//! ChatGPT(Codex)·Antigravity 공식 훅 연동 — 설치/제거 + 응답 형식.
//! 두 서비스 모두 HTTP 훅이 없어 command 훅만 가능 → 이 앱 exe 의 `--hook <codex|agy> <이벤트>` 중계 모드(relay.rs)를 등록한다.
//! 쓰는 파일은 정확히 둘뿐: `~/.codex/hooks.json`(CODEX_HOME 우선), `~/.gemini/config/hooks.json`. 그 밖의 파일·키(notify 등)는 건드리지 않는다.
//! 정책은 hook.rs 와 같다: 사용자가 켤 때만 설치 · 최초 수정 전 백업(`hooks.json.muneo-bak`) · 기존 내용과 병합(키 순서 보존) ·
//! 끄면 우리 항목만 제거 · 임시 파일에 쓴 뒤 이름 바꾸기.
//! 훅 명령 문자열은 고정(포트·토큰은 중계 모드가 설정 파일에서 읽음) — Codex 의 신뢰(trust)가 명령 문자열에 묶이기 때문.

use crate::i18n;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// 권한 요청 훅 timeout(초).
///
/// `permit::WAIT`(110) 보다 길어야 앱이 먼저 빈 응답으로 넘겨줄 수 있음.
///
/// # 참조
/// `codex_entry`, `agy_entry`(PreToolUse)가 사용.
pub const HOOK_TIMEOUT: u64 = 120;
/// 응답 완료(Stop) 훅 timeout(초) — 앱이 즉시 응답.
///
/// # 참조
/// `agy_entry` 가 Stop 항목에 사용.
const STOP_TIMEOUT: u64 = 10;
/// Antigravity hooks.json 의 최상위 키(훅 이름).
///
/// # 참조
/// `strip_agy`, `agy_entry`, `apply`, `installed_command` 가 사용.
const AGY_NAME: &str = "meowffice";

/// 훅을 연동하는 외부 AI 서비스 종류.
///
/// # 참조
/// 설치(`apply`)·중계(`relay.rs`)·응답 형식 함수가 구분 기준으로 사용.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    /// ChatGPT Codex (설정·사무실 키 "chatgpt").
    Codex,
    /// Antigravity (키 "antigravity").
    Agy,
}

/// `Provider` 의 인자·키·훅 파일 위치 조회 메서드.
impl Provider {
    /// `--hook` 명령줄 인자로 쓰는 서비스 이름.
    ///
    /// # 반환
    /// Codex 는 "codex", Antigravity 는 "agy".
    ///
    /// # 참조
    /// `marker`, `command_line`, `dir` 이 사용. `Provider::from_arg` 의 역.
    pub fn arg(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Agy => "agy",
        }
    }
    /// 사무실·카드에서 쓰는 서비스 키.
    ///
    /// # 반환
    /// Codex 는 "chatgpt", Antigravity 는 "antigravity".
    pub fn key(self) -> &'static str {
        match self {
            Provider::Codex => "chatgpt",
            Provider::Agy => "antigravity",
        }
    }
    /// `--hook` 인자를 서비스로 해석한다.
    ///
    /// # 인자
    /// - `s`: 명령줄 인자 문자열
    ///
    /// # 반환
    /// "codex" → Codex, "agy" → Agy, 그 밖은 None.
    ///
    /// # 참조
    /// `relay::run` 이 호출.
    pub fn from_arg(s: &str) -> Option<Self> {
        match s {
            "codex" => Some(Provider::Codex),
            "agy" => Some(Provider::Agy),
            _ => None,
        }
    }
    /// 훅 명령 문자열 안에서 이 앱의 항목임을 알아보는 표식.
    ///
    /// # 반환
    /// `--hook <인자>` 문자열.
    ///
    /// # 참조
    /// `is_ours_command`, `agy_entry_ours` 가 사용.
    fn marker(self) -> String {
        format!("--hook {}", self.arg())
    }
    /// 서비스의 훅 파일이 있는 디렉터리.
    ///
    /// debug 빌드에서는 환경변수 MUNEO_PROVIDER_HOOK_DIR(시험용)이 비어 있지 않으면 그 아래 `<인자>` 폴더를 쓴다 — 실제 ~/.codex·~/.gemini 를 건드리지 않고 확인하려고.
    /// 그 밖에 Codex 는 `codex::codex_home()`(CODEX_HOME 우선), Antigravity 는 홈 아래 `.gemini/config`.
    ///
    /// # 반환
    /// 디렉터리 경로. 홈 등을 알 수 없으면 None.
    ///
    /// # 참조
    /// `codex::codex_home` 호출. `read_agy_config` 가 호출.
    pub fn dir(self) -> Option<PathBuf> {
        #[cfg(debug_assertions)]
        if let Some(d) = std::env::var_os("MUNEO_PROVIDER_HOOK_DIR").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(d).join(self.arg()));
        }
        match self {
            Provider::Codex => crate::codex::codex_home(),
            Provider::Agy => directories::BaseDirs::new().map(|b| b.home_dir().join(".gemini").join("config")),
        }
    }
}

/// 훅 명령줄에서 따옴표 없이 안전하지 않은 문자(공백·cmd 특수문자).
///
/// Codex·Antigravity 가 문자열을 `cmd /c` 로 넘기는 방식이 확인되지 않았고 표준 인자 이스케이프는 따옴표 경로를 깨뜨리므로,
/// Windows 에서는 이런 문자가 없는 경로만 등록한다.
///
/// # 참조
/// `has_unsafe` 가 사용.
const UNSAFE_CHARS: &[char] = &[' ', '&', '^', '%', '(', ')', '!', ';', ',', '=', '\''];

