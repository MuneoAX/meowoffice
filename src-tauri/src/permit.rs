//! Claude Code 권한 요청 → 알림 카드 수락/거절.
//! Claude Code 의 PreToolUse / PermissionRequest HTTP 훅이 요청을 보내면 카드로 띄우고 선택을 응답.
//! 터미널에서 직접 응답해도 Claude Code 는 훅 연결을 끊지 않으므로, 같은 세션의 후속 이벤트
//! (PostToolUse·Stop·UserPromptSubmit → POST <EVENT_PATH>)를 받으면 해당 카드를 닫는다.
//! 카드 형식은 `Permit.kind` 플래그 하나로 구분(알림 창이 같은 카드 안에서 분기):
//! `tool` = 일반 도구 수락/거절, `question` = AskUserQuestion 선택지(단일/복수 선택 + 기타 입력).
//! 질문 답변은 allow + updatedInput.answers 로 돌려줘 Claude Code 가 그 답으로 도구를 완료하게 함.
//! 자동 수락이 켜져 있으면 선택이 필요한 도구(CHOICE_TOOLS)만 카드로 띄우고 나머지는 즉시 수락.
//! 보안: 루프백 바인드 + 설정에 저장된 토큰 헤더(x-muneo-token) 일치 시에만 처리.

use crate::provider_hook::{self, AgyPolicy, Event, Provider};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const PATH: &str = "/muneo-permission";
/// 권한 요청이 다른 곳(터미널 등)에서 처리됐음을 알리는 후속 이벤트 수신 경로.
pub const EVENT_PATH: &str = "/muneo-event";
/// ChatGPT(Codex)·Antigravity 중계 모드(relay.rs)가 보내는 경로: /muneo-provider/<codex|agy>/<이벤트>.
pub const PROVIDER_PREFIX: &str = "/muneo-provider/";
/// 채팅(runner) 전용 훅 경로: 앱이 `claude -p` 실행 때만 `--settings` 로 붙이는 PermissionRequest 훅(runner_claude.rs).
pub const CHAT_PATH: &str = "/muneo-chat-permission";
/// 사용자 응답 대기 한도. 훅 timeout(hook.rs) 보다 짧아야 빈 응답으로 터미널 확인에 넘길 수 있음.
pub const WAIT: Duration = Duration::from_secs(110);
/// 채팅 승인 대기 한도(30분). 전용 훅 timeout(1800초)보다 짧아야 앱이 먼저 거절+중단 응답을 줄 수 있음.
pub const CHAT_WAIT: Duration = Duration::from_secs(1740);
const MAX_BODY: usize = 1 << 20;

/// 질문형 도구 이름 — 이 도구의 요청은 `question` 형식 카드로 띄움.
const QUESTION_TOOL: &str = "AskUserQuestion";
/// 수락/거절이 아니라 선택이 필요한 도구 — 자동 수락에서 제외(질문 선택지·계획 승인 방식 선택).
const CHOICE_TOOLS: &[&str] = &[QUESTION_TOOL, "ExitPlanMode"];

/// 사용자 선택. 수락 시 바꿔 넣을 도구 입력(질문 답변 등)을 함께 전달.
pub enum Decision {
    Allow(Option<Value>),
    Deny,
}

#[derive(Serialize, Clone)]
pub struct Permit {
    pub id: String,
    /// 카드 형식 플래그: "tool" | "question".
    pub kind: &'static str,
    /// 요청을 보낸 서비스(사무실 고양이 열쇠와 같은 이름): "claude" | "chatgpt" | "antigravity".
    pub provider: &'static str,
    pub project: String,
    pub tool: String,
    /// 카드 본문: Bash 명령 / 파일 경로 / URL 등.
    pub detail: String,
    pub description: String,
    pub created_at: String,
    /// question 형식일 때 tool_input.questions(header·question·options·multiSelect).
    #[serde(skip_serializing_if = "Value::is_null")]
    pub questions: Value,
    /// 후속 이벤트와 대조용 + 오피스에서 어느 고양이(세션)의 요청인지 찾는 데 씀(알림 카드에는 미표시).
    pub session: String,
    #[serde(skip)]
    pub tool_input: Value,
}

#[derive(Default)]
pub struct Permits {
    pending: Vec<(Permit, Sender<Decision>)>,
    seq: u64,
}

