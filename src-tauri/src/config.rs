//! 설정 모듈.
//! 경로: %APPDATA%\muneo\muneo-claude-usage-tray\config\config.toml
//! 인증은 Claude Code 로그인 자격증명(~/.claude/.credentials.json)을 읽기 전용으로 재사용 — 키 입력 없음.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 앱 설정 전체 — `config.toml` 과 1:1 로 직렬화·역직렬화된다.
///
/// 모든 필드에 `#[serde(default...)]` 가 있어 파일에 없는 항목은 기본값으로 채워진다(`Default` 구현과 같은 값).
/// 토큰·키 값은 이 문서에 적지 않는다(필드 이름만: `hook_token`, `admin_api_key_enc`).
///
/// # 참조
/// `load`, `load_readonly` 로 읽고 `save` 로 쓴다. 파일: `config.toml`.
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Config {
    /// 플랜 한도 갱신 주기(분). 트레이 아이콘도 이 주기로 갱신.
    ///
    /// 기본값 5. 갱신 스레드는 이 값을 최소 1분으로 올려 쓴다.
    #[serde(default = "default_interval")]
    pub refresh_interval_minutes: u64,
    /// 로그인 자동시작 등록 여부.
    ///
    /// 기본값 true. 기동 시 `autostart::apply` 가 이 값에 맞춘다.
    #[serde(default = "default_true")]
    pub autostart: bool,
    /// Claude 설정 디렉터리. 공란이면 CLAUDE_CONFIG_DIR → ~/.claude.
    ///
    /// 기본값 빈 문자열. 해석은 `claude_dir()` 함수가 한다.
    #[serde(default)]
    pub claude_dir: String,
    /// 세션 알림 팝업(입력 대기·검토 대기) 사용 여부.
    ///
    /// 기본값 true.
    #[serde(default = "default_true")]
    pub alerts: bool,
    /// 알림 확인 주기(초).
    ///
    /// 기본값 30. 알림 확인 스레드는 이 값을 최소 10초로 올려 쓴다.
    #[serde(default = "default_alert_poll")]
    pub alert_poll_seconds: u64,
    /// [자세히]만 있는 일반 상태 알림 카드를 이 시간(초) 뒤 자동으로 숨김(입력 대기·로컬 세션·업데이트·연결 불안정 제외).
    /// 0 이면 끔. 숨겨도 읽지 않은 알림으로 남음.
    ///
    /// 기본값 30.
    #[serde(default = "default_auto_hide")]
    pub alert_auto_hide_seconds: u64,
    /// 로컬 세션(터미널·IDE 의 Claude Code) 응답 완료·입력 대기 알림. Claude Code 연동(훅) 필요.
    ///
    /// 기본값 true.
    #[serde(default = "default_true")]
    pub local_alerts: bool,
    /// 알림 창에 띄우지 않을 알림 종류(alerts::KINDS 의 id). 기록에는 읽음으로 남음.
    ///
    /// 기본값 빈 목록.
    #[serde(default)]
    pub muted_alert_kinds: Vec<String>,
    /// Claude Code 연동: 권한 요청을 알림 카드에서 수락/거절(settings.json 에 HTTP 훅 등록).
    ///
    /// 기본값 false. 켜져 있으면 기동 시 `hook::apply` 로 훅을 다시 맞춘다.
    #[serde(default)]
    pub permission_hook: bool,
    /// 자동 수락: 권한 요청을 카드 없이 바로 수락(선택지를 고르는 질문·계획 승인은 제외). permission_hook 필요.
    ///
    /// 기본값 false.
    #[serde(default)]
    pub auto_allow: bool,
    /// 권한 요청 수신 포트(127.0.0.1).
    ///
    /// 기본값 47821.
    #[serde(default = "default_hook_port")]
    pub hook_port: u16,
    /// 훅 요청 검증 토큰. 연동을 켤 때 자동 생성.
    ///
    /// 기본값 빈 문자열. 생성은 `new_token()`. 값은 문서·로그에 적지 않는다.
    #[serde(default)]
    pub hook_token: String,
    /// claude.ai 링크(세션 카드·알림 "자세히")를 Claude 데스크톱 앱으로 열기(미설치 시 브라우저).
    ///
    /// 기본값 false.
    #[serde(default)]
    pub open_in_desktop: bool,
    /// 관리 창(패널)을 항상 다른 창 위에 표시. 끄면 뒤 창을 누르면 그 창이 위로 올라옴.
    ///
    /// 기본값 false.
    #[serde(default)]
    pub panel_on_top: bool,
    /// Claude API(Console) 월 할당 크레딧(USD). 0 이면 사용액만 표시.
    ///
    /// 기본값 0.0.
    #[serde(default)]
    pub api_allocated_usd: f64,
    /// Admin API 키 — Windows 는 DPAPI 암호문(hex, 같은 사용자만 복호). 그 외 OS 는 "plain:" 접두 평문.
    ///
    /// 기본값 빈 문자열(키 없음). 저장·복호는 `set_admin_key`·`admin_key` 가 한다.
    #[serde(default)]
    pub admin_api_key_enc: String,
    /// 다른 AI 서비스 연동(사무실 표시)을 켠 서비스: "chatgpt" · "antigravity". None = 아직 한 번도 저장 안 함(예전 화면 저장값을 옮겨 옴).
    ///
    /// 기본값 None.
    #[serde(default)]
    pub providers_on: Option<Vec<String>>,
    /// 웹 서비스 장애 알림을 켠 서비스: "chatgpt" · "gemini". (Claude 는 항상 확인) 기본값 빈 목록.
    #[serde(default)]
    pub web_status_alerts: Vec<String>,
    /// ChatGPT(Codex) 권한 요청 연동: ~/.codex/hooks.json 에 PermissionRequest 훅(이 앱 exe 의 --hook 모드) 등록.
    ///
    /// 기본값 false.
    #[serde(default)]
    pub codex_hook: bool,
    /// Codex 권한 요청 자동 수락(카드 없이). codex_hook 필요.
    ///
    /// 기본값 false.
    #[serde(default)]
    pub codex_auto_allow: bool,
    /// Antigravity 권한 요청·응답 완료 연동: ~/.gemini/config/hooks.json 에 PreToolUse·Stop 훅 등록.
    ///
    /// 기본값 true (0.5.2 부터 — 모르고 꺼 둔 채 쓰는 사용자가 많아서). 이전 설치는 `agy_hook_defaulted` 로 한 번만 켠다.
    #[serde(default = "default_true")]
    pub agy_hook: bool,
    /// Antigravity 연동 기본 켬을 이미 적용했는지 (앱 시작 때 한 번만 켜고 그 뒤로는 사용자 선택을 따름).
    ///
    /// 기본값 false.
    #[serde(default)]
    pub agy_hook_defaulted: bool,
    /// Antigravity 권한 요청 자동 수락(카드 없이). agy_hook 필요.
    ///
    /// 기본값 false.
    #[serde(default)]
    pub agy_auto_allow: bool,
    /// 화면·알림 언어 선택: "auto"(OS 언어 — 한국어면 ko, 일본어면 ja, 그 밖은 en) | "ko" | "en" | "ja".
    ///
    /// 기본값 "auto". 화면이 `set_lang` 명령으로 바꾼다. 실제 언어 판정은 `i18n::resolve`.
    #[serde(default = "default_lang")]
    pub lang: String,
}

