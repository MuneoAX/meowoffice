//! 로컬 Claude Code 세션 로그 집계.
//! 소스: <claude_dir>/projects/<프로젝트>/<세션id>.jsonl (+ <세션id>/subagents/*.jsonl)
//!       <claude_dir>/sessions/<pid>.json (현재 실행 중 세션: busy/idle)
//! assistant 줄의 message.usage 를 message.id 단위로 중복 제거 후 모델별·기간별·세션별 합산.
//! 파일별 파싱 결과는 (mtime, 크기) 기준 메모리 캐시 — 변경된 파일만 재파싱.

use chrono::{DateTime, Duration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

/// 응답 1건의 토큰 사용량 (세션 로그의 assistant 줄 하나).
///
/// `id` 는 message.id(없으면 requestId, 그것도 없으면 시각+모델)로, 같은 응답의 중복 제거 키다. `parse_file` 이 만들고 `report` 가 합산한다.
#[derive(Clone)]
struct Entry {
    /// 중복 제거 키 (message.id → requestId → "시각#모델")
    id: String,
    /// 응답 시각 (UTC)
    ts: DateTime<Utc>,
    /// 모델 이름
    model: String,
    /// 입력 토큰 수
    input: u64,
    /// 출력 토큰 수
    output: u64,
    /// 캐시 생성 입력 토큰 수 (cache_creation_input_tokens)
    cache_write: u64,
    /// 캐시 읽기 입력 토큰 수 (cache_read_input_tokens)
    cache_read: u64,
}

/// 로그 파일 1개의 파싱 결과.
///
/// 사용량 항목과 세션 제목·작업 폴더 후보를 담는다. `scan` 이 (mtime, 크기) 기준으로 `CACHE` 에 보관해 재사용한다.
#[derive(Default)]
struct FileData {
    /// 세션 id (메인 파일은 파일 이름, 서브에이전트는 부모 세션 id)
    session_id: String,
    /// 사용자 지정 제목 (custom-title 줄)
    custom_title: Option<String>,
    /// AI 가 붙인 제목 (ai-title 줄)
    ai_title: Option<String>,
    /// 첫 사용자 입력 텍스트 (시스템 태그로 시작하는 것 제외)
    first_prompt: Option<String>,
    /// 마지막 프롬프트 (last-prompt 줄)
    last_prompt: Option<String>,
    /// 작업 폴더 (처음 나온 줄의 cwd)
    cwd: Option<String>,
    /// 파일에서 가장 이른 줄의 시각
    first_ts: Option<DateTime<Utc>>,
    /// message.id 별로 중복을 없앤 응답 목록
    entries: Vec<Entry>,
}

/// 파일 경로 → (수정 시각, 크기, 파싱 결과) 캐시 형태.
type Cache = Mutex<HashMap<PathBuf, (SystemTime, u64, Arc<FileData>)>>;
/// 파일별 파싱 결과 메모리 캐시.
///
/// `scan` 이 (mtime, 크기) 가 같으면 재사용하고 다르면 `parse_file` 로 다시 파싱해 넣는다. `Mutex` 로 보호.
static CACHE: OnceLock<Cache> = OnceLock::new();

// ── 출력 ────────────────────────────────────────────────────────────────────

/// 토큰 4종 합계 (입력·출력·캐시 쓰기·캐시 읽기). 화면으로 전달된다(Serialize).
#[derive(Serialize, Default, Clone, Copy)]
pub struct Tokens {
    /// 입력 토큰 수
    pub input: u64,
    /// 출력 토큰 수
    pub output: u64,
    /// 캐시 쓰기 토큰 수
    pub cache_write: u64,
    /// 캐시 읽기 토큰 수
    pub cache_read: u64,
}

impl Tokens {
    /// `Entry` 의 토큰 4종을 누적값에 더한다.
    ///
    /// # 인자
    /// - `e`: 더할 응답 항목
    fn add(&mut self, e: &Entry) {
        self.input += e.input;
        self.output += e.output;
        self.cache_write += e.cache_write;
        self.cache_read += e.cache_read;
    }
    /// 토큰 4종의 합계를 구한다.
    ///
    /// # 반환
    /// input + output + cache_write + cache_read.
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_write + self.cache_read
    }
}

/// 모델별 사용량 한 줄 (토큰 합계·총합·턴 수). `LocalReport.by_model` 의 원소.
#[derive(Serialize)]
pub struct ModelUse {
    /// 모델 이름
    pub model: String,
    /// 토큰 종류별 합계
    pub tokens: Tokens,
    /// 토큰 총합
    pub total: u64,
    /// 응답(턴) 수
    pub turns: u64,
}

/// 추이 버킷 한 칸.
///
/// 1일 조회면 시간별, 그 외에는 일별. `LocalReport.trend` 의 원소.
#[derive(Serialize)]
pub struct Bucket {
    /// 축에 보일 이름 ("N시" 또는 "MM/DD")
    pub label: String,
    /// 집계 키 (시간 "HH" 또는 날짜 "YYYY-MM-DD", 로컬 시간 기준)
    pub key: String,
    /// 그 구간의 토큰 총합
    pub total: u64,
}

/// 세션 하나의 사용량 요약. `LocalReport.sessions` 의 원소.
///
/// `ptokens::build` 도 같은 모양으로 채운다.
#[derive(Serialize)]
pub struct Session {
    /// 세션 id
    pub id: String,
    /// 표시 제목 (한 줄, 120자까지)
    pub title: String,
    /// 작업 폴더 이름 (cwd 의 마지막 부분)
    pub project: String,
    /// 작업 폴더 전체 경로
    pub cwd: String,
    /// 출력 토큰이 가장 많은 모델
    pub model: String,
    /// 토큰 종류별 합계
    pub tokens: Tokens,
    /// 토큰 총합
    pub total: u64,
    /// 응답(턴) 수
    pub turns: u64,
    /// 시작 시각 RFC3339. 모르면 None
    pub started_at: Option<String>,
    /// 마지막 활동 시각 RFC3339. 모르면 None
    pub last_at: Option<String>,
    /// "busy" | "idle" (실행 중) | "" (종료).
    pub status: String,
}

