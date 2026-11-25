//! Codex 어댑터 — 상주 `codex app-server`(appserver.rs) 위에서 스레드·턴·승인을 공통 이벤트(`AgentEvent`)와 권한 카드(`Permit`)로 잇는다(설계서 3.5·5.3).
//! - 승인: 서버 요청(`item/*/requestApproval`·`item/tool/requestUserInput`)을 기존 `permit::Permits` 큐로 올려 결재 줄·알림 카드를 그대로 쓴다.
//! - `approvalPolicy`·`sandbox` 는 16장 V-C2 에 따라 `Mode::Ask` 는 `on-request` 만, `ReadOnly` 는 `never`+`read-only`, `UserDefault` 는 둘 다 생략(sandbox 는 사용자 config.toml 을 따름).
//! - 규칙: 대화 본문·명령·경로·RPC 내용은 로그에 넣지 않는다(method 이름·코드·종류만).

use crate::appserver::{AppServer, Incoming, RpcError, REQUEST_TIMEOUT};
use crate::chatlog::{self, HistPage};
use crate::runner::{tool_summary, truncate_bytes, AgentEvent, ErrCode, Mode, Outcome, ReqCtl, Runner, Service, ToolKind};
use crate::{permit, PermitHost};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// 기존 세션 등록에 필요한 스레드 정보.
pub struct Meta {
    pub cwd: String,
    pub title: String,
}

/// 모드 → (approvalPolicy, sandbox). sandbox 는 `ReadOnly` 만 지정한다(V-C2).
pub fn policy(mode: Mode) -> (Option<&'static str>, Option<&'static str>) {
    match mode {
        Mode::Ask | Mode::AcceptEdits => (Some("on-request"), None),
        Mode::ReadOnly => (Some("never"), Some("read-only")),
        Mode::UserDefault => (None, None),
    }
}

/// 스레드 시작·재개·복사 요청에 모드의 정책 필드를 덧붙인다.
fn with_policy(mut p: Value, mode: Mode) -> Value {
    let (approval, sandbox) = policy(mode);
    if let Some(a) = approval {
        p["approvalPolicy"] = json!(a);
    }
    if let Some(s) = sandbox {
        p["sandbox"] = json!(s);
    }
    p
}

/// RPC 오류 → 화면용 분류. 서버 오류 문구는 보지도 기록하지도 않고 코드로만 판단한다.
fn err_code(e: &RpcError) -> ErrCode {
    match e {
        RpcError::Closed => ErrCode::AppServerExit,
        RpcError::Timeout => ErrCode::Timeout,
        RpcError::Remote { code, .. } => {
            log::warn!("Codex RPC 오류 코드 {code}");
            ErrCode::Rpc
        }
    }
}

/// 요청 하나(응답이 오류면 분류해서 돌려줌).
fn call(srv: &AppServer, method: &str, params: Value) -> Result<Value, ErrCode> {
    srv.request(method, params, REQUEST_TIMEOUT).map_err(|e| err_code(&e))
}

/// 스레드 정보(작업 폴더·제목)를 읽는다(`thread/read`, 스레드를 로드하지 않음).
pub fn thread_meta(rt: &Arc<Runner>, id: &str) -> Result<Meta, ErrCode> {
    let srv = rt.codex_server(false)?;
    let r = call(&srv, "thread/read", json!({ "threadId": id, "includeTurns": false }))?;
    let t = r.get("thread").unwrap_or(&Value::Null);
    let cwd = t.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    if cwd.is_empty() {
        return Err(ErrCode::Rpc);
    }
    let title = t.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).or_else(|| t.get("preview").and_then(Value::as_str)).unwrap_or("");
    Ok(Meta { cwd, title: crate::runner::truncate(title.lines().next().unwrap_or("").trim(), 80) })
}

/// 지난 대화 한 페이지.
pub fn history(rt: &Arc<Runner>, id: &str, cursor: Option<&str>, limit: usize) -> Result<HistPage, ErrCode> {
    let srv = rt.codex_server(false)?;
    chatlog::codex_page(&srv, id, cursor, limit)
}

/// 응답의 `thread.id`.
fn thread_id(r: &Value) -> Result<String, ErrCode> {
    r.pointer("/thread/id").and_then(Value::as_str).map(str::to_string).ok_or(ErrCode::Rpc)
}

