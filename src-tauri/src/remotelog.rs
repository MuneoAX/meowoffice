//! 원격 로그 접수 — 설정 → 정보 → 로그 → "보내기" 로 어제+오늘 로그와 증상 설명을 muneo.co.kr 에 올리고 접수번호를 받는다.
//! 서버 규격(2026-11-20, 64번 서버 세션):
//!   POST https://muneo.co.kr/api/claude-tray/logs, JSON, 본문 전체 5 MB 상한(넘으면 413, 6 MB 넘으면 Caddy 가 끊어 빈 502).
//!   201 {id, received_at} / 실패 {error, message} — 400·411(재전송 금지), 413(로그 줄여 1회 재시도), 429·503(Retry-After, 자동 재시도 금지), 5xx.
//!   멱등 키가 없어 응답을 못 받고 다시 보내면 중복 접수 → 자동 재시도는 413 의 1회만.
//! 개인정보: 사용자 홈 경로·사용자 이름은 보내기 전에 가린다(`mask`). 토큰·명령 본문은 원래 로그에 남기지 않는다(applog 규칙).
//! 설치 id: 같은 PC 의 접수를 묶기 위한 무작위 값. 로그 폴더 옆 `install-id` 파일에 한 번 만들어 둔다(개인정보 아님).

use crate::i18n;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// 로그 접수 주소.
const URL: &str = "https://muneo.co.kr/api/claude-tray/logs";
/// 서버의 본문 상한 5 MB 에서 여유 16 KB 를 뺀 값 (직렬화한 본문 전체 기준).
const MAX_BODY: usize = 5 * 1024 * 1024 - 16 * 1024;
/// 증상 설명 최대 글자 수 (서버 규칙과 같음).
const MAX_SYMPTOM: usize = 2000;
/// 앞부분을 잘랐을 때 로그 맨 앞에 붙이는 표시.
const CUT_MARK: &str = "[...앞부분 생략...]\n";

/// 접수 성공 결과 (화면에 그대로 전달).
#[derive(Serialize, Debug)]
pub struct Receipt {
    /// 접수번호 (예: 20261120-7K3F)
    pub id: String,
    /// 서버가 받은 시각 RFC3339
    pub received_at: String,
    /// 크기 상한 때문에 로그 앞부분을 잘랐는가
    pub trimmed: bool,
}

/// 보내기 전 미리보기 (화면의 "보낼 내용 보기").
#[derive(Serialize, Debug)]
pub struct Preview {
    /// 가림 처리한 로그 (화면 표시용, 앞 `PREVIEW_CHARS` 글자까지)
    pub text: String,
    /// 가림 처리한 로그 전체 바이트 수
    pub bytes: usize,
    /// 화면 표시용으로 잘랐는가
    pub cut: bool,
}

/// 미리보기에 보여 줄 최대 글자 수 (화면이 무거워지지 않게).
const PREVIEW_CHARS: usize = 200_000;

/// 로그 텍스트에서 사용자 홈 경로와 사용자 이름을 가린다.
///
/// 홈 경로(역슬래시·슬래시·JSON 이스케이프 꼴 모두, 대소문자 무시)는 `~` 로, 그 밖의 `Users\<이름>`·`Users/<이름>` 은 `Users\<사용자>` 로 바꾼다.
/// 사용자 이름만 따로 나온 곳은 흔한 낱말과 겹칠 수 있어 건드리지 않는다.
///
/// # 인자
/// - `text`: 원본 로그
/// - `home`: 홈 경로 (예: `C:\Users\KF6`). 비어 있으면 홈 가림은 건너뜀
/// - `user`: 사용자 이름 (예: `KF6`). 비어 있으면 이름 가림은 건너뜀
///
/// # 반환
/// 가린 텍스트.
///
/// # 참조
/// `replace_ci`. `collect_masked` 가 호출.
pub fn mask(text: &str, home: &str, user: &str) -> String {
    let mut out = text.to_string();
    if !home.is_empty() {
        let back = home.replace('/', "\\");
        let fwd = back.replace('\\', "/");
        let esc = back.replace('\\', "\\\\");
        for h in [esc, back, fwd] {
            out = replace_ci(&out, &h, "~");
        }
    }
    if !user.is_empty() {
        // "-" 는 Claude 프로젝트 폴더 이름 꼴(C--Users-이름-dev-…)
        for sep in ["\\\\", "\\", "/", "-"] {
            out = replace_ci(&out, &format!("Users{sep}{user}"), &format!("Users{sep}<사용자>"));
        }
    }
    mask_window_titles(&out)
}