/// 기간별 토큰 사용량 보고서 (합계·모델별·추이·세션).
///
/// `local::report`(Claude)와 `ptokens::build`(Codex·Antigravity)가 같은 모양으로 만든다.
#[derive(Serialize)]
pub struct LocalReport {
    /// 조회 기간(일), 1~90
    pub days: u32,
    /// 토큰 종류별 합계
    pub totals: Tokens,
    /// 토큰 총합
    pub total: u64,
    /// 응답(턴) 수
    pub turns: u64,
    /// 모델별 사용량 (많은 순)
    pub by_model: Vec<ModelUse>,
    /// 추이 버킷 목록 (빈 구간은 0 으로 채움)
    pub trend: Vec<Bucket>,
    /// 추이 단위 "hour" | "day"
    pub trend_unit: String,
    /// 세션 목록 (실행 중 우선 후 최근순, 최대 200개)
    pub sessions: Vec<Session>,
    /// 실행 중(status 가 비지 않은) 세션 수
    pub running: usize,
}

// ── 집계 ────────────────────────────────────────────────────────────────────

/// Claude Code 세션 로그를 집계해 `LocalReport` 로 만든다.
///
/// `days` 를 1~90 으로 보정해 시작 시각(1이면 오늘 로컬 자정, 그 외 최근 N일 첫날 자정)을 정하고, `scan` 으로 로그를, `running_sessions` 로 실행 중 세션을 읽는다.
/// message.id 단위로 중복을 제거하며 합계·모델별·추이(빈 구간 0)·세션별로 합산한다. 세션 제목은 사용자 지정 → AI → 첫 프롬프트 → 마지막 프롬프트 → 실행 중 이름 순으로 고른다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더 (`projects/`, `sessions/` 를 읽음)
/// - `days`: 기간(일). 1~90 으로 보정
///
/// # 반환
/// `LocalReport`. 파일이 없으면 빈 보고서.
///
/// # 참조
/// `scan`, `running_sessions`, `one_line`. 읽는 곳: `<claude_dir>/projects`, `<claude_dir>/sessions`.
pub fn report(claude_dir: &Path, days: u32) -> LocalReport {
    let days = days.clamp(1, 90);
    let now_local = Local::now();
    let start_local = (now_local - Duration::days(days as i64 - 1))
        .with_hour(0)
        .and_then(|t| t.with_minute(0))
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now_local);
    let cutoff = start_local.with_timezone(&Utc);

    let files = scan(&claude_dir.join("projects"), cutoff);
    let running = running_sessions(&claude_dir.join("sessions"));

    let hourly = days == 1;
    let bucket_key = |ts: &DateTime<Utc>| {
        let l = ts.with_timezone(&Local);
        if hourly {
            l.format("%H").to_string()
        } else {
            l.format("%Y-%m-%d").to_string()
        }
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut totals = Tokens::default();
    let mut turns = 0u64;
    let mut by_model: HashMap<String, (Tokens, u64)> = HashMap::new();
    let mut buckets: HashMap<String, u64> = HashMap::new();
    // 세션 id → (토큰, 턴, 모델별 출력, 최초, 최종, 메타 파일들)
    /// 세션 하나의 누적값 (토큰·턴 수·모델별 출력량·마지막 시각·제목용 메타 파일들). `report` 안에서만 쓴다.
    struct Acc {
        tokens: Tokens,
        turns: u64,
        model_out: HashMap<String, u64>,
        last: Option<DateTime<Utc>>,
        meta: Vec<Arc<FileData>>,
    }
    let mut sess: HashMap<String, Acc> = HashMap::new();

    for (is_main, fd) in &files {
        let acc = sess.entry(fd.session_id.clone()).or_insert_with(|| Acc {
            tokens: Tokens::default(),
            turns: 0,
            model_out: HashMap::new(),
            last: None,
            meta: Vec::new(),
        });
        if *is_main {
            acc.meta.push(fd.clone());
        }
        for e in &fd.entries {
            if e.ts < cutoff || !seen.insert(e.id.clone()) {
                continue;
            }
            totals.add(e);
            turns += 1;
            let m = by_model.entry(e.model.clone()).or_default();
            m.0.add(e);
            m.1 += 1;
            *buckets.entry(bucket_key(&e.ts)).or_default() += e.input + e.output + e.cache_write + e.cache_read;
            acc.tokens.add(e);
            acc.turns += 1;
            *acc.model_out.entry(e.model.clone()).or_default() += e.output.max(1);
            if acc.last.map(|l| e.ts > l).unwrap_or(true) {
                acc.last = Some(e.ts);
            }
        }
    }

    let mut by_model: Vec<ModelUse> =
        by_model.into_iter().map(|(model, (tokens, turns))| ModelUse { total: tokens.total(), model, tokens, turns }).collect();
    by_model.sort_by(|a, b| b.total.cmp(&a.total));

    // 추이: 빈 구간도 0으로 채워 연속 축 유지.
    let mut trend = Vec::new();
    if hourly {
        for h in 0..=now_local.hour() {
            let key = format!("{h:02}");
            trend.push(Bucket { label: crate::i18n::tf("bucket.hour", &[("h", &h.to_string())]), total: buckets.get(&key).copied().unwrap_or(0), key });
        }
    } else {
        for d in (0..days as i64).rev() {
            let day = now_local - Duration::days(d);
            let key = day.format("%Y-%m-%d").to_string();
            trend.push(Bucket { label: day.format("%m/%d").to_string(), total: buckets.get(&key).copied().unwrap_or(0), key });
        }
    }

    let mut sessions: Vec<Session> = Vec::new();
    let mut ids: HashSet<String> = sess.keys().cloned().collect();
    ids.extend(running.keys().cloned());
    for id in ids {
        let acc = sess.get(&id);
        let run = running.get(&id);
        let used = acc.map(|a| a.turns > 0).unwrap_or(false);
        if !used && run.is_none() {
            continue;
        }
        let meta = acc.map(|a| a.meta.as_slice()).unwrap_or(&[]);
        let pick = |f: fn(&FileData) -> Option<&String>| meta.iter().rev().find_map(|m| f(m).cloned());
        let title = pick(|m| m.custom_title.as_ref())
            .or_else(|| pick(|m| m.ai_title.as_ref()))
            .or_else(|| pick(|m| m.first_prompt.as_ref()))
            .or_else(|| pick(|m| m.last_prompt.as_ref()))
            .or_else(|| run.map(|r| r.name.clone()).filter(|n| !n.is_empty()))
            .unwrap_or_else(|| crate::i18n::t("session.untitled").into());
        let cwd = pick(|m| m.cwd.as_ref()).or_else(|| run.map(|r| r.cwd.clone())).unwrap_or_default();
        let project = Path::new(&cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let started = meta.iter().filter_map(|m| m.first_ts).min();
        let (tokens, turns, last, model) = match acc {
            Some(a) => (a.tokens, a.turns, a.last, a.model_out.iter().max_by_key(|(_, v)| **v).map(|(k, _)| k.clone()).unwrap_or_default()),
            None => (Tokens::default(), 0, None, String::new()),
        };
        let fmt = |t: DateTime<Utc>| t.to_rfc3339();
        sessions.push(Session {
            id,
            title: one_line(&title, 120),
            project,
            cwd,
            model,
            total: tokens.total(),
            tokens,
            turns,
            started_at: started.map(fmt),
            last_at: last.or(run.and_then(|r| r.updated)).map(fmt),
            status: run.map(|r| r.status.clone()).unwrap_or_default(),
        });
    }
    // 실행 중 우선 → 최근 활동순.
    sessions.sort_by(|a, b| a.status.is_empty().cmp(&b.status.is_empty()).then_with(|| b.last_at.cmp(&a.last_at)));
    sessions.truncate(200);

    LocalReport {
        days,
        total: totals.total(),
        totals,
        turns,
        by_model,
        trend,
        trend_unit: if hourly { "hour" } else { "day" }.into(),
        running: sessions.iter().filter(|s| !s.status.is_empty()).count(),
        sessions,
    }
}

/// 훅 알림용 세션 제목을 기록에서 읽는다.
///
/// 기록(transcript) 줄 중 제목·last-prompt 줄만 해석해 사용자 지정 제목 → AI 제목 → 마지막 프롬프트 순으로 고르고 한 줄(120자)로 줄인다.
///
/// # 인자
/// - `transcript`: 세션 기록(jsonl) 경로
///
/// # 반환
/// 제목. 파일을 못 열거나 제목이 없으면 None.
///
/// # 참조
/// `one_line`, `Line`.
pub fn session_title(transcript: &Path) -> Option<String> {
    let f = std::fs::File::open(transcript).ok()?;
    let (mut custom, mut ai, mut last) = (None, None, None);
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if !(line.contains("-title\"") || line.contains("\"last-prompt\"")) {
            continue;
        }
        let Ok(l) = serde_json::from_str::<Line>(&line) else {
            continue;
        };
        match l.kind.as_str() {
            "ai-title" => ai = l.ai_title.filter(|s| !s.is_empty()).or(ai),
            "custom-title" => custom = l.custom_title.or(l.title).filter(|s| !s.is_empty()).or(custom),
            "last-prompt" => last = l.last_prompt.filter(|s| !s.is_empty()).or(last),
            _ => {}
        }
    }
    custom.or(ai).or(last).map(|t| one_line(&t, 120))
}

