//! muneo-claude-usage-tray (Meowffice) — Tauri 진입점.
//!
//! 시계 옆 트레이 아이콘(사용률 링)만 상주한다. 한 번 클릭 → 오피스(메인) 창 열기/닫기, 더블클릭 → 열기, 우클릭 → 메뉴(오피스 열기·새로고침·컴퓨터 제어·종료).
//! 세션이 입력/검토 대기면 알림 창(notify)에 카드를 표시하고, "자세히" 시 브라우저(또는 데스크톱 앱)로 세션을 연다.
//! Claude Code 연동(선택): PermissionRequest HTTP 훅 → 알림 카드에서 수락/거절(permit.rs·hook.rs).
//! UI 는 ../ui (HTML/CSS/JS). Rust 는 데이터 수집·트레이·창 배치·자동시작·알림 판단을 담당한다.
//!
//! # 시작 순서 (`main`)
//! 1. `--hook <codex|agy> <이벤트>` 인자면 `relay::run` 으로 훅을 중계하고 바로 종료(창·트레이·로그 없음).
//! 2. 로그 초기화 → 설정 로드 → 자동시작 적용 → Claude Code 훅·ChatGPT/Antigravity 훅·자가 치유.
//! 3. Tauri 구성: 단일 인스턴스, `AppState` 등록, 업데이터 플러그인, setup, 창 이벤트, `invoke_handler`.
//! 4. setup: 트레이 메뉴·아이콘 생성 → 첫 설치/업데이트 후 첫 실행이면 오피스 열기 → 백그라운드 스레드 시작.
//!
//! # 스레드 (setup 에서 시작)
//! - 플랜 한도 갱신(설정 주기), 1분 툴팁 재계산·초기화 시각 점검
//! - 권한 요청 수신 서버(`permit::serve`, 127.0.0.1)
//! - 업데이트 확인, Claude 연결 상태 확인(5분), ChatGPT·Antigravity 폴링(15초), 세션 알림 폴링
//!
//! # 창
//! - `office`: 메인 화면(3D 오피스·사용량·설정). 닫으면 숨기지 않고 없앤다.
//! - `notify`: 우하단 알림 카드·권한 요청 창. 닫으면 숨긴다.
//!
//! # 이벤트 (Rust → UI)
//! `plan`, `alerts`, `permits`, `alert_history`, `notify_visible`, `auto_hide`, `auto_permit`, `update`, `update_notes`.
//! UI 에서는 `#[tauri::command]` 함수를 `invoke` 로 부른다(목록은 `invoke_handler` 참조).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod antigravity;
mod apicost;
mod appserver;
mod applog;
mod autostart;
mod chatlog;
mod codex;
mod config;
mod crypto;
mod exports;
mod health;
mod i18n;
mod hook;
mod jobobj;
mod local;
mod mcpreg;
mod oauth;
mod office;
mod permit;
mod provider_hook;
mod providers;
mod ptokens;
mod relay;
mod remotelog;
mod runner;
mod runner_claude;
mod runner_codex;
mod sysstat;
mod tray;
mod update;

use chrono::{DateTime, Duration as CDuration, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

/// 트레이 아이콘 식별자. `TrayIconBuilder::with_id` 로 만들고 `app.tray_by_id` 로 다시 찾는 데 쓴다.
const TRAY_ID: &str = "main";
/// 트레이 메뉴 항목(오피스 열기·새로고침·종료) 핸들 — 언어가 바뀌면 `set_lang` 이 글자를 바꾼다.
static TRAY_MENU: Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>> = Mutex::new(None);
/// 표시 이름(트레이 툴팁 첫 줄). tauri.conf.json productName 과 같게.
/// `update_tray` 가 툴팁 첫 줄로, `main` 이 트레이 초기 툴팁으로 쓴다.
const APP_NAME: &str = "Meowffice";
/// 패널 표시 때마다의 재조회 최소 간격(사용량 엔드포인트 과호출 방지).
/// `refresh_plan` 이 `force=false` 일 때 직전 조회가 이 시간(20초) 안이면 보관값을 그대로 돌려준다.
const PLAN_MIN_GAP: Duration = Duration::from_secs(20);

/// 앱 상태: 최근 플랜 조회 결과 + 세션 알림 + 권한 요청.
///
/// `main` 의 `.manage(...)` 로 한 번 등록되고, 각 함수가 `app.state::<AppState>()` 로 꺼내 쓴다.
/// 필드는 대부분 `Mutex` 로 보호되며(여러 스레드가 동시 접근), `treats` 등은 원자값이다.
struct AppState {
    /// 가장 최근 플랜 조회 시각과 결과. `refresh_plan` 이 채우고 `PLAN_MIN_GAP` 캐시·`reset_passed`·`redraw_tray` 가 읽는다.
    plan: Mutex<Option<(Instant, PlanSnap)>>,
    /// 세션·상태·업데이트 알림 카드 목록과 닫음·읽음 기록(`alerts::Alerts`).
    alerts: Mutex<alerts::Alerts>,
    /// 응답 대기 중인 권한 요청 목록(`permit::Permits`).
    permits: Mutex<permit::Permits>,
    /// 확인된 새 버전(없으면 None). `refresh_update` 가 갱신하고 `get_update` 가 돌려준다.
    update: Mutex<Option<update::Available>>,
    /// 방금 앱에서 설치한 업데이트의 내역 — 패널이 처음 불러갈 때 "업데이트 완료" 모달로 1회 표시.
    /// `take_update_notes` 가 꺼내면 비워진다.
    installed: Mutex<Option<update::Available>>,
    /// Claude 연결 상태(상태 페이지 + 이 앱의 연속 실패).
    health: Mutex<health::Health>,
    /// ChatGPT·Antigravity 연결 상태 (켠 서비스만 채움). 키 = 서비스 이름.
    phealth: Mutex<std::collections::HashMap<&'static str, health::ProvHealth>>,
    /// 오피스 밖에서 모인 간식 몫(알림 카드 수락 + 오피스가 이벤트를 받을 수 없을 때 자동 수락 + 작업 완료 `turn_done_treat`).
    /// `answer_permit`·`PermitHost::auto_allowed`·`turn_done_treat` 가 더하고, 오피스가 `take_treats` 로 꺼내 간식을 준다.
    /// 앱을 꺼도 남게 `treats_path` 파일에 함께 저장한다.
    treats: AtomicU32,
    /// 오피스가 `auto_permit`·`treats` 이벤트를 받을 준비가 됨 (리스너 등록 뒤 첫 `take_treats` 에서 켜고, 창이 없어지면 끔).
    /// 창은 있지만 장면을 만드는 중일 때 자동 수락 이벤트를 잃지 않게 `auto_allowed` 가 이 값으로 판단한다.
    office_ready: AtomicBool,
    /// 채팅 실행기(Claude `claude -p`·Codex app-server 세션 소유, `runner.rs`). 오피스 채팅 명령이 쓰고, 권한 서버가 소유 세션을 물어본다.
    runner: std::sync::Arc<runner::Runner>,
}

/// 권한 요청 서버 ↔ 앱 연결.
///
/// `permit::serve` 가 요청을 받을 때 설정·창·알림에 접근하는 통로. `permit::Host` 트레이트를 구현한다.
/// 튜플 필드 하나(`AppHandle`)로 앱 핸들을 들고 있다. `main` 의 setup 에서 만들어 권한 서버 스레드로 넘긴다.
#[derive(Clone)]
struct PermitHost(AppHandle);

/// 권한 요청 서버(`permit::serve`)가 앱에 묻는 설정값·알림 갱신 통로 구현.
impl permit::Host for PermitHost {
    /// 권한 요청 목록(`AppState.permits`)의 잠금 객체를 돌려준다.
    ///
    /// # 반환
    /// `AppState` 안의 `Mutex<permit::Permits>` 참조.
    fn permits(&self) -> &Mutex<permit::Permits> {
        &self.0.state::<AppState>().inner().permits
    }
    /// 권한 요청 훅 인증 토큰.
    ///
    /// 설정을 읽어 `permission_hook` 이 켜져 있을 때만 `hook_token` 을 돌려준다.
    ///
    /// # 반환
    /// 연동이 켜져 있으면 `Some(토큰)`, 꺼져 있으면 `None`.
    fn token(&self) -> Option<String> {
        let c = config::load().config;
        c.permission_hook.then_some(c.hook_token)
    }
    /// 도구 권한 요청 자동 수락 여부.
    ///
    /// # 반환
    /// `permission_hook` 과 `auto_allow` 설정이 모두 켜져 있으면 true.
    fn auto_allow(&self) -> bool {
        let c = config::load().config;
        c.permission_hook && c.auto_allow
    }
    /// 자동 수락된 요청을 오피스 창에 알린다.
    ///
    /// # 인자
    /// - `permit`: 자동 수락된 권한 요청
    ///
    /// # 참조
    /// 오피스 창(`office::LABEL`)으로 `auto_permit` 이벤트를 보낸다(실패는 무시).
    fn auto_allowed(&self, permit: &permit::Permit) {
        // 오피스가 이벤트를 받을 수 없으면(창 없음·장면 준비 중) 간식 몫으로 모아 둔다 (준비되면 take_treats 로 지급)
        if !self.0.state::<AppState>().office_ready.load(Ordering::SeqCst) {
            add_treat(&self.0, "자동 수락(오피스 닫힘)");
            return;
        }
        let mut event_permit = permit.clone();
        event_permit.detail.clear();
        let _ = self.0.emit_to(office::LABEL, "auto_permit", event_permit);
    }
    /// 권한 요청 목록이 바뀌었을 때 알림 창과 트레이를 다시 맞춘다.
    ///
    /// # 참조
    /// `sync_notify`, `redraw_tray`
    fn changed(&self) {
        sync_notify(&self.0);
        redraw_tray(&self.0);
    }
    /// 로컬 세션 훅 이벤트를 알림 처리로 넘긴다.
    ///
    /// # 인자
    /// - `v`: Claude Code 훅이 보낸 JSON(`hook_event_name`·`session_id` 등)
    ///
    /// # 참조
    /// `local_session_event`
    fn session_event(&self, v: &serde_json::Value) {
        // 채팅 실행기가 소유한 세션의 완료 알림·간식은 실행기가 턴 끝에서 한 번만 낸다(권한 카드 해소는 호출한 쪽이 이어서 처리).
        let session = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("");
        if !session.is_empty() && self.0.state::<AppState>().runner.is_owned(session) {
            return;
        }
        local_session_event(&self.0, v);
    }
    /// 다른 AI 서비스 훅 인증 토큰.
    ///
    /// # 인자
    /// - `p`: `Codex` 또는 `Agy`
    ///
    /// # 반환
    /// 해당 서비스의 훅 설정(`codex_hook`/`agy_hook`)이 켜져 있으면 `Some(hook_token)`, 아니면 `None`.
    fn provider_token(&self, p: provider_hook::Provider) -> Option<String> {
        let c = config::load().config;
        let on = match p {
            provider_hook::Provider::Codex => c.codex_hook,
            provider_hook::Provider::Agy => c.agy_hook,
        };
        on.then_some(c.hook_token)
    }
    /// 다른 AI 서비스 권한 요청 자동 수락 여부.
    ///
    /// # 인자
    /// - `p`: `Codex` 또는 `Agy`
    ///
    /// # 반환
    /// 해당 서비스의 훅과 자동 수락 설정이 모두 켜져 있으면 true.
    fn provider_auto_allow(&self, p: provider_hook::Provider) -> bool {
        let c = config::load().config;
        match p {
            provider_hook::Provider::Codex => c.codex_hook && c.codex_auto_allow,
            provider_hook::Provider::Agy => c.agy_hook && c.agy_auto_allow,
        }
    }
    /// 다른 AI 서비스의 Stop 훅 처리. Antigravity 일 때만 "응답 완료" 알림을 만든다(Codex 는 로그 폴링으로 처리).
    ///
    /// # 인자
    /// - `p`: 서비스 종류
    /// - `v`: 훅이 보낸 JSON
    ///
    /// # 참조
    /// `agy_turn_done`
    fn provider_stop(&self, p: provider_hook::Provider, v: &serde_json::Value) {
        if p == provider_hook::Provider::Agy {
            agy_turn_done(&self.0, v);
        }
    }
    /// 채팅 실행기가 소유한 세션인지(전역 훅 요청·알림 이중 발생 방지).
    ///
    /// # 인자
    /// - `session`: 서비스 세션 id
    fn owned(&self, session: &str) -> bool {
        self.0.state::<AppState>().runner.is_owned(session)
    }
    /// 채팅 승인 자동 수락 여부 — Claude 는 `auto_allow`, Codex 는 `codex_auto_allow` 설정(각 서비스의 훅 켜짐과 무관).
    ///
    /// # 인자
    /// - `provider`: "claude" | "chatgpt"
    fn chat_auto_allow(&self, provider: &str) -> bool {
        let c = config::load().config;
        match provider {
            "claude" => c.auto_allow,
            "chatgpt" => c.codex_auto_allow,
            _ => false,
        }
    }
    /// 이 세션 id 의 채팅이 읽기 전용 모드인지.
    fn chat_readonly(&self, session: &str) -> bool {
        self.0.state::<AppState>().runner.is_readonly(session)
    }
    /// 채팅 전용 훅 인증 토큰(권한 연동 설정과 무관, 토큰이 비어 있으면 None).
    fn chat_token(&self) -> Option<String> {
        Some(config::load().config.hook_token).filter(|t| !t.is_empty())
    }
    /// 소유 세션의 승인 카드 수명 사건을 실행기에 전달한다.
    fn chat_approval(&self, session: &str, ev: permit::ChatApproval) {
        self.0.state::<AppState>().runner.clone().on_approval(session, ev);
    }
}

/// Antigravity Stop 훅 → "응답 완료" 알림. 사용자가 직접 멈춘 경우(USER_CANCELED)·백그라운드 작업이 남은 경우(fullyIdle=false)는 알리지 않음.
///
/// `conversationId` 가 없거나 위 조건이면 바로 돌아온다. `terminationReason` 에 따라 본문(오류·한도·완료)을 고르고,
/// `cwd`(없으면 `workspacePaths[0]`)의 마지막 경로 요소를 프로젝트 이름으로 삼아 로컬 알림 카드를 추가한다.
/// 알림 목록 잠금은 카드 추가 동안만 잡고 `alerts_changed` 는 잠금 밖에서 부른다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `v`: Antigravity 훅 JSON(`conversationId`·`terminationReason`·`fullyIdle`·`cwd`·`workspacePaths`)
///
/// # 참조
/// `alerts::Alerts::add_local`, `alerts_changed`. `PermitHost::provider_stop` 에서 호출됨.
fn agy_turn_done(app: &AppHandle, v: &serde_json::Value) {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let id = s("conversationId");
    if id.is_empty() || v.get("fullyIdle").and_then(|x| x.as_bool()) == Some(false) {
        return;
    }
    let body = match s("terminationReason") {
        "USER_CANCELED" | "TERMINAL_CUSTOM_HOOK" => return,
        "ERROR" => i18n::t("alert.agy.error"),
        "MAX_INVOCATIONS" | "MAX_FORCED_INVOCATIONS" | "MAX_TOKEN_BUDGET_EXCEEDED" => i18n::t("alert.agy.limit"),
        _ => {
            turn_done_treat(app, "Antigravity 작업 완료", "antigravity", id);
            i18n::t("alert.done")
        }
    };
    let cwd = Some(s("cwd")).filter(|c| !c.is_empty()).or_else(|| v.pointer("/workspacePaths/0").and_then(|x| x.as_str())).unwrap_or("");
    let project = cwd.rsplit(['\\', '/']).find(|x| !x.is_empty()).unwrap_or("").to_string();
    let now = Utc::now();
    log::info!("Antigravity 턴 끝남 알림: {project}");
    app.state::<AppState>().alerts.lock().unwrap().add_local(alerts::Alert {
        key: format!("local:agy:{id}@{}", now.timestamp_millis()),
        id: format!("agy:{id}"),
        title: if project.is_empty() { "Antigravity".into() } else { format!("Antigravity · {project}") },
        message: body.into(),
        state: "done".into(),
        env: "local".into(),
        updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
        project,
        ..Default::default()
    });
    alerts_changed(app);
}

/// 로컬 세션(터미널·IDE) 훅 이벤트 → 알림. claude.ai 세션 목록에 없는 세션도 알림을 받게 함.
///
/// Stop(턴 종료) → "응답 완료", Notification(입력 대기) → "입력 대기". 권한 확인 Notification 은 권한 카드가 따로 있어 제외.
/// UserPromptSubmit·PostToolUse(사용자가 돌아옴) → 그 세션 알림 해소.
/// 서브·백그라운드 에이전트(워크트리 격리 등)도 부모 세션 id 로 같은 훅을 보냄 — 부모 알림을 덮거나 해소하지 않도록
/// 에이전트별 알림(id = <세션>#<에이전트>)으로 분리하고 종류 "agent" 로 표시.
/// 알림·권한 목록 잠금은 판단에 필요한 순간에만 잡고, `alerts_changed` 는 잠금을 푼 뒤에 부른다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `v`: 훅 JSON(`hook_event_name`·`session_id`·`cwd`·`transcript_path`·`message`·`notification_type`·`agent_id` 등)
///
/// # 참조
/// `agent_of`, `local::running_background_agents`, `local::session_title`, `local::agent_title`, `alerts_changed`.
/// `PermitHost::session_event` 에서 호출됨.
fn local_session_event(app: &AppHandle, v: &serde_json::Value) {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let (event, session) = (s("hook_event_name"), s("session_id"));
    let state = app.state::<AppState>();
    let project_of = |cwd: &str| cwd.rsplit(['\\', '/']).find(|x| !x.is_empty()).unwrap_or("Claude Code").to_string();
    let (agent, project) = agent_of(v);
    let project = project_of(&project);
    // 어떤 이벤트가 실제로 들어오는지 확인용(제보 분석: "알림이 안 왔다" 때 훅 자체가 왔는지).
    if event != "PostToolUse" {
        log::debug!(
            "훅 이벤트: {event} · {project}{} · {}{}",
            agent.as_deref().map(|a| format!(" · 에이전트 {a}")).unwrap_or_default(),
            s("notification_type"),
            Some(s("message")).filter(|m| !m.is_empty()).map(|m| format!(" · {m}")).unwrap_or_default()
        );
    }
    let id = match &agent {
        Some(a) => format!("{session}#{a}"),
        None => session.to_string(),
    };
    match event {
        "UserPromptSubmit" | "PostToolUse" => {
            // 에이전트 표시(agent_id·워크트리)가 없는 도구 실행이라도, 메인 턴이 끝난 뒤 백그라운드 에이전트가 돌고 있으면
            // 그 에이전트의 것일 가능성이 큼 — "응답 완료" 카드를 지우지 않음(메인이 다시 돌면 다음 Stop 이 카드를 교체).
            let done = state.alerts.lock().unwrap().local_of(&id).is_some_and(|a| a.state == "done");
            if event == "PostToolUse"
                && agent.is_none()
                && done
                && Some(s("transcript_path"))
                    .filter(|p| !p.is_empty())
                    .is_some_and(|p| local::running_background_agents(std::path::Path::new(p)) > 0)
            {
                return;
            }
            // 사용자가 메인 세션에 새로 입력 → 그 세션 에이전트들의 알림(<세션>#<에이전트>)도 함께 해소
            // (에이전트 알림은 끝난 뒤 같은 id 로 오는 훅이 없어 따로는 풀리지 않음).
            let all = event == "UserPromptSubmit" && agent.is_none();
            if state.alerts.lock().unwrap().resolve_local_session(&id, all) {
                log::debug!("로컬 세션 알림 해소({event}{}): {id}", if all { " +에이전트" } else { "" });
                alerts_changed(app);
            }
        }
        "Stop" | "Notification" => {
            let message = s("message");
            let permission =
                event == "Notification" && (s("notification_type") == "permission_prompt" || message.to_lowercase().contains("permission"));
            if permission {
                // 권한 확인 창. 권한 카드(PermissionRequest 훅)로 받은 건이면 중복이라 건너뜀.
                // 카드가 없으면 훅을 거치지 않는 확인(자동 모드가 위험하다고 본 명령 등) — Claude 화면에서 직접 답해야 함.
                if state.permits.lock().unwrap().visible().iter().any(|p| p.session == session) {
                    return;
                }
            } else if event == "Notification" && state.alerts.lock().unwrap().has_local(&id) {
                // 턴 종료 알림이 이미 떠 있으면 뒤따르는 대기 알림은 중복.
                return;
            }
            let transcript = Some(s("transcript_path")).filter(|p| !p.is_empty()).map(std::path::Path::new);
            let title = match &agent {
                Some(a) => i18n::tf("alert.agent_title", &[("title", &transcript.and_then(|t| local::agent_title(t, a)).unwrap_or_else(|| project.clone()))]),
                None => transcript.and_then(local::session_title).unwrap_or_else(|| project.clone()),
            };
            let (state_name, body) = match event {
                "Stop" if agent.is_some() => ("done", i18n::t("alert.agent_done").to_string()),
                "Stop" => match transcript.map(local::running_background_agents).unwrap_or(0) {
                    0 => ("done", i18n::t("alert.done").to_string()),
                    n => ("done", i18n::tf("alert.done_bg", &[("n", &n.to_string())])),
                },
                _ if permission => (
                    "need_input",
                    i18n::tf(
                        "alert.permission",
                        &[("tool", &message.split("permission to use ").nth(1).map(|tool| format!(" ({})", tool.trim())).unwrap_or_default())],
                    ),
                ),
                _ if message.is_empty() || message.contains("waiting for your input") => ("need_input", i18n::t("alert.waiting").into()),
                _ => ("need_input", message.to_string()),
            };
            let now = Utc::now();
            let alert = alerts::Alert {
                key: format!("local:{id}@{}", now.timestamp_millis()),
                id,
                title,
                message: body,
                state: state_name.into(),
                env: "local".into(),
                url: String::new(),
                updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
                agent: agent.is_some(),
                project: project.clone(),
                // 원격 제어를 켠 세션이면 claude.ai 쪽 알림과 한 카드로 합치려고 그 세션 id 를 같이 둠(에이전트 알림은 합치지 않음).
                bridge: if agent.is_none() {
                    local::bridge_session_of(&config::claude_dir(&config::load().config), session).unwrap_or_default()
                } else {
                    String::new()
                },
                ..Default::default()
            };
            log::info!(
                "로컬 세션 알림({event}{}{}): {project} · {state_name}",
                if permission { " 권한 확인" } else { "" },
                if alert.agent { " 에이전트" } else { "" }
            );
            state.alerts.lock().unwrap().add_local(alert);
            alerts_changed(app);
            if event == "Stop" && agent.is_none() {
                turn_done_treat(app, "Claude 작업 완료", "claude", &session);
            }
        }
        _ => {}
    }
}

/// 훅 이벤트가 에이전트에서 왔으면 (에이전트 id, 부모 프로젝트 경로). 아니면 (None, cwd).
///
/// 훅 입력의 agent_id 를 우선, 없으면 워크트리 경로(<프로젝트>/.claude/worktrees/agent-<id>)로 판단.
/// 경로의 `\` 는 `/` 로 바꿔 비교하고, 에이전트이면 경로는 워크트리 앞부분(프로젝트 루트)으로 돌려준다.
///
/// # 인자
/// - `v`: 훅 JSON(`cwd`·`agent_id` 를 읽음)
///
/// # 반환
/// `(Some(에이전트 id), 프로젝트 루트)` 또는 `(None, cwd)`. id 앞의 `agent-` 접두사는 제거한다.
///
/// # 참조
/// `local_session_event` 에서 호출.
fn agent_of(v: &serde_json::Value) -> (Option<String>, String) {
    let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").replace('\\', "/");
    let (root, worktree) = match cwd.split_once("/.claude/worktrees/") {
        Some((root, rest)) => (root.to_string(), rest.split('/').next().and_then(|w| w.strip_prefix("agent-")).map(str::to_string)),
        None => (cwd.clone(), None),
    };
    let id = v.get("agent_id").and_then(|x| x.as_str()).filter(|a| !a.is_empty()).map(|a| a.trim_start_matches("agent-").to_string());
    match id.or(worktree) {
        Some(a) => (Some(a), root),
        None => (None, cwd),
    }
}

/// 프론트로 넘기는 플랜 스냅샷. 오류도 값으로 전달(트레이 툴팁 공용).
///
/// `get_plan` 의 반환값이자 `plan` 이벤트 페이로드이다. JSON 모양: `{ plan, error, error_kind, state, fetched_at }`.
#[derive(Serialize, Clone)]
struct PlanSnap {
    /// 조회에 성공했을 때의 플랜 한도 정보. 실패하면 None.
    plan: Option<oauth::Plan>,
    /// 조회 실패 메시지. 성공하면 None.
    error: Option<String>,
    /// oauth::ApiError::kind — no_credentials·expired·auth 면 프론트가 로그인 안내 표시.
    error_kind: Option<String>,
    /// 연결 상태 — 다른 서비스와 같은 이름. 조회 전 None
    state: Option<providers::ConnState>,
    /// 조회 시각(RFC3339, 초 단위, UTC). 스레드 오류로 만든 대체 스냅샷에서는 빈 문자열.
    fetched_at: String,
}

// ── 플랜 한도 + 트레이 갱신 ────────────────────────────────────────────────

/// 플랜 한도를 조회해 보관하고 트레이·패널에 반영한다.
///
/// `force=false` 이고 직전 조회가 `PLAN_MIN_GAP` 안이면 보관값을 그대로 돌려준다. 그 외에는 `oauth::fetch_plan` 을 호출(네트워크, 호출 스레드를 막음)하고
/// 결과를 로그에 남기며 연결 상태(`health`)에 반영한다. 429 응답이고 직전에 성공한 값이 있으면 직전 값을 유지한다.
/// 성공·실패 모두 새 스냅샷을 보관하고 트레이를 갱신하며 `plan` 이벤트를 모든 창에 보낸다. `plan` 잠금은 짧게만 잡는다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `force`: true 면 캐시 간격을 무시하고 새로 조회
///
/// # 반환
/// 이번 조회(또는 캐시·직전) `PlanSnap`.
///
/// # 참조
/// `oauth::fetch_plan`, `log_changed`, `apply_health`, `update_tray`. `get_plan`·트레이 "새로고침" 메뉴·주기 갱신 스레드·`reset_passed` 감시 스레드에서 호출.
/// 이벤트 `plan`.
fn refresh_plan(app: &AppHandle, force: bool) -> PlanSnap {
    let state = app.state::<AppState>();
    if !force {
        if let Some((at, snap)) = state.plan.lock().unwrap().as_ref() {
            if at.elapsed() < PLAN_MIN_GAP {
                return snap.clone();
            }
        }
    }
    let cfg = config::load().config;
    let res = oauth::fetch_plan(&config::claude_dir(&cfg));
    log_changed(
        &PLAN_LOG,
        match &res {
            Ok(_) => "플랜 한도 조회 정상".into(),
            Err(e) => format!("플랜 한도 조회 실패({}): {e}", e.kind()),
        },
    );
    if state.health.lock().unwrap().note_api(&res) {
        apply_health(app);
    }
    // 429(요청 과다)는 사용량 API 의 일시적 호출 제한 — 화면·트레이는 직전 값을 그대로 둠.
    if matches!(res, Err(oauth::ApiError::Http(429))) {
        if let Some(prev) = state.plan.lock().unwrap().as_ref().map(|(_, s)| s.clone()).filter(|s| s.plan.is_some()) {
            return prev;
        }
    }
    let snap = PlanSnap {
        state: providers::claude_state(res.is_ok(), res.as_ref().err().map(|e| e.kind())),
        error: res.as_ref().err().map(|e| e.to_string()),
        error_kind: res.as_ref().err().map(|e| e.kind().to_string()),
        plan: res.ok(),
        fetched_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    };
    *state.plan.lock().unwrap() = Some((Instant::now(), snap.clone()));
    update_tray(app, &snap);
    let _ = app.emit("plan", &snap);
    snap
}

/// 초기화 시각(로컬 시간대), 남은 시간은 `with_left`일 때만. " · 20:50 초기화 (1시간 29분 후)" / " · 10/29 17:00 초기화"
///
/// 서버 값이 정각 직전(11:49:59.59)으로 오므로 30초를 더해 가장 가까운 분으로 반올림한다. 오늘이면 시:분, 아니면 월/일 시:분으로 표시.
/// 남은 시간은 24시간 이상이면 "N일 M시간 후", 1시간 이상이면 "H시간 M분 후", 그 미만이면 "M분 후".
///
/// # 인자
/// - `reset`: 초기화 시각(RFC3339 문자열). None 이거나 해석 불가면 빈 문자열
/// - `with_left`: true 면 괄호로 남은 시간을 덧붙임
///
/// # 반환
/// 앞에 " · " 가 붙은 표시 문자열. 시각이 없거나 이미 지났으면 빈 문자열.
///
/// # 참조
/// `update_tray` 의 툴팁 조립에서 호출.
fn until(reset: &Option<String>, with_left: bool) -> String {
    let Some(t) = reset.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()) else {
        return String::new();
    };
    // 서버 값이 정각 직전(11:49:59.59)으로 오므로 가장 가까운 분으로 반올림.
    let t = t + CDuration::seconds(30);
    let t = t - CDuration::seconds(t.timestamp() % 60) - CDuration::nanoseconds(t.timestamp_subsec_nanos() as i64);
    let d = t.with_timezone(&Utc) - Utc::now();
    if d <= CDuration::zero() {
        return String::new();
    }
    let local = t.with_timezone(&Local);
    let at = if local.date_naive() == Local::now().date_naive() {
        local.format("%H:%M").to_string()
    } else {
        local.format("%-m/%-d %H:%M").to_string()
    };
    if !with_left {
        return i18n::tf("tip.reset", &[("at", &at)]);
    }
    let (h, m) = (d.num_hours(), d.num_minutes() % 60);
    let left = if h >= 24 {
        i18n::tf("tip.left_dh", &[("d", &(h / 24).to_string()), ("h", &(h % 24).to_string())])
    } else if h > 0 {
        i18n::tf("tip.left_hm", &[("h", &h.to_string()), ("m", &m.to_string())])
    } else {
        i18n::tf("tip.left_m", &[("m", &m.to_string())])
    };
    i18n::tf("tip.reset_left", &[("at", &at), ("left", &left)])
}