/// 경로에 `UNSAFE_CHARS` 가 하나라도 들어 있는지 확인한다.
///
/// # 인자
/// - `path`: 검사할 exe 경로
///
/// # 반환
/// 위험 문자가 있으면 true.
///
/// # 참조
/// `hook_exe_with` 가 호출.
fn has_unsafe(path: &str) -> bool {
    path.contains(UNSAFE_CHARS)
}

/// 훅에 등록할 exe 경로를 정한다(순수 함수).
///
/// 위험 문자가 없으면 그대로 쓴다. 있으면 `resolve`(8.3 짧은 경로)로 바꾼 값을 쓰되,
/// 짧은 경로를 못 얻거나 비어 있거나 여전히 위험 문자가 있으면 오류를 낸다(연동을 켜지 않음).
///
/// # 인자
/// - `path`: 이 앱 exe 경로
/// - `resolve`: 짧은 경로로 바꾸는 함수(실패 시 None)
///
/// # 반환
/// 등록할 경로. 위험 문자를 없앨 수 없으면 설치 폴더를 옮기라는 안내가 담긴 `Err`.
///
/// # 참조
/// `has_unsafe` 호출. `hook_exe` 와 시험이 호출.
pub fn hook_exe_with(path: &str, resolve: impl Fn(&str) -> Option<String>) -> Result<String, String> {
    if !has_unsafe(path) {
        return Ok(path.to_string());
    }
    match resolve(path) {
        Some(s) if !s.is_empty() && !has_unsafe(&s) => Ok(s),
        _ => Err(i18n::tf("hookfile.unsafe_path", &[("path", path)])),
    }
}

/// 이 PC 에서 훅에 쓸 exe 경로를 정한다.
///
/// Windows 는 `hook_exe_with` 로 위험 문자가 있으면 짧은 경로로 바꾸고, 그 외 OS 는 그대로 쓴다(공백은 `command_line` 이 따옴표로 감쌈).
///
/// # 인자
/// - `path`: 이 앱 exe 경로
///
/// # 반환
/// 등록할 경로. Windows 에서 안전한 경로를 얻지 못하면 `Err`(문자열).
///
/// # 참조
/// `hook_exe_with`, `short_path`(Windows) 호출.
pub fn hook_exe(path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        hook_exe_with(path, short_path)
    }
    #[cfg(not(windows))]
    {
        Ok(path.to_string())
    }
}

