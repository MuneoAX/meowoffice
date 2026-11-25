//! `--hook <codex|agy> <이벤트>` 중계 모드: Codex·Antigravity 가 훅으로 실행하는 이 exe 의 가벼운 진입점.
//! Tauri·창·트레이·단일 인스턴스 검사 없이(main 맨 앞에서 분기) stdin JSON 을 앱의 로컬 권한 서버로 보내고,
//! 돌려받은 응답 JSON 을 stdout 에 그대로 출력한 뒤 종료한다.
//! 포트·토큰은 명령줄이 아니라 설정 파일에서 읽는다(명령 문자열을 고정해 Codex 신뢰가 풀리지 않게).
//! 실패 시 열림: 앱이 꺼져 있거나 연동이 꺼져 있거나 응답이 없으면 서비스가 원래 하던 대로 진행하는 중립 응답을 낸다
//! (provider_hook::fail_open) — 에이전트를 절대 막지 않는다. 릴리스 빌드는 windows 서브시스템이라 콘솔 창이 뜨지 않는다.

use crate::config::Config;
use crate::provider_hook::{fail_open, Event, Provider};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// 앱에 연결하는 한도(400ms).
///
/// 앱이 꺼져 있으면 즉시 거부되지만 방화벽 등으로 지연되는 경우도 짧게 끊는다.
///
/// # 참조
/// `post` 가 사용.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
/// 권한 카드 응답 대기 한도(116초).
///
/// 서버 `permit::WAIT` 110초 + 여유이며 훅 timeout 120초 미만.
///
/// # 참조
/// `relay` 가 Stop 이 아닌 이벤트에 사용.
const PERMIT_READ: Duration = Duration::from_secs(116);
/// 즉시 응답하는 이벤트(Stop)의 읽기 한도(3초).
///
/// # 참조
/// `relay` 가 Stop 이벤트에 사용.
const QUICK_READ: Duration = Duration::from_secs(3);
/// 표준 입력에서 읽는 최대 바이트(1 MiB).
///
/// # 참조
/// `run` 이 사용.
const MAX_STDIN: u64 = 1 << 20;

/// `--hook` 중계 모드 진입점.
///
/// 첫 인자를 서비스(`Provider`), 둘째 인자를 이벤트(`Event`)로 해석하고, 알 수 없으면 아무것도 출력하지 않고 0 을 돌려준다.
/// 표준 입력을 최대 `MAX_STDIN` 바이트 읽어 `relay` 로 응답을 얻은 뒤 표준 출력에 그대로 쓰고 비운다.
///
/// # 인자
/// - `args`: `--hook` 뒤의 인자들(서비스, 이벤트)
///
/// # 반환
/// 프로세스 종료 코드(항상 0).
///
/// # 참조
/// `provider_hook::Provider::from_arg`, `provider_hook::Event::from_arg`, `config::load_readonly`, `relay` 호출. `main.rs` 가 맨 앞에서 호출.
pub fn run(args: &[String]) -> i32 {
    let provider = args.first().and_then(|a| Provider::from_arg(a));
    let event = provider.and_then(|p| args.get(1).and_then(|e| Event::from_arg(p, e)));
    let (Some(p), Some(e)) = (provider, event) else {
        return 0; // 알 수 없는 인자: 아무것도 출력하지 않음(서비스가 알아서)
    };
    let mut input = String::new();
    let _ = std::io::stdin().lock().take(MAX_STDIN).read_to_string(&mut input);
    let out = relay(p, e, &input, crate::config::load_readonly().as_ref());
    let mut so = std::io::stdout().lock();
    let _ = so.write_all(out.as_bytes());
    let _ = so.flush();
    0
}

/// 설정에서 이 서비스 연동이 켜져 있을 때의 (포트, 토큰)을 꺼낸다.
///
/// Codex 는 `codex_hook`, Antigravity 는 `agy_hook` 가 켜져 있고 `hook_token` 이 비어 있지 않아야 한다.
///
/// # 인자
/// - `p`: 서비스
/// - `c`: 설정
///
/// # 반환
/// `Some((hook_port, hook_token))`. 연동이 꺼져 있거나 토큰이 비어 있으면 None.
///
/// # 참조
/// `relay` 가 호출.
fn endpoint(p: Provider, c: &Config) -> Option<(u16, &str)> {
    let on = match p {
        Provider::Codex => c.codex_hook,
        Provider::Agy => c.agy_hook,
    };
    (on && !c.hook_token.is_empty()).then_some((c.hook_port, c.hook_token.as_str()))
}

/// stdin 원문을 앱의 로컬 권한 서버로 보내고, 서비스에 출력할 응답을 만든다. 어떤 실패든 fail_open.
///
/// 설정에서 연동 엔드포인트를 얻지 못하면 바로 중립 응답이다. 얻으면 Stop 이벤트는 `QUICK_READ`, 그 밖은 `PERMIT_READ` 를 읽기 한도로 하여
/// `/muneo-provider/<서비스>/<이벤트>` 로 `post` 한다. 응답 본문이 없거나 공백뿐이면 중립 응답을 쓴다.
///
/// # 인자
/// - `p`: 서비스
/// - `e`: 이벤트
/// - `input`: 서비스가 stdin 으로 준 JSON 원문
/// - `cfg`: 설정(None 이면 중립 응답)
///
/// # 반환
/// 서비스에 그대로 출력할 응답 문자열.
///
/// # 참조
/// `endpoint`, `post`, `provider_hook::fail_open` 호출. `run` 이 호출.
pub fn relay(p: Provider, e: Event, input: &str, cfg: Option<&Config>) -> String {
    let neutral = || fail_open(p, e).to_string();
    let Some((port, token)) = cfg.and_then(|c| endpoint(p, c)) else { return neutral() };
    let read = if e == Event::Stop { QUICK_READ } else { PERMIT_READ };
    match post(port, token, &format!("/muneo-provider/{}/{}", p.arg(), e.arg()), input.as_bytes(), read) {
        Some(body) if !body.trim().is_empty() => body,
        _ => neutral(),
    }
}

