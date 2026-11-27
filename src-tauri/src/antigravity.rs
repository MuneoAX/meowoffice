//! Google Antigravity 상태 → providers::Snapshot.
//! 자료:
//!   - ~/.gemini/antigravity            (daemon/hub_<포트>.json, conversation_summaries.db, conversations, brain)
//!   - %LOCALAPPDATA%\Programs\Antigravity (설치 여부)
//!   - %APPDATA%\Antigravity\app_storage.json (마지막 로그인 계정 이름)
//!   - 윈도우 자격 증명 관리자 항목 `gemini:antigravity` (로그인 여부 — 존재만 확인, 내용은 읽지 않음)
//!   - 실행 중인 language server 의 로컬 HTTP(Connect JSON) API: GetUserStatus(계정·요금제·모델별 쿼터),
//!     GetUserQuotaSummary(그룹별 쿼터). 접속 정보(포트·CSRF)는 daemon/hub_*.json 에서 읽어 이 프로세스 안에서만 쓴다.
//!
//!   - conversations/<id>.db (SQLite, 예전 .pb), brain/<id>/.system_generated/logs/{transcript.jsonl, media/*.jpg}:
//!     대화 시작 시각, 토큰 사용량(숫자만), 책상 모니터 그림. 모델 이름은 conversations/<id>.db 의 gen_metadata(읽기 전용).
//!
//! 사용 한도·요금제는 Antigravity 가 켜져 있을 때만 알 수 있다. 비밀값(CSRF·토큰)은 어디에도 출력·저장하지 않는다.

use crate::i18n;
use crate::local::pid_alive;
use crate::providers::{project_of, Limit, PSession, Snapshot};
use crate::ptokens::{Meta, Rec};
use chrono::{DateTime, Duration as CDuration, TimeZone, Utc};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// 언어 서버 Connect JSON API 의 서비스 이름 (호출 주소 `/<서비스>/<메서드>` 에 들어간다).
const LS_SERVICE: &str = "exa.language_server_pb.LanguageServerService";
/// 원격(언어 서버) 조회 성공 결과를 재사용하는 시간 (60초). cmdkey 결과 캐시에도 쓴다.
const OK_TTL: Duration = Duration::from_secs(60);
/// 원격(언어 서버) 조회 실패 결과를 재사용하는 시간 (20초).
const FAIL_TTL: Duration = Duration::from_secs(20);
/// 최근 세션으로 보는 기간(시간) — 이보다 오래된 대화는 세션 목록에서 뺀다.
const RECENT_HOURS: i64 = 24;
/// 쉼(idle) 으로 보는 기간(분) — 마지막 수정이 이 안이면 idle.
const IDLE_MINUTES: i64 = 30;
/// 윈도우 자격 증명 관리자의 Antigravity 항목 이름 (존재만 확인하고 내용은 읽지 않는다).
const CRED_TARGET: &str = "gemini:antigravity";
/// 로그인되어 있지 않을 때 `Snapshot.error` 에 넣는 문구(현재 언어).
fn msg_not_logged_in() -> &'static str {
    i18n::t("agy.err.not_logged_in")
}

// ── 위치 ────────────────────────────────────────────────────────────────────

/// Antigravity 데이터 폴더(~/.gemini/antigravity) 위치를 구한다.
///
/// # 반환
/// 폴더 경로. 홈 폴더를 알 수 없으면 None (실제로 있는지는 확인하지 않음).
///
/// # 참조
/// `token_report`·`last_image`·`probe_health`·`snapshot` 이 호출.
fn data_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().join(".gemini").join("antigravity"))
}

/// Antigravity 설치 폴더(%LOCALAPPDATA%/Programs/Antigravity) 위치를 구한다.
///
/// # 반환
/// 폴더 경로. 알 수 없으면 None.
///
/// # 참조
/// `snapshot` 이 설치 여부 판정에 사용.
fn app_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.data_local_dir().join("Programs").join("Antigravity"))
}

/// app_storage.json(%APPDATA%/Antigravity) 위치를 구한다.
///
/// # 반환
/// 파일 경로. 알 수 없으면 None.
///
/// # 참조
/// `last_login_account` 가 호출.
fn app_storage_path() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.data_dir().join("Antigravity").join("app_storage.json"))
}

// ── 로그인 ──────────────────────────────────────────────────────────────────

/// 자격 증명 관리자에 Antigravity 항목이 있는지 확인한다.
///
/// Windows 에서만 `cmdkey /list:<항목>` 을 창 없이 실행해 출력의 Target 줄만 본다 (비밀값은 출력되지 않음). 다른 OS 는 항상 false.
///
/// # 반환
/// 항목이 있으면 true. 실행 실패도 false.
///
/// # 참조
/// `parse_cmdkey`. `credential_exists_cached` 가 호출.
fn credential_exists() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("cmdkey").arg(format!("/list:{CRED_TARGET}")).creation_flags(0x0800_0000).output();
        match out {
            Ok(o) => parse_cmdkey(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// cmdkey 출력에 항목이 있는지 판정한다.
///
/// 항목 이름을 포함한 줄이 머리말 말고 한 번 더 나오면(2줄 이상) 항목 있음, 없으면 머리말에만 이름이 나온다. 출력은 로캘·코드페이지에 따라 깨질 수 있다.
///
/// # 인자
/// - `text`: cmdkey 표준 출력 문자열
///
/// # 반환
/// 항목이 있으면 true.
fn parse_cmdkey(text: &str) -> bool {
    text.lines().filter(|l| l.contains(CRED_TARGET)).count() >= 2
}

/// `credential_exists` 결과를 60초(`OK_TTL`) 캐시해 돌려준다 (cmdkey 호출은 프로세스 생성이라 비싸다).
///
/// `RUNNING` 자물쇠로 cmdkey 를 동시에 여러 번 띄우지 않게 한다.
///
/// # 반환
/// 항목이 있으면 true.
///
/// # 참조
/// `credential_exists`. `snapshot` 이 호출.
fn credential_exists_cached() -> bool {
    /// `credential_exists_cached` 의 캐시: (조회 시각, 결과).
    static C: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    /// cmdkey 를 동시에 여러 번 띄우지 않게 하는 자물쇠.
    static RUNNING: Mutex<()> = Mutex::new(()); // cmdkey 를 동시에 여러 번 띄우지 않게
    let _one = RUNNING.lock();
    if let Ok(g) = C.lock() {
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() < OK_TTL {
                return *v;
            }
        }
    }
    let v = credential_exists();
    if let Ok(mut g) = C.lock() {
        *g = Some((Instant::now(), v));
    }
    v
}

/// app_storage.json 의 마지막 로그인 계정(agy.onboarding.lastLoginUsername)을 읽는다 (토큰류가 아님).
///
/// # 반환
/// 계정 이메일/이름. 파일이 없거나 해석할 수 없거나 값이 없으면 빈 문자열.
///
/// # 참조
/// `app_storage_path`. `snapshot` 이 호출.
fn last_login_account() -> String {
    let Some(p) = app_storage_path() else { return String::new() };
    let Ok(txt) = std::fs::read_to_string(p) else { return String::new() };
    let v: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
    v.get("agy.onboarding.lastLoginUsername").and_then(|x| x.as_str()).unwrap_or("").to_string()
}

// ── 언어 서버 접속 정보 ─────────────────────────────────────────────────────

/// 언어 서버 접속 정보 (포트·CSRF).
///
/// daemon/hub_*.json 에서 읽어 이 프로세스 안에서만 쓰며, 어디에도 출력·저장하지 않는다.
struct Hub {
    /// 언어 서버 HTTP 포트 (127.0.0.1)
    port: u16,
    /// 요청 헤더 x-codeium-csrf-token 값 (비밀값)
    csrf: String,
}

/// daemon/hub_*.json 에서 살아 있는 언어 서버 접속 정보를 모은다.
///
/// 이름이 "hub_" 로 시작하는 파일을 수정 시각 최근순으로 정렬해 `parse_hub` 로 해석하고, 최대 4개를 돌려준다.
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
///
/// # 반환
/// `Hub` 목록 (최근 파일부터). 폴더가 없으면 빈 목록.
///
/// # 참조
/// `parse_hub`, `pid_alive`. `fetch_remote_uncached`·`probe_health` 가 호출. 읽는 파일: daemon/hub_*.json
fn find_hubs(dir: &Path) -> Vec<Hub> {
    let Ok(rd) = std::fs::read_dir(dir.join("daemon")) else { return vec![] };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("hub_"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files.into_iter().filter_map(|(_, p)| parse_hub(&std::fs::read_to_string(&p).ok()?, pid_alive)).take(4).collect()
}

/// hub 파일 JSON 을 `Hub` 로 해석한다.
///
/// pid·httpPort·csrfToken 이 모두 있어야 하며, 포트가 0 이거나 CSRF 가 비었거나 `alive(pid)` 가 거짓이면 버린다.
///
/// # 인자
/// - `txt`: hub 파일 내용
/// - `alive`: pid 가 살아 있는지 판정하는 함수 (테스트에서 대체 가능)
///
/// # 반환
/// `Hub`. 조건을 만족하지 않으면 None.
///
/// # 참조
/// `find_hubs` 가 호출.
fn parse_hub(txt: &str, alive: impl Fn(u32) -> bool) -> Option<Hub> {
    let v: Value = serde_json::from_str(txt).ok()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    let port = u16::try_from(v.get("httpPort")?.as_u64()?).ok()?;
    let csrf = v.get("csrfToken")?.as_str()?.to_string();
    if port == 0 || csrf.is_empty() || !alive(pid) {
        return None;
    }
    Some(Hub { port, csrf })
}

// ── 언어 서버 호출 ──────────────────────────────────────────────────────────

/// 언어 서버 호출 실패 종류.
///
/// `ls_call` 이 만들고 `fetch_remote_uncached`·`probe_health` 가 분기에 쓴다.
#[derive(Debug, Clone, Copy, PartialEq)]
enum CallErr {
    /// HTTP 401·403 — 서버가 로그인 안 됨으로 답함
    Auth,
    /// 전송 오류·시간 초과·본문 읽기 실패 (서버에 닿지 못함)
    Net,
    /// 그 밖의 HTTP 상태 오류 또는 JSON 해석 실패
    Other,
}

/// 로컬 언어 서버의 Connect JSON 메서드를 호출한다.
///
/// 127.0.0.1 로 POST 하며(본문은 "{}") 제한 시간 3초다. CSRF 토큰이 프록시로 새지 않도록 환경 변수 프록시(HTTP_PROXY 등)를 쓰지 않는다.
/// 401·403 은 `Auth`, 그 밖의 상태는 `Other`, 전송 오류는 `Net`, 본문 읽기 실패는 `Net`, JSON 해석 실패는 `Other`.
///
/// # 인자
/// - `hub`: 접속 정보 (포트·CSRF)
/// - `method`: 메서드 이름 (예: GetUserStatus·GetUserQuotaSummary·GetAuthStatus)
///
/// # 반환
/// 응답 JSON. 실패하면 `CallErr`.
///
/// # 참조
/// `LS_SERVICE`. `fetch_remote_uncached`·`probe_health` 가 호출.
fn ls_call(hub: &Hub, method: &str) -> Result<Value, CallErr> {
    // 127.0.0.1 언어 서버: 환경 변수 프록시(HTTP_PROXY 등)를 타지 않게 끈다 — CSRF 토큰이 프록시로 새지 않도록
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).proxy(None).build().into();
    let url = format!("http://127.0.0.1:{}/{LS_SERVICE}/{method}", hub.port);
    let mut resp = match agent
        .post(&url)
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .header("x-codeium-csrf-token", &hub.csrf)
        .send("{}")
    {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(401)) | Err(ureq::Error::StatusCode(403)) => return Err(CallErr::Auth),
        Err(ureq::Error::StatusCode(_)) => return Err(CallErr::Other),
        Err(_) => return Err(CallErr::Net),
    };
    let body = resp.body_mut().read_to_string().map_err(|_| CallErr::Net)?;
    serde_json::from_str(&body).map_err(|_| CallErr::Other)
}

