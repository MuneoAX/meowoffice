//! 자동 업데이트 — tauri-plugin-updater.
//! 엔드포인트(latest.json)·서명 공개키는 tauri.conf.json 의 plugins.updater. 업로드는 scripts/release.mjs.
//! 기동 10초 후 + 1시간마다 확인(사무실 창을 열 때도 10분 넘게 지났으면 화면이 다시 확인) → 새 버전이 있으면 상태에 기억, 패널에 "update" 이벤트, 트레이 툴팁에 1줄.
//! 설치는 사용자가 패널에서 누를 때만(작업 중 갑자기 재시작되지 않도록). Windows 는 설치 프로그램이 앱을 닫고 다시 띄움.
//! 업데이트 후 첫 실행: 마지막으로 실행한 버전(last-version)과 다르면 "업데이트 완료" 모달로 변경 내역 표시.
//! 앱에서 설치했든 설치 파일로 직접 올렸든 같음. 내역은 설치 직전 남겨 둔 파일(update-notes.json) → 없으면 업데이트 피드.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// 앱 시작 후 첫 업데이트 확인까지 기다리는 시간(10초).
pub const FIRST_CHECK: Duration = Duration::from_secs(10);
/// 업데이트 확인 반복 주기(1시간).
pub const INTERVAL: Duration = Duration::from_secs(3600);
/// 확인이 실패했을 때 다시 해 보기까지 기다리는 시간(90초).
pub const RETRY: Duration = Duration::from_secs(90);
/// 연속 재시도 횟수 상한(넘으면 `INTERVAL` 주기로 돌아감).
pub const RETRY_MAX: u32 = 3;

/// 설치 가능한(또는 설치 중·설치된) 버전과 그 변경 내역.
///
/// 패널로 보내는 "update" 이벤트, 업데이트 완료 모달, `update-notes.json` 저장에 쓰인다(직렬화·역직렬화).
#[derive(Serialize, Deserialize, Clone)]
pub struct Available {
    /// 버전 문자열.
    pub version: String,
    /// 변경 내역 본문(없으면 빈 문자열).
    pub notes: String,
}

/// 새 버전이 있는지 확인한다.
///
/// `tauri-plugin-updater` 로 엔드포인트(tauri.conf.json 의 plugins.updater)를 조회해, 새 버전이 있으면 버전과 노트를 담아 돌려준다.
///
/// # 인자
/// - `app`: Tauri 앱 핸들
///
/// # 반환
/// 새 버전이 있으면 `Some(Available)`, 최신이면 None. 업데이터 생성·조회 실패 시 오류 문자열.
pub async fn check(app: &AppHandle) -> Result<Option<Available>, String> {
    // 시간 제한(플러그인 기본은 없음): 서버가 응답을 물고 있으면 업데이트 확인이 끝나지 않던 것
    let update = app.updater_builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| Available { version: u.version, notes: u.body.unwrap_or_default() }))
}

/// 새 버전을 내려받아 설치하고 앱을 다시 시작한다.
///
/// 다시 확인해 새 버전이 없으면 오류를 돌려준다. 있으면 변경 내역을 `save_notes` 로 파일에 남긴 뒤
/// 내려받기·서명 확인·설치를 하고 `app.restart()` 한다. 내려받은 바이트 수와 단계는 로그에 남긴다.
/// 재시작에 성공하면 이 함수는 돌아오지 않는다.
///
/// # 인자
/// - `app`: Tauri 앱 핸들
///
/// # 반환
/// 이미 최신이면 `Err("이미 최신 버전입니다")`, 그 밖의 업데이터·내려받기·설치 실패도 `Err`(문자열).
///
/// # 참조
/// `save_notes` 호출. 파일: `update-notes.json` 쓰기.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    // 내려받기까지 같은 제한을 쓰므로 넉넉히(느린 회선의 설치 파일 내려받기)
    let update = app.updater_builder().timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?.ok_or(crate::i18n::t("update.up_to_date"))?;
    log::info!("업데이트 내려받기 시작: {} → {}", update.current_version, update.version);
    save_notes(&Available { version: update.version.clone(), notes: update.body.clone().unwrap_or_default() });
    let mut got = 0usize;
    update
        .download_and_install(|n, _| got += n, || log::info!("업데이트 내려받기 완료(서명 확인됨) — 설치 시작"))
        .await
        .map_err(|e| e.to_string())?;
    log::info!("업데이트 설치 완료({got} bytes) — 다시 시작");
    app.restart();
}