/// Windows 8.3 짧은 경로를 구한다.
///
/// `\\?\` 접두를 떼고 `GetShortPathNameW`(버퍼 1024 글자)를 호출한다.
///
/// # 인자
/// - `path`: 원래 경로
///
/// # 반환
/// 짧은 경로. 호출 실패이거나 버퍼에 담기지 않으면 None.
///
/// # 참조
/// `hook_exe` 가 `hook_exe_with` 의 `resolve` 로 넘긴다.
#[cfg(windows)]
fn short_path(path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let p = path.strip_prefix(r"\\?\").unwrap_or(path);
    let wide: Vec<u16> = std::ffi::OsStr::new(p).encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: wide 는 NUL 로 끝나는 유효한 버퍼, buf 는 길이를 함께 넘김.
    let n = unsafe { windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    (n > 0 && n < buf.len()).then(|| String::from_utf16_lossy(&buf[..n]))
}

/// 훅 명령 문자열을 만든다.
///
/// Windows 는 `hook_exe` 로 안전한 경로만 들어오므로 따옴표 없이 쓰고, 경로에 공백이 남는 경우(비 Windows)만 따옴표로 감싼다.
/// 형식은 `<exe> --hook <서비스> <이벤트>`. 포트·토큰은 넣지 않는다(중계 모드가 설정 파일에서 읽음).
///
/// # 인자
/// - `exe`: 훅에 쓸 exe 경로(`hook_exe` 결과)
/// - `p`: 서비스
/// - `event`: 이벤트 인자 문자열("permission", "pretool", "stop")
///
/// # 반환
/// 명령 문자열.
///
/// # 참조
/// `codex_entry`, `agy_entry`, `apply` 가 사용.
pub fn command_line(exe: &str, p: Provider, event: &str) -> String {
    let quoted = if exe.contains(' ') { format!("\"{exe}\"") } else { exe.to_string() };
    format!("{quoted} --hook {} {event}", p.arg())
}

/// 훅 파일 경로를 구한다.
///
/// # 인자
/// - `dir`: `Provider::dir` 결과
///
/// # 반환
/// `<dir>/hooks.json`.
fn file_of(dir: &Path) -> PathBuf {
    dir.join("hooks.json")
}

/// hooks.json 을 읽는다.
///
/// 파일이 없거나 비어 있으면 빈 객체. 있으면 JSON 으로 해석한다.
///
/// # 인자
/// - `path`: hooks.json 경로
///
/// # 반환
/// JSON 값. 해석 실패나 NotFound 가 아닌 읽기 오류는 `Err`(문자열).
///
/// # 참조
/// `apply`, `installed_command` 가 호출. 파일: `hooks.json` 읽기.
fn load(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).map_err(|e| i18n::tf("hookfile.parse", &[("file", "hooks.json"), ("e", &e.to_string())])),
        Ok(_) => Ok(json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

/// hooks.json 을 쓴다. 백업(최초 1회) 후 임시 파일에 쓰고 이름을 바꾼다.
///
/// 원본이 있고 `hooks.json.muneo-bak` 이 아직 없으면 먼저 복사한다. 상위 폴더를 만들고, 프로세스 id·시각이 든 임시 파일에 쓰고 `sync_all` 한 뒤
/// `rename` 으로 교체한다. 쓰기나 교체에 실패하면 임시 파일을 지운다.
///
/// # 인자
/// - `path`: hooks.json 경로
/// - `v`: 쓸 JSON
///
/// # 반환
/// 성공하면 `Ok(())`. 백업·폴더 생성·직렬화·쓰기·이름 바꾸기 실패 시 `Err`(문자열).
///
/// # 참조
/// `apply` 가 호출. 파일: `hooks.json`, `hooks.json.muneo-bak`, `hooks.json.muneo-tmp-*`.
fn save(path: &Path, v: &Value) -> Result<(), String> {
    let bak = path.with_extension("json.muneo-bak");
    if path.exists() && !bak.exists() {
        std::fs::copy(path, &bak).map_err(|e| i18n::tf("hookfile.backup", &[("e", &e.to_string())]))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = path.with_extension(format!("json.muneo-tmp-{}-{nanos}", std::process::id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// 명령이 이 앱의 것인지 판정한다.
///
/// 명령에서 `--hook <서비스>` 표식 앞부분을 잘라 실행 파일 이름(따옴표·경로 제거, 소문자)을 구하고, 그 이름이 "muneo" 로 시작하고 ".exe" 로 끝나는지 본다
/// (8.3 짧은 이름 MUNEO-~1.EXE 포함).
///
/// # 인자
/// - `c`: 훅 명령 문자열
/// - `p`: 서비스
///
/// # 반환
/// 이 앱의 명령이면 true. 표식이 없으면 false.
///
/// # 참조
/// `Provider::marker` 사용. `is_ours_handler` 가 호출.
fn is_ours_command(c: &str, p: Provider) -> bool {
    let Some((head, _)) = c.split_once(&p.marker()) else { return false };
    let name = head.trim().trim_matches('"').rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase();
    name.starts_with("muneo") && name.ends_with(".exe")
}

/// 훅 핸들러가 이 앱의 것인지 판정한다.
///
/// 핸들러의 `command` 또는 `commandWindows` 문자열 중 하나라도 `is_ours_command` 이면 true.
///
/// # 인자
/// - `h`: hooks.json 의 핸들러 JSON
/// - `p`: 서비스
///
/// # 반환
/// 이 앱의 핸들러이면 true.
///
/// # 참조
/// `strip_codex`, `codex_ours_count`, `installed_command` 가 호출.
fn is_ours_handler(h: &Value, p: Provider) -> bool {
    ["command", "commandWindows"].iter().any(|k| h.get(k).and_then(Value::as_str).is_some_and(|c| is_ours_command(c, p)))
}

/// Codex hooks.json 에서 이 앱의 항목을 제거한다(빈 그룹·배열·hooks 객체 정리).
///
/// 모든 이벤트 그룹에서 이 앱의 핸들러만 지운다. 지워서 비게 된 그룹만 없애고(원래 비어 있던 그룹·배열은 그대로),
/// 지워서 비게 된 이벤트 배열과 `hooks` 객체를 정리한다.
///
/// # 인자
/// - `root`: hooks.json 최상위 JSON(제자리 수정)
///
/// # 참조
/// `is_ours_handler` 호출. `apply` 가 호출.
fn strip_codex(root: &mut Value) {
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    let events: Vec<String> = hooks.keys().cloned().collect();
    let mut any_removed = false;
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else { continue };
        // 우리 항목만 지우고, 그래서 비게 된 그룹만 정리(원래 비어 있던 그룹·배열은 그대로).
        let mut emptied = Vec::with_capacity(groups.len());
        let mut removed = false;
        for g in groups.iter_mut() {
            let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) else {
                emptied.push(false);
                continue;
            };
            let n = list.len();
            list.retain(|h| !is_ours_handler(h, Provider::Codex));
            removed |= list.len() != n;
            emptied.push(list.len() != n && list.is_empty());
        }
        let mut i = 0;
        groups.retain(|_| {
            i += 1;
            !emptied[i - 1]
        });
        any_removed |= removed;
        if removed && groups.is_empty() {
            hooks.remove(&event);
        }
    }
    // 우리가 항목을 지워서 비게 된 hooks 만 정리(원래 있던 빈 "hooks": {} 는 그대로)
    if any_removed && hooks.is_empty() {
        root.as_object_mut().map(|o| o.remove("hooks"));
    }
}

/// Antigravity 훅 항목이 이 앱의 것인지 판정한다.
///
/// 값 안의 문자열(배열·객체를 재귀로 훑음) 중 하나라도 `--hook agy` 표식을 포함하면 우리 것이다.
///
/// # 인자
/// - `v`: 최상위 `AGY_NAME` 키의 값
///
/// # 반환
/// 이 앱의 항목이면 true.
///
/// # 참조
/// `strip_agy`, `apply`, `installed_command` 가 호출.
fn agy_entry_ours(v: &Value) -> bool {
    /// JSON 값 안에 표식 문자열 `m` 이 들어 있는 문자열이 있는지 재귀로 찾는다.
    ///
    /// # 인자
    /// - `v`: 훑을 JSON 값
    /// - `m`: 찾을 표식
    ///
    /// # 반환
    /// 포함하는 문자열이 있으면 true.
    fn walk(v: &Value, m: &str) -> bool {
        match v {
            Value::String(s) => s.contains(m),
            Value::Array(a) => a.iter().any(|x| walk(x, m)),
            Value::Object(o) => o.values().any(|x| walk(x, m)),
            _ => false,
        }
    }
    walk(v, &Provider::Agy.marker())
}

/// Antigravity hooks.json 에서 이 앱의 항목을 제거한다. 남의 것이면 건드리지 않는다.
///
/// 최상위 `AGY_NAME` 키의 값이 우리 것(`agy_entry_ours`)일 때만 그 키를 지운다.
///
/// # 인자
/// - `root`: hooks.json 최상위 JSON(제자리 수정)
///
/// # 참조
/// `apply` 가 호출.
fn strip_agy(root: &mut Value) {
    if root.get(AGY_NAME).is_some_and(agy_entry_ours) {
        root.as_object_mut().map(|o| o.remove(AGY_NAME));
    }
}

/// Codex PermissionRequest 훅 그룹 JSON 을 만든다.
///
/// `command` 와 `commandWindows` 에 같은 명령(`permission` 이벤트)을 넣고 timeout 은 `HOOK_TIMEOUT`, 상태 메시지를 붙인다.
///
/// # 인자
/// - `exe`: 훅에 쓸 exe 경로
/// - `event`: 이벤트 인자 문자열
///
/// # 반환
/// `{"hooks":[{...}]}` 형태의 JSON.
///
/// # 참조
/// `command_line` 호출. `apply` 가 호출.
fn codex_entry(exe: &str, event: &str) -> Value {
    let c = command_line(exe, Provider::Codex, event);
    json!({ "hooks": [{ "type": "command", "command": c, "commandWindows": c, "timeout": HOOK_TIMEOUT, "statusMessage": i18n::t("hook.status_message") }] })
}

/// Antigravity 훅 객체(최상위 `AGY_NAME` 키의 값)를 만든다.
///
/// pretool 이 true 면 `run_command` 매처의 PreToolUse(권한 카드, timeout `HOOK_TIMEOUT`) 항목을 넣고, Stop(timeout `STOP_TIMEOUT`) 항목은 항상 넣는다.
///
/// # 인자
/// - `exe`: 훅에 쓸 exe 경로
/// - `pretool`: PreToolUse(권한 카드) 항목도 넣을지
///
/// # 반환
/// JSON 객체.
///
/// # 참조
/// `command_line` 호출. `apply` 가 호출.
fn agy_entry(exe: &str, pretool: bool) -> Value {
    let cmd = |event: &str, timeout: u64| json!({ "type": "command", "command": command_line(exe, Provider::Agy, event), "timeout": timeout });
    let mut o = Map::new();
    if pretool {
        o.insert("PreToolUse".into(), json!([{ "matcher": "run_command", "hooks": [cmd("pretool", HOOK_TIMEOUT)] }]));
    }
    o.insert("Stop".into(), json!([cmd("stop", STOP_TIMEOUT)]));
    Value::Object(o)
}

/// Codex hooks.json 안의 이 앱 핸들러 개수를 센다.
///
/// 모든 이벤트의 모든 그룹을 훑어 `is_ours_handler` 인 핸들러를 센다. 그중 `command`·`commandWindows` 가 모두 `want` 와 같은 것도 센다.
///
/// # 인자
/// - `root`: hooks.json JSON
/// - `want`: 지금 등록하려는 명령 문자열
///
/// # 반환
/// (우리 핸들러 전체 개수, 원하는 명령과 같은 개수).
///
/// # 참조
/// `apply` 가 이미 같은 설정인지(1, 1) 확인하는 데 사용.
fn codex_ours_count(root: &Value, want: &str) -> (usize, usize) {
    let mut total = 0;
    let mut same = 0;
    let groups = root.get("hooks").and_then(Value::as_object).into_iter().flat_map(|o| o.values()).filter_map(Value::as_array).flatten();
    for h in groups.filter_map(|g| g.get("hooks")?.as_array()).flatten() {
        if is_ours_handler(h, Provider::Codex) {
            total += 1;
            let eq = |k: &str| h.get(k).and_then(Value::as_str) == Some(want);
            if eq("command") && eq("commandWindows") {
                same += 1;
            }
        }
    }
    (total, same)
}

/// 서비스의 훅 파일을 `enabled` 상태로 맞춘다. 이미 같은 설정이면 파일을 건드리지 않는다.
///
/// `<dir>/hooks.json` 을 읽는다. Codex: 이미 같은 명령 하나만 등록돼 있으면 그대로 끝내고, 아니면 우리 항목을 지운 뒤 `enabled` 면 `hooks.PermissionRequest` 에 항목을 추가한다.
/// Antigravity: 최상위 `meowffice` 키에 남의 훅이 있으면 오류로 건드리지 않고, 아니면 우리 항목을 지운 뒤 `enabled` 면 새로 넣는다.
/// 결과가 원본과 같으면 쓰지 않는다. 파일이 없는 채로 끄는 경우에도 만들지 않는다.
///
/// # 인자
/// - `dir`: 훅 파일 디렉터리(`Provider::dir`)
/// - `p`: 서비스
/// - `enabled`: true 면 설치, false 면 제거
/// - `exe`: 훅에 쓸 이 앱 exe 경로(`hook_exe` 결과)
/// - `agy_card`: Antigravity PreToolUse(권한 카드) 항목을 둘지(= `agy_policy` 가 Card). 아니면 Stop 항목만 둠. Codex 는 무시
///
/// # 반환
/// 성공하면 `Ok(())`. 파싱 실패, 최상위·`hooks`·`hooks.PermissionRequest` 가 예상한 형식이 아님, Antigravity 의 같은 이름 남의 훅, 백업·쓰기 실패 시 `Err`(문자열).
///
/// # 참조
/// `load`, `strip_codex`, `strip_agy`, `codex_ours_count`, `codex_entry`, `agy_entry`, `save` 호출. 파일: `hooks.json`.
pub fn apply(dir: &Path, p: Provider, enabled: bool, exe: &str, agy_card: bool) -> Result<(), String> {
    let path = file_of(dir);
    let mut root = load(&path)?;
    if !root.is_object() {
        return Err(i18n::tf("hookfile.not_object", &[("file", "hooks.json")]));
    }
    let original = root.clone();
    match p {
        Provider::Codex => {
            if enabled && codex_ours_count(&root, &command_line(exe, p, "permission")) == (1, 1) {
                return Ok(()); // 이미 같은 명령 하나만 등록됨 — 파일을 다시 쓰지 않음(순서 보존)
            }
            strip_codex(&mut root);
            if enabled {
                let obj = root.as_object_mut().unwrap();
                let Some(hooks) = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new())).as_object_mut() else {
                    return Err(i18n::tf("hookfile.hooks_not_object", &[("file", "hooks.json")]));
                };
                match hooks.entry("PermissionRequest").or_insert_with(|| Value::Array(vec![])).as_array_mut() {
                    Some(a) => a.push(codex_entry(exe, "permission")),
                    None => return Err(i18n::tf("hookfile.event_not_array", &[("file", "hooks.json"), ("path", "hooks.PermissionRequest")])),
                }
            }
        }
        Provider::Agy => {
            if enabled && root.get(AGY_NAME).is_some_and(|v| !agy_entry_ours(v)) {
                return Err(i18n::tf("hookfile.agy_exists", &[("name", AGY_NAME)]));
            }
            strip_agy(&mut root);
            if enabled {
                root.as_object_mut().unwrap().insert(AGY_NAME.into(), agy_entry(exe, agy_card));
            }
        }
    }
    if root == original {
        return Ok(());
    }
    // 파일이 없는데 끄는 경우엔 만들지 않음(위에서 root == original 로 이미 반환).
    save(&path, &root)
}

/// 현재 hooks.json 에 등록된 이 앱의 명령을 꺼낸다(설정 화면의 설치 상태·경로 변경 감지용).
///
/// Codex: 첫 번째 우리 핸들러의 명령(Windows 는 `commandWindows`, 그 외는 `command`). Antigravity: 우리 항목의 `Stop[0].command`.
///
/// # 인자
/// - `dir`: 훅 파일 디렉터리
/// - `p`: 서비스
///
/// # 반환
/// 등록된 명령 문자열. 파일을 읽지 못하거나 우리 항목이 없으면 None.
///
/// # 참조
/// `load`, `is_ours_handler`, `agy_entry_ours` 호출. 파일: `hooks.json` 읽기.
pub fn installed_command(dir: &Path, p: Provider) -> Option<String> {
    let root = load(&file_of(dir)).ok()?;
    match p {
        Provider::Codex => root.get("hooks")?.as_object()?.values().filter_map(Value::as_array).flatten().filter_map(|g| g.get("hooks")?.as_array()).flatten().find_map(|h| {
            is_ours_handler(h, p).then(|| h.get(if cfg!(windows) { "commandWindows" } else { "command" }).or_else(|| h.get("command")).and_then(Value::as_str).unwrap_or("").to_string())
        }),
        Provider::Agy => {
            let e = root.get(AGY_NAME).filter(|v| agy_entry_ours(v))?;
            e.pointer("/Stop/0/command").and_then(Value::as_str).map(str::to_string)
        }
    }
}

// ── 응답 형식(relay.rs 와 permit.rs 가 공유) ──────────────────────────────────

/// 훅 이벤트 종류.
///
/// # 참조
/// `relay.rs`, `permit.rs` 가 응답 형식을 맞추는 데 공유한다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Event {
    /// Codex PermissionRequest.
    Permission,
    /// Antigravity PreToolUse.
    PreTool,
    /// Antigravity Stop.
    Stop,
}

/// `Event` 의 인자 변환 메서드.
impl Event {
    /// 이벤트의 `--hook` 명령줄 인자 문자열.
    ///
    /// # 반환
    /// "permission" · "pretool" · "stop".
    pub fn arg(self) -> &'static str {
        match self {
            Event::Permission => "permission",
            Event::PreTool => "pretool",
            Event::Stop => "stop",
        }
    }
    /// 서비스와 인자 문자열을 이벤트로 해석한다.
    ///
    /// # 인자
    /// - `p`: 서비스
    /// - `s`: 이벤트 인자 문자열
    ///
    /// # 반환
    /// (Codex, "permission") → Permission, (Agy, "pretool") → PreTool, (Agy, "stop") → Stop. 그 밖의 조합은 None.
    ///
    /// # 참조
    /// `relay::run` 이 호출.
    pub fn from_arg(p: Provider, s: &str) -> Option<Self> {
        match (p, s) {
            (Provider::Codex, "permission") => Some(Event::Permission),
            (Provider::Agy, "pretool") => Some(Event::PreTool),
            (Provider::Agy, "stop") => Some(Event::Stop),
            _ => None,
        }
    }
}

/// 앱에 닿지 않을 때 서비스에 돌려줄 중립 응답(실패 시 열림): 서비스가 원래 하던 대로 진행·질문하게 함.
/// Codex 권한 요청: 출력 없음 → Codex 자체 승인창. Antigravity PreToolUse: ask. Stop: 계속 막지 않는 `{}`.
///
/// # 인자
/// - `p`: 서비스
/// - `e`: 이벤트
///
/// # 반환
/// 출력할 문자열(Codex 권한 요청은 빈 문자열, Antigravity PreToolUse 는 `{"decision":"ask"}`, 그 밖은 `{}`).
///
/// # 참조
/// `relay::relay` 가 호출.
pub fn fail_open(p: Provider, e: Event) -> &'static str {
    match (p, e) {
        (Provider::Codex, Event::Permission) => "",
        (Provider::Agy, Event::PreTool) => r#"{"decision":"ask"}"#,
        _ => "{}",
    }
}

