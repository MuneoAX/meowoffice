//! claude.ai 계정 데이터(OAuth).
//! 인증: Claude Code 로그인 자격증명(<claude_dir>/.credentials.json → claudeAiOauth.accessToken)을
//! 읽기 전용으로 사용. 토큰 갱신(refresh)은 하지 않음 — Claude Code 가 사용 중 자동 갱신.
//!
//! - 플랜 한도: GET /api/oauth/usage   (5시간 세션·주간·모델별 한도, 서피스별 비중, 추가 사용량)
//! - 프로필:   GET /api/oauth/profile (계정 이름·이메일 표시, 조직 uuid — 클라우드 세션 조회 헤더용)
//! - 클라우드 세션: GET /v1/sessions  (claude.ai/code 원격·브리지 세션)

use crate::i18n;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Anthropic API 기본 주소.
const BASE: &str = "https://api.anthropic.com";
/// OAuth 엔드포인트 호출 시 `anthropic-beta` 헤더 값.
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// 클라우드 세션·환경 목록 호출 시 `anthropic-beta` 헤더 값.
const SESSIONS_BETA: &str = "ccr-byoc-2025-07-29,oauth-2025-04-20";
/// 요청 헤더 `anthropic-version` 에 보내는 API 버전.
const API_VERSION: &str = "2023-06-01";
/// 요청 헤더 `user-agent` 값 (앱 이름 + Cargo 패키지 버전).
const USER_AGENT: &str = concat!("muneo-claude-usage-tray/", env!("CARGO_PKG_VERSION"));

/// claude.ai OAuth API 호출 실패 종류.
///
/// `kind()` 로 UI 분기용 문자열을, `Display` 로 사용자에게 보일 한국어 문구를 만든다 (토큰은 문구에 넣지 않는다).
#[derive(Debug)]
pub enum ApiError {
    /// 로그인 정보(자격증명) 없음 또는 accessToken 이 빔
    NoCredentials,
    /// 저장된 expiresAt 이 지나 호출하지 않음
    Expired,
    /// HTTP 401·403 — 서버가 인증을 거절
    Auth,
    /// 그 밖의 HTTP 상태 코드 오류 (값은 상태 코드)
    Http(u16),
    /// 전송·본문 읽기 실패 (값은 오류 설명)
    Network(String),
    /// 자격증명 파일·응답 해석 실패 (값은 설명)
    Parse(String),
}

impl ApiError {
    /// UI 분기용 오류 종류 문자열을 돌려준다 (로그인 안내 화면 표시 판정).
    ///
    /// # 반환
    /// "no_credentials" | "expired" | "auth" | "http" | "network" | "parse".
    pub fn kind(&self) -> &'static str {
        match self {
            ApiError::NoCredentials => "no_credentials",
            ApiError::Expired => "expired",
            ApiError::Auth => "auth",
            ApiError::Http(_) => "http",
            ApiError::Network(_) => "network",
            ApiError::Parse(_) => "parse",
        }
    }
}

impl std::fmt::Display for ApiError {
    /// `ApiError` 를 한국어 문구로 출력한다.
    ///
    /// # 인자
    /// - `f`: 출력 대상 포매터
    ///
    /// # 반환
    /// `std::fmt::Result`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::NoCredentials => {
                write!(f, "{}", i18n::t("api.err.no_creds"))
            }
            ApiError::Expired => write!(f, "{}", i18n::t("api.err.expired")),
            ApiError::Auth => write!(f, "{}", i18n::t("api.err.auth")),
            ApiError::Http(c) => write!(f, "{}", i18n::tf("api.err.http", &[("code", &c.to_string())])),
            ApiError::Network(e) => write!(f, "{}", i18n::tf("api.err.network", &[("e", e)])),
            ApiError::Parse(e) => write!(f, "{}", i18n::tf("api.err.parse", &[("e", e)])),
        }
    }
}

// ── 자격증명 ────────────────────────────────────────────────────────────────

/// 자격증명 파일(.credentials.json) 최상위. `claudeAiOauth` 항목만 읽는다.
#[derive(Deserialize)]
struct CredFile {
    /// OAuth 로그인 정보 (JSON 필드 `claudeAiOauth`)
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OauthCred>,
}

/// `claudeAiOauth` 항목에서 쓰는 필드 (없으면 기본값). 토큰 값은 로그에 남기지 않는다.
#[derive(Deserialize)]
struct OauthCred {
    /// 액세스 토큰 (JSON 필드 `accessToken`, 비밀값)
    #[serde(rename = "accessToken", default)]
    access_token: String,
    /// 만료 시각 (JSON 필드 `expiresAt`, 밀리초 epoch, 0 이면 모름)
    #[serde(rename = "expiresAt", default)]
    expires_at: i64,
    /// 요금제 이름 (JSON 필드 `subscriptionType`)
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    /// 한도 등급 (JSON 필드 `rateLimitTier`)
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier: Option<String>,
}

// accessToken 은 로그/디버그 노출 금지 — Debug 미구현.
/// 읽어 둔 로그인 정보 (토큰·요금제·등급).
///
/// accessToken 은 로그·디버그에 노출하지 않으려고 `Debug` 를 구현하지 않았다. `read_cred` 가 만든다.
struct Cred {
    /// 액세스 토큰 (비밀값)
    token: String,
    /// 요금제 이름 (모르면 빈 값)
    plan: String,
    /// 한도 등급 (모르면 빈 값)
    tier: String,
}

