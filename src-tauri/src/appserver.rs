//! Codex app-server JSONL 클라이언트 — `codex app-server` 를 stdio 로 띄워 요청·응답·알림·서버 요청을 주고받는다.
//! 줄 단위 JSON(`jsonrpc` 필드 없음). 줄 분류: `id` 있고 `method` 없음 = 응답 / `method` 만 = 알림 / 둘 다 = 서버 요청.
//! 규칙: 로그에는 method 이름·오류 코드·소요 시간만 남긴다. params·result·error.message 는 대화 내용이 섞일 수 있어 기록 금지.

use crate::jobobj::Job;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 요청 기본 대기 시간.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 시작(initialize) 대기 시간.
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// 시끄러운 알림은 연결 때 끈다(대화 표시에 쓰지 않음).
const OPT_OUT: [&str; 5] = [
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "mcpServer/startupStatus/updated",
];

/// RPC 실패 종류. `Remote` 의 message 는 화면·로그에 쓰지 않는다.
#[derive(Debug, PartialEq, Clone)]
pub enum RpcError {
    /// app-server 가 끝났거나 아직 시작되지 않음.
    Closed,
    /// 대기 시간 초과.
    Timeout,
    /// 서버가 오류로 응답(코드, 메시지).
    Remote { code: i64, message: String },
}

/// 한 줄을 분류한 결과.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// 요청에 대한 응답.
    Response { id: u64, result: Result<Value, RpcError> },
    /// 알림(응답 불필요).
    Notification { method: String, params: Value },
    /// 서버가 우리에게 보낸 요청(승인 등) — `id` 는 그대로 돌려줘야 하므로 Value.
    ServerRequest { id: Value, method: String, params: Value },
    /// JSON 이 아니거나 형식을 알 수 없는 줄.
    Bad,
}

/// 줄 하나를 응답·알림·서버 요청으로 분류한다.
///
/// # 인자
/// - `line`: JSONL 한 줄
///
/// # 반환
/// `Incoming`. 깨진 줄·모르는 모양은 `Bad`.
pub fn classify(line: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return Incoming::Bad };
    if !v.is_object() {
        return Incoming::Bad;
    }
    let id = v.get("id").filter(|i| !i.is_null());
    let method = v.get("method").and_then(Value::as_str);
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match (id, method) {
        (Some(id), None) => {
            let Some(n) = id.as_u64() else { return Incoming::Bad };
            let result = match v.get("error") {
                Some(e) => Err(RpcError::Remote {
                    code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                }),
                None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            };
            Incoming::Response { id: n, result }
        }
        (None, Some(m)) => Incoming::Notification { method: m.to_string(), params },
        (Some(id), Some(m)) => Incoming::ServerRequest { id: id.clone(), method: m.to_string(), params },
        (None, None) => Incoming::Bad,
    }
}

/// 알림·서버 요청 수신 콜백(읽기 스레드에서 호출 — 오래 막지 말고 스레드를 따로 띄울 것).
pub type OnMessage = Arc<dyn Fn(&Arc<AppServer>, Incoming) + Send + Sync>;
/// 프로세스 종료(stdout 닫힘) 콜백.
pub type OnExit = Arc<dyn Fn(&Arc<AppServer>) + Send + Sync>;

/// 실행 중인 app-server 한 개.
pub struct AppServer {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Result<Value, RpcError>>>>,
    alive: AtomicBool,
    pid: u32,
    job: Option<Job>,
}