/// 변경 내역(노트)을 읽을 업데이트 피드(latest.json) 주소. tauri.conf.json 의 plugins.updater.endpoints 중 자체 서버 주소(업데이트 확인은 GitHub 릴리스가 먼저).
///
/// # 참조
/// `feed_notes` 가 조회.
const FEED: &str = "https://muneo.co.kr/downloads/claude-tray/latest.json";

/// 이번 실행이 버전이 바뀐 뒤 첫 실행인지 확인하고 현재 버전을 기록한다.
///
/// debug 빌드는 기록하지 않고 false. 그 밖에는 `last-version` 파일을 읽어 현재 버전과 다르면 현재 버전으로 덮어쓴다.
/// 기록이 있으면 현재 버전과 다를 때 true. 기록이 없으면(이 기능 이전 버전에서 올라온 경우) 처음 설치(`fresh`)가 아닐 때만 true.
///
/// # 인자
/// - `current`: 지금 실행 중인 앱 버전 문자열
/// - `fresh`: 이번 실행이 처음 설치 후 첫 실행(설정 파일을 새로 만듦)인지
///
/// # 반환
/// 업데이트 후 첫 실행이면 true.
///
/// # 참조
/// `applog::dir` 의 상위 폴더에 있는 `last-version` 파일 읽기·쓰기.
pub fn first_run_after_update(current: &str, fresh: bool) -> bool {
    // 개발 실행(tauri dev)은 기록하지 않음 — 같은 PC 의 설치본이 업데이트 후 모달을 못 보게 됨.
    if cfg!(debug_assertions) {
        return false;
    }
    let path = crate::applog::dir().with_file_name("last-version");
    let last = std::fs::read_to_string(&path).ok().map(|s| s.trim().to_string());
    if last.as_deref() != Some(current) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path)).and_then(|_| std::fs::write(&path, current));
    }
    match last {
        Some(v) => v != current,
        None => !fresh,
    }
}

/// 지금 버전의 변경 내역을 구한다.
///
/// 설치 직전에 남긴 파일(`take_installed`)을 먼저 보고, 없으면 업데이트 피드(`feed_notes`)에서 가져온다.
/// 둘 다 없으면 노트가 빈 `Available` 을 돌려준다.
///
/// # 인자
/// - `current`: 지금 실행 중인 앱 버전 문자열
///
/// # 반환
/// `Available`(노트가 비어 있을 수 있음).
///
/// # 참조
/// `take_installed`, `feed_notes` 호출.
pub fn installed_notes(current: &str) -> Available {
    let a = take_installed(current).or_else(|| feed_notes(current)).unwrap_or(Available { version: current.into(), notes: String::new() });
    keep_notes(&a);
    a
}

/// 지금 버전의 변경 내역(업데이트 창이 새 버전이 없을 때 보여 주는 "마지막 업데이트 내역").
///
/// 보관해 둔 파일(`last-notes.json`)이 지금 버전 것이면 그것을, 아니면 업데이트 피드에서 가져와 보관한다. 네트워크를 쓸 수 있어 느릴 수 있다(최대 15초).
///
/// # 인자
/// - `current`: 지금 실행 중인 앱 버전 문자열
///
/// # 반환
/// `Available`(내역을 못 구하면 노트가 빈 문자열).
///
/// # 참조
/// `feed_notes`, `keep_notes` 호출. `main.rs` 의 `current_notes` 명령이 호출. 파일: `last-notes.json` 읽기.
pub fn current_notes(current: &str) -> Available {
    let kept = std::fs::read_to_string(last_notes_file()).ok().and_then(|s| serde_json::from_str::<Available>(&s).ok());
    if let Some(a) = kept {
        if a.version == current && !a.notes.is_empty() {
            return a;
        }
    }
    match feed_notes(current) {
        Some(a) => {
            keep_notes(&a);
            a
        }
        None => Available { version: current.into(), notes: String::new() },
    }
}