/// 트레이 툴팁 글자 수 한도 (Windows 는 127자)
const TIP_MAX: usize = 120;
/// 연동할 수 있는 다른 AI 서비스 (이름, 툴팁·카드에 쓰는 표시 이름)
const PROVIDER_LABELS: [(&str, &str); 2] = [("chatgpt", "ChatGPT"), ("antigravity", "Antigravity")];

/// 연동을 켠 서비스 이름들 (설정 파일 기준, 저장한 적 없으면 모두 꺼짐)
///
/// # 반환
/// 설정의 `providers_on` 목록. 없으면 빈 목록.
///
/// # 참조
/// `provider_on`, `provider_tip`, `poll_providers`
fn providers_on_list() -> Vec<String> {
    config::load().config.providers_on.unwrap_or_default()
}

/// 해당 서비스 연동이 켜져 있는지 확인한다.
///
/// # 인자
/// - `name`: 서비스 이름("chatgpt" | "antigravity")
///
/// # 반환
/// `providers_on_list` 에 있으면 true.
///
/// # 참조
/// `get_provider_tokens`, `get_provider_image`, `provider_login` 에서 호출.
fn provider_on(name: &str) -> bool {
    providers_on_list().iter().any(|n| n == name)
}

/// 툴팁 한 줄: 켠 서비스의 대표 한도 % ("ChatGPT 12% · Antigravity 80%"). 켠 서비스가 없거나 값이 없으면 None
///
/// `PROVIDER_LABELS` 순서로 켠 서비스만 골라, 보관된 마지막 조회값(`providers::last`)에서 대표 퍼센트를 뽑아 이어 붙인다.
///
/// # 반환
/// 조립된 한 줄, 표시할 값이 하나도 없으면 `None`.
///
/// # 참조
/// `providers::last`, `providers::main_percent`, `update_tray`
fn provider_tip() -> Option<String> {
    let on = providers_on_list();
    let parts: Vec<String> = PROVIDER_LABELS
        .iter()
        .filter(|(n, _)| on.iter().any(|x| x == n))
        .filter_map(|(n, label)| providers::last(n).and_then(|s| providers::main_percent(&s)).map(|p| format!("{label} {p:.0}%")))
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// 툴팁 글자 조립: Claude 줄 + 덧붙임 줄(다른 서비스 %·알림·문제·새 버전). 한도를 넘으면 Claude 줄을 초기화 시각 없는 짧은 판으로 바꿔
/// 덧붙임 줄이 잘리지 않게 하고, 그래도 넘으면 한도에서 자른다 (Windows 툴팁 127자)
///
/// # 인자
/// - `full`: 초기화 시각이 포함된 긴 Claude 줄(여러 줄 문자열)
/// - `short`: 긴 판이 한도를 넘을 때만 호출되는 짧은 판 생성 클로저
/// - `extras`: 덧붙임 줄들(줄바꿈으로 이어 붙임)
///
/// # 반환
/// `TIP_MAX` 글자 이하로 맞춘 툴팁 문자열.
///
/// # 참조
/// `update_tray` 에서 호출. 단위 테스트 `tip_tests`.
fn fit_tip(full: String, short: impl FnOnce() -> String, extras: &[String]) -> String {
    let compose = |head: String| std::iter::once(head).chain(extras.iter().cloned()).collect::<Vec<_>>().join("\n");
    let mut tip = compose(full);
    if tip.chars().count() > TIP_MAX {
        tip = compose(short());
    }
    tip.chars().take(TIP_MAX).collect()
}

/// 플랜 스냅샷으로 트레이 아이콘과 툴팁을 다시 그린다.
///
/// 트레이가 없으면 바로 돌아온다. 읽지 않은 알림 수·권한 요청 수를 구하고, Claude 줄(한도별 %와 초기화 시각)과
/// 덧붙임 줄(다른 서비스 %·권한 요청·읽지 않은 알림·연결 문제·새 버전)을 `fit_tip` 으로 조립해 툴팁에 설정한다.
/// 아이콘은 5시간·주간 게이지와 배지 수(알림+권한)로 만든다. 여러 잠금은 각각 짧게 잡는다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `snap`: 그릴 플랜 스냅샷(오류 스냅샷이면 오류 문구를 툴팁에 씀)
///
/// # 참조
/// `until`, `provider_tip`, `fit_tip`, `tray::image`. `refresh_plan`·`redraw_tray` 에서 호출.
fn update_tray(app: &AppHandle, snap: &PlanSnap) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let n_unread = app.state::<AppState>().alerts.lock().unwrap().unread();
    let n_permits = app.state::<AppState>().permits.lock().unwrap().visible().len();
    // 툴팁 한도 때문에 주간은 시각만, 직전 줄과 같은 초기화 시각은 생략. 길면 초기화 시각을 통째로 뺀 짧은 판으로.
    let claude_tip = |with_reset: bool| -> String {
        match (&snap.plan, &snap.error) {
            (Some(p), _) => {
                let mut lines = vec![APP_NAME.to_string()];
                let mut prev = String::new();
                for l in p.limits.iter().filter(|l| l.kind != "weekly_scoped" || l.percent > 0.0) {
                    let reset = until(&l.resets_at, l.kind == "session");
                    let shown = if reset == prev || !with_reset { "" } else { reset.as_str() };
                    lines.push(format!("{} {:.0}%{}", l.label, l.percent, shown));
                    prev = reset;
                }
                lines.join("\n")
            }
            (None, Some(e)) => format!("{APP_NAME}\n{e}"),
            _ => APP_NAME.to_string(),
        }
    };
    let (s, w) = match (&snap.plan, &snap.error) {
        (Some(p), _) => p.gauges(),
        _ => (None, None),
    };
    let mut extras: Vec<String> = Vec::new();
    if let Some(l) = provider_tip() {
        extras.push(l);
    }
    if n_permits > 0 {
        extras.push(i18n::tf("tip.permits", &[("n", &n_permits.to_string())]));
    }
    if n_unread > 0 {
        extras.push(i18n::tf("tip.unread", &[("n", &n_unread.to_string())]));
    }
    if let Some(i) = app.state::<AppState>().health.lock().unwrap().current() {
        extras.push(format!("⚠ {}", i.title));
    }
    for (name, label) in PROVIDER_LABELS {
        if app.state::<AppState>().phealth.lock().unwrap().get(name).is_some_and(|h| h.current().is_some()) {
            extras.push(i18n::tf("tip.provider_warn", &[("label", label)]));
        }
    }
    if let Some(u) = app.state::<AppState>().update.lock().unwrap().as_ref() {
        extras.push(i18n::tf("tip.update", &[("v", &u.version)]));
    }
    let tip = fit_tip(claude_tip(true), || claude_tip(false), &extras);
    let _ = tray.set_icon(Some(tray::image(s, w, (n_unread + n_permits) as u32)));
    let _ = tray.set_tooltip(Some(tip));
}

/// 최근 스냅샷의 한도 중 초기화 시각이 이미 지난 것이 있는지.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 반환
/// 보관된 플랜의 한도 중 `resets_at` 이 현재 시각 이전인 것이 하나라도 있으면 true. 보관값이 없으면 false.
///
/// # 참조
/// `main` 의 1분 주기 스레드가 새 조회 여부를 정하는 데 사용.
fn reset_passed(app: &AppHandle) -> bool {
    let plan = app.state::<AppState>().plan.lock().unwrap().as_ref().and_then(|(_, s)| s.plan.clone());
    let now = Utc::now();
    plan.map(|p| {
        p.limits.iter().any(|l| l.resets_at.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).is_some_and(|t| t <= now))
    })
    .unwrap_or(false)
}

/// 최근 플랜 스냅샷으로 트레이만 다시 그림(알림 배지 변경 시).
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `update_tray`. 보관된 스냅샷이 없으면 아무것도 하지 않는다.
fn redraw_tray(app: &AppHandle) {
    let snap = app.state::<AppState>().plan.lock().unwrap().as_ref().map(|(_, s)| s.clone());
    if let Some(snap) = snap {
        update_tray(app, &snap);
    }
}

// ── 세션 알림 ──────────────────────────────────────────────────────────────

/// 플랜 조회 주기 작업의 마지막 로그 문구 — 같은 내용이 반복되면 로그를 남기지 않음(30초 폴링이 로그를 덮지 않도록).
/// `log_changed` 가 비교에 쓴다.
static PLAN_LOG: Mutex<String> = Mutex::new(String::new());
/// 세션 알림 폴링의 마지막 로그 문구(`log_changed` 중복 억제용).
static POLL_LOG: Mutex<String> = Mutex::new(String::new());

/// 직전과 다른 문구일 때만 로그를 남긴다.
///
/// 문구에 "실패" 가 있으면 warn, 아니면 info 로 기록하고 마지막 문구를 갱신한다. 주기 작업이 같은 내용을 반복해 로그를 덮는 것을 막는다.
///
/// # 인자
/// - `last`: 해당 작업의 마지막 문구를 보관하는 전역 `Mutex`
/// - `msg`: 이번 문구
///
/// # 참조
/// `refresh_plan`, `poll_alerts`, `poll_status`, `poll_provider_health` 에서 호출.
fn log_changed(last: &Mutex<String>, msg: String) {
    let mut last = last.lock().unwrap();
    if *last != msg {
        if msg.contains("실패") {
            log::warn!("{msg}");
        } else {
            log::info!("{msg}");
        }
        *last = msg;
    }
}

/// 세션 알림 폴링 1회: 클라우드·원격 세션 목록을 조회해 알림 카드를 갱신한다.
///
/// `alerts` 설정이 꺼져 있으면 로그만 남기고 끝낸다. 켜져 있으면 최근 `alerts::RECENT_HOURS` 시간의 세션을 조회한다.
/// 네트워크·인증 오류 시 기존 카드를 유지한다(일시 장애로 알림이 사라지지 않도록). 조회 결과는 연결 상태에도 반영하고,
/// 알림을 갱신한 뒤 닫음·읽음 기록을 저장하며 표시가 바뀌었으면 `alerts_changed` 를 부른다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `oauth::fetch_cloud_sessions`, `alerts::Alerts::update`, `save_alert_marks`, `alerts_changed`. `main` 의 알림 폴링 스레드에서 주기 호출.
fn poll_alerts(app: &AppHandle) {
    let cfg = config::load().config;
    if !cfg.alerts {
        log_changed(&POLL_LOG, "세션 알림 꺼짐(설정) — 확인 안 함".into());
        return;
    }
    let since = Utc::now() - CDuration::hours(alerts::RECENT_HOURS);
    // 네트워크·인증 오류 시 기존 카드 유지(일시 장애로 알림이 사라지지 않도록).
    let res = oauth::fetch_cloud_sessions(&config::claude_dir(&cfg), since);
    if app.state::<AppState>().health.lock().unwrap().note_api(&res) {
        apply_health(app);
    }
    let list = match res {
        Ok(list) => list,
        Err(e) => return log_changed(&POLL_LOG, format!("세션 알림 확인 실패({}): {e}", e.kind())),
    };
    let waiting: Vec<String> = list.iter().filter(|s| alerts::is_waiting(s)).map(|s| format!("{}={}", s.env, s.state)).collect();
    log_changed(
        &POLL_LOG,
        format!(
            "세션 알림 확인: 최근 {}시간 클라우드·원격 세션 {}개, 대기 {}개 [{}]",
            alerts::RECENT_HOURS,
            list.len(),
            waiting.len(),
            waiting.join(", ")
        ),
    );
    let changed = app.state::<AppState>().alerts.lock().unwrap().update(&list);
    // 표시가 안 바뀌어도 이어 붙임·죽은 건 정리·seen 갱신으로 기록이 바뀔 수 있음.
    save_alert_marks(app);
    if changed {
        alerts_changed(app);
    }
}

// ── 연결 상태 ──────────────────────────────────────────────────────────────

/// 연결 상태 카드의 세션 자리 id(로컬 알림 목록을 같이 씀).
const HEALTH_ALERT: &str = "claude-status";
/// Claude 상태 페이지 확인의 마지막 로그 문구(`log_changed` 중복 억제용).
static STATUS_LOG: Mutex<String> = Mutex::new(String::new());

/// 상태 페이지 확인 1회.
///
/// `health::fetch_status` 로 가져온 문제 정보를 로그에 남기고 연결 상태에 반영하며, 상태가 바뀌었으면 `apply_health` 로 카드를 맞춘다.
/// 조회 실패는 로그만 남긴다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `health::fetch_status`, `apply_health`. `main` 의 상태 확인 스레드(기동 20초 후, `health::INTERVAL` 마다)에서 호출.
fn poll_status(app: &AppHandle) {
    match health::fetch_status() {
        Ok(issue) => {
            log_changed(
                &STATUS_LOG,
                match &issue {
                    Some(i) => format!("상태 페이지: 문제 있음 — {}", i.detail),
                    None => "상태 페이지: 정상".into(),
                },
            );
            if app.state::<AppState>().health.lock().unwrap().set_status(issue) {
                apply_health(app);
            }
        }
        Err(e) => log_changed(&STATUS_LOG, format!("상태 페이지 확인 실패: {e}")),
    }
}

/// 현재 연결 상태를 알림으로: 문제(새로 생기거나 바뀜) → "좋지 않습니다" 카드, 풀림 → "복구되었습니다" 카드.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `apply_health_card`(id = `HEALTH_ALERT`, 서비스 "Claude")
fn apply_health(app: &AppHandle) {
    let issue = app.state::<AppState>().health.lock().unwrap().current();
    apply_health_card(app, HEALTH_ALERT, "Claude", health::STATUS_PAGE, issue);
}

/// 연결 상태 카드 하나(id = 카드 자리, name = 서비스 이름) 맞추기. Claude·ChatGPT·Antigravity 가 같이 쓴다.
/// 바뀐 것만 새 카드로 알리고(같은 문제는 다시 알리지 않음), 문제가 풀렸을 때만 "복구" 카드.
///
/// 문제가 있으면 `<id>@<문제 key>` 키의 카드가 없을 때만 추가한다. 문제가 없고 직전에 "status" 카드가 떠 있었으면 "복구되었습니다" 카드를 추가한다.
/// 알림 목록 잠금 안에서 판단·추가하고, 바뀐 경우에만 잠금 밖에서 `alerts_changed` 를 부른다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `id`: 카드 자리 id(예: "claude-status", "chatgpt-status")
/// - `name`: 복구 카드 제목에 쓸 서비스 표시 이름
/// - `page`: 복구 카드 링크(상태 페이지 주소, 없으면 빈 문자열)
/// - `issue`: 현재 문제(없으면 None)
///
/// # 참조
/// `alerts::Alerts::add_local`, `alerts_changed`. `apply_health`·`poll_provider_health` 에서 호출.
fn apply_health_card(app: &AppHandle, id: &str, name: &str, page: &str, issue: Option<health::Issue>) {
    let state = app.state::<AppState>();
    let now = Utc::now();
    let changed = {
        let mut alerts = state.alerts.lock().unwrap();
        let showing_problem = alerts.local_of(id).is_some_and(|a| a.state == "status");
        match issue {
            Some(i) => {
                let key = format!("{id}@{}", i.key);
                alerts.find(&key).is_none() && {
                    log::warn!("연결 상태 문제: {} — {}", i.title, i.detail);
                    alerts.add_local(alerts::Alert {
                        key,
                        id: id.into(),
                        title: i.title,
                        message: i.detail,
                        state: "status".into(),
                        env: "status".into(),
                        url: i.url,
                        updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
                        ..Default::default()
                    })
                }
            }
            None if showing_problem => {
                log::info!("{name} 연결 상태 복구");
                alerts.add_local(alerts::Alert {
                    key: format!("{id}-ok@{}", now.timestamp_millis()),
                    id: id.into(),
                    title: i18n::tf("health.recovered.title", &[("name", name)]),
                    message: i18n::t("health.recovered.message").into(),
                    state: "recovered".into(),
                    env: "status".into(),
                    url: page.into(),
                    updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
                    ..Default::default()
                })
            }
            None => false,
        }
    };
    if changed {
        alerts_changed(app);
    }
}

