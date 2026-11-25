//! OpenAI Codex (CLI·데스크톱 앱, ChatGPT 계정) 상태 → providers::Snapshot.
//! 자료: ~/.codex (CODEX_HOME 우선)
//!   - auth.json                  : 로그인 방식(chatgpt/apikey), id_token 클레임(이메일·요금제), 액세스 토큰(한도 조회용, 읽기만)
//!   - https://chatgpt.com/backend-api/wham/usage : 사용 한도 (5시간·주간). 실패 시 최근 rollout 의 token_count.rate_limits 로 대체
//!   - sessions/YYYY/MM/DD/rollout-*.jsonl, session_index.jsonl : 최근 세션
//!
//!   - 같은 rollout 의 token_usage_record·turn_context·task_complete: 토큰 사용량 집계, 턴 끝남 알림
//!
//! 규칙: 토큰은 메모리에서만 쓰고 출력·로그·오류에 넣지 않는다. ~/.codex 에는 쓰지 않는다 (토큰 갱신도 하지 않음).
//! 대화 내용은 제목(이미 화면에 보이는 것) 말고는 다루지 않는다.

use crate::providers::{project_of, Limit, PSession, Snapshot};
use crate::ptokens::{Meta, Rec};
use base64::Engine;
use chrono::{DateTime, Duration as CDuration, Local, NaiveDate, TimeZone, Utc};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// 사용 한도 조회 엔드포인트 (ChatGPT wham/usage).
const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// 한도 조회 결과(`USAGE_CACHE`)를 재사용하는 시간(초).
const CACHE_SECS: u64 = 60;
/// 세션 파일 머리(메타 + 첫 사용자 메시지)를 읽는 최대 바이트 — 메타에 긴 지침이 들어 있어 넉넉히 잡는다.
const HEAD_BYTES: u64 = 512 * 1024;
/// 세션 파일 꼬리를 읽는 바이트 (턴 표식·마지막 시각·rate_limits 찾기용).
const TAIL_BYTES: u64 = 64 * 1024;
/// `collect_sessions` 가 돌려줄 세션 수 상한.
const MAX_SESSIONS: usize = 30;

// ── 인증 ────────────────────────────────────────────────────────────────────

/// auth.json 에서 읽은 로그인 정보.
///
/// 토큰이 들어 있어 Debug/Serialize 를 일부러 붙이지 않는다. `parse_auth` 가 만든다.
struct Auth {
    /// true = ChatGPT 계정 로그인, false = API 키만
    chatgpt: bool,
    /// 이메일 (id_token → access_token 클레임 순). 로그에 남기지 않는다
    email: String,
    /// 계정 이름 (클레임 name)
    name: String,
    /// 화면용 요금제 이름 (`plan_name` 결과)
    plan: String,
    /// 액세스 토큰 (한도 조회용, 비밀값). API 키 로그인이면 빈 값
    access_token: String,
    /// ChatGPT 계정 id (`chatgpt-account-id` 헤더용)
    account_id: String,
}

/// Codex 데이터 폴더(~/.codex) 위치를 구한다.
///
/// 환경변수 CODEX_HOME 이 비어 있지 않으면 그 경로, 아니면 홈 폴더의 `.codex`.
///
/// # 반환
/// 폴더 경로. 홈 폴더를 알 수 없으면 None (폴더가 실제로 있는지는 확인하지 않음).
///
/// # 참조
/// `snapshot`·`token_report`·`poll_finished` 가 호출.
pub fn codex_home() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    directories::BaseDirs::new().map(|b| b.home_dir().join(".codex"))
}

/// JWT 가운데(payload) 부분만 base64url 로 풀어 JSON 으로 만든다 (서명은 검증하지 않음).
///
/// # 인자
/// - `token`: 점(.)으로 나뉜 JWT 문자열
///
/// # 반환
/// payload JSON. 형식이 다르거나 디코딩·해석에 실패하면 None.
///
/// # 참조
/// `parse_auth` 가 클레임(이메일·요금제·계정 id)을 읽을 때 호출.
fn jwt_payload(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 요금제 코드를 화면 이름으로 바꾼다 ("plus" → "Plus").
///
/// 소문자로 바꾼 코드가 비면 빈 문자열, "prolite" 는 "Pro Lite", 그 외는 첫 글자만 대문자.
///
/// # 인자
/// - `code`: 요금제 코드 (예: chatgpt_plan_type·plan_type 값)
///
/// # 반환
/// 화면용 요금제 이름.
///
/// # 참조
/// `parse_auth`·`snapshot` 이 호출.
fn plan_name(code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "" => String::new(),
        "prolite" => "Pro Lite".into(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

/// auth.json JSON 을 `Auth` 로 해석한다.
///
/// auth_mode 가 "apikey"/"api_key" 면 API 키 로그인, "chatgpt"/"chatgptAuthTokens" 이거나 값이 없으면 토큰 유무로 ChatGPT 로그인 여부를 정한다.
/// ChatGPT 로그인이면 id_token 다음 access_token 의 클레임에서 이메일·이름·요금제·계정 id 를 채운다(이미 채워진 값은 덮어쓰지 않음). API 키 로그인은 액세스 토큰을 비운다.
///
/// # 인자
/// - `v`: auth.json 을 파싱한 JSON
///
/// # 반환
/// `Auth`. ChatGPT 로그인도 API 키도 없으면 None.
///
/// # 참조
/// `jwt_payload`, `plan_name`. `snapshot` 이 호출. 읽는 파일: auth.json.
fn parse_auth(v: &Value) -> Option<Auth> {
    let tokens = v.get("tokens");
    let access = tokens.and_then(|t| t.get("access_token")).and_then(Value::as_str).unwrap_or("");
    let id_token = tokens.and_then(|t| t.get("id_token")).and_then(Value::as_str).unwrap_or("");
    let api_key = v.get("OPENAI_API_KEY").and_then(Value::as_str).unwrap_or("");
    let mode = v.get("auth_mode").and_then(Value::as_str).unwrap_or("");
    let chatgpt = match mode {
        "apikey" | "api_key" => false,
        "chatgpt" | "chatgptAuthTokens" => !access.is_empty() || !id_token.is_empty(),
        // 값이 없으면 토큰 유무로 판단
        _ => !access.is_empty() || !id_token.is_empty(),
    };
    if !chatgpt && api_key.is_empty() {
        return None;
    }
    let mut a = Auth {
        chatgpt,
        email: String::new(),
        name: String::new(),
        plan: String::new(),
        access_token: if chatgpt { access.to_string() } else { String::new() },
        account_id: tokens.and_then(|t| t.get("account_id")).and_then(Value::as_str).unwrap_or("").to_string(),
    };
    if chatgpt {
        // 계정·요금제는 id_token, 없으면 access_token 클레임에서
        for tok in [id_token, access] {
            let Some(p) = jwt_payload(tok) else { continue };
            let auth = p.get("https://api.openai.com/auth");
            let pick = |obj: &Value, k: &str| obj.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            if a.email.is_empty() {
                a.email = pick(&p, "email");
                if a.email.is_empty() {
                    a.email = p.get("https://api.openai.com/profile").map(|o| pick(o, "email")).unwrap_or_default();
                }
            }
            if a.name.is_empty() {
                a.name = pick(&p, "name");
            }
            if let Some(auth) = auth {
                if a.plan.is_empty() {
                    a.plan = plan_name(&pick(auth, "chatgpt_plan_type"));
                }
                if a.account_id.is_empty() {
                    a.account_id = pick(auth, "chatgpt_account_id");
                }
            }
        }
    }
    Some(a)
}

// ── 사용 한도 ───────────────────────────────────────────────────────────────

/// 사용 한도 창(JSON) 하나를 `Limit` 로 바꾼다.
///
/// used_percent 를 0~100 으로 제한해 percent 로 쓴다. 창 길이는 limit_window_seconds, 없으면 window_minutes×60 이며 0 초과 24시간 이하면 "session"(5시간 한도), 그 외는 "weekly"(주간 한도).
/// 초기화 시각은 reset_at/resets_at(초 단위 epoch)을, 없으면 reset_after_seconds/resets_in_seconds 를 `now` 에 더해 구한다.
///
/// # 인자
/// - `w`: 한도 창 JSON
/// - `now`: 상대 초 값을 절대 시각으로 바꿀 기준 시각
///
/// # 반환
/// `Limit`. used_percent 가 없으면 None.
///
/// # 참조
/// `parse_usage`·`parse_rollout_limits` 가 호출.
fn window_limit(w: &Value, now: DateTime<Utc>) -> Option<Limit> {
    let percent = w.get("used_percent").and_then(Value::as_f64)?;
    let secs = w
        .get("limit_window_seconds")
        .and_then(Value::as_i64)
        .or_else(|| w.get("window_minutes").and_then(Value::as_i64).map(|m| m * 60))
        .unwrap_or(0);
    let reset =
        w.get("reset_at").or_else(|| w.get("resets_at")).and_then(Value::as_i64).and_then(|t| Utc.timestamp_opt(t, 0).single()).or_else(
            || {
                w.get("reset_after_seconds")
                    .or_else(|| w.get("resets_in_seconds"))
                    .and_then(Value::as_i64)
                    .and_then(CDuration::try_seconds)
                    .and_then(|d| now.checked_add_signed(d))
            },
        );
    let (kind, label) = if secs > 0 && secs <= 24 * 3600 { ("session", "5시간 한도") } else { ("weekly", "주간 한도") };
    Some(Limit {
        kind: kind.into(),
        label: label.into(),
        percent: Some(percent.clamp(0.0, 100.0)),
        resets_at: reset.map(|d| d.to_rfc3339()),
    })
}

/// wham/usage 응답을 (요금제 코드, 한도들) 로 해석한다.
///
/// rate_limit 의 primary_window·secondary_window 를 `window_limit` 으로 바꾸되, 같은 종류가 이미 있으면(예: 무료 요금제의 단일 창) 덮어쓰지 않는다.
///
/// # 인자
/// - `v`: wham/usage 응답 JSON
/// - `now`: 기준 시각
///
/// # 반환
/// (plan_type 값 — 없으면 빈 문자열, 한도 목록).
///
/// # 참조
/// `window_limit`. `cached_usage` 가 호출.
fn parse_usage(v: &Value, now: DateTime<Utc>) -> (String, Vec<Limit>) {
    let plan = v.get("plan_type").and_then(Value::as_str).unwrap_or("").to_string();
    let mut out: Vec<Limit> = Vec::new();
    if let Some(rl) = v.get("rate_limit") {
        for key in ["primary_window", "secondary_window"] {
            if let Some(l) = rl.get(key).and_then(|w| window_limit(w, now)) {
                // 같은 종류가 이미 있으면(예: 무료 요금제의 단일 창) 덮어쓰지 않음
                if !out.iter().any(|o| o.kind == l.kind) {
                    out.push(l);
                }
            }
        }
    }
    (plan, out)
}

/// rollout 의 token_count.rate_limits({primary, secondary}) 를 한도 목록으로 바꾼다.
///
/// 이미 초기화 시각이 지난 창은 값이 낡았으므로 뺀다. 같은 종류가 중복되면 앞의 것만 둔다.
///
/// # 인자
/// - `rl`: rate_limits JSON
/// - `now`: 기준 시각
///
/// # 반환
/// `Limit` 목록 (없으면 빈 목록).
///
/// # 참조
/// `window_limit`. `snapshot` 이 한도 조회 실패 시 대체값으로 사용.
fn parse_rollout_limits(rl: &Value, now: DateTime<Utc>) -> Vec<Limit> {
    let mut out: Vec<Limit> = Vec::new();
    for key in ["primary", "secondary"] {
        let Some(l) = rl.get(key).and_then(|w| window_limit(w, now)) else { continue };
        let expired = l.resets_at.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d < now).unwrap_or(false);
        if !expired && !out.iter().any(|o| o.kind == l.kind) {
            out.push(l);
        }
    }
    out
}

/// wham/usage 를 호출해 응답 JSON 을 받는다.
///
/// 제한 시간 20초의 에이전트로 GET 하며 authorization(Bearer)·user-agent 헤더를 붙이고, 계정 id 가 있으면 chatgpt-account-id 도 붙인다.
/// 오류 문구에는 토큰을 넣지 않는다 (401·403 → "인증 만료", 그 밖의 상태 → "HTTP <코드>", 전송 오류 → "네트워크 오류", 본문 읽기·해석 실패 → 각각 짧은 문구).
///
/// # 인자
/// - `auth`: 액세스 토큰·계정 id 를 가진 `Auth`
///
/// # 반환
/// 응답 JSON. 실패하면 짧은 오류 문구.
///
/// # 참조
/// `USAGE_URL`, `ERR_AUTH`. `cached_usage` 가 호출.
fn fetch_usage(auth: &Auth) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).build().into();
    let mut req =
        agent.get(USAGE_URL).header("authorization", &format!("Bearer {}", auth.access_token)).header("user-agent", "codex_cli_rs");
    if !auth.account_id.is_empty() {
        req = req.header("chatgpt-account-id", &auth.account_id);
    }
    let mut resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(401)) | Err(ureq::Error::StatusCode(403)) => return Err(ERR_AUTH.into()),
        Err(ureq::Error::StatusCode(c)) => return Err(format!("HTTP {c}")),
        Err(_) => return Err("네트워크 오류".into()),
    };
    let body = resp.body_mut().read_to_string().map_err(|_| "응답 읽기 실패".to_string())?;
    serde_json::from_str(&body).map_err(|_| "응답 해석 실패".to_string())
}

