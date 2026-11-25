//! 세션 알림 — Claude 가 사용자 응답(권한 수락·검토)을 기다리는 세션을 팝업 카드로 표시.
//! 소스 ① 클라우드 세션 목록(/v1/sessions)의 post_turn_summary.status_category.
//!       원격 제어(브리지) 로컬 세션도 여기에 포함됨.
//!     ② 로컬 세션(터미널·IDE 의 Claude Code) — claude.ai 에 없으므로 훅 이벤트로 받음(add_local).
//!       세션당 1건, 새 입력·도구 실행이면 해소(resolve_local).
//! 카드는 해당 세션이 더 이상 대기 상태가 아니게 되면(=사용자가 처리) 자동 제거.
//! 사용자가 닫은 카드는 같은 대기 건이 바뀌기 전까지 다시 띄우지 않음. 같은 건 = 검토 준비는 세션이 계속 review_ready 인 동안,
//! 입력 대기는 계속 need_input 이고 묻는 내용(needs_action)이 같은 동안(updated_at 만 바뀌는 건 같은 건).
//! 자동 숨김(expire)된 카드도 같음 — 단 읽음 처리는 안 함(트레이 배지·패널 알림 탭에 남음).
//! 닫음·숨김·읽음 기록(marks)은 alert-marks.json 에 남겨 재시작·업데이트 뒤에도 유지(24시간, 죽은 건은 첫 폴링 뒤 정리).
//! 기록(history): 패널 알림 탭용. 열기·닫기·패널에서 보기 → 읽음, 대기가 풀리면(처리됨) 읽음.
//! 패널에서 읽은 카드는 내림 — 입력 대기(need_input) 카드만 처리하거나 직접 닫을 때까지 남김.
//! 종류(KINDS): 알림 분류의 단일 정의. 설정 화면의 종류별 표시 체크·카드 뱃지가 모두 이 표를 씀.
//! 끈 종류(muted)는 받지 않음 — 알림 창·기록·배지 모두 제외. 끄기 전에 받은 건은 창에서 숨기고 읽음 처리.

use crate::oauth::CloudSession;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 같은 id 로 교체되는 앱 카드(연결 상태·업데이트)의 key 접두사. 교체로 목록에서 빠져도 닫음·숨김 기록을 지우지 않음 —
/// 안 그러면 문제 A(닫음) → 문제 B 로 교체 → 다시 A 일 때 이미 닫은 A 가 다시 뜸. 재시작을 넘겨서도(파일 기록) TTL 까지 유지.
/// 종류가 적어 기록이 크게 늘지 않음.
///
/// 값: "claude-status@", "chatgpt-status@", "antigravity-status@", "app-update@", "chatgpt-status-web@", "gemini-status@".
///
/// # 참조
/// `sticky` 가 사용.
pub const STICKY_KEYS: [&str; 6] =
    ["claude-status@", "chatgpt-status@", "antigravity-status@", "app-update@", "chatgpt-status-web@", "gemini-status@"];

/// key 가 `STICKY_KEYS` 접두사 중 하나로 시작하는지 확인한다.
///
/// # 인자
/// - `key`: 알림 key
///
/// # 반환
/// 앱 카드(연결 상태·업데이트)이면 true.
///
/// # 참조
/// `Alerts::reconcile` 이 기록 정리 때 호출.
fn sticky(key: &str) -> bool {
    STICKY_KEYS.iter().any(|p| key.starts_with(p))
}

/// 패널 알림 탭에 남기는 최대 건수(50).
///
/// # 참조
/// `Alerts::reconcile` 이 기록을 이 길이로 자른다.
const HISTORY_MAX: usize = 50;

/// 이보다 오래 방치된 대기 세션은 알림 대상에서 제외(기동 시 과거 건 폭주 방지). 12시간.
///
/// # 참조
/// `MARK_TTL_HOURS` 계산에 사용. 세션 조회 쪽(`main.rs`)에서도 조회 창으로 사용.
pub const RECENT_HOURS: i64 = 12;

/// 닫음·숨김·읽음 기록 보존 시간(시간 단위). 대기 세션 조회 창(`RECENT_HOURS`) + 하루 안의 재시작·꺼둔 시간 여유(12시간).
///
/// # 참조
/// `expired_by_ttl` 이 사용.
pub const MARK_TTL_HOURS: i64 = RECENT_HOURS + 12;
/// 살아 있는 건의 seen 갱신 최소 간격(밀리초, 1시간) — 파일 쓰기 최소화.
///
/// # 참조
/// `Alerts::reconcile` 이 사용.
const SEEN_BUMP_MS: i64 = 3_600_000;
/// alert-marks.json 형식 버전(1).
///
/// # 참조
/// `load_marks`, `Alerts::take_marks_if_dirty` 가 사용.
const MARKS_VERSION: u32 = 1;

/// 알림 종류 정의(설정 화면 체크 목록 순서).
///
/// # 참조
/// `KINDS` 표의 원소. 설정 화면(직렬화)과 `muted_kinds` 가 사용.
#[derive(Serialize, Clone, Copy)]
pub struct Kind {
    /// 종류 id. 설정의 `muted_alert_kinds` 에 들어가는 값이자 `Alert::kind` 값.
    pub id: &'static str,
    /// 설정 화면에 표시하는 종류 이름.
    pub label: &'static str,
    /// 설정 화면 설명.
    pub desc: &'static str,
    /// 출처 뱃지: "local" | "remote" | "app".
    ///
    /// `muted_kinds` 가 `alerts`(remote)·`local_alerts`(local) 설정을 이 값으로 종류에 대응시킨다.
    pub origin: &'static str,
    /// Claude Code 연동(훅)이 있어야 받는 종류.
    pub needs_hook: bool,
}