impl Permits {
    pub fn visible(&self) -> Vec<Permit> {
        self.pending.iter().map(|(p, _)| p.clone()).collect()
    }

    fn add(&mut self, mut p: Permit, tx: Sender<Decision>) -> String {
        self.seq += 1;
        p.id = format!("p{}", self.seq);
        let id = p.id.clone();
        self.pending.push((p, tx));
        id
    }

    fn remove(&mut self, id: &str) -> bool {
        let n = self.pending.len();
        self.pending.retain(|(p, _)| p.id != id);
        n != self.pending.len()
    }

    /// 같은 세션의 후속 이벤트 → 이미 처리된 요청 제거(대기 스레드는 빈 응답으로 종료). 변경 여부 반환.
    /// 도구 실행 이벤트는 같은 도구·입력만, 그 외(턴 종료·새 입력)는 세션의 모든 요청.
    fn resolve(&mut self, session: &str, tool: Option<(&str, &Value)>) -> bool {
        let n = self.pending.len();
        self.pending.retain(|(p, _)| p.session != session || tool.is_some_and(|(name, input)| p.tool != name || p.tool_input != *input));
        n != self.pending.len()
    }

    /// 이 세션의 대기 요청을 모두 거둔다(대기 스레드는 빈 응답으로 종료). 채팅 중단·종료용. 변경 여부 반환.
    pub fn drop_session(&mut self, session: &str) -> bool {
        self.resolve(session, None)
    }

    /// 사용자 선택 전달. answers(질문 텍스트 → 답) 가 있으면 원래 입력에 합쳐 updatedInput 으로 보냄.
    /// 이미 끝난 요청이면 false.
    pub fn answer(&mut self, id: &str, allow: bool, answers: Option<Value>) -> bool {
        let Some(i) = self.pending.iter().position(|(p, _)| p.id == id) else {
            return false;
        };
        let (p, tx) = self.pending.remove(i);
        let decision = match (allow, answers) {
            (false, _) => Decision::Deny,
            (true, None) => Decision::Allow(None),
            (true, answers) => {
                let mut input = p.tool_input;
                if let (Some(o), Some(a)) = (input.as_object_mut(), answers) {
                    o.insert("answers".into(), a);
                }
                Decision::Allow(Some(input))
            }
        };
        tx.send(decision).is_ok()
    }
}

/// 서버 콜백: 목록 변경 시 호출(알림 창·트레이 갱신).
pub trait Host: Send + Sync + 'static {
    fn permits(&self) -> &Mutex<Permits>;
    fn token(&self) -> Option<String>;
    /// 자동 수락 모드 여부.
    fn auto_allow(&self) -> bool;
    /// 자동 수락된 권한 요청을 사무실 연출에 전달한다.
    fn auto_allowed(&self, permit: &Permit);
    fn changed(&self);
    /// 후속 이벤트 원문(로컬 세션 알림용).
    fn session_event(&self, v: &Value);
    /// Codex·Antigravity 연동이 켜져 있으면 요청 검증 토큰(꺼져 있으면 None → 요청 무시).
    fn provider_token(&self, p: Provider) -> Option<String>;
    /// 그 서비스의 자동 수락 여부.
    fn provider_auto_allow(&self, p: Provider) -> bool;
    /// Antigravity 응답 완료(Stop) 이벤트 → 알림.
    fn provider_stop(&self, p: Provider, v: &Value);
    /// 이 세션이 채팅 실행기(runner)가 소유한 것인지 — 소유 세션의 전역 훅 요청은 카드·알림 이중 발생을 막으려 결정 없이 돌려보냄.
    fn owned(&self, session: &str) -> bool;
    /// 채팅 승인 자동 수락 여부. `provider` = "claude" | "chatgpt". Claude 는 `auto_allow`, Codex 는 `codex_auto_allow` 설정(훅 켜짐과 무관).
    fn chat_auto_allow(&self, provider: &str) -> bool;
    /// 이 서비스 세션 id 의 대화가 읽기 전용(`Mode::ReadOnly`)인지 — 그렇면 자동 수락하지 않고 카드로 사용자에게 묻는다.
    fn chat_readonly(&self, session: &str) -> bool;
    /// 채팅 전용 훅(`CHAT_PATH`) 검증 토큰. 토큰이 비어 있으면 None(요청 무시).
    fn chat_token(&self) -> Option<String>;
    /// 소유 세션의 승인 카드가 열리고 닫힘을 실행기에 알린다(`wait_outcome` 이 호출). `session` = 서비스 세션 id.
    fn chat_approval(&self, session: &str, ev: ChatApproval);
}

