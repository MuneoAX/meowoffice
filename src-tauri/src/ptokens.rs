//! Codex·Antigravity 토큰 사용량 집계 공통부 — 응답 기록(Rec) 목록 → local::LocalReport (Claude 의 토큰 사용량과 같은 모양).
//! 기록을 읽는 쪽(codex.rs·antigravity.rs)은 파일별로 (mtime, 크기) 캐시를 두고, 여기서는 기간·모델·세션별로 합산만 한다.
//! 규칙: 숫자·id·모델 이름·이미 화면에 보이는 제목만 다룬다 (대화 내용은 다루지 않음).

use crate::local::{Bucket, LocalReport, ModelUse, Session, Tokens};
use chrono::{DateTime, Duration, Local, Timelike, Utc};
use std::collections::HashMap;

/// 응답 1건의 토큰 사용량 기록.
///
/// `input` 은 캐시 읽기를 뺀 순수 입력. 기록을 읽는 `codex.rs`·`antigravity.rs` 가 만들고 `build` 가 합산한다.
#[derive(Clone, Debug)]
pub struct Rec {
    /// 세션 id
    pub session: String,
    /// 응답 시각 (UTC)
    pub ts: DateTime<Utc>,
    /// 모델 이름
    pub model: String,
    /// 캐시 읽기를 뺀 입력 토큰 수
    pub input: u64,
    /// 출력 토큰 수
    pub output: u64,
    /// 캐시 쓰기 토큰 수
    pub cache_write: u64,
    /// 캐시 읽기 토큰 수
    pub cache_read: u64,
}

/// 세션 표시용 정보 (제목·작업 폴더·상태·시작 시각).
///
/// `build` 가 세션 id 로 찾아 `Session` 필드를 채우는 데 쓴다.
#[derive(Clone, Default, Debug)]
pub struct Meta {
    /// 세션 제목 (없으면 빈 문자열)
    pub title: String,
    /// 작업 폴더 전체 경로
    pub cwd: String,
    /// "busy" | "idle" | ""
    pub status: String,
    /// 세션 시작 시각. 모르면 None (그땐 첫 기록 시각 사용)
    pub started: Option<DateTime<Utc>>,
}

/// 토큰 4종의 합계를 구한다.
///
/// # 인자
/// - `t`: 합산할 `Tokens`
///
/// # 반환
/// input + output + cache_write + cache_read.
fn total(t: &Tokens) -> u64 {
    t.input + t.output + t.cache_write + t.cache_read
}

/// 기록 1건의 토큰을 누적값에 더한다.
///
/// # 인자
/// - `t`: 누적 대상 `Tokens` (제자리 변경)
/// - `r`: 더할 `Rec`
fn add(t: &mut Tokens, r: &Rec) {
    t.input += r.input;
    t.output += r.output;
    t.cache_write += r.cache_write;
    t.cache_read += r.cache_read;
}

/// 조회 시작 시각을 구한다.
///
/// `days` 를 1~90 으로 제한한 뒤, 1 이면 오늘 로컬 자정, 그 외에는 최근 N일(오늘 포함)의 첫날 로컬 자정을 UTC 로 바꿔 돌려준다.
/// 자정 계산에 실패하면 현재 시각을 쓴다.
///
/// # 인자
/// - `days`: 기간(일). 1~90 으로 보정
///
/// # 반환
/// 조회 시작 시각 (UTC).
///
/// # 참조
/// `build` 와 `codex.rs`·`antigravity.rs` 의 기록 읽기에서 사용.
pub fn cutoff_of(days: u32) -> DateTime<Utc> {
    let days = days.clamp(1, 90);
    let now = Local::now();
    let start = (now - Duration::days(days as i64 - 1))
        .with_hour(0)
        .and_then(|t| t.with_minute(0))
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now);
    start.with_timezone(&Utc)
}