// ── 다른 AI 서비스 (켠 것만) ───────────────────────────────────────────────

/// OpenAI 상태 페이지 확인의 마지막 로그 문구(`log_changed` 중복 억제용).
static PSTATUS_LOG: Mutex<String> = Mutex::new(String::new());

/// 웹 서비스 장애 알림 대상: (설정 id, phealth 키, 카드 id, 표시 이름 — 문구 키 또는 고유 이름, 상태 페이지, 확인 주기 tick).
///
/// 카드 id `chatgpt-status-web` 은 key 가 `chatgpt-status` 로 시작해 `alerts::provider_of` 가 chatgpt 로고를 준다.
const WEB_STATUS: [(&str, &str, &str, &str, &str, u64); 2] = [
    ("chatgpt", "chatgpt-web", "chatgpt-status-web", "health.web.chatgpt", health::OPENAI_STATUS_PAGE, 20), // 5분
    ("gemini", "gemini-web", "gemini-status", "Gemini", health::GOOGLE_STATUS_PAGE, 60),            // 15분(응답이 큼)
];
/// 웹 서비스 상태 확인의 마지막 로그 문구(`log_changed` 중복 억제용).
static WEB_STATUS_LOG: Mutex<String> = Mutex::new(String::new());

/// 웹 서비스(ChatGPT·Gemini) 장애 알림: 설정에서 켠 것만 공식 상태 페이지를 확인한다. 로그인 정보는 쓰지 않는다.
///
/// 꺼진 서비스는 보관한 상태와 남은 카드를 조용히 치운다(복구 카드 없음). 켠 서비스는 주기(`WEB_STATUS` 의 tick)마다,
/// 또는 아직 확인한 적 없을 때(phealth 에 키 없음 = 미확인) 바로 조회한다. 조회가 실패해도 키를 만들어 15초마다 재조회하지 않는다.
/// 바뀐 문제만 `apply_health_card` 로 카드에 반영한다. 네트워크 조회 동안 잠금은 잡지 않는다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `tick`: 15초 주기 호출 횟수
///
/// # 참조
/// `health::fetch_chatgpt_web_status`, `health::fetch_gemini_status`, `apply_health_card`, `log_changed`. 서비스 폴링 스레드에서 `poll_providers` 다음에 호출.
fn poll_web_status(app: &AppHandle, tick: u64) {
    let on = config::load().config.web_status_alerts;
    let state = app.state::<AppState>();
    for (id, key, card, label_key, page, every) in WEB_STATUS {
        let label = i18n::t(label_key);
        if !on.iter().any(|n| n == id) {
            let had = state.phealth.lock().unwrap().remove(key).is_some();
            if had && state.alerts.lock().unwrap().resolve_local(card) {
                alerts_changed(app);
            }
            continue;
        }
        let due = tick.is_multiple_of(every) || !state.phealth.lock().unwrap().contains_key(key);
        if !due {
            continue;
        }
        let res = if id == "chatgpt" { health::fetch_chatgpt_web_status() } else { health::fetch_gemini_status() };
        let mut g = state.phealth.lock().unwrap();
        let h = g.entry(key).or_default();
        match res {
            Ok(issue) => {
                log_changed(
                    &WEB_STATUS_LOG,
                    match &issue {
                        Some(i) => format!("{label} 상태 페이지: 문제 있음 — {}", i.detail),
                        None => format!("{label} 상태 페이지: 정상"),
                    },
                );
                if h.set_status(issue) {
                    let cur = h.current();
                    drop(g);
                    apply_health_card(app, card, label, page, cur);
                }
            }
            Err(e) => log_changed(&WEB_STATUS_LOG, format!("{label} 상태 페이지 확인 실패: {e}")),
        }
    }
}

/// 서비스를 껐을 때: 보관값·연결 상태·남은 카드를 치운다 (복구 카드도 만들지 않음)
///
/// 보관된 조회값을 지우고 연결 상태 항목을 제거한다. ChatGPT 이면 Codex 끝남 추적도 초기화한다.
/// 연결 상태가 있었고 "<name>-status" 카드가 남아 있으면 해소하고 알림 갱신을 알린다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `name`: 서비스 이름("chatgpt" | "antigravity")
///
/// # 참조
/// `providers::forget`, `codex::reset_finished`, `alerts_changed`. `poll_providers` 에서 호출.
fn provider_cleared(app: &AppHandle, name: &str) {
    providers::forget(name);
    let state = app.state::<AppState>();
    let had = state.phealth.lock().unwrap().remove(name).is_some();
    if name == "chatgpt" {
        codex::reset_finished();
    }
    if had && state.alerts.lock().unwrap().resolve_local(&format!("{name}-status")) {
        alerts_changed(app);
    }
}

/// 서비스별 연결 상태 갱신 + 카드. tick = 15초 단위 횟수 (상태 페이지는 5분, 로컬 확인은 1분마다)
///
/// ChatGPT: tick 이 20의 배수일 때 OpenAI 상태 페이지를 확인하고, 4의 배수일 때 Codex 사용량 조회의 연속 네트워크 실패를 반영한다.
/// Antigravity: tick 이 4의 배수일 때 로컬 프로브(`antigravity::probe_health`)로 실행·헬스·인증 상태를 반영한다.
/// 상태가 바뀐 경우에만 `apply_health_card` 로 카드를 맞춘다(같은 문제는 key 로 걸러짐).
///
/// # 인자
/// - `app`: 앱 핸들
/// - `name`: 서비스 이름("chatgpt" 이면 ChatGPT, 그 외는 Antigravity 로 취급)
/// - `tick`: 15초 주기 호출 횟수
///
/// # 참조
/// `health::fetch_openai_status`, `codex::usage_net_fails`, `antigravity::probe_health`, `apply_health_card`. `poll_providers` 에서 호출.
fn poll_provider_health(app: &AppHandle, name: &'static str, tick: u64) {
    let state = app.state::<AppState>();
    let (label, page) = match name {
        "chatgpt" => ("ChatGPT", health::OPENAI_STATUS_PAGE),
        _ => ("Antigravity", ""),
    };
    let mut changed = false;
    if name == "chatgpt" {
        if tick.is_multiple_of(20) {
            match health::fetch_openai_status() {
                Ok(issue) => {
                    log_changed(
                        &PSTATUS_LOG,
                        match &issue {
                            Some(i) => format!("OpenAI 상태 페이지(Codex): 문제 있음 — {}", i.detail),
                            None => "OpenAI 상태 페이지(Codex): 정상".into(),
                        },
                    );
                    changed |= state.phealth.lock().unwrap().entry(name).or_default().set_status(issue);
                }
                Err(e) => log_changed(&PSTATUS_LOG, format!("OpenAI 상태 페이지 확인 실패: {e}")),
            }
        }
        if tick.is_multiple_of(4) {
            let (n, e) = codex::usage_net_fails();
            changed |= state.phealth.lock().unwrap().entry(name).or_default().set_local(health::codex_net_issue(n, &e));
        }
    } else if tick.is_multiple_of(4) {
        let p = antigravity::probe_health();
        let mut g = state.phealth.lock().unwrap();
        let h = g.entry(name).or_default();
        let fails = h.count(p.running && !p.healthz_ok);
        changed |= h.set_local(health::agy_issue(p.running, fails, p.auth_ok));
    }
    // 바뀐 것만 카드로 (같은 문제는 apply_health_card 가 key 로 거름)
    if changed {
        let issue = state.phealth.lock().unwrap().get(name).and_then(|h| h.current());
        apply_health_card(app, &format!("{name}-status"), label, page, issue);
    }
}

/// 켠 서비스 주기 작업(15초): 조회값 보관(트레이 툴팁) · 연결 상태 · Codex 턴 끝남 알림. 꺼진 서비스는 아무것도 읽지 않는다.
///
/// `PROVIDER_LABELS` 의 각 서비스에 대해 꺼져 있으면 `provider_cleared` 로 정리하고 건너뛴다. 켜져 있으면 스냅샷을 보관하고 연결 상태를 갱신한다.
/// ChatGPT 는 끝난 Codex 턴마다 "응답이 끝났습니다" 로컬 알림 카드를 추가한다. 마지막에 트레이를 다시 그린다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `tick`: 15초 주기 호출 횟수(0부터)
///
/// # 참조
/// `providers::snapshot`, `providers::remember`, `poll_provider_health`, `codex::poll_finished`, `redraw_tray`. `main` 의 서비스 폴링 스레드(기동 25초 후, 15초마다)에서 호출.
fn poll_providers(app: &AppHandle, tick: u64) {
    let on = providers_on_list();
    for (name, _) in PROVIDER_LABELS {
        if !on.iter().any(|n| n == name) {
            provider_cleared(app, name);
            continue;
        }
        providers::remember(&providers::snapshot(name));
        poll_provider_health(app, name, tick);
        if name == "chatgpt" {
            for f in codex::poll_finished() {
                let now = Utc::now();
                let title = if f.title.is_empty() { f.project.clone() } else { f.title.clone() };
                log::info!("Codex 턴 끝남 알림: {}", f.project);
                turn_done_treat(app, "Codex 작업 완료", "chatgpt", &f.id);
                app.state::<AppState>().alerts.lock().unwrap().add_local(alerts::Alert {
                    key: format!("local:codex:{}@{}", f.id, f.turn),
                    id: format!("codex:{}", f.id),
                    title: if title.is_empty() { "Codex".into() } else { format!("Codex · {title}") },
                    message: i18n::t("alert.done").into(),
                    state: "done".into(),
                    env: "local".into(),
                    updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
                    project: f.project,
                    ..Default::default()
                });
                alerts_changed(app);
            }
        }
    }
    redraw_tray(app);
}

/// 닫음·숨김·읽음 기록이 바뀌었으면 파일에 씀(잠금 밖에서). 바뀐 게 없으면 아무것도 안 함.
///
/// 스냅샷+쓰기를 `MARKS_IO` 로 직렬화한다(여러 스레드가 동시에 저장하면 오래된 스냅샷이 나중에 써져 방금 닫은 기록이 빠질 수 있음).
/// 기록을 꺼낼 때만 알림 목록 잠금을 잡고, 파일 쓰기는 잠금 밖에서 한다. 쓰기에 실패하면 경고 로그 후 다음 저장 때 다시 쓰도록 dirty 로 되돌린다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `alerts::Alerts::take_marks_if_dirty`, `alerts::save_marks`, `alerts::marks_path`. `alerts_changed`·`expire_alert`·`quit_app`·트레이 종료 메뉴 등에서 호출.
fn save_alert_marks(app: &AppHandle) {
    // 스냅샷+쓰기를 직렬화 — 여러 스레드가 동시에 저장하면 오래된 스냅샷이 나중에 써져 방금 닫은 기록이 빠질 수 있음.
    /// 알림 기록 저장 직렬화용 잠금(`save_alert_marks` 안에서만 사용).
    static MARKS_IO: Mutex<()> = Mutex::new(());
    let _io = MARKS_IO.lock().unwrap();
    let snap = app.state::<AppState>().alerts.lock().unwrap().take_marks_if_dirty();
    if let Some(f) = snap {
        if let Err(e) = alerts::save_marks(&alerts::marks_path(), &f) {
            log::warn!("알림 기록 저장 실패: {e}");
            // 다음 저장 때 다시 쓰도록.
            app.state::<AppState>().alerts.lock().unwrap().mark_dirty();
        }
    }
}

/// 알림 상태 변경 → 기록 저장, 알림 창·트레이 배지·패널 알림 탭 갱신.
///
/// 기록 저장 → 알림 창 동기화 → 트레이 다시 그리기 순으로 하고, 마지막으로 알림 기록 목록을 오피스 창에 보낸다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `save_alert_marks`, `sync_notify`, `redraw_tray`. 오피스 창으로 `alert_history` 이벤트(알림 기록 배열).
fn alerts_changed(app: &AppHandle) {
    save_alert_marks(app);
    sync_notify(app);
    redraw_tray(app);
    let history = app.state::<AppState>().alerts.lock().unwrap().history();
    let _ = app.emit_to(office::LABEL, "alert_history", &history);
}

/// 알림 창에 띄울 카드(끈 종류는 Alerts::visible 에서 빠짐 — 설정의 알림 종류).
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 반환
/// 현재 표시 대상 `alerts::Alert` 목록.
///
/// # 참조
/// `sync_notify`, `get_alerts`
fn notify_list(app: &AppHandle) -> Vec<alerts::Alert> {
    app.state::<AppState>().alerts.lock().unwrap().visible()
}

/// sync_notify 직렬화 — 여러 스레드(폴링·훅 서버·업데이트·상태 확인·IPC)가 동시에 부르면
/// 읽기→판단→표시/숨김이 엇갈려 카드가 있는데 창이 숨는 일이 생김.
static SYNC_NOTIFY: Mutex<()> = Mutex::new(());
/// 메인(이벤트 루프) 스레드 id — `main` 시작 때 기록. `sync_notify` 가 메인 스레드에서 불렸는지 가린다.
static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// 오피스 창 "항상 위" 설정(config.panel_on_top) — sync_notify 가 자주 불려 파일 대신 여기서 읽음.
/// (예전 트레이 관리 창 → 오피스 창으로 옮김. 아래 PANEL_* 은 오피스 창이 앞에 있는지 판단용)
/// `set_panel_on_top` 이 쓰고 `panel_in_front`·`show_panel` 이 읽는다.
static PANEL_ON_TOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 관리 창이 마지막으로 포커스를 잃은 시각. 트레이 아이콘을 누르면 클릭 처리 전에 포커스가 먼저 빠지므로
/// 직전(아래 시간 안)에 빠졌으면 "앞에 있었음"으로 봄.
/// `main` 의 창 이벤트 핸들러가 기록한다.
static PANEL_BLUR: Mutex<Option<Instant>> = Mutex::new(None);
/// `PANEL_BLUR`·`PANEL_SHOWN` 이후 "앞에 있음"으로 인정하는 유예 시간(600ms).
const PANEL_BLUR_GRACE: Duration = Duration::from_millis(600);
/// 관리 창을 마지막으로 앞으로 띄운 시각. set_focus 직후엔 아직 포커스가 안 잡혀 있을 수 있어
/// 그 사이 알림 창이 잠깐 떴다 사라지지 않게 같은 시간 동안 "앞에 있음"으로 봄.
/// `show_panel` 이 기록한다.
static PANEL_SHOWN: Mutex<Option<Instant>> = Mutex::new(None);

/// 오피스 창 "항상 위" 값을 보관하고 열려 있는 오피스 창에 적용한다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `on`: 항상 위 여부
///
/// # 참조
/// `PANEL_ON_TOP`. `main` 의 setup 과 `save_config` 에서 호출.
fn set_panel_on_top(app: &AppHandle, on: bool) {
    PANEL_ON_TOP.store(on, std::sync::atomic::Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(office::LABEL) {
        let _ = win.set_always_on_top(on);
    }
}

/// 관리 창이 보이고 다른 창에 가려지지 않음. 항상 위가 아니면 포커스가 있을 때만(뒤로 묻힌 창은 "열림" 아님 —
/// 묻힌 채로 알림 창이 계속 숨거나, 트레이 클릭이 묻힌 창을 닫기만 하는 일이 없게).
///
/// 창이 없거나 보이지 않거나 최소화돼 있으면 false. 그 외에는 항상 위 설정, 포커스, 최근 표시(`PANEL_SHOWN`)가 유예 시간 안,
/// 또는 `recent_blur` 가 true 이고 최근 포커스 상실(`PANEL_BLUR`)이 유예 시간 안이면 true.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `recent_blur`: true 면 직전 포커스 상실도 "앞에 있음"으로 인정(트레이 클릭 처리용)
///
/// # 반환
/// 오피스 창이 앞에 있다고 볼 수 있으면 true.
///
/// # 참조
/// `sync_notify`(recent_blur=false), `toggle_panel`(recent_blur=true)
fn panel_in_front(app: &AppHandle, recent_blur: bool) -> bool {
    let Some(w) = app.get_webview_window(office::LABEL) else {
        return false;
    };
    // 최소화된 오피스는 "앞에 있음"이 아님 (항상 위여도) — 세션 알림 카드가 숨지 않고, 트레이 클릭이 닫지 않고 되살리게
    if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return false;
    }
    PANEL_ON_TOP.load(std::sync::atomic::Ordering::Relaxed)
        || w.is_focused().unwrap_or(false)
        || PANEL_SHOWN.lock().unwrap().is_some_and(|t| t.elapsed() < PANEL_BLUR_GRACE)
        || (recent_blur && PANEL_BLUR.lock().unwrap().is_some_and(|t| t.elapsed() < PANEL_BLUR_GRACE))
}

/// 창 이벤트(메인 스레드)용: sync_notify 를 다른 스레드에서. 메인 스레드가 SYNC_NOTIFY 를 기다리는 사이,
/// 그 자물쇠를 쥔 스레드가 창 상태(is_visible 등)를 메인 루프에 물으면 서로 기다리게 되므로.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `sync_notify`. `show_panel` 과 `main` 의 창 이벤트 핸들러에서 호출.
fn sync_notify_async(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || sync_notify(&app));
}

/// 알림 창 표시 상태 동기화(포커스 뺏지 않음).
/// 권한 요청 있음 → 항상 표시(응답 대기 중이라 시급). 세션 알림만 있음 → 패널 닫혀 있을 때만.
///
/// `SYNC_NOTIFY` 로 직렬화한다. 알림 카드·권한 요청을 `notify` 창에, 권한 요청은 오피스 창에도 보낸다.
/// 표시할 것이 없거나(권한 없음 + 카드 없음 또는 오피스가 앞에 있음) 창이 보이면 숨기고, 표시할 것이 있는데 숨겨져 있으면 우하단에 배치해 보인다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `notify_list`, `panel_in_front`, `place`. 이벤트 `alerts`·`permits`·`notify_visible`(notify 창), `permits`(오피스 창).
/// `alerts_changed`·`PermitHost::changed`·`answer_permit`·`resync_notify`·`save_config` 등에서 호출.
fn sync_notify(app: &AppHandle) {
    // 메인 스레드(동기 IPC 명령·창 이벤트)에서 불리면 다른 스레드로 넘긴다: 메인 스레드가 SYNC_NOTIFY 를 기다리는 사이
    // 그 자물쇠를 쥔 스레드가 창 상태(is_visible 등)를 메인 루프에 물으면 서로 기다려 앱 전체가 멈춘다
    // (0.6.9: '최근 알림' 읽음 처리 mark_alerts_read → alerts_changed → 여기서 멈춤)
    if MAIN_THREAD.get().is_some_and(|id| *id == std::thread::current().id()) {
        sync_notify_async(app);
        return;
    }
    let _guard = SYNC_NOTIFY.lock().unwrap_or_else(|e| e.into_inner());
    let Some(nw) = app.get_webview_window("notify") else {
        return;
    };
    let list = notify_list(app);
    let permits = app.state::<AppState>().permits.lock().unwrap().visible();
    let panel_open = panel_in_front(app, false);
    let _ = app.emit_to("notify", "alerts", &list);
    let _ = app.emit_to("notify", "permits", &permits);
    let _ = app.emit_to(office::LABEL, "permits", &permits); // 오피스 결재 줄
    let visible = nw.is_visible().unwrap_or(false);
    if permits.is_empty() && (list.is_empty() || panel_open) {
        if visible {
            log::info!("알림 창 숨김 (카드 {}개, 오피스 앞 {panel_open})", list.len());
        }
        let _ = nw.hide();
        let _ = app.emit_to("notify", "notify_visible", false);
    } else if !visible {
        log::info!("알림 창 표시 (알림 {}개, 권한 요청 {}개)", list.len(), permits.len());
        place(&nw, None);
        let _ = nw.show();
        let _ = app.emit_to("notify", "notify_visible", true);
    }
}

/// 알림 창에 띄울 카드 목록을 돌려준다.
///
/// # 반환
/// `alerts::Alert` 배열(JSON). UI 의 `invoke('get_alerts')`(notify.js) 가 호출.
///
/// # 참조
/// `notify_list`
#[tauri::command]
fn get_alerts(app: AppHandle) -> Vec<alerts::Alert> {
    notify_list(&app)
}

/// 응답 대기 중인 권한 요청 목록을 돌려준다.
///
/// # 반환
/// `permit::Permit` 배열(JSON). UI 의 `invoke('get_permits')`(notify.js, office/office.js) 가 호출.
#[tauri::command]
fn get_permits(app: AppHandle) -> Vec<permit::Permit> {
    app.state::<AppState>().permits.lock().unwrap().visible()
}

/// 권한 요청 카드의 수락/거절(question 형식은 answers 동봉). 수락 시 설정이 켜져 있으면 데스크톱 앱을 띄움(미리보기 카드 포함).
///
/// 권한 목록 잠금을 잡고 답을 전달하고 곧바로 잠금을 푼다. 이미 끝난 요청이면 알림 창을 다시 맞추고 오류를 돌려준다.
///
/// # 인자
/// - `id`: 권한 요청 id(미리보기는 "preview" 로 시작)
/// - `allow`: true 수락, false 거절
/// - `answers`: question 형식 카드의 선택 답(JSON), 없으면 None
/// - `source`: 응답한 곳. "card" 면 알림 카드(수락 시 간식 몫 적립 `add_treat`), 오피스는 생략(오피스가 결재 연출로 직접 지급)
///
/// # 반환
/// 전달됐으면 `Ok(())`. 이미 처리됐거나 시간이 지난 요청이면 `Err("이미 처리되었거나 시간이 지난 요청입니다")`.
///
/// # 참조
/// `permit::Permits::answer`, `show_desktop_app`, `sync_notify`. UI 의 `invoke('answer_permit')`(notify.js, office/office.js) 가 호출.
#[tauri::command]
fn answer_permit(app: AppHandle, id: String, allow: bool, answers: Option<serde_json::Value>, source: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut permits = state.permits.lock().unwrap();
    let ok = permits.answer(&id, allow, answers);
    drop(permits);
    log::info!("권한 요청 {id}: 카드에서 {} ({})", if allow { "수락" } else { "거절" }, if ok { "전달됨" } else { "이미 끝난 요청" });
    if allow && (ok || id.starts_with("preview")) {
        show_desktop_app();
    }
    // 알림 카드에서 수락한 건은 오피스 결재 연출을 거치지 않으므로 간식 몫으로 모은다 (오피스에서 수락한 건은 오피스가 직접 줌)
    if allow && ok && source.as_deref() == Some("card") {
        add_treat(&app, "알림 카드 수락");
    }
    if ok {
        Ok(())
    } else {
        sync_notify(&app);
        Err(i18n::t("err.permit_gone").into())
    }
}