/// 알림 분류의 단일 정의(9종, 설정 화면 체크 목록 순서).
///
/// local_done, local_input, agent, codex_done, agy_done, remote_input, remote_review, update, status. 설정 화면의 종류별 표시 체크·카드 뱃지가 이 표를 쓴다.
///
/// # 참조
/// `kind_of`, `muted_kinds` 가 사용.
pub const KINDS: [Kind; 9] = [
    Kind {
        id: "local_done",
        label: "로컬 세션 응답 완료",
        desc: "터미널·IDE 의 Claude Code 가 응답을 마치면 알립니다.",
        origin: "local",
        needs_hook: true,
    },
    Kind {
        id: "local_input",
        label: "로컬 세션 입력 대기·권한 확인",
        desc: "입력을 기다리거나 Claude 화면에서 직접 수락할 확인이 있을 때 알립니다.",
        origin: "local",
        needs_hook: true,
    },
    Kind {
        id: "agent",
        label: "에이전트 완료·대기",
        desc: "서브·백그라운드 에이전트가 끝나거나 입력을 기다릴 때 알립니다.",
        origin: "local",
        needs_hook: true,
    },
    Kind {
        id: "codex_done",
        label: "Codex 응답 완료",
        desc: "ChatGPT(Codex) 대화가 한 턴을 마치면 알립니다. Codex 설정은 바꾸지 않고 이 PC 의 기록만 읽습니다.",
        origin: "local",
        needs_hook: false,
    },
    Kind {
        id: "agy_done",
        label: "Antigravity 응답 완료",
        desc: "Antigravity 대화가 한 턴을 마치면 알립니다. Antigravity 의 권한 요청 연동(훅)을 켜야 받습니다.",
        origin: "local",
        needs_hook: false,
    },
    Kind {
        id: "remote_input",
        label: "원격·클라우드 세션 입력 대기",
        desc: "원격 제어·클라우드 세션이 입력을 기다릴 때 알립니다.",
        origin: "remote",
        needs_hook: false,
    },
    Kind {
        id: "remote_review",
        label: "원격·클라우드 세션 검토 준비",
        desc: "원격 제어·클라우드 세션의 변경 사항 검토가 준비되면 알립니다.",
        origin: "remote",
        needs_hook: false,
    },
    Kind {
        id: "update",
        label: "앱 업데이트",
        desc: "새 버전이 나오면 알림 창에서 바로 설치할 수 있습니다.",
        origin: "app",
        needs_hook: false,
    },
    Kind {
        id: "status",
        label: "AI 서비스 연결 상태",
        desc: "Claude 와 (켜 둔) ChatGPT·Antigravity 의 서비스 장애·연결 불안정, (켜 둔) ChatGPT·Gemini 웹 서비스 장애와 복구를 알립니다.",
        origin: "app",
        needs_hook: false,
    },
];

/// 알림의 종류 id 를 판정한다.
///
/// `env` 가 "update"·"status" 면 같은 이름 종류. "local" 이면 id 접두 "codex:" → codex_done, "agy:" → agy_done, 에이전트 알림 → agent, 상태가 "done" → local_done, 그 밖은 local_input.
/// 그 밖의 환경은 상태가 "review_ready" 면 remote_review, 아니면 remote_input.
///
/// # 인자
/// - `a`: 판정할 알림
///
/// # 반환
/// `KINDS` 의 id.
///
/// # 참조
/// `classified` 가 호출.
pub fn kind_of(a: &Alert) -> &'static str {
    match a.env.as_str() {
        "update" => "update",
        "status" => "status",
        "local" if a.id.starts_with("codex:") => "codex_done",
        "local" if a.id.starts_with("agy:") => "agy_done",
        "local" if a.agent => "agent",
        "local" if a.state == "done" => "local_done",
        "local" => "local_input",
        _ if a.state == "review_ready" => "remote_review",
        _ => "remote_input",
    }
}

/// 설정에서 끈 종류 id 목록을 구한다. 예전 설정(alerts·local_alerts 끔)은 해당 종류 전부 끈 것으로 본다.
///
/// `muted_alert_kinds` 를 복사하고, `alerts` 가 꺼져 있으면 origin 이 "remote" 인 종류를, `local_alerts` 가 꺼져 있으면 "local" 인 종류를 중복 없이 덧붙인다.
///
/// # 인자
/// - `cfg`: 설정
///
/// # 반환
/// 끈 종류 id 목록.
///
/// # 참조
/// `KINDS` 사용. 결과는 `Alerts::set_muted` 에 넘긴다.
pub fn muted_kinds(cfg: &crate::config::Config) -> Vec<String> {
    let mut out = cfg.muted_alert_kinds.clone();
    let mut add = |origin: &str| {
        for k in KINDS.iter().filter(|k| k.origin == origin) {
            if !out.iter().any(|x| x == k.id) {
                out.push(k.id.to_string());
            }
        }
    };
    if !cfg.alerts {
        add("remote");
    }
    if !cfg.local_alerts {
        add("local");
    }
    out
}

/// 알림 카드 1건(클라우드 세션·로컬 훅·앱 알림 공통).
///
/// # 참조
/// `Alerts` 가 보관·분류한다. 알림 창과 기록으로 직렬화되어 나간다.
#[derive(Serialize, Clone, PartialEq, Default)]
pub struct Alert {
    /// 알림 식별 키. 클라우드 건은 기본 `<세션 id>@<updated_at>`(같은 대기가 이어지면 이전 key 유지). 닫음·숨김·읽음 기록의 색인.
    pub key: String,
    /// 세션(또는 앱 카드) id. 로컬 알림은 같은 id 의 이전 건을 교체하는 기준.
    pub id: String,
    /// 카드 제목(클라우드 세션은 제목이 비면 id).
    pub title: String,
    /// 카드 본문.
    pub message: String,
    /// 상태 값. 클라우드 대기는 "need_input" · "review_ready", 로컬은 "done" 등(종류 판정과 카드 유지 판정에 쓰임).
    pub state: String,
    /// 출처 환경 값("update", "status", "local", 그 밖은 클라우드·원격 세션 환경).
    pub env: String,
    /// "자세히" 링크 주소.
    pub url: String,
    /// 세션의 마지막 갱신 시각 문자열.
    pub updated_at: String,
    /// 서브·백그라운드 에이전트에서 온 알림(로컬 훅).
    pub agent: bool,
    /// 프로젝트 이름(로컬: 작업 폴더, 원격·클라우드: 저장소/작업 폴더). 모르면 빈 값.
    pub project: String,
    /// 종류 id(KINDS) — 추가될 때 kind_of 로 채움.
    pub kind: &'static str,
    /// 서비스 id: "claude" | "chatgpt" | "antigravity" | "app"(서비스 무관 앱 알림) — 추가될 때 provider_of 로 채움.
    /// 저장 파일에는 넣지 않고 매번 판정하므로 예전 기록은 자동으로 같은 규칙을 따름.
    pub provider: &'static str,
}

/// 알림의 서비스 id(chatgpt·antigravity·gemini·app·claude)를 판정한다. 연결 상태 카드는 키 접두사, Codex·Antigravity 응답 완료는 종류, 업데이트는 앱, 나머지는 claude.
///
/// key 가 "chatgpt-status"(복구 카드 포함)로 시작하면 chatgpt, "antigravity-status" 면 antigravity, "app-update@" 이거나 종류가 update 면 app,
/// 종류가 codex_done 이면 chatgpt, agy_done 이면 antigravity, 그 밖은 claude.
///
/// # 인자
/// - `a`: 판정할 알림(`kind` 가 채워진 상태)
///
/// # 반환
/// 서비스 id.
///
/// # 참조
/// `classified` 가 호출.
pub fn provider_of(a: &Alert) -> &'static str {
    // 문제 카드 chatgpt-status@… 와 복구 카드 chatgpt-status-ok@… 모두
    if a.key.starts_with("gemini-status") {
        return "gemini";
    }
    if a.key.starts_with("chatgpt-status") {
        "chatgpt"
    } else if a.key.starts_with("antigravity-status") {
        "antigravity"
    } else if a.key.starts_with("app-update@") || a.kind == "update" {
        "app"
    } else if a.kind == "codex_done" {
        "chatgpt"
    } else if a.kind == "agy_done" {
        "antigravity"
    } else {
        "claude"
    }
}