/// 한도 조회 결과 형태: Ok((요금제 코드, 한도들)) 또는 Err(짧은 오류 문구).
type UsageResult = Result<(String, Vec<Limit>), String>;
/// 한도 조회 결과 캐시: (저장 시각, 결과). `CACHE_SECS`(60초) 동안 재사용한다 (`Mutex` 로 보호).
static USAGE_CACHE: Mutex<Option<(Instant, UsageResult)>> = Mutex::new(None);

/// 조회 중 자물쇠: 겹친 호출(오피스 주기 조회 + 설정 화면)이 각자 네트워크에 묻지 않게 하나만 묻고 나머지는 그 결과를 쓰게 한다.
static USAGE_FETCH: Mutex<()> = Mutex::new(());

/// wham/usage 호출 연속 실패 횟수 (연결 상태 감지용). 인증 만료·4xx 는 연결 문제가 아니므로 세지 않는다.
static NET_FAILS: AtomicU32 = AtomicU32::new(0);
/// 마지막 연결 실패 오류 문구 (`NET_FAILS` 와 함께 갱신).
static NET_LAST_ERR: Mutex<String> = Mutex::new(String::new());
/// 인증 만료를 뜻하는 오류 문구 (`fetch_usage` 가 만들고 `snapshot` 이 `auth_expired` 판정에 비교).
const ERR_AUTH: &str = "인증 만료";

/// 한도 조회 결과를 연결 상태 기록에 반영한다.
///
/// 성공이면 `NET_FAILS` 를 0 으로, "네트워크 오류" 또는 "HTTP 5xx" 이면 1 늘리고 `NET_LAST_ERR` 에 문구를 저장한다. 그 밖의 오류는 무시한다.
///
/// # 인자
/// - `r`: 조회 결과 (Ok 의 값 종류는 무관)
///
/// # 참조
/// `cached_usage` 가 호출.
fn note_usage_result<T>(r: &Result<T, String>) {
    match r {
        Ok(_) => NET_FAILS.store(0, Ordering::Relaxed),
        Err(e) if e == "네트워크 오류" || e.starts_with("HTTP 5") => {
            NET_FAILS.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut g) = NET_LAST_ERR.lock() {
                *g = e.clone();
            }
        }
        Err(_) => {}
    }
}

/// 한도 조회의 연속 실패 상태를 돌려준다.
///
/// # 반환
/// (연속 실패 횟수, 마지막 오류 문구). 잠금 실패 시 문구는 빈 문자열.
///
/// # 참조
/// `NET_FAILS`, `NET_LAST_ERR`.
pub fn usage_net_fails() -> (u32, String) {
    (NET_FAILS.load(Ordering::Relaxed), NET_LAST_ERR.lock().map(|g| g.clone()).unwrap_or_default())
}

/// `USAGE_CACHE` 가 아직 유효하면 그 결과를 돌려준다.
///
/// # 반환
/// 저장된 지 `CACHE_SECS` 이내인 결과 복제본. 없거나 낡았거나 잠금 실패면 None.
///
/// # 참조
/// `cached_usage` 가 호출.
fn fresh_usage() -> Option<UsageResult> {
    let g = USAGE_CACHE.lock().ok()?;
    let (at, r) = g.as_ref()?;
    (at.elapsed() < Duration::from_secs(CACHE_SECS)).then(|| r.clone())
}

/// 캐시·단일 조회 자물쇠를 거쳐 한도를 가져온다.
///
/// 유효한 캐시가 있으면 반환하고, 없으면 `USAGE_FETCH` 를 잡은 뒤 한 번 더 캐시를 확인(기다리는 사이 다른 호출이 받아 왔을 수 있음)한다.
/// 그래도 없으면 `fetch_usage` → `parse_usage` 로 조회해 `note_usage_result` 로 연결 상태를 기록하고 `USAGE_CACHE` 에 저장한다 (오류도 저장).
///
/// # 인자
/// - `auth`: 로그인 정보
///
/// # 반환
/// (요금제 코드, 한도들) 또는 짧은 오류 문구.
///
/// # 참조
/// `fresh_usage`, `fetch_usage`, `parse_usage`, `note_usage_result`. `snapshot` 이 호출.
fn cached_usage(auth: &Auth) -> UsageResult {
    if let Some(r) = fresh_usage() {
        return r;
    }
    let _fetching = USAGE_FETCH.lock();
    if let Some(r) = fresh_usage() {
        return r; // 기다리는 사이 다른 호출이 받아 옴
    }
    let r = fetch_usage(auth).map(|v| parse_usage(&v, Utc::now()));
    note_usage_result(&r);
    if let Ok(mut g) = USAGE_CACHE.lock() {
        *g = Some((Instant::now(), r.clone()));
    }
    r
}

// ── 세션 ────────────────────────────────────────────────────────────────────

/// 파일 끝 n 바이트를 줄 단위로 읽는다.
///
/// 시작 위치가 파일 처음이 아니면 첫 줄은 잘렸을 수 있어 버린다. 바이트는 UTF-8 손실 변환.
///
/// # 인자
/// - `p`: 파일 경로
/// - `n`: 읽을 마지막 바이트 수
///
/// # 반환
/// 줄 목록. 파일을 열거나 읽지 못하면 빈 목록.
///
/// # 참조
/// `file_info`·`index_names`·`poll_finished` 가 호출.
fn tail_lines(p: &Path, n: u64) -> Vec<String> {
    let Ok(mut f) = File::open(p) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(n);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut buf = Vec::new();
    if f.take(n).read_to_end(&mut buf).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&buf);
    let mut it = text.lines().map(str::to_string);
    if start > 0 {
        it.next();
    }
    it.collect()
}

