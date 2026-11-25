//! Claude 연결 상태 감지 → "연결 상태가 좋지 않습니다" 알림.
//! 소스 ① 공식 상태 페이지(status.claude.com, Atlassian Statuspage 공개 JSON) — 5분마다.
//!       claude.ai·Claude API·Claude Code 구성요소가 정상이 아니거나 이들에 걸친 미해결 장애가 있으면 문제.
//!     ② 이 앱의 API 호출(플랜 한도·세션 목록) — 네트워크 오류·5xx 가 연속 NET_FAILS 번이면 문제.
//!       429(요청 과다)는 사용량 API 의 호출 제한일 뿐이라 연결 문제로 보지 않음.
//! 문제가 생기거나 바뀌면 알림 카드(자동 숨김 없음), 풀리면 "복구됨" 카드. 상태 변화는 로그에 남김.
//! ChatGPT(Codex)·Antigravity 는 같은 카드 모양을 쓰되 켠 서비스만 확인(ProvHealth):
//!   - Codex: status.openai.com 의 Codex 구성요소 + wham/usage 호출 연속 실패
//!   - ChatGPT 웹: status.openai.com 의 ChatGPT 웹 구성요소(Conversations·Login 등) — 설정에서 켠 경우만
//!   - Gemini 웹: Google Workspace Status Dashboard(incidents.json)의 Gemini 진행 중 장애 — 설정에서 켠 경우만
//!   - Antigravity: 로컬 언어 서버 /healthz 연속 실패, GetAuthStatus 로 로그인 만료 (공식 상태 페이지 없음)

use crate::i18n;
use crate::oauth::ApiError;
use serde_json::Value;
use std::time::Duration;

/// Claude 공식 상태 페이지 주소(알림 카드 링크·이슈 URL 의 기준).
///
/// # 참조
/// `build_issue` 의 페이지 인자, `main.rs` 의 링크 열기 허용 판정에서 사용.
pub const STATUS_PAGE: &str = "https://status.claude.com";
/// Claude 상태 페이지의 Statuspage 공개 JSON(summary.json) 주소.
///
/// # 참조
/// `fetch_status` 가 조회.
const SUMMARY: &str = "https://status.claude.com/api/v2/summary.json";
/// 상태 페이지 확인 주기(5분).
pub const INTERVAL: Duration = Duration::from_secs(5 * 60);
/// 이 앱이 쓰는 구성요소(상태 페이지 이름 앞부분 기준): claude.ai, Claude API, Claude Code.
///
/// # 참조
/// `watched` 가 사용.
const WATCHED: [&str; 3] = ["claude.ai", "Claude API", "Claude Code"];
/// 연속 실패 몇 번이면 연결 문제로 볼지(3).
///
/// # 참조
/// `Health::net_issue`, `codex_net_issue`, `agy_issue` 가 사용.
const NET_FAILS: u32 = 3;

/// 알릴 문제 1건. key 가 바뀌면 새 알림.
///
/// # 참조
/// `build_issue`, `Health::current`, `ProvHealth::current` 등이 만든다. 알림 카드를 만드는 쪽(`main.rs`)이 소비.
#[derive(Clone, PartialEq, Debug)]
pub struct Issue {
    /// 문제 식별 키("net", "incident:<id>:<status>", "components:<목록>", "auth", "healthz" 등). 바뀌면 새 알림.
    pub key: String,
    /// 알림 카드 제목.
    pub title: String,
    /// 알림 카드 본문(장애 이름·영향 구성요소·실패 횟수 등).
    pub detail: String,
    /// "자세히" 링크 주소(상태 페이지·장애 페이지, Antigravity 는 `antigravity://`).
    pub url: String,
}

/// Claude 연결 상태 — 상태 페이지 결과와 이 앱의 API 연속 실패를 합쳐 현재 문제를 판단한다.
///
/// # 참조
/// `main.rs` 의 앱 상태에 `Mutex<Health>` 로 보관.
#[derive(Default)]
pub struct Health {
    /// 마지막으로 확인한 상태 페이지 문제(없으면 None).
    status: Option<Issue>,
    /// 이 앱의 API 호출 연속 실패 횟수(성공하면 0 으로).
    net_fails: u32,
    /// 가장 최근 연속 실패의 오류 문구(알림 본문에 쓰임).
    last_net_error: String,
}