/// 기록 목록을 기간·모델·세션별로 합산해 `LocalReport` 로 만든다.
///
/// `cutoff_of` 이후의 기록만 골라 합계·모델별·세션별·추이(days=1 이면 시간별, 아니면 일별, 빈 구간은 0)를 계산한다.
/// 모델은 `total` 내림차순, 세션은 실행 중 우선 후 최근순으로 정렬하고 200개로 자른다.
/// 세션 제목은 공백을 정리해 120자까지, 비면 "(제목 없음)" 으로 한다.
///
/// # 인자
/// - `days`: 기간(일). 1~90 으로 보정
/// - `recs`: 응답 기록 목록
/// - `meta`: 세션 id → 표시 정보
///
/// # 반환
/// `local::LocalReport` (Claude 의 토큰 사용량과 같은 모양).
///
/// # 참조
/// `cutoff_of`, `total`, `add`, `providers::project_of` 를 호출한다.
pub fn build(days: u32, recs: &[Rec], meta: &HashMap<String, Meta>) -> LocalReport {
    let days = days.clamp(1, 90);
    let now_local = Local::now();
    let cutoff = cutoff_of(days);
    let hourly = days == 1;
    let key_of = |ts: &DateTime<Utc>| {
        let l = ts.with_timezone(&Local);
        if hourly {
            l.format("%H").to_string()
        } else {
            l.format("%Y-%m-%d").to_string()
        }
    };

    let mut totals = Tokens::default();
    let mut turns = 0u64;
    let mut by_model: HashMap<String, (Tokens, u64)> = HashMap::new();
    let mut buckets: HashMap<String, u64> = HashMap::new();
    /// 세션 하나의 누적값 (토큰·턴 수·모델별 출력량·첫/마지막 시각). `build` 안에서만 쓴다.
    struct Acc {
        tokens: Tokens,
        turns: u64,
        model_out: HashMap<String, u64>,
        first: Option<DateTime<Utc>>,
        last: Option<DateTime<Utc>>,
    }
    let mut sess: HashMap<String, Acc> = HashMap::new();
    for r in recs.iter().filter(|r| r.ts >= cutoff) {
        add(&mut totals, r);
        turns += 1;
        let m = by_model.entry(r.model.clone()).or_default();
        add(&mut m.0, r);
        m.1 += 1;
        *buckets.entry(key_of(&r.ts)).or_default() += r.input + r.output + r.cache_write + r.cache_read;
        let a = sess.entry(r.session.clone()).or_insert_with(|| Acc {
            tokens: Tokens::default(),
            turns: 0,
            model_out: HashMap::new(),
            first: None,
            last: None,
        });
        add(&mut a.tokens, r);
        a.turns += 1;
        *a.model_out.entry(r.model.clone()).or_default() += r.output.max(1);
        a.first = Some(a.first.map_or(r.ts, |f| f.min(r.ts)));
        a.last = Some(a.last.map_or(r.ts, |l| l.max(r.ts)));
    }

    let mut by_model: Vec<ModelUse> =
        by_model.into_iter().map(|(model, (tokens, turns))| ModelUse { total: total(&tokens), model, tokens, turns }).collect();
    by_model.sort_by_key(|a| std::cmp::Reverse(a.total));

    // 추이: 빈 구간도 0 으로 채워 연속 축 유지
    let mut trend = Vec::new();
    if hourly {
        for h in 0..=now_local.hour() {
            let key = format!("{h:02}");
            trend.push(Bucket { label: format!("{h}시"), total: buckets.get(&key).copied().unwrap_or(0), key });
        }
    } else {
        for d in (0..days as i64).rev() {
            let day = now_local - Duration::days(d);
            let key = day.format("%Y-%m-%d").to_string();
            trend.push(Bucket { label: day.format("%m/%d").to_string(), total: buckets.get(&key).copied().unwrap_or(0), key });
        }
    }

    let mut sessions: Vec<Session> = sess
        .into_iter()
        .map(|(id, a)| {
            let m = meta.get(&id).cloned().unwrap_or_default();
            let project = crate::providers::project_of(&m.cwd);
            let model = a.model_out.iter().max_by_key(|(_, v)| **v).map(|(k, _)| k.clone()).unwrap_or_default();
            let title: String = m.title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
            Session {
                id,
                title: if title.is_empty() { "(제목 없음)".into() } else { title },
                project,
                cwd: m.cwd,
                model,
                total: total(&a.tokens),
                tokens: a.tokens,
                turns: a.turns,
                started_at: m.started.or(a.first).map(|t| t.to_rfc3339()),
                last_at: a.last.map(|t| t.to_rfc3339()),
                status: m.status,
            }
        })
        .collect();
    sessions.sort_by(|a, b| a.status.is_empty().cmp(&b.status.is_empty()).then_with(|| b.last_at.cmp(&a.last_at)));
    sessions.truncate(200);

    LocalReport {
        days,
        total: total(&totals),
        totals,
        turns,
        by_model,
        trend,
        trend_unit: if hourly { "hour" } else { "day" }.into(),
        running: sessions.iter().filter(|s| !s.status.is_empty()).count(),
        sessions,
    }
}

/// `build` 의 합산·기간 필터 단위 테스트.
#[cfg(test)]
mod tests {
    use super::*;

    fn rec(session: &str, model: &str, input: u64, cache_read: u64, output: u64) -> Rec {
        Rec { session: session.into(), ts: Utc::now(), model: model.into(), input, output, cache_write: 0, cache_read }
    }

    #[test]
    fn sums_by_model_and_session() {
        let recs = vec![rec("a", "m1", 10, 90, 5), rec("a", "m1", 1, 0, 2), rec("b", "m2", 3, 0, 4)];
        let mut meta = HashMap::new();
        meta.insert("a".to_string(), Meta { title: "  제목   하나 ".into(), cwd: "C:\\w\\proj".into(), ..Default::default() });
        let r = build(7, &recs, &meta);
        assert_eq!(r.turns, 3);
        assert_eq!(r.total, 10 + 90 + 5 + 1 + 2 + 3 + 4);
        assert_eq!(r.by_model[0].model, "m1");
        let a = r.sessions.iter().find(|s| s.id == "a").unwrap();
        assert_eq!((a.title.as_str(), a.project.as_str(), a.turns), ("제목 하나", "proj", 2));
        assert_eq!(r.trend.len(), 7);
        assert_eq!(r.trend.last().unwrap().total, r.total);
    }

    #[test]
    fn drops_records_before_cutoff() {
        let mut old = rec("a", "m", 100, 0, 0);
        old.ts = Utc::now() - Duration::days(40);
        let r = build(7, &[old, rec("a", "m", 1, 0, 1)], &HashMap::new());
        assert_eq!(r.total, 2);
    }
}