/// 파일 앞 n 바이트까지 줄 단위로 읽으며 머리 정보를 찾는다 (다 찾으면 바로 멈춤).
///
/// # 인자
/// - `p`: 파일 경로
/// - `n`: 읽을 최대 바이트 수
///
/// # 반환
/// `Head`. 파일을 열지 못하면 기본값.
///
/// # 참조
/// `parse_head`. `file_info` 가 호출.
fn read_head(p: &Path, n: u64) -> Head {
    let Ok(f) = File::open(p) else { return Head::default() };
    let lines = BufReader::new(f.take(n)).split(b'\n').map_while(Result::ok).map(|b| String::from_utf8_lossy(&b).into_owned());
    parse_head(lines)
}

/// 지침·환경 안내 같은 자동 삽입 메시지인지 판정한다.
///
/// 앞 공백을 뗀 텍스트가 비었거나 '<' 로 시작하거나 "# AGENTS.md"·"# Context from my IDE"·"[external_agent" 로 시작하면 true.
///
/// # 인자
/// - `t`: 메시지 텍스트
///
/// # 반환
/// 자동 삽입 메시지면 true.
///
/// # 참조
/// `user_text` 가 호출.
fn is_boilerplate(t: &str) -> bool {
    let t = t.trim_start();
    t.is_empty()
        || t.starts_with('<')
        || t.starts_with("# AGENTS.md")
        || t.starts_with("# Context from my IDE")
        || t.starts_with("[external_agent")
}

/// 공백을 한 칸으로 정리하고 길이를 제한한다.
///
/// # 인자
/// - `t`: 원문
/// - `max`: 최대 글자 수 (넘으면 잘라 "…" 를 붙임)
///
/// # 반환
/// 한 줄로 정리된 문자열.
fn shorten(t: &str, max: usize) -> String {
    let one: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > max {
        one.chars().take(max).collect::<String>() + "…"
    } else {
        one
    }
}

/// rollout 한 줄(JSON)에서 진짜 사용자 메시지 본문을 뽑는다.
///
/// (event_msg, user_message) 의 message, 또는 (response_item, message) 중 role 이 user 인 content 에서 자동 삽입 메시지가 아닌 첫 text 를 쓴다. 뽑은 텍스트가 자동 삽입 메시지면 제외.
///
/// # 인자
/// - `o`: rollout 한 줄을 파싱한 JSON
///
/// # 반환
/// 사용자 메시지 본문. 해당하지 않으면 None.
///
/// # 참조
/// `is_boilerplate`. `parse_head`·`parse_tok_file` 이 제목에 사용.
fn user_text(o: &Value) -> Option<String> {
    let p = o.get("payload")?;
    let t = match (o.get("type").and_then(Value::as_str)?, p.get("type").and_then(Value::as_str)?) {
        ("event_msg", "user_message") => p.get("message").and_then(Value::as_str)?.to_string(),
        ("response_item", "message") if p.get("role").and_then(Value::as_str) == Some("user") => p
            .get("content")?
            .as_array()?
            .iter()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .find(|t| !is_boilerplate(t))?
            .to_string(),
        _ => return None,
    };
    if is_boilerplate(&t) {
        None
    } else {
        Some(t)
    }
}

/// rollout 파일 머리에서 읽은 세션 정보 (id·작업 폴더·시작 시각·제목).
///
/// `parse_head` 가 만든다.
#[derive(Default, Debug, Clone)]
struct Head {
    /// 세션 id (session_meta.id)
    id: String,
    /// 작업 폴더 (session_meta.cwd)
    cwd: String,
    /// 시작 시각 (session_meta.timestamp, 없으면 줄의 timestamp)
    started_at: Option<String>,
    /// 첫 사용자 메시지를 80자로 줄인 제목 (없으면 빈 값)
    title: String,
    /// session_meta.thread_source ("user" 등, 가져온 세션은 빈 값)
    thread_source: String,
}

/// rollout 줄들에서 머리 정보를 찾는다.
///
/// session_meta 줄에서 id·cwd·thread_source·시작 시각을, 그 외 줄에서는 제목이 비었을 때 `user_text` 로 첫 사용자 메시지를 뽑아 80자로 줄인다.
/// id 와 제목을 둘 다 찾으면 읽기를 멈춘다. JSON 이 아닌 줄은 건너뛴다.
///
/// # 인자
/// - `lines`: rollout 줄 이터레이터
///
/// # 반환
/// `Head` (못 찾은 값은 빈 값/None).
///
/// # 참조
/// `user_text`, `shorten`. `read_head` 가 호출.
fn parse_head(lines: impl IntoIterator<Item = impl AsRef<str>>) -> Head {
    let mut h = Head::default();
    for l in lines {
        let Ok(o) = serde_json::from_str::<Value>(l.as_ref()) else { continue };
        if o.get("type").and_then(Value::as_str) == Some("session_meta") {
            let p = o.get("payload").cloned().unwrap_or(Value::Null);
            let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            h.id = s("id");
            h.cwd = s("cwd");
            h.thread_source = s("thread_source");
            let ts = s("timestamp");
            h.started_at = if ts.is_empty() { o.get("timestamp").and_then(Value::as_str).map(str::to_string) } else { Some(ts) };
        } else if h.title.is_empty() {
            if let Some(t) = user_text(&o) {
                h.title = shorten(&t, 80);
            }
        }
        if !h.id.is_empty() && !h.title.is_empty() {
            break;
        }
    }
    h
}

/// rollout 꼬리에서 읽은 턴 진행 상태.
///
/// `parse_tail` 이 정하고 `decide_status` 가 세션 상태 판정에 쓴다.
#[derive(Default, Debug, PartialEq, Clone)]
enum Turn {
    /// 꼬리에서 턴 표식을 못 찾음
    #[default]
    Unknown,
    /// 턴이 진행 중 (task_started·turn_started 가 마지막 표식)
    Running,
    /// 턴이 끝남 (task_complete·turn_complete·turn_aborted·shutdown_complete 가 마지막 표식)
    Done,
}

/// rollout 꼬리에서 읽은 값 (마지막 시각·턴 상태·rate_limits).
///
/// `parse_tail` 이 만든다.
#[derive(Default, Debug)]
struct Tail {
    /// 마지막 줄의 timestamp 문자열
    last_ts: Option<String>,
    /// 턴 진행 상태
    turn: Turn,
    /// 가장 최근 token_count.rate_limits (없으면 Null)
    rate_limits: Value,
}

/// rollout 꼬리 줄들에서 마지막 시각·턴 상태·rate_limits 를 읽는다.
///
/// 줄 순서대로 훑으며 timestamp 를 갱신하고, event_msg 의 task_started/turn_started 는 Running, task_complete/turn_complete/turn_aborted/shutdown_complete 는 Done 으로 바꾸며,
/// token_count 에 rate_limits 객체가 있으면 가장 나중 것을 보관한다. JSON 이 아닌 줄은 건너뛴다.
///
/// # 인자
/// - `lines`: 꼬리 줄 목록
///
/// # 반환
/// `Tail`.
///
/// # 참조
/// `file_info` 가 호출.
fn parse_tail(lines: &[String]) -> Tail {
    let mut t = Tail { rate_limits: Value::Null, ..Default::default() };
    for l in lines {
        let Ok(o) = serde_json::from_str::<Value>(l) else { continue };
        if let Some(ts) = o.get("timestamp").and_then(Value::as_str) {
            t.last_ts = Some(ts.to_string());
        }
        let p = o.get("payload").unwrap_or(&Value::Null);
        let pt = p.get("type").and_then(Value::as_str).unwrap_or("");
        match (o.get("type").and_then(Value::as_str).unwrap_or(""), pt) {
            ("event_msg", "task_started" | "turn_started") => t.turn = Turn::Running,
            ("event_msg", "task_complete" | "turn_complete" | "turn_aborted" | "shutdown_complete") => t.turn = Turn::Done,
            ("event_msg", "token_count") if p.get("rate_limits").map(|r| r.is_object()).unwrap_or(false) => {
                t.rate_limits = p["rate_limits"].clone();
            }
            _ => {}
        }
    }
    t
}

/// 세션 상태 문자열을 판정한다.
///
/// 턴이 Running 이고 마지막 쓰기가 10분 이내이거나, 턴을 모르는데(Unknown) 15초 이내에 쓰였으면 "busy". 그 외 30분 이내에 쓰였으면 "idle". 그 밖은 "".
///
/// # 인자
/// - `turn`: 꼬리에서 읽은 턴 상태
/// - `age`: 파일이 마지막으로 수정된 뒤 지난 시간
///
/// # 반환
/// "busy" | "idle" | "".
///
/// # 참조
/// `collect_sessions` 가 호출.
fn decide_status(turn: &Turn, age: Duration) -> &'static str {
    let s = age.as_secs();
    if (*turn == Turn::Running && s < 600) || (*turn == Turn::Unknown && s < 15) {
        "busy"
    } else if s < 30 * 60 {
        "idle"
    } else {
        ""
    }
}

/// 채팅 충돌 판정(4.2)용 Codex 스레드 활동 상태. rollout 파일만 근거(app-server 는 남의 스레드를 전부 `notLoaded` 로 보고함).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Activity {
    /// 하위(서브) 에이전트 스레드 — 보기만.
    Sub,
    /// 다른 프로세스가 지금 작업 중(턴 진행 표식 + 10분 이내, 또는 15초 이내 쓰기).
    Busy,
    /// 마지막 쓰기가 30분 이내인 쉼 — 다른 창이 열려 있을 수 있음.
    Idle,
    /// 30분 넘게 조용하거나 기록을 못 찾음 — 이어서 쓸 수 있음.
    Quiet,
}