/// 채팅 소유 세션의 승인 카드 수명 사건. `wait_outcome` 이 `Host::chat_approval` 로 전달.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatApproval {
    /// 카드가 떴다(`question` = 질문형).
    Open { id: String, question: bool },
    /// 카드가 닫혔다(응답·다른 곳에서 처리·연결 종료).
    Closed { id: String },
    /// 대기 한도를 넘겨 닫혔다.
    TimedOut { id: String },
}

/// `wait_outcome` 의 종료 사유.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waited {
    /// 사용자가 수락·거절함.
    Decided,
    /// 같은 세션의 후속 이벤트로 이미 처리됨(대기 요청이 제거됨).
    Resolved,
    /// 대기 한도 초과.
    TimedOut,
    /// 요청 쪽이 포기함(`cancelled` 가 true).
    Cancelled,
}

/// 권한 요청을 목록에 올리고 사용자 선택·시간 초과·취소·다른 곳 처리 중 먼저 오는 것을 기다린다.
///
/// 목록 갱신(`changed`)과 소유 세션의 `chat_approval` 알림, 끝난 뒤 목록에서 제거까지 맡는다.
/// `handle`·`handle_provider`·채팅 훅·Codex 어댑터가 함께 쓰는 단일 대기 루프(500ms 간격으로 취소·한도 확인).
///
/// # 인자
/// - `host`: 서버 콜백
/// - `permit`: 올릴 요청(`session` 이 소유 세션이면 실행기에도 알림)
/// - `wait`: 대기 한도
/// - `cancelled`: true 를 돌려주면 대기 중단(예: HTTP 연결 종료)
///
/// # 반환
/// (선택, 종료 사유). 선택이 없으면(`None`) 호출한 쪽이 사유에 맞게 응답한다.
pub fn wait_outcome<H: Host>(host: &H, permit: Permit, wait: Duration, cancelled: impl Fn() -> bool) -> (Option<Decision>, Waited) {
    let (session, question, what) = (permit.session.clone(), permit.kind == "question", format!("{} · {} · {}", permit.provider, permit.tool, permit.project));
    let (tx, rx) = mpsc::channel();
    let id = host.permits().lock().unwrap().add(permit, tx);
    log::info!("권한 요청 {id} 카드 표시: {what}");
    host.changed();
    let chat = !session.is_empty() && host.owned(&session);
    if chat {
        host.chat_approval(&session, ChatApproval::Open { id: id.clone(), question });
    }
    let started = Instant::now();
    let (decision, why) = loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(d) => break (Some(d), Waited::Decided),
            Err(RecvTimeoutError::Disconnected) => {
                log::info!("권한 요청 {id}: 다른 곳에서 처리됨(후속 이벤트)");
                break (None, Waited::Resolved);
            }
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() >= wait {
                    log::info!("권한 요청 {id}: {}초 무응답", wait.as_secs());
                    break (None, Waited::TimedOut);
                }
                if cancelled() {
                    log::info!("권한 요청 {id}: 요청 쪽 연결 종료(다른 곳에서 처리·중단)");
                    break (None, Waited::Cancelled);
                }
            }
        }
    };
    if host.permits().lock().unwrap().remove(&id) || decision.is_some() {
        host.changed();
    }
    if chat {
        host.chat_approval(&session, if why == Waited::TimedOut { ChatApproval::TimedOut { id } } else { ChatApproval::Closed { id } });
    }
    (decision, why)
}

/// `wait_outcome` 의 선택만 돌려주는 얇은 판.
///
/// # 반환
/// 수락·거절이면 `Some`, 시간 초과·취소·다른 곳 처리면 `None`.
pub fn wait_decision<H: Host>(host: &H, permit: Permit, wait: Duration, cancelled: impl Fn() -> bool) -> Option<Decision> {
    wait_outcome(host, permit, wait, cancelled).0
}

