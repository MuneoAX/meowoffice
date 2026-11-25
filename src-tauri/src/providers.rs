//! 다른 AI 서비스(제공사) 공통 형식. 제공사 모듈마다 `snapshot()` 이 이 형식을 채우고,
//! 화면은 `get_provider(name)` 하나로 받는다 (오피스 고양이·현황 카드·설정 연결 상태).
//!   - "chatgpt"     → codex.rs       (OpenAI Codex CLI·앱, ChatGPT 계정)
//!   - "antigravity" → antigravity.rs (Google Antigravity)
//!
//! Claude 는 기존 oauth.rs·local.rs 경로를 그대로 쓴다 (나중에 이 형식으로 옮길 수 있음).
//!
//! 연결 상태(`ConnState`) — installed·logged_in·auth_expired·error 조합을 한 값으로 (`conn_state`, 위에서 먼저 맞는 것):
//!   not_installed(설치 흔적 없음) → logged_out(로그인 안 됨) → expired(로그인 만료) → degraded(연결됐으나 일부 정보 없음) → connected.
//! 화면은 `Snapshot.state` 만 읽는다.
//!
//! 규칙: 비밀값(토큰·키)은 이 구조체·로그·오류 문구에 절대 넣지 않는다. 모르는 값은 빈 문자열/None (정상인 척 꾸미지 않음).

use serde::Serialize;

/// 연결 상태(명시적). installed·logged_in·auth_expired·error 조합을 한 값으로.
///
/// 직렬화는 snake_case ("not_installed" 등). 화면(설정·사용량 상세·사무실)이 이 값만 읽는다.
#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnState {
    /// 이 PC 에 도구 없음
    #[default]
    NotInstalled,
    /// 도구는 있으나 로그인 안 됨
    LoggedOut,
    /// 정상 연결
    Connected,
    /// 로그인 만료
    Expired,
    /// 연결은 됐으나 일부 정보만 있음
    Degraded,
}

/// 사용 한도 한 줄 (예: 5시간 · 주간).
///
/// `percent` 는 사용한 비율 0~100 이며 모르면 `None`. `Snapshot.limits` 의 원소로 화면에 그대로 전달된다(Serialize).
#[derive(Serialize, Clone, Default, Debug)]
pub struct Limit {
    /// 안정된 식별자: "session" | "weekly" | "monthly" | "credits" | 제공사 고유 값
    pub kind: String,
    /// 화면에 보일 이름 (예: "5시간 한도")
    pub label: String,
    /// 사용한 비율 0~100. 모르면 None
    pub percent: Option<f64>,
    /// RFC3339 (UTC 권장). 모르면 None
    pub resets_at: Option<String>,
}

/// 세션(대화) 하나의 화면용 요약.
///
/// `status`: "busy"(지금 응답·도구 실행 중) | "idle"(열려 있지만 쉼) | ""(끝남·오래됨).
/// `Snapshot.sessions` 의 원소로 전달된다(Serialize).
#[derive(Serialize, Clone, Default, Debug)]
pub struct PSession {
    /// 세션 식별자
    pub id: String,
    /// 세션 제목
    pub title: String,
    /// 작업 폴더 이름 (cwd 의 마지막 부분)
    pub project: String,
    /// 작업 폴더 전체 경로
    pub cwd: String,
    /// "busy" | "idle" | "" (구조체 설명 참고)
    pub status: String,
    /// 시작 시각 RFC3339. 모르면 None
    pub started_at: Option<String>,
    /// 마지막 활동 시각 RFC3339. 모르면 None
    pub last_at: Option<String>,
    /// 열기 링크(있으면). 없으면 빈 문자열
    pub url: String,
}