/// 컴퓨터 제어 로그의 창 제목(`관리자 권한 창 '제목'`)을 가린다 — 제목에 문서 이름·계정 이름이 들어갈 수 있어서.
///
/// PC 안의 로그 파일은 그대로 두고, 밖으로 보낼 때만 가린다.
///
/// # 인자
/// - `s`: 로그 텍스트
///
/// # 반환
/// 제목을 `<가림>` 으로 바꾼 텍스트 (닫는 따옴표가 없으면 그 줄 끝까지 가림).
///
/// # 참조
/// `mask` 가 호출. 로그를 남기는 곳: 없음(예전 컴퓨터 제어 모듈이 쓰던 자리).
fn mask_window_titles(s: &str) -> String {
    const OPEN: &str = "관리자 권한 창 '";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i + OPEN.len()]);
        out.push_str("<가림>");
        let after = &rest[i + OPEN.len()..];
        let line_end = after.find('\n').unwrap_or(after.len());
        rest = match after[..line_end].rfind('\'') {
            Some(q) => &after[q..],
            None => &after[line_end..],
        };
    }
    out.push_str(rest);
    out
}

/// 대소문자를 무시하고 `pat` 을 모두 `to` 로 바꾼다 (ASCII 대소문자만 같게 봄 — Windows 경로 용도).
///
/// # 인자
/// - `s`: 원본
/// - `pat`: 찾을 문자열 (비면 원본 그대로)
/// - `to`: 바꿀 문자열
///
/// # 반환
/// 바꾼 문자열.
///
/// # 참조
/// `mask` 가 호출.
fn replace_ci(s: &str, pat: &str, to: &str) -> String {
    if pat.is_empty() {
        return s.to_string();
    }
    let (ls, lp) = (s.to_ascii_lowercase(), pat.to_ascii_lowercase());
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(k) = ls[i..].find(&lp) {
        out.push_str(&s[i..i + k]);
        out.push_str(to);
        i += k + lp.len();
    }
    out.push_str(&s[i..]);
    out
}

/// 어제+오늘 로그를 모아 가림 처리한 텍스트를 만든다.
///
/// # 인자
/// - `version`: 머리글에 적을 앱 버전
///
/// # 반환
/// 가린 로그. 로그 폴더를 읽지 못하면 `Err(문구)`.
///
/// # 참조
/// `applog::collect`, `mask`. `preview`·`send` 가 호출.
fn collect_masked(version: &str) -> Result<String, String> {
    let raw = crate::applog::collect(version).map_err(|e| format!("로그를 읽지 못했습니다: {e}"))?;
    Ok(mask_here(&raw))
}

/// 이 PC 의 홈 경로·사용자 이름으로 `mask` 한다.
///
/// # 인자
/// - `text`: 가릴 텍스트 (로그 또는 사용자가 쓴 증상)
///
/// # 반환
/// 가린 텍스트.
///
/// # 참조
/// `mask`. `collect_masked`·`send`(증상) 가 호출.
fn mask_here(text: &str) -> String {
    let home = directories::UserDirs::new().map(|u| u.home_dir().display().to_string()).unwrap_or_default();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    mask(text, &home, &user)
}

