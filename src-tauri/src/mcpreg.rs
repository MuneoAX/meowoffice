//! 예전 버전(컴퓨터 제어)이 Claude Code 사용자 설정(.claude.json)에 등록한 MCP 서버 `muneo-computer` 정리.
//! 컴퓨터 제어 기능은 없어졌으므로 앱이 없는 주소를 가리키는 항목이 남으면 Claude Code 가 연결 실패를 보인다.
//! 앱 시작 때 한 번 `remove_legacy` 로 그 항목만 조용히 지운다(다른 MCP·키·순서는 그대로, 실패는 로그만).

use crate::config;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 예전에 등록하던 MCP 서버 이름.
const NAME: &str = "muneo-computer";
/// 예전 MCP 엔드포인트 경로(http://127.0.0.1:<포트>/mcp).
const LEGACY_PATH: &str = "/mcp";

/// .claude.json 위치: claude_dir 설정·CLAUDE_CONFIG_DIR 이 있으면 그 안, 아니면 ~/.claude.json(~/.claude 폴더 밖).
fn path(cfg: &config::Config) -> PathBuf {
    let custom = !cfg.claude_dir.trim().is_empty() || std::env::var("CLAUDE_CONFIG_DIR").is_ok_and(|d| !d.trim().is_empty());
    if custom {
        return config::claude_dir(cfg).join(".claude.json");
    }
    directories::BaseDirs::new().map(|b| b.home_dir().join(".claude.json")).unwrap_or_else(|| PathBuf::from(".claude.json"))
}

/// 이 앱이 등록한 항목인지 — http://127.0.0.1:<포트>/mcp 를 가리키면 우리 것(다른 이름·다른 주소의 MCP 는 건드리지 않음).
fn is_ours(v: &Value) -> bool {
    v.get("url").and_then(Value::as_str).is_some_and(|u| {
        u.strip_prefix("http://127.0.0.1:").and_then(|r| r.strip_suffix(LEGACY_PATH)).is_some_and(|port| port.parse::<u16>().is_ok())
    })
}

/// 앱 시작 때 호출: 예전 `muneo-computer` 항목이 있으면 지운다. 실패해도 시작을 막지 않고 로그만 남긴다.
pub fn remove_legacy(cfg: &config::Config) {
    match remove_at(&path(cfg)) {
        Ok(true) => log::info!("예전 컴퓨터 제어 MCP 항목({NAME})을 Claude Code 설정에서 제거함"),
        Ok(false) => {}
        Err(e) => log::warn!("예전 컴퓨터 제어 MCP 항목 정리 실패: {e}"),
    }
}

/// 항목이 있고 우리 것이면 지우고 true. 없거나 남의 것이면 false(파일은 건드리지 않음).
fn remove_at(path: &Path) -> Result<bool, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let mut root: Value = serde_json::from_str(&text).map_err(|e| format!(".claude.json 파싱 실패: {e}"))?;
    let ours = root.pointer(&format!("/mcpServers/{NAME}")).is_some_and(is_ours);
    if !ours {
        return Ok(false);
    }
    // Claude Code 가 기록 중이면 건드리지 않고 다음 시작에 다시 시도.
    let lock = path.with_extension("json.lock");
    if lock.exists() {
        return Err("Claude Code 가 .claude.json 을 수정 중이라 다음 시작 때 다시 시도함".into());
    }
    if let Some(m) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
        m.remove(NAME);
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp = path.with_file_name(format!(".claude.json.muneo-{}-{nonce}.tmp", std::process::id()));
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    // 쓰는 사이 Claude Code 가 파일을 바꿨으면(읽은 내용과 다름) 덮어쓰지 않는다.
    let unchanged = std::fs::read_to_string(path).is_ok_and(|now| serde_json::from_str::<Value>(&now).is_ok_and(|v| v == serde_json::from_str::<Value>(&text).unwrap_or(json!(null))));
    if !unchanged || lock.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err("저장 중 .claude.json 이 바뀌어 다음 시작 때 다시 시도함".into());
    }
    let bak = path.with_extension("json.muneo-bak");
    if !bak.exists() {
        std::fs::copy(path, &bak).map_err(|e| format!("백업 실패: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muneo-mcpreg-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(".claude.json")
    }

    #[test]
    fn removes_only_our_entry_and_keeps_others() {
        let file = temp("ours");
        std::fs::write(
            &file,
            r#"{"numStartups":3,"mcpServers":{"other":{"type":"stdio","command":"x"},"muneo-computer":{"type":"http","url":"http://127.0.0.1:47821/mcp","headers":{"x-muneo-token":"t"}}},"zeta":true}"#,
        )
        .unwrap();
        assert!(remove_at(&file).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(v.pointer("/mcpServers/muneo-computer").is_none());
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "x");
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["numStartups", "mcpServers", "zeta"]);
        assert!(!remove_at(&file).unwrap()); // 두 번째는 할 일 없음
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn leaves_foreign_entry_and_missing_file() {
        let file = temp("foreign");
        let original = r#"{"mcpServers":{"muneo-computer":{"type":"http","url":"https://example.com/mcp"}}}"#;
        std::fs::write(&file, original).unwrap();
        assert!(!remove_at(&file).unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        assert!(!remove_at(&file.with_file_name("none.json")).unwrap());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
