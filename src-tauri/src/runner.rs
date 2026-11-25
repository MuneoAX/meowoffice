//! 채팅 실행기 공통 계층 — 오피스 채팅이 Claude(`claude -p`)·Codex(app-server)에 말을 걸고 답을 받는 통로.
//! 설계서: docs/CHAT-DESIGN.md. 세션은 Rust 가 소유하고 오피스 창은 붙었다 떼는 뷰다(창이 닫혀도 턴은 계속).
//!
//! - 공통 형식: `Service`·`SessionSpec`·`Mode`·`ChatState`·`AgentEvent`·`ErrCode`.
//! - 상태 머신: 순수 함수 `step` 하나로만 전이한다(8.1 표). 동시 실행 수(`Runner::active`)는 전이에서 자동으로 맞춘다(불변식 ≤ 3).
//! - 전달: 오피스 창으로 `chat` 이벤트 `{key, seq, ev}`. 현재 턴의 이벤트만 세션별 버퍼에 두고 본문은 디스크에 저장하지 않는다.
//! - 충돌 판정: 다른 프로세스가 쥐고 있을 수 있으면 보기만(4장). 탈출구는 사본으로 이어가기(`chat_fork`).
//! - 로그 규칙(10.1): 이 모듈 계열(`runner*`·`appserver`·`chatlog`)은 대화 본문·도구 입출력·명령·경로 전체·RPC 내용을 로그에 넣지 않는다.
//!   로그에는 `log_line` 등 요약 함수의 반환값(종류·글자 수)만 쓴다.

use crate::appserver::AppServer;
use crate::jobobj::Job;
use crate::{chatlog, codex, config, local, office, permit, runner_claude, runner_codex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 전체 동시 답변 수 상한(세션당 턴은 1개).
pub const MAX_ACTIVE_TURNS: usize = 3;
/// 현재 턴 이벤트 버퍼 상한(개수·바이트). 넘으면 이어진 `Delta` 를 합쳐 줄인다.
const LIVE_MAX_EVENTS: usize = 2000;
const LIVE_MAX_BYTES: usize = 1 << 20;
/// 턴이 끝난 뒤에도 세션을 "소유"로 보는 시간(늦게 도착하는 전역 훅 이벤트 흡수).
const OWNED_GRACE: Duration = Duration::from_secs(30);
/// 첫 이벤트가 이 시간 안에 안 오면 시작 실패(8.1).
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// 중단 요청 뒤 이 시간이 지나면 강제 종료(8.1).
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(5);
/// 턴 중 이 시간 동안 이벤트가 없으면 `Notice{quiet}` 만 표시.
const QUIET_NOTICE: Duration = Duration::from_secs(300);
/// 대기·보기만 세션이 이 시간 동안 조용하면 등록부에서 정리.
const PRUNE_AFTER: Duration = Duration::from_secs(2 * 3600);
/// 채팅 세션 목록(`chat_sessions`)에서 조용한 세션을 뺄 시간(7.6: 마지막 활동 후 30분).
const LIST_WINDOW: Duration = Duration::from_secs(30 * 60);
/// Codex 소유 스레드가 없고 이 시간 동안 요청이 없으면 app-server 종료.
const CODEX_IDLE: Duration = Duration::from_secs(600);

// ── 공통 형식 ───────────────────────────────────────────────────────────────

/// 대화 서비스. 고양이 열쇠 접두: Claude `L:`, Codex `P:chatgpt:`, Gemini `P:gemini:`.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Service {
    #[serde(alias = "Claude")]
    Claude,
    #[serde(alias = "chatgpt", alias = "Codex")]
    Codex,
    #[serde(alias = "Gemini")]
    Gemini,
}

impl Service {
    /// 사무실·권한 카드가 쓰는 서비스 이름: "claude" | "chatgpt" | "gemini".
    pub fn provider(self) -> &'static str {
        match self {
            Service::Claude => "claude",
            Service::Codex => "chatgpt",
            Service::Gemini => "gemini",
        }
    }

    /// 서비스 세션 id → 고양이 열쇠.
    pub fn key(self, id: &str) -> String {
        match self {
            Service::Claude => format!("L:{id}"),
            Service::Codex => format!("P:chatgpt:{id}"),
            Service::Gemini => format!("P:gemini:{id}"),
        }
    }

    /// 열쇠 → (서비스, 세션 id). 클라우드(`C:`)·모르는 접두는 None.
    pub fn parse_key(key: &str) -> Option<(Service, String)> {
        let (svc, id) = if let Some(id) = key.strip_prefix("L:") {
            (Service::Claude, id)
        } else if let Some(id) = key.strip_prefix("P:chatgpt:") {
            (Service::Codex, id)
        } else if let Some(id) = key.strip_prefix("P:gemini:") {
            (Service::Gemini, id)
        } else {
            return None;
        };
        (!id.is_empty()).then(|| (svc, id.to_string()))
    }
}

/// 승인 방식. Claude: Ask=manual / AcceptEdits / ReadOnly=plan / UserDefault=플래그 생략.
/// Codex: Ask·AcceptEdits=approvalPolicy on-request, ReadOnly=never+read-only, UserDefault=둘 다 생략.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// 결재 받기(기본).
    #[default]
    Ask,
    /// 파일 수정은 자동.
    #[serde(alias = "acceptEdits")]
    AcceptEdits,
    /// 읽기만.
    #[serde(alias = "readOnly")]
    ReadOnly,
    /// 사용자가 서비스 설정에 둔 값.
    #[serde(alias = "userDefault")]
    UserDefault,
}

/// 세션 생성 명세(설계서 3.2). `role`·`ephemeral` 은 회의실(2단계)이 쓸 자리로 1단계에서 미리 잡아 둔 것(아직 만드는 곳 없음).
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct SessionSpec {
    pub service: Service,
    pub cwd: PathBuf,
    pub resume: Option<String>,
    pub fork: bool,
    pub mode: Mode,
    pub role: Option<String>,
    pub ephemeral: bool,
}

/// 대화 세션 상태(8.1).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ChatState {
    ViewOnly,
    Idle,
    Sending,
    Streaming,
    AwaitingApproval,
    Interrupting,
    Error,
}

impl ChatState {
    /// 동시 실행 수에 들어가는 상태인지.
    pub fn is_active(self) -> bool {
        matches!(self, ChatState::Sending | ChatState::Streaming | ChatState::AwaitingApproval | ChatState::Interrupting)
    }
}

/// 도구 종류(대화 목록 아이콘용).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Command,
    File,
    Mcp,
    Web,
    Other,
}

/// 턴 결과.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Done,
    Failed,
    Interrupted,
}

/// 오류 분류. 문구는 UI 사전에서(문자열로 전달). 종료 코드 같은 세부는 로그에만.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ErrCode {
    Auth,
    Limit,
    NoCli,
    Spawn,
    ProcessExit,
    Timeout,
    AppServerExit,
    Rpc,
    Unknown,
}

impl ErrCode {
    /// 로그·이유 문자열용 이름(serde 이름과 같음).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrCode::Auth => "auth",
            ErrCode::Limit => "limit",
            ErrCode::NoCli => "no_cli",
            ErrCode::Spawn => "spawn",
            ErrCode::ProcessExit => "process_exit",
            ErrCode::Timeout => "timeout",
            ErrCode::AppServerExit => "app_server_exit",
            ErrCode::Rpc => "rpc",
            ErrCode::Unknown => "unknown",
        }
    }
}

/// 실행기 → UI 이벤트(설계서 3.2). `serde(tag = "t")`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    State { state: ChatState, reason: Option<String> },
    Rekey { to: String },
    UserMessage { id: String, text: String },
    TurnStart { turn: String },
    Delta { item: String, text: String },
    Message { item: String, text: String },
    ToolStart { item: String, kind: ToolKind, title: String, detail: String },
    ToolEnd { item: String, ok: bool, summary: String },
    Approval { permit: String, question: bool },
    ApprovalDone { permit: String },
    Usage { input: u64, output: u64, cached: u64, cost_usd: Option<f64>, context_pct: Option<f64> },
    TurnEnd { turn: String, outcome: Outcome, error: Option<ErrCode> },
    Notice { code: String },
}

/// 이벤트 요약(로그 전용). 종류와 글자 수만 — 본문·제목·상세·요약·질문은 절대 넣지 않는다.
///
/// # 인자
/// - `ev`: 이벤트
///
/// # 반환
/// 예: `delta len=12`, `tool_start kind=command`, `turn_end outcome=done`.
pub fn log_line(ev: &AgentEvent) -> String {
    let n = |s: &str| s.chars().count();
    match ev {
        AgentEvent::State { state, reason } => format!("state {:?} reason={}", state, reason.as_deref().unwrap_or("-")),
        AgentEvent::Rekey { .. } => "rekey".into(),
        AgentEvent::UserMessage { text, .. } => format!("user_message len={}", n(text)),
        AgentEvent::TurnStart { .. } => "turn_start".into(),
        AgentEvent::Delta { text, .. } => format!("delta len={}", n(text)),
        AgentEvent::Message { text, .. } => format!("message len={}", n(text)),
        AgentEvent::ToolStart { kind, title, detail, .. } => format!("tool_start kind={:?} title_len={} detail_len={}", kind, n(title), n(detail)),
        AgentEvent::ToolEnd { ok, summary, .. } => format!("tool_end ok={ok} summary_len={}", n(summary)),
        AgentEvent::Approval { question, .. } => format!("approval question={question}"),
        AgentEvent::ApprovalDone { .. } => "approval_done".into(),
        AgentEvent::Usage { input, output, cached, .. } => format!("usage in={input} out={output} cached={cached}"),
        AgentEvent::TurnEnd { outcome, error, .. } => format!("turn_end outcome={:?} error={}", outcome, error.map(|e| e.as_str()).unwrap_or("-")),
        AgentEvent::Notice { code } => format!("notice {code}"),
    }
}

// ── 상태 머신 ───────────────────────────────────────────────────────────────

/// 상태 전이를 일으키는 사건(8.1 표의 "사건" 열).
#[derive(Clone, Debug, PartialEq)]
pub enum Trigger {
    /// 보기만 상태의 주기 재판정(충돌 있음 여부).
    Recheck { conflict: bool },
    /// 사용자가 확인한 "여기서 이어받기".
    Takeover,
    /// `chat_send`(재판정 결과·동시 실행 여유).
    Send { conflict: bool, capacity: bool },
    /// 첫 `TurnStart`/`Delta` 등 턴 이벤트.
    FirstEvent,
    /// 시작 실패(실행 파일 없음·RPC 오류).
    StartFailed,
    /// 첫 이벤트 60초 대기 초과.
    SendTimeout,
    /// `chat_interrupt`.
    Interrupt,
    /// 승인 요청 도착.
    ApprovalOpen,
    /// 승인 요청 모두 해소(수락·거절·자동 수락·다른 곳에서 해소).
    ApprovalClosed,
    /// 승인 30분 초과.
    ApprovalTimeout,
    /// 턴 종료.
    TurnEnd(Outcome),
    /// 프로세스·app-server 죽음. 지금 어댑터는 `TurnEnd{failed}` 로 알리므로 아직 보내는 곳은 없지만 8.1 표의 행이라 상태 머신에 둔다.
    #[allow(dead_code)]
    ProcessDied,
    /// 중단 5초 초과.
    InterruptTimeout,
    /// `chat_open` 재진입(충돌 있음 여부).
    Reopen { conflict: bool },
}