/// 보낼 로그 미리보기를 만든다.
///
/// # 인자
/// - `version`: 앱 버전
///
/// # 반환
/// `Preview`. 로그를 읽지 못하면 `Err(문구)`.
///
/// # 참조
/// `collect_masked`. main.rs 의 `log_send_preview` 명령이 호출.
pub fn preview(version: &str) -> Result<Preview, String> {
    let text = collect_masked(version)?;
    let bytes = text.len();
    let cut = text.chars().count() > PREVIEW_CHARS;
    let shown = if cut { text.chars().take(PREVIEW_CHARS).collect() } else { text };
    Ok(Preview { text: shown, bytes, cut })
}

/// 설치 id 를 읽고, 없으면 무작위로 만들어 저장한다.
///
/// 위치: 로그 폴더의 형제 파일 `install-id` (applog::dir 의 상위 폴더). 저장에 실패해도 이번 전송에는 만든 값을 쓴다.
///
/// # 반환
/// 32자 16진수 id.
///
/// # 참조
/// `applog::dir`, `config::new_token`. `send` 가 호출.
fn install_id() -> String {
    let path = crate::applog::dir().with_file_name("install-id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim();
        if !s.is_empty() && s.len() <= 128 {
            return s.to_string();
        }
    }
    let id = crate::config::new_token();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, &id) {
        log::warn!("설치 id 저장 실패: {e}");
    }
    id
}

/// 접수 본문을 만든다. 직렬화한 크기가 `limit` 를 넘으면 로그 앞부분을 잘라 최신 꼬리를 남긴다.
///
/// 넘친 만큼(+ 표시·여유) 앞에서 잘라 글자 경계에 맞추고, 다시 재서 맞을 때까지 되풀이한다(이스케이프로 늘어나는 만큼 반영).
///
/// # 인자
/// - `meta`: version·os·arch·install_id·sent_at 이 든 JSON 객체
/// - `symptom`: 증상 설명 (이미 `MAX_SYMPTOM` 이하로 자른 값)
/// - `log`: 가린 로그
/// - `limit`: 본문 바이트 상한
///
/// # 반환
/// (직렬화한 본문, 로그를 잘랐는가).
///
/// # 참조
/// `send` 가 호출.
fn build_body(meta: &Value, symptom: &str, log: &str, limit: usize) -> (Vec<u8>, bool) {
    let make = |log: &str| {
        let mut v = meta.clone();
        v["schema"] = json!(1);
        v["app"] = json!("muneo-claude-usage-tray");
        v["consent"] = json!(true);
        v["symptom"] = json!(symptom);
        v["log"] = json!(log);
        serde_json::to_vec(&v).unwrap_or_default()
    };
    let mut body = make(log);
    let mut cur = log.to_string();
    let mut trimmed = false;
    while body.len() > limit && !cur.is_empty() {
        let over = body.len() - limit + CUT_MARK.len() + 1024;
        let raw = cur.strip_prefix(CUT_MARK).unwrap_or(&cur);
        let mut k = over.min(raw.len());
        while k < raw.len() && !raw.is_char_boundary(k) {
            k += 1;
        }
        cur = if k >= raw.len() { String::new() } else { format!("{CUT_MARK}{}", &raw[k..]) };
        trimmed = true;
        body = make(&cur);
    }
    (body, trimmed)
}

/// 서버 실패 응답을 사용자 문구로 바꾼다.
///
/// 본문이 `{error, message}` JSON 이면 message 를 쓰고, 429·503 은 Retry-After(초)를 분으로 바꿔 덧붙인다. JSON 이 아니면(502·504 등) 상태별 기본 문구.
///
/// # 인자
/// - `status`: HTTP 상태 코드
/// - `body`: 응답 본문 (비어 있을 수 있음)
/// - `retry_after`: Retry-After 헤더 값(초)
///
/// # 반환
/// 화면에 보일 문구(현재 언어).
///
/// # 참조
/// `send` 가 호출.
fn fail_text(status: u16, body: &str, retry_after: Option<u64>) -> String {
    let msg = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string));
    let base = msg.unwrap_or_else(|| match status {
        400 | 411 => i18n::t("logsend.err.400").into(),
        413 => i18n::t("logsend.err.413").into(),
        429 => i18n::t("logsend.err.429").into(),
        503 => i18n::t("logsend.err.503").into(),
        _ => i18n::tf("logsend.err.other", &[("status", &status.to_string())]),
    });
    match (status, retry_after) {
        (429 | 503, Some(s)) => i18n::tf("logsend.retry_min", &[("base", &base), ("min", &s.div_ceil(60).max(1).to_string())]),
        (429 | 503, None) | (500..=599, _) => i18n::tf("logsend.retry_later", &[("base", &base)]),
        _ => base,
    }
}