/// 알림 기록 1건(패널 알림 탭).
///
/// # 참조
/// `Alerts::history` 가 최근 `HISTORY_MAX` 건을 보관·반환한다.
#[derive(Serialize, Clone)]
pub struct Entry {
    /// 기록한 알림 내용(직렬화 때 이 구조체의 필드가 평탄하게 펼쳐짐).
    #[serde(flatten)]
    pub alert: Alert,
    /// 패널 알림 탭에서 읽음(또는 닫음·처리·끈 종류로 읽음 처리됨).
    pub read: bool,
    /// 대기 상태가 풀림(사용자가 처리).
    pub resolved: bool,
}

/// 패널에서 읽어도 카드를 내리지 않는 알림인지 판정한다.
///
/// 사용자가 처리해야 하는 입력 대기(local_input·remote_input, 에이전트 대기)가 해당한다.
/// 종류 id 로는 agent 가 완료·대기를 같이 쓰므로 상태("need_input")로 판정한다.
///
/// # 인자
/// - `a`: 알림
///
/// # 반환
/// 상태가 "need_input" 이면 true.
///
/// # 참조
/// `Alerts::hidden` 이 호출.
pub fn keeps_card_when_read(a: &Alert) -> bool {
    a.state == "need_input"
}

/// 알림 1건의 닫음·자동 숨김·읽음 기록. 파일(alert-marks.json)에 남겨 재시작·업데이트 뒤에도 같은 건을 다시 띄우지 않음.
///
/// # 참조
/// `Alerts` 의 `marks` 맵 값. `MarksFile` 로 저장된다.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct Mark {
    /// 사용자가 닫음(× 또는 자세히).
    #[serde(default)]
    pub dismissed: bool,
    /// 자동 숨김(설정 시간 경과) — 읽음은 아님.
    #[serde(default)]
    pub expired: bool,
    /// 패널 알림 탭에서 봄.
    #[serde(default)]
    pub read: bool,
    /// 원격 대기 건 이어 붙임용 세션 id. 원격 종류(remote_input·remote_review)만 채우고 나머지는 빈 문자열.
    #[serde(default)]
    pub id: String,
    /// 원격 대기 건 이어 붙임용 상태. 원격 종류만 채우고 나머지는 빈 문자열.
    #[serde(default)]
    pub state: String,
    /// 원격 대기 건 이어 붙임용 카드 본문. 원격 종류만 채우고 나머지는 빈 문자열.
    #[serde(default)]
    pub message: String,
    /// 마지막으로 기록했거나 살아 있는 것을 본 시각(UTC ms). TTL 기준.
    #[serde(default)]
    pub seen: i64,
}

/// `Mark` 생성 메서드.
impl Mark {
    /// 새 기록을 만든다. 원격 카드면 이어 붙임용 id·상태·본문을 같이 담음(앱·로컬 카드, 이미 사라진 key 는 빈 값).
    ///
    /// # 인자
    /// - `a`: 기록 대상 알림(이미 사라졌으면 None)
    /// - `now`: 현재 시각(UTC ms, `seen` 으로 기록)
    ///
    /// # 반환
    /// `seen` 만 채워진 새 `Mark`(원격 종류면 id·state·message 도 채움).
    ///
    /// # 참조
    /// `Alerts::mark_mut`, `Alerts::mark_read` 가 호출.
    fn of(a: Option<&Alert>, now: i64) -> Mark {
        match a {
            Some(a) if matches!(a.kind, "remote_input" | "remote_review") => {
                Mark { id: a.id.clone(), state: a.state.clone(), message: a.message.clone(), seen: now, ..Default::default() }
            }
            _ => Mark { seen: now, ..Default::default() },
        }
    }
}

/// alert-marks.json 전체.
///
/// # 참조
/// `load_marks`, `save_marks`, `Alerts::take_marks_if_dirty` 가 사용.
#[derive(Serialize, Deserialize, Default)]
pub struct MarksFile {
    /// 형식 버전(지금 1). 다른 값이면 버리고 새로 시작.
    pub v: u32,
    /// key → 기록. 로컬 훅·미리보기 key 는 담지 않음.
    pub marks: HashMap<String, Mark>,
}

/// 파일에 남기는 key 인지 판정한다. 로컬 훅(local:)·미리보기(preview-) 카드는 재시작 후 재발하지 않아 안 남김.
///
/// # 인자
/// - `key`: 알림 key
///
/// # 반환
/// 파일에 남겨야 하면 true.
///
/// # 참조
/// `Alerts` 의 기록 갱신·복원·저장 함수들이 호출.
fn persisted(key: &str) -> bool {
    !key.starts_with("local:") && !key.starts_with("preview-")
}

/// 기록이 보존 시간(`MARK_TTL_HOURS`)을 넘겼는지 판정한다.
///
/// # 인자
/// - `m`: 기록
/// - `now`: 현재 시각(UTC ms)
///
/// # 반환
/// `seen` 이후 TTL 이 지났으면 true.
///
/// # 참조
/// `Alerts::reconcile`, `Alerts::restore_marks` 가 호출.
fn expired_by_ttl(m: &Mark, now: i64) -> bool {
    now - m.seen > MARK_TTL_HOURS * 3_600_000
}

/// 기록 파일 경로를 구한다(로그 폴더 옆, last-version 과 같은 곳). 개발 실행은 설치본 기록을 건드리지 않도록 다른 이름.
///
/// # 반환
/// `applog::dir` 의 상위 폴더 아래 `alert-marks.json`(debug 빌드는 `alert-marks.dev.json`).
///
/// # 참조
/// `applog::dir` 호출.
pub fn marks_path() -> PathBuf {
    crate::applog::dir().with_file_name(if cfg!(debug_assertions) { "alert-marks.dev.json" } else { "alert-marks.json" })
}

/// 기록 파일을 읽는다. 파일이 없으면 Ok(None). 손상·형식 버전 불일치는 Err.
///
/// # 인자
/// - `path`: 기록 파일 경로(`marks_path`)
///
/// # 반환
/// `Some(MarksFile)`. 파일이 없으면 `Ok(None)`. 읽기 실패·JSON 해석 실패·버전이 `MARKS_VERSION` 과 다르면 `Err`(문자열).
///
/// # 참조
/// `Alerts::restore_marks` 에 결과를 넘기는 쪽(`main.rs`)이 호출. 파일: `alert-marks.json` 읽기.
pub fn load_marks(path: &Path) -> Result<Option<MarksFile>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let f: MarksFile = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if f.v != MARKS_VERSION {
        return Err(format!("형식 버전 {} (지원 {MARKS_VERSION})", f.v));
    }
    Ok(Some(f))
}