/// 전이와 함께 호출한 쪽이 수행할 동작.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// 턴 시작(프로세스·RPC).
    StartTurn,
    /// 보기만이라 거부.
    RejectViewOnly,
    /// 동시 실행 초과로 거부.
    RejectBusy,
    /// 진행 중 턴 중단(프로세스 종료·turn/interrupt).
    KillTurn,
    /// 강제 종료(Codex: app-server 재시작).
    ForceKill,
    /// 대기 승인 제거(Codex 는 cancel 응답).
    CancelApprovals,
    /// 완료 보고(알림·간식).
    ReportDone,
    /// 승인 시간 초과 안내.
    NoticeApprovalTimeout,
    /// 불가능한 전이 — 아무것도 하지 않음.
    Ignore,
}

/// 상태 머신(설계서 8.1). 순수 함수 — 모든 상태 전이는 이 함수 하나로만 한다.
///
/// # 인자
/// - `state`: 현재 상태
/// - `t`: 사건
///
/// # 반환
/// (다음 상태, 동작 목록). 불가능한 전이는 (현재 상태, `[Ignore]`).
pub fn step(state: ChatState, t: &Trigger) -> (ChatState, Vec<Action>) {
    use Action::*;
    use ChatState as S;
    use Trigger as T;
    let ignore = (state, vec![Ignore]);
    match (state, t) {
        // 보기만
        (S::ViewOnly, T::Recheck { conflict: false }) => (S::Idle, vec![]),
        (S::ViewOnly, T::Recheck { conflict: true }) => (S::ViewOnly, vec![]),
        (S::ViewOnly, T::Takeover) => (S::Idle, vec![]),
        (S::ViewOnly, T::Send { .. }) => (S::ViewOnly, vec![RejectViewOnly]),
        (S::ViewOnly | S::Idle | S::Error, T::Reopen { conflict: true }) => (S::ViewOnly, vec![]),
        (S::ViewOnly | S::Idle | S::Error, T::Reopen { conflict: false }) => (S::Idle, vec![]),
        // 대기·오류에서 보내기
        (S::Idle | S::Error, T::Send { conflict: true, .. }) => (S::ViewOnly, vec![RejectViewOnly]),
        (S::Idle | S::Error, T::Send { capacity: false, .. }) => (state, vec![RejectBusy]),
        (S::Idle | S::Error, T::Send { .. }) => (S::Sending, vec![StartTurn]),
        // 보내는 중
        (S::Sending, T::FirstEvent) => (S::Streaming, vec![]),
        (S::Sending, T::StartFailed) => (S::Error, vec![]),
        (S::Sending, T::SendTimeout) => (S::Error, vec![KillTurn]),
        // 답변 중·보내는 중 공통
        (S::Sending | S::Streaming, T::Interrupt) => (S::Interrupting, vec![KillTurn]),
        (S::Sending | S::Streaming, T::ApprovalOpen) => (S::AwaitingApproval, vec![]),
        (S::Sending | S::Streaming | S::AwaitingApproval, T::TurnEnd(Outcome::Done)) => (S::Idle, vec![ReportDone]),
        (S::Sending | S::Streaming | S::AwaitingApproval, T::TurnEnd(Outcome::Failed)) => (S::Error, vec![]),
        (S::Sending | S::Streaming | S::AwaitingApproval, T::TurnEnd(Outcome::Interrupted)) => (S::Idle, vec![]),
        (S::Sending | S::Streaming, T::ProcessDied) => (S::Error, vec![CancelApprovals]),
        // 승인 대기
        (S::AwaitingApproval, T::ApprovalOpen) => (S::AwaitingApproval, vec![]),
        (S::AwaitingApproval, T::ApprovalClosed) => (S::Streaming, vec![]),
        (S::AwaitingApproval, T::ApprovalTimeout) => (S::Idle, vec![CancelApprovals, NoticeApprovalTimeout]),
        (S::AwaitingApproval, T::Interrupt) => (S::Interrupting, vec![CancelApprovals, KillTurn]),
        (S::AwaitingApproval, T::ProcessDied) => (S::Error, vec![CancelApprovals]),
        // 중단 중
        (S::Interrupting, T::TurnEnd(_) | T::ProcessDied) => (S::Idle, vec![CancelApprovals]),
        (S::Interrupting, T::InterruptTimeout) => (S::Idle, vec![ForceKill, CancelApprovals]),
        (S::Interrupting, T::ApprovalOpen | T::ApprovalClosed | T::FirstEvent) => (S::Interrupting, vec![]),
        _ => ignore,
    }
}

// ── 폴더 검사 ───────────────────────────────────────────────────────────────

/// 비교용 문자열: UNC 접두(`\\?\`) 제거, `/`→`\`, 소문자, 끝 구분자 제거.
fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix("\\\\?\\").filter(|r| !r.starts_with("UNC\\")).unwrap_or(&s).to_string();
    s.trim_end_matches('\\').to_lowercase()
}

/// `child` 가 `base` 와 같거나 그 아래인지(정규화된 문자열 비교).
fn is_under(child: &str, base: &str) -> bool {
    !base.is_empty() && (child == base || child.starts_with(&format!("{base}\\")))
}

/// 존재하면 정규화한 경로를 비교 문자열로 만든다.
fn norm_canon(p: &Path) -> String {
    norm(&std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
}

/// 드라이브 루트(상위가 없는 경로)인지.
fn is_root(p: &Path) -> bool {
    p.parent().is_none() || norm(p).len() <= 2
}

/// 작업 폴더 검사(10.3). 절대 경로 + 존재하는 폴더 + 정규화 성공이어야 하고, 드라이브 루트·홈 폴더 자체·시스템 폴더·설정/데이터 폴더 아래는 거부한다.
///
/// # 인자
/// - `path`: 검사할 경로
/// - `deny_under`: 그 아래를 거부할 폴더들
/// - `home`: 홈 폴더(자체를 거부)
///
/// # 반환
/// 정규화한 경로. 거부 사유는 코드 문자열(`bad_cwd`·`cwd_root`·`cwd_home`·`cwd_denied`).
pub fn check_cwd(path: &Path, deny_under: &[PathBuf], home: Option<&Path>) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() {
        return Err("bad_cwd");
    }
    let canon = std::fs::canonicalize(path).map_err(|_| "bad_cwd")?;
    if !canon.is_dir() {
        return Err("bad_cwd");
    }
    if is_root(&canon) {
        return Err("cwd_root");
    }
    let n = norm(&canon);
    if home.is_some_and(|h| norm_canon(h) == n) {
        return Err("cwd_home");
    }
    if deny_under.iter().any(|d| is_under(&n, &norm_canon(d))) {
        return Err("cwd_denied");
    }
    let s = canon.to_string_lossy();
    Ok(match s.strip_prefix("\\\\?\\") {
        Some(r) if !r.starts_with("UNC\\") => PathBuf::from(r),
        _ => canon,
    })
}

/// 실제 PC 의 거부 폴더 목록(시스템·Program Files·Claude/Codex/Gemini 설정·이 앱의 데이터·설치 폴더).
fn deny_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    for var in ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(p) = std::env::var_os(var).filter(|p| !p.is_empty()) {
            v.push(PathBuf::from(p));
        }
    }
    v.push(config::claude_dir(&config::load().config));
    if let Some(c) = codex::codex_home() {
        v.push(c);
    }
    if let Some(b) = directories::BaseDirs::new() {
        v.push(b.home_dir().join(".gemini"));
    }
    if let Some(d) = directories::ProjectDirs::from("co.kr", "muneo", "muneo-claude-usage-tray") {
        v.push(d.data_local_dir().to_path_buf());
        v.push(d.config_dir().to_path_buf());
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        v.push(d);
    }
    v
}

/// 홈 폴더.
fn home_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

/// 새 대화·이어가기에서 쓸 작업 폴더를 검사한다(실제 PC 기준).
pub fn check_cwd_real(path: &str) -> Result<PathBuf, &'static str> {
    check_cwd(Path::new(path.trim()), &deny_dirs(), home_dir().as_deref())
}

/// 자동 수락을 적용해도 되는 작업 폴더인지(5.1). 비었거나 홈·드라이브 루트면 false.
pub fn auto_allow_cwd_ok(cwd: &str) -> bool {
    if cwd.trim().is_empty() {
        return false;
    }
    let p = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    if is_root(&p) {
        return false;
    }
    !home_dir().is_some_and(|h| norm_canon(&h) == norm(&p))
}

// ── 보조 ────────────────────────────────────────────────────────────────────

/// 글자 수 기준으로 자른다(바이트 경계 안전).
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 앞 `max` 바이트(문자 경계로 내림)만 남긴다.
pub fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    s[..i].to_string()
}

/// 도구 이름·입력 → (종류, 제목, 상세). 상세는 명령·경로·주소(2KB 상한). 로그에는 쓰지 않는다.
pub fn tool_summary(name: &str, input: &Value) -> (ToolKind, String, String) {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let base = |p: &str| p.rsplit(['\\', '/']).find(|x| !x.is_empty()).unwrap_or(p).to_string();
    let first_line = |t: &str| truncate(t.lines().next().unwrap_or("").trim(), 80);
    let compact = || {
        let t = input.to_string();
        if t == "null" || t == "{}" {
            String::new()
        } else {
            truncate_bytes(&t, 600)
        }
    };
    match name {
        "Bash" | "PowerShell" => {
            let cmd = s("command").unwrap_or_default();
            let title = s("description").map(|d| truncate(&d, 80)).unwrap_or_else(|| first_line(&cmd));
            (ToolKind::Command, title, truncate_bytes(&cmd, 2048))
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let p = s("file_path").or_else(|| s("notebook_path")).unwrap_or_default();
            (ToolKind::File, format!("{name} {}", base(&p)), p)
        }
        "WebFetch" | "WebSearch" => {
            let d = s("url").or_else(|| s("query")).unwrap_or_default();
            (ToolKind::Web, format!("{name} {}", truncate(&d, 60)), truncate_bytes(&d, 600))
        }
        n if n.starts_with("mcp__") => (ToolKind::Mcp, n.trim_start_matches("mcp__").replace("__", "/"), compact()),
        _ => {
            let hint = s("file_path").or_else(|| s("pattern")).or_else(|| s("path")).or_else(|| s("query")).map(|d| base(&d)).unwrap_or_default();
            (ToolKind::Other, if hint.is_empty() { name.to_string() } else { format!("{name} {hint}") }, compact())
        }
    }
}