/// 언어 서버에서 얻은 값 묶음 (실행 여부·계정·요금제·한도·오류·로그인 판정).
///
/// `fetch_remote_uncached` 가 만들고 `CACHE` 에 캐시된다.
#[derive(Clone, Default)]
struct Remote {
    /// 언어 서버(hub + 살아 있는 프로세스)가 있음
    running: bool,
    /// 계정 이메일 (없으면 name, 그것도 없으면 빈 값)
    account: String,
    /// 요금제 이름 (모르면 빈 값)
    plan: String,
    /// 모델별·그룹별 사용 한도
    limits: Vec<Limit>,
    /// 사람이 읽을 짧은 설명 (비밀값 없음)
    error: String,
    /// 서버가 로그인 상태를 확인함 (계정 이메일이 있음)
    signed_in: bool,
    /// 서버가 로그인 안 됨이라고 답함
    signed_out: bool,
}

/// 원격 조회 결과 캐시: (저장 시각, 유효 시간, 결과).
///
/// 성공이면 `OK_TTL`, 실패면 `FAIL_TTL` 동안 재사용한다 (`Mutex` 로 보호).
static CACHE: Mutex<Option<(Instant, Duration, Remote)>> = Mutex::new(None);

/// 조회 중 자물쇠: 겹친 호출이 각자 언어 서버에 묻지 않게 하나만 묻고 나머지는 그 결과를 쓰게 한다.
static FETCHING: Mutex<()> = Mutex::new(());

/// `CACHE` 가 아직 유효하면 그 결과를 돌려준다.
///
/// # 반환
/// 저장된 지 유효 시간 이내인 결과 복제본. 없거나 낡았거나 잠금 실패면 None.
///
/// # 참조
/// `fetch_remote` 가 호출.
fn fresh_remote() -> Option<Remote> {
    let g = CACHE.lock().ok()?;
    let (at, ttl, r) = g.as_ref()?;
    (at.elapsed() < *ttl).then(|| r.clone())
}

/// 원격 값을 캐시·단일 조회 자물쇠를 거쳐 가져온다.
///
/// 유효한 캐시가 있으면 반환하고, 없으면 `FETCHING` 을 잡은 뒤 다시 확인한다. 그래도 없으면 `fetch_remote_uncached` 로 조회해 (결과, 유효 시간) 을 `CACHE` 에 저장한다.
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
///
/// # 반환
/// `Remote`.
///
/// # 참조
/// `fresh_remote`, `fetch_remote_uncached`. `snapshot`·`token_report` 가 호출.
fn fetch_remote(dir: &Path) -> Remote {
    if let Some(r) = fresh_remote() {
        return r;
    }
    let _fetching = FETCHING.lock();
    if let Some(r) = fresh_remote() {
        return r;
    }
    let (r, ttl) = fetch_remote_uncached(dir);
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((Instant::now(), ttl, r.clone()));
    }
    r
}

/// 언어 서버에 직접 묻는다 (캐시 없음).
///
/// 살아 있는 hub 가 없으면 "실행 중일 때만 볼 수 있다" 오류와 `FAIL_TTL` 을 돌려준다. 있으면 running 으로 보고, 낡은 hub 파일(재사용된 pid 등)은 접속이 안 되므로 `Net` 오류가 아닐 때까지 다음 hub 로 GetUserStatus 를 시도한다.
/// 성공하면 계정·요금제·모델별 쿼터를 채우고, `Auth` 오류면 signed_out 과 `OK_TTL` 로 바로 끝낸다. 이어서 GetUserQuotaSummary 가 있으면 그룹별 쿼터로 한도를 대체한다(서버가 응답하지 않았으면 다시 기다리지 않음).
/// 한도가 비면 상황에 맞는 오류 문구를 넣는다.
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
///
/// # 반환
/// (`Remote`, 유효 시간). 상태 호출이 실패했으면 `FAIL_TTL`, 아니면 `OK_TTL`.
///
/// # 참조
/// `find_hubs`, `ls_call`, `parse_user`, `parse_model_quotas`, `parse_quota_summary`. `fetch_remote` 가 호출.
fn fetch_remote_uncached(dir: &Path) -> (Remote, Duration) {
    let mut r = Remote::default();
    let hubs = find_hubs(dir);
    if hubs.is_empty() {
        r.error = i18n::t("agy.err.not_running").into();
        return (r, FAIL_TTL);
    }
    r.running = true;
    // 낡은 hub 파일(재사용된 pid 등)은 접속이 안 되므로 다음 것을 시도
    let mut picked = None;
    for h in hubs {
        let st = ls_call(&h, "GetUserStatus");
        let stop = !matches!(st, Err(CallErr::Net));
        picked = Some((h, st));
        if stop {
            break;
        }
    }
    let Some((hub, status)) = picked else { return (r, FAIL_TTL) };
    match &status {
        Ok(v) => {
            let (email, plan) = parse_user(v);
            r.signed_in = !email.is_empty();
            r.account = email;
            r.plan = plan;
            r.limits = parse_model_quotas(v);
        }
        Err(CallErr::Auth) => {
            r.signed_out = true;
            r.error = msg_not_logged_in().into();
            return (r, OK_TTL);
        }
        Err(_) => {}
    }
    // 그룹별 쿼터 요약이 있으면 우선 (표시 이름이 더 정돈됨). 서버가 응답하지 않았으면 다시 기다리지 않는다
    if let Ok(v) = if matches!(status, Err(CallErr::Net)) { Err(CallErr::Net) } else { ls_call(&hub, "GetUserQuotaSummary") } {
        let l = parse_quota_summary(&v);
        if !l.is_empty() {
            r.limits = l;
        }
    }
    if r.limits.is_empty() {
        r.error =
            if status.is_err() { i18n::t("agy.err.no_response") } else { i18n::t("agy.err.no_limits") }.into();
    }
    (r, if status.is_err() { FAIL_TTL } else { OK_TTL })
}

// ── 응답 해석 ───────────────────────────────────────────────────────────────