/// `Health` 의 상태 갱신·조회 메서드.
impl Health {
    /// 상태 페이지 결과를 반영한다.
    ///
    /// # 인자
    /// - `issue`: `fetch_status` 의 문제(없으면 None)
    ///
    /// # 반환
    /// 이전 값과 달라졌으면 true.
    pub fn set_status(&mut self, issue: Option<Issue>) -> bool {
        let changed = self.status != issue;
        self.status = issue;
        changed
    }

    /// 이 앱의 API 호출 결과를 반영한다(429·인증 오류 등은 무시).
    ///
    /// 성공이면 연속 실패 횟수를 0 으로 되돌린다. 네트워크 오류와 HTTP 5xx 는 횟수를 1 올리고 오류 문구를 기억한다.
    /// 그 밖의 오류(429 포함)는 횟수를 건드리지 않고 false 를 돌려준다.
    ///
    /// # 인자
    /// - `res`: 플랜 한도·세션 목록 등 API 호출 결과
    ///
    /// # 반환
    /// 네트워크 문제 여부(`net_issue` 가 Some 인지)가 바뀌었으면 true.
    ///
    /// # 참조
    /// `net_issue` 호출. `oauth::ApiError` 를 구분한다.
    pub fn note_api<T>(&mut self, res: &Result<T, ApiError>) -> bool {
        let before = self.net_issue().is_some();
        match res {
            Ok(_) => self.net_fails = 0,
            Err(e @ ApiError::Network(_)) => {
                self.net_fails += 1;
                self.last_net_error = e.to_string();
            }
            Err(e @ ApiError::Http(c)) if *c >= 500 => {
                self.net_fails += 1;
                self.last_net_error = e.to_string();
            }
            Err(_) => return false,
        }
        before != self.net_issue().is_some()
    }

    /// 연속 실패가 `NET_FAILS` 번 이상이면 "서버 연결 불안정" 문제를 만든다.
    ///
    /// # 반환
    /// 키 "net" 인 `Issue`(상태 페이지 링크). 실패 횟수가 모자라면 None.
    ///
    /// # 참조
    /// `note_api`, `current` 가 호출.
    fn net_issue(&self) -> Option<Issue> {
        (self.net_fails >= NET_FAILS).then(|| Issue {
            key: "net".into(),
            title: i18n::t("health.net.title").into(),
            detail: i18n::tf("health.net.detail", &[("n", &self.net_fails.to_string()), ("err", &self.last_net_error)]),
            url: STATUS_PAGE.into(),
        })
    }

    /// 지금 알릴 문제를 구한다. 상태 페이지에 올라온 장애가 우선, 없으면 이 앱의 연속 실패.
    ///
    /// # 반환
    /// 문제가 있으면 `Some(Issue)`, 없으면 None.
    ///
    /// # 참조
    /// `net_issue` 호출.
    pub fn current(&self) -> Option<Issue> {
        self.status.clone().or_else(|| self.net_issue())
    }
}

/// Claude 상태 페이지를 확인한다.
///
/// 15초 제한으로 summary.json 을 내려받아(`fetch_json`) 해석하고 `issue_from_summary` 로 문제를 뽑는다.
///
/// # 반환
/// 문제가 없으면 `Ok(None)`. 조회·읽기·해석 실패는 `Err`(문자열) — 연결 문제 판단은 `Health::note_api` 쪽 몫.
///
/// # 참조
/// `SUMMARY` 조회, `issue_from_summary` 호출.
pub fn fetch_status() -> Result<Option<Issue>, String> {
    Ok(issue_from_summary(&fetch_json(SUMMARY)?))
}

/// 공개 JSON 주소를 15초 제한으로 내려받아 해석한다.
///
/// # 인자
/// - `url`: 상태 JSON 주소
///
/// # 반환
/// 해석한 JSON. 조회·읽기·해석 실패는 `Err`(문자열).
///
/// # 참조
/// `fetch_status`, `fetch_openai_status`, `fetch_chatgpt_web_status`, `fetch_gemini_status` 가 호출.
fn fetch_json(url: &str) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).build().into();
    let body = agent.get(url).call().map_err(|e| e.to_string())?.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// 상태 페이지 구성요소 이름이 이 앱이 보는 것인지 판정한다.