/// 프로세스 하나를 강제 종료(Job 이 없을 때의 대체 수단).
pub fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).output();
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// 난수 UUID v4 문자열. `config::new_token` 의 난수(16진 32자)를 UUID 형식으로 바꾼다(새 의존성 없음).
pub fn new_uuid() -> String {
    let h: Vec<char> = config::new_token().chars().collect();
    let variant = ['8', '9', 'a', 'b'][(h[16].to_digit(16).unwrap_or(0) % 4) as usize];
    let at = |a: usize, b: usize| h[a..b].iter().collect::<String>();
    format!("{}-{}-4{}-{}{}-{}", at(0, 8), at(8, 12), at(13, 16), variant, at(17, 20), at(20, 32))
}

/// 열쇠 앞 8자(로그용).
fn key8(key: &str) -> String {
    key.chars().take(8).collect()
}

/// 폴더 경로의 마지막 이름(프로젝트 표시용).
pub fn project_of(cwd: &Path) -> String {
    cwd.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// 현재 시각(RFC3339, 초 단위).
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Claude 기록 폴더 이름 규칙: 영숫자 외 문자를 `-` 로 바꾼다.
fn project_dir_name(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// ── 턴 제어·세션 ────────────────────────────────────────────────────────────

/// 진행 중 턴의 종료 수단. Claude 는 자식 프로세스(Job), Codex 는 쓰지 않는다.
pub struct TurnCtl {
    /// 종료 요청이 있었는지(프로세스가 아직 안 떠 있어도 뜨자마자 끝냄).
    pub killed: AtomicBool,
    proc: Mutex<Option<(u32, Option<Job>)>>,
}

impl TurnCtl {
    /// 새 제어 객체.
    pub fn new() -> Arc<TurnCtl> {
        Arc::new(TurnCtl { killed: AtomicBool::new(false), proc: Mutex::new(None) })
    }

    /// 띄운 자식 프로세스를 등록한다. 이미 종료 요청이 있었으면 바로 끝낸다.
    pub fn attach(&self, pid: u32, job: Option<Job>) {
        *self.proc.lock().unwrap() = Some((pid, job));
        if self.killed.load(Ordering::SeqCst) {
            self.kill();
        }
    }

    /// 자식 프로세스 트리를 끝낸다.
    pub fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        if let Some((pid, job)) = self.proc.lock().unwrap().as_ref() {
            match job {
                Some(j) => j.terminate(),
                None => kill_pid(*pid),
            }
        }
    }

    /// 이 턴의 모든 프로세스 pid — 등록된 자식 pid 와 Job 안의 후손들(없으면 자식 pid 만).
    pub fn pids(&self) -> Vec<u32> {
        let g = self.proc.lock().unwrap();
        let Some((pid, job)) = g.as_ref() else { return Vec::new() };
        let mut v = job.as_ref().map(Job::pids).unwrap_or_default();
        if !v.contains(pid) {
            v.push(*pid);
        }
        v
    }
}

/// Codex 서버 요청 하나(승인 대기)의 취소·해소 표식.
pub struct ReqCtl {
    /// 요청 id(JSON 문자열 표기) — `serverRequest/resolved` 와 대조.
    pub rid: String,
    /// 서버가 `serverRequest/resolved` 로 알림(응답 불필요).
    pub resolved: AtomicBool,
    /// 우리 쪽 중단(응답은 cancel).
    pub cancel: AtomicBool,
}

impl ReqCtl {
    /// 요청 id 로 새 표식.
    pub fn new(rid: String) -> ReqCtl {
        ReqCtl { rid, resolved: AtomicBool::new(false), cancel: AtomicBool::new(false) }
    }
}

/// 실행기가 아는 대화 세션 하나.
pub struct Session {
    pub key: String,
    pub service: Service,
    pub id: String,
    pub cwd: PathBuf,
    pub cwd_ok: bool,
    pub mode: Mode,
    pub state: ChatState,
    pub why: Option<String>,
    pub title: String,
    pub started_at: String,
    pub last_at: String,
    pub last_touch: Instant,
    seq: u64,
    live: VecDeque<(u64, AgentEvent)>,
    live_bytes: usize,
    /// Claude: 첫 턴이 이 세션에서 갈라져 나옴(`--resume <원본> --fork-session`).
    pub fork_src: Option<String>,
    /// Claude: 기록이 생겼는지(init 을 본 뒤) — 이후 턴은 `--resume`.
    pub started: bool,
    /// Claude: 이 폴더의 설정·MCP 를 불러도 되는지(10.3).
    pub trusted: bool,
    pub ctl: Option<Arc<TurnCtl>>,
    /// 직전 턴 프로세스들(자식·후손)의 pid — 턴이 끝난 직후 아직 사라지지 않은 세션 파일을 "다른 프로세스"로 오판하지 않으려고 20초 동안 제외에 쓴다.
    pub last_pids: Vec<u32>,
    pub approvals: HashSet<String>,
    pub turn_no: u32,
    pub turn: String,
    pub codex_turn: Option<String>,
    pub codex_loaded: bool,
    pub codex_files: HashMap<String, Vec<String>>,
    pub reqs: Vec<Arc<ReqCtl>>,
    pub last_event: Instant,
    pub last_end: Option<Instant>,
    pub interrupting_since: Option<Instant>,
    pub quiet_noted: bool,
    pub warned_writer: bool,
    /// 이미 있던 세션을 보려고 열기만 해서 등록됨(ensure_session). 이 앱에서 턴을 한 번도 보내지 않았으면 chat_sessions 에 올리지 않는다 —
    /// 고양이를 누르기만 해도 진행 시간·마지막 갱신이 누른 시각으로 덮이고 퇴근이 늦어지던 문제.
    pub adopted: bool,
}

impl Session {
    /// 새 세션(대기 상태).
    pub fn new(service: Service, id: &str, cwd: PathBuf, cwd_ok: bool, mode: Mode, title: String, trusted: bool) -> Session {
        let now = now_iso();
        Session {
            key: service.key(id),
            service,
            id: id.to_string(),
            cwd,
            cwd_ok,
            mode,
            state: ChatState::Idle,
            why: None,
            title,
            started_at: now.clone(),
            last_at: now,
            last_touch: Instant::now(),
            seq: 0,
            live: VecDeque::new(),
            live_bytes: 0,
            fork_src: None,
            started: false,
            trusted,
            ctl: None,
            last_pids: Vec::new(),
            approvals: HashSet::new(),
            turn_no: 0,
            turn: String::new(),
            codex_turn: None,
            codex_loaded: false,
            codex_files: HashMap::new(),
            reqs: vec![],
            last_event: Instant::now(),
            last_end: None,
            interrupting_since: None,
            quiet_noted: false,
            warned_writer: false,
            adopted: false,
        }
    }

    /// 이벤트 한 개를 버퍼에 쌓고 seq 를 매긴다. 버퍼가 상한을 넘으면 이어진 `Delta` 를 합친다.
    ///
    /// # 반환
    /// 매긴 seq.
    fn push(&mut self, ev: AgentEvent) -> u64 {
        self.seq += 1;
        self.last_at = now_iso();
        self.last_touch = Instant::now();
        self.live_bytes += event_bytes(&ev);
        self.live.push_back((self.seq, ev));
        if self.live.len() > LIVE_MAX_EVENTS || self.live_bytes > LIVE_MAX_BYTES {
            self.compact();
        }
        self.seq
    }

    /// 같은 항목의 이어진 `Delta` 를 하나로 합친다(압축).
    fn compact(&mut self) {
        let mut out: VecDeque<(u64, AgentEvent)> = VecDeque::with_capacity(self.live.len());
        for (seq, ev) in self.live.drain(..) {
            if let (AgentEvent::Delta { item, text }, Some((pseq, AgentEvent::Delta { item: pitem, text: ptext }))) = (&ev, out.back_mut()) {
                if item == pitem {
                    ptext.push_str(text);
                    *pseq = seq;
                    continue;
                }
            }
            out.push_back((seq, ev));
        }
        self.live_bytes = out.iter().map(|(_, e)| event_bytes(e)).sum();
        self.live = out;
    }
}

/// 이벤트가 차지하는 대략의 바이트(버퍼 상한 계산용).
fn event_bytes(ev: &AgentEvent) -> usize {
    64 + match ev {
        AgentEvent::Delta { text, .. } | AgentEvent::Message { text, .. } | AgentEvent::UserMessage { text, .. } => text.len(),
        AgentEvent::ToolStart { title, detail, .. } => title.len() + detail.len(),
        AgentEvent::ToolEnd { summary, .. } => summary.len(),
        _ => 0,
    }
}

/// Codex app-server 보관함.
#[derive(Default)]
pub struct CodexSlot {
    pub server: Option<Arc<AppServer>>,
    /// 최근 시작 실패 시각들(5분 안 3번이면 사용자 재시도 전까지 자동 시작 안 함).
    pub fails: Vec<Instant>,
    pub last_used: Option<Instant>,
    /// 어떤 스레드가 app-server 를 시작하는 중(락 밖에서 시작하므로 중복 시작을 막는 표식).
    pub starting: bool,
}

/// 충돌 판정에 쓰는 세션 사본(잠금 밖에서 파일을 읽기 위해).
struct Snap {
    service: Service,
    id: String,
    cwd_ok: bool,
    child_pids: Vec<u32>,
    turn_active: bool,
    own_recent: bool,
    codex_loaded: bool,
}

/// 채팅 실행기(앱에 하나). `AppState.runner` 에 들어 있다.
pub struct Runner {
    pub sessions: Mutex<HashMap<String, Session>>,
    active: AtomicUsize,
    /// 서비스 세션 id → None(턴 진행 중) | Some(끝난 시각). 전역 훅 중복 방지용(`is_owned`).
    owned: Mutex<HashMap<String, Option<Instant>>>,
    pub codex: Mutex<CodexSlot>,
    app: OnceLock<AppHandle>,
    stopping: AtomicBool,
}

impl Runner {
    /// 빈 실행기.
    pub fn new() -> Arc<Runner> {
        Arc::new(Runner {
            sessions: Mutex::new(HashMap::new()),
            active: AtomicUsize::new(0),
            owned: Mutex::new(HashMap::new()),
            codex: Mutex::new(CodexSlot::default()),
            app: OnceLock::new(),
            stopping: AtomicBool::new(false),
        })
    }

    /// 앱 핸들을 붙이고 감시 스레드를 시작한다(setup 에서 1회).
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
        let rt = self.clone();
        std::thread::spawn(move || {
            let mut tick = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                if rt.stopping.load(Ordering::SeqCst) {
                    return;
                }
                tick += 1;
                rt.tick(tick);
            }
        });
    }

    /// 앱 종료 정리 중인지.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// 앱 핸들(시작 전이면 None).
    pub fn app(&self) -> Option<&AppHandle> {
        self.app.get()
    }

    /// 지금 답변 중인 턴 수.
    pub fn active_count(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    // ── 소유 세션(훅 중복 방지) ─────────────────────────────────────────────

    /// 이 서비스 세션 id 를 실행기가 소유 중인지(턴 진행 중이거나 끝난 지 `OWNED_GRACE` 이내).
    pub fn is_owned(&self, id: &str) -> bool {
        match self.owned.lock().unwrap().get(id) {
            Some(None) => true,
            Some(Some(t)) => t.elapsed() < OWNED_GRACE,
            None => false,
        }
    }

    /// 이 서비스 세션 id 의 대화가 읽기 전용 모드인지(없는 세션이면 false).
    pub fn is_readonly(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().values().any(|s| s.id == id && s.mode == Mode::ReadOnly)
    }

    fn own(&self, id: &str) {
        self.owned.lock().unwrap().insert(id.to_string(), None);
    }

    fn disown_later(&self, id: &str) {
        if let Some(v) = self.owned.lock().unwrap().get_mut(id) {
            *v = Some(Instant::now());
        }
    }

    // ── 이벤트·전이 ─────────────────────────────────────────────────────────

    /// 이벤트를 세션 버퍼에 쌓고 오피스 창에 보낸다(잠금을 쥔 채 호출).
    fn emit_in(&self, s: &mut Session, ev: AgentEvent) {
        if !matches!(ev, AgentEvent::Delta { .. }) {
            log::debug!("채팅 {} · {}", key8(&s.key), log_line(&ev));
        }
        let payload = json!({ "key": s.key, "ev": ev });
        let seq = s.push(ev);
        if let Some(app) = self.app.get() {
            let mut p = payload;
            p["seq"] = json!(seq);
            let _ = app.emit_to(office::LABEL, "chat", p);
        }
    }

    /// 상태 머신을 한 번 돌린다(잠금을 쥔 채). 상태가 바뀌면 동시 실행 수를 맞추고 `State` 이벤트를 낸다.
    fn apply_in(&self, s: &mut Session, t: &Trigger, reason: Option<&str>) -> Vec<Action> {
        let (next, acts) = step(s.state, t);
        if next != s.state {
            match (s.state.is_active(), next.is_active()) {
                (false, true) => {
                    self.active.fetch_add(1, Ordering::SeqCst);
                }
                (true, false) => {
                    // 활성 상태를 벗어나는 모든 전이에서 소유 표식을 시한부로 바꾼다(시간 초과 등 `TurnEnd` 없이 끝나는 경로 포함).
                    self.disown_later(&s.id);
                    // 증감은 모두 세션 잠금 안에서만 일어나므로 읽고 빼도 경쟁이 없다.
                    if self.active.load(Ordering::SeqCst) > 0 {
                        self.active.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                _ => {}
            }
            s.state = next;
            s.why = reason.map(str::to_string);
            if next == ChatState::Interrupting {
                s.interrupting_since = Some(Instant::now());
            }
            self.emit_in(s, AgentEvent::State { state: next, reason: reason.map(str::to_string) });
        }
        acts
    }

    /// 열쇠로 세션을 찾아 상태 머신을 돌리고 동작을 수행한다.
    fn apply(self: &Arc<Self>, key: &str, t: Trigger, reason: Option<&str>) {
        let acts = {
            let mut g = self.sessions.lock().unwrap();
            match g.get_mut(key) {
                Some(s) => self.apply_in(s, &t, reason),
                None => return,
            }
        };
        self.run_actions(key, acts);
    }

    /// 상태 머신이 돌려준 동작을 수행한다(잠금 밖).
    fn run_actions(self: &Arc<Self>, key: &str, acts: Vec<Action>) {
        for a in acts {
            match a {
                Action::KillTurn => self.kill_turn(key),
                Action::ForceKill => self.force_kill(key),
                Action::CancelApprovals => self.cancel_approvals(key),
                Action::ReportDone => self.report_done(key),
                Action::NoticeApprovalTimeout => self.emit(key, AgentEvent::Notice { code: "approval_timeout".into() }),
                Action::StartTurn | Action::RejectViewOnly | Action::RejectBusy | Action::Ignore => {}
            }
        }
    }

    /// 이벤트를 하나 내보낸다(버퍼·오피스 창).
    pub fn emit(&self, key: &str, ev: AgentEvent) {
        let mut g = self.sessions.lock().unwrap();
        if let Some(s) = g.get_mut(key) {
            self.emit_in(s, ev);
        }
    }

    /// 어댑터가 올리는 이벤트의 공통 처리: 쌓고 보낸 뒤 상태 머신에 반영한다(`TurnEnd` 는 끝 처리 포함).
    pub fn on_event(self: &Arc<Self>, key: &str, ev: AgentEvent) {
        self.on_event_turn(key, None, ev);
    }

    /// `on_event` 에 턴 표식을 더한 것. `turn` 이 있고 세션의 현재 턴(`Session::turn`)과 다르면 이전 턴 스레드가 늦게 올린 이벤트라 버린다
    /// (시간 초과로 끝난 뒤 새 `chat_send` 로 시작한 턴을 이전 턴의 `TurnEnd` 가 끊지 않게). Codex 는 `codex_turn` 으로 이미 거르므로 None.
    pub fn on_event_turn(self: &Arc<Self>, key: &str, turn: Option<&str>, ev: AgentEvent) {
        let trig = match &ev {
            AgentEvent::TurnStart { .. }
            | AgentEvent::Delta { .. }
            | AgentEvent::Message { .. }
            | AgentEvent::ToolStart { .. }
            | AgentEvent::ToolEnd { .. }
            | AgentEvent::Usage { .. } => Some(Trigger::FirstEvent),
            AgentEvent::TurnEnd { outcome, .. } => Some(Trigger::TurnEnd(*outcome)),
            _ => None,
        };
        let end = match &ev {
            AgentEvent::TurnEnd { outcome, error, .. } => Some((*outcome, *error)),
            _ => None,
        };
        let acts = {
            let mut g = self.sessions.lock().unwrap();
            let Some(s) = g.get_mut(key) else { return };
            if turn.is_some_and(|t| t != s.turn) {
                log::debug!("채팅 {} 지난 턴 이벤트 버림", key8(&s.key));
                return;
            }
            s.last_event = Instant::now();
            s.quiet_noted = false;
            self.emit_in(s, ev);
            let reason = end.and_then(|(_, e)| e).map(|e| e.as_str());
            let acts = match &trig {
                Some(t) => self.apply_in(s, t, reason),
                None => vec![],
            };
            if let Some((outcome, _)) = end {
                s.last_end = Some(Instant::now());
                s.last_pids = s.ctl.as_ref().map(|c| c.pids()).unwrap_or_default();
                s.ctl = None;
                s.codex_turn = None;
                s.approvals.clear();
                s.reqs.clear();
                s.interrupting_since = None;
                if outcome == Outcome::Done {
                    s.live.clear();
                    s.live_bytes = 0;
                }
                self.disown_later(&s.id);
            }
            acts
        };
        self.run_actions(key, acts);
    }

    /// 시작 실패(실행 파일 없음·RPC 오류 등): 보내는 중 → 오류.
    pub fn fail_start(self: &Arc<Self>, key: &str, code: ErrCode) {
        log::warn!("채팅 {} 시작 실패: {}", key8(key), code.as_str());
        {
            let mut g = self.sessions.lock().unwrap();
            if let Some(s) = g.get_mut(key) {
                s.ctl = None;
                self.disown_later(&s.id);
            }
        }
        self.apply(key, Trigger::StartFailed, Some(code.as_str()));
    }

    /// Claude: 첫 `init` 을 본 뒤 호출 — 기록이 생겼음을 표시하고 갈라 나온 출처를 지운다. id 가 다르면 열쇠를 바꾼다.
    pub fn mark_started(&self, key: &str, session_id: &str) -> String {
        let mut g = self.sessions.lock().unwrap();
        let Some(mut s) = g.remove(key) else { return key.to_string() };
        s.started = true;
        s.fork_src = None;
        if !session_id.is_empty() && s.id != session_id {
            self.owned.lock().unwrap().insert(session_id.to_string(), None);
            s.id = session_id.to_string();
            s.key = s.service.key(session_id);
            let to = s.key.clone();
            self.emit_in(&mut s, AgentEvent::Rekey { to: to.clone() });
            g.insert(to.clone(), s);
            return to;
        }
        g.insert(key.to_string(), s);
        key.to_string()
    }

    /// 승인 카드 수명 사건(`permit::Host::chat_approval` 이 호출). `sid` = 서비스 세션 id.
    pub fn on_approval(self: &Arc<Self>, sid: &str, ev: permit::ChatApproval) {
        use permit::ChatApproval as A;
        let acts = {
            let mut g = self.sessions.lock().unwrap();
            let Some(s) = g.values_mut().find(|s| s.id == sid) else { return };
            match ev {
                A::Open { id, question } => {
                    s.approvals.insert(id.clone());
                    let a = self.apply_in(s, &Trigger::ApprovalOpen, None);
                    self.emit_in(s, AgentEvent::Approval { permit: id, question });
                    a
                }
                A::Closed { id } => {
                    let had = s.approvals.remove(&id);
                    if had {
                        self.emit_in(s, AgentEvent::ApprovalDone { permit: id });
                    }
                    if s.approvals.is_empty() {
                        self.apply_in(s, &Trigger::ApprovalClosed, None)
                    } else {
                        vec![]
                    }
                }
                A::TimedOut { id } => {
                    s.approvals.remove(&id);
                    self.emit_in(s, AgentEvent::ApprovalDone { permit: id });
                    s.approvals.clear();
                    self.apply_in(s, &Trigger::ApprovalTimeout, None)
                }
            }
        };
        let key = self.sessions.lock().unwrap().values().find(|s| s.id == sid).map(|s| s.key.clone());
        if let Some(k) = key {
            self.run_actions(&k, acts);
        }
    }

    /// 진행 중 턴 중단: Claude 는 프로세스 트리 종료, Codex 는 `turn/interrupt`.
    fn kill_turn(self: &Arc<Self>, key: &str) {
        let (service, ctl) = {
            let g = self.sessions.lock().unwrap();
            match g.get(key) {
                Some(s) => (s.service, s.ctl.clone()),
                None => return,
            }
        };
        match service {
            Service::Claude => {
                if let Some(c) = ctl {
                    c.kill();
                }
            }
            Service::Codex => {
                let rt = self.clone();
                let key = key.to_string();
                std::thread::spawn(move || runner_codex::interrupt(&rt, &key));
            }
            Service::Gemini => {}
        }
    }

    /// 강제 종료: Claude 는 다시 프로세스 종료, Codex 는 app-server 를 끝낸다(다음 사용 때 다시 시작).
    fn force_kill(self: &Arc<Self>, key: &str) {
        let (service, ctl) = {
            let g = self.sessions.lock().unwrap();
            match g.get(key) {
                Some(s) => (s.service, s.ctl.clone()),
                None => return,
            }
        };
        match service {
            Service::Claude => {
                if let Some(c) = ctl {
                    c.kill();
                }
            }
            Service::Codex => {
                let srv = self.codex.lock().unwrap().server.clone();
                if let Some(srv) = srv {
                    srv.kill();
                }
            }
            Service::Gemini => {}
        }
    }

    /// 이 세션의 대기 승인을 모두 거둔다(권한 목록에서 제거 → 기다리던 스레드가 풀림. Codex 는 cancel 응답).
    pub fn cancel_approvals(&self, key: &str) {
        let (sid, reqs) = {
            let g = self.sessions.lock().unwrap();
            match g.get(key) {
                Some(s) => (s.id.clone(), s.reqs.clone()),
                None => return,
            }
        };
        for r in reqs {
            r.cancel.store(true, Ordering::SeqCst);
        }
        if let Some(app) = self.app.get() {
            let changed = app.state::<crate::AppState>().permits.lock().unwrap().drop_session(&sid);
            if changed {
                permit::Host::changed(&crate::PermitHost(app.clone()));
            }
        }
    }

    /// 완료 보고(알림·간식). 중단·실패는 보고하지 않는다.
    fn report_done(&self, key: &str) {
        let (service, id, project) = {
            let g = self.sessions.lock().unwrap();
            match g.get(key) {
                Some(s) => (s.service, s.id.clone(), project_of(&s.cwd)),
                None => return,
            }
        };
        if let Some(app) = self.app.get() {
            crate::chat_turn_done(app, service.provider(), &id, &project);
        }
    }

    // ── 충돌 판정(4장) ──────────────────────────────────────────────────────

    /// 세션 사본을 뜬다.
    fn snap(&self, key: &str) -> Option<Snap> {
        let g = self.sessions.lock().unwrap();
        let s = g.get(key)?;
        Some(Snap {
            service: s.service,
            id: s.id.clone(),
            cwd_ok: s.cwd_ok,
            child_pids: match s.ctl.as_ref().map(|c| c.pids()).filter(|v| !v.is_empty()) {
                Some(v) => v,
                None if s.last_end.is_some_and(|t| t.elapsed() < Duration::from_secs(20)) => s.last_pids.clone(),
                None => Vec::new(),
            },
            turn_active: s.state.is_active(),
            own_recent: s.last_end.is_some_and(|t| t.elapsed() < Duration::from_secs(20)),
            codex_loaded: s.codex_loaded,
        })
    }

    /// 충돌 판정. 충돌이 있으면 사유 코드(`open_elsewhere`·`just_written`·`in_use`·`maybe_open`·`sub_agent`·`bad_cwd`), 없으면 None.
    fn judge(&self, sn: &Snap) -> Option<String> {
        if !sn.cwd_ok {
            return Some("bad_cwd".into());
        }
        match sn.service {
            Service::Claude => {
                let dir = config::claude_dir(&config::load().config);
                let exclude = &sn.child_pids;
                if local::session_owner(&dir, &sn.id, exclude).is_some() {
                    return Some("open_elsewhere".into());
                }
                if sn.turn_active || sn.own_recent {
                    return None;
                }
                let fresh = local::find_transcript(&dir, &sn.id)
                    .and_then(|p| std::fs::metadata(p).ok())
                    .and_then(|m| m.modified().ok())
                    .is_some_and(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(15));
                fresh.then(|| "just_written".into())
            }
            Service::Codex => {
                if sn.codex_loaded {
                    return None;
                }
                match codex::session_activity(&sn.id) {
                    codex::Activity::Sub => Some("sub_agent".into()),
                    codex::Activity::Busy => Some("in_use".into()),
                    codex::Activity::Idle => Some("maybe_open".into()),
                    codex::Activity::Quiet => None,
                }
            }
            Service::Gemini => Some("unsupported".into()),
        }
    }

    // ── Tauri 명령 본체 ─────────────────────────────────────────────────────

    /// 기존 세션을 읽어 등록한다(없으면 `not_found`). 프로세스는 띄우지 않는다.
    fn ensure_session(self: &Arc<Self>, key: &str) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(key) {
            return Ok(());
        }
        let (svc, id) = Service::parse_key(key).ok_or("not_found")?;
        let s = match svc {
            Service::Claude => {
                let dir = config::claude_dir(&config::load().config);
                let path = local::find_transcript(&dir, &id).ok_or("not_found")?;
                let meta = chatlog::claude_meta(&path).ok_or("not_found")?;
                let (cwd, ok) = match check_cwd_real(&meta.cwd) {
                    Ok(p) => (p, true),
                    Err(_) => (PathBuf::from(&meta.cwd), false),
                };
                let mut s = Session::new(svc, &id, cwd, ok, Mode::Ask, meta.title, true);
                s.started = true;
                s.adopted = true;
                s
            }
            Service::Codex => {
                let m = runner_codex::thread_meta(self, &id).map_err(|e| e.as_str().to_string())?;
                let (cwd, ok) = match check_cwd_real(&m.cwd) {
                    Ok(p) => (p, true),
                    Err(_) => (PathBuf::from(&m.cwd), false),
                };
                let mut s = Session::new(svc, &id, cwd, ok, Mode::Ask, m.title, true);
                s.adopted = true;
                s
            }
            Service::Gemini => return Err("unsupported".into()),
        };
        self.sessions.lock().unwrap().entry(key.to_string()).or_insert(s);
        Ok(())
    }

    /// `chat_open`: 충돌 판정 후 현재 상태·진행 중 턴 이벤트를 돌려준다. 프로세스는 띄우지 않는다.
    pub fn chat_open(self: &Arc<Self>, key: &str) -> Result<Value, String> {
        if key.starts_with("C:") {
            return Ok(json!({
                "state": ChatState::ViewOnly, "can_send": false, "why": "cloud", "live": [], "seq": 0,
                "meta": { "key": key, "service": "claude", "provider": "claude", "cloud": true }
            }));
        }
        self.ensure_session(key)?;
        let conflict = self.snap(key).and_then(|sn| self.judge(&sn));
        let acts = {
            let mut g = self.sessions.lock().unwrap();
            let s = g.get_mut(key).ok_or("not_found")?;
            let acts = self.apply_in(s, &Trigger::Reopen { conflict: conflict.is_some() }, conflict.as_deref());
            if conflict.is_none() && s.state == ChatState::Idle {
                s.why = None;
            }
            acts
        };
        self.run_actions(key, acts);
        let g = self.sessions.lock().unwrap();
        let s = g.get(key).ok_or("not_found")?;
        let live: Vec<Value> = s.live.iter().map(|(seq, ev)| json!({ "key": s.key, "seq": seq, "ev": ev })).collect();
        Ok(json!({
            "state": s.state,
            "can_send": s.state == ChatState::Idle,
            "why": s.why,
            "live": live,
            "seq": s.seq,
            "meta": {
                "key": s.key, "service": s.service, "provider": s.service.provider(), "id": s.id,
                "cwd": s.cwd.to_string_lossy(), "project": project_of(&s.cwd), "title": s.title, "mode": s.mode,
                "trusted": s.trusted, "can_takeover": s.service == Service::Codex && s.why.as_deref() == Some("maybe_open"),
                "turn_active": s.state.is_active(), "started_at": s.started_at, "last_at": s.last_at,
            }
        }))
    }

    /// `chat_sessions`: 실행기가 아는 세션 목록(최근 30분 안 활동이거나 진행 중인 것).
    pub fn chat_sessions(&self) -> Vec<Value> {
        let g = self.sessions.lock().unwrap();
        let mut v: Vec<&Session> = g
            .values()
            .filter(|s| s.state.is_active() || (s.last_touch.elapsed() < LIST_WINDOW && (!s.adopted || s.turn_no > 0)))
            .collect();
        v.sort_by(|a, b| b.last_at.cmp(&a.last_at));
        v.into_iter()
            .map(|s| {
                json!({
                    "key": s.key, "service": s.service, "provider": s.service.provider(), "state": s.state,
                    "cwd": s.cwd.to_string_lossy(), "project": project_of(&s.cwd), "title": s.title,
                    "busy": s.state.is_active(), "started_at": s.started_at, "last_at": s.last_at,
                })
            })
            .collect()
    }

    /// `chat_history`: 지난 대화 한 페이지.
    pub fn chat_history(self: &Arc<Self>, key: &str, cursor: Option<String>, limit: Option<usize>) -> Result<Value, String> {
        if key.starts_with("C:") {
            return Ok(json!({ "items": [], "next_cursor": null }));
        }
        let (svc, id) = Service::parse_key(key).ok_or("not_found")?;
        let page = match svc {
            Service::Claude => {
                let dir = config::claude_dir(&config::load().config);
                let lim = limit.unwrap_or(40);
                // 사본 세션은 첫 말을 보내기 전엔 기록 파일이 없다 — 갈라 나온 원본의 기록을 대신 보여 준다.
                let src = self.sessions.lock().unwrap().get(key).and_then(|s| s.fork_src.clone());
                match chatlog::claude_page(&dir, &id, cursor.as_deref(), lim) {
                    Some(p) => p,
                    None => src.and_then(|o| chatlog::claude_page(&dir, &o, cursor.as_deref(), lim)).ok_or("not_found")?,
                }
            }
            Service::Codex => runner_codex::history(self, &id, cursor.as_deref(), limit.unwrap_or(10)).map_err(|e| e.as_str().to_string())?,
            Service::Gemini => return Err("unsupported".into()),
        };
        serde_json::to_value(page).map_err(|e| e.to_string())
    }

    /// `chat_new`: 폴더 검사 후 새 세션을 만든다. Claude 는 UUID 를 직접 만들고, Codex 는 `thread/start` 로 id 를 받는다.
    pub fn chat_new(self: &Arc<Self>, service: Service, cwd: &str, mode: Mode, trust_ack: bool) -> Result<Value, String> {
        let cwd = check_cwd_real(cwd).map_err(str::to_string)?;
        let key = match service {
            Service::Claude => {
                let dir = config::claude_dir(&config::load().config);
                let trusted = dir.join("projects").join(project_dir_name(&cwd)).is_dir();
                if !trusted && !trust_ack {
                    return Err("trust_required".into());
                }
                let id = new_uuid();
                let s = Session::new(service, &id, cwd, true, mode, String::new(), trusted);
                let key = s.key.clone();
                self.sessions.lock().unwrap().insert(key.clone(), s);
                key
            }
            Service::Codex => {
                let id = runner_codex::start_thread(self, &cwd, mode).map_err(|e| e.as_str().to_string())?;
                let mut s = Session::new(service, &id, cwd, true, mode, String::new(), true);
                s.codex_loaded = true;
                let key = s.key.clone();
                self.sessions.lock().unwrap().insert(key.clone(), s);
                key
            }
            Service::Gemini => return Err("unsupported".into()),
        };
        Ok(json!({ "key": key }))
    }

    /// `chat_fork`: 사본 세션을 만든다(원본은 그대로 둠).
    pub fn chat_fork(self: &Arc<Self>, key: &str) -> Result<Value, String> {
        self.ensure_session(key)?;
        let (service, id, cwd, mode, title, cwd_ok) = {
            let g = self.sessions.lock().unwrap();
            let s = g.get(key).ok_or("not_found")?;
            (s.service, s.id.clone(), s.cwd.clone(), s.mode, s.title.clone(), s.cwd_ok)
        };
        if !cwd_ok {
            return Err("bad_cwd".into());
        }
        let new_key = match service {
            Service::Claude => {
                let nid = new_uuid();
                let mut s = Session::new(service, &nid, cwd, true, mode, title, true);
                s.fork_src = Some(id);
                let k = s.key.clone();
                self.sessions.lock().unwrap().insert(k.clone(), s);
                k
            }
            Service::Codex => {
                let nid = runner_codex::fork_thread(self, &id, mode).map_err(|e| e.as_str().to_string())?;
                let mut s = Session::new(service, &nid, cwd, true, mode, title, true);
                s.codex_loaded = true;
                let k = s.key.clone();
                self.sessions.lock().unwrap().insert(k.clone(), s);
                k
            }
            Service::Gemini => return Err("unsupported".into()),
        };
        Ok(json!({ "key": new_key }))
    }

    /// `chat_send`: 판정 재확인 후 턴을 시작한다. 거부 사유는 `view_only`·`busy_limit`·`empty`·`not_found` 코드 문자열.
    pub fn chat_send(self: &Arc<Self>, key: &str, text: &str) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("empty".into());
        }
        let sn = self.snap(key).ok_or("not_found")?;
        let conflict = if sn.turn_active { None } else { self.judge(&sn) };
        // init 만 보고 started 가 켜져도 첫 메시지 기록 전에 끊기면 기록 파일이 없다 — 파일이 있을 때만 `--resume`.
        let has_transcript = sn.service == Service::Claude && local::find_transcript(&config::claude_dir(&config::load().config), &sn.id).is_some();
        enum Start {
            Claude(runner_claude::Plan),
            Codex,
        }
        let (acts, start) = {
            let mut g = self.sessions.lock().unwrap();
            let s = g.get_mut(key).ok_or("not_found")?;
            let capacity = self.active.load(Ordering::SeqCst) < MAX_ACTIVE_TURNS;
            let acts = self.apply_in(s, &Trigger::Send { conflict: conflict.is_some(), capacity }, conflict.as_deref());
            let mut start = None;
            if acts.contains(&Action::StartTurn) {
                s.turn_no += 1;
                s.turn = format!("t{}", s.turn_no);
                s.live.clear();
                s.live_bytes = 0;
                s.last_event = Instant::now();
                s.quiet_noted = false;
                s.warned_writer = false;
                let ctl = TurnCtl::new();
                s.ctl = Some(ctl.clone());
                self.own(&s.id);
                let user = AgentEvent::UserMessage { id: format!("u{}", s.turn_no), text: text.clone() };
                self.emit_in(s, user);
                start = Some(match s.service {
                    Service::Claude => Start::Claude(runner_claude::Plan {
                        key: s.key.clone(),
                        id: s.id.clone(),
                        cwd: s.cwd.clone(),
                        mode: s.mode,
                        resume: s.fork_src.clone(),
                        fork: s.fork_src.is_some(),
                        started: s.started && has_transcript,
                        trusted: s.trusted,
                        turn: s.turn.clone(),
                        text: text.clone(),
                        ctl,
                    }),
                    _ => Start::Codex,
                });
            }
            (acts, start)
        };
        if acts.contains(&Action::RejectViewOnly) {
            return Err("view_only".into());
        }
        if acts.contains(&Action::RejectBusy) {
            return Err("busy_limit".into());
        }
        match start {
            Some(Start::Claude(plan)) => {
                // 터미널에서 끝나 떠 있던 "응답 완료" 카드 해소 — 소유 세션은 전역 훅(session_event)이 건너뛰어 UserPromptSubmit 이 닿지 않는다.
                if let Some(app) = self.app.get() {
                    crate::chat_resume_local(app, &plan.id);
                }
                let rt = self.clone();
                std::thread::spawn(move || runner_claude::run_turn(rt, plan));
            }
            Some(Start::Codex) => {
                let rt = self.clone();
                let key = key.to_string();
                std::thread::spawn(move || runner_codex::send(&rt, &key, &text));
            }
            None => return Err("not_allowed".into()),
        }
        Ok(())
    }

    /// `chat_interrupt`: 진행 중 턴을 중단한다.
    pub fn chat_interrupt(self: &Arc<Self>, key: &str) -> Result<(), String> {
        let state = self.sessions.lock().unwrap().get(key).map(|s| s.state).ok_or("not_found")?;
        if !state.is_active() {
            return Err("not_running".into());
        }
        self.apply(key, Trigger::Interrupt, None);
        Ok(())
    }

    /// `chat_takeover`: 사용자가 확인한 "여기서 이어받기"(Codex 의 쉼 구간 `maybe_open` 만).
    pub fn chat_takeover(self: &Arc<Self>, key: &str) -> Result<(), String> {
        let (service, id, why, mode, state) = {
            let g = self.sessions.lock().unwrap();
            let s = g.get(key).ok_or("not_found")?;
            (s.service, s.id.clone(), s.why.clone(), s.mode, s.state)
        };
        if service != Service::Codex || state != ChatState::ViewOnly || why.as_deref() != Some("maybe_open") {
            return Err("not_allowed".into());
        }
        runner_codex::resume_thread(self, &id, mode).map_err(|e| e.as_str().to_string())?;
        let mut g = self.sessions.lock().unwrap();
        if let Some(s) = g.get_mut(key) {
            s.codex_loaded = true;
            self.apply_in(s, &Trigger::Takeover, None);
        }
        Ok(())
    }

    /// `chat_close`: 소유를 푼다. 턴 진행 중이면 거부.
    pub fn chat_close(self: &Arc<Self>, key: &str) -> Result<(), String> {
        let (service, id, loaded) = {
            let mut g = self.sessions.lock().unwrap();
            let s = g.get(key).ok_or("not_found")?;
            if s.state.is_active() {
                return Err("turn_running".into());
            }
            let r = (s.service, s.id.clone(), s.codex_loaded);
            g.remove(key);
            r
        };
        self.owned.lock().unwrap().remove(&id);
        if service == Service::Codex && loaded {
            let rt = self.clone();
            std::thread::spawn(move || runner_codex::unsubscribe(&rt, &id));
        }
        Ok(())
    }

    // ── 감시·정리 ───────────────────────────────────────────────────────────

    /// 1초마다: 시간 초과 처리, 3초마다 다른 창 쓰기 감시, 5초마다 보기만 재판정, 30초마다 정리.
    fn tick(self: &Arc<Self>, n: u64) {
        // 시간 초과 처리
        let mut timeouts: Vec<(String, Trigger)> = Vec::new();
        let mut quiet: Vec<String> = Vec::new();
        {
            let mut g = self.sessions.lock().unwrap();
            for s in g.values_mut() {
                match s.state {
                    ChatState::Sending if s.last_event.elapsed() > SEND_TIMEOUT => timeouts.push((s.key.clone(), Trigger::SendTimeout)),
                    ChatState::Interrupting if s.interrupting_since.is_some_and(|t| t.elapsed() > INTERRUPT_TIMEOUT) => {
                        timeouts.push((s.key.clone(), Trigger::InterruptTimeout))
                    }
                    ChatState::Streaming if !s.quiet_noted && s.last_event.elapsed() > QUIET_NOTICE => {
                        s.quiet_noted = true;
                        quiet.push(s.key.clone());
                    }
                    _ => {}
                }
            }
        }
        for k in quiet {
            self.emit(&k, AgentEvent::Notice { code: "quiet".into() });
        }
        for (k, t) in timeouts {
            let reason = (t == Trigger::SendTimeout).then_some(ErrCode::Timeout.as_str());
            self.apply(&k, t, reason);
        }
        // 다른 창이 같은 대화에 쓰기 시작했는지(Claude) — 경고만
        if n % 3 == 0 {
            self.watch_other_writer();
        }
        // 보기만 → 충돌이 풀렸는지
        if n % 5 == 0 {
            let keys: Vec<String> = self.sessions.lock().unwrap().values().filter(|s| s.state == ChatState::ViewOnly && s.cwd_ok).map(|s| s.key.clone()).collect();
            for k in keys {
                if let Some(sn) = self.snap(&k) {
                    if self.judge(&sn).is_none() {
                        self.apply(&k, Trigger::Recheck { conflict: false }, None);
                    }
                }
            }
        }
        if n % 30 == 0 {
            self.prune();
        }
    }

    /// 진행 중인 Claude 턴 동안 같은 세션 id 의 다른 pid 세션 파일이 생겼는지 본다(경고만, 자동 종료 없음).
    fn watch_other_writer(self: &Arc<Self>) {
        let cands: Vec<(String, String, Vec<u32>)> = {
            let g = self.sessions.lock().unwrap();
            g.values()
                .filter(|s| s.service == Service::Claude && s.state.is_active() && !s.warned_writer)
                .map(|s| (s.key.clone(), s.id.clone(), s.ctl.as_ref().map(|c| c.pids()).unwrap_or_default()))
                .collect()
        };
        if cands.is_empty() {
            return;
        }
        let dir = config::claude_dir(&config::load().config);
        for (key, id, pids) in cands {
            if pids.is_empty() {
                continue;
            }
            if local::session_owner(&dir, &id, &pids).is_some() {
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&key) {
                    s.warned_writer = true;
                }
                self.emit(&key, AgentEvent::Notice { code: "other_writer".into() });
            }
        }
    }

    /// 오래 조용한 대기·보기만 세션과 끝난 소유 기록을 정리하고, 쓰지 않는 Codex app-server 를 끈다.
    fn prune(self: &Arc<Self>) {
        let (loaded, any_active) = {
            let mut g = self.sessions.lock().unwrap();
            g.retain(|_, s| s.state.is_active() || s.last_touch.elapsed() < PRUNE_AFTER);
            let loaded = g.values().filter(|s| s.service == Service::Codex && s.codex_loaded && !s.state.is_active() && s.last_touch.elapsed() > CODEX_IDLE).map(|s| (s.key.clone(), s.id.clone())).collect::<Vec<_>>();
            (loaded, g.values().any(|s| s.service == Service::Codex && s.state.is_active()))
        };
        self.owned.lock().unwrap().retain(|_, v| v.is_none_or(|t| t.elapsed() < OWNED_GRACE * 4));
        // 10분 넘게 조용한 Codex 스레드는 구독 해제
        for (key, id) in loaded {
            runner_codex::unsubscribe(self, &id);
            if let Some(s) = self.sessions.lock().unwrap().get_mut(&key) {
                s.codex_loaded = false;
            }
        }
        if !any_active {
            let mut slot = self.codex.lock().unwrap();
            let idle = slot.last_used.is_none_or(|t| t.elapsed() > CODEX_IDLE);
            let owned_threads = self.sessions.lock().unwrap().values().any(|s| s.service == Service::Codex && s.codex_loaded);
            if idle && !owned_threads {
                if let Some(srv) = slot.server.take() {
                    log::info!("Codex app-server 유휴 종료");
                    srv.kill();
                }
            }
        }
    }

    // ── Codex 서버 ──────────────────────────────────────────────────────────

    /// 살아 있는 app-server 를 돌려준다(없으면 시작). 5분 안에 3번 실패했으면 `user_retry` 가 아닌 호출은 시작하지 않는다.
    pub fn codex_server(self: &Arc<Self>, user_retry: bool) -> Result<Arc<AppServer>, ErrCode> {
        // 뮤텍스는 "시작 중" 표식만 잡는 동안 쥔다 — `AppServer::start`(initialize 대기 최대 10초)는 락 밖에서.
        let mut waited = 0;
        loop {
            let mut slot = self.codex.lock().unwrap();
            if let Some(s) = slot.server.clone() {
                if s.alive() {
                    slot.last_used = Some(Instant::now());
                    return Ok(s);
                }
                slot.server = None;
            }
            if slot.starting {
                // 다른 스레드가 시작 중 — 끝나길 기다렸다가 그 결과를 쓴다.
                drop(slot);
                waited += 1;
                if waited > 130 || self.is_stopping() {
                    return Err(ErrCode::AppServerExit);
                }
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            slot.fails.retain(|t| t.elapsed() < Duration::from_secs(300));
            if user_retry {
                slot.fails.clear();
            } else if slot.fails.len() >= 3 {
                return Err(ErrCode::AppServerExit);
            }
            slot.starting = true;
            break;
        }
        let started = self.start_codex_server();
        let mut slot = self.codex.lock().unwrap();
        slot.starting = false;
        match started {
            Ok(s) => {
                if self.is_stopping() {
                    s.kill();
                    return Err(ErrCode::AppServerExit);
                }
                slot.server = Some(s.clone());
                slot.last_used = Some(Instant::now());
                Ok(s)
            }
            Err(e) => {
                slot.fails.push(Instant::now());
                Err(e)
            }
        }
    }

    /// 락 밖에서 app-server 를 띄운다(`codex_server` 전용).
    fn start_codex_server(self: &Arc<Self>) -> Result<Arc<AppServer>, ErrCode> {
        let exe = codex::cli_path().ok_or(ErrCode::NoCli)?;
        let (r1, r2) = (self.clone(), self.clone());
        let on_msg: crate::appserver::OnMessage = Arc::new(move |srv, inc| runner_codex::on_incoming(&r1, srv, inc));
        let on_exit: crate::appserver::OnExit = Arc::new(move |srv| runner_codex::on_exit(&r2, srv));
        AppServer::start(&exe, on_msg, on_exit)
    }

    // ── 종료 ────────────────────────────────────────────────────────────────

    /// 앱 종료 정리(3.7): Claude 자식은 종료, Codex 턴은 `turn/interrupt`(2초 대기) 후 app-server 종료.
    pub fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut codex_turns: Vec<(String, String)> = Vec::new();
        {
            let g = self.sessions.lock().unwrap();
            for s in g.values() {
                if let Some(c) = &s.ctl {
                    c.kill();
                }
                if let (Service::Codex, Some(t)) = (s.service, &s.codex_turn) {
                    codex_turns.push((s.id.clone(), t.clone()));
                }
            }
        }
        let srv = self.codex.lock().unwrap().server.take();
        if let Some(srv) = srv {
            let deadline = Instant::now() + Duration::from_secs(2);
            for (thread, turn) in codex_turns {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                let _ = srv.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), left.min(Duration::from_secs(1)));
            }
            srv.kill();
        }
    }
}