/// 기록을 파일에 쓴다. 임시 파일에 쓰고 이름 바꿈(쓰다 죽어도 이전 파일 유지).
///
/// 상위 폴더를 만들고 `alert-marks.json.tmp`(확장자 `json.tmp`)에 보기 좋게 직렬화해 쓴 뒤 `rename` 으로 교체한다.
///
/// # 인자
/// - `path`: 기록 파일 경로
/// - `f`: 저장할 기록
///
/// # 반환
/// 성공하면 `Ok(())`. 폴더 생성·쓰기·이름 바꾸기 실패 시 `Err`.
///
/// # 참조
/// `Alerts::take_marks_if_dirty` 결과를 쓰는 쪽(`main.rs`)이 호출. 실패하면 `Alerts::mark_dirty` 로 다시 쓰게 한다.
pub fn save_marks(path: &Path, f: &MarksFile) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().unwrap_or(path))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(f).unwrap_or_default())?;
    std::fs::rename(&tmp, path)
}

/// 알림 상태 전체 — 클라우드 대기 건·로컬 알림·닫음/숨김/읽음 기록·패널 기록을 들고 표시 목록을 계산한다.
///
/// # 참조
/// `main.rs` 의 앱 상태에서 보관한다. 기록은 `alert-marks.json` 으로 영속.
#[derive(Default)]
pub struct Alerts {
    /// 클라우드 세션 목록에서 만든 대기 알림(`update` 가 호출될 때마다 통째로 교체).
    pending: Vec<Alert>,
    /// 로컬 세션 알림(훅). 클라우드 폴링(update)과 별개로 유지.
    local: Vec<Alert>,
    /// key → 닫음·숨김·읽음 기록(파일로 영속).
    marks: HashMap<String, Mark>,
    /// 클라우드 목록을 한 번이라도 반영했는지. 그 전에는 파일에서 읽은 원격 건 기록을 "아직 살아 있을 수 있음"으로 보고 지우지 않음.
    polled: bool,
    /// 파일에 써야 할 변경이 있음(로컬 훅·미리보기 key 의 변경은 제외).
    dirty: bool,
    /// 끈 종류 id(설정).
    muted: HashSet<String>,
    /// 패널 알림 탭용 기록(최신이 앞, 최대 `HISTORY_MAX` 건).
    history: Vec<Entry>,
}

/// 알림 대상 대기 세션인지 판정한다. 실행 중(running)이면 post_turn_summary 가 지난 턴 것이라 제외.
///
/// 세션 상태가 "archived"·"running" 이 아니고 대기 상태(`state`)가 "need_input" 또는 "review_ready" 여야 한다.
///
/// # 인자
/// - `s`: 클라우드 세션
///
/// # 반환
/// 알림 대상이면 true.
///
/// # 참조
/// `Alerts::update` 가 호출.
pub fn is_waiting(s: &CloudSession) -> bool {
    !matches!(s.status.as_str(), "archived" | "running") && matches!(s.state.as_str(), "need_input" | "review_ready")
}

/// `Alerts` 의 갱신·조회·기록 영속 메서드.
impl Alerts {
    /// 최신 세션 목록을 반영한다.
    ///
    /// 대기 세션(`is_waiting`)마다 알림을 만든다. 본문은 `needs_action`, 비면 상태별 기본 문구. key 는 같은 대기가 이어지는 동안(`updated_at` 만 바뀜) 유지하려고
    /// 직전 목록 → 파일에서 복원한 기록 순으로 같은 건(같은 id·상태, 검토 준비가 아니면 본문까지 같음)을 찾아 그 key 를 쓰고, 없으면 `<id>@<updated_at>`.
    /// 분류(`classified`) 후 끈 종류를 거르고, `reconcile` 로 기록을 정리한다.
    ///
    /// # 인자
    /// - `sessions`: 최신 클라우드 세션 목록
    ///
    /// # 반환
    /// 표시 목록이나 기록이 바뀌었으면 true.
    ///
    /// # 참조
    /// `is_waiting`, `classified`, `reconcile`, `visible` 호출.
    pub fn update(&mut self, sessions: &[CloudSession]) -> bool {
        self.polled = true;
        let before = self.visible();
        let prev = std::mem::take(&mut self.pending);
        let marks = &self.marks;
        self.pending = sessions
            .iter()
            .filter(|s| is_waiting(s))
            .map(|s| {
                let message = if s.needs_action.is_empty() {
                    match s.state.as_str() {
                        "review_ready" => "검토할 변경 사항이 준비되었습니다.".to_string(),
                        _ => "Claude 가 응답을 기다리고 있습니다.".to_string(),
                    }
                } else {
                    s.needs_action.clone()
                };
                // 대기가 계속 이어지는 동안(백그라운드 에이전트 완료·연결 상태 변화로 updated_at 만 바뀜)은 같은 건으로 봄 —
                // 닫거나 숨긴 카드가 몇 분마다·재시작마다 다시 뜨지 않게. 검토 준비는 상태만, 입력 대기는 묻는 내용(message)까지 같아야 함.
                // 후보 ① 직전 목록(prev) ② 파일에서 복원한 기록(재시작 직후 — 첫 폴링 뒤 죽은 건은 정리돼 빠짐).
                let same_wait =
                    |id: &str, state: &str, msg: &str| id == s.id && state == s.state && (state == "review_ready" || msg == message);
                let key = prev
                    .iter()
                    .find(|p| same_wait(&p.id, &p.state, &p.message))
                    .map(|p| {
                        if p.updated_at != s.updated_at {
                            log::debug!("원격 대기 이어짐(updated_at 만 바뀜): {} {} — key 유지", s.id, s.state);
                        }
                        p.key.clone()
                    })
                    .or_else(|| {
                        marks.iter().find(|(_, m)| same_wait(&m.id, &m.state, &m.message)).map(|(k, _)| {
                            log::debug!("원격 대기 이어 붙임(기록): {} {} — key 유지 {k}", s.id, s.state);
                            k.clone()
                        })
                    })
                    .unwrap_or_else(|| {
                        if prev.iter().any(|p| p.id == s.id && p.state == "need_input" && s.state == "need_input") {
                            log::debug!("원격 입력 대기 내용 바뀜 → 새 알림: {}", s.id);
                        }
                        format!("{}@{}", s.id, s.updated_at)
                    });
                Alert {
                    key,
                    id: s.id.clone(),
                    title: if s.title.is_empty() { s.id.clone() } else { s.title.clone() },
                    message,
                    state: s.state.clone(),
                    env: s.env.clone(),
                    url: s.url.clone(),
                    updated_at: s.updated_at.clone(),
                    project: s.project.clone(),
                    ..Default::default()
                }
            })
            .map(classified)
            .filter(|a| !self.muted.contains(a.kind))
            .collect();
        self.reconcile() || before != self.visible()
    }

