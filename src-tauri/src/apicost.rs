//! Claude API(Console) 크레딧 사용액 — Anthropic Admin Cost Report (GET /v1/organizations/cost_report).
//! muneo-claude-api-credit-widget 에서 옮김. 남은 선불 잔액을 주는 공개 API 가 없어 월 할당액은 설정에 직접 입력하고,
//! 사용액만 집계(이번 달 UTC 기준: 총액·모델별·일별). Admin 키(sk-ant-admin…)는 DPAPI 로 암호화해 설정에 저장.

use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// cost_report 의 amount 는 센트 단위 소수 문자열이므로 USD = amount / 100 으로 바꾸는 나눗수.
const AMOUNT_DIVISOR: f64 = 100.0;
/// Anthropic Admin Cost Report 엔드포인트 (GET /v1/organizations/cost_report).
const COST_REPORT_URL: &str = "https://api.anthropic.com/v1/organizations/cost_report";
/// 요청 헤더 `anthropic-version` 에 보내는 API 버전.
const API_VERSION: &str = "2023-06-01";
/// 요청 헤더 `user-agent` 값 (앱 이름 + Cargo 패키지 버전).
const USER_AGENT: &str = concat!("muneo-claude-usage-tray/", env!("CARGO_PKG_VERSION"));
/// 같은 키로 이 시간(300초) 안에 다시 부르면 지난 결과를 돌려준다 (새로고침 버튼은 `force` 로 우회).
const CACHE_TTL: Duration = Duration::from_secs(300);

/// Admin Cost Report 호출 실패 종류.
///
/// `Display` 로 사용자에게 보일 한국어 문구를 만든다 (키 값은 문구에 넣지 않는다).
#[derive(Debug)]
pub enum ApiError {
    /// HTTP 401·403 — Admin API 키가 아니거나 권한 없음
    Auth,
    /// 그 밖의 HTTP 상태 코드 오류 (값은 상태 코드)
    Http(u16),
    /// 전송·본문 읽기 실패 (값은 오류 설명)
    Network(String),
    /// 응답이 cost_report 형태가 아니거나 페이지 상한 초과 (값은 설명)
    Parse(String),
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
            ApiError::Auth => write!(f, "인증 실패 — Admin API 키(sk-ant-admin…)가 아니거나 권한이 없습니다"),
            ApiError::Http(c) => write!(f, "HTTP 오류 {c}"),
            ApiError::Network(e) => write!(f, "네트워크 오류: {e}"),
            ApiError::Parse(e) => write!(f, "응답 해석 오류: {e}"),
        }
    }
}

/// 모델별 사용액 한 줄 (USD). `aggregate` 가 만들고 `Report.by_model` 에 담긴다.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ModelCost {
    /// 모델 이름 (없으면 description, 그것도 없으면 "기타")
    pub model: String,
    /// 사용액 (USD)
    pub amount: f64,
}

/// 일별 사용액 한 줄 (USD).
///
/// `date` 는 YYYY-MM-DD(UTC). `Report.daily` 에 날짜 오름차순으로 담긴다.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DayCost {
    /// 날짜 YYYY-MM-DD (UTC)
    pub date: String,
    /// 그날 사용액 (USD)
    pub amount: f64,
}

/// 이번 달(UTC 역월) 사용액 보고서.
///
/// 총액·모델별·일별 합계와 집계 기간을 담아 화면으로 전달한다(Serialize). `report` 가 5분 캐시한다.
#[derive(Serialize, Clone, Debug)]
pub struct Report {
    /// 이번 달 총 사용액 (USD)
    pub total: f64,
    /// 모델별 사용액 (많은 순, 같으면 이름순)
    pub by_model: Vec<ModelCost>,
    /// 일별 사용액 (날짜 오름차순)
    pub daily: Vec<DayCost>,
    /// 집계 기간 시작 (RFC3339, 이번 달 1일 00:00 UTC)
    pub period_start: String,
    /// 집계 기간 끝 (RFC3339, 다음 달 1일 00:00 UTC, 배타)
    pub period_end: String,
}

