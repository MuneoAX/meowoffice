//! 지난 대화 읽기 — Claude 기록(jsonl)과 Codex(app-server `thread/turns/list`)를 공통 형식(`HistPage`)으로.
//! 처음 열 때는 최신 1페이지만, 위로 올릴수록 `next_cursor` 로 더 과거를 읽는다. 본문은 앱이 따로 저장하지 않는다(원본은 각 서비스가 보관).
//! 규칙: 이 모듈은 대화 본문을 로그에 남기지 않는다(오류는 종류만).

use crate::appserver::AppServer;
use crate::local;
use crate::runner::{tool_summary, truncate_bytes, ErrCode, ToolKind};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 한 번에 거꾸로 읽는 기본 크기(256KB). 메시지가 모자라면 두 배씩 늘려 `MAX_READ` 까지.
const CHUNK: u64 = 256 * 1024;
/// 한 페이지에서 읽는 최대 바이트(2MB).
const MAX_READ: u64 = 2 * 1024 * 1024;
/// 이보다 긴 줄은 건너뜀(그림 base64 등).
const MAX_LINE: usize = 2 * 1024 * 1024;

/// 도구 항목 정보.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HistTool {
    pub kind: ToolKind,
    pub title: String,
    pub detail: String,
    pub ok: bool,
    /// 결과 앞 2KB.
    pub summary: String,
}

/// 지난 대화 항목 하나. `role` = "user" | "assistant" | "tool".
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HistItem {
    pub id: String,
    pub role: &'static str,
    pub text: String,
    pub tool: Option<HistTool>,
    pub at: Option<String>,
}

/// 한 페이지. `items` 는 오래된 것 → 최신, `next_cursor` 는 더 과거가 있을 때만.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HistPage {
    pub items: Vec<HistItem>,
    pub next_cursor: Option<String>,
}

/// 기록 머리에서 읽은 세션 정보.
pub struct ClaudeMeta {
    /// 작업 폴더.
    pub cwd: String,
    /// 제목(없으면 빈 값).
    pub title: String,
}

/// Claude 기록 파일 머리(앞 256KB)에서 작업 폴더·제목을 읽는다.
///
/// # 인자
/// - `path`: 기록 파일
///
/// # 반환
/// 작업 폴더를 찾으면 `Some`. 못 찾으면 None.
pub fn claude_meta(path: &Path) -> Option<ClaudeMeta> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; CHUNK as usize];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);
    let cwd = text.lines().filter(|l| l.contains("\"cwd\"")).find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string)
    })?;
    Some(ClaudeMeta { cwd, title: local::session_title(path).unwrap_or_default() })
}

/// 한 줄을 해석한 결과.
#[derive(Default)]
struct LineOut {
    items: Vec<(HistItem, String)>,
    /// (tool_use_id, 오류 여부, 결과 요약)
    results: Vec<(String, bool, String)>,
}

/// tool_result 내용(문자열 또는 text 블록 배열)에서 앞 2KB 를 뽑는다.
pub fn result_text(c: &Value) -> String {
    let t = match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    truncate_bytes(&t, 2048)
}