/// `lang` 의 serde 기본값.
///
/// # 반환
/// "auto".
fn default_lang() -> String {
    "auto".into()
}

/// `hook_port` 의 serde 기본값.
///
/// # 반환
/// 47821.
fn default_hook_port() -> u16 {
    47821
}

/// `alert_auto_hide_seconds` 의 serde 기본값.
///
/// # 반환
/// 30.
fn default_auto_hide() -> u64 {
    30
}

/// `alert_poll_seconds` 의 serde 기본값.
///
/// # 반환
/// 30.
fn default_alert_poll() -> u64 {
    30
}

/// `refresh_interval_minutes` 의 serde 기본값.
///
/// # 반환
/// 5.
fn default_interval() -> u64 {
    5
}
/// 기본값이 true 인 불리언 필드(`autostart`, `alerts`, `local_alerts`, `agy_hook`)의 serde 기본값.
///
/// # 반환
/// 항상 true.
fn default_true() -> bool {
    true
}

/// `Config` 의 기본값 — 각 필드의 serde 기본값과 같은 값으로 채운다.
impl Default for Config {
    /// 기본 설정을 만든다.
    ///
    /// # 반환
    /// 모든 필드가 기본값인 `Config`. `load` 가 파일이 없거나 해석에 실패했을 때 쓴다.
    fn default() -> Self {
        Self {
            refresh_interval_minutes: 5,
            autostart: true,
            claude_dir: String::new(),
            alerts: true,
            alert_poll_seconds: 30,
            alert_auto_hide_seconds: 30,
            local_alerts: true,
            muted_alert_kinds: Vec::new(),
            permission_hook: false,
            auto_allow: false,
            hook_port: 47821,
            hook_token: String::new(),
            open_in_desktop: false,
            panel_on_top: false,
            api_allocated_usd: 0.0,
            admin_api_key_enc: String::new(),
            providers_on: None,
            web_status_alerts: Vec::new(),
            codex_hook: false,
            codex_auto_allow: false,
            agy_hook: true,
            agy_hook_defaulted: false,
            agy_auto_allow: false,
            lang: default_lang(),
        }
    }
}