/// GetUserStatus 응답에서 (이메일, 요금제 이름) 을 뽑는다.
///
/// userStatus 아래의 email(없으면 name)과, 요금제는 userTier.name → planStatus.planInfo.planName → planStatus.planInfo.teamsTier 중 처음 비지 않은 값.
///
/// # 인자
/// - `v`: GetUserStatus 응답 JSON
///
/// # 반환
/// (이메일, 요금제 이름). 없는 값은 빈 문자열.
///
/// # 참조
/// `fetch_remote_uncached` 가 호출.
fn parse_user(v: &Value) -> (String, String) {
    let us = v.get("userStatus").unwrap_or(v);
    let email = us.get("email").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let email = if email.is_empty() { us.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string() } else { email };
    let plan = [us.pointer("/userTier/name"), us.pointer("/planStatus/planInfo/planName"), us.pointer("/planStatus/planInfo/teamsTier")]
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    (email, plan)
}

/// JSON 값을 실수로 읽는다 (숫자 또는 숫자 문자열).
///
/// # 인자
/// - `v`: JSON 값 (없을 수 있음)
///
/// # 반환
/// 실수. 없거나 숫자로 해석할 수 없으면 None.
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// 남은 비율을 사용 퍼센트로 바꾼다.
///
/// # 인자
/// - `remaining`: 남은 비율 (0.0~1.0)
///
/// # 반환
/// (1 - remaining) × 100 을 0~100 으로 제한한 값.
fn fraction_to_percent(remaining: f64) -> f64 {
    ((1.0 - remaining) * 100.0).clamp(0.0, 100.0)
}

/// 초기화 시각 문자열을 UTC RFC3339 로 정규화한다.
///
/// # 인자
/// - `v`: RFC3339 문자열을 가진 JSON 값 (없을 수 있음)
///
/// # 반환
/// UTC RFC3339 문자열. 없거나 해석할 수 없으면 None.
fn norm_reset(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc).to_rfc3339())
}

/// 표시 이름을 한도 종류(kind) 식별자로 바꾼다.
///
/// 소문자로 바꾸고 영숫자가 아닌 글자를 '-' 로 치환한 뒤 양끝의 '-' 를 뗀다.
///
/// # 인자
/// - `s`: 표시 이름
///
/// # 반환
/// 식별자 문자열.
fn slug(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string()
}

/// 쿼터 항목의 남은 비율을 읽는다.
///
/// 0 은 JSON 에서 생략될 수 있어, remainingFraction 이 없고 초기화 시각만 있으면 소진(남은 0)으로 본다.
///
/// # 인자
/// - `q`: 쿼터 항목 JSON
/// - `reset`: 정규화한 초기화 시각
///
/// # 반환
/// 남은 비율. 비율도 초기화 시각도 없으면 None.
///
/// # 참조
/// `num`. `parse_model_quotas`·`parse_quota_summary` 가 호출.
fn remaining_of(q: &Value, reset: &Option<String>) -> Option<f64> {
    match num(q.get("remainingFraction")) {
        Some(f) => Some(f),
        None if reset.is_some() => Some(0.0),
        None => None,
    }
}

/// GetUserStatus 안의 모델별 쿼터를 한도 목록으로 바꾼다 (cascadeModelConfigData.clientModelConfigs[].quotaInfo).
///
/// label 이 비었거나 남은 비율을 알 수 없는 항목은 건너뛴다. kind 는 label 의 `slug`, percent 는 사용 퍼센트.
///
/// # 인자
/// - `v`: GetUserStatus 응답 JSON
///
/// # 반환
/// `Limit` 목록 (없으면 빈 목록).
///
/// # 참조
/// `norm_reset`, `remaining_of`, `fraction_to_percent`, `slug`. `fetch_remote_uncached` 가 호출.
fn parse_model_quotas(v: &Value) -> Vec<Limit> {
    let us = v.get("userStatus").unwrap_or(v);
    let Some(arr) = us.pointer("/cascadeModelConfigData/clientModelConfigs").and_then(|x| x.as_array()) else { return vec![] };
    let mut out = vec![];
    for m in arr {
        let Some(q) = m.get("quotaInfo") else { continue };
        let label = m.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if label.is_empty() {
            continue;
        }
        let reset = norm_reset(q.get("resetTime"));
        let Some(remaining) = remaining_of(q, &reset) else { continue };
        out.push(Limit { kind: slug(&label), label, percent: Some(fraction_to_percent(remaining)), resets_at: reset });
    }
    out
}

/// GetUserQuotaSummary 응답을 한도 목록으로 바꾼다 (groups[].buckets[] 와 최상위 buckets[]).
///
/// disabled 버킷과 남은 비율을 모르는 버킷은 건너뛴다. 이름은 displayName → bucketId, 그룹 이름이 있고 이름과 다르면 "그룹 이름" 형태로 이어 붙이며, refreshWindowLabel 이 있으면 "(창 이름)" 을 붙인다.
/// kind 는 bucketId 의 `slug`(없으면 라벨의 slug).
///
/// # 인자
/// - `v`: GetUserQuotaSummary 응답 JSON
///
/// # 반환
/// `Limit` 목록 (없으면 빈 목록).
///
/// # 참조
/// `norm_reset`, `remaining_of`, `fraction_to_percent`, `slug`. `fetch_remote_uncached` 가 호출.
fn parse_quota_summary(v: &Value) -> Vec<Limit> {
    let root = v.get("quotaSummary").unwrap_or(v);
    let mut out = vec![];
    let mut groups: Vec<(String, &Vec<Value>)> = vec![];
    if let Some(gs) = root.get("groups").and_then(|x| x.as_array()) {
        for g in gs {
            if let Some(bs) = g.get("buckets").and_then(|x| x.as_array()) {
                groups.push((g.get("displayName").and_then(|x| x.as_str()).unwrap_or("").to_string(), bs));
            }
        }
    }
    if let Some(bs) = root.get("buckets").and_then(|x| x.as_array()) {
        groups.push((String::new(), bs));
    }
    for (group, bs) in groups {
        for b in bs {
            if b.get("disabled").and_then(|x| x.as_bool()).unwrap_or(false) {
                continue;
            }
            let reset = norm_reset(b.get("resetTime"));
            let Some(remaining) = remaining_of(b, &reset) else { continue };
            let name =
                ["displayName", "bucketId"].iter().filter_map(|k| b.get(*k).and_then(|x| x.as_str())).find(|s| !s.is_empty()).unwrap_or("");
            let window = b.get("refreshWindowLabel").and_then(|x| x.as_str()).unwrap_or("");
            let mut label = if group.is_empty() || group == name { name.to_string() } else { format!("{group} {name}").trim().to_string() };
            if label.is_empty() {
                label = group.clone();
            }
            if label.is_empty() {
                continue;
            }
            if !window.is_empty() {
                label = format!("{label} ({window})");
            }
            let id = b.get("bucketId").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(slug).unwrap_or_else(|| slug(&label));
            out.push(Limit { kind: id, label, percent: Some(fraction_to_percent(remaining)), resets_at: reset });
        }
    }
    out
}

// ── 세션 ────────────────────────────────────────────────────────────────────

/// DB 시간 값(RFC3339 류 문자열 또는 숫자 에포크)을 UTC 로 바꾼다.
///
/// 숫자면 `epoch_to_utc`, 아니면 RFC3339, 그다음 "2026-11-17 11:20:23.123456+09:00" 류(Go 시간 문자열의 " m=" 꼬리는 버림), 마지막으로 시간대 없는 형식(UTC 로 간주)을 차례로 시도한다.
///
/// # 인자
/// - `s`: 시간 문자열
///
/// # 반환
/// UTC 시각. 비었거나 어떤 형식도 맞지 않으면 None.
///
/// # 참조
/// `epoch_to_utc`. `read_rows_uncached`·`parse_transcript` 가 호출.
fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<i64>() {
        return epoch_to_utc(n);
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Some(d.with_timezone(&Utc));
    }
    // "2026-11-17 11:20:23.123456+09:00" 류 (Go 시간 문자열의 " m=" 꼬리는 버림)
    let head = t.split(" m=").next().unwrap_or(t);
    for f in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%z"] {
        if let Ok(d) = DateTime::parse_from_str(head, f) {
            return Some(d.with_timezone(&Utc));
        }
    }
    chrono::NaiveDateTime::parse_from_str(head, "%Y-%m-%d %H:%M:%S%.f").ok().map(|n| Utc.from_utc_datetime(&n))
}

/// 초 / 밀리초 / 마이크로초 / 나노초 에포크를 자릿수로 구분해 UTC 시각으로 바꾼다.
///
/// # 인자
/// - `n`: 에포크 값 (절댓값 기준 자릿수로 단위를 판정)
///
/// # 반환
/// UTC 시각. 범위를 벗어나면 None.
///
/// # 참조
/// `parse_time` 이 호출.
fn epoch_to_utc(n: i64) -> Option<DateTime<Utc>> {
    let ms = match n.abs() {
        0..=99_999_999_999 => n * 1000,
        100_000_000_000..=99_999_999_999_999 => n,
        100_000_000_000_000..=99_999_999_999_999_999 => n / 1000,
        _ => n / 1_000_000,
    };
    Utc.timestamp_millis_opt(ms).single()
}

