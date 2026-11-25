//! Claude 어댑터 — 턴마다 `claude -p` 한 개를 띄우고 stream-json 출력을 공통 이벤트(`AgentEvent`)로 바꾼다(설계서 3.4).
//! - 프롬프트는 stdin 으로 쓰고 닫는다(인자로 넘기지 않음: 길이·인용 문제, 명령줄 노출).
//! - 승인: 실행 때만 `--settings chat-hooks.json` 으로 PermissionRequest HTTP 훅(`/muneo-chat-permission`)을 붙인다. 사용자 settings.json 은 건드리지 않는다.
//! - 중단: 프로세스 트리 강제 종료(Job Object). 재개는 `--resume` 이 안전하다(미완 턴은 다음 입력이 이어받음).
//! - 규칙: 대화 본문·도구 입출력·stderr 내용·경로 전체는 로그에 넣지 않는다(`runner::log_line` 요약만).

use crate::jobobj::Job;
use crate::runner::{tool_summary, AgentEvent, ErrCode, Mode, Outcome, Runner, TurnCtl};
use crate::{chatlog, config};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 한 턴을 돌리는 데 필요한 값(세션에서 복사).
pub struct Plan {
    /// 고양이 열쇠
    pub key: String,
    /// 서비스 세션 id (`--session-id`/`--resume` 대상)
    pub id: String,
    /// 작업 폴더
    pub cwd: PathBuf,
    pub mode: Mode,
    /// 갈라지기 원본 세션 id (`fork` 일 때만 의미)
    pub resume: Option<String>,
    /// 첫 턴이 원본에서 갈라져 나옴(`--resume <원본> --fork-session --session-id <새 id>`)
    pub fork: bool,
    /// 기록이 이미 있음(이후 턴은 `--resume <id>`)
    pub started: bool,
    /// 폴더 안 설정·MCP 를 불러도 되는지(10.3). false 면 `--setting-sources user --strict-mcp-config`
    pub trusted: bool,
    pub turn: String,
    pub text: String,
    pub ctl: Arc<TurnCtl>,
}

/// claude 실행 파일(Windows: `main::find_claude`, 그 밖: PATH 의 `claude`).
pub fn claude_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        crate::find_claude()
    }
    #[cfg(not(windows))]
    {
        let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.iter().map(|d| d.join("claude")).find(|p| p.is_file())
    }
}

/// 채팅 전용 훅 설정 파일 경로(앱 데이터 폴더).
pub fn hooks_path() -> PathBuf {
    crate::applog::dir().with_file_name("chat-hooks.json")
}

/// `claude -p` 인자 목록(설계서 3.4). 프롬프트는 포함하지 않는다(stdin).
///
/// # 인자
/// - `p`: 턴 계획
/// - `settings`: 채팅 전용 훅 설정 파일 경로
///
/// # 반환
/// 인자 배열. 새 세션 `--session-id`, 이어가기 `--resume`, 갈라지기 `--resume <원본> --fork-session --session-id <새 id>`.
/// 모드 `Ask`=manual · `AcceptEdits`=acceptEdits · `ReadOnly`=plan · `UserDefault`=생략. 미신뢰 폴더는 `--setting-sources user --strict-mcp-config`.
pub fn args_for(p: &Plan, settings: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    if p.fork {
        a.extend(["--resume".into(), p.resume.clone().unwrap_or_default(), "--fork-session".into(), "--session-id".into(), p.id.clone()]);
    } else if p.started {
        a.extend(["--resume".into(), p.id.clone()]);
    } else {
        a.extend(["--session-id".into(), p.id.clone()]);
    }
    let mode = match p.mode {
        Mode::Ask => Some("manual"),
        Mode::AcceptEdits => Some("acceptEdits"),
        Mode::ReadOnly => Some("plan"),
        Mode::UserDefault => None,
    };
    if let Some(m) = mode {
        a.extend(["--permission-mode".into(), m.into()]);
    }
    a.extend(["--settings".into(), settings.to_string_lossy().to_string()]);
    if !p.trusted {
        a.extend(["--setting-sources".into(), "user".into(), "--strict-mcp-config".into()]);
    }
    a
}