/// 새 스레드 시작 → 스레드 id. 사용자 동작이므로 시작 실패 이력을 지우고 다시 시도한다.
pub fn start_thread(rt: &Arc<Runner>, cwd: &Path, mode: Mode) -> Result<String, ErrCode> {
    let srv = rt.codex_server(true)?;
    let r = call(&srv, "thread/start", with_policy(json!({ "cwd": cwd.to_string_lossy() }), mode))?;
    thread_id(&r)
}

/// 스레드 복사(`thread/fork`) → 새 스레드 id.
pub fn fork_thread(rt: &Arc<Runner>, id: &str, mode: Mode) -> Result<String, ErrCode> {
    let srv = rt.codex_server(true)?;
    let r = call(&srv, "thread/fork", with_policy(json!({ "threadId": id, "excludeTurns": true }), mode))?;
    thread_id(&r)
}

/// 기존 스레드를 이 app-server 에 올린다(`thread/resume`, 기록은 읽지 않음).
pub fn resume_thread(rt: &Arc<Runner>, id: &str, mode: Mode) -> Result<(), ErrCode> {
    let srv = rt.codex_server(true)?;
    call(&srv, "thread/resume", with_policy(json!({ "threadId": id, "excludeTurns": true }), mode))?;
    Ok(())
}

/// 스레드 구독 해제(이미 서버가 없으면 아무것도 안 함).
pub fn unsubscribe(rt: &Arc<Runner>, id: &str) {
    let srv = rt.codex.lock().unwrap().server.clone();
    if let Some(srv) = srv.filter(|s| s.alive()) {
        let _ = srv.request("thread/unsubscribe", json!({ "threadId": id }), Duration::from_secs(5));
    }
}

/// 턴 시작(별도 스레드에서 호출): 필요하면 스레드를 올리고 `turn/start`. 실패는 `fail_start`.
pub fn send(rt: &Arc<Runner>, key: &str, text: &str) {
    let (id, mode, loaded) = {
        let g = rt.sessions.lock().unwrap();
        let Some(s) = g.get(key) else { return };
        (s.id.clone(), s.mode, s.codex_loaded)
    };
    let run = || -> Result<(), ErrCode> {
        let srv = rt.codex_server(true)?;
        if !loaded {
            call(&srv, "thread/resume", with_policy(json!({ "threadId": id, "excludeTurns": true }), mode))?;
            if let Some(s) = rt.sessions.lock().unwrap().get_mut(key) {
                s.codex_loaded = true;
            }
        }
        let r = call(&srv, "turn/start", json!({ "threadId": id, "input": [{ "type": "text", "text": text, "text_elements": [] }] }))?;
        if let Some(t) = r.pointer("/turn/id").and_then(Value::as_str) {
            if let Some(s) = rt.sessions.lock().unwrap().get_mut(key) {
                s.codex_turn = Some(t.to_string());
            }
        }
        Ok(())
    };
    if let Err(code) = run() {
        rt.fail_start(key, code);
    }
}