/// 본문 하나를 POST 한다.
///
/// HTTP 오류 상태도 본문을 읽기 위해 오류로 바꾸지 않는다(http_status_as_error=false).
/// 제한 시간: 연결 15초, 전체 150초 (느린 회선에서 5 MB 를 올리는 시간 포함). 시간 초과는 서버가 이미 받았을 수 있어
/// 바로 다시 보내지 말라고 안내한다(중복 접수 방지). 전송 오류 원인은 로그에 남긴다.
///
/// # 인자
/// - `version`: User-Agent 에 넣을 앱 버전
/// - `body`: 직렬화한 JSON 본문
///
/// # 반환
/// (상태 코드, 응답 본문, Retry-After 초). 네트워크 오류면 `Err(문구)`.
///
/// # 참조
/// `send` 가 호출.
fn post(version: &str, body: &[u8]) -> Result<(u16, String, Option<u64>), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_global(Some(Duration::from_secs(150)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .post(URL)
        .header("content-type", "application/json")
        .header("user-agent", &format!("muneo-claude-usage-tray/{version}"))
        .send(body)
        .map_err(|e| {
            log::warn!("로그 보내기 전송 오류: {e}");
            match e {
                ureq::Error::Timeout(_) => {
                    i18n::t("logsend.timeout").to_string()
                }
                _ => i18n::t("logsend.network").to_string(),
            }
        })?;
    let status = resp.status().as_u16();
    let retry = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    Ok((status, text, retry))
}

/// 로그를 접수 서버에 보낸다.
///
/// 동의가 없으면 보내지 않는다. 증상은 2000자까지. 본문이 `MAX_BODY` 를 넘으면 로그 앞부분을 잘라 맞추고,
/// 서버가 413 을 주면 상한을 절반으로 줄여 한 번만 다시 보낸다. 그 밖의 실패는 자동 재시도하지 않는다(서버에 멱등 키가 없어 중복 접수됨).
///
/// # 인자
/// - `version`: 앱 버전
/// - `symptom`: 사용자가 쓴 증상 (빈 문자열 가능)
/// - `consent`: 개인정보 동의 체크 여부
///
/// # 반환
/// 성공하면 `Receipt`, 실패하면 화면에 보일 문구.
///
/// # 참조
/// `collect_masked`, `install_id`, `build_body`, `post`, `fail_text`. main.rs 의 `send_log` 명령이 호출.
pub fn send(version: &str, symptom: &str, consent: bool) -> Result<Receipt, String> {
    if !consent {
        return Err(i18n::t("logsend.consent").into());
    }
    let log_text = collect_masked(version)?;
    // 증상에 붙여 넣은 경로도 로그와 똑같이 가린 뒤 자른다
    let symptom: String = mask_here(symptom.trim()).chars().take(MAX_SYMPTOM).collect();
    let meta = json!({
        "version": version,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "install_id": install_id(),
        "sent_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    let mut limit = MAX_BODY;
    let mut retried = false;
    loop {
        let (body, trimmed) = build_body(&meta, &symptom, &log_text, limit);
        let (status, text, retry) = post(version, &body).inspect_err(|e| log::warn!("로그 보내기 실패: {e}"))?;
        if status == 201 {
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let received_at = v.get("received_at").and_then(Value::as_str).unwrap_or("").to_string();
            log::info!("로그 보냄: 접수번호 {id}, 본문 {}바이트{}", body.len(), if trimmed { ", 앞부분 생략" } else { "" });
            return Ok(Receipt { id, received_at, trimmed });
        }
        if status == 413 && !retried {
            retried = true;
            limit /= 2;
            log::warn!("로그 보내기: 413 — 로그를 줄여 한 번 더 보냄");
            continue;
        }
        let msg = fail_text(status, &text, retry);
        log::warn!("로그 보내기 실패: HTTP {status} — {msg}");
        return Err(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_home_and_user() {
        let s = r#"설정 C:\Users\KF6\AppData\Roaming\x · c:/users/kf6/a · "C:\\Users\\KF6\\b" · D:\Users\KF6\c · KF6 그대로"#;
        let m = mask(s, r"C:\Users\KF6", "KF6");
        assert!(!m.contains(r"C:\Users\KF6"));
        assert!(m.contains(r"~\AppData\Roaming\x"));
        assert!(m.contains("~/a"));
        assert!(m.contains(r#""~\\b""#));
        assert!(m.contains(r"D:\Users\<사용자>\c"));
        assert!(m.contains("KF6 그대로"));
        let p = mask("프로젝트 C--Users-KF6-dev-app", r"C:\Users\KF6", "KF6");
        assert!(p.contains("C--Users-<사용자>-dev-app"));
    }

    #[test]
    fn mask_admin_window_title() {
        let s = "a\n12:00 WARN 컴퓨터 제어 입력 차단(관리자 권한 창 '급여명세서.xlsx - 김철수'): left_click\nb";
        let m = mask(s, "", "");
        assert!(m.contains("관리자 권한 창 '<가림>'): left_click"));
        assert!(!m.contains("김철수"));
        assert!(m.ends_with("\nb"));
        let open = mask("관리자 권한 창 '끝 따옴표 없음\n다음 줄", "", "");
        assert_eq!(open, "관리자 권한 창 '<가림>\n다음 줄");
    }

    #[test]
    fn body_fits_and_keeps_tail() {
        let meta = json!({ "version": "0.4.4", "os": "windows", "arch": "x86_64", "install_id": "a", "sent_at": "2026-11-20T00:00:00Z" });
        let log: String = (0..20_000).map(|i| format!("줄 {i} \"따옴표\" \\ 역슬래시\n")).collect();
        let (body, trimmed) = build_body(&meta, "증상", &log, 100_000);
        assert!(trimmed);
        assert!(body.len() <= 100_000);
        let v: Value = serde_json::from_slice(&body).unwrap();
        let l = v["log"].as_str().unwrap();
        assert!(l.starts_with(CUT_MARK));
        assert!(l.ends_with("줄 19999 \"따옴표\" \\ 역슬래시\n"));
        assert_eq!(v["consent"], json!(true));
        assert_eq!(v["schema"], json!(1));
        let (small, t2) = build_body(&meta, "", "짧은 로그", 100_000);
        assert!(!t2);
        assert_eq!(serde_json::from_slice::<Value>(&small).unwrap()["log"], json!("짧은 로그"));
    }

    /// 실제 서버에 1건 보낸다 (개발 PC 연동 확인용, 수동 실행: cargo test live_send -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn live_send() {
        let r = send(env!("CARGO_PKG_VERSION"), "연동 시험 (개발 PC, 클라이언트 구현 확인)", true);
        println!("{r:?}");
        assert!(r.is_ok());
    }

    #[test]
    fn fail_messages() {
        assert_eq!(fail_text(400, r#"{"error":"consent_required","message":"동의가 필요합니다"}"#, None), "동의가 필요합니다");
        assert!(fail_text(429, r#"{"error":"rate_limited","message":"너무 잦습니다"}"#, Some(600)).contains("약 10분 뒤"));
        assert!(fail_text(502, "", None).contains("HTTP 502"));
        assert!(fail_text(503, "<html>", Some(30)).contains("약 1분 뒤"));
    }
}