/// 파일 정보에서 활동 상태를 정한다(순수 함수).
///
/// # 인자
/// - `thread_source`: session_meta.thread_source
/// - `turn`: 꼬리에서 읽은 턴 상태
/// - `age`: 마지막 수정 뒤 지난 시간
///
/// # 반환
/// 서브 에이전트면 `Sub`, 그 외 `decide_status` 결과를 `Busy`/`Idle`/`Quiet` 로 옮긴 값.
fn activity_of(thread_source: &str, turn: &Turn, age: Duration) -> Activity {
    if thread_source.contains("sub") {
        return Activity::Sub;
    }
    match decide_status(turn, age) {
        "busy" => Activity::Busy,
        "idle" => Activity::Idle,
        _ => Activity::Quiet,
    }
}

/// 스레드 id 의 rollout 파일을 찾아 활동 상태를 돌려준다(최근 2일 폴더만 — 더 오래된 파일은 어차피 `Quiet`).
///
/// # 인자
/// - `id`: Codex 스레드(세션) id
///
/// # 반환
/// `Activity`. Codex 폴더나 기록을 못 찾으면 `Quiet`.
///
/// # 참조
/// `recent_rollouts`, `file_info`, `activity_of`. `runner` 의 충돌 판정이 호출.
pub fn session_activity(id: &str) -> Activity {
    let Some(home) = codex_home() else { return Activity::Quiet };
    if !is_uuid_like(id) {
        return Activity::Quiet;
    }
    let cutoff = (Local::now() - CDuration::days(2)).date_naive();
    let suffix = format!("{id}.jsonl");
    let best = recent_rollouts(&home.join("sessions"), cutoff)
        .into_iter()
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?;
            Some((m.modified().ok()?, m.len(), p))
        })
        .max_by_key(|x| x.0);
    let Some((mt, len, path)) = best else { return Activity::Quiet };
    let info = file_info(&path, mt, len, true);
    activity_of(&info.head.thread_source, &info.turn, SystemTime::now().duration_since(mt).unwrap_or_default())
}

/// 날짜 폴더(YYYY/MM/DD)를 최근 것부터 훑어 rollout 파일을 모은다.
///
/// 연·월·일 폴더 이름을 숫자 내림차순으로 따라가며, cutoff 보다 오래된 날짜를 만나면 멈춘다. 이름이 "rollout-" 로 시작하고 ".jsonl" 로 끝나는 파일만 담는다. 유효하지 않은 날짜는 건너뛴다.
///
/// # 인자
/// - `root`: sessions 폴더 (~/.codex/sessions)
/// - `cutoff`: 이 날짜보다 오래된 폴더는 보지 않음
///
/// # 반환
/// rollout 파일 경로 목록 (최근 날짜 폴더부터).
///
/// # 참조
/// `collect_sessions`·`token_report`·`poll_finished` 가 호출.
fn recent_rollouts(root: &Path, cutoff: NaiveDate) -> Vec<PathBuf> {
    /// 폴더 안의 숫자 이름 항목을 큰 수부터 정렬해 돌려준다 (`recent_rollouts` 안에서만 사용).
    ///
    /// # 인자
    /// - `dir`: 읽을 폴더
    ///
    /// # 반환
    /// (숫자, 경로) 목록 (내림차순). 읽지 못하거나 숫자가 아닌 이름은 제외.
    fn sorted_nums(dir: &Path) -> Vec<(u32, PathBuf)> {
        let mut v: Vec<(u32, PathBuf)> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some((e.file_name().to_str()?.parse::<u32>().ok()?, e.path())))
            .collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.0));
        v
    }
    let mut out = Vec::new();
    'y: for (y, yp) in sorted_nums(root) {
        for (m, mp) in sorted_nums(&yp) {
            for (d, dp) in sorted_nums(&mp) {
                match NaiveDate::from_ymd_opt(y as i32, m, d) {
                    Some(date) if date < cutoff => break 'y,
                    Some(_) => {}
                    None => continue,
                }
                for e in std::fs::read_dir(&dp).into_iter().flatten().flatten() {
                    let p = e.path();
                    let n = e.file_name().to_string_lossy().into_owned();
                    if n.starts_with("rollout-") && n.ends_with(".jsonl") {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

/// session_index.jsonl 꼬리에서 세션 id → 대화 이름 맵을 만든다 (뒤에 나온 것이 우선).
///
/// 꼬리 256KB 의 줄 중 id 와 thread_name 이 있고 이름이 비지 않은 것만 담는다.
///
/// # 인자
/// - `home`: Codex 데이터 폴더
///
/// # 반환
/// id → 대화 이름 (파일이 없으면 빈 맵).
///
/// # 참조
/// `tail_lines`. `index_names_cached` 가 호출. 읽는 파일: session_index.jsonl
fn index_names(home: &Path) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for l in tail_lines(&home.join("session_index.jsonl"), 256 * 1024) {
        let Ok(o) = serde_json::from_str::<Value>(&l) else { continue };
        if let (Some(id), Some(n)) = (o.get("id").and_then(Value::as_str), o.get("thread_name").and_then(Value::as_str)) {
            if !n.trim().is_empty() {
                m.insert(id.to_string(), n.to_string());
            }
        }
    }
    m
}

/// `collect_sessions` 의 결과: 세션 목록과 한도 대체용 rate_limits.
struct Sessions {
    /// 최근 세션 목록 (마지막 활동 최근순)
    list: Vec<PSession>,
    /// 가장 최근 파일부터 찾은 rate_limits (한도 조회 실패 시 대체용)
    rate_limits: Value,
}

/// rollout 파일별로 읽어 둔 값.
///
/// 머리는 한 번 다 찾으면 다시 읽지 않고, 꼬리는 파일이 바뀌었을 때만 다시 읽는다. `FILES` 에 캐시된다.
#[derive(Clone)]
struct FileInfo {
    /// 읽을 때의 파일 수정 시각 (캐시 유효성 비교)
    mtime: SystemTime,
    /// 읽을 때의 파일 크기 (캐시 유효성 비교)
    len: u64,
    /// 머리 정보
    head: Head,
    /// 턴 진행 상태 (꼬리에 표식이 없으면 지난번 값 유지)
    turn: Turn,
    /// 마지막 줄의 timestamp 문자열
    last_ts: Option<String>,
    /// 꼬리에서 찾은 가장 최근 rate_limits (없으면 Null)
    rate_limits: Value,
}
/// rollout 경로 → `FileInfo` 캐시.
///
/// `file_info` 가 사용하며 항목이 400개를 넘으면 비운다 (오래 켜 둔 경우 지난 파일 정리). `Mutex` 로 보호.
static FILES: Mutex<Option<HashMap<PathBuf, FileInfo>>> = Mutex::new(None);
/// session_index.jsonl 캐시 형태: (수정 시각, 크기, id → 대화 이름).
type IndexCache = Option<(SystemTime, u64, HashMap<String, String>)>;
/// session_index.jsonl 읽은 값 캐시. 파일의 (수정 시각, 크기) 가 바뀌면 다시 읽는다 (`Mutex` 로 보호).
static INDEX: Mutex<IndexCache> = Mutex::new(None);

/// session_index.jsonl 의 id → 대화 이름 맵을 캐시를 거쳐 돌려준다.
///
/// 파일의 (수정 시각, 크기) 가 `INDEX` 와 같으면 저장본을, 아니면 `index_names` 로 다시 읽어 저장한다.
///
/// # 인자
/// - `home`: Codex 데이터 폴더
///
/// # 반환
/// id → 대화 이름.
///
/// # 참조
/// `index_names`, `INDEX`. `collect_sessions`·`token_report`·`poll_finished` 가 호출.
fn index_names_cached(home: &Path) -> HashMap<String, String> {
    let p = home.join("session_index.jsonl");
    let meta = std::fs::metadata(&p).ok();
    let key = meta.as_ref().and_then(|m| Some((m.modified().ok()?, m.len())));
    if let (Some((mt, len)), Ok(g)) = (key, INDEX.lock()) {
        if let Some((cmt, clen, m)) = g.as_ref() {
            if *cmt == mt && *clen == len {
                return m.clone();
            }
        }
    }
    let m = index_names(home);
    if let (Some((mt, len)), Ok(mut g)) = (key, INDEX.lock()) {
        *g = Some((mt, len, m.clone()));
    }
    m
}

/// rollout 파일 하나의 정보를 읽는다 (캐시 우선).
///
/// `FILES` 의 값이 (mtime, 크기) 가 같고 필요한 머리가 있으면 그대로 반환한다. 아니면 꼬리를 `parse_tail` 로 다시 읽고, 머리는 id·제목을 이미 찾았으면 재사용, 필요(`need_head`)하면 `read_head` 로 읽는다.
/// 꼬리에 턴 표식이 없으면(긴 도구 출력 등) 지난번 판정을 이어 써서 오래 걸리는 명령이 쉼으로 깜빡이지 않게 한다.
///
/// # 인자
/// - `path`: rollout 파일 경로
/// - `mt`: 파일 수정 시각
/// - `len`: 파일 크기(바이트)
/// - `need_head`: 머리 정보(id·제목)가 필요한지
///
/// # 반환
/// `FileInfo`.
///
/// # 참조
/// `tail_lines`, `parse_tail`, `read_head`, `FILES`. `collect_sessions`·`poll_finished` 가 호출.
fn file_info(path: &Path, mt: SystemTime, len: u64, need_head: bool) -> FileInfo {
    let prev = FILES.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(path).cloned()));
    if let Some(p) = &prev {
        if p.mtime == mt && p.len == len && (!need_head || !p.head.id.is_empty()) {
            return p.clone();
        }
    }
    let tail = parse_tail(&tail_lines(path, TAIL_BYTES));
    let head = match &prev {
        // 머리(메타·첫 메시지)는 이미 다 찾았으면 그대로
        Some(p) if !p.head.id.is_empty() && !p.head.title.is_empty() => p.head.clone(),
        _ if need_head => read_head(path, HEAD_BYTES),
        _ => prev.as_ref().map(|p| p.head.clone()).unwrap_or_default(),
    };
    // 꼬리(64KB)에 턴 표식이 없으면(긴 도구 출력 등) 지난번 판정을 이어 쓴다 — 오래 걸리는 명령이 쉼으로 깜빡이지 않게
    let turn = if tail.turn == Turn::Unknown { prev.as_ref().map(|p| p.turn.clone()).unwrap_or_default() } else { tail.turn };
    let info = FileInfo { mtime: mt, len, head, turn, last_ts: tail.last_ts, rate_limits: tail.rate_limits };
    if let Ok(mut g) = FILES.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 400 {
            m.clear(); // 오래 켜 둔 경우 지난 파일 정리
        }
        m.insert(path.to_path_buf(), info.clone());
    }
    info
}