/// 세션 기록 옆 서브에이전트 메타(<세션>/subagents/agent-<id>.meta.json) 를 (id, JSON) 로 순회한다.
///
/// `recent` 가 있으면 기록(jsonl, 없으면 메타 파일)의 수정 시각이 그 이후인 에이전트만 읽는다 — 훅마다 불리므로 오래된 메타를 매번 파싱하지 않게.
///
/// # 인자
/// - `transcript`: 세션 기록 경로
/// - `recent`: 이 시각 이후 바뀐 에이전트만 읽을 기준. None 이면 전부
///
/// # 반환
/// (에이전트 id, 메타 JSON) 이터레이터. 폴더가 없으면 빈 이터레이터.
///
/// # 참조
/// `running_background_agents` 가 호출.
fn agent_metas(transcript: &Path, recent: Option<SystemTime>) -> impl Iterator<Item = (String, serde_json::Value)> {
    let dir = transcript.with_extension("").join("subagents");
    std::fs::read_dir(&dir).into_iter().flatten().flatten().filter_map(move |e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_string();
        if let Some(t) = recent {
            // 막 띄운 에이전트는 기록(jsonl)이 아직 없을 수 있음 → 메타 파일 시각으로 판단.
            let modified =
                std::fs::metadata(dir.join(format!("agent-{id}.jsonl"))).or_else(|_| e.metadata()).and_then(|m| m.modified()).ok()?;
            if modified < t {
                return None;
            }
        }
        let v = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
        Some((id, v))
    })
}