/// 제공사 한 곳의 현재 상태 (한도·세션·로그인 여부).
///
/// 각 제공사 모듈의 `snapshot()` 이 채우고 `providers::snapshot`·`remember`·`last` 로 오간다.
/// 비밀값(토큰·키)은 넣지 않으며, 모르는 값은 빈 문자열/None 으로 둔다.
#[derive(Serialize, Clone, Default, Debug)]
pub struct Snapshot {
    /// "chatgpt" | "antigravity"
    pub provider: String,
    /// 이 PC 에 설치(또는 사용 흔적) 있음
    pub installed: bool,
    /// 로그인돼 있음 (자격 증명 파일 등으로 확인)
    pub logged_in: bool,
    /// 계정 표시 이름 또는 이메일 (모르면 빈 값)
    pub account: String,
    /// 요금제 이름 (예: "Plus", "Pro") — 모르면 빈 값
    pub plan: String,
    /// 사용 한도 목록 (`main_percent` 가 대표값을 고른다)
    pub limits: Vec<Limit>,
    /// 최근 세션 목록
    pub sessions: Vec<PSession>,
    /// 일부만 실패했을 때 사람이 읽을 짧은 설명 (비밀값 금지)
    pub error: String,
    /// 이 값을 만든 시각 RFC3339
    pub fetched_at: String,
    /// 로그인 정보는 있으나 서버가 거절함(만료) — 화면이 다시 로그인 안내를 띄움
    pub auth_expired: bool,
    /// 연결 상태 — `providers::snapshot` 이 `conn_state` 로 채움. 화면은 이 값만 읽는다
    pub state: ConnState,
}

impl Snapshot {
    /// 제공사 이름만 채운 빈 `Snapshot` 을 만든다.
    ///
    /// `provider` 를 넣고 `fetched_at` 을 현재 UTC 시각(RFC3339)으로 채우며, 나머지는 `Default`(빈 값·false·빈 목록).
    ///
    /// # 인자
    /// - `provider`: 제공사 이름 ("chatgpt" | "antigravity" 등)
    ///
    /// # 반환
    /// 초기화된 `Snapshot`.
    ///
    /// # 참조
    /// `codex::snapshot`·`antigravity::snapshot`·`providers::snapshot` 에서 시작값으로 사용.
    pub fn new(provider: &str) -> Self {
        Snapshot { provider: provider.into(), fetched_at: chrono::Utc::now().to_rfc3339(), ..Default::default() }
    }
}

/// 이름으로 제공사 상태를 모은다 (파일·네트워크를 읽으므로 blocking 스레드에서 부를 것).
///
/// "chatgpt" 는 `codex::snapshot()`, "antigravity" 는 `antigravity::snapshot()` 으로 보낸다.
/// 그 외 이름은 `error` 에 "알 수 없는 제공사" 를 담은 `Snapshot` 을 돌려준다.
///
/// # 인자
/// - `name`: 제공사 이름 ("chatgpt" | "antigravity")
///
/// # 반환
/// 해당 제공사의 `Snapshot`. 알 수 없는 이름이면 오류 문구가 든 빈 `Snapshot`.
///
/// # 참조
/// `codex::snapshot`, `antigravity::snapshot`, `Snapshot::new` 를 호출한다.
pub fn snapshot(name: &str) -> Snapshot {
    let mut s = match name {
        "chatgpt" => crate::codex::snapshot(),
        "antigravity" => crate::antigravity::snapshot(),
        other => {
            let mut s = Snapshot::new(other);
            s.error = crate::i18n::t("err.unknown_provider").into();
            s
        }
    };
    s.state = conn_state(s.installed, s.logged_in, s.auth_expired, !s.error.is_empty());
    s
}

/// 설치·로그인·만료·오류 조합에서 연결 상태를 정한다.
///
/// 위에서 먼저 맞는 것: 미설치 → 로그인 안 됨 → 만료 → 오류 있음(Degraded) → 연결됨.
///
/// # 인자
/// - `installed`: 설치 흔적 있음
/// - `logged_in`: 로그인됨
/// - `auth_expired`: 서버가 로그인 거절
/// - `has_error`: 일부 조회 실패 문구 있음
///
/// # 반환
/// 해당하는 `ConnState`.
///
/// # 참조
/// `snapshot` 이 유일하게 호출해 `Snapshot.state` 를 채운다.
pub fn conn_state(installed: bool, logged_in: bool, auth_expired: bool, has_error: bool) -> ConnState {
    if !installed {
        ConnState::NotInstalled
    } else if !logged_in {
        ConnState::LoggedOut
    } else if auth_expired {
        ConnState::Expired
    } else if has_error {
        ConnState::Degraded
    } else {
        ConnState::Connected
    }
}