/// 진행 중 턴 중단(`turn/interrupt`). `turn/completed{interrupted}` 가 오면 상태 머신이 대기로 돌린다.
pub fn interrupt(rt: &Arc<Runner>, key: &str) {
    // turn/start 응답이 오기 전이면 잠깐 기다림
    let mut got = None;
    for _ in 0..20 {
        got = rt.sessions.lock().unwrap().get(key).map(|s| (s.id.clone(), s.codex_turn.clone()));
        if got.as_ref().is_none_or(|(_, t)| t.is_some()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let Some((id, Some(turn))) = got else { return };
    let srv = rt.codex.lock().unwrap().server.clone();
    if let Some(srv) = srv.filter(|s| s.alive()) {
        let _ = srv.request("turn/interrupt", json!({ "threadId": id, "turnId": turn }), Duration::from_secs(5));
    }
}

/// app-server 가 끝났을 때: 진행 중 턴은 실패 처리, 대기 승인은 거둔다.
pub fn on_exit(rt: &Arc<Runner>, srv: &Arc<AppServer>) {
    if rt.is_stopping() {
        return;
    }
    {
        let mut slot = rt.codex.lock().unwrap();
        if slot.server.as_ref().is_some_and(|s| Arc::ptr_eq(s, srv)) {
            slot.server = None;
        }
    }
    let active: Vec<(String, String)> = {
        let mut g = rt.sessions.lock().unwrap();
        let mut v = vec![];
        for s in g.values_mut().filter(|s| s.service == Service::Codex) {
            s.codex_loaded = false;
            for r in &s.reqs {
                r.cancel.store(true, Ordering::SeqCst);
            }
            if s.state.is_active() {
                v.push((s.key.clone(), s.turn.clone()));
            }
        }
        v
    };
    log::warn!("Codex app-server 종료 감지 — 진행 중 턴 {}개 실패 처리", active.len());
    for (key, turn) in active {
        rt.cancel_approvals(&key);
        rt.on_event(&key, AgentEvent::TurnEnd { turn, outcome: Outcome::Failed, error: Some(ErrCode::AppServerExit) });
    }
}

/// app-server 가 보낸 알림·서버 요청 분배(읽기 스레드에서 호출 — 서버 요청은 승인 대기가 길 수 있어 스레드를 따로 띄움).
pub fn on_incoming(rt: &Arc<Runner>, srv: &Arc<AppServer>, inc: Incoming) {
    match inc {
        Incoming::Notification { method, params } => on_notification(rt, &method, &params),
        Incoming::ServerRequest { id, method, params } => {
            let (rt, srv) = (rt.clone(), srv.clone());
            std::thread::spawn(move || on_server_request(&rt, &srv, &id, &method, &params));
        }
        _ => {}
    }
}

/// 열쇠로 쓰는 스레드 id → 세션 열쇠.
fn key_of(rt: &Runner, thread: &str) -> Option<String> {
    rt.sessions.lock().unwrap().values().find(|s| s.service == Service::Codex && s.id == thread).map(|s| s.key.clone())
}

/// 알림 → 공통 이벤트(3.5 표). 파일 수정 항목의 경로는 `files` 에 기억해 승인 카드 본문에 쓴다.
///
/// # 인자
/// - `method`: 알림 이름
/// - `p`: 알림 params
/// - `files`: itemId → 경로 목록(fileChange 시작 때 기록)
///
/// # 반환
/// 이벤트들(관심 없는 알림은 빈 목록).
pub fn map_notification(method: &str, p: &Value, files: &mut HashMap<String, Vec<String>>) -> Vec<AgentEvent> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "turn/started" => vec![AgentEvent::TurnStart { turn: p.pointer("/turn/id").and_then(Value::as_str).unwrap_or("").to_string() }],
        "item/agentMessage/delta" => vec![AgentEvent::Delta { item: s(p, "itemId"), text: s(p, "delta") }],
        "item/started" => {
            let it = p.get("item").unwrap_or(&Value::Null);
            let id = s(it, "id");
            match it.get("type").and_then(Value::as_str).unwrap_or("") {
                "commandExecution" => {
                    let (_, title, detail) = tool_summary("Bash", &json!({ "command": s(it, "command") }));
                    vec![AgentEvent::ToolStart { item: id, kind: ToolKind::Command, title, detail }]
                }
                "fileChange" => {
                    let paths = change_paths(it);
                    files.insert(id.clone(), paths.clone());
                    let names: Vec<String> = paths.iter().map(|x| x.rsplit(['\\', '/']).next().unwrap_or(x).to_string()).collect();
                    let title = if names.is_empty() { "파일 수정".to_string() } else { crate::runner::truncate(&names.join(", "), 80) };
                    vec![AgentEvent::ToolStart { item: id, kind: ToolKind::File, title, detail: truncate_bytes(&paths.join("\n"), 2048) }]
                }
                "mcpToolCall" => vec![AgentEvent::ToolStart {
                    item: id,
                    kind: ToolKind::Mcp,
                    title: format!("{}/{}", s(it, "server"), s(it, "tool")),
                    detail: it.get("arguments").map(|a| truncate_bytes(&a.to_string(), 600)).unwrap_or_default(),
                }],
                "webSearch" => {
                    let q = s(it, "query");
                    vec![AgentEvent::ToolStart { item: id, kind: ToolKind::Web, title: crate::runner::truncate(&q, 80), detail: truncate_bytes(&q, 600) }]
                }
                _ => vec![],
            }
        }
        "item/completed" => {
            let it = p.get("item").unwrap_or(&Value::Null);
            let id = s(it, "id");
            let ok = it.get("status").and_then(Value::as_str) == Some("completed");
            match it.get("type").and_then(Value::as_str).unwrap_or("") {
                "agentMessage" => vec![AgentEvent::Message { item: id, text: s(it, "text") }],
                "commandExecution" => {
                    let mut summary = truncate_bytes(&s(it, "aggregatedOutput"), 2048);
                    if summary.is_empty() {
                        if let Some(c) = it.get("exitCode").and_then(Value::as_i64).filter(|c| *c != 0) {
                            summary = format!("exit {c}");
                        }
                    }
                    vec![AgentEvent::ToolEnd { item: id, ok, summary }]
                }
                "fileChange" => {
                    files.remove(&id);
                    vec![AgentEvent::ToolEnd { item: id, ok, summary: String::new() }]
                }
                "mcpToolCall" => {
                    let summary = it.pointer("/error/message").and_then(Value::as_str).map(|m| truncate_bytes(m, 2048)).unwrap_or_default();
                    vec![AgentEvent::ToolEnd { item: id, ok, summary }]
                }
                "webSearch" => vec![AgentEvent::ToolEnd { item: id, ok: true, summary: String::new() }],
                _ => vec![],
            }
        }
        "thread/tokenUsage/updated" => {
            let last = p.pointer("/tokenUsage/last").unwrap_or(&Value::Null);
            let n = |k: &str| last.get(k).and_then(Value::as_u64).unwrap_or(0);
            let window = p.pointer("/tokenUsage/modelContextWindow").and_then(Value::as_f64).filter(|w| *w > 0.0);
            vec![AgentEvent::Usage {
                input: n("inputTokens"),
                output: n("outputTokens"),
                cached: n("cachedInputTokens"),
                cost_usd: None,
                context_pct: window.map(|w| (n("inputTokens") as f64 / w * 100.0).min(100.0)),
            }]
        }
        "turn/completed" => {
            let t = p.get("turn").unwrap_or(&Value::Null);
            let outcome = match t.get("status").and_then(Value::as_str).unwrap_or("") {
                "completed" => Outcome::Done,
                "interrupted" => Outcome::Interrupted,
                _ => Outcome::Failed,
            };
            let error = (outcome == Outcome::Failed).then(|| match t.pointer("/error/codexErrorInfo").and_then(Value::as_str).unwrap_or("") {
                "unauthorized" => ErrCode::Auth,
                "usageLimitExceeded" | "rateLimitExceeded" => ErrCode::Limit,
                _ => ErrCode::Unknown,
            });
            vec![AgentEvent::TurnEnd { turn: s(t, "id"), outcome, error }]
        }
        "error" if p.get("willRetry").and_then(Value::as_bool) == Some(true) => vec![AgentEvent::Notice { code: "retry".into() }],
        _ => vec![],
    }
}