/// 채팅 전용 훅 설정을 쓴다: PermissionRequest → `http://127.0.0.1:<port>/muneo-chat-permission`(헤더 `x-muneo-token`, timeout 1800초).
///
/// # 인자
/// - `path`: 쓸 파일
/// - `port`: 앱 로컬 서버 포트
/// - `token`: 검증 토큰(파일에 들어가지만 로그에는 남기지 않음)
pub fn write_chat_hooks(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let v = json!({
        "hooks": {
            "PermissionRequest": [{
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}{}", crate::permit::CHAT_PATH),
                    "headers": { "x-muneo-token": token },
                    "timeout": 1800
                }]
            }]
        }
    });
    std::fs::write(path, serde_json::to_string_pretty(&v).unwrap_or_default())
}

/// 앱 토큰을 돌려준다(비어 있으면 만들어 설정에 저장 — 설정 파일을 못 읽은 상태면 저장하지 않고 빈 값).
fn ensure_token() -> String {
    let l = config::load();
    let mut c = l.config;
    if c.hook_token.is_empty() && l.note.is_none() {
        c.hook_token = config::new_token();
        if let Err(e) = config::save(&l.path, &c) {
            log::warn!("채팅 훅 토큰 저장 실패: {e}");
            return String::new();
        }
    }
    c.hook_token
}

/// 오류 문구·분류 문자열에서 인증·한도 오류를 알아본다(내용은 로그에 남기지 않음).
///
/// # 반환
/// 인증 만료면 `Auth`, 사용 한도면 `Limit`, 모르면 None.
pub fn classify_error(s: &str) -> Option<ErrCode> {
    let t = s.to_lowercase();
    if ["authentication", "unauthorized", "invalid api key", "please run /login", "oauth token has expired", "not logged in"].iter().any(|k| t.contains(k)) {
        Some(ErrCode::Auth)
    } else if ["usage limit", "rate limit", "rate_limit", "limit reached", "credit balance", "quota"].iter().any(|k| t.contains(k)) {
        Some(ErrCode::Limit)
    } else {
        None
    }
}

/// stream-json 줄 해석기. 조각(`stream_event`)의 항목 id 를 나중의 확정 본문(`assistant`)과 맞추려고 약간의 상태를 가진다.
pub struct LineParser {
    turn: String,
    /// 지금 메시지 id(`message_start`·`assistant` 에서 갱신)
    msg: String,
    /// 조각을 보낸 텍스트 항목 id 들(확정 본문이 같은 항목으로 대체되도록 순서대로 소비)
    pending: Vec<String>,
    /// 재시도·오류 줄에서 본 오류 분류 문자열(최종 결과 분류에 합침)
    retry_err: String,
    /// `system/init` 에서 읽은 세션 id(실행기가 꺼내 `mark_started` 에 씀)
    pub init_session: Option<String>,
}

impl LineParser {
    /// 해석기. `turn` 은 `TurnStart`/`TurnEnd` 에 넣을 턴 id.
    pub fn new(turn: &str) -> LineParser {
        LineParser { turn: turn.to_string(), msg: "m".into(), pending: vec![], retry_err: String::new(), init_session: None }
    }