/// 최소 HTTP POST(루프백 전용). 200 응답의 본문만 반환한다.
///
/// 127.0.0.1:`port` 에 `CONNECT_TIMEOUT` 안에 연결해 읽기·쓰기 제한(읽기는 `read_timeout`, 쓰기 5초)을 걸고,
/// `x-muneo-token` 헤더와 JSON 본문을 가진 HTTP/1.1 요청을 보낸 뒤 연결이 닫힐 때까지 읽는다.
///
/// # 인자
/// - `port`: 앱 로컬 서버 포트
/// - `token`: 검증 토큰(헤더로 전달)
/// - `path`: 요청 경로
/// - `body`: 요청 본문 바이트
/// - `read_timeout`: 응답 읽기 한도
///
/// # 반환
/// 상태가 `HTTP/1.1 200` 일 때의 본문. 연결·입출력 실패, 응답 형식 오류, 200 이 아닌 상태는 None.
///
/// # 참조
/// `relay` 가 호출.
fn post(port: u16, token: &str, path: &str, body: &[u8], read_timeout: Duration) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    s.set_read_timeout(Some(read_timeout)).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-muneo-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).ok()?;
    s.write_all(body).ok()?;
    s.flush().ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then(|| rest.to_string())
}

/// `relay` 의 실패 시 열림과 요청 전달을 검증하는 시험 모음.
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::time::Instant;

    fn cfg(port: u16, on: bool) -> Config {
        Config { codex_hook: on, agy_hook: on, hook_port: port, hook_token: "tok".into(), ..Config::default() }
    }

    /// 항상 연결이 거부되는 포트: 0 번 포트로는 연결할 수 없다(병렬 시험이 임시 포트를 재사용해도 영향 없음).
    fn dead_port() -> u16 {
        0
    }

    #[test]
    fn fail_open_when_app_off_or_disabled_or_no_config() {
        let t = Instant::now();
        let c = cfg(dead_port(), true);
        assert_eq!(relay(Provider::Codex, Event::Permission, "{}", Some(&c)), "");
        assert_eq!(relay(Provider::Agy, Event::PreTool, "{}", Some(&c)), r#"{"decision":"ask"}"#);
        assert_eq!(relay(Provider::Agy, Event::Stop, "{}", Some(&c)), "{}");
        assert_eq!(relay(Provider::Agy, Event::PreTool, "{}", Some(&cfg(dead_port(), false))), r#"{"decision":"ask"}"#);
        assert_eq!(relay(Provider::Agy, Event::PreTool, "{}", None), r#"{"decision":"ask"}"#);
        // 거부된 연결 한 번이 Windows 에선 연결 제한(400ms)까지 걸릴 수 있음: 최대 4번 + 여유
        assert!(t.elapsed() < Duration::from_secs(5), "실패 시 열림이 느림: {:?}", t.elapsed());
    }

    #[test]
    fn fail_open_on_server_error_or_empty_body() {
        for (status, body) in [("500 Internal Server Error", "boom"), ("200 OK", ""), ("401 Unauthorized", "{}")] {
            let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = l.local_addr().unwrap().port();
            let reply = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let h = std::thread::spawn(move || {
                let (mut s, _) = l.accept().unwrap();
                let mut b = [0u8; 4096];
                let _ = s.read(&mut b);
                s.write_all(reply.as_bytes()).unwrap();
            });
            assert_eq!(relay(Provider::Agy, Event::PreTool, "{}", Some(&cfg(port, true))), r#"{"decision":"ask"}"#, "{status}");
            h.join().unwrap();
        }
    }

    #[test]
    fn relays_request_and_prints_server_body() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            // 머리와 본문이 따로 올 수 있어 Content-Length 만큼 다 읽는다
            let mut raw = Vec::new();
            let mut b = [0u8; 4096];
            let req = loop {
                let n = s.read(&mut b).unwrap();
                raw.extend_from_slice(&b[..n]);
                let t = String::from_utf8_lossy(&raw).to_string();
                if let Some((head, rest)) = t.split_once("\r\n\r\n") {
                    let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)));
                    if n == 0 || rest.len() >= len.unwrap_or(0) {
                        break t;
                    }
                } else if n == 0 {
                    break t;
                }
            };
            let body = crate::provider_hook::allow_body(Provider::Codex, Event::Permission);
            write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            req
        });
        let out = relay(Provider::Codex, Event::Permission, r#"{"tool_name":"Bash"}"#, Some(&cfg(port, true)));
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /muneo-provider/codex/permission HTTP/1.1"), "{req}");
        assert!(req.to_lowercase().contains("x-muneo-token: tok"));
        assert!(req.ends_with(r#"{"tool_name":"Bash"}"#));
        assert!(out.contains(r#""behavior":"allow""#), "{out}");
    }
}