/// 오피스 밖에서 생긴 간식 몫(권한 승인·작업 완료) 하나를 더하고, 오피스 창이 열려 있으면 바로 가져가라고 알린다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `why`: 로그에 남길 사유
///
/// # 참조
/// `AppState::treats`. `answer_permit`·`PermitHost::auto_allowed`·`turn_done_treat` 가 호출. 오피스 창에 `treats` 이벤트를 보낸다.
fn add_treat(app: &AppHandle, why: &str) {
    let n = app.state::<AppState>().treats.fetch_add(1, Ordering::SeqCst) + 1;
    save_treats(n);
    log::debug!("간식 몫 +1: {why} (모인 몫 {n})");
    let _ = app.emit_to(office::LABEL, "treats", n);
}

/// 작업 완료 간식 몫을 마지막으로 더한 시각 — 열쇠 "<서비스>:<세션 id>". `turn_done_treat` 이 30초 제한에 쓰고,
/// `take_treats` 가 최근 것(30초 안)을 오피스에 알려 같은 완료를 오피스가 다시 세지 않게 한다.
static TURN_DONE_LAST: Mutex<Option<std::collections::HashMap<String, Instant>>> = Mutex::new(None);

/// 작업(턴)이 끝났을 때의 간식 — 세션마다 30초에 한 번.
///
/// 오피스가 준비돼 있고 그 서비스를 표시 중이면 오피스에 `turn_done` 이벤트("<서비스>:<세션 id>")를 보내 고양이 보고 연출(demo.js turnDone → report)이 지급하고,
/// 아니면 간식 몫(`add_treat`)으로 모은다. 둘 중 한쪽만 하므로 이중 지급이 없다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `why`: 로그에 남길 사유
/// - `provider`: "claude" | "chatgpt" | "antigravity"
/// - `session`: 세션 id (30초 제한 열쇠)
///
/// # 참조
/// `add_treat`, `provider_on`, `AppState::office_ready`. Claude Stop 훅(`local_session_event`), Codex `poll_finished`, Antigravity `agy_turn_done` 이 호출.
fn turn_done_treat(app: &AppHandle, why: &str, provider: &str, session: &str) {
    // 세션마다 30초에 한 번만 (짧은 문답이 이어지거나 백그라운드 에이전트 재개 Stop 이 겹쳐도 부풀지 않게 — 오피스 쪽 REPORT_GAP_MS 와 같음)
    {
        let mut g = TURN_DONE_LAST.lock().unwrap();
        let m = g.get_or_insert_with(Default::default);
        m.retain(|_, t| t.elapsed() < Duration::from_secs(600));
        let key = format!("{provider}:{session}");
        if m.get(&key).is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
            log::debug!("작업 완료 간식 건너뜀(30초 안 중복): {key}");
            return;
        }
        m.insert(key, Instant::now());
    }
    // 오피스가 준비돼 있고 그 서비스를 사무실에 표시 중이면 고양이 보고 연출로 지급하라고 알린다
    // (조회로 바쁨→쉼을 기다리면 짧은 턴·곧바로 다음 입력을 넣은 턴을 놓침). 아니면 간식 몫으로 모은다.
    let shown = provider == "claude" || provider_on(provider);
    if app.state::<AppState>().office_ready.load(Ordering::SeqCst) && shown {
        let _ = app.emit_to(office::LABEL, "turn_done", format!("{provider}:{session}"));
        return;
    }
    add_treat(app, why);
}

/// 채팅 턴이 정상 종료됐을 때의 완료 보고 — 간식(`turn_done_treat`)과, Claude 는 오피스가 닫혀 있을 때만 알림 카드.
///
/// 소유 세션은 전역 Stop 훅 알림이 건너뛰므로(`PermitHost::session_event`) 여기서 한 번만 낸다.
/// Codex 의 완료 알림 카드는 rollout 폴링(`codex::poll_finished`)이 이미 내므로 카드는 만들지 않는다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `provider`: "claude" | "chatgpt"
/// - `session`: 서비스 세션 id
/// - `project`: 프로젝트(폴더) 이름
///
/// # 참조
/// `turn_done_treat`, `alerts::Alerts::add_local`. `runner::Runner::report_done` 이 호출.
pub(crate) fn chat_turn_done(app: &AppHandle, provider: &str, session: &str, project: &str) {
    log::info!("채팅 턴 완료 보고: {provider} · {project}");
    turn_done_treat(app, "채팅 작업 완료", provider, session);
    if provider == "claude" && !app.state::<AppState>().office_ready.load(Ordering::SeqCst) {
        let now = Utc::now();
        app.state::<AppState>().alerts.lock().unwrap().add_local(alerts::Alert {
            key: format!("local:{session}@{}", now.timestamp_millis()),
            id: session.to_string(),
            title: if project.is_empty() { "Claude".into() } else { format!("Claude · {project}") },
            message: i18n::t("alert.done").into(),
            state: "done".into(),
            env: "local".into(),
            updated_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            project: project.to_string(),
            ..Default::default()
        });
        alerts_changed(app);
    }
}

/// 채팅 실행기가 Claude 세션에 새 메시지를 보낼 때 — 그 세션(에이전트 포함)의 로컬 알림("응답 완료" 등)을 해소한다.
///
/// 소유 세션의 전역 훅은 `PermitHost::session_event` 에서 걸러지므로, 터미널에서 끝나 남은 카드는 여기서만 풀린다.
///
/// # 참조
/// `alerts::Alerts::resolve_local_session`. `runner::Runner::chat_send` 가 호출.
pub(crate) fn chat_resume_local(app: &AppHandle, session: &str) {
    if app.state::<AppState>().alerts.lock().unwrap().resolve_local_session(session, true) {
        log::debug!("채팅 이어 말하기 — 로컬 세션 알림 해소: {session}");
        alerts_changed(app);
    }
}

/// Antigravity 연동 기본 켬 결과를 설정 파일에 남긴다.
///
/// 설정 화면에서 한 번도 저장하지 않은 파일(템플릿 그대로: agy_hook·hook_token 줄 없음)은 맨 끝에 줄만 덧붙여 템플릿 설명 주석을 살리고,
/// 그 밖에는 `config::save` 로 통째로 쓴다(이미 저장된 적이 있어 주석이 없는 파일).
///
/// # 인자
/// - `path`: 설정 파일 경로
/// - `c`: 저장할 설정 (agy_hook·agy_hook_defaulted·hook_token 이 채워진 것)
///
/// # 반환
/// 쓰기 실패 시 `Err`.
///
/// # 참조
/// `config::save`. `main` 의 시작 루틴이 호출.
fn persist_agy_default(path: &std::path::Path, c: &config::Config) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let has = |k: &str| text.lines().any(|l| l.trim_start().starts_with(k) && l.contains('='));
    if text.is_empty() || has("agy_hook") || has("hook_token") {
        return config::save(path, c);
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path)?;
    write!(
        f,
        "\n# Antigravity 권한 요청·응답 완료 연동(~/.gemini/config/hooks.json 에 훅 등록). 설정 화면에서 끌 수 있습니다.\nagy_hook = true\nagy_hook_defaulted = true\n# 훅·권한 요청 서버 인증 토큰 (자동 생성)\nhook_token = \"{}\"\n",
        c.hook_token
    )
}

/// 간식 몫 저장 파일 경로 (로그 폴더의 형제 파일 `treats`).
///
/// # 참조
/// `applog::dir`. `load_treats`·`save_treats` 가 사용.
fn treats_path() -> std::path::PathBuf {
    applog::dir().with_file_name("treats")
}