/// 훅 알림용 에이전트 이름을 읽는다 (메타의 description = 에이전트를 띄울 때 준 작업 설명).
///
/// # 인자
/// - `transcript`: 세션 기록 경로
/// - `agent_id`: 에이전트 id
///
/// # 반환
/// 한 줄(120자)로 줄인 description. 파일이 없거나 비어 있으면 None.
///
/// # 참조
/// `one_line`. 읽는 곳: <세션>/subagents/agent-<id>.meta.json
pub fn agent_title(transcript: &Path, agent_id: &str) -> Option<String> {
    let path = transcript.with_extension("").join("subagents").join(format!("agent-{agent_id}.meta.json"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v.get("description")?.as_str().filter(|d| !d.is_empty()).map(|d| one_line(d, 120))
}

/// 아직 끝나지 않은 백그라운드 에이전트 수를 센다 — 메인 턴이 끝나도 작업이 계속되는 중인지 판단용.
///
/// 메타의 requestShape 가 "background" 이고 finished 가 true 가 아닌 것을 센다. 비정상 종료로 남은 메타는 기록이 1시간 넘게 안 바뀌었으면 뺀다.
///
/// # 인자
/// - `transcript`: 세션 기록 경로
///
/// # 반환
/// 실행 중인 백그라운드 에이전트 수.
///
/// # 참조
/// `agent_metas`.
pub fn running_background_agents(transcript: &Path) -> usize {
    agent_metas(transcript, Some(SystemTime::now() - std::time::Duration::from_secs(3600)))
        .filter(|(_, v)| {
            v.get("requestShape").and_then(|x| x.as_str()) == Some("background")
                && v.get("finished").and_then(|x| x.as_bool()) != Some(true)
        })
        .count()
}

/// 문자열의 공백을 한 칸으로 정리하고 길이를 제한한다.
///
/// # 인자
/// - `s`: 원문
/// - `max`: 최대 글자 수 (넘으면 잘라 "…" 를 붙임)
///
/// # 반환
/// 한 줄로 정리된 문자열.
fn one_line(s: &str, max: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > max {
        t.chars().take(max).collect::<String>() + "…"
    } else {
        t
    }
}

// ── 파일 탐색/파싱 ──────────────────────────────────────────────────────────

/// cutoff 이후 수정된 로그 파일을 찾아 파싱 결과를 돌려준다.
///
/// `<projects>/<프로젝트>/<세션>.jsonl` 은 메인, `<프로젝트>/<세션>/subagents/*.jsonl` 은 부모 세션 귀속(비메인)으로 모은다.
/// 수정 시각이 cutoff 이전이면 건너뛰고, `CACHE` 에서 (mtime, 크기) 가 같으면 재사용, 아니면 `parse_file` 로 다시 파싱해 저장한다.
///
/// # 인자
/// - `projects`: `<claude_dir>/projects` 경로
/// - `cutoff`: 이 시각 이후 수정된 파일만
///
/// # 반환
/// (메인 세션 파일 여부, 파싱 결과) 목록. 폴더를 못 읽으면 빈 목록.
///
/// # 참조
/// `parse_file`, `CACHE`. `report` 가 호출.
fn scan(projects: &Path, cutoff: DateTime<Utc>) -> Vec<(bool, Arc<FileData>)> {
    let cutoff_sys: SystemTime = cutoff.into();
    let mut targets: Vec<(PathBuf, bool, String)> = Vec::new();
    let Ok(projs) = std::fs::read_dir(projects) else {
        return Vec::new();
    };
    for p in projs.flatten() {
        let Ok(items) = std::fs::read_dir(p.path()) else {
            continue;
        };
        for it in items.flatten() {
            let path = it.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                let sid = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                targets.push((path, true, sid));
            } else if path.is_dir() {
                // 서브에이전트 로그 → 부모 세션으로 귀속.
                let sid = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if let Ok(subs) = std::fs::read_dir(path.join("subagents")) {
                    for s in subs.flatten() {
                        let sp = s.path();
                        if sp.extension().map(|e| e == "jsonl").unwrap_or(false) {
                            targets.push((sp, false, sid.clone()));
                        }
                    }
                }
            }
        }
    }

    let cache = CACHE.get_or_init(Default::default);
    let mut out = Vec::new();
    for (path, is_main, sid) in targets {
        let Ok(md) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = md.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if mtime < cutoff_sys {
            continue;
        }
        let size = md.len();
        let hit = cache.lock().unwrap().get(&path).filter(|(m, s, _)| *m == mtime && *s == size).map(|(_, _, d)| d.clone());
        let fd = match hit {
            Some(d) => d,
            None => {
                let d = Arc::new(parse_file(&path, sid));
                cache.lock().unwrap().insert(path.clone(), (mtime, size, d.clone()));
                d
            }
        };
        out.push((is_main, fd));
    }
    out
}

/// 세션 로그 한 줄(JSON)에서 쓰는 필드만 뽑은 형태. 없는 필드는 기본값.
#[derive(Deserialize)]
struct Line {
    /// 줄 종류 (JSON 필드 `type`: assistant | user | ai-title | custom-title | last-prompt 등)
    #[serde(rename = "type", default)]
    kind: String,
    /// 줄 시각 (RFC3339 문자열)
    #[serde(default)]
    timestamp: Option<String>,
    /// 작업 폴더
    #[serde(default)]
    cwd: Option<String>,
    /// 메타 줄 여부 (JSON 필드 `isMeta`) — 첫 프롬프트에서 제외
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    /// 요청 id (JSON 필드 `requestId`) — message.id 가 없을 때 중복 제거 키
    #[serde(rename = "requestId", default)]
    request_id: Option<String>,
    /// 메시지 본문 (사용량·모델·내용)
    #[serde(default)]
    message: Option<Msg>,
    /// AI 제목 (JSON 필드 `aiTitle`)
    #[serde(rename = "aiTitle", default)]
    ai_title: Option<String>,
    /// 사용자 지정 제목 (JSON 필드 `customTitle`)
    #[serde(rename = "customTitle", default)]
    custom_title: Option<String>,
    /// 제목 (custom-title 줄에서 customTitle 이 없을 때 대신 사용)
    #[serde(default)]
    title: Option<String>,
    /// 마지막 프롬프트 (JSON 필드 `lastPrompt`)
    #[serde(rename = "lastPrompt", default)]
    last_prompt: Option<String>,
}

/// 로그 줄의 message 객체에서 쓰는 필드.
#[derive(Deserialize)]
struct Msg {
    /// 응답 id (message.id) — 중복 제거 키
    #[serde(default)]
    id: Option<String>,
    /// 모델 이름
    #[serde(default)]
    model: Option<String>,
    /// 토큰 사용량
    #[serde(default)]
    usage: Option<Usage>,
    /// 내용 (첫 프롬프트 추출용)
    #[serde(default)]
    content: Option<serde_json::Value>,
}

/// message.usage 의 토큰 수 (없으면 0).
#[derive(Deserialize)]
struct Usage {
    /// 입력 토큰 수
    #[serde(default)]
    input_tokens: u64,
    /// 출력 토큰 수
    #[serde(default)]
    output_tokens: u64,
    /// 캐시 생성 입력 토큰 수
    #[serde(default)]
    cache_creation_input_tokens: u64,
    /// 캐시 읽기 입력 토큰 수
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// 로그 파일 하나를 파싱한다.
///
/// 사용량·제목·첫 프롬프트가 있을 법한 줄만 역직렬화해 시작 시각·cwd·제목 후보를 모은다. 같은 message.id 는 콘텐츠 블록마다 반복 기록되므로 마지막 기록으로 덮어쓴다.
/// 모델이 비었거나 '<' 로 시작하는(<synthetic> 등) 항목은 건너뛴다.
///
/// # 인자
/// - `path`: 로그(jsonl) 경로
/// - `session_id`: 이 파일이 속한 세션 id
///
/// # 반환
/// `FileData`. 파일을 못 열면 항목 없는 빈 결과.
///
/// # 참조
/// `prompt_text`. `scan` 이 호출.
fn parse_file(path: &Path, session_id: String) -> FileData {
    let mut fd = FileData { session_id, ..Default::default() };
    let Ok(f) = std::fs::File::open(path) else {
        return fd;
    };
    // 같은 응답(message.id)이 콘텐츠 블록마다 반복 기록됨 → 마지막 기록으로 덮어씀.
    let mut idx: HashMap<String, usize> = HashMap::new();

    for line in BufReader::new(f).lines().map_while(Result::ok) {
        // 대용량 요청 스냅샷 등 불필요 줄은 역직렬화 생략.
        let wanted = line.contains("\"usage\"")
            || line.contains("-title\"")
            || line.contains("\"last-prompt\"")
            || (fd.first_prompt.is_none() && line.contains("\"type\":\"user\""));
        if !wanted {
            continue;
        }
        let Ok(l) = serde_json::from_str::<Line>(&line) else { continue };
        let ts = l.timestamp.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc));
        if let Some(t) = ts {
            if fd.first_ts.map(|f| t < f).unwrap_or(true) {
                fd.first_ts = Some(t);
            }
        }
        match l.kind.as_str() {
            "assistant" => {
                let Some(msg) = l.message else { continue };
                let (Some(u), Some(ts)) = (msg.usage, ts) else {
                    continue;
                };
                let model = msg.model.unwrap_or_default();
                if model.is_empty() || model.starts_with('<') {
                    continue; // <synthetic> 등
                }
                if fd.cwd.is_none() {
                    fd.cwd = l.cwd;
                }
                let id = msg.id.or(l.request_id).unwrap_or_else(|| format!("{}#{}", ts.timestamp_millis(), model));
                let e = Entry {
                    id: id.clone(),
                    ts,
                    model,
                    input: u.input_tokens,
                    output: u.output_tokens,
                    cache_write: u.cache_creation_input_tokens,
                    cache_read: u.cache_read_input_tokens,
                };
                match idx.get(&id) {
                    Some(&i) => fd.entries[i] = e,
                    None => {
                        idx.insert(id, fd.entries.len());
                        fd.entries.push(e);
                    }
                }
            }
            "user" if fd.first_prompt.is_none() && !l.is_meta => {
                if let Some(text) = l.message.and_then(|m| m.content).and_then(prompt_text) {
                    fd.first_prompt = Some(text);
                    if fd.cwd.is_none() {
                        fd.cwd = l.cwd;
                    }
                }
            }
            "ai-title" => fd.ai_title = l.ai_title.filter(|s| !s.is_empty()),
            "custom-title" => fd.custom_title = l.custom_title.or(l.title).filter(|s| !s.is_empty()),
            "last-prompt" => fd.last_prompt = l.last_prompt.filter(|s| !s.is_empty()),
            _ => {}
        }
    }
    fd
}