/// workspace_uris(JSON 배열 또는 단일 문자열, 그 밖에는 쉼표·줄바꿈 구분) 의 첫 폴더를 경로로 바꾼다.
///
/// # 인자
/// - `raw`: workspace_uris 열의 원문
///
/// # 반환
/// 작업 폴더 경로. 없으면 빈 문자열.
///
/// # 참조
/// `uri_to_path`. `sessions_from_rows`·`token_report` 가 호출.
fn workspace_cwd(raw: &str) -> String {
    let first = match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(a)) => a.first().and_then(|x| x.as_str()).unwrap_or("").to_string(),
        Ok(Value::String(s)) => s,
        _ => raw.split([',', '\n']).next().unwrap_or("").trim().to_string(),
    };
    uri_to_path(&first)
}

/// file URI 를 경로로 바꾼다 (file:///c%3A/dev/x → c:\dev\x).
///
/// "file:///" 또는 "file://" 접두사를 떼고 %XX 를 디코딩한다. 윈도우 드라이브 경로(두 번째 글자가 ':')면 '/' 를 역슬래시로 바꾸고, 아니면 앞에 '/' 를 붙인다.
///
/// # 인자
/// - `uri`: URI 문자열
///
/// # 반환
/// 경로 문자열. file URI 가 아니면 입력을 그대로 돌려준다.
fn uri_to_path(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("file:///").or_else(|| uri.strip_prefix("file://")) else { return uri.to_string() };
    let b = rest.as_bytes();
    let mut dec = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(x) = rest.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                dec.push(x);
                i += 3;
                continue;
            }
        }
        dec.push(b[i]);
        i += 1;
    }
    let s = String::from_utf8_lossy(&dec).to_string();
    // 윈도우 드라이브 경로면 슬래시를 역슬래시로
    if s.as_bytes().get(1) == Some(&b':') {
        s.replace('/', "\\")
    } else {
        format!("/{s}")
    }
}

/// conversation_summaries 표의 대화 한 줄.
///
/// `read_rows_uncached` 가 만들고 `sessions_from_rows`·`token_report` 가 쓴다.
#[derive(Clone)]
struct Row {
    /// 대화 id (conversation_id)
    id: String,
    /// 대화 제목
    title: String,
    /// 미리보기 (제목이 비었을 때 첫 줄을 제목으로 씀)
    preview: String,
    /// 마지막 수정 시각 (last_modified_time)
    last: Option<DateTime<Utc>>,
    /// 작업 폴더 URI 원문 (workspace_uris)
    workspace: String,
    /// 상태 문자열
    status: String,
    /// not_fully_idle (1/true 면 아직 쉬지 않음)
    not_idle: bool,
    /// killed (1/true 면 중단됨)
    killed: bool,
    /// 부모 대화 id (하위 대화일 때, 아니면 빈 값)
    parent: String,
}

/// SQLite 파일을 읽기 전용으로 열어 `run` 을 실행한다.
///
/// 500ms busy 타임아웃을 건다. 앱이 쓰는 중이라 잠겨(BUSY/LOCKED) 있으면 호출마다 다른 임시 폴더에 DB(와 -wal, -shm)를 복사해 읽고 곧바로 지워 제목 같은 내용이 남지 않게 한다.
/// 표 구조가 바뀐 경우 등 다른 오류는 복사해도 소용없으므로 None.
///
/// # 인자
/// - `db`: SQLite 파일 경로
/// - `run`: 연결을 받아 질의를 수행하는 함수
///
/// # 반환
/// `run` 의 결과. 파일이 없거나 열기·질의 실패·복사 실패면 None.
///
/// # 참조
/// `is_locked`. `read_rows_uncached`·`read_models` 가 호출.
#[allow(clippy::let_and_return)] // 끝 식으로 바로 돌려주면 연결(임시값)이 TmpDir 보다 늦게 닫혀 임시 폴더가 안 지워진다
fn with_db<T>(db: &Path, run: impl Fn(&rusqlite::Connection) -> rusqlite::Result<T>) -> Option<T> {
    use rusqlite::OpenFlags;
    let open = |p: &Path| rusqlite::Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX);
    let run = |c: &rusqlite::Connection| -> rusqlite::Result<T> {
        let _ = c.busy_timeout(Duration::from_millis(500));
        run(c)
    };
    if !db.is_file() {
        return None;
    }
    match open(db).and_then(|c| run(&c)) {
        Ok(v) => return Some(v),
        Err(e) if is_locked(&e) => {}
        Err(_) => return None,
    }
    // 호출마다 다른 임시 폴더 (동시 호출이 서로 지우지 않게), 끝나면 반드시 지움
    /// 임시 폴더 이름이 호출마다 달라지게 하는 일련번호 (동시 호출이 서로 지우지 않게).
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    /// 임시 폴더 지킴이: 값이 사라질 때(Drop) 폴더를 통째로 지운다. 안의 DB 복사본이 남지 않게 하는 용도.
    struct TmpDir(PathBuf);
    impl Drop for TmpDir {
        /// 임시 폴더를 지운다 (실패는 무시).
        ///
        /// # 인자
        /// - `self`: 지울 임시 폴더를 가진 `TmpDir`
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let tmp = TmpDir(std::env::temp_dir().join(format!("meowffice-agy-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&tmp.0).ok()?;
    let dst = tmp.0.join("s.db");
    std::fs::copy(db, &dst).ok()?;
    for ext in ["-wal", "-shm"] {
        let mut src = db.as_os_str().to_owned();
        src.push(ext);
        let mut d = dst.as_os_str().to_owned();
        d.push(ext);
        let _ = std::fs::copy(src, d);
    }
    let res = open(&dst).and_then(|c| run(&c)).ok();
    res // 연결이 먼저 닫힌 뒤 TmpDir 이 지운다
}

/// conversation_summaries 표에서 최근 대화 최대 200건을 읽는다 (캐시 없음).
///
/// 마지막 수정 시각 내림차순으로 conversation_id·title·preview·last_modified_time·workspace_uris·status·not_fully_idle·killed·parent_conversation_id 열을 읽어 `Row` 로 만든다.
/// 열 값은 텍스트·정수·실수를 문자열로 바꿔 쓰며, 시간은 `parse_time` 으로 해석한다.
///
/// # 인자
/// - `db`: conversation_summaries.db 경로
///
/// # 반환
/// `Row` 목록. DB 를 읽지 못하면 None.
///
/// # 참조
/// `with_db`, `parse_time`. `read_rows` 가 호출.
fn read_rows_uncached(db: &Path) -> Option<Vec<Row>> {
    use rusqlite::types::ValueRef;
    let sql = "SELECT conversation_id, title, preview, last_modified_time, workspace_uris, status, not_fully_idle, killed, parent_conversation_id                FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 200";
    with_db(db, |c| {
        let mut st = c.prepare(sql)?;
        let rows = st.query_map([], |r| {
            let text = |i: usize| -> String {
                match r.get_ref(i) {
                    Ok(ValueRef::Text(t)) => String::from_utf8_lossy(t).to_string(),
                    Ok(ValueRef::Integer(n)) => n.to_string(),
                    Ok(ValueRef::Real(f)) => (f as i64).to_string(),
                    _ => String::new(),
                }
            };
            Ok(Row {
                id: text(0),
                title: text(1),
                preview: text(2),
                last: parse_time(&text(3)),
                workspace: text(4),
                status: text(5),
                not_idle: matches!(text(6).as_str(), "1" | "true"),
                killed: matches!(text(7).as_str(), "1" | "true"),
                parent: text(8),
            })
        })?;
        Ok(rows.flatten().collect())
    })
}

/// SQLite 오류가 DB 잠김(BUSY/LOCKED)인지 판정한다.
///
/// # 인자
/// - `e`: rusqlite 오류
///
/// # 반환
/// 잠김이면 true.
///
/// # 참조
/// `with_db` 가 임시 복사 여부를 정할 때 호출.
fn is_locked(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
}

/// 대화 목록을 읽는다. DB·WAL 파일이 그대로면 지난 결과를 쓴다 (5초마다 불려도 다시 읽지 않게).
///
/// DB 와 -wal 파일의 (수정 시각, 크기) 를 키로 `ROWS` 캐시와 비교하고, DB 파일이 없으면 캐시를 쓰지 않는다. 다르면 `read_rows_uncached` 로 읽어 저장한다.
///
/// # 인자
/// - `db`: conversation_summaries.db 경로
///
/// # 반환
/// `Row` 목록. 읽지 못하면 None.
///
/// # 참조
/// `read_rows_uncached`. `token_report`·`snapshot` 이 호출.
fn read_rows(db: &Path) -> Option<Vec<Row>> {
    let stamp = |p: &Path| std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    let key = (stamp(db), stamp(Path::new(&wal)));
    /// 대화 목록 캐시 형태: ((DB 파일 상태, WAL 파일 상태), 읽은 결과). 상태는 (수정 시각, 크기).
    type RowsCache = Option<((Option<(std::time::SystemTime, u64)>, Option<(std::time::SystemTime, u64)>), Option<Vec<Row>>)>;
    /// `read_rows` 의 캐시 (`Mutex` 로 보호).
    static ROWS: Mutex<RowsCache> = Mutex::new(None);
    if let Ok(g) = ROWS.lock() {
        if let Some((k, rows)) = g.as_ref() {
            if *k == key && key.0.is_some() {
                return rows.clone();
            }
        }
    }
    let rows = read_rows_uncached(db);
    if let Ok(mut g) = ROWS.lock() {
        *g = Some((key, rows.clone()));
    }
    rows
}

/// 한 대화의 상태 문자열을 판정한다.
///
/// 언어 서버가 살아 있고(`running`) 응답 중 신호(`busy_signal`)가 있으면 "busy", 마지막 수정이 `IDLE_MINUTES` 이내면 "idle", 아니면 "".
///
/// # 인자
/// - `last`: 마지막 수정 시각 (없으면 None)
/// - `now`: 현재 시각
/// - `busy_signal`: 응답 중 신호가 있는지
/// - `running`: 언어 서버가 실행 중인지
///
/// # 반환
/// "busy" | "idle" | "".
///
/// # 참조
/// `sessions_from_rows`·`sessions_from_files` 가 호출.
fn session_status(last: Option<DateTime<Utc>>, now: DateTime<Utc>, busy_signal: bool, running: bool) -> &'static str {
    if busy_signal && running {
        return "busy";
    }
    match last {
        Some(t) if now - t <= CDuration::minutes(IDLE_MINUTES) => "idle",
        _ => "",
    }
}

/// 대화 한 줄에 응답 중 신호가 있는지 판정한다.
///
/// killed 면 false. 아니면 not_fully_idle 이 참이거나 status(소문자)에 running·busy·generating·processing 이 들어 있으면 true.
///
/// # 인자
/// - `r`: 대화 한 줄
///
/// # 반환
/// 응답 중 신호가 있으면 true.
///
/// # 참조
/// `sessions_from_rows` 가 호출.
fn busy_signal(r: &Row) -> bool {
    if r.killed {
        return false;
    }
    let s = r.status.to_lowercase();
    r.not_idle || s.contains("running") || s.contains("busy") || s.contains("generating") || s.contains("processing")
}

/// 대화 목록 `Row` 들을 세션(`PSession`) 목록으로 바꾼다.
///
/// 하위(자식) 대화는 건너뛰되, 자식이 응답 중이면 부모도 응답 중으로 본다. id 나 마지막 수정 시각이 없거나 `RECENT_HOURS` 보다 오래된 대화는 뺀다.
/// 제목은 title, 비면 preview 의 첫 줄(80자). 시작 시각은 대화 파일 생성 시각, 열기 링크는 `APP_URL`.
///
/// # 인자
/// - `rows`: 대화 목록
/// - `now`: 현재 시각
/// - `running`: 언어 서버가 실행 중인지
/// - `dir`: Antigravity 데이터 폴더
///
/// # 반환
/// `PSession` 목록.
///
/// # 참조
/// `busy_signal`, `workspace_cwd`, `first_line`, `session_status`, `conversation_created`, `providers::project_of`. `snapshot`·`token_report` 가 호출.
fn sessions_from_rows(rows: Vec<Row>, now: DateTime<Utc>, running: bool, dir: &Path) -> Vec<PSession> {
    use std::collections::HashSet;
    // 하위(자식) 대화가 응답 중이면 부모도 응답 중으로 본다
    let busy_parents: HashSet<String> = rows.iter().filter(|r| !r.parent.is_empty() && busy_signal(r)).map(|r| r.parent.clone()).collect();
    let mut out = vec![];
    for r in rows {
        if !r.parent.is_empty() || r.id.is_empty() {
            continue;
        }
        let Some(last) = r.last else { continue };
        if now - last > CDuration::hours(RECENT_HOURS) {
            continue;
        }
        let cwd = workspace_cwd(&r.workspace);
        let title = if !r.title.trim().is_empty() { r.title.trim().to_string() } else { first_line(&r.preview) };
        let busy = busy_signal(&r) || busy_parents.contains(&r.id);
        out.push(PSession {
            status: session_status(Some(last), now, busy, running).into(),
            project: project_of(&cwd),
            cwd,
            started_at: conversation_created(dir, &r.id),
            last_at: Some(last.to_rfc3339()),
            title,
            id: r.id,
            url: APP_URL.into(),
        });
    }
    out
}

/// 텍스트에서 비지 않은 첫 줄을 80자까지 뽑는다.
///
/// # 인자
/// - `s`: 원문
///
/// # 반환
/// 첫 줄 (없으면 빈 문자열).
fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(80).collect()
}

/// 앱 창을 앞으로 가져오는 링크 (대화별 직접 링크는 없음).
const APP_URL: &str = "antigravity://";

/// 대화 파일(conversations/<id>.db — 예전 버전은 .pb)이 만들어진 시각을 돌려준다 (= 대화 시작).
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
/// - `id`: 대화 id
///
/// # 반환
/// RFC3339 시각. 파일이 없으면 None.
///
/// # 참조
/// `file_created`. `sessions_from_rows` 가 호출.
fn conversation_created(dir: &Path, id: &str) -> Option<String> {
    let base = dir.join("conversations");
    ["db", "pb"].iter().find_map(|ext| file_created(&base.join(format!("{id}.{ext}"))))
}

/// 파일 생성 시각을 RFC3339 로 돌려준다 (생성 시각을 알 수 없으면 수정 시각).
///
/// # 인자
/// - `p`: 파일 경로
///
/// # 반환
/// RFC3339 시각. 파일 정보를 읽지 못하면 None.
///
/// # 참조
/// `conversation_created`·`sessions_from_files` 가 호출.
fn file_created(p: &Path) -> Option<String> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.created().or_else(|_| m.modified()).ok()?;
    Some(DateTime::<Utc>::from(t).to_rfc3339())
}