/// 저장해 둔 간식 몫을 읽는다 (앱 시작 때 1회). 없거나 못 읽으면 0.
///
/// # 참조
/// `treats_path`. `main` 의 `AppState` 초기화가 호출.
fn load_treats() -> u32 {
    std::fs::read_to_string(treats_path()).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// 간식 몫을 파일에 쓴다. 실패는 로그만 남긴다(이번 실행 동안은 메모리 값으로 동작).
///
/// # 인자
/// - `n`: 저장할 몫
///
/// # 참조
/// `treats_path`. `add_treat`·`take_treats` 가 호출.
fn save_treats(n: u32) {
    let p = treats_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Err(e) = std::fs::write(&p, n.to_string()) {
        log::warn!("간식 몫 저장 실패: {e}");
    }
}

/// 모아 둔 간식 몫을 꺼내 0으로 되돌리고, 최근 몫으로 센 작업 완료 목록을 함께 준다 (오피스가 간식으로 지급).
///
/// 오피스는 이벤트 리스너를 등록한 뒤 이 명령을 부르므로, 여기서 `office_ready` 를 켠다(이후 자동 수락은 이벤트로 바로 연출).
///
/// # 반환
/// `TreatsTaken` (꺼낸 몫, 최근 센 작업 완료 열쇠).
///
/// # 참조
/// `AppState::treats`, `add_treat`. UI 의 `invoke('take_treats')`(office/office.js) 가 오피스를 열 때와 `treats` 이벤트 때 호출.
#[tauri::command]
fn take_treats(app: AppHandle) -> TreatsTaken {
    let st = app.state::<AppState>();
    st.office_ready.store(true, Ordering::SeqCst);
    let n = st.treats.swap(0, Ordering::SeqCst);
    if n > 0 {
        save_treats(0);
    }
    // 제보 분석용: 오피스를 열 때 "밖에서 모인 몫"과 간식이 들어오는 길(연동)이 켜져 있는지 남긴다 (모두 꺼져 있으면 간식이 안 쌓이는 게 정상)
    let c = config::load().config;
    let (perm, codex, agy) = (c.permission_hook, c.codex_hook, c.agy_hook);
    log::debug!("간식 몫 꺼냄: {n}개 (연동 — Claude {perm}, Codex {codex}, Antigravity {agy})");
    let recent = TURN_DONE_LAST
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.iter().filter(|(_, t)| t.elapsed() < Duration::from_secs(30)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    TreatsTaken { n, recent }
}

/// 오피스 진행 기록: 간식 누계·고양이 타워 해제 여부·고양이(품종)별 경험치 — 설정처럼 앱 데이터 폴더에 둔다(업데이트·재설치에도 남게).
/// 예전 간식 누계는 오피스 창의 localStorage 에만 있어서, WebView 저장소가 비면(설치 방식에 따라) 0으로 돌아갔다.
/// 레벨은 경험치에서 계산한다(ui/office/demo.js levelOf) — 파일에는 경험치만 둔다.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Progress {
    /// 간식 누계
    points: u64,
    /// 고양이 타워 해제 여부
    unlocked: bool,
    /// 고양이에게 준 간식 누계(쓴 만큼). 남은 간식 = points - spent
    spent: u64,
    /// 고양이별 경험치(받아 온 간식 수). 열쇠 = 품종 이름(같은 세션은 늘 같은 품종이라 그 고양이로 계속 자란다)
    cats: std::collections::BTreeMap<String, u64>,
}

/// 진행 기록 파일 경로: 로그 폴더의 형제 파일 `progress.json` (debug 빌드는 `progress.dev.json`).
fn progress_path() -> std::path::PathBuf {
    applog::dir().with_file_name(if cfg!(debug_assertions) { "progress.dev.json" } else { "progress.json" })
}

/// 저장된 진행 기록 (없거나 못 읽으면 None — 오피스가 localStorage 값으로 대신하고 다음 저장 때 파일로 옮긴다).
///
/// # 참조
/// `progress_path`. UI 의 `invoke('get_progress')`(office/office.js) 가 오피스를 열 때 호출.
#[tauri::command]
fn get_progress() -> Option<Progress> {
    std::fs::read_to_string(progress_path()).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// 진행 기록을 저장한다. 값은 줄어들지 않게 합친다(누계·경험치는 큰 쪽, 해제는 한 번 풀리면 유지) —
/// 창 둘이 동시에 쓰거나 옛 값이 늦게 와도 잃지 않게.
///
/// # 참조
/// `progress_path`. UI 의 `invoke('set_progress')`(office/demo.js saveProgress) 가 호출.
#[tauri::command]
fn set_progress(progress: Progress) -> Result<(), String> {
    let mut v = get_progress().unwrap_or_default();
    v.points = v.points.max(progress.points);
    v.unlocked |= progress.unlocked;
    v.spent = v.spent.max(progress.spent);
    for (k, xp) in progress.cats {
        let e = v.cats.entry(k).or_insert(0);
        *e = (*e).max(xp);
    }
    let p = progress_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// `take_treats` 결과.
#[derive(Serialize)]
struct TreatsTaken {
    /// 꺼낸 간식 몫
    n: u32,
    /// 최근 30초 안에 몫으로 센 작업 완료 — "<서비스>:<세션 id>" (오피스가 같은 완료를 다시 보고하지 않게)
    recent: Vec<String>,
}

/// 알림 창 목록을 실제 상태로 다시 맞춤(미리보기 카드 정리용).
///
/// # 참조
/// `sync_notify`. UI 의 `invoke('resync_notify')`(notify.js) 가 호출.
#[tauri::command]
fn resync_notify(app: AppHandle) {
    sync_notify(&app);
}

/// 알림 카드를 닫는다.
///
/// # 인자
/// - `key`: 알림 키(`alerts::Alert.key`)
///
/// # 참조
/// `alerts::Alerts::dismiss`, `alerts_changed`. UI 의 `invoke('dismiss_alert')`(notify.js) 가 호출. `open_alert` 도 내부에서 호출.
#[tauri::command]
fn dismiss_alert(app: AppHandle, key: String) {
    log::debug!("알림 닫음: {key}");
    app.state::<AppState>().alerts.lock().unwrap().dismiss(&key);
    alerts_changed(&app);
}

/// 단순 알림 카드 자동 숨김(설정 시간 경과). 읽지 않은 상태로 남김.
///
/// # 인자
/// - `key`: 알림 키
///
/// # 참조
/// `alerts::Alerts::expire`, `save_alert_marks`, `sync_notify`. UI 의 `invoke('expire_alert')`(notify.js) 가 호출.
#[tauri::command]
fn expire_alert(app: AppHandle, key: String) {
    log::debug!("알림 자동 숨김: {key}");
    app.state::<AppState>().alerts.lock().unwrap().expire(&key);
    save_alert_marks(&app);
    sync_notify(&app);
}

/// 패널 알림 탭 목록.
///
/// # 반환
/// `alerts::Entry` 배열(JSON). UI 의 `invoke('get_alert_history')`(office/office.js) 가 호출.
#[tauri::command]
fn get_alert_history(app: AppHandle) -> Vec<alerts::Entry> {
    app.state::<AppState>().alerts.lock().unwrap().history()
}

/// 패널 알림 탭을 봄 → 전부 읽음(트레이 배지 해제). 읽은 카드는 내림(입력 대기 카드는 유지).
///
/// 알림 목록 잠금 안에서 전부 읽음 처리하고 표시 카드 수 변화를 센다. 바뀐 게 있을 때만 로그와 `alerts_changed` 를 부른다(잠금 밖).
///
/// # 참조
/// `alerts::Alerts::mark_read`, `alerts_changed`. UI 의 `invoke('mark_alerts_read')`(office/appbits.js) 가 호출.
#[tauri::command]
fn mark_alerts_read(app: AppHandle) {
    let (changed, taken) = {
        let state = app.state::<AppState>();
        let mut a = state.alerts.lock().unwrap();
        let before = a.visible().len();
        let changed = a.mark_read(None);
        (changed, before - a.visible().len())
    };
    if changed {
        log::debug!("알림 전부 읽음(오피스 최근 알림) — 카드 {taken}개 내림");
        alerts_changed(&app);
    }
}

/// "자세히": 세션 대화를 브라우저(설정 시 데스크톱 앱)로 열고 카드 닫기.
///
/// 키가 "preview-" 로 시작하는 미리보기 카드는 별도 스레드에서 최근 클라우드 세션 링크(없으면 claude.ai/code)를 열고 닫는다.
/// 그 외에는 알림을 찾아, 로컬 세션이면(설정 켜짐+데스크톱 앱 설치 시) 앱의 해당 세션으로 이동하고, 아니면 알림의 URL 을 연다. 끝나면 카드를 닫는다.
///
/// # 인자
/// - `key`: 알림 키
///
/// # 반환
/// 성공하면 `Ok(())`. 알림이 이미 없으면 `Err("이미 처리된 알림")`, URL 열기 실패는 그 오류.
///
/// # 참조
/// `open_url`, `desktop_session_for`, `open_link`, `dismiss_alert`. UI 의 `invoke('open_alert')`(notify.js) 가 호출.
#[tauri::command(async)] // 메인 스레드 밖에서(외부 프로세스·파일 읽기 대기로 창이 멈추지 않게)
fn open_alert(app: AppHandle, key: String) -> Result<(), String> {
    // 미리보기 카드: 링크 열기 동작 확인용으로 최근 클라우드 세션(없으면 Claude Code 홈) 열기.
    if key.starts_with("preview-") {
        std::thread::spawn(|| {
            let cfg = config::load().config;
            let url = oauth::fetch_cloud_sessions(&config::claude_dir(&cfg), Utc::now() - CDuration::days(7))
                .ok()
                .and_then(|list| list.into_iter().map(|s| s.url).find(|u| u.starts_with("https://claude.ai/")))
                .unwrap_or_else(|| "https://claude.ai/code".into());
            let _ = open_url(url);
        });
        dismiss_alert(app, key);
        return Ok(());
    }
    let alert = app.state::<AppState>().alerts.lock().unwrap().find(&key);
    let Some(a) = alert else {
        return Err(i18n::t("err.alert_gone").into());
    };
    if a.env == "local" {
        // 터미널·IDE 창은 앞으로 가져올 수 없음 — 데스크톱 앱에서 연 세션만 앱으로 이동.
        if config::load().config.open_in_desktop && desktop_app_installed() {
            if let Some(local) = desktop_session_for(&a.id) {
                let _ = open_link(&format!("claude://claude.ai/epitaxy/{local}"));
            }
        }
        dismiss_alert(app, key);
        return Ok(());
    }
    open_url(a.url)?;
    dismiss_alert(app, key);
    Ok(())
}

/// 설정의 "미리보기": 패널을 닫고 데모 카드를 알림 창에 표시(실제 알림 상태는 건드리지 않음).
/// 카드의 닫기/자세히 → dismiss_alert → 실제 목록으로 재동기화되며 사라짐.
///
/// 알림 3종(입력 대기·검토 준비·에이전트 완료)과 권한 요청 2종(도구·질문)을 만들어 `notify` 창에 보내고 우하단에 표시한다.
///
/// # 참조
/// 이벤트 `alerts`·`permits`·`notify_visible`(notify 창), `place`. UI 의 `invoke('preview_alert')`(settings.js) 가 호출.
#[tauri::command]
fn preview_alert(app: AppHandle) {
    let Some(nw) = app.get_webview_window("notify") else {
        return;
    };
    let now = Utc::now();
    let at = |min: i64| (now - CDuration::minutes(min)).to_rfc3339_opts(SecondsFormat::Secs, true);
    let demo = vec![
        alerts::Alert {
            key: "preview-1".into(),
            id: "preview-1".into(),
            title: i18n::t("preview.1.title").into(),
            message: i18n::t("preview.1.message").into(),
            state: "need_input".into(),
            env: "bridge".into(),
            url: String::new(),
            updated_at: at(2),
            ..Default::default()
        },
        alerts::Alert {
            key: "preview-2".into(),
            id: "preview-2".into(),
            title: i18n::t("preview.2.title").into(),
            message: i18n::t("alert.remote.review_ready").into(),
            state: "review_ready".into(),
            env: "cloud".into(),
            url: String::new(),
            updated_at: at(0),
            ..Default::default()
        },
        alerts::Alert {
            key: "preview-3".into(),
            id: "preview-3".into(),
            title: i18n::t("preview.3.title").into(),
            message: i18n::t("preview.3.message").into(),
            state: "done".into(),
            env: "local".into(),
            url: String::new(),
            updated_at: at(0),
            agent: true,
            ..Default::default()
        },
    ];
    let permits = vec![
        permit::Permit {
            id: "preview".into(),
            kind: "tool",
            provider: "claude",
            project: "muneo-claude-usage-tray".into(),
            tool: "Bash".into(),
            detail: "npm run build".into(),
            description: i18n::t("preview.permit.desc").into(),
            created_at: at(0),
            questions: serde_json::Value::Null,
            session: String::new(),
            tool_input: serde_json::Value::Null,
        },
        permit::Permit {
            id: "preview-q".into(),
            kind: "question",
            provider: "claude",
            project: "muneo-claude-usage-tray".into(),
            tool: "AskUserQuestion".into(),
            detail: String::new(),
            description: String::new(),
            created_at: at(0),
            questions: serde_json::json!([
                { "header": i18n::t("preview.q.1.header"), "question": i18n::t("preview.q.1.question"), "multiSelect": false,
                  "options": [{ "label": i18n::t("preview.q.1.opt1"), "description": i18n::t("preview.q.1.opt1desc") }, { "label": i18n::t("preview.q.1.opt2"), "description": i18n::t("preview.q.1.opt2desc") }] },
                { "header": i18n::t("preview.q.2.header"), "question": i18n::t("preview.q.2.question"), "multiSelect": true,
                  "options": [{ "label": i18n::t("preview.q.2.opt1") }, { "label": i18n::t("preview.q.2.opt2") }, { "label": i18n::t("preview.q.2.opt3") }] }
            ]),
            session: String::new(),
            tool_input: serde_json::Value::Null,
        },
    ];
    let _ = app.emit_to("notify", "alerts", &demo);
    let _ = app.emit_to("notify", "permits", &permits);
    place(&nw, None);
    let _ = nw.show();
    let _ = app.emit_to("notify", "notify_visible", true);
}

/// 알림 창 높이를 카드 수에 맞추고 우하단 재배치(논리 px).
///
/// 현재 너비를 유지하고 높이만 60~900 범위로 제한해 적용한 뒤 `place` 로 다시 놓는다.
///
/// # 인자
/// - `height`: 원하는 높이(논리 px, 60.0~900.0 로 제한)
///
/// # 참조
/// `place`. UI 의 `invoke('notify_resize')`(notify.js) 가 호출.
#[tauri::command]
fn notify_resize(app: AppHandle, height: f64) {
    let Some(nw) = app.get_webview_window("notify") else {
        return;
    };
    let w = nw.outer_size().ok().zip(nw.scale_factor().ok()).map(|(s, f)| s.width as f64 / f).unwrap_or(400.0);
    let _ = nw.set_size(tauri::LogicalSize::new(w, height.clamp(60.0, 900.0)));
    place(&nw, None);
}

// ── 커맨드 ─────────────────────────────────────────────────────────────────

/// 플랜 한도 스냅샷을 돌려준다.
///
/// 네트워크를 쓰는 `refresh_plan` 을 blocking 스레드에서 실행한다. 스레드 실패는 오류 스냅샷으로 바꿔 돌려준다.
///
/// # 인자
/// - `force`: true 면 `PLAN_MIN_GAP` 캐시를 무시하고 새로 조회
///
/// # 반환
/// `PlanSnap` JSON `{ plan, error, error_kind, fetched_at }`.
///
/// # 참조
/// `refresh_plan`. UI 의 `invoke('get_plan')`(office/appbits.js, office/office.js) 가 호출. 이벤트 `plan`.
#[tauri::command]
async fn get_plan(app: AppHandle, force: bool) -> PlanSnap {
    tauri::async_runtime::spawn_blocking(move || refresh_plan(&app, force)).await.unwrap_or_else(|e| PlanSnap {
        plan: None,
        error: Some(e.to_string()),
        error_kind: None,
        state: None,
        fetched_at: String::new(),
    })
}

/// API 크레딧 탭 데이터. configured=false 면 Admin 키 미설정(안내 표시).
///
/// `get_api_usage` 의 반환 JSON `{ configured, allocated, report, error, fetched_at }`.
#[derive(Serialize)]
struct ApiSnap {
    /// Admin API 키가 설정돼 있음.
    configured: bool,
    /// 사용자가 정한 할당 금액(USD, 0 이상).
    allocated: f64,
    /// 조회에 성공한 사용액 보고서. 실패·미설정이면 None.
    report: Option<apicost::Report>,
    /// 조회 실패 메시지.
    error: Option<String>,
    /// 조회 시각(RFC3339, 초 단위, UTC). 스레드 오류 대체값에서는 빈 문자열.
    fetched_at: String,
}

/// API 크레딧 탭 데이터를 조회한다.
///
/// blocking 스레드에서 설정을 읽어 할당액을 구하고, Admin 키가 있으면 `apicost::report` 로 사용액을 조회한다.
/// 조회 실패는 경고 로그를 남기고 `error` 에 담는다. 스레드 실패는 `configured=true` 의 오류 값으로 바꾼다.
///
/// # 인자
/// - `force`: true 면 `apicost` 캐시를 무시하고 새로 조회
///
/// # 반환
/// `ApiSnap` JSON `{ configured, allocated, report, error, fetched_at }`.
///
/// # 참조
/// `config::admin_key`, `apicost::report`. UI 의 `invoke('get_api_usage')`(office/usage.js) 가 호출.
#[tauri::command]
async fn get_api_usage(force: bool) -> ApiSnap {
    tauri::async_runtime::spawn_blocking(move || {
        let c = config::load().config;
        let mut snap = ApiSnap {
            configured: false,
            allocated: c.api_allocated_usd.max(0.0),
            report: None,
            error: None,
            fetched_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        };
        if let Some(key) = config::admin_key(&c) {
            snap.configured = true;
            match apicost::report(&key, force) {
                Ok(r) => snap.report = Some(r),
                Err(e) => {
                    log::warn!("API 사용액 조회 실패: {e}");
                    snap.error = Some(e.to_string());
                }
            }
        }
        snap
    })
    .await
    .unwrap_or_else(|e| ApiSnap {
        configured: true,
        allocated: 0.0,
        report: None,
        error: Some(e.to_string()),
        fetched_at: String::new(),
    })
}

/// 설정 "검증": 입력한 키(비우면 저장된 키)로 cost_report 1건 조회.
///
/// # 인자
/// - `key`: 검증할 Admin API 키. 공백뿐이면 저장된 키를 사용
///
/// # 반환
/// 검증에 성공하면 `Ok(())`. 저장된 키가 없으면 `Err("저장된 키가 없습니다")`, 그 외에는 조회 오류 문자열.
///
/// # 참조
/// `apicost::validate`. UI 의 `invoke('validate_api_key')`(settings.js) 가 호출.
#[tauri::command]
async fn validate_api_key(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key =
            if key.trim().is_empty() { config::admin_key(&config::load().config).ok_or(i18n::t("err.no_saved_key"))? } else { key };
        apicost::validate(key.trim()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// API 크레딧 설정 저장. key: None = 그대로, Some("") = 지움, Some(키) = 바꿈.
///
/// 할당액은 유한한 0 이상 값으로 보정한다. 키를 바꾸거나 지우면 사용액 캐시도 비운다. 설정 파일 저장 오류는 로그에 남긴다.
///
/// # 인자
/// - `allocated`: 할당 금액(USD). 음수·NaN·무한대는 0 으로 보정
/// - `key`: Admin API 키 변경(None 유지 / Some("") 삭제 / Some(키) 교체)
///
/// # 반환
/// 저장에 성공하면 `Ok(())`, 실패하면 오류 문자열.
///
/// # 참조
/// `config::set_admin_key`, `apicost::clear_cache`, `config::save`. UI 의 `invoke('save_api_config')`(settings.js) 가 호출.
#[tauri::command]
fn save_api_config(allocated: f64, key: Option<String>) -> Result<(), String> {
    let loaded = config::load();
    let mut c = loaded.config;
    c.api_allocated_usd = if allocated.is_finite() { allocated.max(0.0) } else { 0.0 };
    if let Some(k) = key {
        config::set_admin_key(&mut c, &k).inspect_err(|e| log::error!("Admin API 키 저장 실패: {e}"))?;
        apicost::clear_cache();
    }
    log::info!("API 크레딧 설정 저장: 할당 ${}, 키 {}", c.api_allocated_usd, if c.admin_api_key_enc.is_empty() { "없음" } else { "있음" });
    config::save(&loaded.path, &c).map_err(|e| {
        log::error!("설정 파일 저장 실패: {e}");
        e.to_string()
    })
}

/// 로컬(Claude Code) 세션 사용량 보고서를 돌려준다.
///
/// blocking 스레드에서 Claude 설정 폴더의 세션 기록을 읽어 집계한다.
///
/// # 인자
/// - `days`: 집계 기간(일)
///
/// # 반환
/// `local::LocalReport` JSON. 스레드 실패는 오류 문자열.
///
/// # 참조
/// `local::report`. UI 의 `invoke('get_local')`(office/office.js, office/usage.js) 가 호출.
#[tauri::command]
async fn get_local(days: u32) -> Result<local::LocalReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config::load().config;
        local::report(&config::claude_dir(&cfg), days)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 로컬 세션이 마지막으로 받은 이미지 (오피스 책상 모니터에 띄움). 없으면 None.
///
/// blocking 스레드에서 Claude 설정 폴더의 세션 기록을 읽어 마지막 이미지를 찾는다. 스레드 실패도 None 으로 취급한다.
///
/// # 인자
/// - `id`: 로컬 세션 id
///
/// # 반환
/// 이미지 문자열(`local::last_image` 가 만든 값), 없으면 `null`.
///
/// # 참조
/// `local::last_image`. UI 의 `invoke('get_session_image')`(office/office.js) 가 호출.
#[tauri::command]
async fn get_session_image(id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config::load().config;
        local::last_image(&config::claude_dir(&cfg), &id)
    })
    .await
    .ok()
    .flatten()
}

/// 다른 AI 서비스 연동 켬 목록 (설정 파일). None = 아직 저장한 적 없음.
///
/// # 반환
/// 서비스 이름 배열 또는 `null`. UI 의 `invoke('get_providers_on')`(common.js) 가 호출.
#[tauri::command]
fn get_providers_on() -> Option<Vec<String>> {
    config::load().config.providers_on
}

/// 다른 AI 서비스 연동 켜기/끄기 — 바로 설정 파일에 저장(다시 실행해도 유지).
///
/// 이름이 "chatgpt"·"antigravity" 가 아니면 거부한다. 설정의 `providers_on` 에서 해당 이름을 빼고, 켜는 경우에만 다시 넣어 저장한다.
///
/// # 인자
/// - `name`: 서비스 이름("chatgpt" | "antigravity")
/// - `on`: true 켜기, false 끄기
///
/// # 반환
/// 저장에 성공하면 `Ok(())`. 알 수 없는 이름이면 `Err("알 수 없는 서비스")`, 저장 실패는 오류 문자열.
///
/// # 참조
/// `config::save`. UI 의 `invoke('set_provider_on')`(common.js) 가 호출.
#[tauri::command]
fn set_provider_on(name: String, on: bool) -> Result<(), String> {
    if !matches!(name.as_str(), "chatgpt" | "antigravity") {
        return Err(i18n::t("err.unknown_service").into());
    }
    let loaded = config::load();
    let mut c = loaded.config;
    let mut list = c.providers_on.take().unwrap_or_default();
    list.retain(|x| x != &name);
    if on {
        list.push(name);
    }
    c.providers_on = Some(list);
    config::save(&loaded.path, &c).map_err(|e| e.to_string())
}

/// 웹 서비스 장애 알림 한 건(화면용).
#[derive(Serialize)]
struct WebIssueView {
    /// 카드 제목
    title: String,
    /// 본문(장애 이름·영향 구성요소)
    detail: String,
    /// 자세히 링크
    url: String,
}

/// 웹 서비스(계정) 한 곳의 화면용 상태.
///
/// `get_web_services` 의 반환 원소. `providers::WEB_SERVICES` 항목에 알림 상태를 더한 것이다.
#[derive(Serialize)]
struct WebServiceView {
    /// 웹 서비스 식별자 ("claude" | "chatgpt" | "gemini")
    id: &'static str,
    /// 화면 이름
    label: &'static str,
    /// 계정 제공사
    account: &'static str,
    /// 바로가기 주소
    url: &'static str,
    /// 이 계정 아래 도구의 서비스 키
    tool: &'static str,
    /// 장애 알림을 설정에서 켜고 끌 수 있음 (Claude 는 항상 켜짐 → false)
    alertable: bool,
    /// 장애 알림이 켜져 있음
    alerts_on: bool,
    /// 한 번이라도 확인함
    checked: bool,
    /// 지금 장애(없으면 None)
    issue: Option<WebIssueView>,
    /// 상태 페이지 주소
    status_page: &'static str,
}

/// 웹 서비스 표와 장애 알림 상태를 돌려준다 (설정 파일 1회 읽기뿐이라 동기 명령).
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 반환
/// `providers::WEB_SERVICES` 순서의 `WebServiceView` 목록.
///
/// # 참조
/// `providers::WEB_SERVICES`, `WEB_STATUS`, `health::Health::current`. UI 의 `invoke('get_web_services')`(office/usage.js, settings.js) 가 호출.
#[tauri::command]
fn get_web_services(app: AppHandle) -> Vec<WebServiceView> {
    let state = app.state::<AppState>();
    let on = config::load().config.web_status_alerts;
    let view = |i: health::Issue| WebIssueView { title: i.title, detail: i.detail, url: i.url };
    providers::WEB_SERVICES
        .iter()
        .map(|w| {
            let mut v = WebServiceView {
                id: w.id,
                label: w.label,
                account: w.account,
                url: w.url,
                tool: w.tool,
                alertable: false,
                alerts_on: true,
                checked: true,
                issue: None,
                status_page: health::STATUS_PAGE,
            };
            if w.id == "claude" {
                v.issue = state.health.lock().unwrap().current().map(view);
            } else if let Some((_, key, _, _, page, _)) = WEB_STATUS.iter().find(|x| x.0 == w.id) {
                let g = state.phealth.lock().unwrap();
                v.alertable = true;
                v.alerts_on = on.iter().any(|n| n == w.id);
                v.checked = g.contains_key(key);
                v.issue = g.get(key).and_then(|h| h.current()).map(view);
                v.status_page = page;
            }
            v
        })
        .collect()
}

/// 웹 서비스 장애 알림 켜기/끄기 — 바로 설정 파일에 저장.
///
/// 이름이 "chatgpt"·"gemini" 가 아니면 거부한다. 설정의 `web_status_alerts` 에서 이름을 빼고, 켜는 경우에만 다시 넣어 저장한다.
///
/// # 인자
/// - `name`: 서비스 이름("chatgpt" | "gemini")
/// - `on`: true 켜기, false 끄기
///
/// # 반환
/// 저장에 성공하면 `Ok(())`. 알 수 없는 이름이면 `Err("알 수 없는 서비스")`, 저장 실패는 오류 문자열.
///
/// # 참조
/// `config::save`. UI 의 `invoke('set_web_status_alert')`(settings.js) 가 호출. 반영은 `poll_web_status` 가 다음 15초 주기에.
#[tauri::command]
fn set_web_status_alert(name: String, on: bool) -> Result<(), String> {
    if !matches!(name.as_str(), "chatgpt" | "gemini") {
        return Err(i18n::t("err.unknown_service").into());
    }
    let loaded = config::load();
    let mut c = loaded.config;
    c.web_status_alerts.retain(|x| x != &name);
    if on {
        c.web_status_alerts.push(name);
    }
    config::save(&loaded.path, &c).map_err(|e| e.to_string())
}

/// 서비스 훅 연동 상태(설정 화면 표시용).
///
/// `get_provider_hook`·`set_provider_hook` 의 반환 JSON `{ enabled, installed, stale, auto_allow, path, present, warning }`.
#[derive(Serialize)]
struct ProviderHookState {
    /// 설정에서 켜 두었고 hooks.json 에 우리 항목이 있음.
    enabled: bool,
    /// hooks.json 에 우리 항목이 있음(설정은 꺼져 있어도 남아 있을 수 있음).
    installed: bool,
    /// 등록된 명령이 지금 실행 중인 exe 와 다름(앱을 옮기거나 업데이트함 → 다시 켜야 갱신, Codex 는 다시 신뢰 필요).
    stale: bool,
    /// 해당 서비스 권한 요청 자동 수락 설정.
    auto_allow: bool,
    /// 수정하는 훅 파일 경로.
    path: String,
    /// 서비스 설정 폴더가 이 PC 에 있음.
    present: bool,
    /// 처리는 됐지만 알릴 문제(예: 끄는 중 훅 파일을 고치지 못함).
    warning: Option<String>,
}

/// 서비스 이름을 훅 종류로 바꾼다.
///
/// # 인자
/// - `name`: "chatgpt" 또는 "antigravity"
///
/// # 반환
/// "chatgpt" → `Provider::Codex`, "antigravity" → `Provider::Agy`. 그 외는 `Err("알 수 없는 서비스")`.
///
/// # 참조
/// `get_provider_hook`, `set_provider_hook`
fn provider_of(name: &str) -> Result<provider_hook::Provider, String> {
    match name {
        "chatgpt" => Ok(provider_hook::Provider::Codex),
        "antigravity" => Ok(provider_hook::Provider::Agy),
        _ => Err(i18n::t("err.unknown_service").into()),
    }
}

/// 훅에 등록할 이 앱 실행 파일 경로(공백·특수문자가 있으면 Windows 8.3 짧은 경로 — 못 얻으면 한국어 오류).
///
/// 현재 실행 파일 경로를 구해 `provider_hook::hook_exe` 로 훅 명령에 쓸 수 있는 형태로 바꾼다.
///
/// # 반환
/// 훅 명령에 넣을 실행 파일 경로 문자열. 경로를 알 수 없으면 "앱 경로를 알 수 없습니다: …", 변환 실패는 `hook_exe` 의 오류.
///
/// # 참조
/// `provider_hook::hook_exe`. `provider_hook_state`·`set_provider_hook`·`main` 에서 호출.
fn exe_string() -> Result<String, String> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| i18n::tf("err.app_path", &[("e", &e.to_string())]))?;
    provider_hook::hook_exe(&exe)
}

/// Antigravity 가 스스로 물을 설정이라 PreToolUse(권한 카드) 훅을 둘 수 있는가.
///
/// # 반환
/// Antigravity 설정을 읽어 `provider_hook::agy_policy` 가 `Card` 면 true.
///
/// # 참조
/// `provider_hook::read_agy_config`. `set_provider_hook`·`main` 의 훅 자가 치유에서 호출.
fn agy_card() -> bool {
    provider_hook::agy_policy(provider_hook::read_agy_config().as_ref()) == provider_hook::AgyPolicy::Card
}

/// 등록돼야 할 대표 명령(설치 상태 비교용).
///
/// Antigravity 는 PreToolUse 가 없을 수도 있어 항상 있는 Stop 명령으로 비교하고, Codex 는 permission 명령으로 비교한다.
///
/// # 인자
/// - `p`: 서비스 종류
/// - `exe`: 훅에 등록할 실행 파일 경로
///
/// # 반환
/// `provider_hook::command_line` 이 만든 훅 명령줄.
///
/// # 참조
/// `provider_hook_state`, `set_provider_hook`, `main`
fn wanted_command(p: provider_hook::Provider, exe: &str) -> String {
    // Antigravity 는 PreToolUse 가 없을 수도 있어 항상 있는 Stop 명령으로 비교
    let event = if p == provider_hook::Provider::Codex { "permission" } else { "stop" };
    provider_hook::command_line(exe, p, event)
}

/// 서비스 훅 연동 상태를 구성한다.
///
/// 서비스 설정 폴더에서 등록된 명령을 읽어 설치 여부를 정하고, 현재 실행 파일 기준 기대 명령(`wanted_command`)과 다르면 `stale` 로 표시한다.
/// `enabled` 는 설정이 켜져 있고 실제로 설치돼 있을 때만 true 이다. `warning` 은 항상 None 으로 시작한다.
///
/// # 인자
/// - `p`: 서비스 종류
/// - `c`: 현재 설정
///
/// # 반환
/// `ProviderHookState`.
///
/// # 참조
/// `provider_hook::installed_command`, `exe_string`. `get_provider_hook`·`set_provider_hook` 에서 호출.
fn provider_hook_state(p: provider_hook::Provider, c: &config::Config) -> ProviderHookState {
    let dir = p.dir();
    let installed_cmd = dir.as_deref().and_then(|d| provider_hook::installed_command(d, p));
    let installed = installed_cmd.is_some();
    let (on, auto_allow) = match p {
        provider_hook::Provider::Codex => (c.codex_hook, c.codex_auto_allow),
        provider_hook::Provider::Agy => (c.agy_hook, c.agy_auto_allow),
    };
    let stale = installed && exe_string().is_ok_and(|e| installed_cmd.as_deref() != Some(wanted_command(p, &e).as_str()));
    ProviderHookState {
        enabled: on && installed,
        installed,
        stale,
        auto_allow,
        path: dir.as_deref().map(|d| d.join("hooks.json").display().to_string()).unwrap_or_default(),
        present: dir.as_deref().is_some_and(|d| d.exists()),
        warning: None,
    }
}

/// 서비스 훅 연동 상태를 조회한다.
///
/// # 인자
/// - `name`: "chatgpt" | "antigravity"
///
/// # 반환
/// `ProviderHookState` JSON `{ enabled, installed, stale, auto_allow, path, present, warning }`. 알 수 없는 이름이면 `Err("알 수 없는 서비스")`.
///
/// # 참조
/// `provider_of`, `provider_hook_state`. UI 의 `invoke('get_provider_hook')`(settings.js) 가 호출.
#[tauri::command]
fn get_provider_hook(name: String) -> Result<ProviderHookState, String> {
    let p = provider_of(&name)?;
    Ok(provider_hook_state(p, &config::load().config))
}

/// ChatGPT(Codex)·Antigravity 권한 요청 연동 켜기/끄기 — 훅 파일 수정 + 설정 저장(바로 적용).
/// 훅 명령이 바뀌면 Codex 는 사용자가 다시 신뢰해야 한다.
///
/// 켤 때: 훅 토큰이 없으면 새로 만들고, 서비스 설정 폴더가 없으면(디버그 빌드의 시험용 폴더 지정 제외) 오류로 돌려보낸다. 그 다음 훅 파일을 수정하고 명령이 바뀌었으면 경고 로그를 남긴다.
/// 끌 때: 훅 파일 정리에 실패해도 설정은 끄고 `warning` 으로만 알린다(깨진 JSON 은 덮어쓰지 않음). 마지막에 설정을 저장한다.
///
/// # 인자
/// - `name`: "chatgpt" | "antigravity"
/// - `enabled`: 연동 켜기 여부
/// - `auto_allow`: 자동 수락 여부(`enabled` 가 false 면 무시되어 false)
///
/// # 반환
/// 적용 후의 `ProviderHookState`(끄다 실패한 파일 문제는 `warning`). 알 수 없는 서비스·설정 폴더 없음·훅 수정 실패·저장 실패는 오류 문자열.
///
/// # 참조
/// `provider_hook::apply`, `config::save`, `exe_string`, `agy_card`. UI 의 `invoke('set_provider_hook')`(settings.js) 가 호출.
#[tauri::command]
fn set_provider_hook(name: String, enabled: bool, auto_allow: bool) -> Result<ProviderHookState, String> {
    let p = provider_of(&name)?;
    let loaded = config::load();
    let mut c = loaded.config;
    if enabled && c.hook_token.is_empty() {
        c.hook_token = config::new_token();
    }
    match p {
        provider_hook::Provider::Codex => (c.codex_hook, c.codex_auto_allow) = (enabled, auto_allow && enabled),
        provider_hook::Provider::Agy => (c.agy_hook, c.agy_auto_allow) = (enabled, auto_allow && enabled),
    }
    let mut warning = None;
    if enabled {
        let dir = p.dir().ok_or(i18n::t("err.svc_dir_unknown"))?;
        let exe = exe_string()?;
        // 시험용 폴더 재지정(MUNEO_PROVIDER_HOOK_DIR)은 디버그 빌드에서만 폴더 검사를 건너뜀
        let test_dir = cfg!(debug_assertions) && std::env::var_os("MUNEO_PROVIDER_HOOK_DIR").is_some();
        if !dir.exists() && !test_dir {
            return Err(i18n::tf("err.svc_dir_missing", &[("svc", p.key()), ("dir", &dir.display().to_string())]));
        }
        let before = provider_hook::installed_command(&dir, p);
        provider_hook::apply(&dir, p, true, &exe, agy_card()).map_err(|e| {
            log::error!("{} 훅 적용 실패: {e}", p.key());
            i18n::tf("err.hook_write", &[("e", &e.to_string())])
        })?;
        if before.as_deref().is_some_and(|b| b != wanted_command(p, &exe)) {
            log::warn!("{} 훅 명령이 바뀌어 다시 신뢰(trust)가 필요할 수 있음", p.key());
        }
    } else if let Some(dir) = p.dir() {
        // 끄기는 훅 파일이 깨져 있어도 설정을 끈다 — 파일 문제는 알리기만(깨진 JSON 은 덮어쓰지 않음)
        if let Err(e) = provider_hook::apply(&dir, p, false, &exe_string().unwrap_or_default(), false) {
            log::error!("{} 훅 제거 실패(설정은 끔): {e}", p.key());
            warning = Some(i18n::tf("warn.hook_cleanup", &[("path", &dir.join("hooks.json").display().to_string()), ("e", &e.to_string())]));
        }
    }
    config::save(&loaded.path, &c).map_err(|e| e.to_string())?;
    log::info!("{} 권한 요청 연동 {} (자동 수락 {})", p.key(), if enabled { "켬" } else { "끔" }, auto_allow && enabled);
    let mut st = provider_hook_state(p, &c);
    st.warning = warning;
    Ok(st)
}

/// 다른 AI 서비스 상태 (name: "chatgpt" | "antigravity"). 파일·네트워크를 읽으므로 blocking 스레드에서
///
/// # 인자
/// - `name`: 서비스 이름
///
/// # 반환
/// `providers::Snapshot` JSON. 스레드 실패는 이름 "unknown" 에 `error` 를 채운 스냅샷.
///
/// # 참조
/// `providers::snapshot`. UI 의 `invoke('get_provider')`(office/office.js, settings.js) 가 호출.
#[tauri::command]
async fn get_provider(name: String) -> providers::Snapshot {
    tauri::async_runtime::spawn_blocking(move || providers::snapshot(&name)).await.unwrap_or_else(|e| {
        let mut s = providers::Snapshot::new("unknown");
        s.error = e.to_string();
        s
    })
}

/// 켠 서비스의 토큰 사용량 (모델·날짜·세션별, Claude 의 get_local 과 같은 모양). 꺼진 서비스는 읽지 않는다.
///
/// # 인자
/// - `name`: "chatgpt" | "antigravity"
/// - `days`: 집계 기간(일)
///
/// # 반환
/// `local::LocalReport` JSON. 연동이 꺼져 있으면 `Err("연동이 꺼져 있습니다")`, 알 수 없는 이름이면 `Err("알 수 없는 서비스")`.
///
/// # 참조
/// `codex::token_report`, `antigravity::token_report`. UI 의 `invoke('get_provider_tokens')`(office/usage.js) 가 호출.
#[tauri::command]
async fn get_provider_tokens(name: String, days: u32) -> Result<local::LocalReport, String> {
    if !provider_on(&name) {
        return Err(i18n::t("err.integration_off").into());
    }
    tauri::async_runtime::spawn_blocking(move || match name.as_str() {
        "chatgpt" => Ok(codex::token_report(days)),
        "antigravity" => Ok(antigravity::token_report(days)),
        _ => Err(i18n::t("err.unknown_service").to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 켠 서비스 세션의 책상 모니터 그림. 지금은 Antigravity 만 (Codex 는 기록에 그림 경로가 실제로 남는 것이 확인되지 않아 제외). 없으면 None.
///
/// # 인자
/// - `name`: 서비스 이름(Antigravity 외에는 항상 None)
/// - `id`: 세션 id
///
/// # 반환
/// 이미지 문자열, 없거나 서비스가 꺼져 있으면 `null`.
///
/// # 참조
/// `antigravity::last_image`. UI 의 `invoke('get_provider_image')`(office/office.js) 가 호출.
#[tauri::command]
async fn get_provider_image(name: String, id: String) -> Option<String> {
    if name != "antigravity" || !provider_on(&name) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || antigravity::last_image(&id)).await.ok().flatten()
}

/// 로그인 안내의 버튼 — 사용자가 누를 때만 부른다. ChatGPT: 새 콘솔에서 `codex login` (CLI 를 못 찾으면 Codex 앱 열기),
/// Antigravity: 앱 열기. 반환: "cli" | "app"
///
/// # 인자
/// - `name`: "chatgpt" | "antigravity"
///
/// # 반환
/// `Ok("cli")`(콘솔에서 로그인 실행) 또는 `Ok("app")`(앱을 엶). 연동이 꺼져 있으면 `Err("연동이 꺼져 있습니다")`, 알 수 없는 이름이면 `Err("알 수 없는 서비스")`.
///
/// # 참조
/// `codex::spawn_login`, `open_link`. UI 의 `invoke('provider_login')`(office/usage.js, settings.js) 가 호출.
#[tauri::command(async)] // 메인 스레드 밖에서(외부 프로세스·파일 읽기 대기로 창이 멈추지 않게)
fn provider_login(name: String) -> Result<&'static str, String> {
    if !provider_on(&name) {
        return Err(i18n::t("err.integration_off").into());
    }
    match name.as_str() {
        "chatgpt" => {
            if codex::spawn_login()? {
                Ok("cli")
            } else {
                open_link("codex://")?;
                Ok("app")
            }
        }
        "antigravity" => {
            open_link("antigravity://")?;
            Ok("app")
        }
        _ => Err(i18n::t("err.unknown_service").into()),
    }
}

/// 클라우드·원격 세션 목록을 돌려준다.
///
/// blocking 스레드에서 `oauth::fetch_cloud_sessions` 로 최근 `days`일(1~90일로 제한)의 세션을 조회한다.
///
/// # 인자
/// - `days`: 조회 기간(일, 1~90 로 제한)
///
/// # 반환
/// `oauth::CloudSession` 배열 JSON. 조회·스레드 실패는 오류 문자열.
///
/// # 참조
/// `oauth::fetch_cloud_sessions`. UI 의 `invoke('get_cloud')`(office/office.js) 가 호출.
#[tauri::command]
async fn get_cloud(days: u32) -> Result<Vec<oauth::CloudSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config::load().config;
        let since = Utc::now() - CDuration::days(days.clamp(1, 90) as i64);
        oauth::fetch_cloud_sessions(&config::claude_dir(&cfg), since).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 설정 조회(설정 패널 프리필용).
///
/// `get_config` 의 반환 JSON. 필드 이름이 그대로 JSON 키이다(세부는 각 필드 주석).
#[derive(Serialize)]
struct Cfg {
    /// 실행 중인 앱 버전(설정 화면 표시).
    version: String,
    /// 설정 > 정보의 시스템 정보 — 운영체제 표시 이름(`os_name`).
    os: String,
    /// CPU 아키텍처(`std::env::consts::ARCH`).
    arch: String,
    /// 권한 요청이 듣는 127.0.0.1 포트.
    hook_port: u16,
    /// 플랜 한도 갱신 주기(분).
    refresh_interval_minutes: u64,
    /// 로그인 시 자동 시작 설정.
    autostart: bool,
    /// 단순 알림 카드 자동 숨김 시간(초).
    alert_auto_hide_seconds: u64,
    /// 알림 종류 정의(설정 화면 체크 목록) + 끈 종류.
    alert_kinds: [alerts::Kind; 9],
    /// 꺼 둔 알림 종류 id 목록.
    muted_alert_kinds: Vec<String>,
    /// Claude Code 권한 요청 연동 — 설정이 켜져 있고 훅이 실제로 설치돼 있을 때만 true.
    permission_hook: bool,
    /// 권한 요청 자동 수락 설정.
    auto_allow: bool,
    /// 링크·세션을 Claude 데스크톱 앱에서 여는 설정.
    open_in_desktop: bool,
    /// 오피스 창 항상 위 설정.
    panel_on_top: bool,
    /// API 크레딧 할당 금액(USD).
    api_allocated_usd: f64,
    /// Admin API 키가 저장돼 있음(키 자체는 화면에 보내지 않음).
    api_key_set: bool,
    /// Claude 데스크톱 앱(claude:// 핸들러) 설치 여부 — 미설치면 설정 체크박스 비활성.
    desktop_app: bool,
    /// 사용하는 Claude 설정 폴더 경로.
    claude_dir: String,
    /// 이 앱 설정 파일 경로.
    config_path: String,
    /// 설정 파일을 읽을 때 생긴 안내(`config::load` 의 `note`), 없으면 None.
    note: Option<String>,
}

/// 설정 화면 프리필용 현재 설정을 돌려준다.
///
/// 설정 파일을 읽어 `Cfg` 로 옮긴다. 권한 연동은 설정값과 실제 설치 상태를 함께 따져 계산한다. Admin 키는 저장 여부만 담는다.
///
/// # 반환
/// `Cfg` JSON(버전·OS·포트·갱신 주기·알림·권한·API·경로 등).
///
/// # 참조
/// `config::load`, `hook::installed`, `os_name`, `desktop_app_installed`. UI 의 `invoke('get_config')`(notify.js, settings.js) 가 호출.
#[tauri::command]
fn get_config(app: AppHandle) -> Cfg {
    let loaded = config::load();
    Cfg {
        version: app.package_info().version.to_string(),
        os: os_name(),
        arch: std::env::consts::ARCH.into(),
        hook_port: loaded.config.hook_port,
        refresh_interval_minutes: loaded.config.refresh_interval_minutes,
        autostart: loaded.config.autostart,
        alert_auto_hide_seconds: loaded.config.alert_auto_hide_seconds,
        alert_kinds: alerts::KINDS,
        muted_alert_kinds: alerts::muted_kinds(&loaded.config),
        permission_hook: loaded.config.permission_hook && hook::installed(&config::claude_dir(&loaded.config)),
        auto_allow: loaded.config.auto_allow,
        open_in_desktop: loaded.config.open_in_desktop,
        panel_on_top: loaded.config.panel_on_top,
        api_allocated_usd: loaded.config.api_allocated_usd,
        api_key_set: config::admin_key(&loaded.config).is_some(),
        desktop_app: desktop_app_installed(),
        claude_dir: config::claude_dir(&loaded.config).display().to_string(),
        config_path: loaded.path.display().to_string(),
        note: loaded.note,
    }
}

/// 운영체제 표시 이름(Windows 는 빌드 번호로 10/11 구분).
///
/// Windows 는 `cmd /C ver` 출력(창 없이 실행)에서 빌드 번호를 읽어 22000 이상이면 "Windows 11", 미만이면 "Windows 10" 으로 표시하고,
/// 읽지 못하면 "Windows". 그 외 OS 는 `std::env::consts::OS`.
///
/// # 반환
/// "Windows 11 (빌드 N)" 형태 등의 문자열.
///
/// # 참조
/// `get_config`
fn os_name() -> String {
    // 한 번만 알아내 둔다(get_config 가 자주 불리는데, 매번 cmd /C ver 를 기다리면 메인 스레드가 멈칫함)
    static OS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    OS.get_or_init(os_name_uncached).clone()
}

fn os_name_uncached() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let build = std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(0x0800_0000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).split('.').nth(2).and_then(|b| b.trim().parse::<u32>().ok()));
        return match build {
            Some(b) if b >= 22000 => i18n::tf("os.win11", &[("b", &b.to_string())]),
            Some(b) => i18n::tf("os.win10", &[("b", &b.to_string())]),
            None => "Windows".into(),
        };
    }
    #[allow(unreachable_code)]
    std::env::consts::OS.into()
}