    /// 로컬 세션 알림을 추가한다(같은 세션의 이전 건은 교체).
    ///
    /// 분류한 뒤 같은 id 의 이전 로컬 알림을 지운다. 끈 종류면 추가하지 않고 정리만 한다(같은 자리의 이전 알림은 교체되어 사라짐).
    /// 아니면 목록에 넣고 `reconcile` 한다.
    ///
    /// # 인자
    /// - `a`: 추가할 로컬 알림
    ///
    /// # 반환
    /// 항상 true.
    ///
    /// # 참조
    /// `classified`, `reconcile` 호출.
    pub fn add_local(&mut self, a: Alert) -> bool {
        let a = classified(a);
        self.local.retain(|x| x.id != a.id);
        if self.muted.contains(a.kind) {
            // 끈 종류는 받지 않음(같은 자리의 이전 알림은 교체되어 사라짐).
            self.reconcile();
            return true;
        }
        self.local.push(a);
        self.reconcile();
        true
    }

    /// 해당 세션에 아직 남은 로컬 알림이 있는지 확인한다.
    ///
    /// # 인자
    /// - `session`: 세션 id
    ///
    /// # 반환
    /// 같은 id 의 로컬 알림이 있으면 true.
    pub fn has_local(&self, session: &str) -> bool {
        self.local.iter().any(|a| a.id == session)
    }

    /// 해당 id 의 로컬 알림을 찾는다(연결 상태 카드 등 현재 상태 확인용).
    ///
    /// # 인자
    /// - `id`: 알림 id
    ///
    /// # 반환
    /// 있으면 그 알림 참조, 없으면 None.
    pub fn local_of(&self, id: &str) -> Option<&Alert> {
        self.local.iter().find(|a| a.id == id)
    }

    /// 사용자가 그 세션으로 돌아옴(새 입력·도구 실행) → 로컬 알림을 해소한다.
    ///
    /// # 인자
    /// - `session`: 세션 id
    ///
    /// # 반환
    /// 목록이 바뀌었으면 true.
    ///
    /// # 참조
    /// `resolve_local_session`(에이전트 알림 제외) 호출.
    pub fn resolve_local(&mut self, session: &str) -> bool {
        self.resolve_local_session(session, false)
    }

    /// 로컬 알림을 해소한다. `with_agents` 면 그 세션 에이전트 알림(id = <세션>#<에이전트>)까지 해소.
    ///
    /// id 가 세션과 같은 알림, 그리고 `with_agents` 면 `<세션>#` 로 시작하는 알림을 지운다. 지운 게 있으면 `reconcile` 한다.
    ///
    /// # 인자
    /// - `session`: 세션 id
    /// - `with_agents`: 에이전트 알림도 함께 지울지
    ///
    /// # 반환
    /// 목록이 바뀌었으면 true.
    ///
    /// # 참조
    /// `reconcile` 호출. `resolve_local` 이 호출.
    pub fn resolve_local_session(&mut self, session: &str, with_agents: bool) -> bool {
        let n = self.local.len();
        let prefix = format!("{session}#");
        self.local.retain(|a| a.id != session && !(with_agents && a.id.starts_with(&prefix)));
        n != self.local.len() && {
            self.reconcile();
            true
        }
    }

    /// 살아 있는 알림(클라우드+로컬) 기준으로 닫음·숨김 기록을 정리하고 기록(history)을 갱신한다.
    ///
    /// 순서: ① 살아 있는 건의 `seen` 을 1시간 단위로 갱신(TTL 정리보다 먼저) ② 죽은 건·TTL 지난 건의 기록 정리(앱 카드는 TTL 까지 둠, 원격 건은 첫 폴링 이후부터 정리)
    /// ③ 살아 있지 않게 된 기록을 resolved·읽음 처리 ④ 새 알림을 기록 앞에 추가(끈 종류이거나 복원된 읽음 기록이 있으면 읽음으로) ⑤ 기록을 `HISTORY_MAX` 로 자름.
    ///
    /// # 반환
    /// history 항목이 바뀌었으면 true(marks 정리만으로는 true 가 되지 않음).
    ///
    /// # 참조
    /// `persisted`, `sticky`, `expired_by_ttl` 호출. `update`, `add_local`, `resolve_local_session` 이 호출.
    fn reconcile(&mut self) -> bool {
        let mut changed = false;
        let now = Utc::now().timestamp_millis();
        let live: HashSet<&String> = self.pending.iter().chain(&self.local).map(|a| &a.key).collect();
        // 살아 있는 건은 seen 갱신(1시간 단위 — 파일 쓰기 최소화). TTL 정리보다 먼저: 하루 넘게 절전이었다 깨어나도 살아 있는 건은 안 버림.
        for (k, m) in self.marks.iter_mut() {
            if live.contains(k) && now - m.seen > SEEN_BUMP_MS {
                m.seen = now;
                self.dirty |= persisted(k);
            }
        }
        // 죽은 건의 기록 정리(메모리·파일 누수 방지). 앱 카드(sticky)는 같은 key 로 돌아오므로 TTL 까지 둠.
        // 원격 건은 첫 폴링 전엔 죽었는지 알 수 없음(재시작 직후 pending 이 빔) — 폴링 한 번 반영한 뒤부터 정리.
        let polled = self.polled;
        let before = self.marks.len();
        self.marks.retain(|k, m| {
            let proven_dead = !live.contains(k) && !sticky(k) && (polled || !persisted(k));
            !proven_dead && !expired_by_ttl(m, now)
        });
        if self.marks.len() != before {
            log::debug!("알림 기록 정리: {}건", before - self.marks.len());
            self.dirty = true;
        }
        for e in self.history.iter_mut().filter(|e| !e.resolved && !live.contains(&e.alert.key)) {
            e.resolved = true;
            e.read = true;
            changed = true;
        }
        // 새 기록 항목: 끈 종류이거나 파일에서 복원된 읽음 기록이 있으면 읽음으로(재시작 뒤 배지가 다시 켜지지 않게).
        for a in self.pending.iter().chain(&self.local).rev() {
            if !self.history.iter().any(|e| e.alert.key == a.key) {
                let read = self.muted.contains(a.kind) || self.marks.get(&a.key).is_some_and(|m| m.read);
                self.history.insert(0, Entry { alert: a.clone(), read, resolved: false });
                changed = true;
            }
        }
        self.history.truncate(HISTORY_MAX);
        changed
    }

    /// 알림 창에서 숨겨야 하는지 판정한다.
    ///
    /// 기록에 닫음·자동 숨김이 있거나, 읽음이면서 `keeps_card_when_read` 가 아니면 숨긴다(입력 대기 건은 처리하거나 직접 닫을 때까지 카드 유지).
    ///
    /// # 인자
    /// - `a`: 알림
    ///
    /// # 반환
    /// 숨겨야 하면 true.
    ///
    /// # 참조
    /// `visible` 이 호출.
    fn hidden(&self, a: &Alert) -> bool {
        self.marks.get(&a.key).is_some_and(|m| m.dismissed || m.expired || (m.read && !keeps_card_when_read(a)))
    }