///
/// # 인자
/// - `_id`: 구성요소 id (Claude 는 이름으로만 판정)
/// - `name`: 구성요소 이름
///
/// # 반환
/// `WATCHED` 의 어느 하나로 시작하면 true.
///
/// # 참조
/// `issue_from_summary` 가 `build_issue` 의 판정 함수로 넘긴다.
fn watched(_id: &str, name: &str) -> bool {
    WATCHED.iter().any(|w| name.starts_with(w))
}

/// Statuspage 구성요소 상태 코드를 한국어 표시로 바꾼다.
///
/// # 인자
/// - `s`: 상태 코드(degraded_performance 등)
///
/// # 반환
/// 성능 저하·일부 장애·주요 장애·점검 중, 그 밖은 "이상".
///
/// # 참조
/// `build_issue` 가 호출.
fn status_label(s: &str) -> &'static str {
    match s {
        "degraded_performance" => i18n::t("health.status.degraded"),
        "partial_outage" => i18n::t("health.status.partial"),
        "major_outage" => i18n::t("health.status.major"),
        "under_maintenance" => i18n::t("health.status.maint"),
        _ => i18n::t("health.status.other"),
    }
}

/// Claude summary.json 에서 문제를 뽑는다.
///
/// `WATCHED` 구성요소만 보고, 구성요소 표시가 없는 장애도 관련 있는 것으로 보는 조건으로 `build_issue` 를 부른다.
///
/// # 인자
/// - `v`: summary.json 을 해석한 JSON
///
/// # 반환
/// 문제가 있으면 `Some(Issue)`, 없으면 None.
///
/// # 참조
/// `build_issue`, `watched` 호출. `fetch_status` 와 시험이 호출.
fn issue_from_summary(v: &Value) -> Option<Issue> {
    build_issue(v, &watched, true, i18n::t("health.claude.title"), STATUS_PAGE)
}

/// Statuspage summary.json 을 문제로 바꾼다. watched(구성요소 이름) 인 것만 본다.
/// empty_relevant: 구성요소 표시가 없는 장애를 관련 있는 것으로 볼지 (Claude 는 예, OpenAI 는 무관한 공지가 많아 아니오)
///
/// 정상(operational)이 아닌 관심 구성요소 목록을 만들고, 미해결 장애 중 관심 구성요소에 걸친 첫 건을 찾는다.
/// 둘 다 없으면 None. 장애가 있으면 키를 "incident:<id>:<status>", 링크를 `<page>/incidents/<id>` 로, 없으면 "components:<목록>" 과 `page` 로 한다.
/// 본문은 장애 이름과 영향 구성요소(예: "<이름> 성능 저하")를 " · " 로 잇는다.
///
/// # 인자
/// - `v`: summary.json JSON
/// - `watched`: 구성요소 판정 함수 (인자: id, 이름)
/// - `empty_relevant`: 구성요소 표시 없는 장애를 관련으로 볼지
/// - `title`: 카드 제목
/// - `page`: 상태 페이지 주소(링크 기준)
///
/// # 반환
/// 문제가 있으면 `Some(Issue)`, 없으면 None.
///
/// # 참조
/// `status_label` 호출. `issue_from_summary`, `issue_from_openai` 가 호출.
fn build_issue(v: &Value, watched: &dyn Fn(&str, &str) -> bool, empty_relevant: bool, title: &str, page: &str) -> Option<Issue> {
    let str_of = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let empty = vec![];
    let bad: Vec<(String, String)> = v
        .get("components")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter(|c| watched(&str_of(c, "id"), &str_of(c, "name")) && str_of(c, "status") != "operational")
        .map(|c| (str_of(c, "name"), str_of(c, "status")))
        .collect();
    // 미해결 장애 중 관련 구성요소에 걸친 것(구성요소 표시가 없으면 관련으로 봄).
    let incident = v.get("incidents").and_then(Value::as_array).unwrap_or(&empty).iter().find(|i| {
        let comps = i.get("components").and_then(Value::as_array);
        match comps {
            None => empty_relevant,
            Some(cs) if cs.is_empty() => empty_relevant,
            Some(cs) => cs.iter().any(|c| watched(&str_of(c, "id"), &str_of(c, "name"))),
        }
    });
    if bad.is_empty() && incident.is_none() {
        return None;
    }
    let (key, name, url) = match incident {
        Some(i) => (
            format!("incident:{}:{}", str_of(i, "id"), str_of(i, "status")),
            str_of(i, "name"),
            format!("{page}/incidents/{}", str_of(i, "id")),
        ),
        None => (
            // 키는 언어와 무관하게(상태 코드 그대로) — 언어를 바꿔도 같은 문제로 본다.
            format!("components:{}", bad.iter().map(|(n, s)| format!("{n} {s}")).collect::<Vec<_>>().join(",")),
            String::new(),
            page.into(),
        ),
    };
    let shown = bad.iter().map(|(n, s)| format!("{n} {}", status_label(s))).collect::<Vec<_>>().join(", ");
    let detail = [name, shown].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
    Some(Issue { key, title: title.into(), detail, url })
}