/// 권한 요청을 수락하는 응답 본문을 만든다.
///
/// Codex 는 `hookSpecificOutput.decision.behavior = "allow"` 형식, 그 밖은 `{"decision":"allow"}`.
///
/// # 인자
/// - `p`: 서비스
/// - `e`: 이벤트(Codex 는 무시)
///
/// # 반환
/// JSON 문자열.
///
/// # 참조
/// 시험(`relay.rs`)이 호출. 응답 형식은 `permit.rs` 와 공유.
pub fn allow_body(p: Provider, e: Event) -> String {
    match (p, e) {
        (Provider::Codex, _) => json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }).to_string(),
        _ => json!({ "decision": "allow" }).to_string(),
    }
}

/// 권한 요청을 거절하는 응답 본문을 만든다.
///
/// Codex 는 `hookSpecificOutput.decision.behavior = "deny"` 와 `message`, 그 밖은 `{"decision":"deny","reason":...}`.
///
/// # 인자
/// - `p`: 서비스
/// - `e`: 이벤트(Codex 는 무시)
/// - `message`: 거절 사유 문구
///
/// # 반환
/// JSON 문자열.
///
/// # 참조
/// 응답 형식은 `permit.rs` 와 공유.
pub fn deny_body(p: Provider, e: Event, message: &str) -> String {
    match (p, e) {
        (Provider::Codex, _) => json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": message } } }).to_string(),
        _ => json!({ "decision": "deny", "reason": message }).to_string(),
    }
}