/// Claude Code 로그인 정보를 읽기 전용으로 읽는다 (토큰 갱신은 하지 않음).
///
/// `<claude_dir>/.credentials.json` 을 읽고, 없으면 `keychain_cred()`(macOS 키체인)로 대신한다. `claudeAiOauth` 가 없거나 accessToken 이 비면 `NoCredentials`.
/// expiresAt(ms) 이 현재보다 과거이면 호출하지 않도록 `Expired`(401 낭비 방지).
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
///
/// # 반환
/// `Cred`. 실패하면 `NoCredentials`·`Parse`·`Expired`.
///
/// # 참조
/// `keychain_cred`. `fetch_plan`·`fetch_cloud_sessions` 가 호출. 읽는 곳: `<claude_dir>/.credentials.json`
fn read_cred(claude_dir: &Path) -> Result<Cred, ApiError> {
    let text = std::fs::read_to_string(claude_dir.join(".credentials.json")).ok().or_else(keychain_cred).ok_or(ApiError::NoCredentials)?;
    let file: CredFile = serde_json::from_str(&text).map_err(|e| ApiError::Parse(e.to_string()))?;
    let o = file.oauth.ok_or(ApiError::NoCredentials)?;
    if o.access_token.is_empty() {
        return Err(ApiError::NoCredentials);
    }
    // expiresAt(ms) 경과 시 호출하지 않음(401 낭비 방지).
    if o.expires_at > 0 && o.expires_at < Utc::now().timestamp_millis() {
        return Err(ApiError::Expired);
    }
    Ok(Cred { token: o.access_token, plan: o.subscription_type.unwrap_or_default(), tier: o.rate_limit_tier.unwrap_or_default() })
}

/// macOS 키체인에서 Claude Code 자격증명 JSON 을 읽는다.
///
/// Claude Code 는 macOS 에서 자격증명을 파일 대신 키체인(서비스 "Claude Code-credentials")에 저장한다. `security find-generic-password -w` 를 실행하며,
/// 첫 조회 시 macOS 가 키체인 접근 허용을 묻는다("항상 허용" 권장).
///
/// # 반환
/// 자격증명 JSON 문자열. 명령 실패·빈 값이면 None.
///
/// # 참조
/// `read_cred` 가 파일이 없을 때 호출.
#[cfg(target_os = "macos")]
fn keychain_cred() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    Some(text.trim().to_string()).filter(|t| !t.is_empty())
}

/// macOS 가 아닌 환경의 `keychain_cred` — 항상 None.
///
/// # 반환
/// None (키체인 사용 안 함).
///
/// # 참조
/// `read_cred`.
#[cfg(not(target_os = "macos"))]
fn keychain_cred() -> Option<String> {
    None
}

/// 전역 타임아웃(20초)을 건 HTTP 에이전트를 만든다 (네트워크 교착 시 스레드 무한대기 방지).
///
/// # 반환
/// `ureq::Agent`.
///
/// # 참조
/// `get_json` 에서 호출.
fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).build().into()
}

/// 인증 헤더를 붙여 GET 하고 JSON 으로 해석한다.
///
/// `authorization: Bearer`, `anthropic-beta`, `anthropic-version`, `user-agent` 헤더를 붙이고 `org` 가 있으면 `x-organization-uuid` 도 붙인다.
/// 401·403 은 `Auth`, 그 외 상태는 `Http`, 전송 오류는 `Network`, 본문이 JSON 이 아니면 `Parse`.
///
/// # 인자
/// - `cred`: 로그인 정보 (토큰은 헤더에만 쓰고 로그에 남기지 않음)
/// - `path`: `BASE` 뒤에 붙일 경로 (쿼리 포함)
/// - `beta`: `anthropic-beta` 헤더 값
/// - `org`: 조직 uuid. None 이면 헤더 생략
///
/// # 반환
/// 응답 JSON. 실패하면 `ApiError`.
///
/// # 참조
/// `http_agent`. `fetch_plan`·`credits_cached`·`profile`·`fetch_cloud_sessions`·`env_projects` 가 호출.
fn get_json(cred: &Cred, path: &str, beta: &str, org: Option<&str>) -> Result<Value, ApiError> {
    let mut req = http_agent()
        .get(&format!("{BASE}{path}"))
        .header("authorization", &format!("Bearer {}", cred.token))
        .header("anthropic-beta", beta)
        .header("anthropic-version", API_VERSION)
        .header("user-agent", USER_AGENT);
    if let Some(org) = org {
        req = req.header("x-organization-uuid", org);
    }
    let mut resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(401)) | Err(ureq::Error::StatusCode(403)) => return Err(ApiError::Auth),
        Err(ureq::Error::StatusCode(c)) => return Err(ApiError::Http(c)),
        Err(e) => return Err(ApiError::Network(e.to_string())),
    };
    let body = resp.body_mut().read_to_string().map_err(|e| ApiError::Network(e.to_string()))?;
    serde_json::from_str(&body).map_err(|e| ApiError::Parse(e.to_string()))
}

// ── 플랜 한도 ───────────────────────────────────────────────────────────────

/// 한도 1건 (5시간 세션 / 주간 전체 / 주간 모델별 등).
///
/// `percent` 는 0~100. `parse_limits` 가 만들어 `Plan.limits` 에 담긴다(Serialize).
#[derive(Serialize, Clone)]
pub struct Limit {
    /// 종류 ("session" | "weekly_all" | "weekly_scoped" 등 서버 값)
    pub kind: String,
    /// 화면에 보일 이름 (예: "5시간 세션")
    pub label: String,
    /// 사용 비율 0~100
    pub percent: f64,
    /// 심각도 ("normal" | "warning" | "critical")
    pub severity: String,
    /// 초기화 시각 (서버 문자열). 모르면 None
    pub resets_at: Option<String>,
    /// 모델별 주간 한도(weekly_scoped): 이 모델이 쓴 양 = 주간 전체 한도의 몇 %(weekly_scoped_shares).
    pub share_of_weekly: Option<f64>,
    /// 이 모델에 허용된 양 = 주간 전체 한도의 몇 %.
    pub allowance_of_weekly: Option<f64>,
}