// ── ChatGPT(Codex)·Antigravity ──────────────────────────────────────────────

/// OpenAI 공식 상태 페이지 주소.
///
/// # 참조
/// `issue_from_openai`, `issue_from_chatgpt_web`, `codex_net_issue` 가 링크로 사용. `main.rs` 의 링크 열기 허용 판정에서도 사용.
pub const OPENAI_STATUS_PAGE: &str = "https://status.openai.com";
/// OpenAI 상태 페이지의 Statuspage 공개 JSON(components.json) 주소.
///
/// summary.json 은 구성요소가 25개에서 잘려 Codex Web·Agent 등이 빠지므로 전체 목록인 components.json 을 쓴다.
///
/// # 참조
/// `fetch_openai_status`, `fetch_chatgpt_web_status` 가 조회.
const OPENAI_COMPONENTS: &str = "https://status.openai.com/api/v2/components.json";

/// OpenAI 상태 페이지를 확인한다 — Codex 구성요소만 본다.
///
/// 15초 제한으로 components.json 을 내려받아 해석하고 `issue_from_openai` 로 문제를 뽑는다.
///
/// # 반환
/// 문제가 없으면 `Ok(None)`. 조회·읽기·해석 실패는 `Err`(문자열).
///
/// # 참조
/// `OPENAI_COMPONENTS` 조회, `issue_from_openai` 호출.
pub fn fetch_openai_status() -> Result<Option<Issue>, String> {
    Ok(issue_from_openai(&fetch_json(OPENAI_COMPONENTS)?))
}

/// OpenAI components.json 에서 Codex 관련 문제를 뽑는다.
///
/// 이름에 "codex" 가 들어간 구성요소와 "CLI"·"VS Code extension" 만 보며, 구성요소 표시 없는 장애는 무시하도록 `build_issue` 를 부른다.
///
/// # 인자
/// - `v`: summary.json 을 해석한 JSON
///
/// # 반환
/// 문제가 있으면 `Some(Issue)`, 없으면 None.
///
/// # 참조
/// `build_issue` 호출. `fetch_openai_status` 와 시험이 호출.
fn issue_from_openai(v: &Value) -> Option<Issue> {
    build_issue(
        v,
        &|_id: &str, n: &str| n.to_ascii_lowercase().contains("codex") || n == "CLI" || n == "VS Code extension",
        false,
        i18n::t("health.codex.title"),
        OPENAI_STATUS_PAGE,
    )
}

/// ChatGPT 웹의 Login 구성요소 id (이름이 같은 API 쪽 Login 01JSM5RT… 과 구분).
const CHATGPT_LOGIN_ID: &str = "01JMXBNJXG1S2D9V65P1ZZTD94";
/// ChatGPT 웹 구성요소 이름(정확히 일치). "Agent" 는 API 의 "Agents" 와 다르다.
const CHATGPT_WEB: [&str; 9] =
    ["Conversations", "Search", "File uploads", "Voice mode", "GPTs", "Image Generation", "Deep Research", "Agent", "Connectors/Apps"];