/// 갱신 주기·자동시작·알림·Claude Code 연동 저장 → 자동시작·훅 재적용.
///
/// 설정을 읽어 인자를 반영한다(갱신 주기는 최소 1분). 끈 알림 종류에서 원격·클라우드/로컬 알림 스위치를 파생시키고,
/// 연동이 켜졌는데 토큰이 없으면 새로 만든다. 이어서 Claude Code 훅을 적용하고 설정 파일을 저장한 뒤, 창 항상 위·알림 창·
/// 자동시작·알림 창 자동 숨김 시간·끈 종류를 즉시 반영한다. 훅·저장 단계 실패는 오류를 돌려주고 이후 단계는 실행하지 않는다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `refresh_interval_minutes`: 플랜 갱신 주기(분, 최소 1)
/// - `autostart`: 로그인 시 자동 시작
/// - `alert_auto_hide_seconds`: 알림 카드 자동 숨김 시간(초)
/// - `muted_alert_kinds`: 끌 알림 종류 id 목록(모르는 id 는 무시)
/// - `permission_hook`: Claude Code 권한 요청 연동
/// - `auto_allow`: 자동 수락
/// - `open_in_desktop`: 데스크톱 앱에서 열기
/// - `panel_on_top`: 오피스 창 항상 위
///
/// # 반환
/// 성공하면 `Ok(())`. 훅 적용 실패는 "Claude Code 설정 수정 실패: …", 저장 실패는 오류 문자열.
///
/// # 참조
/// `hook::apply`, `config::save`, `set_panel_on_top`, `sync_notify`, `autostart::apply`, `alerts_changed`.
/// 이벤트 `auto_hide`(notify 창). UI 의 `invoke('save_config')`(settings.js) 가 호출.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 설정 화면 필드가 그대로 커맨드 인자(IPC)
fn save_config(
    app: AppHandle,
    refresh_interval_minutes: u64,
    autostart: bool,
    alert_auto_hide_seconds: u64,
    muted_alert_kinds: Vec<String>,
    permission_hook: bool,
    auto_allow: bool,
    open_in_desktop: bool,
    panel_on_top: bool,
) -> Result<(), String> {
    let loaded = config::load();
    let mut c = loaded.config;
    c.refresh_interval_minutes = refresh_interval_minutes.max(1);
    c.autostart = autostart;
    c.alert_auto_hide_seconds = alert_auto_hide_seconds;
    let muted: Vec<String> =
        alerts::KINDS.iter().filter(|k| muted_alert_kinds.iter().any(|m| m == k.id)).map(|k| k.id.to_string()).collect();
    // 예전 스위치는 종류 목록에서 파생: 원격·클라우드 종류가 모두 꺼지면 세션 목록 확인(폴링)도 멈춤.
    let all_off = |origin: &str| alerts::KINDS.iter().filter(|k| k.origin == origin).all(|k| muted.iter().any(|m| m == k.id));
    c.alerts = !all_off("remote");
    c.local_alerts = !all_off("local");
    c.muted_alert_kinds = muted;
    c.permission_hook = permission_hook;
    c.auto_allow = auto_allow;
    c.open_in_desktop = open_in_desktop;
    c.panel_on_top = panel_on_top;
    if permission_hook && c.hook_token.is_empty() {
        c.hook_token = config::new_token();
    }
    log::info!(
        "설정 저장: 갱신 {}분, 자동시작 {}, 자동 숨김 {}초, 끈 알림 [{}], 권한 연동 {}, 자동 수락 {}, 데스크톱 앱 {}, 오피스 창 최상위 {}",
        c.refresh_interval_minutes,
        c.autostart,
        c.alert_auto_hide_seconds,
        c.muted_alert_kinds.join(", "),
        c.permission_hook,
        c.auto_allow,
        c.open_in_desktop,
        c.panel_on_top
    );
    hook::apply(&config::claude_dir(&c), c.permission_hook, c.hook_port, &c.hook_token).map_err(|e| {
        log::error!("Claude Code 훅 적용 실패: {e}");
        i18n::tf("err.claude_settings", &[("e", &e.to_string())])
    })?;
    config::save(&loaded.path, &c).map_err(|e| {
        log::error!("설정 파일 저장 실패: {e}");
        e.to_string()
    })?;
    set_panel_on_top(&app, c.panel_on_top);
    sync_notify(&app);
    let _ = autostart::apply(c.autostart);
    let _ = app.emit_to("notify", "auto_hide", c.alert_auto_hide_seconds);
    app.state::<AppState>().alerts.lock().unwrap().set_muted(alerts::muted_kinds(&c));
    alerts_changed(&app);
    redraw_tray(&app);
    Ok(())
}

// ── 업데이트 ───────────────────────────────────────────────────────────────

/// 새 버전 확인 → 상태·패널·트레이 반영.
///
/// `update::check` 로 확인하고(실패는 경고 로그 후 오류 반환) 결과를 `AppState.update` 에 보관하며 오피스 창에 알린다.
/// 새 버전이 있으면 버전당 1회 "새 버전" 알림 카드를 추가하고(같은 키가 있으면 추가하지 않음), 없으면 업데이트 카드를 해소한다.
/// 알림이 바뀌었으면 `alerts_changed`, 아니면 트레이만 다시 그린다. 알림 목록 잠금은 카드 처리 블록에서만 잡는다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 반환
/// 새 버전 정보 `Some(update::Available)`, 최신이면 `None`. 확인 실패는 오류 문자열.
///
/// # 참조
/// `update::check`, `UPDATE_ALERT`, `alerts_changed`, `redraw_tray`. 이벤트 `update`(오피스 창, 페이로드는 `Option<Available>`).
/// `check_update` 와 `main` 의 업데이트 확인 스레드에서 호출.
async fn refresh_update(app: &AppHandle) -> Result<Option<update::Available>, String> {
    let found = update::check(app).await.inspect_err(|e| log::warn!("업데이트 확인 실패: {e}"))?;
    match &found {
        Some(u) => log::info!("업데이트 확인: 새 버전 {} 있음", u.version),
        None => log::info!("업데이트 확인: 최신 버전({})", app.package_info().version),
    }
    *app.state::<AppState>().update.lock().unwrap() = found.clone();
    let _ = app.emit_to(office::LABEL, "update", &found);
    // 알림 창에 "새 버전" 카드 — 버전당 1회(닫거나 자동 숨김되면 같은 버전은 다시 안 띄움, 기록·배지엔 남음).
    let state = app.state::<AppState>();
    let changed = {
        let mut alerts = state.alerts.lock().unwrap();
        match &found {
            Some(u) => {
                let key = format!("{UPDATE_ALERT}@{}", u.version);
                alerts.find(&key).is_none()
                    && alerts.add_local(alerts::Alert {
                        key,
                        id: UPDATE_ALERT.into(),
                        title: i18n::tf("update.card.title", &[("v", &u.version)]),
                        message: if u.notes.is_empty() {
                            i18n::t("update.card.message").into()
                        } else {
                            i18n::tf("update.card.message_notes", &[("notes", &u.notes)])
                        },
                        state: "update".into(),
                        env: "update".into(),
                        url: String::new(),
                        updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
                        ..Default::default()
                    })
            }
            None => alerts.resolve_local(UPDATE_ALERT),
        }
    };
    if changed {
        alerts_changed(app);
    } else {
        redraw_tray(app);
    }
    Ok(found)
}

/// 업데이트 알림 카드의 세션 자리 id(로컬 알림 목록을 같이 씀 — 세션 id 와 겹치지 않음).
const UPDATE_ALERT: &str = "app-update";

/// 방금 설치된 업데이트 내역(1회). 패널 시작 시 불러 모달로 표시.
///
/// # 반환
/// `AppState.installed` 값을 꺼내 돌려주고 비운다. 없으면 `null`.
///
/// # 참조
/// UI 의 `invoke('take_update_notes')`(office/appbits.js) 가 호출. 이벤트 `update_notes` 도 같은 흐름에서 쓰인다.
#[tauri::command]
fn take_update_notes(app: AppHandle) -> Option<update::Available> {
    app.state::<AppState>().installed.lock().unwrap().take()
}

/// 지금 버전의 변경 내역(업데이트 창이 새 버전이 없을 때 보여 주는 마지막 업데이트 내역).
///
/// # 반환
/// `update::current_notes` 의 결과(내역을 못 구하면 노트가 빈 문자열). 피드를 읽을 수 있어 별도 스레드에서 돈다. UI 의 `invoke('current_notes')`(office/appbits.js) 가 호출.
#[tauri::command]
async fn current_notes() -> update::Available {
    let cur = env!("CARGO_PKG_VERSION");
    tauri::async_runtime::spawn_blocking(move || update::current_notes(cur)).await.unwrap_or_else(|_| update::Available { version: cur.into(), notes: String::new() })
}

/// 마지막 확인 결과(패널 표시용).
///
/// # 반환
/// `AppState.update` 의 복사본(`update::Available` 또는 `null`). UI 의 `invoke('get_update')`(office/appbits.js) 가 호출.
#[tauri::command]
fn get_update(app: AppHandle) -> Option<update::Available> {
    app.state::<AppState>().update.lock().unwrap().clone()
}

/// 설정의 "업데이트 확인".
///
/// 직전 확인이 60초 안이면 서버에 다시 묻지 않고 저장된 결과(`AppState::update`)를 돌려준다(중복 호출 방지).
///
/// # 반환
/// `refresh_update` 의 결과(새 버전이면 `Some`, 최신이면 `null`, 실패는 오류 문자열). UI 의 `invoke('check_update')`(office/appbits.js) 가 호출.
///
/// # 참조
/// `refresh_update`
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<update::Available>, String> {
    // 60초 안에 또 들어온 확인(오피스를 열 때 겹쳐 오던 호출 등)은 서버에 다시 묻지 않고 직전 결과를 돌려준다.
    // 시작 시각을 먼저 적어 동시에 들어온 호출도 막는다(먼저 간 확인이 끝나면 `update` 이벤트로 결과가 간다).
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
            log::debug!("업데이트 확인: 60초 안 중복 호출 — 직전 결과 사용");
            return Ok(app.state::<AppState>().update.lock().unwrap().clone());
        }
        *last = Some(Instant::now());
    }
    let r = refresh_update(&app).await;
    if r.is_err() {
        // 실패한 확인은 막지 않는다 — 바로 다시 누르면 실제로 다시 묻게 (저장된 None 을 '최신'으로 보이지 않게)
        *LAST.lock().unwrap() = None;
    }
    r
}

/// 패널의 "업데이트" → 내려받아 설치 후 재시작.
///
/// # 반환
/// 설치에 성공하면 `Ok(())`(앱이 재시작됨). 실패는 오류 로그를 남기고 오류 문자열.
///
/// # 참조
/// `update::install`. UI 의 `invoke('install_update')`(notify.js, office/appbits.js) 가 호출.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    // 채팅 답변이 진행 중이면 재시작으로 끊기므로 먼저 확인한다.
    let running = app.state::<AppState>().runner.active_count();
    if running > 0 {
        #[cfg(any(windows, target_os = "macos"))]
        {
            let ok = rfd::AsyncMessageDialog::new()
                .set_title(i18n::t("update.dialog.title"))
                .set_description(i18n::tf("update.dialog.running", &[("n", &running.to_string())]))
                .set_buttons(rfd::MessageButtons::YesNo)
                .show()
                .await;
            if ok != rfd::MessageDialogResult::Yes {
                return Err(i18n::t("update.cancelled").into());
            }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        return Err(i18n::t("update.deferred").into());
    }
    update::install(&app).await.inspect_err(|e| log::error!("업데이트 설치 실패: {e}"))
}

// ── 로그 ───────────────────────────────────────────────────────────────────

/// 설정의 "로그 폴더 열기".
///
/// # 반환
/// 폴더를 열었으면 `Ok(())`, 실패는 오류 문자열.
///
/// # 참조
/// `applog::dir`, `open_link`. UI 의 `invoke('open_log_dir')`(settings.js) 가 호출.
#[tauri::command]
fn open_log_dir() -> Result<(), String> {
    open_link(&applog::dir().display().to_string())
}