/// UTC 역월 경계를 구한다.
///
/// 이번 달 1일 00:00 과 다음 달 1일 00:00(12월이면 다음 해 1월) 을 만든다. 끝은 배타.
///
/// # 인자
/// - `now`: 기준 시각 (UTC)
///
/// # 반환
/// (시작, 끝) UTC 시각 쌍.
///
/// # 참조
/// `fetch_report`·`validate` 가 조회 기간으로 사용.
pub fn month_bounds_utc(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).single().expect("월 시작 경계");
    let (ny, nm) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let end = Utc.with_ymd_and_hms(ny, nm, 1, 0, 0, 0).single().expect("월 종료 경계");
    (start, end)
}

/// HTTP 에이전트를 만든다 (전체 제한 시간 30초).
///
/// # 반환
/// `ureq::Agent`.
///
/// # 참조
/// `fetch_report`·`validate` 에서 호출.
fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).build().into()
}

/// cost_report 응답 본문 (페이지 하나). 없는 필드는 기본값으로 읽는다.
#[derive(Deserialize, Default)]
struct CostReport {
    /// 일 단위 버킷 목록
    #[serde(default)]
    data: Vec<Bucket>,
    /// 다음 페이지가 더 있는지
    #[serde(default)]
    has_more: bool,
    /// 다음 페이지 요청에 쓸 토큰 (`page` 쿼리 값)
    #[serde(default)]
    next_page: Option<String>,
}

/// cost_report 의 하루(1d) 버킷.
#[derive(Deserialize, Default)]
struct Bucket {
    /// 버킷 시작 시각 (앞 10자가 날짜로 쓰인다)
    #[serde(default)]
    starting_at: Option<String>,
    /// 버킷 안의 비용 항목들
    #[serde(default)]
    results: Vec<CostItem>,
}

/// cost_report 버킷 안의 비용 항목 하나.
#[derive(Deserialize, Default)]
struct CostItem {
    /// 센트 단위 소수 문자열 (해석 실패 시 그 항목은 건너뜀)
    #[serde(default)]
    amount: String,
    /// 모델 이름 (없을 수 있음)
    #[serde(default)]
    model: Option<String>,
    /// 비용 설명 (모델 이름이 없을 때 대신 쓴다)
    #[serde(default)]
    description: Option<String>,
}

/// cost_report 를 한 번 호출한다.
///
/// x-api-key·anthropic-version·user-agent 헤더와 쿼리를 붙여 GET 하고, 401·403 은 `Auth`, 그 외 상태는 `Http`,
/// 전송 오류는 `Network` 로 바꾼다. 2xx 여도 본문이 cost_report 형태가 아니면 `Parse`(프록시·캡티브 포털 오탐 방지).
///
/// # 인자
/// - `agent`: 재사용할 HTTP 에이전트
/// - `key`: Admin API 키 (로그·오류에 넣지 않음)
/// - `query`: (이름, 값) 쿼리 쌍 목록
///
/// # 반환
/// 해석한 `CostReport`. 실패하면 `ApiError`.
///
/// # 참조
/// `COST_REPORT_URL` 호출. `fetch_report`·`validate` 가 부른다.
fn call(agent: &ureq::Agent, key: &str, query: &[(&str, &str)]) -> Result<CostReport, ApiError> {
    let mut req =
        agent.get(COST_REPORT_URL).header("x-api-key", key).header("anthropic-version", API_VERSION).header("user-agent", USER_AGENT);
    for (k, v) in query {
        req = req.query(*k, *v);
    }
    let mut resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(401)) | Err(ureq::Error::StatusCode(403)) => return Err(ApiError::Auth),
        Err(ureq::Error::StatusCode(c)) => return Err(ApiError::Http(c)),
        Err(e) => return Err(ApiError::Network(e.to_string())),
    };
    let body = resp.body_mut().read_to_string().map_err(|e| ApiError::Network(e.to_string()))?;
    // 2xx 라도 cost_report 형태인지 확인(프록시·캡티브 포털 200 오탐 방지).
    serde_json::from_str(&body).map_err(|e| ApiError::Parse(e.to_string()))
}