/// ChatGPT 웹 구성요소인지 판정한다.
///
/// # 인자
/// - `id`: 구성요소 id
/// - `name`: 구성요소 이름
///
/// # 반환
/// ChatGPT 쪽 Login id 이거나 `CHATGPT_WEB` 이름이면 true.
///
/// # 참조
/// `issue_from_chatgpt_web` 이 `build_issue` 에 넘긴다.
fn chatgpt_web_watched(id: &str, name: &str) -> bool {
    id == CHATGPT_LOGIN_ID || CHATGPT_WEB.contains(&name)
}

/// OpenAI components.json 에서 ChatGPT 웹 문제를 뽑는다 (구성요소 상태만 사용).
///
/// # 인자
/// - `v`: components.json 을 해석한 JSON
///
/// # 반환
/// 문제가 있으면 `Some(Issue)`, 없으면 None.
///
/// # 참조
/// `build_issue`, `chatgpt_web_watched` 호출. `fetch_chatgpt_web_status` 와 시험이 호출.
fn issue_from_chatgpt_web(v: &Value) -> Option<Issue> {
    build_issue(v, &chatgpt_web_watched, false, i18n::t("health.chatgpt_web.title"), OPENAI_STATUS_PAGE)
}

/// ChatGPT 웹 서비스 상태를 확인한다 (설정에서 켠 경우만 `main.rs` 가 부름).
///
/// # 반환
/// 문제가 없으면 `Ok(None)`. 조회 실패는 `Err`(문자열).
///
/// # 참조
/// `fetch_json`, `issue_from_chatgpt_web` 호출.
pub fn fetch_chatgpt_web_status() -> Result<Option<Issue>, String> {
    Ok(issue_from_chatgpt_web(&fetch_json(OPENAI_COMPONENTS)?))
}

// ── Gemini 웹 (Google Workspace Status Dashboard) ──────────────────────────

/// Google Workspace Status Dashboard 주소(카드 링크 기준).
///
/// # 참조
/// `issue_from_google` 이 링크로 사용. `main.rs` 의 링크 열기 허용 판정에서도 사용.
pub const GOOGLE_STATUS_PAGE: &str = "https://www.google.com/appsstatus/dashboard";
/// Google 상태 대시보드의 공개 JSON(장애 목록) 주소.
const GOOGLE_INCIDENTS: &str = "https://www.google.com/appsstatus/dashboard/incidents.json";
/// 대시보드의 Gemini 제품 id.
const GEMINI_PRODUCT_ID: &str = "npdyhgECDJ6tB66MxXyo";

/// Google 장애 목록에서 Gemini 의 진행 중 장애를 뽑는다.
///
/// 끝나지 않았고(end 없음·빈 값), Gemini 제품이 걸렸고, 영향이 SERVICE_DISRUPTION·SERVICE_OUTAGE 인 첫 건.
/// SERVICE_INFORMATION 은 사후 공지라 제외한다.
///
/// # 인자
/// - `v`: incidents.json 을 해석한 JSON (배열)
///
/// # 반환
/// 문제가 있으면 키 "incident:<id>" 인 `Some(Issue)`, 없거나 배열이 아니면 None.
///
/// # 참조
/// `fetch_gemini_status` 와 시험이 호출.
fn issue_from_google(v: &Value) -> Option<Issue> {
    let str_of = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let i = v.as_array()?.iter().find(|i| {
        let open = i.get("end").and_then(Value::as_str).unwrap_or("").is_empty();
        let gemini = i
            .get("affected_products")
            .and_then(Value::as_array)
            .is_some_and(|ps| ps.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(GEMINI_PRODUCT_ID)));
        let impact = i.get("status_impact").and_then(Value::as_str).unwrap_or("");
        open && gemini && (impact == "SERVICE_DISRUPTION" || impact == "SERVICE_OUTAGE")
    })?;
    let uri = str_of(i, "uri");
    let url = if uri.is_empty() { GOOGLE_STATUS_PAGE.to_string() } else { format!("{GOOGLE_STATUS_PAGE}/{uri}") };
    let line = str_of(i, "external_desc")
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("**"))
        .map(str::to_string)
        .unwrap_or_default();
    let detail = if line.is_empty() {
        i18n::t("health.gemini.detail").to_string()
    } else if line.chars().count() > 160 {
        format!("{}…", line.chars().take(160).collect::<String>())
    } else {
        line
    };
    Some(Issue { key: format!("incident:{}", str_of(i, "id")), title: i18n::t("health.gemini.title").into(), detail, url })
}