// ── Tauri 명령 ──────────────────────────────────────────────────────────────

/// 앱 상태에서 실행기를 꺼낸다.
fn rt(app: &AppHandle) -> Arc<Runner> {
    app.state::<crate::AppState>().runner.clone()
}

/// 설치·로그인 여부 조사 결과(`chat_services`).
#[derive(Serialize)]
pub struct ServiceInfo {
    service: Service,
    installed: bool,
    logged_in: Option<bool>,
    version: Option<String>,
}

/// 실행 파일의 `--version` 첫 줄(10분 캐시, 로그에 남기지 않음).
fn cli_version(name: &'static str, exe: &Path) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<&'static str, (Instant, Option<String>)>>> = Mutex::new(None);
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref().and_then(|m| m.get(name)) {
        if at.elapsed() < Duration::from_secs(600) {
            return v.clone();
        }
    }
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let v = cmd.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()).filter(|s| !s.is_empty());
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(name, (Instant::now(), v.clone()));
    v
}

/// PATH 에서 gemini 실행 파일 찾기(탐지만).
fn find_gemini() -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.iter().flat_map(|d| ["gemini.cmd", "gemini.exe", "gemini"].map(|n| d.join(n))).find(|p| p.is_file())
}

/// 서비스별 설치·로그인·버전.
///
/// # 반환
/// `[{service, installed, logged_in, version}]` (Claude·Codex·Gemini 순). Gemini 는 PATH 탐지만(`logged_in`·`version` 은 null).
#[tauri::command(async)]
pub fn chat_services() -> Vec<ServiceInfo> {
    let cfg = config::load().config;
    let claude = runner_claude::claude_exe();
    let codex_exe = codex::cli_path();
    vec![
        ServiceInfo {
            service: Service::Claude,
            installed: claude.is_some(),
            logged_in: Some(config::claude_dir(&cfg).join(".credentials.json").is_file()),
            version: claude.as_deref().and_then(|e| cli_version("claude", e)),
        },
        ServiceInfo {
            service: Service::Codex,
            installed: codex_exe.is_some(),
            logged_in: Some(codex::codex_home().is_some_and(|h| h.join("auth.json").is_file())),
            version: codex_exe.as_deref().and_then(|e| cli_version("codex", e)),
        },
        ServiceInfo { service: Service::Gemini, installed: find_gemini().is_some(), logged_in: None, version: None },
    ]
}