pub fn serve<H: Host + Clone>(port: u16, host: H) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            log::error!("권한 요청 서버 시작 실패(127.0.0.1:{port}): {e} — 다른 인스턴스가 포트를 쓰는 중일 수 있음");
            return;
        }
    };
    log::info!("권한 요청 서버 시작: 127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        let host = host.clone();
        std::thread::spawn(move || {
            let _ = handle(stream, &host);
        });
    }
}

fn handle<H: Host>(mut stream: TcpStream, host: &H) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let Some((head, body)) = read_request(&mut stream)? else {
        return respond(&mut stream, 400, "");
    };
    let mut lines = head.lines();
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split(' ');
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let headers: Vec<(&str, &str)> = lines.filter_map(|l| l.split_once(':')).collect();
    let header = |key: &str| headers.iter().find(|(k, _)| k.trim().eq_ignore_ascii_case(key)).map(|(_, v)| v.trim());
    if let Some(rest) = path.strip_prefix(PROVIDER_PREFIX) {
        if method != "POST" {
            return respond(&mut stream, 404, "");
        }
        let token = header("x-muneo-token").map(str::to_string);
        return handle_provider(&mut stream, host, rest, token, &body);
    }
    if method != "POST" || (path != PATH && path != EVENT_PATH && path != CHAT_PATH) {
        return respond(&mut stream, 404, "");
    }
    let token = header("x-muneo-token").map(str::to_string);
    // 연동 꺼짐·토큰 불일치 → 결정 없음(평소 흐름). 채팅 전용 훅은 권한 연동 설정과 무관하게 앱 토큰만 본다.
    match (if path == CHAT_PATH { host.chat_token() } else { host.token() }, token) {
        (Some(want), Some(got)) if !want.is_empty() && want == got => {}
        (None, _) => {
            log::debug!("훅 요청 무시: 권한 연동 꺼짐 ({path})");
            return respond(&mut stream, 200, "");
        }
        _ => {
            log::warn!("훅 요청 무시: 토큰 불일치 ({path}) — settings.json 훅과 앱 설정의 토큰이 다름");
            return respond(&mut stream, 200, "");
        }
    }
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut stream, 200, "");
    };
    if path == EVENT_PATH {
        on_event(&input, host);
        return respond(&mut stream, 200, "");
    }
    if path == CHAT_PATH {
        return handle_chat(&mut stream, host, &input);
    }

    let permit = to_permit(&input);
    // 채팅 실행기가 소유한 세션은 전용 훅(CHAT_PATH)이 결정한다 — 전역 훅은 결정 없음(카드 이중 표시 방지).
    if path == PATH && !permit.session.is_empty() && host.owned(&permit.session) {
        log::debug!("전역 권한 훅 무시: 채팅 소유 세션");
        return respond(&mut stream, 200, "");
    }
    // 명령 본문(detail)은 비밀이 섞일 수 있어 기록하지 않음.
    let what = format!("{} · {}", permit.tool, permit.project);
    if host.auto_allow() && !CHOICE_TOOLS.contains(&permit.tool.as_str()) {
        log::info!("권한 요청 자동 수락: {what}");
        host.auto_allowed(&permit);
        return respond(&mut stream, 200, &allowed_body(None));
    }

    // 대기: 사용자 선택 / 시간 초과 / Claude Code 쪽 연결 종료(터미널에서 처리·중단).
    let decision = wait_decision(host, permit, WAIT, || peer_closed(&stream));

    let body = match decision {
        Some(Decision::Allow(input)) => allowed_body(input),
        Some(Decision::Deny) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "deny", "message": "사용자가 트레이 알림에서 거절했습니다." }
            }
        })
        .to_string(),
        None => String::new(),
    };
    respond(&mut stream, 200, &body)
}