/// Gemini 웹 서비스 상태를 확인한다 (설정에서 켠 경우만 `main.rs` 가 부름).
///
/// # 반환
/// 문제가 없으면 `Ok(None)`. 조회 실패는 `Err`(문자열).
///
/// # 참조
/// `GOOGLE_INCIDENTS` 조회, `issue_from_google` 호출.
pub fn fetch_gemini_status() -> Result<Option<Issue>, String> {
    Ok(issue_from_google(&fetch_json(GOOGLE_INCIDENTS)?))
}

/// 서비스(ChatGPT·Antigravity) 하나의 연결 상태. 켠 서비스만 갱신하고, 바뀐 것만 알린다.
///
/// # 참조
/// `main.rs` 가 서비스 이름별 `HashMap` 으로 보관.
#[derive(Default)]
pub struct ProvHealth {
    /// 공식 상태 페이지 결과.
    status: Option<Issue>,
    /// 이 앱이 직접 본 결과(호출 연속 실패·로컬 서버 상태).
    local: Option<Issue>,
    /// 연속 실패 횟수(Antigravity /healthz).
    fails: u32,
}

/// `ProvHealth` 의 상태 갱신·조회 메서드.
impl ProvHealth {
    /// 공식 상태 페이지 결과를 반영한다.
    ///
    /// # 인자
    /// - `issue`: 상태 페이지에서 뽑은 문제(없으면 None)
    ///
    /// # 반환
    /// 이전 값과 달라졌으면 true.
    pub fn set_status(&mut self, issue: Option<Issue>) -> bool {
        let changed = self.status != issue;
        self.status = issue;
        changed
    }

    /// 이 앱이 직접 본 결과(호출 연속 실패·로컬 서버 상태)를 반영한다.
    ///
    /// # 인자
    /// - `issue`: 로컬에서 판단한 문제(없으면 None)
    ///
    /// # 반환
    /// 이전 값과 달라졌으면 true.
    pub fn set_local(&mut self, issue: Option<Issue>) -> bool {
        let changed = self.local != issue;
        self.local = issue;
        changed
    }

    /// 연속 실패 횟수를 갱신한다. 실패(bad)면 +1, 아니면 0 으로.
    ///
    /// # 인자
    /// - `bad`: 이번 확인이 실패였는지
    ///
    /// # 반환
    /// 새 연속 실패 횟수.
    pub fn count(&mut self, bad: bool) -> u32 {
        self.fails = if bad { self.fails + 1 } else { 0 };
        self.fails
    }

    /// 지금 알릴 문제를 구한다. 상태 페이지가 우선.
    ///
    /// # 반환
    /// 상태 페이지 문제, 없으면 로컬 문제, 둘 다 없으면 None.
    pub fn current(&self) -> Option<Issue> {
        self.status.clone().or_else(|| self.local.clone())
    }
}

/// Codex wham/usage 연속 실패가 `NET_FAILS` 이상이면 문제로 만든다.
///
/// # 인자
/// - `fails`: 연속 실패 횟수
/// - `last_err`: 마지막 오류 문구(본문에 넣음)
///
/// # 반환
/// 키 "net" 인 `Issue`(OpenAI 상태 페이지 링크). 횟수가 모자라면 None.
pub fn codex_net_issue(fails: u32, last_err: &str) -> Option<Issue> {
    (fails >= NET_FAILS).then(|| Issue {
        key: "net".into(),
        title: i18n::t("health.codex_net.title").into(),
        detail: i18n::tf("health.codex_net.detail", &[("n", &fails.to_string()), ("err", last_err)]),
        url: OPENAI_STATUS_PAGE.into(),
    })
}