/// 저장된 Admin API 키를 평문으로 꺼낸다.
///
/// `admin_api_key_enc` 를 다듬어 비어 있으면 None. "plain:" 접두가 있으면 접두를 뗀 평문, 없으면 `crypto::decrypt` 로 복호한다. 결과가 공백뿐이면 None.
///
/// # 인자
/// - `c`: 설정
///
/// # 반환
/// 키 평문. 없거나 복호 실패·공백이면 None.
///
/// # 참조
/// `crypto::decrypt` 호출.
pub fn admin_key(c: &Config) -> Option<String> {
    let enc = c.admin_api_key_enc.trim();
    if enc.is_empty() {
        return None;
    }
    match enc.strip_prefix("plain:") {
        Some(p) => Some(p.to_string()),
        None => crate::crypto::decrypt(enc),
    }
    .filter(|k| !k.trim().is_empty())
}

/// Admin API 키를 설정에 저장(암호화)한다. 빈 값이면 지운다.
///
/// 키를 다듬어 빈 문자열이면 `admin_api_key_enc` 를 비운다. Windows 는 `crypto::encrypt`(DPAPI)로 암호화하며, 실패하면 평문으로 두지 않고 오류를 낸다.
/// 그 외 OS 는 암호화 수단이 없어 "plain:" 접두를 붙여 평문으로 둔다. 파일에 쓰지는 않는다(`save` 는 호출자 몫).
///
/// # 인자
/// - `c`: 값을 바꿀 설정
/// - `key`: 저장할 키 문자열(앞뒤 공백 무시, 빈 값이면 삭제)
///
/// # 반환
/// 성공하면 `Ok(())`. Windows 에서 DPAPI 암호화 실패 시 `Err("키 암호화(DPAPI)에 실패해 저장하지 않았습니다")`.
///
/// # 참조
/// `crypto::encrypt` 호출.
pub fn set_admin_key(c: &mut Config, key: &str) -> Result<(), String> {
    let key = key.trim();
    c.admin_api_key_enc = if key.is_empty() {
        String::new()
    } else if cfg!(windows) {
        crate::crypto::encrypt(key).ok_or(crate::i18n::t("config.err.dpapi"))?
    } else {
        format!("plain:{key}")
    };
    Ok(())
}

/// `load` 의 결과 묶음 — 설정과 그 파일 경로, 안내 문구, 새로 만들었는지 여부.
pub struct Loaded {
    /// 읽어 온 설정(실패 시 기본값).
    pub config: Config,
    /// 설정 파일 경로(`config.toml`). `save` 에 그대로 넘긴다.
    pub path: PathBuf,
    /// UI 안내 문구(템플릿 생성/파싱 오류 등). 정상 로드 시 None.
    pub note: Option<String>,
    /// 이번 로드에서 설정 파일을 새로 만듦(=처음 설치 후 첫 실행).
    ///
    /// 템플릿 쓰기에 실패해도 파일이 없었으면 true 다.
    pub created: bool,
}