/// 실행기가 아는 세션 목록.
#[tauri::command(async)]
pub fn chat_sessions(app: AppHandle) -> Vec<Value> {
    rt(&app).chat_sessions()
}

/// 세션을 열어 충돌 판정 결과와 진행 중 턴 이벤트를 받는다.
#[tauri::command(async)]
pub fn chat_open(app: AppHandle, key: String) -> Result<Value, String> {
    rt(&app).chat_open(&key)
}

/// 지난 대화 한 페이지.
#[tauri::command(async)]
pub fn chat_history(app: AppHandle, key: String, cursor: Option<String>, limit: Option<usize>) -> Result<Value, String> {
    rt(&app).chat_history(&key, cursor, limit)
}

/// 새 대화 만들기.
#[tauri::command(async)]
pub fn chat_new(app: AppHandle, service: Service, cwd: String, mode: Option<Mode>, trust_ack: Option<bool>) -> Result<Value, String> {
    rt(&app).chat_new(service, &cwd, mode.unwrap_or_default(), trust_ack.unwrap_or(false))
}

/// 말 보내기(턴 시작).
#[tauri::command(async)]
pub fn chat_send(app: AppHandle, key: String, text: String) -> Result<(), String> {
    rt(&app).chat_send(&key, &text)
}

/// 답변 중단.
#[tauri::command(async)]
pub fn chat_interrupt(app: AppHandle, key: String) -> Result<(), String> {
    rt(&app).chat_interrupt(&key)
}