    /// 알림 창에 띄울 카드 목록을 구한다(닫음·자동 숨김·읽음(입력 대기 제외)·끈 종류 제외).
    ///
    /// # 반환
    /// 클라우드 건 뒤에 로컬 건을 이은 표시 대상 알림 복사본.
    ///
    /// # 참조
    /// `hidden` 호출.
    pub fn visible(&self) -> Vec<Alert> {
        self.pending.iter().chain(&self.local).filter(|a| !self.muted.contains(a.kind) && !self.hidden(a)).cloned().collect()
    }

    /// 끈 종류를 반영한다. 이미 받은 그 종류의 읽지 않은 알림은 읽음 처리.
    ///
    /// # 인자
    /// - `kinds`: 끈 종류 id 목록(`muted_kinds` 결과)
    ///
    /// # 반환
    /// 기록의 읽음 상태가 바뀌었으면 true.
    pub fn set_muted(&mut self, kinds: Vec<String>) -> bool {
        self.muted = kinds.into_iter().collect();
        let mut changed = false;
        for e in self.history.iter_mut().filter(|e| !e.read && self.muted.contains(e.alert.kind)) {
            e.read = true;
            changed = true;
        }
        changed
    }

    /// key 의 기록을 꺼낸다(없으면 새로 만듦).
    ///
    /// 현재 알림을 찾아(`find`) 새 기록을 `Mark::of` 로 만들어 넣는다.
    ///
    /// # 인자
    /// - `key`: 알림 key
    ///
    /// # 반환
    /// 그 key 의 `Mark` 가변 참조.
    ///
    /// # 참조
    /// `find`, `Mark::of` 호출. `dismiss`, `expire` 가 호출.
    fn mark_mut(&mut self, key: &str) -> &mut Mark {
        let a = self.find(key);
        let now = Utc::now().timestamp_millis();
        self.marks.entry(key.to_string()).or_insert_with(|| Mark::of(a.as_ref(), now))
    }

    /// 파일에 남기는 key 의 기록이 바뀌었음을 표시한다(`dirty`).
    ///
    /// # 인자
    /// - `key`: 알림 key
    ///
    /// # 참조
    /// `persisted` 호출. `dismiss`, `expire` 가 호출.
    fn touch(&mut self, key: &str) {
        self.dirty |= persisted(key);
    }

    /// 카드를 닫는다(× 또는 자세히).
    ///
    /// 기록에 닫음을 표시하고 파일 변경으로 기록한 뒤 그 key 를 읽음 처리한다.
    ///
    /// # 인자
    /// - `key`: 닫을 알림 key
    ///
    /// # 참조
    /// `mark_mut`, `touch`, `mark_read` 호출.
    pub fn dismiss(&mut self, key: &str) {
        self.mark_mut(key).dismissed = true;
        self.touch(key);
        self.mark_read(Some(key));
    }

    /// 자동 숨김: 카드만 내리고 읽음 처리는 안 함.
    ///
    /// # 인자
    /// - `key`: 숨길 알림 key
    ///
    /// # 참조
    /// `mark_mut`, `touch` 호출.
    pub fn expire(&mut self, key: &str) {
        self.mark_mut(key).expired = true;
        self.touch(key);
    }

    /// key 하나(None 이면 전부)를 읽음 처리한다. 읽은 건은 기록(marks)에도 남겨 재시작 뒤에도 읽음·카드 내림이 유지됨.
    ///
    /// 읽지 않은 history 항목 중 대상을 읽음으로 바꾸고, 해당 key 의 기록에 `read` 를 표시한다(없으면 새로 만듦). 파일에 남기는 key 가 있으면 `dirty` 로 둔다.
    ///
    /// # 인자
    /// - `key`: 읽음 처리할 알림 key(None 이면 모든 읽지 않은 알림)
    ///
    /// # 반환
    /// 바뀐 항목이 있으면 true.
    ///
    /// # 참조
    /// `Mark::of`, `persisted` 호출. `dismiss` 가 호출.
    pub fn mark_read(&mut self, key: Option<&str>) -> bool {
        let now = Utc::now().timestamp_millis();
        let (mut changed, mut on_disk) = (false, false);
        for e in self.history.iter_mut().filter(|e| !e.read && key.is_none_or(|k| e.alert.key == k)) {
            e.read = true;
            self.marks.entry(e.alert.key.clone()).or_insert_with(|| Mark::of(Some(&e.alert), now)).read = true;
            changed = true;
            on_disk |= persisted(&e.alert.key);
        }
        self.dirty |= on_disk;
        changed
    }

    /// 파일에서 읽은 기록을 복원한다(기동 시 1회). TTL 지난 건·파일에 없어야 할 key 는 버림.
    ///
    /// `persisted` 이면서 TTL 안인 기록만 골라 합친다. 버린 게 있으면 `dirty` 로 둬서 다음 저장 때 파일을 정리한다.
    ///
    /// # 인자
    /// - `marks`: `load_marks` 로 읽은 기록 맵
    /// - `now`: 현재 시각(UTC ms)
    ///
    /// # 반환
    /// (남긴 수, 버린 수).
    ///
    /// # 참조
    /// `persisted`, `expired_by_ttl` 호출.
    pub fn restore_marks(&mut self, marks: HashMap<String, Mark>, now: i64) -> (usize, usize) {
        let total = marks.len();
        let keep: HashMap<String, Mark> = marks.into_iter().filter(|(k, m)| persisted(k) && !expired_by_ttl(m, now)).collect();
        let kept = keep.len();
        self.dirty |= kept != total;
        self.marks.extend(keep);
        (kept, total - kept)
    }

    /// 저장이 실패했을 때 다음 저장 때 다시 쓰도록 표시한다.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// 바뀐 기록이 있으면 파일에 쓸 내용을 꺼내고 `dirty` 를 내린다.
    ///
    /// `dirty` 가 아니면 None. 맞으면 `persisted` key 의 기록만 모아(로컬 훅·미리보기 제외) `MARKS_VERSION` 형식으로 돌려준다.
    ///
    /// # 반환
    /// 쓸 `MarksFile`. 바뀐 게 없으면 None.
    ///
    /// # 참조
    /// `persisted` 호출. 결과는 `save_marks` 로 쓴다.
    pub fn take_marks_if_dirty(&mut self) -> Option<MarksFile> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let marks = self.marks.iter().filter(|(k, _)| persisted(k)).map(|(k, m)| (k.clone(), m.clone())).collect();
        Some(MarksFile { v: MARKS_VERSION, marks })
    }

    /// 읽지 않은 알림 수를 센다(트레이 배지용).
    ///
    /// # 반환
    /// history 에서 `read` 가 false 인 항목 수.
    pub fn unread(&self) -> usize {
        self.history.iter().filter(|e| !e.read).count()
    }

    /// 패널 알림 탭용 기록을 복사해 돌려준다.
    ///
    /// # 반환
    /// 최신이 앞인 `Entry` 목록.
    pub fn history(&self) -> Vec<Entry> {
        self.history.clone()
    }

    /// key 로 살아 있는 알림을 찾는다.
    ///
    /// # 인자
    /// - `key`: 알림 key
    ///
    /// # 반환
    /// 클라우드 건 → 로컬 건 순으로 처음 일치하는 알림 복사본. 없으면 None.
    pub fn find(&self, key: &str) -> Option<Alert> {
        self.pending.iter().chain(&self.local).find(|a| a.key == key).cloned()
    }
}