/// 버킷 목록을 (총액, 모델별, 일별) 로 합산한다.
///
/// 항목 amount 를 파싱해(실패는 건너뜀) 100 으로 나눠 USD 로 바꾸고, 모델 이름이 없으면 description, 그것도 없으면 "기타" 로 묶는다.
/// `starting_at` 이 있는 버킷은 앞 10자를 날짜로 일별 항목을 만든다. 모델별은 금액 내림차순(같으면 이름순), 일별은 날짜순.
///
/// # 인자
/// - `buckets`: 모든 페이지의 버킷
///
/// # 반환
/// (총액 USD, 모델별 목록, 일별 목록).
///
/// # 참조
/// `AMOUNT_DIVISOR`. `fetch_report` 가 호출.
fn aggregate(buckets: &[Bucket]) -> (f64, Vec<ModelCost>, Vec<DayCost>) {
    let mut total = 0.0;
    let mut by_model: HashMap<String, f64> = HashMap::new();
    let mut daily = Vec::new();
    for b in buckets {
        let mut day = 0.0;
        for it in &b.results {
            let Ok(v) = it.amount.trim().parse::<f64>() else {
                continue;
            };
            let usd = v / AMOUNT_DIVISOR;
            total += usd;
            day += usd;
            let name = it.model.clone().or_else(|| it.description.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "기타".into());
            *by_model.entry(name).or_insert(0.0) += usd;
        }
        if let Some(s) = &b.starting_at {
            daily.push(DayCost { date: s.chars().take(10).collect(), amount: day });
        }
    }
    let mut by_model: Vec<ModelCost> = by_model.into_iter().map(|(model, amount)| ModelCost { model, amount }).collect();
    by_model.sort_by(|a, b| b.amount.total_cmp(&a.amount).then_with(|| a.model.cmp(&b.model)));
    daily.sort_by(|a, b| a.date.cmp(&b.date));
    (total, by_model, daily)
}

/// 이번 달(UTC) 사용액을 서버에서 받아 `Report` 로 만든다.
///
/// `month_bounds_utc` 기간을 1일 버킷·description 그룹·limit 31 로 조회하고, `has_more` 와 `next_page` 가 있으면 다음 페이지를 이어 받는다(최대 24회).
/// 24회를 넘기면 `Parse` 오류.
///
/// # 인자
/// - `key`: Admin API 키
/// - `now`: 기준 시각 (UTC)
///
/// # 반환
/// 집계된 `Report`. 실패하면 `ApiError`.
///
/// # 참조
/// `month_bounds_utc`, `http_agent`, `call`, `aggregate`. `report` 가 부른다.
fn fetch_report(key: &str, now: DateTime<Utc>) -> Result<Report, ApiError> {
    let (start, end) = month_bounds_utc(now);
    let (s, e) = (start.to_rfc3339_opts(SecondsFormat::Secs, true), end.to_rfc3339_opts(SecondsFormat::Secs, true));
    let agent = http_agent();
    let mut buckets = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..24 {
        let mut q = vec![
            ("starting_at", s.as_str()),
            ("ending_at", e.as_str()),
            ("bucket_width", "1d"),
            ("group_by[]", "description"),
            ("limit", "31"),
        ];
        if let Some(p) = &page {
            q.push(("page", p.as_str()));
        }
        let r = call(&agent, key, &q)?;
        buckets.extend(r.data);
        match (r.has_more, r.next_page) {
            (true, Some(np)) => page = Some(np),
            _ => {
                let (total, by_model, daily) = aggregate(&buckets);
                return Ok(Report { total, by_model, daily, period_start: s, period_end: e });
            }
        }
    }
    Err(ApiError::Parse("페이지가 너무 많습니다".into()))
}