    /// 한 줄을 공통 이벤트들로 바꾼다. 깨진 JSON·모르는 줄은 빈 목록(종류 이름만 debug 로그).
    pub fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return vec![] };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let sub = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        // 하위 에이전트 줄은 표시하지 않는다(부모 도구 항목이 대표)
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return vec![];
        }
        match (kind, sub) {
            ("system", "init") => {
                self.init_session = v.get("session_id").and_then(Value::as_str).map(str::to_string);
                vec![AgentEvent::TurnStart { turn: self.turn.clone() }]
            }
            ("system", "api_retry") => {
                if let Some(e) = v.get("error").and_then(Value::as_str) {
                    self.retry_err = e.to_string();
                }
                vec![AgentEvent::Notice { code: "retry".into() }]
            }
            ("system", "permission_denied") => vec![AgentEvent::Notice { code: "denied".into() }],
            ("stream_event", _) => self.stream_event(&v),
            ("assistant", _) => self.assistant(&v),
            ("user", _) => v
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .map(|b| AgentEvent::ToolEnd {
                            item: b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                            ok: !b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                            summary: chatlog::result_text(b.get("content").unwrap_or(&Value::Null)),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            ("result", _) => self.result(&v),
            _ => {
                log::debug!("claude 알 수 없는 줄: {kind}/{sub}");
                vec![]
            }
        }
    }

    /// 조각 줄: `message_start` 로 메시지 id 를 기억하고 `text_delta` 만 `Delta` 로.
    fn stream_event(&mut self, v: &Value) -> Vec<AgentEvent> {
        let e = v.get("event").unwrap_or(&Value::Null);
        match e.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(id) = e.pointer("/message/id").and_then(Value::as_str) {
                    self.msg = id.to_string();
                }
                vec![]
            }
            Some("content_block_delta") if e.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") => {
                let text = e.pointer("/delta/text").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                let item = format!("{}:{}", self.msg, e.get("index").and_then(Value::as_u64).unwrap_or(0));
                if !self.pending.contains(&item) {
                    self.pending.push(item.clone());
                }
                vec![AgentEvent::Delta { item, text: text.to_string() }]
            }
            _ => vec![],
        }
    }

    /// 확정 줄: `text` 블록 → `Message`(조각 항목과 같은 id 로 대체), `tool_use` 블록 → `ToolStart`.
    fn assistant(&mut self, v: &Value) -> Vec<AgentEvent> {
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            self.retry_err = e.to_string();
        }
        if let Some(id) = v.pointer("/message/id").and_then(Value::as_str) {
            self.msg = id.to_string();
        }
        let mut out = vec![];
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else { return out };
        for (i, b) in blocks.iter().enumerate() {
            match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() {
                        continue;
                    }
                    let item = if self.pending.is_empty() { format!("{}:{i}", self.msg) } else { self.pending.remove(0) };
                    out.push(AgentEvent::Message { item, text: text.to_string() });
                }
                Some("tool_use") => {
                    let (kind, title, detail) = tool_summary(b.get("name").and_then(Value::as_str).unwrap_or(""), b.get("input").unwrap_or(&Value::Null));
                    out.push(AgentEvent::ToolStart { item: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(), kind, title, detail });
                }
                _ => {}
            }
        }
        out
    }

    /// 마지막 줄: `Usage` + `TurnEnd`. `subtype=="success"` 이고 오류가 아니면 done, 아니면 failed(인증·한도는 분류).
    fn result(&mut self, v: &Value) -> Vec<AgentEvent> {
        let mut out = vec![];
        if v.get("permission_denials").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            out.push(AgentEvent::Notice { code: "denied".into() });
        }
        let u = v.get("usage").unwrap_or(&Value::Null);
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let (input, cached) = (n("input_tokens") + n("cache_creation_input_tokens"), n("cache_read_input_tokens"));
        let window = v.get("modelUsage").and_then(Value::as_object).and_then(|m| m.values().find_map(|x| x.get("contextWindow").and_then(Value::as_f64))).filter(|w| *w > 0.0);
        out.push(AgentEvent::Usage {
            input,
            output: n("output_tokens"),
            cached,
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            context_pct: window.map(|w| ((input + cached) as f64 / w * 100.0).min(100.0)),
        });
        let failed = v.get("is_error").and_then(Value::as_bool).unwrap_or(false) || v.get("subtype").and_then(Value::as_str).unwrap_or("success") != "success";
        let error = failed.then(|| {
            let hay = format!("{} {} {}", v.get("result").and_then(Value::as_str).unwrap_or(""), v.get("subtype").and_then(Value::as_str).unwrap_or(""), self.retry_err);
            classify_error(&hay).unwrap_or(ErrCode::Unknown)
        });
        out.push(AgentEvent::TurnEnd { turn: self.turn.clone(), outcome: if failed { Outcome::Failed } else { Outcome::Done }, error });
        out
    }
}

/// 한 줄을 상태 없이 해석한다(시험·단순 용도).
#[cfg(test)]
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    LineParser::new("t").feed(line)
}