/// 알림에 종류(kind)와 서비스(provider)를 채운다.
///
/// # 인자
/// - `a`: 분류할 알림
///
/// # 반환
/// `kind`·`provider` 가 채워진 알림.
///
/// # 참조
/// `kind_of`, `provider_of` 호출. `update`, `add_local` 이 호출.
fn classified(mut a: Alert) -> Alert {
    a.kind = kind_of(&a);
    a.provider = provider_of(&a);
    a
}

/// 알림 분류·닫음 기록 보존·정리 규칙을 검증하는 시험 모음.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_by_kind_and_key() {
        let p = |key: &str, id: &str, env: &str| provider_of(&classified(Alert { key: key.into(), id: id.into(), env: env.into(), ..Default::default() }));
        assert_eq!(p("codex:1@1", "codex:1", "local"), "chatgpt");
        assert_eq!(p("agy:1@1", "agy:1", "local"), "antigravity");
        assert_eq!(p("chatgpt-status@1", "x", "status"), "chatgpt");
        assert_eq!(p("antigravity-status@1", "x", "status"), "antigravity");
        assert_eq!(p("chatgpt-status-ok@1", "x", "status"), "chatgpt"); // 복구 카드
        assert_eq!(p("antigravity-status-ok@1", "x", "status"), "antigravity");
        assert_eq!(p("claude-status@1", "x", "status"), "claude");
        assert_eq!(p("gemini-status@1", "x", "status"), "gemini");
        assert_eq!(p("gemini-status-ok@1", "x", "status"), "gemini");
        assert_eq!(p("chatgpt-status-web@1", "x", "status"), "chatgpt");
        assert_eq!(p("app-update@1", "x", "update"), "app");
        assert_eq!(p("s@1", "s", "cloud"), "claude");
    }

    fn waiting(id: &str, at: &str) -> CloudSession {
        CloudSession {
            id: id.into(),
            title: id.into(),
            status: "idle".into(),
            env: "cloud".into(),
            model: String::new(),
            created_at: at.into(),
            updated_at: at.into(),
            state: "need_input".into(),
            needs_action: String::new(),
            url: String::new(),
            tokens: None,
            cost_usd: None,
            project: String::new(),
            env_id: String::new(),
        }
    }

    fn asking(id: &str, at: &str, text: &str) -> CloudSession {
        CloudSession { needs_action: text.into(), ..waiting(id, at) }
    }

    fn now() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn local_card(key: &str, id: &str, state: &str) -> Alert {
        Alert {
            key: key.into(),
            id: id.into(),
            title: "t".into(),
            message: "m".into(),
            state: state.into(),
            env: "local".into(),
            ..Default::default()
        }
    }

    #[test]
    fn dismissed_mark_survives_restart_until_first_poll() {
        let mut a = Alerts::default();
        a.update(&[waiting("s1", "t1")]);
        a.dismiss("s1@t1");
        let f = a.take_marks_if_dirty().unwrap();
        assert!(f.marks["s1@t1"].dismissed && f.marks["s1@t1"].read);
        assert!(a.take_marks_if_dirty().is_none(), "바뀐 게 없으면 다시 쓰지 않음");

        let mut b = Alerts::default();
        assert_eq!(b.restore_marks(f.marks, now()), (1, 0));
        // 폴링 전의 add_local(상태 카드) 로 원격 기록이 지워지면 안 됨.
        b.add_local(Alert {
            key: "claude-status@net".into(),
            id: "claude-status".into(),
            state: "status".into(),
            env: "status".into(),
            ..Default::default()
        });
        b.update(&[waiting("s1", "t1")]);
        assert!(b.visible().iter().all(|x| x.key != "s1@t1"), "닫은 건은 재시작 뒤에도 안 뜸");
        assert_eq!(b.unread(), 1, "복원된 읽음 기록 — 원격 건은 읽음, 상태 카드만 미읽음");
        // 폴링 뒤 사라진 건의 기록은 정리.
        b.update(&[]);
        assert!(!b.take_marks_if_dirty().unwrap().marks.contains_key("s1@t1"));
    }

    #[test]
    fn read_in_panel_takes_down_cards_except_input_waiting() {
        let mut a = Alerts::default();
        let review = CloudSession { state: "review_ready".into(), ..waiting("s2", "t1") };
        a.update(&[asking("s1", "t1", "A"), review]);
        a.add_local(local_card("local:x@1", "x", "done"));
        assert_eq!(a.visible().len(), 3);
        assert!(a.mark_read(None));
        let v = a.visible();
        assert_eq!((v.len(), v[0].key.as_str()), (1, "s1@t1"), "입력 대기만 남음");
        a.add_local(local_card("local:y@1", "y", "need_input"));
        a.mark_read(None);
        assert_eq!(a.visible().len(), 2, "로컬 입력 대기도 읽어도 남음");
        a.dismiss("s1@t1");
        assert_eq!(a.visible().len(), 1);
    }

    #[test]
    fn continuing_need_input_keeps_key_until_content_changes() {
        let mut a = Alerts::default();
        a.update(&[asking("s1", "t1", "A")]);
        a.expire("s1@t1");
        assert!(!a.update(&[asking("s1", "t2", "A")]), "updated_at 만 바뀜 → 같은 건");
        assert!(a.visible().is_empty() && a.history().len() == 1 && a.find("s1@t1").is_some());
        assert!(a.update(&[asking("s1", "t3", "B")]), "묻는 내용이 바뀜 → 새 알림");
        assert_eq!(a.visible()[0].key, "s1@t3");
        assert_eq!(a.history().len(), 2);
    }

    #[test]
    fn restored_mark_bridges_updated_at_change_after_restart() {
        let mut a = Alerts::default();
        a.update(&[asking("s1", "t1", "A")]);
        a.dismiss("s1@t1");
        let f = a.take_marks_if_dirty().unwrap();
        let mut b = Alerts::default();
        b.restore_marks(f.marks, now());
        b.update(&[asking("s1", "t2", "A")]);
        assert!(b.visible().is_empty() && b.find("s1@t1").is_some(), "앱이 꺼진 사이 updated_at 만 바뀐 건은 기록으로 이어 붙임");
        b.update(&[asking("s1", "t3", "B")]);
        assert_eq!(b.visible().len(), 1);
    }

    #[test]
    fn marks_skip_local_and_preview_keys_and_expire_by_ttl() {
        let mut a = Alerts::default();
        a.add_local(local_card("local:x@1", "x", "done"));
        a.dismiss("local:x@1");
        assert!(a.visible().is_empty());
        assert!(a.take_marks_if_dirty().is_none(), "로컬 카드만 바뀌면 파일 쓰기 없음");
        a.update(&[waiting("s1", "t1")]);
        a.dismiss("s1@t1");
        let f = a.take_marks_if_dirty().unwrap();
        assert!(f.marks.contains_key("s1@t1") && !f.marks.contains_key("local:x@1"));

        let mut b = Alerts::default();
        let old = Mark { dismissed: true, seen: now() - 25 * 3_600_000, ..Default::default() };
        let fresh = Mark { dismissed: true, seen: now() - 3_600_000, ..Default::default() };
        let marks = HashMap::from([("s9@t".to_string(), old), ("s8@t".to_string(), fresh)]);
        assert_eq!(b.restore_marks(marks, now()), (1, 1));
    }

    #[test]
    fn sticky_mark_persists_across_restart() {
        let card = || Alert {
            key: "app-update@1.2".into(),
            id: "app-update".into(),
            state: "update".into(),
            env: "update".into(),
            ..Default::default()
        };
        let mut a = Alerts::default();
        a.add_local(card());
        a.dismiss("app-update@1.2");
        let f = a.take_marks_if_dirty().unwrap();
        let mut b = Alerts::default();
        b.restore_marks(f.marks, now());
        b.update(&[]); // 폴링 뒤에도 sticky 기록은 남음
        b.add_local(card());
        assert!(b.visible().is_empty());
    }

    #[test]
    fn marks_file_roundtrip_is_atomic() {
        let path = std::env::temp_dir().join(format!("muneo-marks-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(load_marks(&path).unwrap().is_none());
        let mut f = MarksFile { v: MARKS_VERSION, marks: HashMap::new() };
        f.marks.insert(
            "s1@t1".into(),
            Mark { dismissed: true, id: "s1".into(), state: "need_input".into(), message: "A".into(), seen: 5, ..Default::default() },
        );
        save_marks(&path, &f).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let back = load_marks(&path).unwrap().unwrap();
        assert_eq!(back.marks, f.marks);
        std::fs::write(&path, "{").unwrap();
        assert!(load_marks(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn expire_hides_card_but_stays_unread() {
        let mut a = Alerts::default();
        assert!(a.update(&[waiting("s1", "t1"), waiting("s2", "t1")]));
        assert_eq!((a.visible().len(), a.unread()), (2, 2));

        a.expire("s1@t1");
        a.dismiss("s2@t1");
        assert_eq!((a.visible().len(), a.unread()), (0, 1));
        // 같은 대기 건이면 다시 띄우지 않음.
        assert!(!a.update(&[waiting("s1", "t1"), waiting("s2", "t1")]));
        assert_eq!(a.visible().len(), 0);

        assert!(a.mark_read(None));
        assert_eq!(a.unread(), 0);
    }

    #[test]
    fn local_alert_survives_cloud_poll_and_resolves() {
        let mut a = Alerts::default();
        let local = Alert {
            key: "local:x@1".into(),
            id: "x".into(),
            title: "t".into(),
            message: "m".into(),
            state: "done".into(),
            env: "local".into(),
            url: String::new(),
            updated_at: "1".into(),
            ..Default::default()
        };
        assert!(a.add_local(local.clone()));
        a.update(&[waiting("s1", "t1")]);
        assert_eq!((a.visible().len(), a.unread()), (2, 2));
        // 같은 세션의 새 이벤트는 교체.
        a.add_local(Alert { key: "local:x@2".into(), ..local });
        assert_eq!(a.visible().len(), 2);
        assert!(a.resolve_local("x"));
        assert!(!a.has_local("x"));
        assert_eq!(a.visible().len(), 1);
        assert!(!a.resolve_local("x"));
    }

    #[test]
    fn dismissed_app_card_stays_dismissed_after_replacement() {
        let mut a = Alerts::default();
        let card = |key: &str| Alert {
            key: key.into(),
            id: "claude-status".into(),
            title: "t".into(),
            message: "m".into(),
            state: "status".into(),
            env: "status".into(),
            url: String::new(),
            updated_at: "1".into(),
            ..Default::default()
        };
        a.add_local(card("claude-status@net"));
        a.dismiss("claude-status@net");
        a.add_local(card("claude-status@incident:x")); // 다른 문제로 교체
        a.add_local(card("claude-status@net")); // 처음 문제로 돌아옴
        assert!(a.visible().is_empty(), "이미 닫은 같은 문제는 다시 띄우지 않음");
    }

    #[test]
    fn resolved_alert_is_read() {
        let mut a = Alerts::default();
        a.update(&[waiting("s1", "t1")]);
        assert!(a.update(&[]));
        let h = a.history();
        assert_eq!(h.len(), 1);
        assert!(h[0].resolved && h[0].read);
        assert_eq!(a.unread(), 0);
    }

    #[test]
    fn continuing_review_keeps_key_and_running_is_not_waiting() {
        let mut a = Alerts::default();
        let review = |at: &str, status: &str| CloudSession { state: "review_ready".into(), status: status.into(), ..waiting("s1", at) };
        a.update(&[review("t1", "idle")]);
        a.expire("s1@t1");
        // 턴이 다시 끝나 updated_at 만 바뀜 → 같은 건이라 다시 안 뜸.
        assert!(!a.update(&[review("t2", "idle")]));
        assert!(a.visible().is_empty());
        // 실행 중이면 대기 아님 → 풀림. 다시 검토 준비가 되면 새 알림.
        a.update(&[review("t3", "running")]);
        a.update(&[review("t4", "idle")]);
        assert_eq!(a.visible().len(), 1);
    }

    #[test]
    fn muted_kind_is_hidden_and_read() {
        let mut a = Alerts::default();
        a.update(&[waiting("s1", "t1")]);
        assert_eq!(a.visible()[0].kind, "remote_input");
        assert!(a.set_muted(vec!["remote_input".into()]));
        assert_eq!((a.visible().len(), a.unread()), (0, 0));
        let agent = Alert { key: "k".into(), id: "x".into(), state: "done".into(), env: "local".into(), agent: true, ..Default::default() };
        a.add_local(agent.clone());
        assert_eq!(a.visible()[0].kind, "agent");
        // 끈 종류는 기록에도 안 남음.
        a.set_muted(vec!["remote_input".into(), "agent".into()]);
        a.add_local(Alert { key: "k2".into(), ..agent });
        assert!(a.visible().is_empty());
        assert!(!a.history().iter().any(|e| e.alert.key == "k2"));
    }

    #[test]
    fn user_prompt_resolves_session_agents() {
        let mut a = Alerts::default();
        let card =
            |id: &str| Alert { key: format!("{id}@1"), id: id.into(), state: "done".into(), env: "local".into(), ..Default::default() };
        a.add_local(card("s"));
        a.add_local(Alert { agent: true, ..card("s#a1") });
        a.add_local(Alert { agent: true, ..card("other#a2") });
        assert!(a.resolve_local("s"));
        assert_eq!(a.visible().len(), 2, "도구 실행만으로는 에이전트 알림 유지");
        assert!(a.resolve_local_session("s", true));
        assert_eq!(a.visible().len(), 1);
        assert_eq!(a.visible()[0].id, "other#a2");
    }
}