/// 최근 세션 목록과 한도 대체용 rate_limits 를 모은다.
///
/// 최근 48시간 날짜 폴더의 rollout 을 수정 시각 최근순으로 훑는다. 24시간 이내 파일만 세션(최대 `MAX_SESSIONS`)으로 넣고, 그보다 오래된 파일은 rate_limits 대체값을 못 찾았을 때만 몇 개(최대 6개) 더 본다.
/// 같은 세션 id 가 여러 파일에 있으면 가장 최근 것만 쓴다. 제목은 session_index 의 대화 이름 → 머리의 제목 순, 상태는 `decide_status`, 열기 링크는 `thread_url`. 결과는 마지막 활동 최근순으로 정렬한다.
///
/// # 인자
/// - `home`: Codex 데이터 폴더
///
/// # 반환
/// `Sessions` (세션 목록, 가장 최근 파일에서 찾은 rate_limits).
///
/// # 참조
/// `index_names_cached`, `recent_rollouts`, `file_info`, `decide_status`, `thread_url`, `providers::project_of`. `snapshot`·`token_report` 가 호출.
fn collect_sessions(home: &Path) -> Sessions {
    let cutoff = (Local::now() - CDuration::hours(48)).date_naive();
    let names = index_names_cached(home);
    let sys_now = SystemTime::now();
    let mut files: Vec<(SystemTime, u64, PathBuf)> = recent_rollouts(&home.join("sessions"), cutoff)
        .into_iter()
        .filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?;
            Some((m.modified().ok()?, m.len(), p))
        })
        .collect();
    files.sort_by_key(|x| std::cmp::Reverse(x.0));

    let mut list: Vec<PSession> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut rate_limits = Value::Null;
    let mut extra = 0;
    for (mt, len, path) in files {
        let age = sys_now.duration_since(mt).unwrap_or_default();
        let recent = age <= Duration::from_secs(24 * 3600);
        let tail = file_info(&path, mt, len, recent && list.len() < MAX_SESSIONS);
        if rate_limits.is_null() && !tail.rate_limits.is_null() {
            rate_limits = tail.rate_limits.clone();
        }
        if !recent {
            // 하루 넘은 파일은 세션 목록엔 안 넣고, 한도 대체값을 못 찾았을 때만 몇 개 더 훑는다
            extra += 1;
            if !rate_limits.is_null() || extra > 5 {
                break;
            }
            continue;
        }
        if list.len() >= MAX_SESSIONS {
            break;
        }
        let head = tail.head.clone();
        let id = if head.id.is_empty() {
            // 파일 이름 끝 36자(uuid)
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            stem.get(stem.len().saturating_sub(36)..).unwrap_or("").to_string()
        } else {
            head.id.clone()
        };
        if !seen_ids.insert(id.clone()) {
            continue; // 같은 세션 id 가 여러 파일에 있으면 가장 최근 파일만 (최근 것부터 훑음)
        }
        let title = names.get(&id).map(|n| shorten(n, 80)).filter(|t| !t.is_empty()).unwrap_or(head.title);
        let last_at = tail.last_ts.clone().or_else(|| Some(DateTime::<Utc>::from(mt).to_rfc3339()));
        let id_for_url = id.clone();
        list.push(PSession {
            id,
            title,
            project: project_of(&head.cwd),
            cwd: head.cwd,
            status: decide_status(&tail.turn, age).into(),
            started_at: head.started_at,
            last_at,
            url: thread_url(&id_for_url),
        });
    }
    list.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Sessions { list, rate_limits }
}

// ── 진입점 ──────────────────────────────────────────────────────────────────

/// Codex(ChatGPT 계정) 의 현재 상태를 `Snapshot` 으로 모은다.
///
/// Codex 폴더가 있으면 installed, auth.json 이 해석되면 logged_in 이다. 세션은 `collect_sessions` 로 채운다.
/// ChatGPT 로그인이고 액세스 토큰이 있을 때만 `cached_usage` 로 한도를 조회한다 (API 키 로그인은 요금제·한도가 없음).
/// 조회가 실패하면 인증 만료 여부를 `auth_expired` 에 기록하고 최근 세션의 rate_limits 로 대체하며, 대체도 못 하면 오류 문구만 남긴다. 토큰은 결과에 넣지 않는다.
///
/// # 반환
/// `Snapshot` ("chatgpt"). 폴더가 없으면 installed=false 인 빈 값.
///
/// # 참조
/// `codex_home`, `parse_auth`, `collect_sessions`, `cached_usage`, `parse_rollout_limits`, `plan_name`. `providers::snapshot` 이 호출. 읽는 파일: auth.json, sessions/…/rollout-*.jsonl, session_index.jsonl
pub fn snapshot() -> Snapshot {
    let mut s = Snapshot::new("chatgpt");
    let Some(home) = codex_home() else { return s };
    s.installed = home.is_dir();
    if !s.installed {
        return s;
    }
    let auth = std::fs::read_to_string(home.join("auth.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| parse_auth(&v));
    s.logged_in = auth.is_some();

    let now = Utc::now();
    let sess = collect_sessions(&home);
    s.sessions = sess.list;

    if let Some(a) = &auth {
        s.account = if a.email.is_empty() { a.name.clone() } else { a.email.clone() };
        s.plan = a.plan.clone();
        // API 키 로그인은 요금제·한도가 없음
        if a.chatgpt && !a.access_token.is_empty() {
            match cached_usage(a) {
                Ok((plan, limits)) => {
                    if !plan.is_empty() {
                        s.plan = plan_name(&plan);
                    }
                    s.limits = limits;
                    if s.limits.is_empty() {
                        s.error = "사용 한도 정보가 없습니다".into();
                    }
                }
                Err(e) => {
                    s.auth_expired = e == ERR_AUTH;
                    let fb = parse_rollout_limits(&sess.rate_limits, now);
                    if fb.is_empty() {
                        s.error = "사용 한도를 불러오지 못했습니다".into();
                    } else {
                        s.limits = fb;
                        s.error = "사용 한도: 최근 세션 기록 기준(오래된 값일 수 있음)".into();
                    }
                }
            }
        }
    }
    s
}

// ── 열기 · 로그인 ───────────────────────────────────────────────────────────

/// 세션 id 가 uuid 꼴(16진수·하이픈)인지 검사한다 — 열기 링크·경로에 넣기 전 확인용.
///
/// # 인자
/// - `id`: 세션 id
///
/// # 반환
/// 길이 8~64 이고 모든 글자가 16진수 또는 '-' 이면 true.
///
/// # 참조
/// `thread_url` 이 호출.
pub fn is_uuid_like(id: &str) -> bool {
    id.len() >= 8 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Codex 앱에서 이 대화를 여는 링크를 만든다.
///
/// # 인자
/// - `id`: 세션 id
///
/// # 반환
/// "codex://threads/<id>". id 가 uuid 꼴이 아니면 빈 문자열.
///
/// # 참조
/// `is_uuid_like`. `collect_sessions` 가 호출.
fn thread_url(id: &str) -> String {
    if is_uuid_like(id) {
        format!("codex://threads/{id}")
    } else {
        String::new()
    }
}

/// PATH 에서 codex 실행 파일(codex.exe·codex.cmd)을 찾는다 (Windows).
///
/// # 반환
/// 찾은 파일 경로. 없으면 None.
///
/// # 참조
/// `cli_path` 가 호출.
#[cfg(windows)]
fn cli_in_path() -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.iter().flat_map(|d| ["codex.exe", "codex.cmd"].map(|n| d.join(n))).find(|p| p.is_file())
}

/// MSIX(Microsoft Store) 설치의 번들 CLI 를 찾는다 (Windows).
///
/// PowerShell 의 `Get-AppxPackage OpenAI.Codex` 에서 InstallLocation 을 읽어 app/resources/codex.exe 경로를 만든다. 버전마다 경로가 바뀌므로 매번 묻는다 (읽기 전용 조회, 창은 띄우지 않음).
///
/// # 반환
/// codex.exe 경로. 설치 정보가 없거나 파일이 없으면 None.
///
/// # 참조
/// `cli_path` 가 호출.
#[cfg(windows)]
fn cli_in_msix() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation"])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let loc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if loc.is_empty() {
        return None;
    }
    let p = PathBuf::from(loc).join("app").join("resources").join("codex.exe");
    p.is_file().then_some(p)
}