/// 사용자 입력 텍스트를 추출한다.
///
/// 문자열이면 그대로, 배열이면 type 이 "text" 인 블록을 공백으로 이어 붙인다. 비었거나 시스템 태그('<' 로 시작: <command-…>, <system-reminder> 등)면 제외한다.
///
/// # 인자
/// - `c`: message.content JSON 값
///
/// # 반환
/// 공백을 다듬은 텍스트. 제외 대상이거나 형식이 다르면 None.
///
/// # 참조
/// `parse_file` 이 첫 프롬프트에 사용.
pub(crate) fn prompt_text(c: serde_json::Value) -> Option<String> {
    let text = match c {
        serde_json::Value::String(s) => s,
        serde_json::Value::Array(a) => a
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') {
        None
    } else {
        Some(t.to_string())
    }
}

// ── 실행 중 세션 ────────────────────────────────────────────────────────────

/// 실행 중 세션 정보 (`<claude_dir>/sessions/*.json` 에서 읽음).
struct Running {
    /// 세션 이름 (제목 후보)
    name: String,
    /// 작업 폴더
    cwd: String,
    /// "busy" | "idle" (원본이 비면 "idle")
    status: String,
    /// 마지막 갱신 시각
    updated: Option<DateTime<Utc>>,
}

/// `<claude_dir>/sessions/<pid>.json` 의 내용 (없는 필드는 기본값).
#[derive(Deserialize)]
struct SessFile {
    /// 프로세스 id
    #[serde(default)]
    pid: u32,
    /// 세션 id (JSON 필드 `sessionId`)
    #[serde(rename = "sessionId", default)]
    session_id: String,
    /// 작업 폴더
    #[serde(default)]
    cwd: String,
    /// 세션 이름
    #[serde(default)]
    name: String,
    /// 상태 (busy | idle)
    #[serde(default)]
    status: String,
    /// 갱신 시각 (JSON 필드 `updatedAt`, 밀리초 epoch)
    #[serde(rename = "updatedAt", default)]
    updated_at: i64,
    /// 프로세스 시작 시각 (JSON 필드 `procStart`, Windows FILETIME 100ns 단위 문자열). pid 재사용 오판 방지용, 없으면 대조하지 않음.
    #[serde(rename = "procStart", default)]
    proc_start: serde_json::Value,
    /// 이 세션에 연결된 claude.ai 원격 제어 세션 id (JSON 필드 `bridgeSessionId`, 원격 제어를 안 켰으면 빈 값)
    #[serde(rename = "bridgeSessionId", default)]
    bridge_session_id: String,
}

