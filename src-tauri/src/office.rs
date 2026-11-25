//! 3D 오피스 창 — 앞으로 기존 트레이 패널을 대신할 메인 UI.
//!
//! - 트레이에 있을 때는 창(과 3D 장면)을 아예 만들지 않음 → GPU·CPU 사용 없음.
//! - 트레이 아이콘 더블클릭(또는 메뉴 "오피스 열기")으로 만들고, 닫으면 창을 없앰(숨김 아님).
//! - 크기 조절·최대화 가능, F11 로 전체 화면(웹 쪽 office.js).
//! - 마지막 위치·크기·최대화 여부는 office-window.json 에 남겨 다음에 그대로 엶.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 오피스 창의 Tauri 창 레이블.
///
/// `open` 이 창 존재 여부를 찾고 만들 때, 다른 모듈이 이 창을 가리킬 때 쓴다.
pub const LABEL: &str = "office";

/// 저장하는 오피스 창의 위치·크기·최대화 상태.
///
/// `office-window.json`(debug 빌드는 `office-window.dev.json`)에 JSON 으로 저장·복원된다.
#[derive(Serialize, Deserialize, Clone, Copy)]
struct Bounds {
    /// 창 바깥 왼쪽 위의 화면 x 좌표(물리 화소).
    x: i32,
    /// 창 바깥 왼쪽 위의 화면 y 좌표(물리 화소).
    y: i32,
    /// 창 안쪽(내용 영역) 너비(물리 화소).
    w: u32,
    /// 창 안쪽(내용 영역) 높이(물리 화소).
    h: u32,
    /// 저장 시점에 최대화 상태였는지.
    maximized: bool,
}

/// 창 상태 파일 경로.
///
/// # 반환
/// `applog::dir` 의 상위 폴더 아래 `office-window.json`(debug 빌드는 `office-window.dev.json`).
///
/// # 참조
/// `load_bounds`, `save_bounds` 가 사용.
fn state_path() -> std::path::PathBuf {
    crate::applog::dir().with_file_name(if cfg!(debug_assertions) { "office-window.dev.json" } else { "office-window.json" })
}

/// 저장된 창 상태를 읽는다.
///
/// # 반환
/// 파일을 읽고 해석하면 `Some(Bounds)`. 없거나 깨졌으면 None.
///
/// # 참조
/// `state_path`. `open`, `save_bounds` 가 호출. 파일: 창 상태 파일 읽기.
fn load_bounds() -> Option<Bounds> {
    serde_json::from_str(&std::fs::read_to_string(state_path()).ok()?).ok()
}

/// 저장된 위치가 지금 연결된 모니터 안에 걸쳐 있는지 확인한다(모니터를 뺐을 때 화면 밖에 열리지 않게).
///
/// 창 왼쪽 위에서 (+80, +40) 지점(제목 막대쯤)이 어느 모니터 영역 안에라도 들어가면 true 로 본다.
///
/// # 인자
/// - `app`: Tauri 앱 핸들(모니터 목록 조회용)
/// - `b`: 확인할 저장 위치
///
/// # 반환
/// 화면 안이면 true. 모니터 목록을 얻지 못하면 false.
///
/// # 참조
/// `open` 이 호출.
fn on_screen(app: &AppHandle, b: &Bounds) -> bool {
    let Ok(mons) = app.available_monitors() else { return false };
    mons.iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        let (cx, cy) = (b.x + 80, b.y + 40); // 제목 막대 쯤이 보여야 끌어 옮길 수 있음
        cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
    })
}

/// 오피스 창을 앞으로 가져온다(없으면 만든다).
///
/// 창이 이미 있으면 최소화 해제·표시·포커스만 한다. 없으면 `office/index.html` 을 여는 창(기본 1280x800, 최소 800x500, 크기 조절·최대화 가능)을
/// 숨긴 채 만든 뒤, 저장된 상태가 연결된 모니터 안이면 크기·위치·최대화를 복원하고 보여 준다. 창 생성에 실패하면 경고 로그만 남기고 끝낸다.
///
/// # 인자
/// - `app`: Tauri 앱 핸들
///
/// # 참조
/// `load_bounds`, `on_screen` 호출. 창 레이블 `LABEL`.
pub fn open(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("office/index.html".into()))
        .title(format!("{} — 고양이사무실 · AI 세션 가상 오피스", crate::APP_NAME))
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .resizable(true)
        .maximizable(true)
        .decorations(true)
        .visible(false)
        .center()
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => {
            log::warn!("오피스 창 만들기 실패: {e}");
            return;
        }
    };
    if let Some(b) = load_bounds().filter(|b| on_screen(app, b)) {
        let _ = w.set_size(PhysicalSize::new(b.w.max(800), b.h.max(500)));
        let _ = w.set_position(PhysicalPosition::new(b.x, b.y));
        if b.maximized {
            let _ = w.maximize();
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    log::info!("오피스 창 열림");
}

/// 창이 닫히기 직전에 위치·크기를 저장한다.
///
/// 전체 화면이거나 최소화 상태면 저장하지 않는다. 최대화 상태면 화면 크기는 의미가 없으므로 이전에 저장된 보통 크기를 유지한 채 `maximized` 만 true 로 쓰고(이전 값이 없으면 저장 안 함),
/// 그렇지 않으면 현재 바깥 위치와 안쪽 크기를 쓴다. 쓰기 실패는 무시한다.
///
/// # 인자
/// - `w`: 닫히려는 오피스 창
///
/// # 참조
/// `load_bounds`, `state_path` 호출. 파일: 창 상태 파일 쓰기.
pub fn save_bounds(w: &WebviewWindow) {
    if w.is_fullscreen().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let prev = load_bounds();
    let b = if maximized {
        // 최대화 상태의 크기는 화면 크기라 의미 없음 → 이전 보통 크기 유지
        match prev {
            Some(p) => Bounds { maximized: true, ..p },
            None => return,
        }
    } else {
        let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) else { return };
        Bounds { x: p.x, y: p.y, w: s.width, h: s.height, maximized: false }
    };
    if let Ok(t) = serde_json::to_string(&b) {
        let _ = std::fs::write(state_path(), t);
    }
}