/// codex CLI 위치를 찾는다. 찾기가 느려서(프로세스 생성) 결과를 10분 캐시한다.
///
/// 캐시가 10분 이내이고 경로가 아직 파일로 존재하면 재사용한다. Windows 에서는 `cli_in_path` 다음 `cli_in_msix` 로 찾고, 그 밖의 OS 는 항상 못 찾은 것으로 본다.
///
/// # 반환
/// codex 실행 파일 경로. 없으면 None.
///
/// # 참조
/// `cli_in_path`, `cli_in_msix`. `spawn_login` 이 호출.
pub fn cli_path() -> Option<PathBuf> {
    /// `cli_path` 의 캐시: (조회 시각, 찾은 경로).
    static C: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);
    if let Ok(g) = C.lock() {
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(600) && v.as_ref().is_none_or(|p| p.is_file()) {
                return v.clone();
            }
        }
    }
    #[cfg(windows)]
    let found = cli_in_path().or_else(cli_in_msix);
    #[cfg(not(windows))]
    let found: Option<PathBuf> = None;
    if let Ok(mut g) = C.lock() {
        *g = Some((Instant::now(), found.clone()));
    }
    found
}

/// 새 콘솔에서 `codex login` 을 실행한다 (사용자가 버튼을 눌렀을 때만 부를 것).
///
/// CLI 를 못 찾으면 Ok(false) 로 돌려 호출한 쪽이 앱 열기로 대신하게 한다. Windows 에서는 PowerShell 을 새 콘솔로 띄우며 경로는 환경변수 MEOWFFICE_CODEX 로 넘겨 인용 문제를 피하고,
/// 로그인이 실패했을 때만 창이 남게 한다. Windows 가 아니면 실행하지 않고 Ok(false).
///
/// # 반환
/// 실행했으면 Ok(true), CLI 를 못 찾았거나 지원하지 않는 OS 면 Ok(false), 프로세스 시작 실패 시 Err(오류 문구).
///
/// # 참조
/// `cli_path`.
pub fn spawn_login() -> Result<bool, String> {
    let Some(exe) = cli_path() else { return Ok(false) };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Windows 프로세스 생성 플래그: 새 콘솔 창에서 실행.
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        // 경로는 환경변수로 넘겨 인용 문제 회피. 실패했을 때만 창을 남겨 오류를 읽을 수 있게
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "& $env:MEOWFFICE_CODEX login; if ($LASTEXITCODE) { Read-Host '로그인 실패 - Enter 를 누르면 창이 닫힙니다' }",
            ])
            .env("MEOWFFICE_CODEX", &exe)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| e.to_string())?;
        log::info!("Codex 로그인 실행(사용자 요청)");
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        Ok(false)
    }
}

// ── 토큰 사용량 ─────────────────────────────────────────────────────────────

/// rollout 파일 하나에서 읽은 토큰 기록과 세션 정보.
///
/// `parse_tok_file` 이 만들고 `TOK_CACHE` 에 캐시된다.
#[derive(Default)]
struct TokFile {
    /// 세션 id (session_meta.id, 없으면 파일 이름 끝 36자)
    id: String,
    /// 작업 폴더
    cwd: String,
    /// 첫 사용자 메시지를 80자로 줄인 제목
    title: String,
    /// 세션 시작 시각
    started: Option<DateTime<Utc>>,
    /// 다른 에이전트에서 가져온 세션(thread_source 없음 + turn_context 없음) — 집계에서 뺀다 (Claude 와 이중 집계 방지)
    imported: bool,
    /// 응답별 토큰 기록 (imported 이면 비움)
    recs: Vec<Rec>,
}

/// 파일별 파싱 결과 캐시 형태: 경로 → (수정 시각, 크기, 파싱 결과). (mtime, 크기) 가 같으면 다시 읽지 않는다.
type TokCache = Option<HashMap<PathBuf, (SystemTime, u64, Arc<TokFile>)>>;
/// `TokFile` 파싱 결과 캐시. `tok_file` 이 사용하며 항목이 400개를 넘으면 비운다 (`Mutex` 로 보호).
static TOK_CACHE: Mutex<TokCache> = Mutex::new(None);

/// JSON 객체에서 부호 없는 정수 값을 읽는다.
///
/// # 인자
/// - `v`: JSON 객체
/// - `k`: 필드 이름
///
/// # 반환
/// 값. 없거나 정수가 아니면 0.
fn num_of(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// token_usage_record 의 usage 를 (순수 입력, 캐시 읽기, 캐시 쓰기, 출력) 으로 나눈다.
///
/// total_tokens = input_tokens + output_tokens 이므로 cached_input_tokens(·cache_write_input_tokens)는 input_tokens 에 이미 들어 있다. 그래서 순수 입력 = input - cached - cache_write 로 구한다(각각 남은 입력 안으로 제한).
/// 출력 = output_tokens 이며, 추론 토큰 reasoning_output_tokens 도 output 에 포함되어 있어 따로 더하지 않는다.
///
/// # 인자
/// - `usage`: usage JSON (input_tokens·cached_input_tokens·cache_write_input_tokens·output_tokens)
///
/// # 반환
/// (순수 입력, 캐시 읽기, 캐시 쓰기, 출력) 토큰 수.
///
/// # 참조
/// `num_of`. `parse_tok_file` 이 호출.
fn usage_parts(usage: &Value) -> (u64, u64, u64, u64) {
    let input = num_of(usage, "input_tokens");
    let cached = num_of(usage, "cached_input_tokens").min(input);
    let write = num_of(usage, "cache_write_input_tokens").min(input - cached);
    (input - cached - write, cached, write, num_of(usage, "output_tokens"))
}

/// rollout 파일 하나를 읽어 `TokFile` 로 만든다.
///
/// session_meta·turn_context·token_usage_record·제목 후보 표식이 있는 줄만 JSON 으로 해석한다. turn_context 의 모델을 turn_id 별로 기억해 기록에 붙이며(없으면 마지막 모델, 그것도 없으면 "(모델 미상)"),
/// 같은 response_id 는 한 번만 센다. thread_source 도 turn_context 도 없는 파일은 다른 에이전트에서 가져온 세션(imported)으로 보고 기록을 비운다 (Claude 와 이중 집계 방지).
///
/// # 인자
/// - `path`: rollout 파일 경로
///
/// # 반환
/// `TokFile`. 파일을 못 열면 빈 값.
///
/// # 참조
/// `usage_parts`, `user_text`, `shorten`, `ptokens::Rec`. `tok_file` 이 호출.
fn parse_tok_file(path: &Path) -> TokFile {
    let mut f = TokFile::default();
    let Ok(file) = File::open(path) else { return f };
    let mut turn_model: HashMap<String, String> = HashMap::new();
    let mut last_model = String::new();
    let mut have_ctx = false;
    let mut thread_source = false;
    let mut seen_resp: HashSet<String> = HashSet::new();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let stem_id = stem.get(stem.len().saturating_sub(36)..).unwrap_or("").to_string();
    for raw in BufReader::new(file).split(b'\n').map_while(Result::ok) {
        // 큰 줄(대화·도구 출력)은 필요한 표식이 있을 때만 해석
        let line = String::from_utf8_lossy(&raw);
        let is_meta = line.contains("\"session_meta\"");
        let is_ctx = line.contains("\"turn_context\"");
        let is_rec = line.contains("\"token_usage_record\"");
        let is_user = f.title.is_empty() && (line.contains("\"user_message\"") || line.contains("\"role\":\"user\""));
        if !(is_meta || is_ctx || is_rec || is_user) {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
        let p = o.get("payload").unwrap_or(&Value::Null);
        match o.get("type").and_then(Value::as_str).unwrap_or("") {
            "session_meta" => {
                let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("");
                f.id = s("id").to_string();
                f.cwd = s("cwd").to_string();
                thread_source = !s("thread_source").is_empty();
                let ts = if s("timestamp").is_empty() { o.get("timestamp").and_then(Value::as_str).unwrap_or("") } else { s("timestamp") };
                f.started = DateTime::parse_from_rfc3339(ts).ok().map(|d| d.with_timezone(&Utc));
            }
            "turn_context" => {
                have_ctx = true;
                if let Some(m) = p.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                    last_model = m.to_string();
                    if let Some(t) = p.get("turn_id").and_then(Value::as_str) {
                        turn_model.insert(t.to_string(), m.to_string());
                    }
                }
            }
            "token_usage_record" => {
                let Some(usage) = p.get("usage") else { continue };
                if let Some(r) = p.get("response_id").and_then(Value::as_str).filter(|r| !r.is_empty()) {
                    if !seen_resp.insert(r.to_string()) {
                        continue;
                    }
                }
                let Some(ts) = o.get("timestamp").and_then(Value::as_str).and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else {
                    continue;
                };
                let model = p
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .and_then(|t| turn_model.get(t).cloned())
                    .or_else(|| Some(last_model.clone()).filter(|m| !m.is_empty()))
                    .unwrap_or_else(|| "(모델 미상)".into());
                let (input, cache_read, cache_write, output) = usage_parts(usage);
                f.recs.push(Rec { session: String::new(), ts: ts.with_timezone(&Utc), model, input, output, cache_write, cache_read });
            }
            _ => {
                if f.title.is_empty() {
                    if let Some(t) = user_text(&o) {
                        f.title = shorten(&t, 80);
                    }
                }
            }
        }
    }
    if f.id.is_empty() {
        f.id = stem_id;
    }
    f.imported = !thread_source && !have_ctx;
    if f.imported {
        f.recs.clear();
    }
    for r in &mut f.recs {
        r.session = f.id.clone();
    }
    f
}

/// `TokFile` 을 캐시를 거쳐 돌려준다.
///
/// `TOK_CACHE` 의 (mtime, 크기) 가 같으면 재사용하고, 아니면 `parse_tok_file` 로 읽어 저장한다 (400개 초과 시 비움).
///
/// # 인자
/// - `path`: rollout 파일 경로
/// - `mt`: 파일 수정 시각
/// - `len`: 파일 크기
///
/// # 반환
/// 파싱 결과 (`Arc` 공유).
///
/// # 참조
/// `parse_tok_file`, `TOK_CACHE`. `token_report` 가 호출.
fn tok_file(path: &Path, mt: SystemTime, len: u64) -> Arc<TokFile> {
    if let Ok(g) = TOK_CACHE.lock() {
        if let Some((cmt, clen, d)) = g.as_ref().and_then(|m| m.get(path)) {
            if *cmt == mt && *clen == len {
                return d.clone();
            }
        }
    }
    let d = Arc::new(parse_tok_file(path));
    if let Ok(mut g) = TOK_CACHE.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 400 {
            m.clear();
        }
        m.insert(path.to_path_buf(), (mt, len, d.clone()));
    }
    d
}