/// 로컬 세션에 연결된 claude.ai 원격 제어(bridge) 세션 id 를 찾는다.
///
/// `<claude_dir>/sessions/*.json` 중 `sessionId` 가 같은 파일의 `bridgeSessionId`. 같은 세션의 로컬 알림과 원격 제어 알림을 한 카드로 합치는 데 쓴다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
/// - `session_id`: 로컬 세션 id
///
/// # 반환
/// 원격 제어 세션 id. 원격 제어를 안 켰거나 파일이 없으면 None.
pub fn bridge_session_of(claude_dir: &Path, session_id: &str) -> Option<String> {
    let items = std::fs::read_dir(claude_dir.join("sessions")).ok()?;
    for it in items.flatten() {
        let p = it.path();
        if p.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(s) = serde_json::from_str::<SessFile>(&text) else { continue };
        if s.session_id == session_id && !s.bridge_session_id.is_empty() {
            return Some(s.bridge_session_id);
        }
    }
    None
}

/// 실행 중인 세션을 읽는다.
///
/// `<dir>/*.json` 을 해석해 세션 id 가 있고 프로세스가 살아 있는(`pid_alive`) 것만 모은다.
///
/// # 인자
/// - `dir`: `<claude_dir>/sessions` 경로
///
/// # 반환
/// 세션 id → `Running`. 폴더를 못 읽으면 빈 맵.
///
/// # 참조
/// `pid_alive`. `report` 가 호출.
fn running_sessions(dir: &Path) -> HashMap<String, Running> {
    let mut out = HashMap::new();
    let Ok(items) = std::fs::read_dir(dir) else {
        return out;
    };
    for it in items.flatten() {
        let p = it.path();
        if p.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(s) = serde_json::from_str::<SessFile>(&text) else {
            continue;
        };
        if s.session_id.is_empty() || !pid_alive(s.pid) {
            continue;
        }
        out.insert(
            s.session_id,
            Running {
                name: s.name,
                cwd: s.cwd,
                status: if s.status.is_empty() { "idle".into() } else { s.status },
                updated: DateTime::from_timestamp_millis(s.updated_at),
            },
        );
    }
    out
}

/// 세션을 쥐고 있는 다른 프로세스 정보.
#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    /// 프로세스 id
    pub pid: u32,
    /// "busy" | "idle" (원본이 비면 "idle")
    pub status: String,
}

/// 이 세션을 쥐고 있는 살아 있는 프로세스를 찾는다(채팅 충돌 판정 4.1 의 2번).
///
/// `<claude_dir>/sessions/*.json` 중 `sessionId` 가 같고 pid 가 살아 있으며(`pid_alive`), `procStart` 가 있으면 실제 프로세스 시작 시각과 맞는(pid 재사용 제외) 것.
/// 실행기 자신의 자식(`exclude_pids`)은 건너뛴다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
/// - `session_id`: 세션 id
/// - `exclude_pids`: 제외할 pid(실행기가 띄운 자식)
///
/// # 반환
/// 쥐고 있는 프로세스. 없으면 None.
///
/// # 참조
/// `pid_alive`, `proc_start_matches`. `runner` 의 충돌 판정이 호출.
pub fn session_owner(claude_dir: &Path, session_id: &str, exclude_pids: &[u32]) -> Option<Owner> {
    let items = std::fs::read_dir(claude_dir.join("sessions")).ok()?;
    for it in items.flatten() {
        let p = it.path();
        if p.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(s) = serde_json::from_str::<SessFile>(&text) else { continue };
        if s.session_id != session_id || exclude_pids.contains(&s.pid) || !pid_alive(s.pid) || !proc_start_matches(s.pid, &s.proc_start) {
            continue;
        }
        return Some(Owner { pid: s.pid, status: if s.status.is_empty() { "idle".into() } else { s.status } });
    }
    None
}

/// 세션 파일의 `procStart` 가 실제 프로세스 시작 시각과 맞는지 확인한다.
///
/// 값이 없거나 숫자 문자열이 아니거나 시각을 읽을 수 없으면 true(대조 불가 → 살아 있는 것으로 봄). 2초 넘게 다르면 pid 가 다른 프로세스에 재사용된 것으로 보고 false.
///
/// # 인자
/// - `pid`: 프로세스 id
/// - `proc_start`: 세션 파일의 `procStart` 값
#[cfg(windows)]
fn proc_start_matches(pid: u32, proc_start: &serde_json::Value) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let want = match proc_start {
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        serde_json::Value::Number(n) => n.as_u64(),
        _ => None,
    };
    let Some(want) = want else { return true };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return true;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (zero, zero, zero, zero);
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
        CloseHandle(h);
        if !ok {
            return true;
        }
        let have = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
        have.abs_diff(want) < 2 * 10_000_000
    }
}