/// 사본으로 이어가기.
#[tauri::command(async)]
pub fn chat_fork(app: AppHandle, key: String) -> Result<Value, String> {
    rt(&app).chat_fork(&key)
}

/// 여기서 이어받기(확인을 거친 뒤).
#[tauri::command(async)]
pub fn chat_takeover(app: AppHandle, key: String) -> Result<(), String> {
    rt(&app).chat_takeover(&key)
}

/// 대화 닫기(소유 해제).
#[tauri::command(async)]
pub fn chat_close(app: AppHandle, key: String) -> Result<(), String> {
    rt(&app).chat_close(&key)
}

/// 작업 폴더 고르기 창(Windows·macOS). 취소하면 None.
#[tauri::command]
pub async fn pick_folder(window: tauri::WebviewWindow) -> Option<String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let f = rfd::AsyncFileDialog::new().set_parent(&window).pick_folder().await;
        return f.map(|f| f.path().to_string_lossy().to_string());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = window;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ChatState as S;

    fn ok_send() -> Trigger {
        Trigger::Send { conflict: false, capacity: true }
    }

    /// 8.1 표의 모든 행.
    #[test]
    fn step_table_rows() {
        // view_only
        assert_eq!(step(S::ViewOnly, &Trigger::Recheck { conflict: false }), (S::Idle, vec![]));
        assert_eq!(step(S::ViewOnly, &Trigger::Recheck { conflict: true }), (S::ViewOnly, vec![]));
        assert_eq!(step(S::ViewOnly, &Trigger::Takeover), (S::Idle, vec![]));
        assert_eq!(step(S::ViewOnly, &ok_send()), (S::ViewOnly, vec![Action::RejectViewOnly]));
        assert_eq!(step(S::ViewOnly, &Trigger::Reopen { conflict: false }), (S::Idle, vec![]));
        assert_eq!(step(S::ViewOnly, &Trigger::Reopen { conflict: true }), (S::ViewOnly, vec![]));
        // idle
        assert_eq!(step(S::Idle, &ok_send()), (S::Sending, vec![Action::StartTurn]));
        assert_eq!(step(S::Idle, &Trigger::Send { conflict: true, capacity: true }), (S::ViewOnly, vec![Action::RejectViewOnly]));
        assert_eq!(step(S::Idle, &Trigger::Send { conflict: false, capacity: false }), (S::Idle, vec![Action::RejectBusy]));
        assert_eq!(step(S::Idle, &Trigger::Reopen { conflict: true }), (S::ViewOnly, vec![]));
        // sending
        assert_eq!(step(S::Sending, &Trigger::FirstEvent), (S::Streaming, vec![]));
        assert_eq!(step(S::Sending, &Trigger::StartFailed), (S::Error, vec![]));
        assert_eq!(step(S::Sending, &Trigger::SendTimeout), (S::Error, vec![Action::KillTurn]));
        // 중단
        assert_eq!(step(S::Sending, &Trigger::Interrupt), (S::Interrupting, vec![Action::KillTurn]));
        assert_eq!(step(S::Streaming, &Trigger::Interrupt), (S::Interrupting, vec![Action::KillTurn]));
        assert_eq!(step(S::AwaitingApproval, &Trigger::Interrupt), (S::Interrupting, vec![Action::CancelApprovals, Action::KillTurn]));
        // streaming
        assert_eq!(step(S::Streaming, &Trigger::ApprovalOpen), (S::AwaitingApproval, vec![]));
        assert_eq!(step(S::Streaming, &Trigger::TurnEnd(Outcome::Done)), (S::Idle, vec![Action::ReportDone]));
        assert_eq!(step(S::Streaming, &Trigger::TurnEnd(Outcome::Failed)), (S::Error, vec![]));
        assert_eq!(step(S::Streaming, &Trigger::ProcessDied), (S::Error, vec![Action::CancelApprovals]));
        // awaiting
        assert_eq!(step(S::AwaitingApproval, &Trigger::ApprovalClosed), (S::Streaming, vec![]));
        assert_eq!(step(S::AwaitingApproval, &Trigger::ApprovalTimeout), (S::Idle, vec![Action::CancelApprovals, Action::NoticeApprovalTimeout]));
        assert_eq!(step(S::AwaitingApproval, &Trigger::ProcessDied), (S::Error, vec![Action::CancelApprovals]));
        // interrupting
        assert_eq!(step(S::Interrupting, &Trigger::TurnEnd(Outcome::Interrupted)), (S::Idle, vec![Action::CancelApprovals]));
        assert_eq!(step(S::Interrupting, &Trigger::ProcessDied), (S::Idle, vec![Action::CancelApprovals]));
        assert_eq!(step(S::Interrupting, &Trigger::InterruptTimeout), (S::Idle, vec![Action::ForceKill, Action::CancelApprovals]));
        // error
        assert_eq!(step(S::Error, &ok_send()), (S::Sending, vec![Action::StartTurn]));
        assert_eq!(step(S::Error, &Trigger::Reopen { conflict: false }), (S::Idle, vec![]));
        assert_eq!(step(S::Error, &Trigger::Reopen { conflict: true }), (S::ViewOnly, vec![]));
    }

    /// 지난 턴 스레드의 늦은 `TurnEnd` 는 새 턴(제어 객체·승인 목록)을 건드리지 못한다.
    #[test]
    fn stale_turn_event_is_dropped() {
        let rt = Runner::new();
        let mut s = Session::new(Service::Claude, "id2", PathBuf::from("."), true, Mode::Ask, String::new(), true);
        s.state = S::Streaming;
        s.turn = "t2".into();
        s.ctl = Some(TurnCtl::new());
        s.approvals.insert("p1".into());
        let key = s.key.clone();
        rt.sessions.lock().unwrap().insert(key.clone(), s);
        rt.active.store(1, Ordering::SeqCst);
        let end = |t: &str| AgentEvent::TurnEnd { turn: t.into(), outcome: Outcome::Done, error: None };
        rt.on_event_turn(&key, Some("t1"), end("t1"));
        {
            let g = rt.sessions.lock().unwrap();
            let s = &g[&key];
            assert_eq!(s.state, S::Streaming);
            assert!(s.ctl.is_some() && s.last_end.is_none() && !s.approvals.is_empty());
        }
        rt.on_event_turn(&key, Some("t2"), end("t2"));
        let g = rt.sessions.lock().unwrap();
        assert_eq!(g[&key].state, S::Idle);
        assert!(g[&key].ctl.is_none() && g[&key].last_end.is_some());
    }

    /// 시간 초과처럼 `TurnEnd` 없이 활성 상태를 벗어나도 소유 표식은 시한부로 바뀐다.
    #[test]
    fn disown_after_timeout_transition() {
        let rt = Runner::new();
        let mut s = Session::new(Service::Codex, "id3", PathBuf::from("."), true, Mode::Ask, String::new(), true);
        for (from, t) in [(S::Interrupting, Trigger::InterruptTimeout), (S::Sending, Trigger::SendTimeout)] {
            rt.own("id3");
            s.state = from;
            rt.active.store(1, Ordering::SeqCst);
            rt.apply_in(&mut s, &t, None);
            assert!(matches!(rt.owned.lock().unwrap().get("id3"), Some(Some(_))), "{t:?}");
        }
    }

    /// 불가능한 전이는 상태를 바꾸지 않고 Ignore.
    #[test]
    fn step_rejects_impossible() {
        assert_eq!(step(S::ViewOnly, &Trigger::FirstEvent), (S::ViewOnly, vec![Action::Ignore]));
        assert_eq!(step(S::Idle, &Trigger::TurnEnd(Outcome::Done)), (S::Idle, vec![Action::Ignore]));
        assert_eq!(step(S::Idle, &Trigger::Interrupt), (S::Idle, vec![Action::Ignore]));
        assert_eq!(step(S::Streaming, &ok_send()), (S::Streaming, vec![Action::Ignore]));
        assert_eq!(step(S::Idle, &Trigger::ApprovalClosed), (S::Idle, vec![Action::Ignore]));
        assert_eq!(step(S::Error, &Trigger::Takeover), (S::Error, vec![Action::Ignore]));
        assert_eq!(step(S::Sending, &Trigger::InterruptTimeout), (S::Sending, vec![Action::Ignore]));
    }

    /// 불변식: 전이 결과의 활성 상태 수가 `Runner::active` 와 같게 유지되고 3 을 넘지 않는다.
    #[test]
    fn active_counter_follows_transitions() {
        let rt = Runner::new();
        let mut s = Session::new(Service::Claude, "id1", PathBuf::from("."), true, Mode::Ask, String::new(), true);
        for (t, expect) in [
            (ok_send(), 1),
            (Trigger::FirstEvent, 1),
            (Trigger::ApprovalOpen, 1),
            (Trigger::Interrupt, 1),
            (Trigger::TurnEnd(Outcome::Interrupted), 0),
            (ok_send(), 1),
            (Trigger::TurnEnd(Outcome::Done), 0),
        ] {
            rt.apply_in(&mut s, &t, None);
            assert_eq!(rt.active_count(), expect, "{t:?}");
        }
    }

    #[test]
    fn check_cwd_rules() {
        let base = std::env::temp_dir().join(format!("meow-cwd-{}", std::process::id()));
        let ok = base.join("proj");
        let cfgdir = base.join("claude-cfg");
        std::fs::create_dir_all(&ok).unwrap();
        std::fs::create_dir_all(cfgdir.join("projects")).unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let deny = vec![cfgdir.clone()];
        assert!(check_cwd(&ok, &deny, Some(&home)).is_ok());
        assert_eq!(check_cwd(Path::new("relative/dir"), &deny, None), Err("bad_cwd"));
        assert_eq!(check_cwd(&base.join("missing"), &deny, None), Err("bad_cwd"));
        assert_eq!(check_cwd(&home, &deny, Some(&home)), Err("cwd_home"));
        assert_eq!(check_cwd(&cfgdir, &deny, Some(&home)), Err("cwd_denied"));
        assert_eq!(check_cwd(&cfgdir.join("projects"), &deny, Some(&home)), Err("cwd_denied"));
        // 드라이브 루트
        let root = std::env::temp_dir().ancestors().last().unwrap().to_path_buf();
        assert_eq!(check_cwd(&root, &deny, Some(&home)), Err("cwd_root"));
        // 시스템 폴더(Windows)
        if let Some(win) = std::env::var_os("WINDIR").map(PathBuf::from).filter(|p| p.is_dir()) {
            assert_eq!(check_cwd(&win.join("System32"), &[win.clone()], None), Err("cwd_denied"));
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 본문 표식 문자열이 로그 요약에 새지 않는다.
    #[test]
    fn log_line_has_no_body() {
        let secret = "SECRET_BODY_MARKER";
        let evs = vec![
            AgentEvent::UserMessage { id: "u1".into(), text: secret.into() },
            AgentEvent::Delta { item: "i".into(), text: secret.into() },
            AgentEvent::Message { item: "i".into(), text: secret.into() },
            AgentEvent::ToolStart { item: "t".into(), kind: ToolKind::Command, title: secret.into(), detail: secret.into() },
            AgentEvent::ToolEnd { item: "t".into(), ok: true, summary: secret.into() },
            AgentEvent::Approval { permit: secret.into(), question: false },
            AgentEvent::ApprovalDone { permit: secret.into() },
            AgentEvent::Rekey { to: secret.into() },
            AgentEvent::TurnStart { turn: secret.into() },
            AgentEvent::TurnEnd { turn: secret.into(), outcome: Outcome::Failed, error: Some(ErrCode::Auth) },
            AgentEvent::State { state: ChatState::Error, reason: Some("auth".into()) },
            AgentEvent::Notice { code: "retry".into() },
            AgentEvent::Usage { input: 1, output: 2, cached: 3, cost_usd: Some(0.5), context_pct: None },
        ];
        for ev in evs {
            let l = log_line(&ev);
            assert!(!l.contains(secret), "{l}");
        }
        assert_eq!(log_line(&AgentEvent::Delta { item: "i".into(), text: "가나다".into() }), "delta len=3");
    }

    #[test]
    fn service_keys_roundtrip() {
        for (svc, id) in [(Service::Claude, "abc-1"), (Service::Codex, "0199-xyz"), (Service::Gemini, "g1")] {
            assert_eq!(Service::parse_key(&svc.key(id)), Some((svc, id.to_string())));
        }
        assert_eq!(Service::parse_key("C:abc"), None);
        assert_eq!(Service::parse_key("L:"), None);
    }

    #[test]
    fn uuid_format() {
        let u = new_uuid();
        let parts: Vec<&str> = u.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')));
        assert_ne!(u, new_uuid());
    }

    #[test]
    fn live_buffer_compacts_deltas() {
        let mut s = Session::new(Service::Claude, "id1", PathBuf::from("."), true, Mode::Ask, String::new(), true);
        for i in 0..(LIVE_MAX_EVENTS + 10) {
            s.push(AgentEvent::Delta { item: "a".into(), text: format!("{i},") });
        }
        assert!(s.live.len() < LIVE_MAX_EVENTS);
        let AgentEvent::Delta { text, .. } = &s.live[0].1 else { panic!() };
        assert!(text.starts_with("0,1,2,"));
        assert_eq!(s.seq, (LIVE_MAX_EVENTS + 10) as u64);
    }

    #[test]
    fn tool_summary_kinds() {
        assert_eq!(tool_summary("Bash", &json!({"command": "ls -la\nfoo"})).0, ToolKind::Command);
        assert_eq!(tool_summary("Write", &json!({"file_path": "C:\\a\\b.txt"})).1, "Write b.txt");
        assert_eq!(tool_summary("mcp__srv__do", &json!({})).0, ToolKind::Mcp);
        assert_eq!(tool_summary("WebFetch", &json!({"url": "https://x"})).0, ToolKind::Web);
        assert_eq!(tool_summary("Read", &json!({"file_path": "/a/b.rs"})).0, ToolKind::Other);
    }
}