/// 처음 실행 때 쓰는 설정 파일 템플릿(주석 포함 TOML 문서).
///
/// 필드마다 한국어 설명 주석이 달려 있고, 값은 기본값과 같다(권한 연동·토큰·Admin 키 관련 항목은 없음).
///
/// # 참조
/// `write_template` 이 파일로 쓴다.
pub(crate) const TEMPLATE: &str = r#"# muneo-claude-usage-tray 설정
# 인증은 Claude Code 로그인 정보(~/.claude/.credentials.json)를 읽기 전용으로 사용합니다.

# 플랜 한도·트레이 아이콘 갱신 주기(분).
refresh_interval_minutes = 5

# Windows 로그인 시 자동 시작 등록.
autostart = true

# Claude 설정 디렉터리. 공란이면 CLAUDE_CONFIG_DIR 환경변수 → %USERPROFILE%\.claude
claude_dir = ""

# 세션 알림 팝업: Claude 가 입력/검토를 기다리면 시계 위에 카드 표시.
alerts = true

# 알림 확인 주기(초).
alert_poll_seconds = 30

# [자세히] 버튼만 있는 일반 상태 알림 카드를 이 시간(초) 뒤 자동으로 숨김(0 = 끔).
# 입력 대기·로컬 세션(응답 완료·권한 확인)·업데이트·연결 불안정 카드는 제외.
# 숨겨도 읽지 않은 알림으로 남음.
alert_auto_hide_seconds = 30

# 로컬 세션(터미널·IDE 의 Claude Code) 응답 완료·입력 대기 알림. permission_hook(연동) 필요.
local_alerts = true

# 알림 창에 띄우지 않을 종류(설정 화면 "알림 종류"에서 체크 해제).
# local_done · local_input · agent · codex_done · agy_done · remote_input · remote_review · update · status
muted_alert_kinds = []

# Claude Code 연동: 권한 요청을 알림 카드에서 수락/거절 (설정 화면에서 켜기 권장 — 훅 자동 등록).
permission_hook = false

# 자동 수락: 권한 요청을 카드 없이 바로 수락(질문 선택지·계획 승인은 카드로 표시). permission_hook 필요.
auto_allow = false

# 권한 요청 수신 포트(127.0.0.1 전용).
hook_port = 47821

# claude.ai 링크를 Claude 데스크톱 앱으로 열기(설치돼 있지 않으면 브라우저).
open_in_desktop = false

# 관리 창을 항상 다른 창 위에 표시.
panel_on_top = false

# Claude API(Console) 월 할당 크레딧(USD). Admin API 키는 설정 화면에서 입력(암호화해 저장).
api_allocated_usd = 0
"#;

/// 설정을 읽는다. 실패해도 패닉 없이 기본값과 안내 문구를 돌려준다.
///
/// 파일이 없으면 템플릿을 만들고(`write_template`) 기본값을 돌려준다(`created=true`). 있으면 읽어 TOML 로 해석하고,
/// 읽기·해석에 실패하면 기본값과 "설정 파싱 오류" 안내를 돌려준다(파일은 건드리지 않음).
///
/// # 반환
/// `Loaded`. `note` 는 템플릿 생성·실패·파싱 오류일 때만 값이 있다.
///
/// # 참조
/// `config_path`, `write_template` 호출. 파일: `config.toml` 읽기(없으면 생성).
pub fn load() -> Loaded {
    let path = config_path();

    if !path.exists() {
        let note = match write_template(&path) {
            Ok(()) => Some(crate::i18n::tf("config.note.template_created", &[("path", &path.display().to_string())])),
            Err(e) => Some(crate::i18n::tf("config.note.template_failed", &[("e", &e.to_string())])),
        };
        return Loaded { config: Config::default(), path, note, created: true };
    }

    match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| toml::from_str::<Config>(&t).map_err(|e| e.to_string())) {
        Ok(config) => Loaded { config, path, note: None, created: false },
        Err(e) => Loaded {
            config: Config::default(), path, note: Some(crate::i18n::tf("config.note.parse_error", &[("e", &e.to_string())])), created: false
        },
    }
}