/// 주간 사용 비중 한 줄 (Claude Code / Chats / Cowork 등).
///
/// `parse_breakdown` 이 만들어 `Plan.breakdown` 에 담긴다.
#[derive(Serialize, Clone)]
pub struct Share {
    /// 서피스 이름 (없으면 "-")
    pub name: String,
    /// 비중 퍼센트
    pub percent: f64,
}

/// 추가 사용량(usage credits). 활성 계정만.
///
/// `parse_extra` 가 만들어 `Plan.extra` 에 담긴다.
#[derive(Serialize, Clone)]
pub struct Extra {
    /// 사용한 금액 (통화 단위의 실수)
    pub used: f64,
    /// 한도 금액. 한도가 없으면 None
    pub limit: Option<f64>,
    /// 통화 코드 (없으면 "USD")
    pub currency: String,
}

/// 사용 크레딧(claude.ai 에서 충전하는 선불 크레딧) 잔액.
///
/// GET /api/oauth/organizations/{org}/prepaid/credits 응답에서 `parse_credits` 가 만든다.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Credits {
    /// 잔액 (통화 단위의 실수)
    pub balance: f64,
    /// 통화 코드 (없으면 "USD")
    pub currency: String,
    /// 프로모션으로 받은 크레딧 묶음(남은 금액·만료일). 남은 금액 0 이나 지난 것은 뺌.
    pub promos: Vec<CreditTranche>,
    /// 자동 충전 설정이 켜져 있는지
    pub auto_reload: bool,
}

/// 프로모션 크레딧 묶음 하나 (이름·남은 금액·만료일). `Credits.promos` 의 원소.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CreditTranche {
    /// 묶음 이름 (공백 제거)
    pub name: String,
    /// 남은 금액 (통화 단위의 실수)
    pub remaining: f64,
    /// 만료 시각 (서버 문자열). 모르면 None
    pub expires_at: Option<String>,
}

/// 프로모션 사용량 (사용량 응답 promo_credits[]) — 클라우드 세션 크레딧 같은 기간 한정 혜택.
///
/// `parse_promos` 가 만들어 `Plan.promos` 에 담긴다.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Promo {
    /// 프로모션 이름
    pub label: String,
    /// 0~100.
    pub percent: f64,
    /// 사용한 금액(달러). 모르면 None
    pub used: Option<f64>,
    /// 한도 금액(달러). 모르면 None
    pub limit: Option<f64>,
    /// 초기화 시각 (서버 문자열). 모르면 None
    pub resets_at: Option<String>,
    /// 조건 안내 문구 (공백만이면 None)
    pub terms: Option<String>,
}

/// 계정 플랜 현황 (요금제·한도·비중·추가 사용량·크레딧·프로모션·계정).
///
/// `fetch_plan` 이 만들어 화면으로 전달한다(Serialize).
#[derive(Serialize, Clone)]
pub struct Plan {
    /// 요금제 이름
    pub plan: String,
    /// 한도 등급
    pub tier: String,
    /// 한도 목록
    pub limits: Vec<Limit>,
    /// 주간 사용 서피스별 비중
    pub breakdown: Vec<Share>,
    /// 추가 사용량. 비활성이면 None
    pub extra: Option<Extra>,
    /// 사용 크레딧 잔액. 조회 실패·잔액도 프로모션도 없으면 None.
    pub credits: Option<Credits>,
    /// 프로모션 사용량 목록
    pub promos: Vec<Promo>,
    /// 계정 정보(헤더 표시). 프로필 조회 실패 시 None — 한도 표시는 계속.
    pub account: Option<Account>,
}

/// 계정 표시 정보 (이름·이메일·조직 이름). `profile` 응답에서 채운다.
#[derive(Serialize, Clone)]
pub struct Account {
    /// 표시 이름 (display_name → full_name 순, 없으면 빈 값)
    pub name: String,
    /// 이메일 (비밀 취급은 아니나 로그에 남기지 않는다)
    pub email: String,
    /// 조직 이름
    pub org_name: String,
}

impl Plan {
    /// 트레이 링 게이지용 퍼센트 한 쌍을 돌려준다.
    ///
    /// `limits` 에서 kind 가 "session" 인 것과 "weekly_all" 인 것의 percent 를 찾는다.
    ///
    /// # 반환
    /// (5시간 세션 %, 주간 전체 %). 해당 한도가 없으면 각각 None.
    pub fn gauges(&self) -> (Option<f64>, Option<f64>) {
        let find = |k: &str| self.limits.iter().find(|l| l.kind == k).map(|l| l.percent);
        (find("session"), find("weekly_all"))
    }
}

/// 계정 플랜 현황을 서버에서 받아 `Plan` 으로 만든다.
///
/// `read_cred` 로 로그인 정보를 읽고 GET /api/oauth/usage 로 한도를 받는다. 프로필·크레딧은 부가 정보라 실패해도 한도 표시는 계속한다(계정·크레딧은 None).
/// 한도·비중·추가 사용량·프로모션은 응답 JSON 에서 `parse_*` 로 뽑는다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
///
/// # 반환
/// `Plan`. 로그인 정보나 사용량 조회가 실패하면 `ApiError`.
///
/// # 참조
/// `read_cred`, `get_json`, `profile`, `credits_cached`, `parse_limits`, `parse_breakdown`, `parse_extra`, `parse_promos`.
pub fn fetch_plan(claude_dir: &Path) -> Result<Plan, ApiError> {
    let cred = read_cred(claude_dir)?;
    let v = get_json(&cred, "/api/oauth/usage", OAUTH_BETA, None)?;
    let prof = profile(&cred).ok();
    // 크레딧 조회는 부가 정보 — 실패해도 한도 표시는 계속.
    let credits = prof.as_ref().and_then(|p| credits_cached(&cred, &p.org));
    Ok(Plan {
        plan: cred.plan.clone(),
        tier: cred.tier.clone(),
        limits: parse_limits(&v),
        breakdown: parse_breakdown(&v),
        extra: parse_extra(&v),
        credits,
        promos: parse_promos(&v),
        account: prof.map(|p| p.account),
    })
}