/// Codex 의 모델·날짜·세션별 토큰 사용량을 만든다 (Claude 의 local::report 와 같은 모양).
///
/// `days` 를 1~90 으로 보정하고 시작 시각은 `ptokens::cutoff_of` 로 정한다. 긴 세션은 시작한 날 폴더에 계속 쌓이므로 폴더 날짜는 7일 더 넉넉히 보고 파일 수정 시각으로 거른다.
/// imported 파일은 건너뛰고, 같은 (세션, 시각, 토큰 합) 응답은 한 번만 센다. 제목은 session_index 이름 → 파일 제목 순, 상태는 `collect_sessions` 결과에서 가져온다.
///
/// # 인자
/// - `days`: 기간(일). 1~90 으로 보정
///
/// # 반환
/// `local::LocalReport`. Codex 폴더를 알 수 없으면 빈 보고서.
///
/// # 참조
/// `codex_home`, `index_names_cached`, `collect_sessions`, `recent_rollouts`, `tok_file`, `ptokens::build`.
pub fn token_report(days: u32) -> crate::local::LocalReport {
    let days = days.clamp(1, 90);
    let cutoff = crate::ptokens::cutoff_of(days);
    let Some(home) = codex_home() else { return crate::ptokens::build(days, &[], &HashMap::new()) };
    // 긴 세션은 시작한 날 폴더에 계속 쌓이므로 폴더 날짜는 넉넉히(7일 더) 보고, 파일 수정 시각으로 거른다
    let dir_cutoff = (cutoff - CDuration::days(7)).with_timezone(&Local).date_naive();
    let sys_cut: SystemTime = cutoff.into();
    let names = index_names_cached(&home);
    let live: HashMap<String, String> = collect_sessions(&home).list.into_iter().map(|s| (s.id, s.status)).collect();
    let mut recs: Vec<Rec> = Vec::new();
    let mut meta: HashMap<String, Meta> = HashMap::new();
    let mut seen_resp: HashSet<(String, i64, u64)> = HashSet::new();
    for path in recent_rollouts(&home.join("sessions"), dir_cutoff) {
        let Some((mt, len)) = std::fs::metadata(&path).ok().and_then(|m| Some((m.modified().ok()?, m.len()))) else { continue };
        if mt < sys_cut {
            continue;
        }
        let d = tok_file(&path, mt, len);
        if d.imported {
            continue;
        }
        for r in &d.recs {
            // 같은 세션 id 가 여러 파일에 있어도 같은 응답을 두 번 세지 않음
            if seen_resp.insert((r.session.clone(), r.ts.timestamp_millis(), r.output + r.input)) {
                recs.push(r.clone());
            }
        }
        let title = names.get(&d.id).map(|n| shorten(n, 80)).filter(|t| !t.is_empty()).unwrap_or_else(|| d.title.clone());
        meta.insert(
            d.id.clone(),
            Meta { title, cwd: d.cwd.clone(), status: live.get(&d.id).cloned().unwrap_or_default(), started: d.started },
        );
    }
    crate::ptokens::build(days, &recs, &meta)
}

// ── 턴 끝남 알림 ────────────────────────────────────────────────────────────

/// 끝난 턴 1건 (rollout 의 task_complete).
///
/// `poll_finished` 가 만든다. 제목·프로젝트 이름만 담고 대화 내용은 담지 않는다.
pub struct Finished {
    /// 세션 id
    pub id: String,
    /// 세션 제목 (session_index 이름 → 첫 사용자 메시지 제목)
    pub title: String,
    /// 작업 폴더 이름
    pub project: String,
    /// 끝난 턴의 turn_id (중복 알림 방지 키)
    pub turn: String,
}

/// `poll_finished` 의 기준 상태 (처음 부른 시각·조회 하한 시각·이미 알린 turn_id).
struct DoneState {
    /// 처음 부른 시각 — 이보다 앞서 끝난 기록은 알리지 않는다 (기동 때 지난 기록 폭주 방지)
    start: DateTime<Utc>,
    /// 이 시각 이후에 끝난 것만 본다 (직전 조회보다 조금 앞으로 겹쳐 놓치지 않게, 중복은 seen 으로 거름)
    since: DateTime<Utc>,
    /// 이미 알린 turn_id 집합 (500개를 넘으면 비움)
    seen: HashSet<String>,
}
/// `poll_finished` 의 기준 상태 보관소 (`Mutex` 로 보호). None 이면 아직 기준을 잡지 않은 것.
static DONE: Mutex<Option<DoneState>> = Mutex::new(None);

/// 끝남 알림의 기준을 지운다.
///
/// 연동을 껐다가 다시 켰을 때 그 사이 끝난 기록이 한꺼번에 알림으로 뜨지 않게 `DONE` 을 비운다.
///
/// # 참조
/// `DONE`, `poll_finished`.
pub fn reset_finished() {
    if let Ok(mut g) = DONE.lock() {
        *g = None;
    }
}

/// 새로 끝난 턴 목록을 돌려준다.
///
/// 처음 부르면 기준 시각(`DONE`)만 잡고 빈 목록을 돌려준다. 이후에는 기준 시각 이후 수정된 rollout 의 꼬리에서 event_msg/task_complete 줄을 찾아,
/// 시각이 `since`·`start` 보다 늦고 turn_id 가 있으며 아직 알리지 않은 것만 담는다. 하위(서브) 에이전트 스레드의 끝남은 제외한다.
/// 끝나면 `since` 를 (지금 - 20초, 단 start 이상)로 겹치게 옮기고, 중복은 `seen` 으로 거른다. 설정 파일은 건드리지 않는다.
///
/// # 반환
/// `Finished` 목록. 첫 호출·Codex 폴더 없음·잠금 실패면 빈 목록.
///
/// # 참조
/// `codex_home`, `recent_rollouts`, `tail_lines`, `file_info`, `index_names_cached`, `providers::project_of`, `DONE`.
pub fn poll_finished() -> Vec<Finished> {
    let now = Utc::now();
    let Some(home) = codex_home() else { return vec![] };
    let (start, since, mut seen) = {
        let Ok(mut g) = DONE.lock() else { return vec![] };
        match g.as_mut() {
            None => {
                *g = Some(DoneState { start: now, since: now, seen: HashSet::new() });
                return vec![];
            }
            Some(s) => (s.start, s.since, std::mem::take(&mut s.seen)),
        }
    };
    let names = index_names_cached(&home);
    let cutoff = (Local::now() - CDuration::hours(48)).date_naive();
    let sys_since: SystemTime = (since - CDuration::seconds(5)).into();
    let mut out = Vec::new();
    for path in recent_rollouts(&home.join("sessions"), cutoff) {
        let Some((mt, len)) = std::fs::metadata(&path).ok().and_then(|m| Some((m.modified().ok()?, m.len()))) else { continue };
        if mt < sys_since {
            continue;
        }
        let mut found: Vec<String> = vec![];
        for l in tail_lines(&path, TAIL_BYTES) {
            if !l.contains("\"task_complete\"") {
                continue;
            }
            let Ok(o) = serde_json::from_str::<Value>(&l) else { continue };
            let p = o.get("payload").unwrap_or(&Value::Null);
            if o.get("type").and_then(Value::as_str) != Some("event_msg") || p.get("type").and_then(Value::as_str) != Some("task_complete")
            {
                continue;
            }
            let Some(at) = o
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .map(|d| d.with_timezone(&Utc))
            else {
                continue;
            };
            let turn = p.get("turn_id").and_then(Value::as_str).unwrap_or("").to_string();
            if at > since && at > start && !turn.is_empty() && seen.insert(turn.clone()) {
                found.push(turn);
            }
        }
        if found.is_empty() {
            continue;
        }
        let info = file_info(&path, mt, len, true);
        // 하위(서브) 에이전트 스레드의 끝남은 알리지 않는다
        if info.head.thread_source.contains("sub") {
            continue;
        }
        let id = if info.head.id.is_empty() {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
        } else {
            info.head.id.clone()
        };
        let title = names.get(&id).map(|n| shorten(n, 80)).filter(|t| !t.is_empty()).unwrap_or_else(|| info.head.title.clone());
        for turn in found {
            out.push(Finished { id: id.clone(), title: title.clone(), project: project_of(&info.head.cwd), turn });
        }
    }
    if let Ok(mut g) = DONE.lock() {
        if seen.len() > 500 {
            seen.clear(); // since 보다 앞선 것은 어차피 걸러지므로 비워도 중복되지 않음
        }
        *g = Some(DoneState { start, since: (now - CDuration::seconds(20)).max(start), seen });
    }
    out
}