/// Codex·Antigravity 중계 요청. 응답 본문 = 서비스에 그대로 출력할 JSON(비어 있으면 중계 모드가 중립 응답).
fn handle_provider<H: Host>(stream: &mut TcpStream, host: &H, rest: &str, token: Option<String>, body: &[u8]) -> std::io::Result<()> {
    let Some((p, e)) = rest.split_once('/').and_then(|(p, e)| {
        let p = Provider::from_arg(p)?;
        Some((p, Event::from_arg(p, e)?))
    }) else {
        return respond(stream, 404, "");
    };
    match (host.provider_token(p), token) {
        (Some(want), Some(got)) if !want.is_empty() && want == got => {}
        (None, _) => {
            log::debug!("{} 훅 요청 무시: 연동 꺼짐", p.arg());
            return respond(stream, 200, "");
        }
        _ => {
            log::warn!("{} 훅 요청 무시: 토큰 불일치 — 앱 설정이 바뀐 직후일 수 있음", p.arg());
            return respond(stream, 200, "");
        }
    }
    let Ok(input) = serde_json::from_slice::<Value>(body) else {
        return respond(stream, 200, "");
    };
    if e == Event::Stop {
        host.provider_stop(p, &input);
        return respond(stream, 200, "");
    }
    if p == Provider::Agy {
        // PreToolUse 훅은 Antigravity 가 직접 물을 설정(Card)일 때만 등록된다. 설정이 바뀌어 남은 훅이면 관여하지 않고
        // ask(Antigravity 판단) — allow 는 Antigravity 자체 거부 목록을 건너뛰므로 절대 내보내지 않는다.
        if provider_hook::agy_policy(provider_hook::read_agy_config().as_ref()) != AgyPolicy::Card {
            return respond(stream, 200, provider_hook::fail_open(p, e));
        }
    }
    let permit = to_provider_permit(p, &input);
    // 채팅 실행기가 소유한 스레드(app-server 가 돌리는 Codex 턴)는 어댑터가 승인을 맡는다 — 훅은 결정 없음(카드 이중 표시 방지).
    if !permit.session.is_empty() && host.owned(&permit.session) {
        log::debug!("{} 훅 무시: 채팅 소유 세션", p.key());
        return respond(stream, 200, "");
    }
    let what = format!("{} · {} · {}", p.key(), permit.tool, permit.project);
    if host.provider_auto_allow(p) {
        log::info!("권한 요청 자동 수락: {what}");
        host.auto_allowed(&permit);
        return respond(stream, 200, &provider_hook::allow_body(p, e));
    }
    let decision = wait_decision(host, permit, WAIT, || peer_closed(stream));
    let body = match decision {
        Some(Decision::Allow(_)) => provider_hook::allow_body(p, e),
        Some(Decision::Deny) => provider_hook::deny_body(p, e, "사용자가 Meowffice 알림 카드에서 거절했습니다."),
        None => String::new(),
    };
    respond(stream, 200, &body)
}

/// 채팅 전용 훅(`CHAT_PATH`) 요청 — 실행기가 띄운 `claude -p` 의 PermissionRequest.
///
/// 자동 수락(설정 `auto_allow`, 작업 폴더가 홈·드라이브 루트면 제외, 선택형 도구 제외) 아니면 카드를 올려 최대 `CHAT_WAIT` 기다린다.
/// 시간 초과는 빈 응답이 아니라 거절 + `interrupt`(`-p` 는 결정 없음이면 어차피 거절하므로 턴을 멈춘다).
fn handle_chat<H: Host>(stream: &mut TcpStream, host: &H, input: &Value) -> std::io::Result<()> {
    let mut permit = to_permit(input);
    permit.kind = "tool"; // 질문형 도구는 -p 에서 제공되지 않음(1단계) — 항상 수락/거절 카드
    permit.questions = Value::Null;
    let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or("");
    if !CHOICE_TOOLS.contains(&permit.tool.as_str()) && host.chat_auto_allow("claude")
        && crate::runner::auto_allow_cwd_ok(cwd)
        && !host.chat_readonly(&permit.session)
    {
        log::info!("채팅 권한 요청 자동 수락: {} · {}", permit.tool, permit.project);
        host.auto_allowed(&permit);
        return respond(stream, 200, &allowed_body(None));
    }
    let (decision, why) = wait_outcome(host, permit, CHAT_WAIT, || peer_closed(stream));
    let body = match decision {
        Some(Decision::Allow(input)) => allowed_body(input),
        Some(Decision::Deny) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "deny", "message": "사용자가 Meowffice 에서 거절했습니다." }
            }
        })
        .to_string(),
        None if why == Waited::TimedOut => json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "deny", "message": "30분 동안 승인을 받지 못해 작업을 멈춥니다.", "interrupt": true }
            }
        })
        .to_string(),
        None => String::new(),
    };
    respond(stream, 200, &body)
}