/// 사용 크레딧 캐시 항목 형태: (조직 uuid, 조회 시각, 사용 크레딧).
type CreditsCache = (String, Instant, Option<Credits>);
/// 조직별 사용 크레딧 캐시.
///
/// 잔액은 자주 바뀌지 않으므로 `CREDITS_TTL`(10분) 동안 재사용한다. 조회 실패(429·시간 초과)면 마지막 정상 값을 그대로 써서 일시 오류로 잔액이 "없음"으로 깜빡이지 않게 한다.
static CREDITS: Mutex<Option<CreditsCache>> = Mutex::new(None);
/// `CREDITS` 캐시 유효 시간 (600초).
const CREDITS_TTL: Duration = Duration::from_secs(600);

/// 사용 크레딧을 캐시를 거쳐 가져온다.
///
/// 같은 조직의 캐시가 `CREDITS_TTL` 이내면 그대로 쓰고, 아니면 GET /api/oauth/organizations/{org}/prepaid/credits 를 호출해 `parse_credits` 로 해석한 뒤 캐시에 저장한다.
/// 호출이 실패하면 오류는 debug 로그만 남기고 이전 값을 돌려준다.
///
/// # 인자
/// - `cred`: 로그인 정보
/// - `org`: 조직 uuid
///
/// # 반환
/// `Credits`. 잔액도 프로모션도 없거나 실패했는데 이전 값도 없으면 None.
///
/// # 참조
/// `get_json`, `parse_credits`, `CREDITS`. `fetch_plan` 이 호출.
fn credits_cached(cred: &Cred, org: &str) -> Option<Credits> {
    let last = CREDITS.lock().unwrap().clone().filter(|(o, _, _)| o == org);
    if let Some((_, at, c)) = &last {
        if at.elapsed() < CREDITS_TTL {
            return c.clone();
        }
    }
    match get_json(cred, &format!("/api/oauth/organizations/{org}/prepaid/credits"), OAUTH_BETA, Some(org)) {
        Ok(v) => {
            let c = parse_credits(&v, Utc::now());
            *CREDITS.lock().unwrap() = Some((org.to_string(), Instant::now(), c.clone()));
            c
        }
        Err(e) => {
            let prev = last.and_then(|(_, _, c)| c);
            if matches!(e, ApiError::Auth) {
                // 같은 토큰으로 프로필·한도는 받았으니 여기서의 401·403 은 대개 요금제가 이 기능을 지원하지 않는 경우다
                // (403 permission_error "only available for Pro, Max, and Ultra plans"). 새로고침마다 다시 묻지 않게 실패도 TTL 동안 캐시한다.
                log::debug!("사용 크레딧 조회 거절(이 요금제에서 지원하지 않을 수 있음), {}초 동안 다시 묻지 않음: {e}", CREDITS_TTL.as_secs());
                *CREDITS.lock().unwrap() = Some((org.to_string(), Instant::now(), prev.clone()));
            } else {
                log::debug!("사용 크레딧 조회 실패(이전 값 유지): {e}");
            }
            prev
        }
    }
}

/// { amount_minor, exponent } 금액 객체를 실수 금액으로 바꾼다 (exponent 가 없으면 2).
///
/// # 인자
/// - `m`: amount_minor·exponent 를 가진 JSON 객체
///
/// # 반환
/// amount_minor / 10^exponent. amount_minor 가 없거나 숫자가 아니면 None.
///
/// # 참조
/// `parse_credits` 가 호출.
fn minor(m: &Value) -> Option<f64> {
    let amt = m.get("amount_minor")?.as_f64()?;
    let exp = m.get("exponent").and_then(Value::as_i64).unwrap_or(2) as i32;
    Some(amt / 10f64.powi(exp))
}