/// 설정 템플릿 파일을 쓴다(상위 폴더가 없으면 만든다).
///
/// # 인자
/// - `path`: 쓸 설정 파일 경로
///
/// # 반환
/// 성공하면 `Ok(())`. 폴더 생성·파일 쓰기 실패 시 `Err`.
///
/// # 참조
/// `TEMPLATE`. `load` 가 호출.
fn write_template(path: &PathBuf) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, TEMPLATE)
}

/// 설정을 파일에 저장한다. 주석은 보존되지 않는다(재포맷 기록) — 설정 모달 저장용.
///
/// 상위 폴더를 만들고 `toml::to_string_pretty` 결과를 통째로 덮어쓴다.
///
/// # 인자
/// - `path`: 설정 파일 경로(`Loaded::path`)
/// - `cfg`: 저장할 설정
///
/// # 반환
/// 성공하면 `Ok(())`. 직렬화·폴더 생성·쓰기 실패 시 `Err`.
///
/// # 참조
/// 파일: `config.toml` 덮어쓰기.
pub fn save(path: &Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = toml::to_string_pretty(cfg).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::write(path, text)
}

/// Claude 설정 디렉터리를 해석한다: config → CLAUDE_CONFIG_DIR → ~/.claude.
///
/// `cfg.claude_dir` 가 공란이 아니면 그 값, 아니면 환경변수 `CLAUDE_CONFIG_DIR`(공란 아닐 때), 아니면 홈 아래 `.claude`.
/// 홈을 알 수 없으면 상대 경로 `.claude`.
///
/// # 인자
/// - `cfg`: 설정
///
/// # 반환
/// 디렉터리 경로(존재 여부는 확인하지 않음).
pub fn claude_dir(cfg: &Config) -> PathBuf {
    if !cfg.claude_dir.trim().is_empty() {
        return PathBuf::from(cfg.claude_dir.trim());
    }
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    directories::BaseDirs::new().map(|b| b.home_dir().join(".claude")).unwrap_or_else(|| PathBuf::from(".claude"))
}

/// 설정 파일을 읽기만 한다(없거나 깨져 있으면 None — 템플릿을 만들지 않음). `--hook` 중계 모드 전용.
///
/// # 반환
/// 해석된 `Config`. 파일이 없거나 읽기·해석에 실패하면 None.
///
/// # 참조
/// `config_path`. `relay::run` 이 호출. 파일: `config.toml` 읽기.
pub fn load_readonly() -> Option<Config> {
    let text = std::fs::read_to_string(config_path()).ok()?;
    toml::from_str::<Config>(&text).ok()
}

/// 설정 파일 경로를 구한다.
///
/// # 반환
/// `ProjectDirs("co.kr","muneo","muneo-claude-usage-tray")` 의 설정 디렉터리 아래 `config.toml`. 구할 수 없으면 상대 경로 `config.toml`.
fn config_path() -> PathBuf {
    if let Some(dirs) = directories::ProjectDirs::from("co.kr", "muneo", "muneo-claude-usage-tray") {
        dirs.config_dir().join("config.toml")
    } else {
        PathBuf::from("config.toml")
    }
}

/// 무작위 토큰 문자열을 만든다(`hook_token` 용).
///
/// `RandomState` 의 OS 난수 시드와 현재 시각(나노초)을 섞은 해시 64비트 값 2개를 16진수 32자로 이어 붙인다(외부 크레이트 없이 128bit).
///
/// # 반환
/// 32자 16진수 문자열.
pub fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 컴퓨터 제어를 쓰던 예전 config.toml(없어진 키 포함)도 읽혀야 한다.
    #[test]
    fn legacy_computer_keys_are_ignored() {
        let text = "refresh_interval_minutes = 7\ncomputer_control = true\ncomputer_auto_readonly = false\ncomputer_kill_hotkey = \"Ctrl+Alt+Escape\"\n";
        let c: Config = toml::from_str(text).expect("예전 키가 있어도 읽혀야 함");
        assert_eq!(c.refresh_interval_minutes, 7);
    }
}