/// DB 를 못 읽을 때의 대체로 파일에서 세션 목록을 만든다.
///
/// conversations/*.db(예전 .pb) 의 수정 시각을 마지막 활동으로 보고, 같은 id 는 한 번만 센다. `RECENT_HOURS` 보다 오래된 파일은 뺀다.
/// 제목은 brain/<id>/*.md 의 첫 제목(`brain_title`), 상태는 `session_status`(응답 중 신호 없음).
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
/// - `now`: 현재 시각
///
/// # 반환
/// `PSession` 목록. conversations 폴더를 못 읽으면 빈 목록.
///
/// # 참조
/// `brain_title`, `session_status`, `file_created`. `snapshot` 이 호출.
fn sessions_from_files(dir: &Path, now: DateTime<Utc>) -> Vec<PSession> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(dir.join("conversations")) else { return out };
    let mut seen = std::collections::HashSet::new();
    for e in rd.flatten() {
        let p = e.path();
        if !matches!(p.extension().and_then(|x| x.to_str()), Some("db" | "pb")) || !p.is_file() {
            continue;
        }
        let Some(id) = p.file_stem().and_then(|x| x.to_str()).map(String::from) else { continue };
        if !seen.insert(id.clone()) {
            continue; // .db 와 .pb 가 같이 있어도 한 번만
        }
        let Some(last) = e.metadata().ok().and_then(|m| m.modified().ok()).map(DateTime::<Utc>::from) else { continue };
        if now - last > CDuration::hours(RECENT_HOURS) {
            continue;
        }
        out.push(PSession {
            title: brain_title(&dir.join("brain").join(&id)),
            status: session_status(Some(last), now, false, false).into(),
            started_at: file_created(&p),
            last_at: Some(last.to_rfc3339()),
            id,
            url: APP_URL.into(),
            ..Default::default()
        });
    }
    out
}

/// brain/<id> 폴더의 *.md 파일(이름순)에서 첫 '#' 제목 줄을 뽑는다.
///
/// # 인자
/// - `d`: brain/<id> 폴더 경로
///
/// # 반환
/// '#' 을 뗀 제목 (80자까지). 없으면 빈 문자열.
///
/// # 참조
/// `sessions_from_files` 가 호출.
fn brain_title(d: &Path) -> String {
    let Ok(rd) = std::fs::read_dir(d) else { return String::new() };
    let mut mds: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md")).collect();
    mds.sort();
    for p in mds {
        if let Ok(t) = std::fs::read_to_string(&p) {
            if let Some(h) = t.lines().find(|l| l.starts_with('#')) {
                return h.trim_start_matches('#').trim().chars().take(80).collect();
            }
        }
    }
    String::new()
}

// ── 연결 상태 (읽기 전용 확인) ──────────────────────────────────────────────

/// 언어 서버 상태 확인 결과 (읽기 전용 확인).
///
/// `probe_health` 가 만든다.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    /// 언어 서버(hub 파일 + 살아 있는 프로세스)가 있음. 없으면 앱이 꺼진 것이라 문제가 아님
    pub running: bool,
    /// GET /healthz 가 정상 응답
    pub healthz_ok: bool,
    /// GetAuthStatus 의 authResult.hasValidAuth (모르면 None)
    pub auth_ok: Option<bool>,
}