/// Claude 의 연결 상태를 plan 유무와 오류 종류로 정한다.
///
/// Claude 는 설치 여부를 감지하지 않으므로 NotInstalled 를 내지 않는다.
///
/// # 인자
/// - `has_plan`: 요금제 정보를 받음
/// - `error_kind`: 조회 오류 종류 ("no_credentials" | "expired" | "auth" | 그 외)
///
/// # 반환
/// 상태. 둘 다 없으면(아직 조회 전) None.
///
/// # 참조
/// `main.rs` 의 `refresh_plan` 이 `PlanSnap.state` 에 싣는다.
pub fn claude_state(has_plan: bool, error_kind: Option<&str>) -> Option<ConnState> {
    if has_plan {
        return Some(ConnState::Connected);
    }
    match error_kind? {
        "no_credentials" => Some(ConnState::LoggedOut),
        "expired" | "auth" => Some(ConnState::Expired),
        _ => Some(ConnState::Degraded),
    }
}

/// 계정 하나의 웹 서비스와 그 아래 도구.
///
/// `tool` 은 그 계정 아래 도구의 기존 서비스 키(사용량 상세 탭 키).
#[derive(Serialize, Clone, Copy, Debug)]
pub struct WebService {
    /// 웹 서비스 식별자 ("claude" | "chatgpt" | "gemini")
    pub id: &'static str,
    /// 화면 이름
    pub label: &'static str,
    /// 계정 제공사 (Anthropic · OpenAI · Google)
    pub account: &'static str,
    /// 바로가기 주소 (정확히 이 값만 열기 허용)
    pub url: &'static str,
    /// 이 계정 아래 도구의 서비스 키
    pub tool: &'static str,
}

/// 웹 서비스 표 (계정 → 도구, 단일 정의).
pub const WEB_SERVICES: [WebService; 3] = [
    WebService { id: "claude", label: "Claude", account: "Anthropic", url: "https://claude.ai", tool: "claude" },
    WebService { id: "chatgpt", label: "ChatGPT", account: "OpenAI", url: "https://chatgpt.com", tool: "chatgpt" },
    WebService { id: "gemini", label: "Gemini", account: "Google", url: "https://gemini.google.com", tool: "antigravity" },
];

// ── 마지막 조회 값 (트레이 툴팁·알림 스레드용) ──────────────────────────────────

/// 마지막 조회 값 보관소 (제공사당 하나, 트레이 툴팁·알림 스레드용).
///
/// `Mutex` 로 보호되며 `remember`·`forget`·`last` 만 접근한다.
static LAST: std::sync::Mutex<Vec<Snapshot>> = std::sync::Mutex::new(Vec::new());

/// 조회 값을 보관한다 (제공사당 하나).
///
/// `LAST` 잠금을 잡고 같은 제공사의 이전 값을 지운 뒤 복제본을 넣는다. 잠금 실패(poison) 시 아무것도 하지 않는다.
///
/// # 인자
/// - `s`: 보관할 `Snapshot` (`s.provider` 가 키)
///
/// # 참조
/// `LAST`. `forget`·`last` 와 짝.
pub fn remember(s: &Snapshot) {
    if let Ok(mut g) = LAST.lock() {
        g.retain(|x| x.provider != s.provider);
        g.push(s.clone());
    }
}

/// 보관한 마지막 조회 값을 지운다 (연동을 끈 서비스가 툴팁에 남지 않게).
///
/// `LAST` 에서 해당 제공사 항목을 제거한다. 잠금 실패 시 아무것도 하지 않는다.
///
/// # 인자
/// - `name`: 지울 제공사 이름
///
/// # 참조
/// `LAST`.
pub fn forget(name: &str) {
    if let Ok(mut g) = LAST.lock() {
        g.retain(|x| x.provider != name);
    }
}