/// 턴 하나를 실행한다(별도 스레드). 시작 실패는 `Runner::fail_start`, 그 밖의 결과는 이벤트로 올린다.
///
/// 자식은 Job 에 넣어 앱이 비정상 종료해도 남지 않게 하고, `result` 뒤 10초 안에 안 끝나면 강제 종료한다.
/// `result` 없이 끝나면 우리가 죽였으면 interrupted, 아니면 failed(stderr 꼬리로 인증·한도 분류, 아니면 ProcessExit).
///
/// # 인자
/// - `rt`: 실행기
/// - `p`: 턴 계획
pub fn run_turn(rt: Arc<Runner>, p: Plan) {
    let mut key = p.key.clone();
    let Some(exe) = claude_exe() else {
        rt.fail_start(&key, ErrCode::NoCli);
        return;
    };
    let cfg = config::load().config;
    let token = ensure_token();
    let hooks = hooks_path();
    if token.is_empty() || write_chat_hooks(&hooks, cfg.hook_port, &token).is_err() {
        rt.fail_start(&key, ErrCode::Spawn);
        return;
    }
    let mut cmd = Command::new(&exe);
    cmd.args(args_for(&p, &hooks)).current_dir(&p.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !cfg.claude_dir.trim().is_empty() {
        cmd.env("CLAUDE_CONFIG_DIR", cfg.claude_dir.trim());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            rt.fail_start(&key, ErrCode::Spawn);
            return;
        }
    };
    let job = Job::new();
    if let Some(j) = &job {
        if !j.assign(&child) {
            log::warn!("Claude 자식 Job 등록 실패 — 종료는 pid 로");
        }
    }
    p.ctl.attach(child.id(), job);
    let (Some(mut stdin), Some(stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        p.ctl.kill();
        rt.fail_start(&key, ErrCode::Spawn);
        return;
    };
    // 프롬프트는 stdin 으로(큰 입력이 출력 읽기를 막지 않게 별도 스레드), 쓴 뒤 닫음.
    let text = p.text.clone();
    std::thread::spawn(move || {
        let _ = stdin.write_all(text.as_bytes());
    });
    // stderr 는 읽어서 버리되 마지막 2KB 만 보관(오류 분류용, 로그 금지).
    let tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let t2 = tail.clone();
    let err_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut t = t2.lock().unwrap();
            t.extend_from_slice(&buf[..n]);
            let over = t.len().saturating_sub(2048);
            t.drain(..over);
        }
    });

    let finished = Arc::new(AtomicBool::new(false));
    let mut parser = LineParser::new(&p.turn);
    let mut ended = false;
    let mut rd = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let events = parser.feed(&String::from_utf8_lossy(&buf));
        if let Some(sid) = parser.init_session.take() {
            key = rt.mark_started(&key, &sid);
        }
        for ev in events {
            if matches!(ev, AgentEvent::TurnEnd { .. }) && !ended {
                ended = true;
                // result 뒤 10초 안에 프로세스가 안 끝나면 강제 종료
                let (ctl, fin) = (p.ctl.clone(), finished.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(10));
                    if !fin.load(Ordering::SeqCst) {
                        ctl.kill();
                    }
                });
            }
            rt.on_event_turn(&key, Some(&p.turn), ev);
        }
    }
    let code = child.wait().ok().and_then(|s| s.code());
    finished.store(true, Ordering::SeqCst);
    let _ = err_thread.join();
    log::info!("채팅 {} Claude 프로세스 종료 code={}", key.chars().take(8).collect::<String>(), code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()));
    if !ended {
        let (outcome, error) = if p.ctl.killed.load(Ordering::SeqCst) {
            (Outcome::Interrupted, None)
        } else {
            let stderr_tail = String::from_utf8_lossy(&tail.lock().unwrap()).to_string();
            (Outcome::Failed, Some(classify_error(&stderr_tail).unwrap_or(ErrCode::ProcessExit)))
        };
        rt.on_event_turn(&key, Some(&p.turn), AgentEvent::TurnEnd { turn: p.turn.clone(), outcome, error });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ToolKind;

    fn plan(mode: Mode, started: bool, fork: bool, trusted: bool) -> Plan {
        Plan {
            key: "L:new-id".into(),
            id: "new-id".into(),
            cwd: PathBuf::from("."),
            mode,
            resume: fork.then(|| "orig-id".to_string()),
            fork,
            started,
            trusted,
            turn: "t1".into(),
            text: "hi".into(),
            ctl: TurnCtl::new(),
        }
    }

    fn pos(a: &[String], s: &str) -> Option<usize> {
        a.iter().position(|x| x == s)
    }

    #[test]
    fn args_new_resume_fork() {
        let st = Path::new("C:/d/chat-hooks.json");
        let a = args_for(&plan(Mode::Ask, false, false, true), st);
        assert_eq!(&a[..5], ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
        assert_eq!(a[pos(&a, "--session-id").unwrap() + 1], "new-id");
        assert!(pos(&a, "--resume").is_none() && pos(&a, "--fork-session").is_none());
        assert_eq!(a[pos(&a, "--permission-mode").unwrap() + 1], "manual");
        assert_eq!(a[pos(&a, "--settings").unwrap() + 1], "C:/d/chat-hooks.json");
        assert!(pos(&a, "--setting-sources").is_none());
        // 이어가기
        let a = args_for(&plan(Mode::Ask, true, false, true), st);
        assert_eq!(a[pos(&a, "--resume").unwrap() + 1], "new-id");
        assert!(pos(&a, "--session-id").is_none());
        // 갈라지기: 원본을 resume, 새 id 를 session-id
        let a = args_for(&plan(Mode::Ask, false, true, true), st);
        assert_eq!(a[pos(&a, "--resume").unwrap() + 1], "orig-id");
        assert!(pos(&a, "--fork-session").is_some());
        assert_eq!(a[pos(&a, "--session-id").unwrap() + 1], "new-id");
        // 프롬프트는 인자에 없다
        assert!(!a.iter().any(|x| x == "hi"));
    }

    #[test]
    fn args_modes_and_untrusted() {
        let st = Path::new("s.json");
        let mode_of = |m| {
            let a = args_for(&plan(m, true, false, true), st);
            pos(&a, "--permission-mode").map(|i| a[i + 1].clone())
        };
        assert_eq!(mode_of(Mode::Ask).as_deref(), Some("manual"));
        assert_eq!(mode_of(Mode::AcceptEdits).as_deref(), Some("acceptEdits"));
        assert_eq!(mode_of(Mode::ReadOnly).as_deref(), Some("plan"));
        assert_eq!(mode_of(Mode::UserDefault), None);
        let a = args_for(&plan(Mode::Ask, true, false, false), st);
        let i = pos(&a, "--setting-sources").unwrap();
        assert_eq!(a[i + 1], "user");
        assert!(pos(&a, "--strict-mcp-config").is_some());
    }

    #[test]
    fn hooks_file_has_chat_permission_hook() {
        let p = std::env::temp_dir().join(format!("meow-chathooks-{}.json", std::process::id()));
        write_chat_hooks(&p, 47821, "tok").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let h = v.pointer("/hooks/PermissionRequest/0/hooks/0").unwrap();
        assert_eq!(h["type"], "http");
        assert_eq!(h["url"], "http://127.0.0.1:47821/muneo-chat-permission");
        assert_eq!(h["headers"]["x-muneo-token"], "tok");
        assert_eq!(h["timeout"], 1800);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn parse_init_delta_text_tool_result() {
        let mut p = LineParser::new("t1");
        let ev = p.feed(r#"{"type":"system","subtype":"init","session_id":"sid-1","cwd":"C:/x"}"#);
        assert_eq!(ev, vec![AgentEvent::TurnStart { turn: "t1".into() }]);
        assert_eq!(p.init_session.as_deref(), Some("sid-1"));
        assert!(p.feed(r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}"#).is_empty());
        let ev = p.feed(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}}"#);
        assert_eq!(ev, vec![AgentEvent::Delta { item: "msg_1:0".into(), text: "안녕".into() }]);
        // 확정 본문은 조각과 같은 항목 id 로 대체
        let ev = p.feed(r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"안녕하세요"}]}}"#);
        assert_eq!(ev, vec![AgentEvent::Message { item: "msg_1:0".into(), text: "안녕하세요".into() }]);
        let ev = p.feed(r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"thinking","thinking":"x"},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls -la","description":"목록"}}]}}"#);
        assert_eq!(ev.len(), 1);
        match &ev[0] {
            AgentEvent::ToolStart { item, kind, title, detail } => {
                assert_eq!((item.as_str(), *kind, title.as_str(), detail.as_str()), ("tu1", ToolKind::Command, "목록", "ls -la"));
            }
            e => panic!("{e:?}"),
        }
        let ev = p.feed(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"a\nb","is_error":false}]}}"#);
        assert_eq!(ev, vec![AgentEvent::ToolEnd { item: "tu1".into(), ok: true, summary: "a\nb".into() }]);
        let ev = p.feed(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","content":[{"type":"text","text":"boom"}],"is_error":true}]}}"#);
        assert_eq!(ev, vec![AgentEvent::ToolEnd { item: "tu2".into(), ok: false, summary: "boom".into() }]);
    }

    #[test]
    fn parse_result_success_and_failure() {
        let ev = parse_line(r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":2},"modelUsage":{"m":{"contextWindow":200000}},"permission_denials":[]}"#);
        assert_eq!(ev.len(), 2);
        match &ev[0] {
            AgentEvent::Usage { input, output, cached, cost_usd, context_pct } => {
                assert_eq!((*input, *output, *cached), (12, 5, 100));
                assert_eq!(*cost_usd, Some(0.0123));
                assert!(context_pct.unwrap() > 0.05 && context_pct.unwrap() < 0.1);
            }
            e => panic!("{e:?}"),
        }
        assert_eq!(ev[1], AgentEvent::TurnEnd { turn: "t".into(), outcome: Outcome::Done, error: None });
        let ev = parse_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Invalid API key · Please run /login","usage":{}}"#);
        assert_eq!(ev.last().unwrap(), &AgentEvent::TurnEnd { turn: "t".into(), outcome: Outcome::Failed, error: Some(ErrCode::Auth) });
        let ev = parse_line(r#"{"type":"result","subtype":"success","is_error":true,"result":"Claude usage limit reached","usage":{}}"#);
        assert_eq!(ev.last().unwrap(), &AgentEvent::TurnEnd { turn: "t".into(), outcome: Outcome::Failed, error: Some(ErrCode::Limit) });
        let ev = parse_line(r#"{"type":"result","subtype":"error_max_turns","usage":{}}"#);
        assert_eq!(ev.last().unwrap(), &AgentEvent::TurnEnd { turn: "t".into(), outcome: Outcome::Failed, error: Some(ErrCode::Unknown) });
        let ev = parse_line(r#"{"type":"result","subtype":"success","usage":{},"permission_denials":[{"tool_name":"Bash"}]}"#);
        assert_eq!(ev[0], AgentEvent::Notice { code: "denied".into() });
    }

    #[test]
    fn parse_notices_subagent_unknown_and_broken() {
        assert_eq!(parse_line(r#"{"type":"system","subtype":"api_retry","error":"rate_limit"}"#), vec![AgentEvent::Notice { code: "retry".into() }]);
        assert_eq!(parse_line(r#"{"type":"system","subtype":"permission_denied"}"#), vec![AgentEvent::Notice { code: "denied".into() }]);
        // 하위 에이전트 줄은 무시
        assert!(parse_line(r#"{"type":"assistant","parent_tool_use_id":"tu9","message":{"id":"x","content":[{"type":"text","text":"하위"}]}}"#).is_empty());
        assert!(parse_line(r#"{"type":"stream_event","parent_tool_use_id":"tu9","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}"#).is_empty());
        // 모르는 줄·깨진 JSON
        assert!(parse_line(r#"{"type":"something_new","x":1}"#).is_empty());
        assert!(parse_line("{not json").is_empty());
        assert!(parse_line("").is_empty());
        // input_json_delta 같은 조각은 무시
        assert!(parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}}"#).is_empty());
    }

    /// V9: npm 설치(`claude.cmd`) 경로 — `Command` 로 .cmd 가 실행되고 stdin 프롬프트·공백 있는 인자를 받는지(Windows).
    #[cfg(windows)]
    #[test]
    fn cmd_wrapper_runs_via_command() {
        use std::os::windows::process::CommandExt;
        let d = std::env::temp_dir().join(format!("meow cmd {}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("claude.cmd");
        std::fs::write(&f, "@echo off\r\nif \"%1\"==\"--version\" (echo 9.9.9) else (more)\r\n").unwrap();
        let out = Command::new(&f).arg("--version").creation_flags(0x0800_0000).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "9.9.9");
        let mut child = Command::new(&f).args(["-p", "--settings", "C:/a b/s.json"]).stdin(Stdio::piped()).stdout(Stdio::piped()).creation_flags(0x0800_0000).spawn().unwrap();
        child.stdin.take().unwrap().write_all("안녕 hello".as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn classify_error_cases() {
        assert_eq!(classify_error("authentication_failed"), Some(ErrCode::Auth));
        assert_eq!(classify_error("Rate limit exceeded"), Some(ErrCode::Limit));
        assert_eq!(classify_error("something else"), None);
    }
}