/// Windows 가 아니면 시작 시각을 대조하지 않는다.
#[cfg(not(windows))]
fn proc_start_matches(_pid: u32, _proc_start: &serde_json::Value) -> bool {
    true
}

/// 프로세스가 살아 있는지 확인한다 (Windows).
///
/// pid 0 은 false. `OpenProcess`(제한 조회) 후 `GetExitCodeProcess` 가 STILL_ACTIVE 면 true.
///
/// # 인자
/// - `pid`: 프로세스 id
///
/// # 반환
/// 살아 있으면 true.
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

/// 프로세스가 살아 있는지 확인한다 (Unix).
///
/// 시그널 0 으로 존재만 확인한다. EPERM 은 다른 사용자의 살아 있는 프로세스로 보고 true.
///
/// # 인자
/// - `pid`: 프로세스 id (0 이면 false)
///
/// # 반환
/// 살아 있으면 true.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // 시그널 0: 존재 확인만. EPERM 은 다른 사용자의 살아 있는 프로세스.
    pid != 0 && (unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

/// 실행 중 로그 파싱·message.id 중복 제거 테스트 (실데이터 스모크는 ignore).
#[cfg(test)]
mod tests {
    use super::*;

    /// 실 데이터 스모크: cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_real_dir() {
        let dir = crate::config::claude_dir(&crate::config::Config::default());
        for days in [1, 7, 30] {
            let r = report(&dir, days);
            println!("{}", serde_json::to_string_pretty(&r).unwrap());
        }
    }

    #[test]
    fn dedup_by_message_id() {
        let dir = std::env::temp_dir().join(format!("usage-tray-test-{}", std::process::id()));
        let proj = dir.join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let ts = Utc::now().to_rfc3339();
        let line = |out: u64| {
            format!(
                r#"{{"type":"assistant","timestamp":"{ts}","cwd":"C:/x/proj","message":{{"id":"m1","model":"claude-opus-5-5","usage":{{"input_tokens":1,"output_tokens":{out},"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
            )
        };
        let body = [
            r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello world"}}"#.to_string(),
            line(5),
            line(9),
            r#"{"type":"ai-title","aiTitle":"테스트 세션"}"#.to_string(),
        ]
        .join("\n");
        std::fs::write(proj.join("s1.jsonl"), body).unwrap();
        let r = report(&dir, 1);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(r.turns, 1);
        assert_eq!(r.totals.output, 9);
        assert_eq!(r.sessions[0].title, "테스트 세션");
        assert_eq!(r.sessions[0].project, "proj");
    }
}

/// 세션 id 의 기록 파일(`<claude_dir>/projects/*/<id>.jsonl`)을 찾는다.
///
/// 세션 id 는 영숫자·'-' 만 허용해 다른 경로를 가리키지 못하게 한다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
/// - `session_id`: 세션 id
///
/// # 반환
/// 기록 파일 경로. id 가 유효하지 않거나 파일이 없으면 None.
///
/// # 참조
/// `last_image`·`chatlog::claude_page` 가 호출.
pub fn find_transcript(claude_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let projects = claude_dir.join("projects");
    std::fs::read_dir(&projects).ok()?.flatten().map(|d| d.path().join(format!("{session_id}.jsonl"))).find(|p| p.is_file())
}