/// 로컬 언어 서버에 /healthz 와 GetAuthStatus 만 묻는다 (둘 다 읽기 전용, 127.0.0.1 전용).
///
/// 데이터 폴더와 살아 있는 hub 가 없으면 running=false 로 끝낸다. 있으면 제한 시간 3초·프록시 없이 /healthz 를 호출하고, GetAuthStatus 의 authResult.hasValidAuth 를 읽는다(`Auth` 오류면 Some(false), 그 밖의 실패는 None).
///
/// # 반환
/// `Probe`.
///
/// # 참조
/// `data_dir`, `find_hubs`, `ls_call`.
pub fn probe_health() -> Probe {
    let mut p = Probe::default();
    let Some(dir) = data_dir() else { return p };
    let Some(hub) = find_hubs(&dir).into_iter().next() else { return p };
    p.running = true;
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).proxy(None).build().into();
    p.healthz_ok = agent.get(&format!("http://127.0.0.1:{}/healthz", hub.port)).call().is_ok();
    p.auth_ok = match ls_call(&hub, "GetAuthStatus") {
        Ok(v) => v.get("authResult").unwrap_or(&v).get("hasValidAuth").and_then(Value::as_bool),
        Err(CallErr::Auth) => Some(false),
        Err(_) => None,
    };
    p
}

// ── 토큰 사용량 ─────────────────────────────────────────────────────────────

/// protobuf 필드 하나의 값 (varint 또는 길이 지정 바이트).
enum Pb<'a> {
    /// 가변 길이 정수 값
    Varint(u64),
    /// 길이 지정 바이트 (중첩 메시지·문자열)
    Bytes(&'a [u8]),
}

/// protobuf varint 하나를 읽는다.
///
/// `i` 위치부터 7비트씩 이어 읽고 `i` 를 읽은 만큼 앞으로 옮긴다. 데이터가 모자라거나 63비트를 넘으면 실패.
///
/// # 인자
/// - `b`: 바이트 배열
/// - `i`: 읽기 시작 위치 (읽은 뒤 갱신됨)
///
/// # 반환
/// 값. 실패하면 None.
///
/// # 참조
/// `pb_fields` 가 호출.
fn read_varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let (mut x, mut shift) = (0u64, 0u32);
    loop {
        let y = *b.get(*i)?;
        *i += 1;
        x |= u64::from(y & 0x7f).checked_shl(shift)?;
        if y & 0x80 == 0 {
            return Some(x);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// protobuf 한 겹을 훑어 (필드 번호, 값) 목록을 만든다.
///
/// varint(wire 0)와 길이 지정(wire 2)만 값으로 담고, 고정 8·4바이트(wire 1·5)는 건너뛴다. 모르는 줄 종류나 잘린 데이터를 만나면 거기서 멈춘다.
///
/// # 인자
/// - `b`: protobuf 바이트
///
/// # 반환
/// (필드 번호, `Pb`) 목록.
///
/// # 참조
/// `read_varint`. `parse_gen_meta` 가 호출.
fn pb_fields(b: &[u8]) -> Vec<(u64, Pb<'_>)> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(key) = read_varint(b, &mut i) else { break };
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => match read_varint(b, &mut i) {
                Some(v) => out.push((field, Pb::Varint(v))),
                None => break,
            },
            1 => i += 8,
            5 => i += 4,
            2 => {
                let Some(len) = read_varint(b, &mut i) else { break };
                let Some(end) = i.checked_add(len as usize).filter(|e| *e <= b.len()) else { break };
                out.push((field, Pb::Bytes(&b[i..end])));
                i = end;
            }
            _ => break,
        }
    }
    out
}

/// gen_metadata 한 줄(protobuf)에서 (입력 토큰, 출력 토큰, 모델 이름) 을 뽑는다.
///
/// 구조(2.32 기준): 1번 필드 안에 4번(사용량: 2=입력, 3=출력)과 19번(모델 이름 문자열)이 있다.
///
/// # 인자
/// - `data`: gen_metadata 의 data 열 바이트
///
/// # 반환
/// (입력, 출력, 모델 이름). 구조를 못 찾으면 None.
///
/// # 참조
/// `pb_fields`. `read_models` 가 호출.
fn parse_gen_meta(data: &[u8]) -> Option<(u64, u64, String)> {
    let top = pb_fields(data);
    let Some((_, Pb::Bytes(m1))) = top.iter().find(|(f, v)| *f == 1 && matches!(v, Pb::Bytes(_))) else { return None };
    let inner = pb_fields(m1);
    let model = inner.iter().find_map(|(f, v)| match v {
        Pb::Bytes(b) if *f == 19 => std::str::from_utf8(b).ok().map(str::to_string),
        _ => None,
    })?;
    let usage = inner.iter().find_map(|(f, v)| match v {
        Pb::Bytes(b) if *f == 4 => Some(pb_fields(b)),
        _ => None,
    })?;
    let get = |n: u64| {
        usage.iter().find_map(|(f, v)| {
            if *f == n {
                if let Pb::Varint(x) = v {
                    Some(*x)
                } else {
                    None
                }
            } else {
                None
            }
        })
    };
    Some((get(2)?, get(3)?, model))
}

/// 대화 DB 의 모델 정보.
///
/// (입력, 출력) 토큰 쌍으로 모델을 찾고, 못 찾으면 가장 많이 나온 모델을 쓴다. `read_models` 가 만든다.
#[derive(Default, Clone)]
struct ModelMap {
    /// (입력 토큰, 출력 토큰) → 모델 이름
    by_usage: HashMap<(u64, u64), String>,
    /// 가장 많이 쓴 모델 이름 (없으면 빈 값)
    dominant: String,
}

/// 대화 DB 의 gen_metadata 표에서 모델 정보를 읽는다.
///
/// 모든 data 행을 `parse_gen_meta` 로 해석해 (입력, 출력) → 모델 맵을 만들고, 가장 많이 나온 모델을 `dominant` 로 고른다.
///
/// # 인자
/// - `db`: conversations/<id>.db 경로
///
/// # 반환
/// `ModelMap`. DB 를 읽지 못하면 빈 값.
///
/// # 참조
/// `with_db`, `parse_gen_meta`. `token_report` 가 호출.
fn read_models(db: &Path) -> ModelMap {
    let rows: Vec<(u64, u64, String)> = with_db(db, |c| {
        let mut st = c.prepare("SELECT data FROM gen_metadata")?;
        let rows = st.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        Ok(rows.flatten().filter_map(|d| parse_gen_meta(&d)).collect())
    })
    .unwrap_or_default();
    let mut m = ModelMap::default();
    let mut count: HashMap<&str, u32> = HashMap::new();
    for (i, o, model) in &rows {
        m.by_usage.insert((*i, *o), model.clone());
        *count.entry(model.as_str()).or_default() += 1;
    }
    m.dominant = count.into_iter().max_by_key(|(_, n)| *n).map(|(k, _)| k.to_string()).unwrap_or_default();
    m
}

/// 모델 내부 이름을 화면용으로 다듬는다.
///
/// 비었거나 "MODEL_" 로 시작하는 열거형 이름(예: MODEL_PLACEHOLDER_M318)은 그대로 두지 않고 "(모델 미상)" 으로 한다.
///
/// # 인자
/// - `m`: 모델 내부 이름
///
/// # 반환
/// 화면용 모델 이름.
///
/// # 참조
/// `parse_transcript` 가 호출.
fn model_label(m: &str) -> String {
    if m.is_empty() || m.starts_with("MODEL_") {
        i18n::t("model.unknown").into()
    } else {
        m.to_string()
    }
}

/// transcript.jsonl 하나에서 읽은 토큰 기록 모음. `parse_transcript` 가 만들고 `TOK_CACHE` 에 캐시된다.
struct AgyFile {
    /// 응답별 토큰 기록
    recs: Vec<Rec>,
}

/// 파일별 파싱 결과 캐시 형태: 경로 → (수정 시각, 크기, 파싱 결과).
type TokCache = Option<HashMap<PathBuf, (SystemTime, u64, Arc<AgyFile>)>>;
/// transcript 파싱 결과 캐시. (mtime, 크기) 가 같으면 재사용하며 항목이 400개를 넘으면 비운다 (`Mutex` 로 보호).
static TOK_CACHE: Mutex<TokCache> = Mutex::new(None);

/// transcript.jsonl 의 응답 줄(input_tokens·cache_read_tokens·output_tokens)만 읽는다 — 본문(content·thinking)은 읽지 않고 버린다.
///
/// "input_tokens" 가 든 줄만 JSON 으로 해석해 input·output 토큰과 created_at 이 있는 줄을 기록으로 만든다. 모델은 `ModelMap` 에서 (입력, 출력) 으로 찾고 없으면 가장 많이 쓴 모델을 쓰며,
/// input_tokens 와 cache_read_tokens 는 따로 센 값으로 보여 그대로 각각 입력·캐시 읽기에 넣는다(캐시 쓰기는 0).
///
/// # 인자
/// - `path`: transcript.jsonl 경로
/// - `session`: 기록에 붙일 세션 id
/// - `models`: 모델 정보
///
/// # 반환
/// `AgyFile`. 파일을 못 열면 빈 기록.
///
/// # 참조
/// `parse_time`, `model_label`, `ptokens::Rec`. `token_report` 가 호출.
fn parse_transcript(path: &Path, session: &str, models: &ModelMap) -> AgyFile {
    let mut recs = vec![];
    let Ok(f) = std::fs::File::open(path) else { return AgyFile { recs } };
    use std::io::BufRead;
    for raw in std::io::BufReader::new(f).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&raw);
        if !line.contains("\"input_tokens\"") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
        let n = |k: &str| o.get(k).and_then(Value::as_u64);
        let (Some(input), Some(output)) = (n("input_tokens"), n("output_tokens")) else { continue };
        let Some(ts) = o.get("created_at").and_then(Value::as_str).and_then(parse_time) else { continue };
        let model = models.by_usage.get(&(input, output)).cloned().unwrap_or_else(|| models.dominant.clone());
        // input_tokens 와 cache_read_tokens 는 따로 센 값으로 보인다 (입력이 작은데 캐시 읽기만 큼) — 합쳐서 더한다
        recs.push(Rec {
            session: session.to_string(),
            ts,
            model: model_label(&model),
            input,
            output,
            cache_write: 0,
            cache_read: n("cache_read_tokens").unwrap_or(0),
        });
    }
    AgyFile { recs }
}

