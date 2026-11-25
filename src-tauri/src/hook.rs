//! Claude Code 연동 훅 설치/제거 — <claude_dir>/settings.json 의 hooks.PreToolUse, PermissionRequest 와
//! 후속 이벤트(EVENTS: 터미널 등에서 처리된 요청 카드 닫기용)에 이 앱의 HTTP 훅을 추가/삭제한다. 다른 설정·훅은 그대로 두고(키 순서 보존), 최초 수정 전 백업.

use crate::permit;
use serde_json::{json, Map, Value};
use std::path::Path;

/// 훅 timeout(초).
///
/// `permit::WAIT` 보다 길어야 앱이 먼저 빈 응답으로 넘겨줄 수 있음.
///
/// # 참조
/// `apply` 가 PermissionRequest 훅에 사용.
const HOOK_TIMEOUT: u64 = 120;
/// 후속 이벤트 훅 timeout(초) — 앱이 즉시 응답하므로 짧게.
///
/// # 참조
/// `apply` 가 `EVENTS` 훅에 사용.
const EVENT_TIMEOUT: u64 = 5;
/// 후속 이벤트: 권한 요청 처리 감지(같은 세션의 도구 실행 완료·턴 종료·새 입력) +
/// 로컬 세션 알림(턴 종료 Stop·입력 대기 Notification → 카드, 새 입력·도구 실행 → 해소).
///
/// 값은 PostToolUse, Stop, UserPromptSubmit, Notification.
///
/// # 참조
/// `strip`, `apply` 가 사용.
const EVENTS: [&str; 4] = ["PostToolUse", "Stop", "UserPromptSubmit", "Notification"];

/// 예전 버전(컴퓨터 제어)이 등록했던 PreToolUse 훅 경로. 기능은 없어졌고, 남은 항목을 `strip` 이 지우도록 인식만 한다.
const LEGACY_COMPUTER_PATH: &str = "/muneo-computer-pretool";

/// 훅 항목이 이 앱이 등록한 것인지 판정한다.
///
/// 항목의 `url` 이 `permit::PATH`, `permit::EVENT_PATH` 또는 예전 컴퓨터 제어 훅 경로(`LEGACY_COMPUTER_PATH`)로 끝나면 이 앱의 훅이다.
///
/// # 인자
/// - `h`: settings.json 의 훅 항목 하나
///
/// # 반환
/// 이 앱의 훅이면 true.
///
/// # 참조
/// `strip`, `installed` 가 호출.
fn is_ours(h: &Value) -> bool {
    h.get("url")
        .and_then(Value::as_str)
        .is_some_and(|u| u.ends_with(permit::PATH) || u.ends_with(LEGACY_COMPUTER_PATH) || u.ends_with(permit::EVENT_PATH))
}

/// settings.json 을 읽는다.
///
/// 파일이 없거나 비어 있으면 빈 객체. 있으면 JSON 으로 해석한다.
///
/// # 인자
/// - `path`: settings.json 경로
///
/// # 반환
/// JSON 값. JSON 해석 실패나 NotFound 가 아닌 읽기 오류는 `Err`(문자열).
///
/// # 참조
/// `apply`, `installed` 가 호출. 파일: `settings.json` 읽기.
fn load(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).map_err(|e| format!("settings.json 파싱 실패: {e}")),
        Ok(_) => Ok(json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

/// settings.json 을 쓴다. 최초 수정 전 백업.
///
/// 백업 파일(`settings.json.muneo-bak`)이 아직 없고 원본이 있으면 먼저 복사한다(이미 있으면 덮어쓰지 않음).
/// 상위 폴더를 만들고 보기 좋게 직렬화한 내용을 줄바꿈과 함께 쓴다.
///
/// # 인자
/// - `path`: settings.json 경로
/// - `v`: 쓸 JSON
///
/// # 반환
/// 성공하면 `Ok(())`. 백업·폴더 생성·직렬화·쓰기 실패 시 `Err`(문자열).
///
/// # 참조
/// `apply` 가 호출. 파일: `settings.json`, `settings.json.muneo-bak`.
fn save(path: &Path, v: &Value) -> Result<(), String> {
    let bak = path.with_extension("json.muneo-bak");
    if path.exists() && !bak.exists() {
        std::fs::copy(path, &bak).map_err(|e| format!("백업 실패: {e}"))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| e.to_string())
}

/// 이 앱의 훅을 제거한다(빈 그룹·빈 배열·빈 hooks 객체 정리).
///
/// PreToolUse·PermissionRequest 와 `EVENTS` 이벤트의 각 그룹에서 `is_ours` 항목을 지우고, 비게 된 그룹·이벤트 배열·`hooks` 객체를 정리한다.
/// 다른 훅은 그대로 둔다.
///
/// # 인자
/// - `root`: settings.json 최상위 JSON(제자리 수정)
///
/// # 반환
/// 무언가 바뀌었으면 true.
///
/// # 참조
/// `is_ours` 호출. `apply` 가 호출.
fn strip(root: &mut Value) -> bool {
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    for event in ["PreToolUse", "PermissionRequest"].into_iter().chain(EVENTS) {
        let Some(groups) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = groups.clone();
        for g in groups.iter_mut() {
            if let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                list.retain(|h| !is_ours(h));
            }
        }
        groups.retain(|g| g.get("hooks").and_then(Value::as_array).map_or(true, |l| !l.is_empty()));
        changed |= *groups != before;
        if groups.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        root.as_object_mut().map(|o| o.remove("hooks"));
    }
    changed
}