/// 지금 버전의 변경 내역을 보관하는 파일 경로(`update-notes.json` 과 달리 읽어도 지우지 않는다).
///
/// # 반환
/// `applog::dir` 의 상위 폴더 아래 `last-notes.json`.
fn last_notes_file() -> PathBuf {
    crate::applog::dir().with_file_name("last-notes.json")
}

/// 변경 내역을 `last-notes.json` 에 보관한다(노트가 비어 있으면 쓰지 않는다 — 다음에 피드에서 다시 구할 수 있게).
///
/// # 인자
/// - `a`: 보관할 버전·내역
///
/// # 참조
/// `installed_notes`, `current_notes` 가 호출. 파일: `last-notes.json` 쓰기.
fn keep_notes(a: &Available) {
    if a.notes.is_empty() {
        return;
    }
    let path = last_notes_file();
    let res = std::fs::create_dir_all(path.parent().unwrap_or(&path)).and_then(|_| std::fs::write(&path, serde_json::to_string(a).unwrap_or_default()));
    if let Err(e) = res {
        log::warn!("변경 내역 보관 실패: {e}");
    }
}

/// 업데이트 피드에서 지금 버전의 변경 내역을 가져온다.
///
/// 15초 제한으로 `FEED` 를 내려받아 JSON 을 해석하고, 피드의 `version`(앞의 `v` 제외)이 `current` 와 같을 때만 `notes` 를 담아 돌려준다.
///
/// # 인자
/// - `current`: 지금 실행 중인 앱 버전 문자열
///
/// # 반환
/// 피드 버전이 지금 버전이면 `Some`. 네트워크·해석 실패나 버전 불일치는 None.
///
/// # 참조
/// `FEED` 조회. `installed_notes` 가 호출.
fn feed_notes(current: &str) -> Option<Available> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).build().into();
    let body = agent.get(FEED).call().ok()?.body_mut().read_to_string().ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    (v.get("version")?.as_str()?.trim_start_matches('v') == current)
        .then(|| Available { version: current.into(), notes: v.get("notes").and_then(|n| n.as_str()).unwrap_or("").into() })
}

/// 설치 중인 버전의 변경 내역을 두는 파일 경로.
///
/// # 반환
/// `applog::dir` 의 상위 폴더 아래 `update-notes.json`.
///
/// # 참조
/// `save_notes`, `take_installed` 가 사용.
fn notes_file() -> PathBuf {
    crate::applog::dir().with_file_name("update-notes.json")
}

/// 설치할 버전의 변경 내역을 파일에 남긴다(다시 켜진 뒤 모달용).
///
/// 폴더를 만들고 `Available` 을 JSON 으로 쓴다. 실패하면 경고 로그만 남기고 넘어간다.
///
/// # 인자
/// - `a`: 저장할 버전·노트
///
/// # 참조
/// `notes_file`. `install` 이 호출. 파일: `update-notes.json` 쓰기.
fn save_notes(a: &Available) {
    let path = notes_file();
    let res = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|_| std::fs::write(&path, serde_json::to_string(a).unwrap_or_default()));
    if let Err(e) = res {
        log::warn!("업데이트 내역 저장 실패: {e}");
    }
}

/// 직전에 앱에서 설치한 업데이트의 변경 내역을 1회 꺼낸다.
///
/// `update-notes.json` 을 읽어 그 버전이 지금 버전과 같으면 파일을 지우고 내용을 돌려준다.
/// 설치가 실패해 옛 버전으로 켜졌으면 파일을 지우지 않고 둔다(다시 설치할 때 덮어씀).
///
/// # 인자
/// - `current`: 지금 실행 중인 앱 버전 문자열
///
/// # 반환
/// 버전이 일치하면 `Some(Available)`. 파일이 없거나 해석 실패, 버전 불일치는 None.
///
/// # 참조
/// `notes_file`. `installed_notes` 가 호출. 파일: `update-notes.json` 읽기·삭제.
fn take_installed(current: &str) -> Option<Available> {
    let path = notes_file();
    let a: Available = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    (a.version == current).then(|| {
        let _ = std::fs::remove_file(&path);
        a
    })
}