/// 대화의 transcript.jsonl 경로를 만든다 (brain/<id>/.system_generated/logs/transcript.jsonl).
///
/// # 인자
/// - `dir`: Antigravity 데이터 폴더
/// - `id`: 대화 id
///
/// # 반환
/// 파일 경로 (존재 여부는 확인하지 않음).
///
/// # 참조
/// `token_report` 가 호출.
fn transcript_of(dir: &Path, id: &str) -> PathBuf {
    dir.join("brain").join(id).join(".system_generated").join("logs").join("transcript.jsonl")
}

/// Antigravity 의 모델·날짜·세션별 토큰 사용량을 만든다 (Claude 의 local::report 와 같은 모양).
///
/// `days` 를 1~90 으로 보정한다. brain/<id> 폴더 중 id 가 영숫자·'-' 뿐이고 transcript 가 시작 시각 이후 수정된 것만 읽으며, 파일별로 `TOK_CACHE` 를 쓴다.
/// 하위 대화는 부모를 따라 최대 5단계까지 최상위 대화로 합쳐 센다. 세션 표시 정보는 대화 목록 DB 의 제목·작업 폴더·시작 시각이고, 최근 대화의 상태는 `sessions_from_rows` 결과에서 가져온다.
///
/// # 인자
/// - `days`: 기간(일). 1~90 으로 보정
///
/// # 반환
/// `local::LocalReport`. 데이터 폴더가 없으면 빈 보고서.
///
/// # 참조
/// `data_dir`, `read_rows`, `transcript_of`, `read_models`, `parse_transcript`, `sessions_from_rows`, `fetch_remote`, `ptokens::cutoff_of`, `ptokens::build`.
pub fn token_report(days: u32) -> crate::local::LocalReport {
    let days = days.clamp(1, 90);
    let cutoff = crate::ptokens::cutoff_of(days);
    let sys_cut: SystemTime = cutoff.into();
    let Some(dir) = data_dir().filter(|d| d.is_dir()) else { return crate::ptokens::build(days, &[], &HashMap::new()) };
    let rows = read_rows(&dir.join("conversation_summaries.db")).unwrap_or_default();
    // 하위 대화는 최상위 대화로 합쳐 센다
    let parent: HashMap<&str, &str> = rows.iter().filter(|r| !r.parent.is_empty()).map(|r| (r.id.as_str(), r.parent.as_str())).collect();
    let root_of = |id: &str| {
        let mut cur = id;
        for _ in 0..5 {
            match parent.get(cur) {
                Some(p) => cur = p,
                None => break,
            }
        }
        cur.to_string()
    };
    let mut recs: Vec<Rec> = vec![];
    let Ok(rd) = std::fs::read_dir(dir.join("brain")) else { return crate::ptokens::build(days, &[], &HashMap::new()) };
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        let tp = transcript_of(&dir, &id);
        let Some((mt, len)) = std::fs::metadata(&tp).ok().and_then(|m| Some((m.modified().ok()?, m.len()))) else { continue };
        if mt < sys_cut {
            continue;
        }
        let cached = TOK_CACHE
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|m| m.get(&tp).filter(|(cm, cl, _)| *cm == mt && *cl == len).map(|x| x.2.clone())));
        let file = match cached {
            Some(f) => f,
            None => {
                let models = read_models(&dir.join("conversations").join(format!("{id}.db")));
                let f = Arc::new(parse_transcript(&tp, &id, &models));
                if let Ok(mut g) = TOK_CACHE.lock() {
                    let m = g.get_or_insert_with(HashMap::new);
                    if m.len() > 400 {
                        m.clear();
                    }
                    m.insert(tp.clone(), (mt, len, f.clone()));
                }
                f
            }
        };
        let root = root_of(&id);
        recs.extend(file.recs.iter().cloned().map(|mut r| {
            r.session = root.clone();
            r
        }));
    }
    // 세션 표시 정보: 대화 목록 DB 의 제목·작업 폴더, 최근 24시간 대화는 지금 상태까지
    let now = Utc::now();
    let live: HashMap<String, String> =
        sessions_from_rows(rows.clone(), now, fetch_remote(&dir).running, &dir).into_iter().map(|s| (s.id, s.status)).collect();
    let mut meta: HashMap<String, Meta> = HashMap::new();
    for r in rows.iter().filter(|r| r.parent.is_empty()) {
        let title = if !r.title.trim().is_empty() { r.title.trim().to_string() } else { first_line(&r.preview) };
        let started = ["db", "pb"]
            .iter()
            .find_map(|ext| std::fs::metadata(dir.join("conversations").join(format!("{}.{ext}", r.id))).ok())
            .and_then(|m| m.created().or_else(|_| m.modified()).ok())
            .map(DateTime::<Utc>::from);
        meta.insert(
            r.id.clone(),
            Meta { title, cwd: workspace_cwd(&r.workspace), status: live.get(&r.id).cloned().unwrap_or_default(), started },
        );
    }
    crate::ptokens::build(days, &recs, &meta)
}

// ── 책상 모니터 그림 ────────────────────────────────────────────────────────

/// 대화의 가장 최근 생성 그림(책상 모니터용)을 data URL 로 돌려준다.
///
/// id 는 영숫자·'-' 만 허용해 다른 경로를 가리키지 못하게 한다. brain/<id>/.system_generated/logs/media 의 jpg·jpeg 중 수정 시각이 가장 늦은 것을 고르며, 같은 파일(경로·수정 시각)이면 지난 결과를 쓴다.
/// 8MB 이상이면 None 을 캐시한다. 캐시 항목이 40개를 넘으면 비운다.
///
/// # 인자
/// - `id`: 대화 id (영숫자·'-' 만 허용)
///
/// # 반환
/// "data:image/jpeg;base64,<데이터>". 그림이 없거나 id 가 유효하지 않거나 8MB 이상이면 None.
///
/// # 참조
/// `data_dir`.
pub fn last_image(id: &str) -> Option<String> {
    use base64::Engine;
    /// 그림 캐시 형태: 경로 → (수정 시각, data URL 또는 None).
    type ImgCache = Option<HashMap<PathBuf, (SystemTime, Option<String>)>>;
    /// `last_image` 의 그림 캐시 (`Mutex` 로 보호).
    static CACHE: Mutex<ImgCache> = Mutex::new(None);
    // 아이디로 다른 경로를 가리키지 못하게 (영숫자·- 만)
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let media = data_dir()?.join("brain").join(id).join(".system_generated").join("logs").join("media");
    let (path, mt) = std::fs::read_dir(&media)
        .ok()?
        .flatten()
        .filter(|e| matches!(e.path().extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("jpg" | "jpeg")))
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, t)| *t)?;
    if let Ok(g) = CACHE.lock() {
        if let Some((t, v)) = g.as_ref().and_then(|m| m.get(&path)) {
            if *t == mt {
                return v.clone();
            }
        }
    }
    let img = std::fs::read(&path)
        .ok()
        .filter(|b| b.len() < 8_000_000)
        .map(|b| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
    if let Ok(mut g) = CACHE.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 40 {
            m.clear();
        }
        m.insert(path, (mt, img.clone()));
    }
    img
}

// ── 진입점 ──────────────────────────────────────────────────────────────────