/// 보관한 마지막 조회 값을 돌려준다.
///
/// `LAST` 에서 `provider == name` 인 첫 항목을 복제해 반환한다.
///
/// # 인자
/// - `name`: 제공사 이름
///
/// # 반환
/// 보관된 `Snapshot` 복제본. 없거나 잠금 실패면 None.
///
/// # 참조
/// `LAST`, `remember` 가 넣은 값.
pub fn last(name: &str) -> Option<Snapshot> {
    LAST.lock().ok()?.iter().find(|x| x.provider == name).cloned()
}

/// 큰 숫자로 보일 대표 한도 퍼센트를 고른다.
///
/// 로그인 안 됐으면 None. "session" 종류(퍼센트 있는 것) 우선, 없으면 "weekly" 의 첫째.
/// 둘 다 없으면(모델별 한도) 퍼센트가 있는 한도 중 최댓값.
///
/// # 인자
/// - `s`: 대상 `Snapshot`
///
/// # 반환
/// 대표 퍼센트(0~100). 로그인 안 됐거나 값이 하나도 없으면 None.
pub fn main_percent(s: &Snapshot) -> Option<f64> {
    if !s.logged_in {
        return None;
    }
    let typed = s
        .limits
        .iter()
        .find(|l| l.kind == "session" && l.percent.is_some())
        .or_else(|| s.limits.iter().find(|l| l.kind == "weekly" && l.percent.is_some()));
    match typed {
        Some(l) => l.percent,
        None => s.limits.iter().filter_map(|l| l.percent).fold(None, |m, p| Some(m.map_or(p, |x: f64| x.max(p)))),
    }
}

/// 작업 폴더 경로에서 마지막 폴더 이름을 뽑는다.
///
/// 끝의 `/`·`\` 를 떼고 마지막 구분자 뒤 부분을 돌려준다.
///
/// # 인자
/// - `cwd`: 작업 폴더 경로 (`/` 또는 `\` 구분)
///
/// # 반환
/// 마지막 폴더 이름. 비어 있으면 빈 문자열.
///
/// # 참조
/// `ptokens::build` 가 세션 `project` 를 채울 때 사용.
pub fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// 연결 상태 판정·웹 서비스 표 시험.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_state_order() {
        assert_eq!(conn_state(false, true, true, true), ConnState::NotInstalled);
        assert_eq!(conn_state(false, false, false, false), ConnState::NotInstalled);
        assert_eq!(conn_state(true, false, true, true), ConnState::LoggedOut);
        assert_eq!(conn_state(true, true, true, false), ConnState::Expired);
        assert_eq!(conn_state(true, true, false, true), ConnState::Degraded);
        assert_eq!(conn_state(true, true, false, false), ConnState::Connected);
    }

    #[test]
    fn conn_state_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&ConnState::NotInstalled).unwrap(), "\"not_installed\"");
        assert_eq!(serde_json::to_string(&ConnState::LoggedOut).unwrap(), "\"logged_out\"");
    }

    #[test]
    fn claude_state_mapping() {
        assert_eq!(claude_state(true, None), Some(ConnState::Connected));
        assert_eq!(claude_state(false, Some("no_credentials")), Some(ConnState::LoggedOut));
        assert_eq!(claude_state(false, Some("expired")), Some(ConnState::Expired));
        assert_eq!(claude_state(false, Some("auth")), Some(ConnState::Expired));
        assert_eq!(claude_state(false, Some("network")), Some(ConnState::Degraded));
        assert_eq!(claude_state(false, None), None);
    }

    #[test]
    fn unknown_provider_is_not_installed() {
        assert_eq!(snapshot("x").state, ConnState::NotInstalled);
    }

    #[test]
    fn web_services_exact_urls() {
        let u: Vec<&str> = WEB_SERVICES.iter().map(|w| w.url).collect();
        assert_eq!(u, ["https://claude.ai", "https://chatgpt.com", "https://gemini.google.com"]);
    }
}