/// 서비스별 훅 입력 → 카드. Codex 는 Claude 와 같은 필드명(session_id·tool_name·tool_input·cwd), Antigravity 는 camelCase.
fn to_provider_permit(p: Provider, v: &Value) -> Permit {
    let normalized = match p {
        Provider::Codex => v.clone(),
        Provider::Agy => json!({
            "session_id": v.get("conversationId").cloned().unwrap_or(Value::Null),
            "cwd": v.get("cwd").cloned().unwrap_or(Value::Null),
            "tool_name": v.pointer("/toolCall/name").cloned().unwrap_or(Value::Null),
            "tool_input": v.pointer("/toolCall/args").cloned().unwrap_or(Value::Null),
        }),
    };
    let mut permit = to_permit(&normalized);
    permit.kind = "tool"; // 선택지 질문은 훅으로 답할 수 없음 — 항상 수락/거절 카드
    permit.questions = Value::Null;
    permit.provider = p.key();
    if permit.detail.is_empty() && p == Provider::Agy {
        permit.detail = ["CommandLine", "TargetFile", "AbsolutePath", "Url"]
            .iter()
            .find_map(|k| permit.tool_input.get(*k).and_then(Value::as_str))
            .unwrap_or("")
            .chars()
            .take(600)
            .collect();
    }
    permit
}

fn allowed_body(input: Option<Value>) -> String {
    let mut d = json!({ "behavior": "allow" });
    if let Some(input) = input {
        d["updatedInput"] = input;
    }
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": d } }).to_string()
}

fn on_event<H: Host>(v: &Value, host: &H) {
    let session = v.get("session_id").and_then(Value::as_str).unwrap_or("");
    if session.is_empty() {
        return;
    }
    let event = v.get("hook_event_name").and_then(Value::as_str).unwrap_or("");
    host.session_event(v);
    // Notification 은 권한 확인 창이 뜰 때도 오므로(permission_prompt) 처리 완료 신호가 아님.
    if event == "Notification" {
        return;
    }
    let tool_name = v.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let null = Value::Null;
    let tool = (event == "PostToolUse").then(|| (tool_name, v.get("tool_input").unwrap_or(&null)));
    if host.permits().lock().unwrap().resolve(session, tool) {
        host.changed();
    }
}

/// 헤더(\r\n\r\n 까지) + Content-Length 만큼 본문.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<(String, Vec<u8>)>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Ok(None);
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let transfer_encoding = head
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("transfer-encoding"))
        .map(|(_, v)| v.trim().to_ascii_lowercase());
    if let Some(encoding) = transfer_encoding {
        if encoding != "chunked" {
            return Ok(None);
        }
        let initial = buf[head_end + 4..].to_vec();
        let Some(body) = read_chunked_body(stream, initial, MAX_BODY)? else {
            return Ok(None);
        };
        return Ok(Some((head, body)));
    }
    let len = head
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Ok(None);
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Some((head, body)))
}

/// Transfer-Encoding: chunked 본문 해제(크기 줄 → 데이터 → CRLF, 0 크기 뒤 트레일러·빈 줄). 형식 오류·한도 초과 → None.
fn read_chunked_body(stream: &mut TcpStream, mut buf: Vec<u8>, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut body = Vec::new();
    let mut pos = 0usize;
    // buf[pos..] 에서 다음 CRLF 까지의 줄(끝 위치). 부족하면 더 읽음.
    let next_line = |stream: &mut TcpStream, buf: &mut Vec<u8>, pos: usize| -> std::io::Result<Option<usize>> {
        loop {
            if let Some(i) = buf[pos..].windows(2).position(|w| w == b"\r\n") {
                return Ok(Some(pos + i));
            }
            if buf.len() - pos > 64 * 1024 || !fill(stream, buf)? {
                return Ok(None);
            }
        }
    };
    loop {
        let Some(end) = next_line(stream, &mut buf, pos)? else {
            return Ok(None);
        };
        let line = String::from_utf8_lossy(&buf[pos..end]).to_string();
        let Ok(size) = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16) else {
            return Ok(None);
        };
        pos = end + 2;
        if size == 0 {
            // 트레일러 헤더(선택)는 빈 줄로 끝남.
            loop {
                let Some(end) = next_line(stream, &mut buf, pos)? else {
                    return Ok(None);
                };
                if end == pos {
                    return Ok(Some(body));
                }
                pos = end + 2;
            }
        }
        let Some(needed) = body.len().checked_add(size).filter(|n| *n <= max).map(|_| pos + size + 2) else {
            return Ok(None);
        };
        while buf.len() < needed {
            if !fill(stream, &mut buf)? {
                return Ok(None);
            }
        }
        if &buf[pos + size..needed] != b"\r\n" {
            return Ok(None);
        }
        body.extend_from_slice(&buf[pos..pos + size]);
        pos = needed;
    }
}