/// prepaid/credits 응답을 `Credits` 로 해석한다.
///
/// 잔액은 /balance/credits, 없으면 /balance/money 에서 읽는다. promo_tranches 중 남은 금액이 0 초과이고 만료되지 않은 것만 담는다.
/// 잔액이 0 이하이고 남은 프로모션도 없으면 None(카드 숨김). 통화는 없으면 "USD", 자동 충전은 /auto_reload_settings/enabled.
///
/// # 인자
/// - `v`: prepaid/credits 응답 JSON
/// - `now`: 만료 판정 기준 시각
///
/// # 반환
/// `Credits`. 보여줄 것이 없으면 None.
///
/// # 참조
/// `minor`. `credits_cached` 가 호출.
fn parse_credits(v: &Value, now: DateTime<Utc>) -> Option<Credits> {
    let balance = v.pointer("/balance/credits").and_then(minor).or_else(|| v.pointer("/balance/money").and_then(minor)).unwrap_or(0.0);
    let promos: Vec<CreditTranche> = v
        .get("promo_tranches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let exp = t.get("exponent").and_then(Value::as_i64).unwrap_or(2) as i32;
            let remaining = t.get("remaining_amount_minor_units")?.as_f64()? / 10f64.powi(exp);
            let expires_at = t.get("expires_at").and_then(Value::as_str).map(str::to_string);
            let expired = expires_at.as_deref().and_then(|e| DateTime::parse_from_rfc3339(e).ok()).is_some_and(|e| e <= now);
            (remaining > 0.0 && !expired).then(|| CreditTranche {
                name: t.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                remaining,
                expires_at,
            })
        })
        .collect();
    if balance <= 0.0 && promos.is_empty() {
        return None;
    }
    Some(Credits {
        balance,
        currency: v.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string(),
        promos,
        auto_reload: v.pointer("/auto_reload_settings/enabled").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// 사용량 응답 promo_credits[] 를 프로모션 목록으로 해석한다.
///
/// Claude Code 와 같이 Fable 프로모션(program_id 가 model_promo_fable)은 주간 한도(주간 · Fable)로 이미 보이므로 뺀다. label 이 없거나 공백뿐인 항목도 뺀다.
///
/// # 인자
/// - `v`: usage 응답 JSON
///
/// # 반환
/// `Promo` 목록 (없으면 빈 목록).
///
/// # 참조
/// `fetch_plan` 이 호출.
fn parse_promos(v: &Value) -> Vec<Promo> {
    v.get("promo_credits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.get("program_id").and_then(Value::as_str) != Some("model_promo_fable"))
        .filter_map(|p| {
            let label = p.get("label")?.as_str()?.trim();
            (!label.is_empty()).then(|| Promo {
                label: label.to_string(),
                percent: p.get("utilization").and_then(Value::as_f64).unwrap_or(0.0),
                used: p.get("used_dollars").and_then(Value::as_f64),
                limit: p.get("limit_dollars").and_then(Value::as_f64),
                resets_at: p.get("resets_at").and_then(Value::as_str).map(str::to_string),
                terms: p.get("terms_line").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string),
            })
        })
        .collect()
}

/// 한도 종류에서 화면용 이름을 만든다.
///
/// "session" → "5시간 세션", "weekly_all" → "주간 · 전체 모델", 범위 이름이 있으면 "주간 · {이름}", 없으면 kind 그대로.
///
/// # 인자
/// - `kind`: 한도 종류
/// - `scope_name`: 모델·서피스 표시 이름 (없으면 None)
///
/// # 반환
/// 화면에 보일 이름.
///
/// # 참조
/// `parse_limits` 가 호출.
fn limit_label(kind: &str, scope_name: Option<&str>) -> String {
    match (kind, scope_name) {
        ("session", _) => i18n::t("limit.session5").into(),
        ("weekly_all", _) => i18n::t("limit.weekly_all").into(),
        (_, Some(n)) => i18n::tf("limit.weekly_scoped", &[("name", n)]),
        (k, None) => k.to_string(),
    }
}

/// 사용량 응답을 `Limit` 목록으로 해석한다.
///
/// 신형 `limits[]` 를 우선 읽고, weekly_scoped_shares[] 의 limit_index 가 가리키는 한도에 share_of_weekly·allowance_of_weekly 를 붙인다.
/// `limits[]` 가 없어 비면 구형 five_hour / seven_day / seven_day_opus / seven_day_sonnet 로 대신하며, 이때 심각도는 90% 이상 critical, 70% 이상 warning, 그 외 normal.
///
/// # 인자
/// - `v`: usage 응답 JSON
///
/// # 반환
/// `Limit` 목록 (없으면 빈 목록).
///
/// # 참조
/// `limit_label`. `fetch_plan` 이 호출.
fn parse_limits(v: &Value) -> Vec<Limit> {
    let mut out = Vec::new();
    if let Some(arr) = v.get("limits").and_then(Value::as_array) {
        for l in arr {
            let kind = l.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
            let scope = l
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .or_else(|| l.pointer("/scope/surface/display_name").and_then(Value::as_str));
            out.push(Limit {
                label: limit_label(&kind, scope),
                kind,
                percent: l.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
                severity: l.get("severity").and_then(Value::as_str).unwrap_or("normal").to_string(),
                resets_at: l.get("resets_at").and_then(Value::as_str).map(str::to_string),
                share_of_weekly: None,
                allowance_of_weekly: None,
            });
        }
        // weekly_scoped_shares[].limit_index = limits[] 위치.
        for sh in v.get("weekly_scoped_shares").and_then(Value::as_array).into_iter().flatten() {
            let Some(l) = sh.get("limit_index").and_then(Value::as_u64).and_then(|i| out.get_mut(i as usize)) else {
                continue;
            };
            l.share_of_weekly = sh.get("used_percent_of_weekly").and_then(Value::as_f64);
            l.allowance_of_weekly = sh.get("allowance_percent_of_weekly").and_then(Value::as_f64);
        }
    }
    if !out.is_empty() {
        return out;
    }
    let legacy = [
        ("five_hour", "session", None),
        ("seven_day", "weekly_all", None),
        ("seven_day_opus", "weekly_scoped", Some("Opus")),
        ("seven_day_sonnet", "weekly_scoped", Some("Sonnet")),
    ];
    for (key, kind, name) in legacy {
        if let Some(w) = v.get(key).filter(|w| w.is_object()) {
            let pct = w.get("utilization").and_then(Value::as_f64).unwrap_or(0.0);
            out.push(Limit {
                kind: kind.into(),
                label: limit_label(kind, name),
                percent: pct,
                severity: if pct >= 90.0 {
                    "critical"
                } else if pct >= 70.0 {
                    "warning"
                } else {
                    "normal"
                }
                .into(),
                resets_at: w.get("resets_at").and_then(Value::as_str).map(str::to_string),
                share_of_weekly: None,
                allowance_of_weekly: None,
            });
        }
    }
    out
}

/// 사용량 응답의 /seven_day_breakdown/rows 를 서피스별 비중 목록으로 해석한다.
///
/// # 인자
/// - `v`: usage 응답 JSON
///
/// # 반환
/// `Share` 목록. rows 가 없으면 빈 목록.
///
/// # 참조
/// `fetch_plan` 이 호출.
fn parse_breakdown(v: &Value) -> Vec<Share> {
    v.pointer("/seven_day_breakdown/rows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|r| Share {
                    name: r.get("display_name").and_then(Value::as_str).unwrap_or("-").to_string(),
                    percent: r.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 사용량 응답의 spend 를 추가 사용량으로 해석한다.
///
/// spend.enabled 가 true 일 때만 읽고, used·limit 은 { amount_minor, currency, exponent } 를 exponent(없으면 2)로 나눈 실수 금액으로 바꾼다. 통화는 used.currency, 없으면 "USD".
///
/// # 인자
/// - `v`: usage 응답 JSON
///
/// # 반환
/// `Extra`. spend 가 없거나 비활성이거나 used 가 없으면 None.
///
/// # 참조
/// `fetch_plan` 이 호출.
fn parse_extra(v: &Value) -> Option<Extra> {
    let spend = v.get("spend")?;
    if !spend.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let money = |m: &Value| -> Option<f64> {
        let minor = m.get("amount_minor")?.as_f64()?;
        let exp = m.get("exponent").and_then(Value::as_i64).unwrap_or(2) as i32;
        Some(minor / 10f64.powi(exp))
    };
    let used = spend.get("used")?;
    Some(Extra {
        used: money(used).unwrap_or(0.0),
        limit: spend.get("limit").and_then(money),
        currency: used.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string(),
    })
}

// ── 클라우드 세션 ───────────────────────────────────────────────────────────

/// claude.ai/code 세션 하나 (클라우드 실행 + 원격 제어 브리지).
///
/// `to_cloud` 가 GET /v1/sessions 응답 한 건에서 만든다. 화면으로 전달된다(Serialize).
#[derive(Serialize, Clone)]
pub struct CloudSession {
    /// 세션 id
    pub id: String,
    /// 세션 제목
    pub title: String,
    /// 세션 상태 (서버 session_status)
    pub status: String,
    /// "cloud" | "bridge"(로컬 PC 원격 제어) 등.
    pub env: String,
    /// 설정된 모델 (configured_model)
    pub model: String,
    /// 생성 시각 (서버 문자열)
    pub created_at: String,
    /// 갱신 시각 (서버 문자열)
    pub updated_at: String,
    /// post_turn_summary.status_category (need_input / review_ready …).
    pub state: String,
    /// post_turn_summary.needs_action 값
    pub needs_action: String,
    /// 열기 주소 (서버 값이 https:// 가 아니면 claude.ai/code/<id> 로 대체)
    pub url: String,
    /// 세션 누적 토큰 수 (usage 합, 0 이면 None)
    pub tokens: Option<u64>,
    /// 세션 누적 비용(USD, API 요금 환산). 최근 응답은 토큰 수 대신 이것만 줌.
    pub cost_usd: Option<f64>,
    /// 프로젝트 이름: 연결된 저장소 이름, 없으면 원격 제어 PC 의 작업 폴더 이름. 모르면 빈 값.
    pub project: String,
    /// 환경 id. 화면에는 보내지 않고(serde skip) 프로젝트 이름 보충에만 쓴다
    #[serde(skip)]
    pub(crate) env_id: String,
}

/// 프로필 조회 결과 (조직 uuid + 계정 표시 정보). `PROFILE` 에 캐시된다.
#[derive(Clone)]
struct Profile {
    /// 조직 uuid (클라우드 세션 조회 헤더용)
    org: String,
    /// 계정 표시 정보
    account: Account,
}

/// 프로필 캐시: (토큰 지문, 저장 시각, 프로필).
///
/// 토큰이 바뀌면(재로그인·계정 전환·Claude Code 갱신) 즉시 다시 조회하고, 같은 토큰이면 `PROFILE_TTL`(1시간) 동안 재사용한다. 이름 변경은 다음 만료 후 반영된다.
static PROFILE: Mutex<Option<(u64, Instant, Profile)>> = Mutex::new(None);
/// `PROFILE` 캐시 유효 시간 (3600초).
const PROFILE_TTL: Duration = Duration::from_secs(3600);

/// 토큰 지문을 구한다 — 원문 대신 해시만 캐시에 보관하려는 용도.
///
/// # 인자
/// - `cred`: 로그인 정보
///
/// # 반환
/// `DefaultHasher` 해시 u64.
///
/// # 참조
/// `profile` 이 캐시 키로 사용.
fn token_key(cred: &Cred) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cred.token.hash(&mut h);
    h.finish()
}

/// 프로필(조직 uuid·계정 표시 정보)을 가져온다.
///
/// 토큰 지문이 같고 `PROFILE_TTL` 이내면 캐시를 쓰고, 아니면 GET /api/oauth/profile 을 호출한다. organization.uuid 가 없으면 `Parse` 오류.
/// 이름은 account.display_name, 없으면 full_name 을 쓰며 결과를 `PROFILE` 에 저장한다.
///
/// # 인자
/// - `cred`: 로그인 정보
///
/// # 반환
/// `Profile`. 실패하면 `ApiError`.
///
/// # 참조
/// `token_key`, `get_json`. `fetch_plan`·`org_uuid` 가 호출.
fn profile(cred: &Cred) -> Result<Profile, ApiError> {
    let key = token_key(cred);
    if let Some((k, at, p)) = PROFILE.lock().unwrap().clone() {
        if k == key && at.elapsed() < PROFILE_TTL {
            return Ok(p);
        }
    }
    let v = get_json(cred, "/api/oauth/profile", OAUTH_BETA, None)?;
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let org = s("/organization/uuid");
    if org.is_empty() {
        return Err(ApiError::Parse(i18n::t("api.err.no_org").into()));
    }
    let name = [s("/account/display_name"), s("/account/full_name")].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
    let p = Profile { org, account: Account { name, email: s("/account/email"), org_name: s("/organization/name") } };
    *PROFILE.lock().unwrap() = Some((key, Instant::now(), p.clone()));
    Ok(p)
}

/// 조직 uuid 만 돌려준다.
///
/// # 인자
/// - `cred`: 로그인 정보
///
/// # 반환
/// 조직 uuid. 프로필 조회에 실패하면 `ApiError`.
///
/// # 참조
/// `profile`. `fetch_cloud_sessions` 가 호출.
fn org_uuid(cred: &Cred) -> Result<String, ApiError> {
    profile(cred).map(|p| p.org)
}

/// 클라우드 세션(GET /v1/sessions)을 받아 최신순으로 돌려준다.
///
/// 조직 uuid 헤더를 붙여 `after_id` 로 페이지를 이어 받으며(최대 20회, has_more·last_id 기준), `to_cloud` 로 변환해 갱신 시각이 `since` 이후인 것만 담는다.
/// 프로젝트 이름이 빈 세션이 환경 id 를 가지면 `env_projects` 로 보충한 뒤 updated_at 내림차순으로 정렬한다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
/// - `since`: 이 시각 이후 갱신된 세션만 (갱신 시각을 해석 못 하면 포함)
///
/// # 반환
/// `CloudSession` 목록(최신순). 로그인·조직 조회나 페이지 호출이 실패하면 `ApiError`.
///
/// # 참조
/// `read_cred`, `org_uuid`, `get_json`, `to_cloud`, `env_projects`.
pub fn fetch_cloud_sessions(claude_dir: &Path, since: DateTime<Utc>) -> Result<Vec<CloudSession>, ApiError> {
    let cred = read_cred(claude_dir)?;
    let org = org_uuid(&cred)?;
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..20 {
        let path = match &after {
            Some(a) => format!("/v1/sessions?after_id={a}"),
            None => "/v1/sessions".to_string(),
        };
        let v = get_json(&cred, &path, SESSIONS_BETA, Some(&org))?;
        let data = v.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        for s in &data {
            if let Some(cs) = to_cloud(s) {
                let upd = DateTime::parse_from_rfc3339(&cs.updated_at).map(|d| d.with_timezone(&Utc));
                if upd.map(|d| d >= since).unwrap_or(true) {
                    out.push(cs);
                }
            }
        }
        let more = v.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        after = v.get("last_id").and_then(Value::as_str).map(str::to_string);
        if !more || after.is_none() || data.is_empty() {
            break;
        }
    }
    if out.iter().any(|s| s.project.is_empty() && !s.env_id.is_empty()) {
        let dirs = env_projects(&cred, &org);
        for s in out.iter_mut().filter(|s| s.project.is_empty()) {
            if let Some(p) = dirs.get(&s.env_id) {
                s.project = p.clone();
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 경로·저장소 주소의 마지막 이름을 뽑는다 (".git" 제외).
///
/// 끝의 '/'·'\' 를 떼고 마지막 구분자 뒤 부분에서 ".git" 접미사를 뗀다.
///
/// # 인자
/// - `path`: 경로 또는 저장소 주소
///
/// # 반환
/// 마지막 이름. 비어 있으면 빈 문자열.
///
/// # 참조
/// `to_cloud`·`env_projects` 가 프로젝트 이름에 사용.
fn last_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").trim_end_matches(".git").to_string()
}

/// 환경 → 프로젝트 이름 캐시 항목 형태: (조직 uuid, 저장 시각, 환경 id → 프로젝트 이름 맵).
type EnvCache = (String, Instant, std::collections::HashMap<String, String>);
/// `env_projects` 결과 캐시. 같은 조직이고 `ENV_TTL` 이내일 때만 재사용한다 (`Mutex` 로 보호).
static ENV_PROJECTS: Mutex<Option<EnvCache>> = Mutex::new(None);
/// `ENV_PROJECTS` 캐시 유효 시간 (600초).
const ENV_TTL: Duration = Duration::from_secs(600);

/// 환경 id → 프로젝트 이름 맵을 가져온다 (원격 제어 PC 의 저장소 이름 또는 작업 폴더 이름).
///
/// GET /v1/environment_providers 의 environments[] 에서 environment_id 와 bridge_info(git_repo_url 의 마지막 이름, 없으면 directory 의 마지막 이름)를 뽑는다.
/// 성공한 결과만 10분 캐시하고, 실패하면 debug 로그만 남기고 빈 맵을 돌려준다(다음 폴링에 다시 시도).
///
/// # 인자
/// - `cred`: 로그인 정보
/// - `org`: 조직 uuid
///
/// # 반환
/// 환경 id → 프로젝트 이름. 실패하면 빈 맵.
///
/// # 참조
/// `get_json`, `last_name`, `ENV_PROJECTS`. `fetch_cloud_sessions` 가 호출.
fn env_projects(cred: &Cred, org: &str) -> std::collections::HashMap<String, String> {
    if let Some((o, at, m)) = ENV_PROJECTS.lock().unwrap().as_ref() {
        if o == org && at.elapsed() < ENV_TTL {
            return m.clone();
        }
    }
    let map: std::collections::HashMap<String, String> = match get_json(cred, "/v1/environment_providers", SESSIONS_BETA, Some(org)) {
        Ok(v) => v
            .get("environments")
            .and_then(Value::as_array)
            .map(|envs| {
                envs.iter()
                    .filter_map(|e| {
                        let id = e.get("environment_id")?.as_str()?.to_string();
                        let info = e.get("bridge_info")?;
                        let repo = info.get("git_repo_url").and_then(Value::as_str).map(last_name).unwrap_or_default();
                        let name = if repo.is_empty() { info.get("directory").and_then(Value::as_str).map(last_name)? } else { repo };
                        (!name.is_empty()).then_some((id, name))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Err(e) => {
            log::debug!("환경 목록 조회 실패(프로젝트 이름 생략): {e}");
            return Default::default();
        }
    };
    *ENV_PROJECTS.lock().unwrap() = Some((org.to_string(), Instant::now(), map.clone()));
    map
}

/// 세션 JSON 한 건을 `CloudSession` 으로 바꾼다.
///
/// id·title·session_status·environment_kind·configured_model·시각·post_turn_summary 등을 JSON 포인터로 읽는다. 토큰은 external_metadata.usage 의 입력·출력·캐시 읽기·캐시 쓰기 합(0 이면 None),
/// 비용은 usage.cost_usd(0 이하면 None). 프로젝트 이름은 session_context.sources 의 첫 url 의 마지막 이름.
///
/// # 인자
/// - `s`: /v1/sessions 응답의 세션 항목 JSON
///
/// # 반환
/// `CloudSession`. id 가 비어 있으면 None.
///
/// # 참조
/// `last_name`. `fetch_cloud_sessions` 가 호출.
fn to_cloud(s: &Value) -> Option<CloudSession> {
    let str_at = |p: &str| s.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let id = str_at("/id");
    if id.is_empty() {
        return None;
    }
    let usage = s.pointer("/external_metadata/usage");
    let tokens = usage.map(|u| {
        ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
            .iter()
            .filter_map(|k| u.get(*k).and_then(Value::as_u64))
            .sum::<u64>()
    });
    let mut url = str_at("/session_url");
    if !url.starts_with("https://") {
        url = format!("https://claude.ai/code/{id}");
    }
    Some(CloudSession {
        title: str_at("/title"),
        status: str_at("/session_status"),
        env: str_at("/environment_kind"),
        model: str_at("/configured_model"),
        created_at: str_at("/created_at"),
        updated_at: str_at("/updated_at"),
        state: str_at("/post_turn_summary/status_category"),
        needs_action: str_at("/post_turn_summary/needs_action"),
        tokens: tokens.filter(|t| *t > 0),
        cost_usd: usage.and_then(|u| u.get("cost_usd")).and_then(Value::as_f64).filter(|c| *c > 0.0),
        url,
        project: s
            .pointer("/session_context/sources")
            .and_then(Value::as_array)
            .and_then(|src| src.iter().find_map(|x| x.get("url").and_then(Value::as_str)))
            .map(last_name)
            .unwrap_or_default(),
        env_id: str_at("/environment_id"),
        id,
    })
}

/// 한도·크레딧·프로모션 해석과 프로젝트 이름 추출 단위 테스트.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_share_attaches_to_limit() {
        let v: Value = serde_json::from_str(
            r#"{"limits":[{"kind":"weekly_all","percent":23,"severity":"normal","scope":null},
                {"kind":"weekly_scoped","percent":30,"severity":"normal","scope":{"model":{"display_name":"Fable"}}}],
                "weekly_scoped_shares":[{"limit_index":1,"used_percent_of_weekly":15,"allowance_percent_of_weekly":50}]}"#,
        )
        .unwrap();
        let l = parse_limits(&v);
        assert_eq!(l[1].label, "주간 · Fable");
        assert_eq!((l[1].share_of_weekly, l[1].allowance_of_weekly), (Some(15.0), Some(50.0)));
        assert_eq!(l[0].share_of_weekly, None);
    }

    #[test]
    fn credits_balance_and_live_promos() {
        let now = DateTime::parse_from_rfc3339("2026-11-15T00:00:00Z").unwrap().with_timezone(&Utc);
        let empty: Value = serde_json::from_str(
            r#"{"amount":0,"currency":"USD","balance":{"money":null,"credits":{"amount_minor":0,"exponent":2}},"auto_reload_settings":null,"promo_tranches":[]}"#,
        )
        .unwrap();
        assert_eq!(parse_credits(&empty, now), None);
        let v: Value = serde_json::from_str(
            r#"{"currency":"USD","balance":{"credits":{"amount_minor":1250,"exponent":2}},"auto_reload_settings":{"enabled":true},
                "promo_tranches":[{"name":"Web credits","remaining_amount_minor_units":500,"expires_at":"2026-12-01T00:00:00Z"},
                                  {"name":"old","remaining_amount_minor_units":500,"expires_at":"2026-11-01T00:00:00Z"},
                                  {"name":"used","remaining_amount_minor_units":0,"expires_at":"2026-12-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let c = parse_credits(&v, now).unwrap();
        assert_eq!(c.balance, 12.5);
        assert!(c.auto_reload);
        assert_eq!(c.promos.len(), 1);
        assert_eq!((c.promos[0].name.as_str(), c.promos[0].remaining), ("Web credits", 5.0));
    }

    #[test]
    fn promo_credits_skip_fable_and_unlabeled() {
        let v: Value = serde_json::from_str(
            r#"{"promo_credits":[{"program_id":"model_promo_fable","label":"Fable","utilization":10,"resets_at":null},
                {"program_id":"web","label":"클라우드 세션","utilization":40,"resets_at":"2026-11-20T00:00:00Z","limit_dollars":50,"used_dollars":20,"terms_line":" "},
                {"program_id":"x","label":"  ","utilization":1,"resets_at":null}]}"#,
        )
        .unwrap();
        let p = parse_promos(&v);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].percent, p[0].used, p[0].limit, p[0].terms.clone()), (40.0, Some(20.0), Some(50.0), None));
        assert!(parse_promos(&serde_json::json!({"promo_credits": null})).is_empty());
    }

    #[test]
    fn project_name_from_repo_or_dir() {
        assert_eq!(last_name("https://gitlab.example.com/team/shop-api"), "shop-api");
        assert_eq!(last_name("https://github.com/a/b.git"), "b");
        assert_eq!(last_name("/home/dev/proj/"), "proj");
        assert_eq!(last_name(r"C:\dev\tray"), "tray");
    }
}