// ── Antigravity: 우리 카드를 띄울지 ─────────────────────────────────────────

/// Antigravity PreToolUse(run_command)에서 우리 카드를 띄울지에 대한 정책.
///
/// # 참조
/// `agy_policy` 가 판정. `main.rs`·`permit.rs` 가 사용.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgyPolicy {
    /// Antigravity 가 자기 창에서 물었을 요청 → 우리 카드.
    Card,
    /// Antigravity 가 묻지 않고 실행하는 설정(Turbo) → PreToolUse 훅을 등록하지 않음.
    Allow,
    /// 샌드박스 안에서 알아서 실행되는 설정 → PreToolUse 훅을 등록하지 않음.
    Pass,
}

/// Antigravity 설정(`~/.gemini/config/config.json` 의 userSettings, 읽기 전용)으로 카드 정책을 판단한다.
/// Turbo → Allow · 항상 확인(Request Review) → Card · Default/Auto → 터미널 샌드박스가 꺼져 있을 때만 Card · 읽지 못하면 Card.
///
/// `permissionPreset`·`autoExecutionPolicy` 를 대문자로 바꿔 TURBO(또는 `_EAGER` 로 끝남)면 Allow, REQUEST_REVIEW·OFF 면 Card 로 한다.
/// 그 밖에는 `enableTerminalSandbox` 가 true 면 Pass, 아니면 Card.
///
/// # 인자
/// - `config`: `read_agy_config` 결과(None 이거나 userSettings 가 없으면 Card)
///
/// # 반환
/// `AgyPolicy`.
///
/// # 참조
/// `main.rs`, `permit.rs` 가 `read_agy_config` 결과와 함께 호출.
pub fn agy_policy(config: Option<&Value>) -> AgyPolicy {
    let Some(us) = config.and_then(|c| c.get("userSettings")) else { return AgyPolicy::Card };
    let preset = us.get("permissionPreset").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    let exec = us.get("autoExecutionPolicy").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    if preset.contains("TURBO") || exec.contains("TURBO") || exec.ends_with("_EAGER") {
        return AgyPolicy::Allow;
    }
    if preset.contains("REQUEST_REVIEW") || exec.contains("OFF") {
        return AgyPolicy::Card;
    }
    if us.get("enableTerminalSandbox").and_then(Value::as_bool).unwrap_or(false) {
        AgyPolicy::Pass
    } else {
        AgyPolicy::Card
    }
}