/// 소켓에서 한 번 더 읽어 buf 에 붙임. 연결 종료면 false.
fn fill(stream: &mut TcpStream, buf: &mut Vec<u8>) -> std::io::Result<bool> {
    let mut chunk = [0u8; 8192];
    let n = stream.read(&mut chunk)?;
    buf.extend_from_slice(&chunk[..n]);
    Ok(n > 0)
}

fn peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut b = [0u8; 1];
    // FIN(Ok(0)) 뿐 아니라 RST(ConnectionReset 등)도 종료로 판정 — Windows 에선 훅 취소가 RST 로 오는 경우가 있음.
    let closed = match stream.peek(&mut b) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    closed
}

fn respond(stream: &mut TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        401 => "Unauthorized",
        403 => "Forbidden",
        400 => "Bad Request",
        405 => "Method Not Allowed",
        _ => "Not Found",
    };
    let ctype = if body.is_empty() { "text/plain" } else { "application/json" };
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

fn to_permit(v: &Value) -> Permit {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let tool = s("/tool_name");
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    let question = tool == QUESTION_TOOL;
    let field = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let description = field("description").unwrap_or_default();
    let detail = field("command")
        .or_else(|| field("file_path"))
        .or_else(|| field("notebook_path"))
        .or_else(|| field("url"))
        .or_else(|| field("pattern"))
        .or_else(|| field("query"))
        .unwrap_or_else(|| {
            if question {
                return String::new();
            }
            let t = input.to_string();
            if t == "null" || t == "{}" {
                String::new()
            } else {
                t
            }
        });
    let cwd = s("/cwd");
    let project = cwd.rsplit(['\\', '/']).find(|x| !x.is_empty()).unwrap_or("").to_string();
    Permit {
        id: String::new(),
        kind: if question { "question" } else { "tool" },
        provider: "claude",
        project,
        tool,
        detail: detail.chars().take(600).collect(),
        description,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        questions: if question { input.get("questions").cloned().unwrap_or(Value::Null) } else { Value::Null },
        session: s("/session_id"),
        tool_input: input,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 루프백 소켓으로 raw 요청을 보내고 read_request 결과를 받음.
    fn roundtrip(raw: &'static [u8]) -> Option<(String, Vec<u8>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let writer = std::thread::spawn(move || {
            let mut c = TcpStream::connect(addr).unwrap();
            c.write_all(raw).unwrap();
            c
        });
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let res = read_request(&mut stream).unwrap();
        drop(writer.join());
        res
    }

    /// 대기 루프 시험용 서버 콜백(알림 창·트레이 없음).
    struct MockHost {
        permits: Mutex<Permits>,
        owned: bool,
        events: Mutex<Vec<ChatApproval>>,
    }

    impl MockHost {
        fn new(owned: bool) -> Self {
            MockHost { permits: Mutex::new(Permits::default()), owned, events: Mutex::new(vec![]) }
        }
    }

    impl Host for MockHost {
        fn permits(&self) -> &Mutex<Permits> {
            &self.permits
        }
        fn token(&self) -> Option<String> {
            Some("t".into())
        }
        fn auto_allow(&self) -> bool {
            false
        }
        fn auto_allowed(&self, _permit: &Permit) {}
        fn changed(&self) {}
        fn session_event(&self, _v: &Value) {}
        fn provider_token(&self, _p: Provider) -> Option<String> {
            None
        }
        fn provider_auto_allow(&self, _p: Provider) -> bool {
            false
        }
        fn provider_stop(&self, _p: Provider, _v: &Value) {}
        fn owned(&self, _session: &str) -> bool {
            self.owned
        }
        fn chat_auto_allow(&self, _provider: &str) -> bool {
            false
        }
        fn chat_readonly(&self, _session: &str) -> bool {
            false
        }
        fn chat_token(&self) -> Option<String> {
            Some("t".into())
        }
        fn chat_approval(&self, _session: &str, ev: ChatApproval) {
            self.events.lock().unwrap().push(ev);
        }
    }

    fn sample_permit() -> Permit {
        to_permit(&json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "C:/x/proj", "session_id": "s1"}))
    }

    /// 대기 요청이 목록에 뜰 때까지 기다렸다가 선택을 전달한다.
    fn answer_later(host: &std::sync::Arc<MockHost>, allow: bool) -> std::thread::JoinHandle<()> {
        let host = host.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                let id = host.permits.lock().unwrap().visible().first().map(|p| p.id.clone());
                if let Some(id) = id {
                    assert!(host.permits.lock().unwrap().answer(&id, allow, None));
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    }

    #[test]
    fn wait_decision_allow_and_deny() {
        let host = std::sync::Arc::new(MockHost::new(false));
        let t = answer_later(&host, true);
        let d = wait_decision(&*host, sample_permit(), Duration::from_secs(5), || false);
        t.join().unwrap();
        assert!(matches!(d, Some(Decision::Allow(None))));
        assert!(host.permits.lock().unwrap().visible().is_empty());
        let t = answer_later(&host, false);
        let d = wait_decision(&*host, sample_permit(), Duration::from_secs(5), || false);
        t.join().unwrap();
        assert!(matches!(d, Some(Decision::Deny)));
    }

    #[test]
    fn wait_decision_timeout_cancel_and_resolved() {
        let host = MockHost::new(false);
        let (d, why) = wait_outcome(&host, sample_permit(), Duration::from_millis(50), || false);
        assert!(d.is_none() && why == Waited::TimedOut);
        let (d, why) = wait_outcome(&host, sample_permit(), Duration::from_secs(5), || true);
        assert!(d.is_none() && why == Waited::Cancelled);
        assert!(host.permits.lock().unwrap().visible().is_empty());
        // 후속 이벤트로 제거되면 보낸 쪽이 사라져 Resolved
        let host = std::sync::Arc::new(MockHost::new(false));
        let h = host.clone();
        let t = std::thread::spawn(move || {
            for _ in 0..100 {
                if !h.permits.lock().unwrap().visible().is_empty() {
                    h.permits.lock().unwrap().resolve("s1", None);
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let (d, why) = wait_outcome(&*host, sample_permit(), Duration::from_secs(5), || false);
        t.join().unwrap();
        assert!(d.is_none() && why == Waited::Resolved);
    }

    #[test]
    fn owned_session_reports_approval_lifecycle() {
        let host = MockHost::new(true);
        let _ = wait_decision(&host, sample_permit(), Duration::from_millis(50), || false);
        let ev = host.events.lock().unwrap().clone();
        assert_eq!(ev.len(), 2);
        assert!(matches!(&ev[0], ChatApproval::Open { question: false, .. }));
        assert!(matches!(&ev[1], ChatApproval::TimedOut { .. }));
    }

    /// 루프백으로 raw 훅 요청을 `handle` 에 보내 응답 본문과 호스트 상태를 확인한다.
    fn post(host: std::sync::Arc<MockHost>, path: &str, body: &str) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let h = host.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = handle(stream, &*h);
        });
        let mut c = TcpStream::connect(addr).unwrap();
        let req = format!("POST {path} HTTP/1.1\r\nx-muneo-token: t\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        c.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        server.join().unwrap();
        out.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
    }

    #[test]
    fn global_hook_returns_empty_for_owned_session() {
        let host = std::sync::Arc::new(MockHost::new(true));
        let body = json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "C:/x/proj", "session_id": "s1"}).to_string();
        let out = post(host.clone(), PATH, &body);
        assert_eq!(out, "");
        assert!(host.permits.lock().unwrap().visible().is_empty());
        assert!(host.events.lock().unwrap().is_empty());
    }

    #[test]
    fn reads_chunked_body() {
        let raw = b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5;ext=1\r\npedia\r\n0\r\nX-Trailer: 1\r\n\r\n";
        let (_, body) = roundtrip(raw).unwrap();
        assert_eq!(body, b"Wikipedia");
    }

    #[test]
    fn rejects_bad_chunk_and_reads_content_length() {
        assert!(roundtrip(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWikiXX0\r\n\r\n").is_none());
        assert!(roundtrip(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").is_none());
        let (_, body) = roundtrip(b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(body, b"{}");
    }
}