/// Antigravity 문제를 판단한다: 언어 서버가 떠 있는데 /healthz 가 `NET_FAILS` 번 연속 실패, 또는 로그인이 풀림. 앱이 꺼져 있으면 문제 아님.
///
/// 실행 중이 아니면 None. 로그인 확인 결과가 false 면 키 "auth" 문제를 우선 돌려주고,
/// 그렇지 않고 /healthz 연속 실패가 `NET_FAILS` 이상이면 키 "healthz" 문제를 돌려준다. 링크는 `antigravity://`.
///
/// # 인자
/// - `running`: Antigravity 언어 서버가 실행 중인지
/// - `healthz_fails`: /healthz 연속 실패 횟수
/// - `auth_ok`: GetAuthStatus 로그인 확인 결과(모르면 None)
///
/// # 반환
/// 문제가 있으면 `Some(Issue)`, 없으면 None.
pub fn agy_issue(running: bool, healthz_fails: u32, auth_ok: Option<bool>) -> Option<Issue> {
    if !running {
        return None;
    }
    if auth_ok == Some(false) {
        return Some(Issue {
            key: "auth".into(),
            title: i18n::t("health.agy_auth.title").into(),
            detail: i18n::t("health.agy_auth.detail").into(),
            url: "antigravity://".into(),
        });
    }
    (healthz_fails >= NET_FAILS).then(|| Issue {
        key: "healthz".into(),
        title: i18n::t("health.agy_down.title").into(),
        detail: i18n::tf("health.agy_down.detail", &[("n", &healthz_fails.to_string())]),
        url: "antigravity://".into(),
    })
}