/// 세션 기록에서 마지막으로 받은 이미지(사용자가 붙인 그림·도구 결과 스크린샷 등)를 data URL 로 돌려준다.
///
/// 세션 id 는 영숫자·'-' 만 허용해 다른 경로를 가리키지 못하게 한다. 지난번에 읽은 위치(바이트)를 캐시에 기억해 새로 붙은 줄만 이어 읽고(파일이 줄었으면 처음부터),
/// 줄바꿈으로 끝나지 않은 마지막 줄은 다음으로 미룬다. 캐시는 최근 쓴 세션 `IMG_CACHE_MAX` 개까지만 두고 오래된 것부터 버린다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더 (`projects/*/<세션id>.jsonl` 을 찾음)
/// - `session_id`: 세션 id (영숫자·'-' 만 허용)
///
/// # 반환
/// "data:<media_type>;base64,<데이터>" 문자열. 이미지가 없거나 id·파일이 유효하지 않으면 None.
///
/// # 참조
/// `scan_image_line`.
pub fn last_image(claude_dir: &Path, session_id: &str) -> Option<String> {
    use std::io::{BufRead, Seek, SeekFrom};
    /// 이미지 캐시 항목: 마지막으로 읽은 파일 길이(바이트), 가장 최근 이미지, 마지막 사용 시각.
    struct Seen {
        len: u64,
        last: Option<String>,
        used: std::time::Instant,
    }
    /// 이미지 캐시에 둘 세션 수 상한 (넘으면 가장 오래 안 쓴 것부터 버림).
    const IMG_CACHE_MAX: usize = 24;
    /// 세션 기록 경로 → 이미지 읽기 상태(`Seen`) 캐시. `last_image` 전용, `Mutex` 로 보호.
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Seen>>> = OnceLock::new();
    let path = find_transcript(claude_dir, session_id)?;
    let len = std::fs::metadata(&path).ok()?.len();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let (start, mut last) = match cache.lock().unwrap().get_mut(&path) {
        Some(c) if c.len == len => {
            c.used = std::time::Instant::now();
            return c.last.clone();
        }
        Some(c) if c.len < len => (c.len, c.last.clone()),
        _ => (0, None),
    };
    let mut file = std::fs::File::open(&path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut rd = BufReader::new(file);
    let (mut pos, mut buf) = (start, Vec::new());
    loop {
        buf.clear();
        let n = rd.read_until(b'\n', &mut buf).ok()?;
        if n == 0 || buf.last() != Some(&b'\n') {
            break; // 끝, 또는 아직 쓰는 중인 마지막 줄(다음에 이어 읽음)
        }
        pos += n as u64;
        if let Ok(line) = std::str::from_utf8(&buf) {
            if line.contains("\"type\":\"image\"") {
                scan_image_line(line, &mut last);
            }
        }
    }
    let mut c = cache.lock().unwrap();
    if c.len() >= IMG_CACHE_MAX && !c.contains_key(&path) {
        if let Some(old) = c.iter().min_by_key(|(_, v)| v.used).map(|(k, _)| k.clone()) {
            c.remove(&old);
        }
    }
    c.insert(path, Seen { len: pos, last: last.clone(), used: std::time::Instant::now() });
    last
}

/// 기록 한 줄에서 base64 이미지를 찾아 `last` 를 갱신한다.
///
/// JSON 을 스택으로 순회하며 type 이 "image" 이고 source 가 base64, 데이터가 비지 않고 8MB 미만, media_type 이 image/ 로 시작하는 것을 data URL 로 만든다.
/// 순회는 문서 순서를 유지하므로 같은 줄 안에서는 마지막 이미지가 남는다.
///
/// # 인자
/// - `line`: 기록 한 줄(JSON 문자열)
/// - `last`: 최신 이미지를 담는 자리 (조건에 맞는 이미지가 있으면 덮어씀)
///
/// # 참조
/// `last_image` 가 호출.
fn scan_image_line(line: &str, last: &mut Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let mut stack = vec![&v];
    while let Some(x) = stack.pop() {
        match x {
            serde_json::Value::Object(o) => {
                if o.get("type").and_then(|t| t.as_str()) == Some("image") {
                    if let Some(src) = o.get("source") {
                        let kind = src.get("type").and_then(|t| t.as_str());
                        let data = src.get("data").and_then(|t| t.as_str()).unwrap_or("");
                        let mt = src.get("media_type").and_then(|t| t.as_str()).unwrap_or("image/png");
                        if kind == Some("base64") && !data.is_empty() && data.len() < 8_000_000 && mt.starts_with("image/") {
                            *last = Some(format!("data:{mt};base64,{data}"));
                        }
                    }
                }
                // 값들을 순서대로 넣고 pop 은 뒤에서부터라 거꾸로 넣는다
                let vals: Vec<_> = o.values().collect();
                stack.extend(vals.into_iter().rev());
            }
            serde_json::Value::Array(a) => stack.extend(a.iter().rev()),
            _ => {}
        }
    }
}

/// `session_owner` 시험: 살아 있는 pid·죽은 pid·제외 pid·procStart 불일치.
#[cfg(test)]
mod owner_tests {
    use super::*;

    fn write_sess(dir: &Path, name: &str, pid: u32, sid: &str, extra: &str) {
        std::fs::write(dir.join(format!("{name}.json")), format!(r#"{{"pid":{pid},"sessionId":"{sid}","status":"busy"{extra}}}"#)).unwrap();
    }

    #[test]
    fn session_owner_cases() {
        let root = std::env::temp_dir().join(format!("meow-owner-{}", std::process::id()));
        let dir = root.join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        write_sess(&dir, "a", me, "live-sess", "");
        write_sess(&dir, "b", u32::MAX - 1, "dead-sess", "");
        assert_eq!(session_owner(&root, "live-sess", &[]), Some(Owner { pid: me, status: "busy".into() }));
        assert_eq!(session_owner(&root, "dead-sess", &[]), None);
        // 실행기 자식 pid 는 제외
        assert_eq!(session_owner(&root, "live-sess", &[me]), None);
        assert_eq!(session_owner(&root, "other", &[]), None);
        // pid 재사용: 시작 시각이 다르면 제외 (Windows 에서만 대조)
        write_sess(&dir, "c", me, "reused-sess", r#","procStart":"1""#);
        #[cfg(windows)]
        assert_eq!(session_owner(&root, "reused-sess", &[]), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// `last_image` 의 이어 읽기·미완성 줄 보류·파일 축소 시 재시작 테스트.
#[cfg(test)]
mod image_tests {
    use super::*;
    use std::io::Write;

    fn img_line(data: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{data}"}}}}]}}}}"#
        )
    }

    #[test]
    fn last_image_reads_appended_lines_and_restarts_on_truncate() {
        let dir = std::env::temp_dir().join(format!("meow-img-{}", std::process::id()));
        let proj = dir.join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let f = proj.join("sess-1.jsonl");
        std::fs::write(&f, format!("{}\n{{\"type\":\"assistant\"}}\n", img_line("AAAA"))).unwrap();
        assert_eq!(last_image(&dir, "sess-1").as_deref(), Some("data:image/png;base64,AAAA"));
        // 새 줄이 붙으면 그 줄만 읽어 갱신
        let mut h = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        writeln!(h, "{}", img_line("BBBB")).unwrap();
        drop(h);
        assert_eq!(last_image(&dir, "sess-1").as_deref(), Some("data:image/png;base64,BBBB"));
        // 아직 쓰는 중인 줄(줄바꿈 없음)은 다음으로 미룸
        let mut h = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        write!(h, "{}", img_line("CCCC")).unwrap();
        drop(h);
        assert_eq!(last_image(&dir, "sess-1").as_deref(), Some("data:image/png;base64,BBBB"));
        // 파일이 줄면 처음부터
        std::fs::write(&f, "{\"type\":\"assistant\"}\n").unwrap();
        assert_eq!(last_image(&dir, "sess-1"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