/// Antigravity 설정 파일을 읽는다.
///
/// # 반환
/// `<Antigravity 디렉터리>/config.json` 의 JSON. 경로를 모르거나 파일이 없거나 깨지면 None.
///
/// # 참조
/// `Provider::Agy.dir()` 호출. 파일: `config.json` 읽기 전용.
pub fn read_agy_config() -> Option<Value> {
    let path = Provider::Agy.dir()?.join("config.json");
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// 훅 병합·제거·백업과 정책·응답 형식을 검증하는 시험 모음.
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("muneo-phook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const EXE: &str = r"C:\Apps\Meowoffice\muneo-claude-usage-tray.exe";

    #[test]
    fn codex_merge_remove_backup() {
        let dir = tmp("codex");
        let original = r#"{"description":"mine","hooks":{"PermissionRequest":[{"matcher":"Bash","hooks":[{"type":"command","command":"x"}]}],"Stop":[{"hooks":[{"type":"command","command":"y"}]}]},"other":1}"#;
        std::fs::write(dir.join("hooks.json"), original).unwrap();
        apply(&dir, Provider::Codex, true, EXE, true).unwrap();
        let v = load(&dir.join("hooks.json")).unwrap();
        let pr = v.pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap();
        assert_eq!(pr.len(), 2);
        assert_eq!(pr[0]["matcher"], "Bash");
        assert!(pr[1]["hooks"][0]["command"].as_str().unwrap().contains("--hook codex permission"));
        assert_eq!(pr[1]["hooks"][0]["timeout"], HOOK_TIMEOUT);
        assert_eq!(v["description"], "mine");
        assert_eq!(v["other"], 1);
        assert!(dir.join("hooks.json.muneo-bak").exists());
        assert_eq!(std::fs::read_to_string(dir.join("hooks.json.muneo-bak")).unwrap(), original);
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("muneo-tmp")));
        assert!(installed_command(&dir, Provider::Codex).is_some());
        // 두 번 설치해도 중복 없음, 파일 그대로
        let before = std::fs::read_to_string(dir.join("hooks.json")).unwrap();
        apply(&dir, Provider::Codex, true, EXE, true).unwrap();
        assert_eq!(before, std::fs::read_to_string(dir.join("hooks.json")).unwrap());
        // 경로가 바뀌면 명령만 교체
        apply(&dir, Provider::Codex, true, r"D:\new\muneo-claude-usage-tray.exe", true).unwrap();
        let cmd = installed_command(&dir, Provider::Codex).unwrap();
        assert!(cmd.starts_with(r"D:\new\muneo-claude-usage-tray.exe --hook codex"), "{cmd}");
        assert_eq!(load(&dir.join("hooks.json")).unwrap().pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap().len(), 2);
        // 제거 → 원본과 같음
        apply(&dir, Provider::Codex, false, EXE, true).unwrap();
        assert!(installed_command(&dir, Provider::Codex).is_none());
        assert_eq!(load(&dir.join("hooks.json")).unwrap(), serde_json::from_str::<Value>(original).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_creates_file_and_cleans_up() {
        let dir = tmp("codex-new");
        apply(&dir, Provider::Codex, false, EXE, true).unwrap(); // 없는 파일을 끄기 → 만들지 않음
        assert!(!dir.join("hooks.json").exists());
        apply(&dir, Provider::Codex, true, EXE, true).unwrap();
        assert!(!dir.join("hooks.json.muneo-bak").exists()); // 원본이 없었으니 백업 없음
        apply(&dir, Provider::Codex, false, EXE, true).unwrap();
        assert_eq!(load(&dir.join("hooks.json")).unwrap(), json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_merge_remove_backup_and_collision() {
        let dir = tmp("agy");
        let original = r#"{"lint":{"PostToolUse":[{"matcher":"run_command","hooks":[{"command":"./l.sh"}]}]}}"#;
        std::fs::write(dir.join("hooks.json"), original).unwrap();
        apply(&dir, Provider::Agy, true, EXE, true).unwrap();
        let v = load(&dir.join("hooks.json")).unwrap();
        assert!(v.get("lint").is_some());
        assert_eq!(v.pointer("/meowffice/PreToolUse/0/matcher").unwrap(), "run_command");
        assert!(v.pointer("/meowffice/PreToolUse/0/hooks/0/command").unwrap().as_str().unwrap().contains("--hook agy pretool"));
        assert!(v.pointer("/meowffice/Stop/0/command").unwrap().as_str().unwrap().contains("--hook agy stop"));
        assert_eq!(std::fs::read_to_string(dir.join("hooks.json.muneo-bak")).unwrap(), original);
        assert!(installed_command(&dir, Provider::Agy).is_some());
        apply(&dir, Provider::Agy, false, EXE, true).unwrap();
        assert_eq!(load(&dir.join("hooks.json")).unwrap(), serde_json::from_str::<Value>(original).unwrap());
        // 남이 쓴 meowffice 키는 덮어쓰지도 지우지도 않음
        std::fs::write(dir.join("hooks.json"), r#"{"meowffice":{"Stop":[{"command":"mine.sh"}]}}"#).unwrap();
        assert!(apply(&dir, Provider::Agy, true, EXE, true).is_err());
        apply(&dir, Provider::Agy, false, EXE, true).unwrap();
        assert!(load(&dir.join("hooks.json")).unwrap().get("meowffice").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_json_is_not_overwritten() {
        let dir = tmp("bad");
        std::fs::write(dir.join("hooks.json"), "{ not json").unwrap();
        assert!(apply(&dir, Provider::Codex, true, EXE, true).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("hooks.json")).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decision_formats() {
        let a = serde_json::from_str::<Value>(&allow_body(Provider::Codex, Event::Permission)).unwrap();
        assert_eq!(a["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(a["hookSpecificOutput"]["decision"]["behavior"], "allow");
        let d = serde_json::from_str::<Value>(&deny_body(Provider::Codex, Event::Permission, "no")).unwrap();
        assert_eq!(d["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(d["hookSpecificOutput"]["decision"]["message"], "no");
        assert_eq!(serde_json::from_str::<Value>(&allow_body(Provider::Agy, Event::PreTool)).unwrap()["decision"], "allow");
        let d = serde_json::from_str::<Value>(&deny_body(Provider::Agy, Event::PreTool, "no")).unwrap();
        assert_eq!((d["decision"].as_str(), d["reason"].as_str()), (Some("deny"), Some("no")));
        assert_eq!(fail_open(Provider::Codex, Event::Permission), "");
        assert_eq!(serde_json::from_str::<Value>(fail_open(Provider::Agy, Event::PreTool)).unwrap()["decision"], "ask");
        assert_eq!(fail_open(Provider::Agy, Event::Stop), "{}");
    }

    #[test]
    fn agy_policy_from_settings() {
        let c = |p: &str, sandbox: bool| json!({"userSettings":{"permissionPreset":p,"enableTerminalSandbox":sandbox}});
        assert_eq!(agy_policy(None), AgyPolicy::Card);
        assert_eq!(agy_policy(Some(&c("AGENT_PERMISSION_PRESET_TURBO", true))), AgyPolicy::Allow);
        assert_eq!(agy_policy(Some(&c("AGENT_PERMISSION_PRESET_REQUEST_REVIEW", true))), AgyPolicy::Card);
        assert_eq!(agy_policy(Some(&c("AGENT_PERMISSION_PRESET_AUTO", true))), AgyPolicy::Pass);
        assert_eq!(agy_policy(Some(&c("AGENT_PERMISSION_PRESET_AUTO", false))), AgyPolicy::Card);
    }

    #[test]
    fn command_quoting() {
        assert_eq!(command_line(r"C:\a\m.exe", Provider::Codex, "permission"), r"C:\a\m.exe --hook codex permission");
        assert_eq!(command_line(EXE, Provider::Agy, "stop"), format!("{EXE} --hook agy stop"));
        // 공백이 남은 경로(비 Windows)는 따옴표
        assert_eq!(command_line("/a b/m", Provider::Codex, "permission"), "\"/a b/m\" --hook codex permission");
    }

    #[test]
    fn hook_exe_decision() {
        let short = |p: &str| Some(p.replace("Program Files (x86)", "PROGRA~2").replace("Meow office", "MEOWOF~1"));
        assert_eq!(hook_exe_with(r"C:\Apps\m.exe", |_| panic!("안전한 경로는 변환하지 않음")).unwrap(), r"C:\Apps\m.exe");
        assert_eq!(hook_exe_with(r"C:\Program Files (x86)\Meow office\m.exe", short).unwrap(), r"C:\PROGRA~2\MEOWOF~1\m.exe");
        for bad in ["a b", "a&b", "a^b", "a%b", "a(b", "a)b", "a!b", "a;b", "a,b"] {
            let path = format!(r"C:\{bad}\m.exe");
            assert!(hook_exe_with(&path, |_| None).is_err(), "{path}");
            // 짧은 경로가 여전히 위험 문자를 포함하거나 비어 있으면 거부
            assert!(hook_exe_with(&path, |p| Some(p.to_string())).is_err(), "{path}");
            assert!(hook_exe_with(&path, |_| Some(String::new())).is_err());
        }
        let e = hook_exe_with(r"C:\a b\m.exe", |_| None).unwrap_err();
        assert!(e.contains("짧은 경로"), "{e}");
    }

    #[test]
    fn agy_apply_follows_policy() {
        let dir = tmp("agy-policy");
        let h = || load(&dir.join("hooks.json")).unwrap();
        // Card: PreToolUse + Stop
        apply(&dir, Provider::Agy, true, EXE, true).unwrap();
        assert!(h().pointer("/meowffice/PreToolUse/0/matcher").is_some());
        assert!(h().pointer("/meowffice/Stop/0/command").is_some());
        // Turbo·샌드박스(Card 아님): PreToolUse 만 빠지고 Stop 유지
        apply(&dir, Provider::Agy, true, EXE, false).unwrap();
        assert!(h().pointer("/meowffice/PreToolUse").is_none());
        assert!(h().pointer("/meowffice/Stop/0/command").unwrap().as_str().unwrap().contains("--hook agy stop"));
        assert!(installed_command(&dir, Provider::Agy).unwrap().contains("--hook agy stop"));
        // 다시 Card
        apply(&dir, Provider::Agy, true, EXE, true).unwrap();
        assert!(h().pointer("/meowffice/PreToolUse/0/hooks/0/command").unwrap().as_str().unwrap().contains("--hook agy pretool"));
        // 같은 정책 반복은 파일 그대로
        let before = std::fs::read_to_string(dir.join("hooks.json")).unwrap();
        apply(&dir, Provider::Agy, true, EXE, true).unwrap();
        assert_eq!(before, std::fs::read_to_string(dir.join("hooks.json")).unwrap());
        // 끄기는 정책과 무관하게 모두 제거
        apply(&dir, Provider::Agy, false, EXE, false).unwrap();
        assert!(h().get("meowffice").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_nits() {
        // 이미 같은 명령이면 파일을 다시 쓰지 않음(모양·순서 그대로)
        let dir = tmp("codex-nit");
        apply(&dir, Provider::Codex, true, EXE, true).unwrap();
        let mut v = load(&dir.join("hooks.json")).unwrap();
        v["hooks"].as_object_mut().unwrap().insert("Zed".into(), json!([]));
        let custom = serde_json::to_string(&v).unwrap(); // 일부러 압축 모양으로 저장
        std::fs::write(dir.join("hooks.json"), &custom).unwrap();
        apply(&dir, Provider::Codex, true, EXE, true).unwrap();
        assert_eq!(custom, std::fs::read_to_string(dir.join("hooks.json")).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
        // 우리가 만들지 않은 빈 hooks 는 지우지 않음
        let dir = tmp("codex-empty-hooks");
        std::fs::write(dir.join("hooks.json"), r#"{"hooks":{},"x":1}"#).unwrap();
        apply(&dir, Provider::Codex, false, EXE, true).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("hooks.json")).unwrap(), r#"{"hooks":{},"x":1}"#);
        let _ = std::fs::remove_dir_all(&dir);
        // 우리 exe 이름이 아닌 명령은 표식이 같아도 우리 것이 아님
        assert!(!is_ours_command("other.exe --hook codex permission", Provider::Codex));
        assert!(is_ours_command(r"C:\PROGRA~1\MUNEO-~1.EXE --hook codex permission", Provider::Codex));
        assert!(is_ours_command(&format!("{EXE} --hook codex permission"), Provider::Codex));
    }

    #[cfg(windows)]
    #[test]
    fn windows_short_path_resolves() {
        let dir = std::env::var("ProgramFiles").unwrap_or(r"C:\Program Files".into());
        if std::path::Path::new(&dir).exists() {
            let r = hook_exe_with(&dir, short_path);
            assert!(r.as_ref().is_ok_and(|s| !has_unsafe(s)), "{r:?}");
        }
    }
}