/// 기록 한 줄을 항목들로 바꾼다. 두 번째 값은 중복 판정 열쇠(message.id + 종류 + 내용).
fn parse_line(line: &[u8]) -> LineOut {
    let mut out = LineOut::default();
    if line.len() > MAX_LINE {
        return out;
    }
    let Ok(text) = std::str::from_utf8(line) else { return out };
    if !text.contains("\"type\":\"user\"") && !text.contains("\"type\":\"assistant\"") {
        return out;
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else { return out };
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return out;
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let uuid = v.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
    let at = v.get("timestamp").and_then(Value::as_str).map(str::to_string);
    let msg_id = v.pointer("/message/id").and_then(Value::as_str).unwrap_or("").to_string();
    let content = v.pointer("/message/content").cloned().unwrap_or(Value::Null);
    match kind {
        "user" => {
            let (mut images, mut blocks): (u32, Vec<Value>) = (0, vec![]);
            match &content {
                Value::String(_) => blocks.push(json!({"type": "text", "text": content})),
                Value::Array(a) => {
                    for b in a {
                        match b.get("type").and_then(Value::as_str) {
                            Some("text") => blocks.push(b.clone()),
                            Some("image") => images += 1,
                            Some("tool_result") => {
                                let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string();
                                let err = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                                out.results.push((id, err, result_text(b.get("content").unwrap_or(&Value::Null))));
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            let mut t = local::prompt_text(Value::Array(blocks)).unwrap_or_default();
            if images > 0 {
                if !t.is_empty() {
                    t.push('\n');
                }
                t.push_str(&crate::i18n::tf("chat.images", &[("n", &images.to_string())]));
            }
            if !t.is_empty() {
                let key = format!("{uuid}:user");
                out.items.push((HistItem { id: uuid, role: "user", text: t, tool: None, at }, key));
            }
        }
        "assistant" => {
            let Some(blocks) = content.as_array() else { return out };
            for (i, b) in blocks.iter().enumerate() {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let t = b.get("text").and_then(Value::as_str).unwrap_or("").trim();
                        if !t.is_empty() {
                            let key = format!("{msg_id}:text:{t}");
                            out.items.push((HistItem { id: format!("{uuid}:{i}"), role: "assistant", text: t.to_string(), tool: None, at: at.clone() }, key));
                        }
                    }
                    Some("tool_use") => {
                        let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                        let (kind, title, detail) = tool_summary(name, b.get("input").unwrap_or(&Value::Null));
                        let key = format!("{msg_id}:tool:{id}");
                        out.items.push((
                            HistItem { id, role: "tool", text: String::new(), tool: Some(HistTool { kind, title, detail, ok: true, summary: String::new() }), at: at.clone() },
                            key,
                        ));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// 세션 id 로 Claude 기록 한 페이지를 읽는다.
///
/// # 인자
/// - `claude_dir`: Claude 설정 폴더
/// - `id`: 세션 id
/// - `cursor`: 이전 페이지의 `next_cursor`(없으면 최신)
/// - `limit`: 메시지 수 목표(기본 40)
///
/// # 반환
/// 페이지. 기록 파일이 없으면 None.
pub fn claude_page(claude_dir: &Path, id: &str, cursor: Option<&str>, limit: usize) -> Option<HistPage> {
    claude_page_file(&local::find_transcript(claude_dir, id)?, cursor, limit)
}

/// Claude 기록 파일을 끝에서부터 거꾸로 읽어 한 페이지를 만든다.
///
/// 커서 = 이 페이지 첫 줄의 바이트 위치(그 앞이 더 과거). 처음 읽을 때 마지막 줄이 개행으로 끝나지 않으면(쓰는 중) 버린다.
/// 윈도(256KB 부터 두 배씩, 최대 2MB)의 앞쪽 잘린 줄도 버린다. `isSidechain`·`isMeta`·`thinking`·`attachment` 는 제외, 같은 message.id 의 같은 블록은 한 번만,
/// tool_result 는 같은 `tool_use_id` 의 도구 항목 결과로 붙인다(같은 페이지 안에서만).
///
/// # 인자
/// - `path`: 기록 파일
/// - `cursor`: 이전 페이지의 `next_cursor`
/// - `limit`: 메시지 수 목표(1~200)
///
/// # 반환
/// 페이지(항목은 오래된 → 최신). 파일을 못 열면 None. 잘못된 커서도 None.
pub fn claude_page_file(path: &Path, cursor: Option<&str>, limit: usize) -> Option<HistPage> {
    let limit = limit.clamp(1, 200);
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let end = match cursor {
        Some(c) => c.parse::<u64>().ok()?.min(len),
        None => len,
    };
    let mut window = CHUNK;
    loop {
        let lo = end.saturating_sub(window);
        let mut buf = vec![0u8; (end - lo) as usize];
        f.seek(SeekFrom::Start(lo)).ok()?;
        f.read_exact(&mut buf).ok()?;
        let mut base = lo;
        // 앞쪽 불완전 줄 제거
        if lo > 0 {
            match buf.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    buf.drain(..=i);
                    base += i as u64 + 1;
                }
                None => buf.clear(),
            }
        }
        // 처음 페이지의 끝 불완전 줄(쓰는 중) 제거
        if cursor.is_none() && !buf.is_empty() && buf.last() != Some(&b'\n') {
            match buf.iter().rposition(|&b| b == b'\n') {
                Some(i) => buf.truncate(i + 1),
                None => buf.clear(),
            }
        }
        let mut lines: Vec<(u64, &[u8])> = Vec::new();
        let mut start = 0usize;
        for (i, b) in buf.iter().enumerate() {
            if *b == b'\n' {
                lines.push((base + start as u64, &buf[start..i]));
                start = i + 1;
            }
        }
        // 최신 줄부터 해석해 목표 수가 차면 멈춤
        let mut collected: Vec<(u64, LineOut)> = Vec::new();
        let mut count = 0usize;
        for (off, l) in lines.iter().rev() {
            let out = parse_line(l);
            count += out.items.len();
            collected.push((*off, out));
            if count >= limit {
                break;
            }
        }
        if count < limit && lo > 0 && window < MAX_READ {
            window *= 2;
            continue;
        }
        let boundary = collected.last().map(|(o, _)| *o).unwrap_or(if lo > 0 { lo } else { 0 });
        // 오래된 → 최신 순으로 중복 제거 + 결과 연결
        let mut seen: HashSet<String> = HashSet::new();
        let mut items: Vec<HistItem> = Vec::new();
        let mut results: HashMap<String, (bool, String)> = HashMap::new();
        for (_, out) in collected.into_iter().rev() {
            for (item, key) in out.items {
                if seen.insert(key) {
                    items.push(item);
                }
            }
            for (id, err, sum) in out.results {
                results.insert(id, (err, sum));
            }
        }
        for it in items.iter_mut() {
            if let (Some(t), Some((err, sum))) = (it.tool.as_mut(), results.get(&it.id)) {
                t.ok = !err;
                t.summary = sum.clone();
            }
        }
        return Some(HistPage { items, next_cursor: (boundary > 0).then(|| boundary.to_string()) });
    }
}

// ── Codex ───────────────────────────────────────────────────────────────────

/// `thread/turns/list` 의 `data`(턴 목록, 최신 먼저)를 항목들로 바꾼다(오래된 → 최신).
///
/// userMessage·agentMessage·commandExecution·fileChange·mcpToolCall·webSearch 만 담고 reasoning·hookPrompt 등은 제외한다.
///
/// # 인자
/// - `turns`: 응답의 `data` 배열
pub fn codex_turns_to_items(turns: &Value) -> Vec<HistItem> {
    let mut out = Vec::new();
    let Some(arr) = turns.as_array() else { return out };
    for turn in arr.iter().rev() {
        let at = turn.get("startedAt").and_then(Value::as_i64).and_then(|s| chrono::DateTime::from_timestamp(s, 0)).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let Some(items) = turn.get("items").and_then(Value::as_array) else { continue };
        for it in items {
            let id = it.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let s = |k: &str| it.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let done = it.get("status").and_then(Value::as_str) == Some("completed");
            match it.get("type").and_then(Value::as_str).unwrap_or("") {
                "userMessage" => {
                    let parts = it.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
                    let mut t = parts.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("text")).filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
                    let images = parts.iter().filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("image" | "localImage"))).count();
                    if images > 0 {
                        if !t.is_empty() {
                            t.push('\n');
                        }
                        t.push_str(&crate::i18n::tf("chat.images", &[("n", &images.to_string())]));
                    }
                    if !t.trim().is_empty() {
                        out.push(HistItem { id, role: "user", text: t, tool: None, at: at.clone() });
                    }
                }
                "agentMessage" => {
                    let t = s("text");
                    if !t.trim().is_empty() {
                        out.push(HistItem { id, role: "assistant", text: t, tool: None, at: at.clone() });
                    }
                }
                "commandExecution" => {
                    let (_, title, detail) = tool_summary("Bash", &json!({ "command": s("command") }));
                    let summary = truncate_bytes(&s("aggregatedOutput"), 2048);
                    out.push(HistItem { id, role: "tool", text: String::new(), tool: Some(HistTool { kind: ToolKind::Command, title, detail, ok: done, summary }), at: at.clone() });
                }
                "fileChange" => {
                    let paths: Vec<String> = it.get("changes").and_then(Value::as_array).map(|c| c.iter().filter_map(|x| x.get("path").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default();
                    let names: Vec<String> = paths.iter().map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()).collect();
                    let title = if names.is_empty() { crate::i18n::t("chat.file_edit").to_string() } else { crate::runner::truncate(&names.join(", "), 80) };
                    out.push(HistItem {
                        id,
                        role: "tool",
                        text: String::new(),
                        tool: Some(HistTool { kind: ToolKind::File, title, detail: truncate_bytes(&paths.join("\n"), 2048), ok: done, summary: String::new() }),
                        at: at.clone(),
                    });
                }
                "mcpToolCall" => {
                    let title = format!("{}/{}", s("server"), s("tool"));
                    let detail = it.get("arguments").map(|a| truncate_bytes(&a.to_string(), 600)).unwrap_or_default();
                    let summary = it.pointer("/error/message").and_then(Value::as_str).map(|m| truncate_bytes(m, 2048)).unwrap_or_default();
                    out.push(HistItem { id, role: "tool", text: String::new(), tool: Some(HistTool { kind: ToolKind::Mcp, title, detail, ok: done, summary }), at: at.clone() });
                }
                "webSearch" => {
                    let q = s("query");
                    out.push(HistItem {
                        id,
                        role: "tool",
                        text: String::new(),
                        tool: Some(HistTool { kind: ToolKind::Web, title: crate::runner::truncate(&q, 80), detail: truncate_bytes(&q, 600), ok: true, summary: String::new() }),
                        at: at.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    out
}

/// Codex 스레드의 지난 대화 한 페이지(`thread/turns/list`, 스레드를 로드하지 않음).
///
/// # 인자
/// - `srv`: app-server
/// - `thread_id`: 스레드 id
/// - `cursor`: 이전 응답의 `nextCursor` 를 그대로 문자열로
/// - `limit`: 턴 수(기본 10)
///
/// # 반환
/// 페이지. RPC 실패는 `ErrCode::Rpc`(연결 끊김은 `AppServerExit`).
pub fn codex_page(srv: &AppServer, thread_id: &str, cursor: Option<&str>, limit: usize) -> Result<HistPage, ErrCode> {
    let mut params = json!({ "threadId": thread_id, "limit": limit.clamp(1, 50), "sortDirection": "desc", "itemsView": "full" });
    if let Some(c) = cursor {
        params["cursor"] = json!(c);
    }
    let r = srv.request("thread/turns/list", params, crate::appserver::REQUEST_TIMEOUT).map_err(|e| {
        log::warn!("Codex 지난 대화 읽기 실패: {}", e.log());
        match e {
            crate::appserver::RpcError::Closed => ErrCode::AppServerExit,
            _ => ErrCode::Rpc,
        }
    })?;
    Ok(HistPage { items: codex_turns_to_items(r.get("data").unwrap_or(&Value::Null)), next_cursor: r.get("nextCursor").and_then(Value::as_str).map(str::to_string) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("meow-chatlog-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn user(uuid: &str, text: &str) -> String {
        json!({"type": "user", "uuid": uuid, "timestamp": "2026-01-01T00:00:00Z", "message": {"role": "user", "content": text}}).to_string()
    }

    fn asst(uuid: &str, mid: &str, blocks: Value) -> String {
        json!({"type": "assistant", "uuid": uuid, "message": {"id": mid, "role": "assistant", "content": blocks}}).to_string()
    }

    fn write(path: &Path, lines: &[String], trailing_newline: bool) {
        let mut s = lines.join("\n");
        if trailing_newline {
            s.push('\n');
        }
        std::fs::write(path, s).unwrap();
    }

    #[test]
    fn dedup_sidechain_meta_and_tool_result() {
        let d = tmp("dedup");
        let f = d.join("s.jsonl");
        let lines = vec![
            user("u1", "안녕"),
            asst("a1", "m1", json!([{"type": "text", "text": "답변"}])),
            asst("a2", "m1", json!([{"type": "text", "text": "답변"}])), // 같은 message.id 중복
            asst("a3", "m2", json!([{"type": "thinking", "thinking": "비밀"}, {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}}])),
            json!({"type": "user", "uuid": "u2", "message": {"content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "file.txt", "is_error": false}]}}).to_string(),
            json!({"type": "user", "uuid": "u3", "isSidechain": true, "message": {"content": "하위"}}).to_string(),
            json!({"type": "user", "uuid": "u4", "isMeta": true, "message": {"content": "메타"}}).to_string(),
            user("u5", "<system-reminder>x</system-reminder>"),
            json!({"type": "attachment", "uuid": "x"}).to_string(),
            json!({"type": "user", "uuid": "u6", "message": {"content": [{"type": "text", "text": "그림 봐"}, {"type": "image", "source": {}}]}}).to_string(),
        ];
        write(&f, &lines, true);
        let p = claude_page_file(&f, None, 40).unwrap();
        assert_eq!(p.next_cursor, None);
        let roles: Vec<&str> = p.items.iter().map(|i| i.role).collect();
        assert_eq!(roles, vec!["user", "assistant", "tool", "user"]);
        assert_eq!(p.items[0].text, "안녕");
        assert_eq!(p.items[2].tool.as_ref().unwrap().summary, "file.txt");
        assert!(p.items[2].tool.as_ref().unwrap().ok);
        assert!(p.items[3].text.contains("[그림 1장]"));
        assert!(!p.items.iter().any(|i| i.text.contains("비밀") || i.text.contains("하위") || i.text.contains("메타")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn partial_last_line_and_empty_file() {
        let d = tmp("partial");
        let f = d.join("s.jsonl");
        let full = vec![user("u1", "첫째"), user("u2", "둘째")];
        let mut text = full.join("\n");
        text.push('\n');
        text.push_str(r#"{"type":"user","uuid":"u3","message":{"content":"쓰는 "#); // 개행 없이 끊김
        std::fs::write(&f, text).unwrap();
        let p = claude_page_file(&f, None, 40).unwrap();
        assert_eq!(p.items.len(), 2);
        std::fs::write(&f, "").unwrap();
        let p = claude_page_file(&f, None, 40).unwrap();
        assert!(p.items.is_empty() && p.next_cursor.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn oversized_line_is_skipped() {
        let d = tmp("big");
        let f = d.join("s.jsonl");
        let big = user("ub", &"x".repeat(MAX_LINE + 10));
        write(&f, &[user("u1", "앞"), big, user("u2", "뒤")], true);
        // 큰 줄은 한 페이지 윈도보다 길어 건너뛰고, 커서를 따라가면 앞쪽 줄까지 이어서 읽힌다.
        let (mut texts, mut cursor, mut pages): (Vec<String>, Option<String>, u32) = (vec![], None, 0);
        loop {
            let p = claude_page_file(&f, cursor.as_deref(), 40).unwrap();
            let mut t: Vec<String> = p.items.iter().map(|i| i.text.clone()).collect();
            t.extend(texts);
            texts = t;
            cursor = p.next_cursor;
            pages += 1;
            if cursor.is_none() || pages > 20 {
                break;
            }
        }
        assert_eq!(texts, vec!["앞".to_string(), "뒤".to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cursor_roundtrip_covers_everything_in_order() {
        let d = tmp("cursor");
        let f = d.join("s.jsonl");
        let lines: Vec<String> = (0..25).map(|i| user(&format!("u{i}"), &format!("메시지 {i}"))).collect();
        write(&f, &lines, true);
        let mut all: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let p = claude_page_file(&f, cursor.as_deref(), 4).unwrap();
            pages += 1;
            let mut texts: Vec<String> = p.items.iter().map(|i| i.text.clone()).collect();
            texts.extend(all);
            all = texts;
            cursor = p.next_cursor;
            if cursor.is_none() || pages > 50 {
                break;
            }
        }
        let want: Vec<String> = (0..25).map(|i| format!("메시지 {i}")).collect();
        assert_eq!(all, want);
        assert!(pages >= 6);
        assert!(claude_page_file(&f, Some("not-a-number"), 4).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn big_file_pages_backwards() {
        // 윈도(256KB)보다 큰 파일에서도 최신 페이지가 빠르게 나오고 커서로 더 과거를 읽는다.
        let d = tmp("bigfile");
        let f = d.join("s.jsonl");
        let lines: Vec<String> = (0..600).map(|i| user(&format!("u{i}"), &format!("{i}:{}", "가".repeat(900)))).collect();
        write(&f, &lines, true);
        let p = claude_page_file(&f, None, 40).unwrap();
        assert!(p.items.len() >= 40 && p.next_cursor.is_some());
        assert!(p.items.last().unwrap().text.starts_with("599:"));
        let p2 = claude_page_file(&f, p.next_cursor.as_deref(), 40).unwrap();
        assert!(p2.items.last().unwrap().text.starts_with(&format!("{}:", 599 - p.items.len())));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sparse_pages_still_advance_cursor() {
        // 메시지가 아닌 큰 줄(첨부 등)이 윈도를 채워 빈 페이지가 나와도 커서는 앞으로 가고, 끝까지 가면 모든 메시지를 한 번씩만 돌려준다.
        let d = tmp("sparse");
        let f = d.join("s.jsonl");
        let mut lines: Vec<String> = (0..3).map(|i| user(&format!("a{i}"), &format!("앞 {i}"))).collect();
        for i in 0..12 {
            lines.push(format!("{{\"type\":\"attachment\",\"uuid\":\"x{i}\",\"pad\":\"{}\"}}", "x".repeat(900_000)));
        }
        lines.extend((0..3).map(|i| user(&format!("b{i}"), &format!("뒤 {i}"))));
        write(&f, &lines, true);
        let (mut cursor, mut all, mut n): (Option<String>, Vec<String>, usize) = (None, vec![], 0);
        loop {
            let p = claude_page_file(&f, cursor.as_deref(), 40).unwrap();
            let mut t: Vec<String> = p.items.iter().map(|i| i.text.clone()).collect();
            t.extend(all);
            all = t;
            let nx = p.next_cursor;
            assert_ne!(nx, cursor, "같은 커서 반복");
            cursor = nx;
            n += 1;
            if cursor.is_none() || n > 30 {
                break;
            }
        }
        assert_eq!(all, vec!["앞 0", "앞 1", "앞 2", "뒤 0", "뒤 1", "뒤 2"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn codex_turns_convert() {
        let turns = json!([
            {"id": "t2", "startedAt": 1700000100, "items": [
                {"type": "userMessage", "id": "i3", "content": [{"type": "text", "text": "두번째 질문", "text_elements": []}]},
                {"type": "reasoning", "id": "i4", "summary": ["x"]},
                {"type": "agentMessage", "id": "i5", "text": "두번째 답"}
            ]},
            {"id": "t1", "startedAt": 1700000000, "items": [
                {"type": "userMessage", "id": "i1", "content": [{"type": "text", "text": "질문"}, {"type": "localImage", "path": "x.png"}]},
                {"type": "commandExecution", "id": "i2", "command": "ls -la", "cwd": "C:/x", "status": "completed", "aggregatedOutput": "out", "exitCode": 0, "commandActions": []},
                {"type": "fileChange", "id": "i6", "status": "failed", "changes": [{"path": "C:/x/a.rs", "kind": "add", "diff": ""}]},
                {"type": "mcpToolCall", "id": "i7", "server": "s", "tool": "t", "status": "completed", "arguments": {"a": 1}},
                {"type": "webSearch", "id": "i8", "query": "rust"},
                {"type": "hookPrompt", "id": "i9", "fragments": []}
            ]}
        ]);
        let items = codex_turns_to_items(&turns);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["i1", "i2", "i6", "i7", "i8", "i3", "i5"]);
        assert!(items[0].text.contains("[그림 1장]"));
        assert_eq!(items[1].tool.as_ref().unwrap().summary, "out");
        assert!(!items[2].tool.as_ref().unwrap().ok);
        assert_eq!(items[2].tool.as_ref().unwrap().title, "a.rs");
        assert!(items[0].at.is_some());
    }
}