/// 마지막 `report` 결과 캐시: (키 해시, 저장 시각, 보고서).
///
/// `Mutex` 로 보호. 키 해시가 같고 `CACHE_TTL` 이내일 때만 재사용한다. 실패 결과는 넣지 않는다.
static CACHE: Mutex<Option<(u64, Instant, Report)>> = Mutex::new(None);

/// 키의 해시값을 구한다 (캐시 비교용, 키 원문을 보관하지 않으려는 용도).
///
/// # 인자
/// - `key`: Admin API 키
///
/// # 반환
/// `DefaultHasher` 해시 u64.
///
/// # 참조
/// `report` 에서 호출.
fn key_hash(key: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    h.finish()
}

/// 이번 달 사용액을 돌려준다.
///
/// `force` 가 아니면 같은 키 해시이고 5분 이내인 `CACHE` 를 그대로 반환한다. 아니면 `fetch_report` 로 받아 캐시에 저장한다. 실패는 캐시하지 않는다.
///
/// # 인자
/// - `key`: Admin API 키
/// - `force`: true 면 캐시를 무시하고 다시 조회 (새로고침 버튼)
///
/// # 반환
/// `Report`. 실패하면 `ApiError`.
///
/// # 참조
/// `key_hash`, `fetch_report`, `CACHE`.
pub fn report(key: &str, force: bool) -> Result<Report, ApiError> {
    let kh = key_hash(key);
    if !force {
        if let Some((k, at, r)) = CACHE.lock().unwrap().as_ref() {
            if *k == kh && at.elapsed() < CACHE_TTL {
                return Ok(r.clone());
            }
        }
    }
    let r = fetch_report(key, Utc::now())?;
    *CACHE.lock().unwrap() = Some((kh, Instant::now(), r.clone()));
    Ok(r)
}

/// 설정의 "검증" 버튼용 — 키로 1건(limit 1)만 조회해 유효한지 확인한다.
///
/// # 인자
/// - `key`: 확인할 Admin API 키
///
/// # 반환
/// 성공하면 Ok(()). 실패하면 `ApiError`.
///
/// # 참조
/// `month_bounds_utc`, `http_agent`, `call`.
pub fn validate(key: &str) -> Result<(), ApiError> {
    let (start, end) = month_bounds_utc(Utc::now());
    let (s, e) = (start.to_rfc3339_opts(SecondsFormat::Secs, true), end.to_rfc3339_opts(SecondsFormat::Secs, true));
    call(&http_agent(), key, &[("starting_at", s.as_str()), ("ending_at", e.as_str()), ("limit", "1")]).map(|_| ())
}

/// `CACHE` 를 비운다 (키를 바꾸거나 지울 때 지난 결과가 남지 않게).
///
/// # 참조
/// `CACHE`.
pub fn clear_cache() {
    *CACHE.lock().unwrap() = None;
}

/// 월 경계 계산과 비용 합산(모델별·일별) 단위 테스트.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_bounds() {
        let (s, e) = month_bounds_utc(Utc.with_ymd_and_hms(2026, 12, 31, 23, 59, 59).unwrap());
        assert_eq!(s, Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap());
        assert_eq!(e, Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap());
    }

    #[test]
    fn aggregates_cents_by_model_and_day() {
        let r: CostReport = serde_json::from_str(
            r#"{"data":[
                {"starting_at":"2026-11-02T00:00:00Z","results":[{"amount":"150.5","model":"claude-opus-5-5"},{"amount":"50","description":"Web search"}]},
                {"starting_at":"2026-11-01T00:00:00Z","results":[{"amount":"100","model":"claude-opus-5-5"},{"amount":"bad"},{"amount":"10"}]}
            ],"has_more":false}"#,
        )
        .unwrap();
        let (total, by_model, daily) = aggregate(&r.data);
        assert!((total - 3.105).abs() < 1e-9);
        assert_eq!(by_model[0].model, "claude-opus-5-5");
        assert!((by_model[0].amount - 2.505).abs() < 1e-9);
        assert_eq!(by_model.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(), ["claude-opus-5-5", "Web search", "기타"]);
        assert_eq!(daily.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), ["2026-11-01", "2026-11-02"]);
    }
}