/// Antigravity 의 현재 상태를 `Snapshot` 으로 모은다.
///
/// 데이터 폴더나 설치 폴더가 있으면 installed 로 본다. 로그인은 서버가 확인했거나(서버가 부정하지 않았다면) 자격 증명 항목이 있으면 true 로 판정하고, 계정은 서버 값 → 마지막 로그인 계정 순이다.
/// 요금제·한도·인증 만료(signed_out)는 `fetch_remote` 결과를 쓴다. 세션은 대화 DB(`sessions_from_rows`)에서, 비면 파일(`sessions_from_files`)에서 만들어 최근순으로 정렬한다. 비밀값은 결과에 넣지 않는다.
///
/// # 반환
/// `Snapshot` ("antigravity"). 설치 흔적이 없으면 오류 문구만 담은 값.
///
/// # 참조
/// `data_dir`, `app_dir`, `fetch_remote`, `credential_exists_cached`, `last_login_account`, `read_rows`, `sessions_from_rows`, `sessions_from_files`. `providers::snapshot` 이 호출.
pub fn snapshot() -> Snapshot {
    let mut s = Snapshot::new("antigravity");
    let dir = data_dir().filter(|d| d.is_dir());
    s.installed = dir.is_some() || app_dir().is_some_and(|d| d.is_dir());
    let Some(dir) = dir else {
        if !s.installed {
            s.error = i18n::t("agy.err.not_installed").into();
        }
        return s;
    };
    let now = Utc::now();

    let remote = fetch_remote(&dir);
    // 로그인: 서버가 확인했거나, (서버가 부정하지 않았다면) 자격 증명 항목이 있으면
    s.logged_in = remote.signed_in || (!remote.signed_out && credential_exists_cached());
    s.account = if !remote.account.is_empty() {
        remote.account.clone()
    } else if s.logged_in {
        last_login_account()
    } else {
        String::new()
    };
    s.plan = remote.plan.clone();
    s.limits = remote.limits.clone();
    s.auth_expired = remote.signed_out;
    s.error = if !s.logged_in && !remote.running { msg_not_logged_in().into() } else { remote.error.clone() };

    let mut sessions = read_rows(&dir.join("conversation_summaries.db"))
        .map(|rows| sessions_from_rows(rows, now, remote.running, &dir))
        .unwrap_or_default();
    if sessions.is_empty() {
        sessions = sessions_from_files(&dir, now);
    }
    sessions.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    s.sessions = sessions;
    s
}

/// hub·cmdkey·응답·시간·세션·protobuf·transcript 파싱 단위 테스트 (일부는 실데이터 스모크).
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hub_parse_requires_alive() {
        let j = r#"{"pid": 10, "httpsPort": 1, "httpPort": 2, "csrfToken": "x"}"#;
        assert!(parse_hub(j, |_| true).is_some());
        assert!(parse_hub(j, |_| false).is_none());
        assert!(parse_hub("{}", |_| true).is_none());
    }

    /// 살아 있는 프로세스(자기 자신)는 true, pid 0 은 false — 모든 OS 에서(예전엔 Windows 밖에서 항상 false 라 macOS 에서 hub 를 못 찾음).
    #[test]
    fn pid_alive_detects_self() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
    }

    #[test]
    fn cmdkey_output() {
        assert!(parse_cmdkey(
            "gemini:antigravity 에 저장된 자격 증명:

    대상: gemini:antigravity
    사용자: x
"
        ));
        assert!(parse_cmdkey(
            "Credentials stored for gemini:antigravity:

    Target: gemini:antigravity
"
        ));
        assert!(!parse_cmdkey(
            "gemini:antigravity 에 저장된 자격 증명:

* 없음 *
"
        ));
    }

    #[test]
    fn user_status_models() {
        let v = json!({"userStatus": {"email": "a@example.com", "userTier": {"name": "Pro"},
            "cascadeModelConfigData": {"clientModelConfigs": [
                {"label": "Gemini 3 Pro", "quotaInfo": {"remainingFraction": 0.75, "resetTime": "2026-11-17T05:00:00Z"}},
                {"label": "Claude X", "quotaInfo": {"resetTime": "2026-11-17T06:00:00+09:00"}},
                {"label": "No quota"}]}}});
        assert_eq!(parse_user(&v), ("a@example.com".into(), "Pro".into()));
        let l = parse_model_quotas(&v);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].percent, Some(25.0));
        assert_eq!(l[0].kind, "gemini-3-pro");
        assert_eq!(l[1].percent, Some(100.0));
        assert_eq!(l[1].resets_at.as_deref(), Some("2026-11-16T21:00:00+00:00"));
    }

    #[test]
    fn quota_summary_groups() {
        let v = json!({"groups": [{"displayName": "Gemini", "buckets": [
            {"bucketId": "g-pro", "displayName": "Pro", "refreshWindowLabel": "5h", "remainingFraction": 0.4, "resetTime": "2026-11-17T05:00:00Z"},
            {"bucketId": "off", "displayName": "Off", "disabled": true, "remainingFraction": 1.0}]}],
            "buckets": [{"bucketId": "top", "displayName": "Top", "remainingFraction": "0.9"}]});
        let l = parse_quota_summary(&v);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].label, "Gemini Pro (5h)");
        assert_eq!(l[0].kind, "g-pro");
        assert!((l[0].percent.unwrap() - 60.0).abs() < 1e-9);
        assert!((l[1].percent.unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn time_and_uri() {
        assert!(parse_time("2026-11-17T11:20:23+09:00").is_some());
        assert!(parse_time("2026-11-17 11:20:23.123456+09:00").is_some());
        assert!(parse_time("1763346023").is_some());
        assert!(parse_time("1763346023000").is_some());
        assert!(parse_time("garbage").is_none());
        assert_eq!(uri_to_path("file:///c%3A/dev/my%20app"), "c:\\dev\\my app");
        assert_eq!(workspace_cwd(r#"["file:///home/u/proj"]"#), "/home/u/proj");
    }

    #[test]
    fn session_rows() {
        let now = Utc::now();
        let mk = |id: &str, parent: &str, mins: i64, not_idle: bool| Row {
            id: id.into(),
            title: String::new(),
            preview: "첫 줄\n둘째".into(),
            last: Some(now - CDuration::minutes(mins)),
            workspace: r#"["file:///c%3A/w/proj"]"#.into(),
            status: String::new(),
            not_idle,
            killed: false,
            parent: parent.into(),
        };
        let rows =
            vec![mk("a", "", 1, false), mk("b", "", 60, false), mk("c", "", 3000, false), mk("d", "e", 1, true), mk("e", "", 5, false)];
        let s = sessions_from_rows(rows, now, true, Path::new("nonexistent"));
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].status, "idle");
        assert_eq!(s[0].title, "첫 줄");
        assert_eq!(s[0].project, "proj");
        assert_eq!(s[1].status, "");
        assert_eq!(s[2].status, "busy"); // 자식이 응답 중
        let s = sessions_from_rows(vec![mk("a", "", 1, true)], now, false, Path::new("x"));
        assert_eq!(s[0].status, "idle"); // 서버가 꺼져 있으면 busy 로 보지 않음
    }

    #[test]
    fn gen_meta_protobuf() {
        // 1번 필드(len) 안: 4번(len){2=12448, 3=203}, 19번(len)="gemini-x"
        fn varint(mut n: u64) -> Vec<u8> {
            let mut v = vec![];
            loop {
                let b = (n & 0x7f) as u8;
                n >>= 7;
                if n == 0 {
                    v.push(b);
                    return v;
                }
                v.push(b | 0x80);
            }
        }
        let len_field = |f: u64, body: &[u8]| [varint(f << 3 | 2), varint(body.len() as u64), body.to_vec()].concat();
        let vfield = |f: u64, n: u64| [varint(f << 3), varint(n)].concat();
        let usage = [vfield(1, 1318), vfield(2, 12448), vfield(3, 203)].concat();
        let m1 = [vfield(3, 1318), len_field(4, &usage), len_field(19, b"gemini-x")].concat();
        let blob = len_field(1, &m1);
        assert_eq!(parse_gen_meta(&blob), Some((12448, 203, "gemini-x".into())));
        assert_eq!(parse_gen_meta(&[0xff, 0xff]), None);
        assert_eq!(model_label("MODEL_PLACEHOLDER_M318"), "(모델 미상)");
    }

    #[test]
    fn transcript_tokens_only_numbers() {
        let dir = std::env::temp_dir().join(format!("meow-agy-tok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("transcript.jsonl");
        std::fs::write(
            &p,
            [
                r#"{"step_index":0,"source":"USER","type":"USER_INPUT","created_at":"2026-11-17T11:20:23Z","content":"비밀 내용"}"#,
                r#"{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-11-17T11:20:25Z","input_tokens":100,"cache_read_tokens":900,"output_tokens":7,"thinking":"생각"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let mut models = ModelMap::default();
        models.by_usage.insert((100, 7), "gemini-x".into());
        let f = parse_transcript(&p, "conv", &models);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(f.recs.len(), 1);
        let r = &f.recs[0];
        assert_eq!((r.input, r.cache_read, r.output, r.model.as_str(), r.session.as_str()), (100, 900, 7, "gemini-x", "conv"));
    }

    /// 실제 ~/.gemini 읽기: `cargo test live_tokens -- --ignored --nocapture` (숫자만 출력)
    #[test]
    #[ignore]
    fn live_tokens() {
        for days in [1u32, 7, 30] {
            let r = token_report(days);
            println!(
                "agy days={days} turns={} total={} models={} sessions={} running={}",
                r.turns,
                r.total,
                r.by_model.len(),
                r.sessions.len(),
                r.running
            );
            for m in &r.by_model {
                println!("  model {} total={} turns={}", m.model, m.total, m.turns);
            }
        }
        let s = snapshot();
        println!(
            "sessions={} with_started={} urls={}",
            s.sessions.len(),
            s.sessions.iter().filter(|x| x.started_at.is_some()).count(),
            s.sessions.iter().filter(|x| !x.url.is_empty()).count()
        );
        println!("probe={:?}", probe_health());
        if let Some(d) = data_dir() {
            let ids: Vec<String> =
                std::fs::read_dir(d.join("brain")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            println!("image found for {} of {} brain dirs", ids.iter().filter(|i| last_image(i).is_some()).count(), ids.len());
        }
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