/// 상태 JSON 해석·연속 실패 판정이 맞는지 검증하는 시험 모음.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_to_issue() {
        let ok = json!({ "components": [{ "name": "Claude Code", "status": "operational" }], "incidents": [] });
        assert_eq!(issue_from_summary(&ok), None);

        // 관련 없는 구성요소 장애는 무시.
        let other = json!({ "components": [{ "name": "Claude Console (platform.claude.com)", "status": "major_outage" }], "incidents": [
            { "id": "a", "name": "Console errors", "status": "investigating", "components": [{ "name": "Claude Console (platform.claude.com)" }] }
        ] });
        assert_eq!(issue_from_summary(&other), None);

        let bad = json!({ "components": [{ "name": "Claude Code", "status": "degraded_performance" }], "incidents": [
            { "id": "x1", "name": "Elevated errors", "status": "investigating", "components": [{ "name": "Claude Code" }] }
        ] });
        let i = issue_from_summary(&bad).unwrap();
        assert_eq!(i.key, "incident:x1:investigating");
        assert_eq!(i.detail, "Elevated errors · Claude Code 성능 저하");
        assert_eq!(i.url, "https://status.claude.com/incidents/x1");
    }

    #[test]
    fn openai_only_codex_components() {
        let ok = json!({ "components": [{ "name": "Compliance API", "status": "degraded_performance" }], "incidents": [
            { "id": "z", "name": "Costs API delayed", "status": "investigating", "components": [] }
        ] });
        assert_eq!(issue_from_openai(&ok), None);
        let bad = json!({ "components": [{ "name": "Codex in ChatGPT Desktop", "status": "partial_outage" }], "incidents": [
            { "id": "c1", "name": "Codex errors", "status": "identified", "components": [{ "name": "Codex in ChatGPT Desktop" }] }
        ] });
        let i = issue_from_openai(&bad).unwrap();
        assert_eq!(i.key, "incident:c1:identified");
        assert_eq!(i.url, "https://status.openai.com/incidents/c1");
        assert!(i.detail.contains("일부 장애"));
    }

    #[test]
    fn openai_codex_includes_cli_and_web() {
        let mk = |n: &str, st: &str| json!({ "components": [{ "id": "x", "name": n, "status": st }] });
        assert!(issue_from_openai(&mk("Codex Web", "partial_outage")).is_some());
        assert!(issue_from_openai(&mk("CLI", "degraded_performance")).is_some());
        assert!(issue_from_openai(&mk("Chat Completions", "major_outage")).is_none());
    }

    #[test]
    fn chatgpt_web_components() {
        let mk = |id: &str, n: &str, st: &str| json!({ "components": [{ "id": id, "name": n, "status": st }] });
        assert!(issue_from_chatgpt_web(&mk("01JSM5RTJWHRWDTS6Q604VEW3B", "Login", "major_outage")).is_none());
        assert!(issue_from_chatgpt_web(&mk("01JMXBNJXG1S2D9V65P1ZZTD94", "Login", "major_outage")).is_some());
        assert!(issue_from_chatgpt_web(&mk("a", "Agents", "major_outage")).is_none());
        assert!(issue_from_chatgpt_web(&mk("b", "Agent", "major_outage")).is_some());
        assert!(issue_from_chatgpt_web(&mk("c", "Codex Web", "major_outage")).is_none());
        let i = issue_from_chatgpt_web(&mk("d", "Conversations", "degraded_performance")).unwrap();
        assert_eq!(i.key, "components:Conversations degraded_performance");
        assert_eq!(i.url, OPENAI_STATUS_PAGE);
    }

    #[test]
    fn google_gemini_open_incident() {
        let mk = |end: &str, prod: &str, imp: &str| {
            json!([{ "id": "abc", "uri": "incidents/abc", "end": end, "status_impact": imp,
                "external_desc": "**Summary:**\n\nGemini is slow for some users.\nMore.",
                "affected_products": [{ "id": prod }] }])
        };
        assert_eq!(issue_from_google(&mk("2026-11-20T00:00:00+00:00", GEMINI_PRODUCT_ID, "SERVICE_DISRUPTION")), None);
        let i = issue_from_google(&mk("", GEMINI_PRODUCT_ID, "SERVICE_DISRUPTION")).unwrap();
        assert_eq!(i.key, "incident:abc");
        assert_eq!(i.url, "https://www.google.com/appsstatus/dashboard/incidents/abc");
        assert_eq!(i.detail, "Gemini is slow for some users.");
        assert_eq!(issue_from_google(&mk("", "gmail", "SERVICE_DISRUPTION")), None);
        assert_eq!(issue_from_google(&mk("", GEMINI_PRODUCT_ID, "SERVICE_INFORMATION")), None);
        assert_eq!(issue_from_google(&json!({})), None);
    }

    #[test]
    fn provider_local_issues() {
        assert!(codex_net_issue(2, "x").is_none());
        assert!(codex_net_issue(3, "네트워크 오류").is_some());
        assert!(agy_issue(false, 9, Some(false)).is_none()); // 앱이 꺼져 있으면 문제 아님
        assert!(agy_issue(true, 2, Some(true)).is_none());
        assert_eq!(agy_issue(true, 3, Some(true)).unwrap().key, "healthz");
        assert_eq!(agy_issue(true, 0, Some(false)).unwrap().key, "auth");
        let mut h = ProvHealth::default();
        assert_eq!(h.count(true), 1);
        assert_eq!(h.count(false), 0);
        assert!(h.set_local(codex_net_issue(3, "e")));
        assert!(!h.set_local(codex_net_issue(3, "e"))); // 같은 문제는 바뀐 게 아님
    }

    #[test]
    fn net_failures_need_three_in_a_row_and_ignore_429() {
        let mut h = Health::default();
        let net: Result<(), ApiError> = Err(ApiError::Network("timeout".into()));
        assert!(!h.note_api(&net));
        assert!(!h.note_api(&Err::<(), _>(ApiError::Http(429))));
        assert!(!h.note_api(&net));
        assert!(h.note_api(&Err::<(), _>(ApiError::Http(503))));
        assert!(h.current().is_some());
        assert!(h.note_api(&Ok::<(), ApiError>(())));
        assert!(h.current().is_none());
    }
}

/// 실제 상태 페이지를 조회해 보는 수동 시험(`--ignored` 로만 실행).
#[cfg(test)]
mod live {
    /// 실제 상태 페이지 조회(네트워크 필요): `cargo test live_status -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_status() {
        println!("{:?}", super::fetch_status());
    }

    /// ChatGPT 웹·Gemini 상태 조회(네트워크 필요): `cargo test live_web_status -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_web_status() {
        println!("{:?}", super::fetch_chatgpt_web_status());
        println!("{:?}", super::fetch_gemini_status());
    }
}