/// `fileChange` 항목의 `changes[].path` 목록.
fn change_paths(it: &Value) -> Vec<String> {
    it.get("changes").and_then(Value::as_array).map(|c| c.iter().filter_map(|x| x.get("path").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default()
}

/// 알림 처리: 세션을 찾아 이벤트로 바꿔 올린다. `turn/started` 는 턴 id 를 기억하고, `serverRequest/resolved` 는 대기 승인을 풀어 준다.
pub fn on_notification(rt: &Arc<Runner>, method: &str, p: &Value) {
    let Some(thread) = p.get("threadId").and_then(Value::as_str) else { return };
    let Some(key) = key_of(rt, thread) else { return };
    if method == "serverRequest/resolved" {
        // 서버가 이미 처리한 요청 — 응답 없이 카드만 거둔다
        let rid = p.get("requestId").map(Value::to_string).unwrap_or_default();
        let g = rt.sessions.lock().unwrap();
        if let Some(s) = g.get(&key) {
            for r in s.reqs.iter().filter(|r| r.rid == rid) {
                r.resolved.store(true, Ordering::SeqCst);
            }
        }
        return;
    }
    let events = {
        let mut g = rt.sessions.lock().unwrap();
        let Some(s) = g.get_mut(&key) else { return };
        if method == "turn/started" {
            s.codex_turn = p.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
        }
        map_notification(method, p, &mut s.codex_files)
    };
    for ev in events {
        rt.on_event(&key, ev);
    }
}

// ── 서버 요청 ───────────────────────────────────────────────────────────────

/// 서버 요청 종류.
#[derive(Debug, PartialEq)]
pub enum ReqKind {
    Command,
    File,
    UserInput,
    Permissions,
    Elicitation,
    /// 카드 없이 `-32601` 로 거절하는 모든 요청(`item/tool/call`·`account/chatgptAuthTokens/refresh`·`attestation/generate`·`applyPatchApproval`·`execCommandApproval`·모르는 method).
    Unsupported,
}

/// method 이름으로 서버 요청 종류를 정한다.
pub fn req_kind(method: &str) -> ReqKind {
    match method {
        "item/commandExecution/requestApproval" => ReqKind::Command,
        "item/fileChange/requestApproval" => ReqKind::File,
        "item/tool/requestUserInput" => ReqKind::UserInput,
        "item/permissions/requestApproval" => ReqKind::Permissions,
        "mcpServer/elicitation/request" => ReqKind::Elicitation,
        _ => ReqKind::Unsupported,
    }
}

/// 폴더 경로 문자열의 마지막 이름.
fn project_name(cwd: &str) -> String {
    cwd.rsplit(['\\', '/']).find(|x| !x.is_empty()).unwrap_or("").to_string()
}

/// 승인 카드 공통 틀.
fn base_permit(kind: &'static str, tool: &str, project: String, detail: String, description: String, session: String, input: Value) -> permit::Permit {
    permit::Permit {
        id: String::new(),
        kind,
        provider: "chatgpt",
        project,
        tool: tool.to_string(),
        detail: crate::runner::truncate(&detail, 600),
        description,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        questions: Value::Null,
        session,
        tool_input: input,
    }
}

/// 명령 실행 승인 요청 → 카드(`Bash`, 본문 = 명령 600자, 설명 = reason).
pub fn permit_from_command(params: &Value, fallback_project: &str) -> permit::Permit {
    let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let cwd = s("cwd");
    let project = if cwd.is_empty() { fallback_project.to_string() } else { project_name(&cwd) };
    base_permit("tool", "Bash", project, s("command"), s("reason"), s("threadId"), params.clone())
}

/// 파일 수정 승인 요청 → 카드(`Edit`, 본문 = `item/started` 에서 기억한 경로 목록).
pub fn permit_from_file(params: &Value, paths: &[String], project: &str) -> permit::Permit {
    let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    base_permit("tool", "Edit", project.to_string(), paths.join("\n"), s("reason"), s("threadId"), params.clone())
}

/// 사용자 입력 요청 → 질문 카드. `questions` 는 `{header, question, options:[{label,description}], multiSelect:false}` 로 변환하고,
/// 원본 params(질문 id 포함)는 `tool_input` 에 둬서 답을 id 로 되돌린다.
pub fn permit_from_question(params: &Value, project: &str) -> permit::Permit {
    let qs: Vec<Value> = params
        .get("questions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|q| {
                    json!({
                        "header": q.get("header").cloned().unwrap_or(Value::Null),
                        "question": q.get("question").cloned().unwrap_or(Value::Null),
                        "options": q.get("options").cloned().filter(|o| o.is_array()).unwrap_or_else(|| json!([])),
                        "multiSelect": false
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut p = base_permit("question", "AskUserQuestion", project.to_string(), String::new(), String::new(), params.get("threadId").and_then(Value::as_str).unwrap_or("").to_string(), params.clone());
    p.questions = Value::Array(qs);
    p
}

/// 질문에 비밀 입력(`isSecret`)이 있는지 — 있으면 카드에 띄우지 않는다(알림 창·오피스에 평문 노출).
pub fn has_secret(params: &Value) -> bool {
    params.get("questions").and_then(Value::as_array).is_some_and(|a| a.iter().any(|q| q.get("isSecret").and_then(Value::as_bool).unwrap_or(false)))
}

/// 카드의 답(질문 문구 → 답)을 Codex 응답(`{answers:{<id>:{answers:[...]}}}`)으로 바꾼다.
///
/// # 인자
/// - `input`: 카드 결정이 돌려준 입력(원본 params + `answers`). `None` 이면 모두 빈 답.
pub fn answers_to_codex(input: Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    let empty = Value::Null;
    let input = input.unwrap_or(&empty);
    let answers = input.get("answers");
    for q in input.get("questions").and_then(Value::as_array).into_iter().flatten() {
        let (Some(id), text) = (q.get("id").and_then(Value::as_str), q.get("question").and_then(Value::as_str).unwrap_or("")) else { continue };
        let list: Vec<String> = match answers.and_then(|a| a.get(text)) {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
            _ => vec![],
        };
        out.insert(id.to_string(), json!({ "answers": list }));
    }
    json!({ "answers": Value::Object(out) })
}

/// 카드 결정 → 승인 응답 결과. 수락 `accept`, 거절 `decline`(턴 계속), 우리 쪽 중단·시간 초과 `cancel`(턴 중단).
pub fn approval_result(d: Option<&permit::Decision>) -> Value {
    json!({ "decision": match d { Some(permit::Decision::Allow(_)) => "accept", Some(permit::Decision::Deny) => "decline", None => "cancel" } })
}

/// 서버 요청 처리(별도 스레드). 승인류는 카드를 올려 최대 `CHAT_WAIT` 기다리고, 지원하지 않는 요청은 `-32601` 로 돌려보낸다.
pub fn on_server_request(rt: &Arc<Runner>, srv: &Arc<AppServer>, id: &Value, method: &str, params: &Value) {
    let kind = req_kind(method);
    if kind == ReqKind::Unsupported {
        log::debug!("app-server 서버 요청 미지원: {method}");
        srv.respond_err(id, -32601, "not supported");
        return;
    }
    let thread = params.get("threadId").and_then(Value::as_str).unwrap_or("");
    let Some(key) = key_of(rt, thread) else {
        // 우리가 모르는 스레드: 아무것도 허용하지 않는다
        match kind {
            ReqKind::Command | ReqKind::File => srv.respond(id, approval_result(None)),
            ReqKind::UserInput => srv.respond(id, answers_to_codex(None)),
            ReqKind::Permissions => srv.respond(id, json!({ "permissions": {} })),
            _ => srv.respond(id, json!({ "action": "decline" })),
        }
        return;
    };
    let (project, cwd, item_files) = {
        let g = rt.sessions.lock().unwrap();
        let s = g.get(&key);
        let item = params.get("itemId").and_then(Value::as_str).unwrap_or("");
        (
            s.map(|s| crate::runner::project_of(&s.cwd)).unwrap_or_default(),
            s.map(|s| s.cwd.to_string_lossy().to_string()).unwrap_or_default(),
            s.and_then(|s| s.codex_files.get(item).cloned()).unwrap_or_default(),
        )
    };
    let notice = |code: &str| rt.emit(&key, AgentEvent::Notice { code: code.into() });
    match kind {
        ReqKind::Permissions => {
            notice("perm_profile");
            srv.respond(id, json!({ "permissions": {} }));
        }
        ReqKind::Elicitation => {
            notice("elicitation");
            srv.respond(id, json!({ "action": "decline" }));
        }
        ReqKind::UserInput if has_secret(params) => {
            notice("secret_question");
            srv.respond(id, answers_to_codex(Some(params)));
        }
        ReqKind::Command | ReqKind::File | ReqKind::UserInput => {
            let Some(app) = rt.app() else {
                srv.respond(id, approval_result(None));
                return;
            };
            let host = PermitHost(app.clone());
            let permit = match kind {
                ReqKind::Command => permit_from_command(params, &project),
                ReqKind::File => permit_from_file(params, &item_files, &project),
                _ => permit_from_question(params, &project),
            };
            let question = permit.kind == "question";
            // 자동 수락(질문형 제외, 홈·드라이브 루트 제외)
            if !question && permit::Host::chat_auto_allow(&host, "chatgpt") && crate::runner::auto_allow_cwd_ok(&cwd) {
                log::info!("채팅 권한 요청 자동 수락: {} · {project}", permit.tool);
                permit::Host::auto_allowed(&host, &permit);
                srv.respond(id, approval_result(Some(&permit::Decision::Allow(None))));
                return;
            }
            let ctl = Arc::new(ReqCtl::new(id.to_string()));
            if let Some(s) = rt.sessions.lock().unwrap().get_mut(&key) {
                s.reqs.push(ctl.clone());
            }
            let c2 = ctl.clone();
            let (decision, _) = permit::wait_outcome(&host, permit, permit::CHAT_WAIT, move || c2.resolved.load(Ordering::SeqCst) || c2.cancel.load(Ordering::SeqCst));
            if let Some(s) = rt.sessions.lock().unwrap().get_mut(&key) {
                s.reqs.retain(|r| !Arc::ptr_eq(r, &ctl));
            }
            if ctl.resolved.load(Ordering::SeqCst) {
                return; // 서버가 이미 처리함 — 응답 불필요
            }
            if question {
                srv.respond(id, answers_to_codex(match &decision {
                    Some(permit::Decision::Allow(Some(input))) => Some(input),
                    _ => None,
                }));
            } else {
                srv.respond(id, approval_result(decision.as_ref()));
            }
        }
        ReqKind::Unsupported => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_policy_follows_v_c2() {
        assert_eq!(policy(Mode::Ask), (Some("on-request"), None));
        assert_eq!(policy(Mode::ReadOnly), (Some("never"), Some("read-only")));
        assert_eq!(policy(Mode::UserDefault), (None, None));
        let p = with_policy(json!({"cwd": "C:/x"}), Mode::Ask);
        assert_eq!(p["approvalPolicy"], "on-request");
        assert!(p.get("sandbox").is_none());
        let p = with_policy(json!({}), Mode::UserDefault);
        assert!(p.get("approvalPolicy").is_none() && p.get("sandbox").is_none());
    }

    #[test]
    fn command_approval_to_permit() {
        let params = json!({"itemId": "i1", "threadId": "th1", "turnId": "t1", "startedAtMs": 1, "command": "npm test", "cwd": "C:\\work\\proj", "reason": "테스트 실행"});
        let p = permit_from_command(&params, "fallback");
        assert_eq!((p.kind, p.provider, p.tool.as_str(), p.project.as_str()), ("tool", "chatgpt", "Bash", "proj"));
        assert_eq!((p.detail.as_str(), p.description.as_str(), p.session.as_str()), ("npm test", "테스트 실행", "th1"));
        // 본문은 600자 상한
        let long = json!({"command": "x".repeat(900), "threadId": "t"});
        assert_eq!(permit_from_command(&long, "p").detail.chars().count(), 600);
        // cwd 가 없으면 세션 프로젝트로
        assert_eq!(permit_from_command(&json!({"command": "ls", "threadId": "t"}), "fallback").project, "fallback");
    }

    #[test]
    fn file_approval_to_permit_uses_remembered_paths() {
        let mut files = HashMap::new();
        let ev = map_notification("item/started", &json!({"item": {"type": "fileChange", "id": "f1", "status": "inProgress", "changes": [{"path": "C:/x/a.rs"}, {"path": "C:/x/b.rs"}]}}), &mut files);
        assert!(matches!(&ev[0], AgentEvent::ToolStart { kind: ToolKind::File, .. }));
        let params = json!({"itemId": "f1", "threadId": "th1", "reason": "수정"});
        let p = permit_from_file(&params, &files["f1"], "proj");
        assert_eq!((p.tool.as_str(), p.detail.as_str(), p.project.as_str()), ("Edit", "C:/x/a.rs\nC:/x/b.rs", "proj"));
        let ev = map_notification("item/completed", &json!({"item": {"type": "fileChange", "id": "f1", "status": "completed", "changes": []}}), &mut files);
        assert_eq!(ev, vec![AgentEvent::ToolEnd { item: "f1".into(), ok: true, summary: String::new() }]);
        assert!(files.is_empty());
    }

    #[test]
    fn decisions_to_responses() {
        assert_eq!(approval_result(Some(&permit::Decision::Allow(None))), json!({"decision": "accept"}));
        assert_eq!(approval_result(Some(&permit::Decision::Deny)), json!({"decision": "decline"}));
        assert_eq!(approval_result(None), json!({"decision": "cancel"}));
    }

    #[test]
    fn question_answers_map_text_to_id() {
        let params = json!({
            "itemId": "i", "threadId": "th", "turnId": "t", "isBlocking": true,
            "questions": [
                {"id": "q1", "header": "범위", "question": "어디까지?", "options": [{"label": "전체", "description": "d"}], "isOther": true, "isSecret": false},
                {"id": "q2", "header": "형식", "question": "형식은?", "options": null, "isOther": false, "isSecret": false}
            ]
        });
        let p = permit_from_question(&params, "proj");
        assert_eq!(p.kind, "question");
        assert_eq!(p.questions[0]["question"], "어디까지?");
        assert_eq!(p.questions[0]["multiSelect"], false);
        assert_eq!(p.questions[1]["options"], json!([]));
        // 카드가 돌려준 입력 = 원본 params + answers(질문 문구 → 답)
        let mut input = p.tool_input.clone();
        input["answers"] = json!({"어디까지?": "전체", "형식은?": ["표", "목록"]});
        let r = answers_to_codex(Some(&input));
        assert_eq!(r, json!({"answers": {"q1": {"answers": ["전체"]}, "q2": {"answers": ["표", "목록"]}}}));
        // 답이 없으면 빈 답
        assert_eq!(answers_to_codex(Some(&params)), json!({"answers": {"q1": {"answers": []}, "q2": {"answers": []}}}));
        assert_eq!(answers_to_codex(None), json!({"answers": {}}));
        assert!(!has_secret(&params));
        assert!(has_secret(&json!({"questions": [{"id": "s", "isSecret": true}]})));
    }

    #[test]
    fn unknown_server_requests_get_32601() {
        for m in ["item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "applyPatchApproval", "execCommandApproval", "something/new"] {
            assert_eq!(req_kind(m), ReqKind::Unsupported, "{m}");
        }
        assert_eq!(req_kind("item/commandExecution/requestApproval"), ReqKind::Command);
        assert_eq!(req_kind("item/fileChange/requestApproval"), ReqKind::File);
        assert_eq!(req_kind("item/tool/requestUserInput"), ReqKind::UserInput);
        assert_eq!(req_kind("item/permissions/requestApproval"), ReqKind::Permissions);
        assert_eq!(req_kind("mcpServer/elicitation/request"), ReqKind::Elicitation);
        let line = crate::appserver::err_line(&json!(7), -32601, "not supported");
        assert_eq!(line, json!({"id": 7, "error": {"code": -32601, "message": "not supported"}}));
    }

    #[test]
    fn notifications_map_to_events() {
        let mut f = HashMap::new();
        assert_eq!(map_notification("turn/started", &json!({"threadId": "t", "turn": {"id": "turn1"}}), &mut f), vec![AgentEvent::TurnStart { turn: "turn1".into() }]);
        assert_eq!(
            map_notification("item/agentMessage/delta", &json!({"itemId": "m1", "delta": "안"}), &mut f),
            vec![AgentEvent::Delta { item: "m1".into(), text: "안".into() }]
        );
        assert_eq!(
            map_notification("item/completed", &json!({"item": {"type": "agentMessage", "id": "m1", "text": "안녕"}}), &mut f),
            vec![AgentEvent::Message { item: "m1".into(), text: "안녕".into() }]
        );
        let ev = map_notification("item/started", &json!({"item": {"type": "commandExecution", "id": "c1", "command": "ls -la", "status": "inProgress"}}), &mut f);
        assert_eq!(ev, vec![AgentEvent::ToolStart { item: "c1".into(), kind: ToolKind::Command, title: "ls -la".into(), detail: "ls -la".into() }]);
        let ev = map_notification("item/completed", &json!({"item": {"type": "commandExecution", "id": "c1", "status": "failed", "aggregatedOutput": "", "exitCode": 2}}), &mut f);
        assert_eq!(ev, vec![AgentEvent::ToolEnd { item: "c1".into(), ok: false, summary: "exit 2".into() }]);
        // reasoning 등은 무시
        assert!(map_notification("item/completed", &json!({"item": {"type": "reasoning", "id": "r"}}), &mut f).is_empty());
        let ev = map_notification("thread/tokenUsage/updated", &json!({"tokenUsage": {"last": {"inputTokens": 1000, "outputTokens": 20, "cachedInputTokens": 500, "totalTokens": 1020, "reasoningOutputTokens": 0}, "total": {}, "modelContextWindow": 100000}}), &mut f);
        match &ev[0] {
            AgentEvent::Usage { input, output, cached, context_pct, .. } => {
                assert_eq!((*input, *output, *cached), (1000, 20, 500));
                assert!((context_pct.unwrap() - 1.0).abs() < 1e-9);
            }
            e => panic!("{e:?}"),
        }
        let end = |status: &str, info: Value| map_notification("turn/completed", &json!({"turn": {"id": "t9", "status": status, "error": {"message": "x", "codexErrorInfo": info}}}), &mut HashMap::new());
        assert_eq!(end("completed", Value::Null), vec![AgentEvent::TurnEnd { turn: "t9".into(), outcome: Outcome::Done, error: None }]);
        assert_eq!(end("interrupted", Value::Null), vec![AgentEvent::TurnEnd { turn: "t9".into(), outcome: Outcome::Interrupted, error: None }]);
        assert_eq!(end("failed", json!("unauthorized")), vec![AgentEvent::TurnEnd { turn: "t9".into(), outcome: Outcome::Failed, error: Some(ErrCode::Auth) }]);
        assert_eq!(end("failed", json!("usageLimitExceeded")), vec![AgentEvent::TurnEnd { turn: "t9".into(), outcome: Outcome::Failed, error: Some(ErrCode::Limit) }]);
        assert_eq!(end("failed", json!("other")), vec![AgentEvent::TurnEnd { turn: "t9".into(), outcome: Outcome::Failed, error: Some(ErrCode::Unknown) }]);
        assert_eq!(map_notification("error", &json!({"willRetry": true}), &mut f), vec![AgentEvent::Notice { code: "retry".into() }]);
        assert!(map_notification("error", &json!({"willRetry": false}), &mut f).is_empty());
        assert!(map_notification("thread/status/changed", &json!({}), &mut f).is_empty());
    }
}