impl AppServer {
    /// app-server 를 띄워 `initialize` → `initialized` 까지 마친다.
    ///
    /// # 인자
    /// - `exe`: codex 실행 파일
    /// - `on_msg`: 알림·서버 요청 콜백
    /// - `on_exit`: 종료 콜백
    ///
    /// # 반환
    /// 준비된 서버. 실행 실패는 `ErrCode::Spawn`, initialize 실패·시간 초과는 `ErrCode::AppServerExit`.
    pub fn start(exe: &Path, on_msg: OnMessage, on_exit: OnExit) -> Result<Arc<AppServer>, crate::runner::ErrCode> {
        use crate::runner::ErrCode;
        let mut cmd = Command::new(exe);
        cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|_| ErrCode::Spawn)?;
        let job = Job::new();
        if let Some(j) = &job {
            if !j.assign(&child) {
                log::warn!("Codex app-server Job 등록 실패 — 앱 종료 때 직접 끝냄");
            }
        }
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(ErrCode::Spawn);
        };
        let srv = Arc::new(AppServer {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            pid: child.id(),
            job,
        });
        // 읽기 스레드: 줄 분류 → 응답은 대기자에게, 나머지는 콜백.
        let s2 = srv.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match rd.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = String::from_utf8_lossy(&buf);
                if line.trim().is_empty() {
                    continue;
                }
                match classify(&line) {
                    Incoming::Response { id, result } => {
                        if let Some(tx) = s2.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(result);
                        }
                    }
                    Incoming::Bad => log::debug!("app-server 알 수 없는 줄 무시"),
                    other => on_msg(&s2, other),
                }
            }
            s2.alive.store(false, Ordering::SeqCst);
            // 대기 중인 요청은 모두 실패 처리
            for (_, tx) in s2.pending.lock().unwrap().drain() {
                let _ = tx.send(Err(RpcError::Closed));
            }
            let _ = child.wait();
            on_exit(&s2);
        });
        let t0 = std::time::Instant::now();
        let init = srv.request(
            "initialize",
            json!({
                "clientInfo": { "name": "meowffice", "title": "Meowffice", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "optOutNotificationMethods": OPT_OUT }
            }),
            START_TIMEOUT,
        );
        if let Err(e) = init {
            log::warn!("Codex app-server 시작 실패: {}", e.log());
            srv.kill();
            return Err(ErrCode::AppServerExit);
        }
        srv.notify("initialized", Value::Null);
        log::info!("Codex app-server 시작({}ms)", t0.elapsed().as_millis());
        Ok(srv)
    }

    /// 프로세스가 살아 있는지.
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// 프로세스 트리를 끝낸다(Job 이 없으면 pid 로 직접).
    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        match &self.job {
            Some(j) => j.terminate(),
            None => crate::runner::kill_pid(self.pid),
        }
    }

    /// 요청을 보내고 응답을 기다린다.
    ///
    /// # 인자
    /// - `method`: RPC 메서드 이름
    /// - `params`: 인자(Null 이면 생략)
    /// - `timeout`: 대기 시간
    ///
    /// # 반환
    /// 응답 `result`. 실패는 `RpcError`.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        if !self.alive() {
            return Err(RpcError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({ "id": id, "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        if self.write_line(&msg).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcError::Closed);
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                log::debug!("app-server 요청 시간 초과: {method}");
                Err(RpcError::Timeout)
            }
        }
    }

    /// 응답이 필요 없는 알림을 보낸다.
    pub fn notify(&self, method: &str, params: Value) {
        let mut msg = json!({ "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        let _ = self.write_line(&msg);
    }

    /// 서버 요청에 결과로 응답한다(`id` 는 받은 그대로).
    pub fn respond(&self, id: &Value, result: Value) {
        let _ = self.write_line(&json!({ "id": id, "result": result }));
    }

    /// 서버 요청에 오류로 응답한다.
    pub fn respond_err(&self, id: &Value, code: i64, message: &str) {
        let _ = self.write_line(&err_line(id, code, message));
    }

    /// 한 줄 쓰기(요청 간 줄이 섞이지 않게 잠금).
    fn write_line(&self, v: &Value) -> std::io::Result<()> {
        let mut w = self.stdin.lock().unwrap();
        let mut line = v.to_string();
        line.push('\n');
        w.write_all(line.as_bytes())?;
        w.flush()
    }
}

/// 서버 요청에 보낼 오류 응답 줄(`{"id":N,"error":{code,message}}`).
pub fn err_line(id: &Value, code: i64, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}

impl RpcError {
    /// 로그용 요약(내용 없이 종류·코드만).
    pub fn log(&self) -> String {
        match self {
            RpcError::Closed => "closed".into(),
            RpcError::Timeout => "timeout".into(),
            RpcError::Remote { code, .. } => format!("remote {code}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_response_notification_request_and_bad() {
        assert_eq!(classify(r#"{"id":3,"result":{"a":1}}"#), Incoming::Response { id: 3, result: Ok(json!({"a": 1})) });
        assert_eq!(
            classify(r#"{"id":4,"error":{"code":-32600,"message":"x"}}"#),
            Incoming::Response { id: 4, result: Err(RpcError::Remote { code: -32600, message: "x".into() }) }
        );
        assert_eq!(classify(r#"{"method":"turn/started","params":{"threadId":"t"}}"#), Incoming::Notification { method: "turn/started".into(), params: json!({"threadId": "t"}) });
        assert_eq!(
            classify(r#"{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{"itemId":"i"}}"#),
            Incoming::ServerRequest { id: json!("srv-1"), method: "item/commandExecution/requestApproval".into(), params: json!({"itemId": "i"}) }
        );
        assert_eq!(classify(r#"{"id":7,"method":"x"}"#), Incoming::ServerRequest { id: json!(7), method: "x".into(), params: Value::Null });
        assert_eq!(classify("not json"), Incoming::Bad);
        assert_eq!(classify("[1,2]"), Incoming::Bad);
        assert_eq!(classify(r#"{"foo":1}"#), Incoming::Bad);
        assert_eq!(classify(r#"{"id":"abc","result":1}"#), Incoming::Bad);
    }
}