/// 설정의 "로그 내보내기": 어제+오늘 로그를 바탕화면에 한 파일로 저장하고 탐색기에서 선택해 보여줌.
///
/// explorer 는 `/select,"경로"` 형태만 읽으므로 Windows 에서는 `raw_arg` 로 그대로 전달한다(일반 arg 는 공백 경로에서 인자 전체를 따옴표로 감싸 해석에 실패함). macOS 는 `open -R`.
///
/// # 반환
/// 저장한 파일 경로 문자열. 저장 실패는 오류 문자열.
///
/// # 참조
/// `applog::export`. UI 의 `invoke('export_log')`(settings.js) 가 호출.
#[tauri::command]
fn export_log(app: AppHandle) -> Result<String, String> {
    let path = applog::export(&app.package_info().version.to_string()).map_err(|e| e.to_string())?;
    log::info!("로그 내보냄: {}", path.display());
    // explorer 는 `/select,"경로"` 형태만 읽음 — 일반 arg 는 공백 경로(OneDrive\바탕 화면)에서 인자 전체를 따옴표로 감싸
    // 탐색기가 해석 못 하고 문서 폴더를 엶. raw_arg 로 그대로 전달.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    Ok(path.display().to_string())
}

/// 설정의 "로그 보내기" 미리보기: 서버에 보낼 로그(홈 경로·사용자 이름을 가린 것)를 돌려준다.
///
/// # 반환
/// `remotelog::Preview` (표시용 텍스트·전체 바이트 수·잘림 여부). 로그를 읽지 못하면 오류 문구.
///
/// # 참조
/// `remotelog::preview`. UI 의 `invoke('log_send_preview')`(settings.js) 가 호출.
#[tauri::command]
async fn log_send_preview(app: AppHandle) -> Result<remotelog::Preview, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || remotelog::preview(&version)).await.map_err(|e| e.to_string())?
}

/// 설정의 "로그 보내기": 증상 설명과 어제+오늘 로그를 muneo.co.kr 접수 서버에 올리고 접수번호를 돌려준다.
///
/// 네트워크 호출이라 별도 스레드에서 실행한다. 자동 재시도는 413(크기) 1회뿐(서버에 멱등 키가 없음).
///
/// # 인자
/// - `symptom`: 사용자가 쓴 증상 (2000자까지 사용)
/// - `consent`: 개인정보 동의 체크 여부 (false 면 보내지 않음)
///
/// # 반환
/// `remotelog::Receipt`(접수번호·받은 시각·앞부분 생략 여부). 실패하면 화면에 보일 한국어 문구.
///
/// # 참조
/// `remotelog::send`. UI 의 `invoke('send_log')`(settings.js) 가 호출.
#[tauri::command]
async fn send_log(app: AppHandle, symptom: String, consent: bool) -> Result<remotelog::Receipt, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || remotelog::send(&version, &symptom, consent)).await.map_err(|e| e.to_string())?
}

/// 화면(JS)에서 난 오류를 로그에 남김.
///
/// 메시지는 앞 500자만 사용하고, 레벨이 "error"·"warn" 이면 해당 레벨로, 그 외에는 info 로 로그 대상 `muneo_claude_usage_tray::ui` 에 기록한다.
///
/// # 인자
/// - `level`: "error" | "warn" | 그 외(info 로 처리)
/// - `message`: 로그 메시지(500자까지)
///
/// # 참조
/// UI 의 `invoke('log_ui')`(common.js, office/office.js) 가 호출.
#[tauri::command]
fn log_ui(level: String, message: String) {
    let message: String = message.chars().take(500).collect();
    match level.as_str() {
        "error" => log::error!(target: "muneo_claude_usage_tray::ui", "{message}"),
        "warn" => log::warn!(target: "muneo_claude_usage_tray::ui", "{message}"),
        _ => log::info!(target: "muneo_claude_usage_tray::ui", "{message}"),
    }
}


/// 알림 기록을 저장하고 앱을 종료한다.
///
/// # 참조
/// `save_alert_marks`. UI 의 `invoke('quit_app')`(settings.js) 가 호출.
#[tauri::command]
fn quit_app(app: AppHandle) {
    save_alert_marks(&app);
    app.state::<AppState>().runner.shutdown();
    app.exit(0);
}

/// claude.ai 링크 열기 — claude.ai 링크만 허용.
/// 설정이 켜져 있고 데스크톱 앱이 있으면 claude://claude.ai/<경로> 딥링크로 앱에서 열기(다운로드 페이지는 항상 브라우저).
///
/// 허용 목록만 연다: 개발자 메일·웹사이트, Claude·OpenAI·Google 상태 페이지, 웹 서비스 바로가기(`https://chatgpt.com`·`https://gemini.google.com` 정확히 일치),
/// `antigravity://`, 형식이 uuid 꼴인 `codex://threads/<id>`, `https://claude.ai` 와 `https://claude.ai/` 로 시작하는 주소.
/// 그 외는 거부한다.
///
/// # 인자
/// - `url`: 열 주소
///
/// # 반환
/// 열기를 시작했으면 `Ok(())`. 허용되지 않는 주소(uuid 꼴이 아닌 Codex id 포함)는 `Err("허용되지 않은 링크")`, 실행 실패는 오류 문자열.
///
/// # 참조
/// `open_link`, `desktop_app_installed`, `codex::is_uuid_like`. UI 의 `invoke('open_url')`(office/appbits.js, office/office.js, settings.js) 가 호출. `open_alert` 도 내부 호출.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if plain_link_allowed(&url) {
        return open_link(&url);
    }
    // Codex 대화(codex://threads/<id> — id 는 uuid 꼴만)
    if let Some(id) = url.strip_prefix("codex://threads/") {
        return if codex::is_uuid_like(id) { open_link(&url) } else { Err(i18n::t("err.link_not_allowed").into()) };
    }
    // 웹 바로가기 "https://claude.ai" 는 "/" 붙인 주소로 보고 아래 claude.ai 분기(데스크톱 앱 설정을 따름)로.
    let url = if url == "https://claude.ai" { "https://claude.ai/".to_string() } else { url };
    let Some(path) = url.strip_prefix("https://claude.ai/") else {
        return Err(i18n::t("err.link_not_allowed").into());
    };
    let target = if !path.starts_with("download") && config::load().config.open_in_desktop && desktop_app_installed() {
        format!("claude://claude.ai/{path}")
    } else {
        url
    };
    open_link(&target)
}

/// 공개 저장소의 문의(Issues) 페이지. 설정 › 정보 › 문의 링크(ui/settings.js)와 같은 주소.
const ISSUES_URL: &str = "https://github.com/MuneoAX/meowoffice/issues";

/// 그대로(브라우저·앱으로) 열어도 되는 주소인지 — 개발자 연락처, 상태 페이지 3곳(과 그 아래 경로), 웹 서비스 바로가기(정확히 일치), `antigravity://`.
///
/// # 인자
/// - `url`: 열 주소
///
/// # 반환
/// 허용이면 true. `https://claude.ai` 는 데스크톱 앱 설정을 따르므로 여기서는 false(`open_url` 의 claude.ai 분기 담당).
///
/// # 참조
/// `open_url` 이 호출. `providers::WEB_SERVICES`, `health` 의 상태 페이지 상수.
fn plain_link_allowed(url: &str) -> bool {
    let under = |page: &str| url == page || url.starts_with(&format!("{page}/"));
    url == ISSUES_URL
        || url == "https://muneo.co.kr"
        || under(health::STATUS_PAGE)
        || under(health::OPENAI_STATUS_PAGE)
        || under(health::GOOGLE_STATUS_PAGE)
        || providers::WEB_SERVICES.iter().any(|w| w.id != "claude" && w.url == url)
        || url == "antigravity://"
}