/// auth·한도·세션 머리/꼬리·상태·토큰 파싱 단위 테스트 (일부는 실데이터 스모크).
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(v: &Value) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap())
    }

    fn fake_jwt(claims: &Value) -> String {
        format!("{}.{}.sig", b64(&json!({"alg":"none"})), b64(claims))
    }

    #[test]
    fn auth_chatgpt() {
        let id = fake_jwt(
            &json!({"email":"a@example.com","name":"A","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"acc1"}}),
        );
        let v = json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":id,"access_token":"x","account_id":"acc9"}});
        let a = parse_auth(&v).unwrap();
        assert!(a.chatgpt);
        assert_eq!(a.email, "a@example.com");
        assert_eq!(a.plan, "Plus");
        assert_eq!(a.account_id, "acc9");
    }

    #[test]
    fn auth_apikey_only() {
        let a = parse_auth(&json!({"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"})).unwrap();
        assert!(!a.chatgpt && a.plan.is_empty() && a.access_token.is_empty());
        assert!(parse_auth(&json!({"OPENAI_API_KEY":null})).is_none());
    }

    #[test]
    fn plan_names() {
        assert_eq!(plan_name("pro"), "Pro");
        assert_eq!(plan_name("team"), "Team");
        assert_eq!(plan_name(""), "");
    }

    #[test]
    fn usage_parse() {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let v = json!({"plan_type":"plus","rate_limit":{
            "primary_window":{"used_percent":12.5,"limit_window_seconds":18000,"reset_after_seconds":600,"reset_at":1_700_000_600},
            "secondary_window":{"used_percent":40,"limit_window_seconds":604800,"reset_after_seconds":9000,"reset_at":1_700_009_000}}});
        let (plan, l) = parse_usage(&v, now);
        assert_eq!(plan, "plus");
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].kind.as_str(), l[0].percent), ("session", Some(12.5)));
        assert_eq!(l[1].kind, "weekly");
        assert!(l[0].resets_at.as_deref().unwrap().starts_with("2023-11-14T22:23:20"));
    }

    #[test]
    fn usage_free_single_weekly_window() {
        let now = Utc::now();
        let v = json!({"plan_type":"free","rate_limit":{"primary_window":{"used_percent":3,"limit_window_seconds":604800,"reset_after_seconds":100},"secondary_window":null}});
        let (_, l) = parse_usage(&v, now);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].kind, "weekly");
        assert!(l[0].resets_at.is_some());
    }

    #[test]
    fn rollout_limits_drop_expired() {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let rl = json!({"primary":{"used_percent":5.0,"window_minutes":300,"resets_in_seconds":60},"secondary":{"used_percent":9.0,"window_minutes":10080,"resets_at":1_600_000_000}});
        let l = parse_rollout_limits(&rl, now);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].kind, "session");
        assert!(parse_rollout_limits(&Value::Null, now).is_empty());
    }

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_string).collect()
    }

    #[test]
    fn head_skips_boilerplate() {
        let l = lines(
            r##"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"C:\\work\\proj","timestamp":"2026-01-01T00:00:00Z"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"# AGENTS.md instructions"}}
{"type":"event_msg","payload":{"type":"user_message","message":"  로그인   버그 고쳐줘  "}}"##,
        );
        let h = parse_head(&l);
        assert_eq!((h.id.as_str(), h.cwd.as_str()), ("s1", "C:\\work\\proj"));
        assert_eq!(h.title, "로그인 버그 고쳐줘");
        assert_eq!(project_of(&h.cwd), "proj");
    }

    #[test]
    fn tail_turn_state() {
        let running = parse_tail(&lines(
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"function_call"}}"#,
        ));
        assert_eq!(running.turn, Turn::Running);
        assert_eq!(running.last_ts.as_deref(), Some("2026-01-01T00:00:02Z"));
        let done = parse_tail(&lines(
            r#"{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1.0}}}}
{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ));
        assert_eq!(done.turn, Turn::Done);
        assert!(done.rate_limits.is_object());
    }

    #[test]
    fn status_rules() {
        let s = Duration::from_secs;
        assert_eq!(decide_status(&Turn::Running, s(5)), "busy");
        assert_eq!(decide_status(&Turn::Running, s(3600)), "");
        assert_eq!(decide_status(&Turn::Unknown, s(5)), "busy");
        assert_eq!(decide_status(&Turn::Done, s(5)), "idle");
        assert_eq!(decide_status(&Turn::Done, s(1000)), "idle");
        assert_eq!(decide_status(&Turn::Done, s(4000)), "");
    }

    /// 채팅 충돌 판정 경계값: 턴 진행 10분, 알 수 없음 15초, 쉼 30분, 서브 에이전트.
    #[test]
    fn activity_boundaries() {
        let s = Duration::from_secs;
        assert_eq!(activity_of("user", &Turn::Running, s(599)), Activity::Busy);
        assert_eq!(activity_of("user", &Turn::Running, s(600)), Activity::Idle);
        assert_eq!(activity_of("user", &Turn::Unknown, s(14)), Activity::Busy);
        assert_eq!(activity_of("user", &Turn::Unknown, s(15)), Activity::Idle);
        assert_eq!(activity_of("user", &Turn::Done, s(1799)), Activity::Idle);
        assert_eq!(activity_of("user", &Turn::Done, s(1800)), Activity::Quiet);
        assert_eq!(activity_of("subagent", &Turn::Running, s(1)), Activity::Sub);
        assert_eq!(session_activity("not-a-uuid"), Activity::Quiet);
    }

    #[test]
    fn usage_parts_exclude_cached_from_input() {
        // total_tokens = input + output 이므로 cached 는 input 안에 들어 있다 → 순수 입력 = input - cached
        let u = json!({"input_tokens": 22937, "cached_input_tokens": 12032, "cache_write_input_tokens": 0, "output_tokens": 48, "reasoning_output_tokens": 7});
        assert_eq!(usage_parts(&u), (10905, 12032, 0, 48));
        // 값이 엇갈려도 음수로 넘치지 않음
        assert_eq!(usage_parts(&json!({"input_tokens": 5, "cached_input_tokens": 9})), (0, 5, 0, 0));
    }

    #[test]
    fn thread_links_only_uuid_like() {
        assert_eq!(thread_url("01a1e9af-abc2-7ab3-91ec-befca3bafa07"), "codex://threads/01a1e9af-abc2-7ab3-91ec-befca3bafa07");
        assert_eq!(thread_url("../../x"), "");
        assert_eq!(thread_url("a b"), "");
        assert!(!is_uuid_like("zzzzzzzz"));
    }

    #[test]
    fn token_file_skips_imported_and_picks_turn_model() {
        let dir = std::env::temp_dir().join(format!("meow-codex-tok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = |resp: &str, turn: &str, i: u64, c: u64| {
            format!(
                r#"{{"timestamp":"2026-11-17T13:26:12.000Z","type":"token_usage_record","payload":{{"turn_id":"{turn}","response_id":"{resp}","usage":{{"input_tokens":{i},"cached_input_tokens":{c},"output_tokens":3}}}}}}"#
            )
        };
        let real = [
            r#"{"type":"session_meta","payload":{"id":"s-real","cwd":"C:\\w\\p","thread_source":"user","timestamp":"2026-11-17T13:00:00Z"}}"#.to_string(),
            r#"{"timestamp":"2026-11-17T13:26:08.000Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-x"}}"#.to_string(),
            rec("r1", "t1", 100, 40),
            rec("r1", "t1", 100, 40), // 같은 응답 중복
            rec("r2", "t1", 10, 0),
        ]
        .join("\n");
        let imported = [
            r#"{"type":"session_meta","payload":{"id":"s-imp","cwd":"C:\\w\\p"}}"#.to_string(),
            rec("r9", "t9", 1000, 0), // thread_source 없음 + turn_context 없음 → 가져온 세션
        ]
        .join("\n");
        let (pr, pi) = (dir.join("real.jsonl"), dir.join("imp.jsonl"));
        std::fs::write(&pr, real).unwrap();
        std::fs::write(&pi, imported).unwrap();
        let (a, b) = (parse_tok_file(&pr), parse_tok_file(&pi));
        std::fs::remove_dir_all(&dir).ok();
        assert!(!a.imported && b.imported && b.recs.is_empty());
        assert_eq!(a.recs.len(), 2);
        assert_eq!((a.recs[0].input, a.recs[0].cache_read, a.recs[0].output), (60, 40, 3));
        assert_eq!(a.recs[0].model, "gpt-x");
        assert_eq!(a.recs[0].session, "s-real");
    }

    /// 실제 ~/.codex 읽기: `cargo test live_tokens -- --ignored --nocapture` (숫자만 출력)
    #[test]
    #[ignore]
    fn live_tokens() {
        for days in [1u32, 7, 30] {
            let r = token_report(days);
            println!(
                "codex days={days} turns={} total={} models={} sessions={} running={}",
                r.turns,
                r.total,
                r.by_model.len(),
                r.sessions.len(),
                r.running
            );
            for m in &r.by_model {
                println!(
                    "  model {} total={} in={} cache={} out={}",
                    m.model, m.total, m.tokens.input, m.tokens.cache_read, m.tokens.output
                );
            }
        }
        println!("cli found: {}", cli_path().is_some());
        let s = snapshot();
        println!(
            "sessions={} urls={} expired={}",
            s.sessions.len(),
            s.sessions.iter().filter(|x| x.url.starts_with("codex://threads/")).count(),
            s.auth_expired
        );
        println!("finished first={} second={}", poll_finished().len(), poll_finished().len());
    }

    #[test]
    #[ignore]
    fn live_snapshot() {
        let t = Instant::now();
        let s = snapshot();
        println!("{}", serde_json::to_string_pretty(&s).unwrap());
        println!("elapsed: {:?}", t.elapsed());
    }
}