/// settings.json 의 훅을 `enabled` 상태로 맞춘다. 이미 같은 설정이면 파일을 건드리지 않는다.
///
/// `<claude_dir>/settings.json` 을 읽고 먼저 이 앱의 훅을 모두 지운 뒤(`strip`), `enabled` 면 다시 추가한다:
/// PermissionRequest(권한 경로), `EVENTS` 각각(이벤트 경로).
/// 각 항목은 `http://127.0.0.1:<port><경로>` HTTP 훅이며 `x-muneo-token` 헤더를 가진다. 결과가 원본과 같으면 쓰지 않고 끝낸다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 디렉터리
/// - `enabled`: true 면 설치, false 면 제거
/// - `port`: 앱 로컬 서버 포트
/// - `token`: 검증 토큰(헤더로 전달, 로그에 남기지 않음)
///
/// # 반환
/// 성공하면 `Ok(())`. 파싱 실패, 최상위·`hooks`·이벤트 값이 예상한 형식이 아님, 백업·쓰기 실패 시 `Err`(문자열).
///
/// # 참조
/// `load`, `strip`, `save` 호출. 파일: `<claude_dir>/settings.json`.
pub fn apply(claude_dir: &Path, enabled: bool, port: u16, token: &str) -> Result<(), String> {
    let path = claude_dir.join("settings.json");
    let mut root = load(&path)?;
    if !root.is_object() {
        return Err("settings.json 최상위가 객체가 아님".into());
    }
    let original = root.clone();
    strip(&mut root);
    if enabled {
        let entry = |path: &str, timeout: u64| {
            json!({
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}{path}"),
                    "headers": { "x-muneo-token": token },
                    "timeout": timeout
                }]
            })
        };
        let obj = root.as_object_mut().unwrap();
        let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err("settings.json 의 hooks 가 객체가 아님".into());
        };
        let wanted = std::iter::once(("PermissionRequest", entry(permit::PATH, HOOK_TIMEOUT)))
            .chain(EVENTS.map(|e| (e, entry(permit::EVENT_PATH, EVENT_TIMEOUT))));
        for (event, e) in wanted {
            match hooks.entry(event).or_insert_with(|| Value::Array(vec![])).as_array_mut() {
                Some(a) => a.push(e),
                None => return Err(format!("settings.json 의 hooks.{event} 가 배열이 아님")),
            }
        }
    }
    if root == original {
        return Ok(());
    }
    save(&path, &root)
}

/// 현재 settings.json 에 이 앱의 훅이 있는지 확인한다(설정 화면 표시용).
///
/// PreToolUse 또는 PermissionRequest 그룹 중 하나라도 `is_ours` 항목이 있으면 true.
///
/// # 인자
/// - `claude_dir`: Claude 설정 디렉터리
///
/// # 반환
/// 설치돼 있으면 true. 읽기 실패나 파일 없음은 false.
///
/// # 참조
/// `load`, `is_ours` 호출. 파일: `<claude_dir>/settings.json` 읽기.
pub fn installed(claude_dir: &Path) -> bool {
    let Ok(root) = load(&claude_dir.join("settings.json")) else {
        return false;
    };
    ["PreToolUse", "PermissionRequest"].iter().any(|event| {
        root.pointer(&format!("/hooks/{event}"))
            .and_then(Value::as_array)
            .is_some_and(|gs| gs.iter().any(|g| g.get("hooks").and_then(Value::as_array).is_some_and(|l| l.iter().any(is_ours))))
    })
}

/// 훅 설치·제거가 다른 설정을 보존하는지 검증하는 시험 모음.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_and_remove_keeps_other_settings() {
        let dir = std::env::temp_dir().join(format!("muneo-hook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = r#"{"model":"opus","hooks":{"PermissionRequest":[{"matcher":"Bash","hooks":[{"type":"command","command":"x"}]}],"SessionStart":[]}}"#;
        std::fs::write(dir.join("settings.json"), original).unwrap();

        apply(&dir, true, 47821, "t").unwrap();
        assert!(installed(&dir));
        apply(&dir, true, 47821, "t").unwrap(); // 중복 설치 안 됨
        let v = load(&dir.join("settings.json")).unwrap();
        assert_eq!(v.pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(v.pointer("/hooks/Stop").unwrap().as_array().unwrap().len(), 1);

        apply(&dir, false, 47821, "t").unwrap();
        assert!(!installed(&dir));
        let v = load(&dir.join("settings.json")).unwrap();
        assert_eq!(v, serde_json::from_str::<Value>(original).unwrap());
        assert!(dir.join("settings.json.muneo-bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