/// OS 기본 핸들러로 링크 열기(브라우저·claude:// 딥링크).
///
/// Windows 는 `rundll32 url.dll,FileProtocolHandler`, macOS 는 `open` 으로 프로세스를 시작한다(결과를 기다리지 않음). 허용 주소 검사는 하지 않으므로 호출 쪽이 검증한다.
///
/// # 인자
/// - `target`: 열 주소 또는 경로
///
/// # 반환
/// 프로세스 시작에 성공하면 `Ok(())`, 실패는 오류 문자열.
///
/// # 참조
/// `open_url`·`open_alert`·`open_log_dir`·`provider_login`·`show_desktop_app` 등에서 호출.
fn open_link(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", target]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(target).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 로컬 세션 카드 클릭. 데스크톱 앱에서 만든 세션이면(설정 켜짐) 앱의 해당 세션으로,
/// 아니면 새 터미널에서 `claude --resume` 실행. 실행 중인 터미널 세션은 중복 실행을 피해 "active" 반환(프론트가 명령 복사).
///
/// id 는 영숫자·하이픈만 허용한다. 데스크톱 앱 이동 → `active` 이면 "active" → Windows 는 Windows Terminal(`wt`), 없으면 새 PowerShell 콘솔 / macOS 는 Terminal.app 순으로 시도한다.
///
/// # 인자
/// - `id`: Claude Code 세션 id(영숫자·`-` 만)
/// - `cwd`: 세션 작업 폴더(폴더가 아니면 Windows 는 현재 폴더, macOS 는 홈)
/// - `active`: 터미널에서 실행 중인 세션인지
///
/// # 반환
/// `Ok("desktop")`(앱으로 이동) | `Ok("active")`(실행 중이라 열지 않음) | `Ok("terminal")`(새 터미널에서 재개). id 가 잘못되면 `Err("잘못된 세션 id")`, 실행 실패는 오류 문자열.
///
/// # 참조
/// `desktop_session_for`, `open_link`. UI 의 `invoke('open_local_session')`(office/office.js) 가 호출.
#[tauri::command(async)] // 메인 스레드 밖에서(외부 프로세스·파일 읽기 대기로 창이 멈추지 않게)
fn open_local_session(id: String, cwd: String, active: bool) -> Result<&'static str, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(i18n::t("err.bad_session_id").into());
    }
    if config::load().config.open_in_desktop && desktop_app_installed() {
        if let Some(local) = desktop_session_for(&id) {
            open_link(&format!("claude://claude.ai/epitaxy/{local}"))?;
            return Ok("desktop");
        }
    }
    if active {
        return Ok("active");
    }
    #[cfg(windows)]
    {
        // wt 는 인자 안의 ';' 를 하위 명령 구분자로 해석하므로(폴더 이름에 ';' 가 있으면 명령 주입) 그런 경로는 쓰지 않는다.
        let dir = if std::path::Path::new(&cwd).is_dir() && !cwd.contains(';') { cwd } else { ".".into() };
        // Windows Terminal 우선, 없으면 새 PowerShell 콘솔.
        let wt = std::process::Command::new("wt").args(["-d", &dir, "claude", "--resume", &id]).spawn();
        if wt.is_err() {
            use std::os::windows::process::CommandExt;
            /// Windows `CreateProcess` 플래그 — 새 콘솔 창에서 실행.
            const CREATE_NEW_CONSOLE: u32 = 0x10;
            std::process::Command::new("powershell")
                .args(["-NoExit", "-Command", "claude", "--resume", &id])
                .current_dir(&dir)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Terminal.app 새 창에서 실행. id 는 영숫자·하이픈만 통과했으므로 경로만 이스케이프.
        let dir = if std::path::Path::new(&cwd).is_dir() {
            cwd
        } else {
            directories::BaseDirs::new().map(|b| b.home_dir().display().to_string()).unwrap_or_else(|| "/".into())
        };
        let sh = format!("cd '{}' && claude --resume {id}", dir.replace('\'', r"'\''"));
        let osa = sh.replace('\\', r"\\").replace('"', r#"\""#);
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{osa}\""),
                "-e",
                "tell application \"Terminal\" to activate",
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok("terminal")
}

/// 로그인 안내의 [Claude Code 로그인] — 새 콘솔에서 `claude auth login --claudeai` 실행(브라우저 OAuth).
/// 브라우저 콜백이 안 되면 콘솔에 코드를 붙여넣는 흐름이라 창을 숨기지 않음. 설치 안 됨 → Err("not_installed").
///
/// 설정에서 Claude 폴더를 바꿨으면 `CLAUDE_CONFIG_DIR` 환경변수로 넘겨 로그인 결과가 그곳에 저장되게 한다.
/// Windows 는 실행 파일 경로를 환경변수 `MUNEO_CLAUDE` 로 넘겨 인용 문제를 피하고, 실패했을 때만 창이 남도록 한다. macOS 는 Terminal.app 으로 실행한다.
///
/// # 반환
/// 실행을 시작했으면 `Ok(())`. Windows 에서 claude 를 찾지 못하면 `Err("not_installed")`, 실행 실패는 오류 문자열.
///
/// # 참조
/// `find_claude`(Windows). UI 의 `invoke('claude_login')`(office/appbits.js) 가 호출.
#[tauri::command]
fn claude_login() -> Result<(), String> {
    let cfg = config::load().config;
    // 설정에서 디렉터리를 바꿨으면 로그인 결과도 그곳에 저장되도록.
    let custom_dir = Some(cfg.claude_dir.trim()).filter(|d| !d.is_empty()).map(str::to_string);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Windows `CreateProcess` 플래그 — 새 콘솔 창에서 실행.
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        let exe = find_claude().ok_or("not_installed")?;
        // 경로는 환경변수로 넘겨 인용 문제 회피. 실패했을 때만 창을 남겨 오류를 읽을 수 있게.
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command"])
        .arg(format!("& $env:MUNEO_CLAUDE auth login --claudeai; if ($LASTEXITCODE) {{ Read-Host '{}' }}", i18n::t("login.failed_pause")))
        .env("MUNEO_CLAUDE", &exe)
        .creation_flags(CREATE_NEW_CONSOLE);
        if let Some(d) = &custom_dir {
            cmd.env("CLAUDE_CONFIG_DIR", d);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        log::info!("Claude Code 로그인 실행: {}", exe.display());
    }
    #[cfg(target_os = "macos")]
    {
        // Terminal 은 사용자 셸 PATH 로 실행 — 설치 여부는 터미널 메시지로 확인.
        let env = custom_dir.map(|d| format!("CLAUDE_CONFIG_DIR='{}' ", d.replace('\'', r"'\''"))).unwrap_or_default();
        let osa = format!("{env}claude auth login --claudeai").replace('\\', r"\\").replace('"', r#"\""#);
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{osa}\""),
                "-e",
                "tell application \"Terminal\" to activate",
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// claude 실행 파일 찾기. 트레이가 설치 전부터 떠 있으면 PATH 가 갱신되지 않으므로 기본 설치 위치도 확인.
///
/// PATH 의 각 폴더에 홈의 `.local/bin`(네이티브 설치)과 `%APPDATA%\npm`(npm 전역 설치)을 더해 `claude.exe`·`claude.cmd` 를 차례로 찾는다. Windows 에서만 컴파일된다.
///
/// # 반환
/// 찾은 실행 파일 경로, 없으면 `None`.
///
/// # 참조
/// `claude_login`
#[cfg(windows)]
fn find_claude() -> Option<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(b) = directories::BaseDirs::new() {
        dirs.push(b.home_dir().join(".local").join("bin")); // 네이티브 설치(install.ps1)
        dirs.push(b.data_dir().join("npm")); // npm install -g (%APPDATA%\npm)
    }
    dirs.iter().flat_map(|d| ["claude.exe", "claude.cmd"].map(|n| d.join(n))).find(|p| p.is_file())
}

/// 로그인 대기 중 폴링용 — 자격증명 파일 수정 시각(ms). 파일 없음(미로그인·macOS 키체인) → None.
///
/// # 반환
/// Claude 폴더의 `.credentials.json` 수정 시각(UNIX epoch 기준 밀리초). 파일이 없거나 시각을 읽지 못하면 `null`.
///
/// # 참조
/// UI 의 `invoke('cred_stamp')`(office/appbits.js) 가 호출.
#[tauri::command]
fn cred_stamp() -> Option<u64> {
    let path = config::claude_dir(&config::load().config).join(".credentials.json");
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Claude Code 세션 id(cliSessionId) → 데스크톱 앱 로컬 세션 id(local_…).
/// 데스크톱 앱 기록: %APPDATA%\Claude\claude-code-sessions\<계정>\<조직>\local_*.json
///
/// 각 조직 폴더의 `local_*.json` 을 읽되, 파일 전체를 파싱하기 전에 문자열 포함 여부로 먼저 거른다(세션 기록이 클 수 있음).
/// `cliSessionId` 가 일치하는 첫 파일의 `sessionId` 를 돌려준다.
///
/// # 인자
/// - `cli_id`: Claude Code 세션 id
///
/// # 반환
/// 데스크톱 앱 로컬 세션 id, 기록이 없으면 `None`.
///
/// # 참조
/// `open_alert`, `open_local_session` 에서 호출.
fn desktop_session_for(cli_id: &str) -> Option<String> {
    let root = directories::BaseDirs::new()?.config_dir().join("Claude").join("claude-code-sessions");
    let subdirs = |p: &std::path::Path| {
        std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect::<Vec<_>>()
    };
    for org in subdirs(&root).iter().flat_map(|acct| subdirs(acct)) {
        for f in std::fs::read_dir(&org).into_iter().flatten().flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if !name.starts_with("local_") || !name.ends_with(".json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(f.path()) else {
                continue;
            };
            // 파일 전체 파싱 전에 빠른 거르기(세션 기록이 클 수 있음).
            if !text.contains(cli_id) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if v.get("cliSessionId").and_then(|x| x.as_str()) == Some(cli_id) {
                // 파일에서 읽은 값이 claude:// 주소에 들어가므로 영숫자·-·_ 만 통과.
                return v
                    .get("sessionId")
                    .and_then(|x| x.as_str())
                    .filter(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .map(str::to_string);
            }
        }
    }
    None
}

/// 데스크톱 앱 띄우기(설정 켜짐 + 설치 시): 꺼져 있으면 실행, 트레이에 숨었거나 최소화면 창을 앞으로.
/// claude://hotkey 는 앱이 화면 이동 없이 받아들이는 링크 — 두 번째 실행 시 앱이 창만 복원함.
///
/// # 참조
/// `desktop_app_installed`, `open_link`. `answer_permit` 에서 호출.
fn show_desktop_app() {
    if !config::load().config.open_in_desktop || !desktop_app_installed() {
        return;
    }
    let _ = open_link("claude://hotkey");
}

/// Claude 데스크톱 앱 설치 여부: claude:// 프로토콜 핸들러 등록(HKCR\claude) 확인.
/// macOS: /Applications 또는 ~/Applications 의 Claude.app.
///
/// # 반환
/// 설치돼 있으면 true. Windows·macOS 외 OS 는 항상 false.
///
/// # 참조
/// `get_config`, `open_url`, `open_alert`, `open_local_session`, `show_desktop_app`
fn desktop_app_installed() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CLASSES_ROOT;
        winreg::RegKey::predef(HKEY_CLASSES_ROOT).open_subkey("claude").is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        let home = directories::BaseDirs::new().map(|b| b.home_dir().join("Applications/Claude.app"));
        std::path::Path::new("/Applications/Claude.app").is_dir() || home.is_some_and(|p| p.is_dir())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    false
}

// ── 패널 표시/배치 ─────────────────────────────────────────────────────────

/// 작업 영역(작업표시줄 제외) 우하단에 배치. 작업표시줄이 좌/상단이면 그쪽에 붙임.
///
/// `at` 위치가 속한 모니터(없으면 주 모니터)의 작업 영역 우하단에서 12(논리 px)×배율 만큼 띄워 놓는다. macOS 는 메뉴 막대가 위이므로 우상단.
/// `at` 이 작업 영역 왼쪽·위쪽 밖이면 그쪽 가장자리에 붙인다. 모니터·크기를 얻지 못하면 아무것도 하지 않는다.
///
/// # 인자
/// - `win`: 배치할 창
/// - `at`: 기준 화면 위치(물리 px), 없으면 주 모니터
///
/// # 참조
/// `sync_notify`, `preview_alert`, `notify_resize` 에서 호출.
fn place(win: &WebviewWindow, at: Option<PhysicalPosition<f64>>) {
    let mon = at.and_then(|p| win.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| win.primary_monitor().ok().flatten());
    let Some(m) = mon else { return };
    let wa = m.work_area();
    let Ok(size) = win.outer_size() else { return };
    let (wx, wy) = (wa.position.x, wa.position.y);
    let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
    // 패널·알림 창 모두 창을 꽉 채우므로(투명 여백 없음) 화면 가장자리와 띄움.
    let gap = (12.0 * m.scale_factor()) as i32;
    let mut x = wx + ww - size.width as i32 - gap;
    let mut y = wy + wh - size.height as i32 - gap;
    // macOS: 메뉴 막대가 위 → 기본 우상단.
    if cfg!(target_os = "macos") {
        y = wy + gap;
    }
    if let Some(p) = at {
        if (p.x as i32) < wx {
            x = wx + gap;
        }
        if (p.y as i32) < wy {
            y = wy + gap;
        }
    }
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 오피스(메인 화면) 열기: 앞으로 띄우고, 알림 창 표시를 다시 판단 (오피스가 앞에 있으면 세션 알림 카드는 숨김, 권한 요청은 유지)
///
/// 오피스 창을 열고 항상 위 설정을 적용한 뒤 `PANEL_SHOWN` 에 시각을 기록한다. 트레이·메뉴 콜백(메인 스레드)에서도 불리므로
/// 교착을 막기 위해 알림 창 판단은 `sync_notify_async` 로 다른 스레드에서 한다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `office::open`, `sync_notify_async`. 트레이 메뉴·클릭, 두 번째 실행(single-instance), 첫 설치·업데이트 후 첫 실행 스레드에서 호출.
fn show_panel(app: &AppHandle) {
    office::open(app);
    if let Some(w) = app.get_webview_window(office::LABEL) {
        let _ = w.set_always_on_top(PANEL_ON_TOP.load(std::sync::atomic::Ordering::Relaxed));
    }
    *PANEL_SHOWN.lock().unwrap() = Some(Instant::now());
    sync_notify_async(app); // 트레이·메뉴 콜백(메인 스레드)에서도 불리므로 교착 방지
}

/// 마지막 더블클릭 시각. Windows 는 더블클릭을 DOWN·UP·DBLCLK·UP 으로 보내서, 더블클릭 뒤의 UP(한 번 클릭)이
/// 방금 연 오피스를 다시 닫지 않게 이 시간 안의 한 번 클릭은 무시한다.
/// `toggle_panel` 이 읽고(600ms), 트레이 더블클릭 핸들러가 기록한다.
static TRAY_DBL: Mutex<Option<Instant>> = Mutex::new(None);

/// 트레이 한 번 클릭: 오피스가 앞에 있으면 닫고(트레이에 있을 땐 3D 가 돌지 않게 창을 없앰), 아니면 앞으로.
///
/// 직전 더블클릭(`TRAY_DBL`)이 600ms 안이면 무시한다. 그 외에는 `panel_in_front`(직전 포커스 상실 포함)로 판단해 앞에 있으면 창을 닫고, 아니면 `show_panel` 한다.
///
/// # 인자
/// - `app`: 앱 핸들
///
/// # 참조
/// `panel_in_front`, `show_panel`. `main` 의 트레이 왼쪽 클릭(Up) 핸들러에서 호출.
fn toggle_panel(app: &AppHandle) {
    if TRAY_DBL.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(600)) {
        return;
    }
    if panel_in_front(app, true) {
        if let Some(w) = app.get_webview_window(office::LABEL) {
            let _ = w.close();
        }
        return;
    }
    show_panel(app);
}

/// 화면이 시작할 때·언어를 바꿀 때 부르는 명령: 본체의 언어를 맞추고 선택값을 저장한다.
///
/// `choice` 가 "auto"|"ko"|"en"|"ja" 가 아니면 "auto" 로 본다. `lang` 이 "ko"|"en"|"ja" 가 아니면 `choice` 에서 다시 정한다(auto 면 OS 언어).
/// 선택값이 바뀐 경우에만 설정 파일에 쓴다. 현재 언어가 바뀌면 트레이 메뉴 글자를 바꾸고 툴팁을 다시 그리며,
/// 한도 조회 문구(라벨·오류)가 새 언어로 나오도록 플랜을 한 번 다시 조회한다(백그라운드).
///
/// # 인자
/// - `choice`: 사용자가 고른 값 "auto" | "ko" | "en" | "ja"
/// - `lang`: 화면이 실제로 쓰는 언어 "ko" | "en" | "ja"
///
/// # 참조
/// `i18n::set`, `config::save`, `redraw_tray`, `refresh_plan`. UI 의 `invoke('set_lang')`(i18n/i18n.js) 가 호출.
#[tauri::command]
fn set_lang(app: AppHandle, choice: String, lang: String) {
    let choice = if matches!(choice.as_str(), "ko" | "en" | "ja") { choice } else { "auto".to_string() };
    let new = i18n::Lang::parse(&lang).unwrap_or_else(|| i18n::resolve(&choice));
    let changed = i18n::lang() != new;
    i18n::set(new);
    let loaded = config::load();
    if loaded.config.lang != choice {
        let mut c = loaded.config;
        c.lang = choice;
        if let Err(e) = config::save(&loaded.path, &c) {
            log::warn!("언어 설정 저장 실패: {e}");
        }
    }
    if !changed {
        return;
    }
    log::info!("언어 변경: {}", new.code());
    if let Some((office, refresh, quit)) = TRAY_MENU.lock().unwrap().as_ref() {
        let _ = office.set_text(i18n::t("tray.office"));
        let _ = refresh.set_text(i18n::t("tray.refresh"));
        let _ = quit.set_text(i18n::t("tray.quit"));
    }
    if let Some(w) = app.get_webview_window(office::LABEL) {
        let _ = w.set_title(&office::window_title());
    }
    redraw_tray(&app);
    std::thread::spawn(move || {
        refresh_plan(&app, true);
    });
}

/// 앱 진입점.
///
/// `--hook <codex|agy> <이벤트>` 인자면 창·트레이·로그 없이 `relay::run` 으로 훅을 중계하고 종료한다.
/// 일반 실행은 로그 초기화 → 설정 로드·로그 → 자동시작 적용 → Claude Code 훅·ChatGPT/Antigravity 훅 자가 치유(켜져 있고 토큰이 있을 때만)
/// → 업데이트 후/첫 설치 여부 판단 순으로 준비한 뒤 Tauri 를 만든다. 단일 인스턴스 플러그인(두 번째 실행은 오피스를 앞으로),
/// `AppState` 등록, 업데이터 플러그인, setup(트레이 메뉴·아이콘, 첫 실행 안내, 백그라운드 스레드),
/// 창 이벤트 핸들러, `invoke_handler`(UI 명령 등록) 순으로 구성하고 실행한다.
/// setup 의 스레드: 플랜 갱신(`refresh_interval_minutes`마다), 1분마다 툴팁·초기화 시각 점검, 권한 요청 서버(`permit::serve`),
/// 업데이트 확인(`update::FIRST_CHECK` 후 `update::INTERVAL` 마다), 연결 상태 확인(20초 후 `health::INTERVAL` 마다), 다른 서비스 폴링(25초 후 15초마다), 세션 알림 폴링(`alert_poll_seconds`, 최소 10초).
/// 창 닫기는 알림 창 등 일반 창은 숨기고, 오피스 창은 위치를 저장하고 없앤다.
///
/// # 참조
/// `relay::run`, `applog::init`, `config::load`, `hook::apply`, `provider_hook::apply`, `mcpreg::remove_legacy`, `update::first_run_after_update`,
/// `show_panel`, `toggle_panel`, `refresh_plan`, `permit::serve`, `refresh_update`, `poll_status`, `poll_providers`, `poll_alerts`.
fn main() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
    // `--hook <codex|agy> <이벤트>`: Codex·Antigravity 훅이 실행하는 중계 모드 — 창·트레이·로그 초기화 없이 바로 처리하고 종료.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--hook") {
        std::process::exit(relay::run(&args[1..]));
    }
    applog::init();
    // 기동 시 자동시작 자가 치유.
    let mut loaded = config::load();
    i18n::init(&loaded.config.lang); // 시작 언어(화면이 뜨면 `set_lang` 으로 다시 알려 줌)
    log::info!(
        "시작: {} {} ({} {}) · 설정 {}{}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        loaded.path.display(),
        loaded.note.as_deref().map(|n| format!(" · {n}")).unwrap_or_default()
    );
    log::info!(
        "설정: 세션 알림 {}, 확인 주기 {}초, 자동 숨김 {}초, 끈 알림 [{}], 권한 연동 {}, 자동 수락 {}, 포트 {}, Codex 연동 {}, Antigravity 연동 {}",
        loaded.config.alerts,
        loaded.config.alert_poll_seconds,
        loaded.config.alert_auto_hide_seconds,
        alerts::muted_kinds(&loaded.config).join(", "),
        loaded.config.permission_hook,
        loaded.config.auto_allow,
        loaded.config.hook_port,
        loaded.config.codex_hook,
        loaded.config.agy_hook
    );
    if let Err(e) = autostart::apply(loaded.config.autostart) {
        log::warn!("자동시작 적용 실패: {e}");
    }
    // Antigravity 연동 기본 켬(0.5.2): 이전 설치에도 한 번만 켠다. 그 뒤 사용자가 끄면 그대로 둔다.
    // 설정 파일을 읽지 못한 때(기본값으로 대신 동작 중)는 건너뛴다 — 저장하면 사용자 설정을 기본값으로 덮어쓰게 됨. 다음 시작 때 다시.
    if !loaded.config.agy_hook_defaulted && (loaded.created || loaded.note.is_none()) {
        let mut c = loaded.config.clone();
        c.agy_hook_defaulted = true;
        if !c.agy_hook {
            log::info!("Antigravity 권한 요청·응답 완료 연동: 기본값 켬 적용(한 번만)");
        }
        c.agy_hook = true;
        if c.hook_token.is_empty() {
            c.hook_token = config::new_token();
        }
        match persist_agy_default(&loaded.path, &c) {
            Ok(()) => loaded.config = c,
            Err(e) => log::warn!("Antigravity 연동 기본값 저장 실패(다음 시작 때 다시): {e}"),
        }
    }
    // 연동 켜져 있으면 훅 자가 치유(포트·토큰 변경, 수동 삭제 대비).
    if loaded.config.permission_hook && !loaded.config.hook_token.is_empty() {
        let c = &loaded.config;
        if let Err(e) = hook::apply(&config::claude_dir(c), true, c.hook_port, &c.hook_token) {
            log::error!("Claude Code 훅 적용 실패: {e}");
        }
    }
    // ChatGPT(Codex)·Antigravity 훅 자가 치유: 켜 두었는데 항목이 없거나 exe 경로가 바뀌었으면 다시 등록.
    // 명령이 바뀌면 Codex 는 다시 신뢰(trust)해야 하므로 로그에 남김.
    for p in [provider_hook::Provider::Codex, provider_hook::Provider::Agy] {
        let on = match p {
            provider_hook::Provider::Codex => loaded.config.codex_hook,
            provider_hook::Provider::Agy => loaded.config.agy_hook,
        };
        if !on || loaded.config.hook_token.is_empty() {
            continue;
        }
        let Some(dir) = p.dir() else { continue };
        // 서비스 설정 폴더가 없으면(미설치·삭제) 만들지 않음
        if !dir.exists() {
            continue;
        }
        let exe = match exe_string() {
            Ok(e) => e,
            Err(e) => {
                log::error!("{} 훅 자가 치유 건너뜀: {e}", p.key());
                continue;
            }
        };
        let before = provider_hook::installed_command(&dir, p);
        // Antigravity: 권한 설정이 Antigravity 가 직접 묻는 쪽(Card)일 때만 PreToolUse 항목 유지, 아니면 Stop 만
        match provider_hook::apply(&dir, p, true, &exe, agy_card()) {
            Ok(()) => {
                let want = wanted_command(p, &exe);
                match before {
                    None => log::info!("{} 훅 다시 등록(항목 없음)", p.key()),
                    Some(b) if b != want => log::warn!("{} 훅 명령 갱신(앱 경로 변경) — Codex 는 설정 > 훅에서 다시 신뢰해야 함", p.key()),
                    _ => {}
                }
            }
            Err(e) => log::error!("{} 훅 자가 치유 실패: {e}", p.key()),
        }
    }
    // 예전 버전이 등록한 컴퓨터 제어 MCP 항목 정리(조용히, 실패해도 시작은 계속).
    mcpreg::remove_legacy(&loaded.config);
    let hook_port = loaded.config.hook_port;
    let updated = update::first_run_after_update(env!("CARGO_PKG_VERSION"), loaded.created);
    let first_install = loaded.created; // 새로 설치한 첫 실행 → 오피스를 띄워 처음 안내부터
    if updated {
        log::info!("업데이트 후 첫 실행: {} — 변경 내역 표시", env!("CARGO_PKG_VERSION"));
    }

    tauri::Builder::default()
        // 중복 실행 방지: 두 번째 실행 → 기존 패널 표시.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 이 콜백은 다른 프로세스의 SendMessage 처리 중(메인 스레드)에 불린다 — 그 안에서 웹뷰 창을 만들지 않게 스레드로
            let app = app.clone();
            std::thread::spawn(move || show_panel(&app));
        }))
        .manage(AppState {
            plan: Mutex::new(None),
            alerts: Mutex::new({
                let mut a = alerts::Alerts::default();
                a.set_muted(alerts::muted_kinds(&loaded.config));
                // 닫음·숨김·읽음 기록 복원 — 재시작·업데이트 뒤에 이미 본 카드가 다시 뜨지 않게.
                let path = alerts::marks_path();
                match alerts::load_marks(&path) {
                    Ok(Some(f)) => {
                        let (kept, pruned) = a.restore_marks(f.marks, Utc::now().timestamp_millis());
                        log::info!("알림 기록 불러옴: {kept}건(오래된 {pruned}건 정리) — {}", path.display());
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("알림 기록 파일 읽기 실패: {e} — 새로 시작 ({})", path.display()),
                }
                a
            }),
            permits: Mutex::new(permit::Permits::default()),
            update: Mutex::new(None),
            installed: Mutex::new(None),
            health: Mutex::new(health::Health::default()),
            phealth: Mutex::new(std::collections::HashMap::new()),
            treats: AtomicU32::new(load_treats()),
            office_ready: AtomicBool::new(false),
            runner: runner::Runner::new(),
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            // macOS: Dock 아이콘 없이 메뉴 막대에만 상주.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let office_item = MenuItem::with_id(app, "office", i18n::t("tray.office"), true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", i18n::t("tray.refresh"), true, None::<&str>)?;
            set_panel_on_top(app.handle(), loaded.config.panel_on_top);
            let quit = MenuItem::with_id(app, "quit", i18n::t("tray.quit"), true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&office_item, &refresh, &sep, &quit])?;
            *TRAY_MENU.lock().unwrap() = Some((office_item.clone(), refresh.clone(), quit.clone()));

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray::image(None, None, 0))
                .tooltip(APP_NAME)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "office" => show_panel(app),
                    "refresh" => {
                        let app = app.clone();
                        std::thread::spawn(move || refresh_plan(&app, true));
                    }
                    "quit" => {
                        save_alert_marks(app);
                        app.state::<AppState>().runner.shutdown();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| match ev {
                    // 한 번 클릭: 오피스 열기/닫기 (예전 관리 창은 없앰 — 기능은 모두 오피스로 옮김)
                    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                        toggle_panel(tray.app_handle());
                    }
                    // 더블클릭: 첫 클릭이 닫았을 수 있으니 무조건 열기
                    TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                        *TRAY_DBL.lock().unwrap() = Some(Instant::now());
                        show_panel(tray.app_handle());
                    }
                    _ => {}
                })
                .build(app)?;

            // 업데이트 후 첫 실행 → 내역(파일·피드)을 구해 오피스를 띄우고 변경 내역 안내 표시.
            // 오피스 웹뷰가 아직 준비 전일 수 있어, 오피스는 시작 때와 이벤트 두 경로로 take_update_notes 를 부름(1회만 받음).
            if updated {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let notes = update::installed_notes(env!("CARGO_PKG_VERSION"));
                    *handle.state::<AppState>().installed.lock().unwrap() = Some(notes);
                    std::thread::sleep(Duration::from_millis(1500));
                    show_panel(&handle);
                    let _ = handle.emit_to(office::LABEL, "update_notes", ());
                });
            } else if first_install {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(800));
                    show_panel(&handle);
                });
            }

            // 주기 갱신 스레드: 플랜 한도 → 트레이 아이콘·툴팁(+열린 패널에 이벤트).
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                refresh_plan(&handle, true);
                let min = config::load().config.refresh_interval_minutes.max(1);
                std::thread::sleep(Duration::from_secs(min * 60));
            });

            // 툴팁의 남은 시간은 1분마다 다시 계산. 초기화 시각이 지났으면 새 한도를 바로 조회.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60));
                if reset_passed(&handle) {
                    refresh_plan(&handle, false);
                } else {
                    redraw_tray(&handle);
                }
            });

            // 채팅 실행기 감시 스레드(시간 초과·다른 창 쓰기 감시·보기만 재판정·정리).
            app.state::<AppState>().runner.clone().start(app.handle().clone());

            // 권한 요청 수신 서버(127.0.0.1). 연동 꺼져 있으면 요청을 결정 없이 돌려보냄.
            let host = PermitHost(app.handle().clone());
            std::thread::spawn(move || permit::serve(hook_port, host));

            // 업데이트 확인(기동 10초 후, 이후 1시간마다). 실패(네트워크 준비 전·오프라인 등)는 RETRY 뒤 다시(연속 RETRY_MAX 번까지), 그래도 안 되면 다음 주기에.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(update::FIRST_CHECK);
                let mut failed = 0u32;
                loop {
                    let ok = tauri::async_runtime::block_on(refresh_update(&handle)).is_ok();
                    if ok || failed >= update::RETRY_MAX {
                        failed = 0;
                        std::thread::sleep(update::INTERVAL);
                    } else {
                        failed += 1;
                        std::thread::sleep(update::RETRY);
                    }
                }
            });

            // 연결 상태(상태 페이지) 확인: 기동 20초 후, 이후 5분마다.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(20));
                loop {
                    poll_status(&handle);
                    std::thread::sleep(health::INTERVAL);
                }
            });

            // 켠 다른 AI 서비스(ChatGPT·Antigravity): 15초마다 조회값 보관(트레이 툴팁)·연결 상태·Codex 턴 끝남 알림, 웹 서비스 장애 알림.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(25));
                let mut tick = 0u64;
                loop {
                    poll_providers(&handle, tick);
                    poll_web_status(&handle, tick);
                    tick += 1;
                    std::thread::sleep(Duration::from_secs(15));
                }
            });

            // 세션 알림 폴링 스레드.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                poll_alerts(&handle);
                let sec = config::load().config.alert_poll_seconds.max(10);
                std::thread::sleep(Duration::from_secs(sec));
            });
            Ok(())
        })
        .on_window_event(|win, ev| match ev {
            // 창 닫기 → 종료 대신 숨김(트레이 상주).
            // 관리 창 포커스 변화 → 앞에 있는지가 바뀌므로 알림 창 표시 다시 판단(항상 위가 꺼져 있을 때 의미 있음).
            WindowEvent::Focused(focused) if win.label() == office::LABEL => {
                if !focused {
                    *PANEL_BLUR.lock().unwrap() = Some(Instant::now());
                }
                sync_notify_async(win.app_handle());
            }
            // 오피스 창은 숨기지 않고 없앰 → 트레이에 있을 땐 3D 장면이 돌지 않음.
            WindowEvent::CloseRequested { .. } if win.label() == office::LABEL => {
                if let Some(w) = win.app_handle().get_webview_window(office::LABEL) {
                    office::save_bounds(&w);
                }
                log::info!("오피스 창 닫힘");
            }
            // 오피스 창이 없어짐 → 알림 창 복귀 여부 다시 판단
            WindowEvent::Destroyed if win.label() == office::LABEL => {
                // 창이 없어지면 자동 수락은 다시 간식 몫으로 모은다
                win.app_handle().state::<AppState>().office_ready.store(false, Ordering::SeqCst);
                sync_notify_async(win.app_handle());
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win.hide();
                // 알림 창을 직접 닫음 → 화면에 없으니 자동 숨김 카운트 중지.
                if win.label() == "notify" {
                    let _ = win.app_handle().emit_to("notify", "notify_visible", false);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            set_lang,
            get_provider,
            get_provider_tokens,
            get_provider_image,
            provider_login,
            get_providers_on,
            set_provider_on,
            get_web_services,
            set_web_status_alert,
            get_provider_hook,
            set_provider_hook,
            get_plan,
            get_api_usage,
            validate_api_key,
            save_api_config,
            get_local,
            get_cloud,
            get_session_image,
            get_config,
            save_config,
            quit_app,
            open_url,
            open_local_session,
            claude_login,
            cred_stamp,
            get_alerts,
            dismiss_alert,
            expire_alert,
            get_alert_history,
            mark_alerts_read,
            get_update,
            take_update_notes,
            current_notes,
            check_update,
            install_update,
            open_alert,
            open_log_dir,
            export_log,
            log_send_preview,
            take_treats,
            get_progress,
            set_progress,
            send_log,
            log_ui,
            preview_alert,
            get_permits,
            answer_permit,
            resync_notify,
            notify_resize,
            sysstat::sys_stats,
            runner::chat_services,
            runner::chat_sessions,
            runner::chat_open,
            runner::chat_history,
            runner::chat_new,
            runner::chat_send,
            runner::chat_interrupt,
            runner::chat_fork,
            runner::chat_takeover,
            runner::chat_close,
            runner::pick_folder,
            exports::export_pick,
            exports::export_analyze,
            exports::export_saved,
            exports::export_save,
            exports::export_forget
        ])
        .build(tauri::generate_context!())
        .expect("tauri 실행 실패")
        .run(|app, event| {
            // 앱 종료 때 채팅 자식 프로세스(claude·codex app-server)를 정리한다(Job Object 가 비정상 종료까지 보강).
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().runner.shutdown();
            }
        });
}

/// 툴팁 조립(`fit_tip`) 단위 테스트.
#[cfg(test)]
mod tip_tests {
    use super::*;

    /// 긴 Claude 줄이 한도를 넘으면 짧은 판으로 바뀌어 다른 서비스 줄이 잘리지 않고 끝에 남는지, 짧아도 되면 긴 판을 그대로 쓰는지 확인한다.
    #[test]
    fn long_claude_lines_shrink_so_provider_line_survives() {
        let full = "Meowffice\n5시간 세션 42% · 20:50 초기화 (1시간 29분 후)\n주간 전체 67% · 11/20 17:00 초기화\n주간 Fable 30% · 11/20 17:00 초기화".to_string();
        let short = "Meowffice\n5시간 세션 42%\n주간 전체 67%\n주간 Fable 30%".to_string();
        let extras = vec!["ChatGPT 12% · Antigravity 80%".to_string()];
        let tip = fit_tip(full.clone(), || short.clone(), &extras);
        assert!(tip.chars().count() <= TIP_MAX);
        assert!(tip.ends_with("ChatGPT 12% · Antigravity 80%"));
        // 짧아도 되면 긴 판을 그대로
        assert_eq!(fit_tip("Meowffice\n5시간 세션 42% · 20:50 초기화".into(), || unreachable!(), &extras).lines().count(), 3);
    }
}

/// 링크 열기 허용 판정(`plain_link_allowed`) 단위 테스트.
#[cfg(test)]
mod link_tests {
    use super::*;

    /// 허용 주소는 통과하고, 슬래시·경로·비슷한 도메인은 거부하는지 확인한다.
    #[test]
    fn plain_links() {
        for ok in [
            ISSUES_URL,
            "https://muneo.co.kr",
            "https://status.claude.com",
            "https://status.openai.com",
            "https://status.openai.com/incidents/x",
            "https://www.google.com/appsstatus/dashboard",
            "https://www.google.com/appsstatus/dashboard/incidents/abc",
            "https://chatgpt.com",
            "https://gemini.google.com",
            "antigravity://",
        ] {
            assert!(plain_link_allowed(ok), "{ok}");
        }
        for bad in [
            "https://chatgpt.com/",
            "https://chatgpt.com/c/1",
            "https://chatgpt.com.evil.io",
            "https://gemini.google.com/app",
            "https://www.google.com/",
            "https://www.google.com/appsstatus/dashboardx",
            "https://claude.ai",
        ] {
            assert!(!plain_link_allowed(bad), "{bad}");
        }
    }
}

#[cfg(test)]
mod agy_default_tests {
    use super::*;

    /// 템플릿 그대로인 설정 파일엔 줄만 덧붙여 주석을 살리고, 다시 읽으면 연동 켬·토큰이 들어 있어야 한다.
    #[test]
    fn append_keeps_template_comments() {
        let dir = std::env::temp_dir().join(format!("meow-agy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.toml");
        std::fs::write(&p, config::TEMPLATE).unwrap();
        let c = config::Config { agy_hook: true, agy_hook_defaulted: true, hook_token: "abc123".into(), ..config::Config::default() };
        persist_agy_default(&p, &c).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("# muneo-claude-usage-tray 설정"), "템플릿 주석 유지");
        let back: config::Config = toml::from_str(&text).unwrap();
        assert!(back.agy_hook && back.agy_hook_defaulted);
        assert_eq!(back.hook_token, "abc123");
        // 이미 저장된 적 있는 파일(agy_hook 줄 있음)은 통째로 저장 — 키가 겹치지 않아야 한다
        persist_agy_default(&p, &c).unwrap();
        let again: config::Config = toml::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert!(again.agy_hook && again.agy_hook_defaulted);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
