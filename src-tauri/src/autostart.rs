//! 로그인 자동시작.
//! Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run 레지스트리 값.
//! macOS: ~/Library/LaunchAgents/co.kr.muneo.usage-tray.plist (RunAtLoad).
//! 매 기동 시 호출(자가 치유). enabled=false 면 값 삭제.
//! 개발(debug) 빌드는 건드리지 않음 — debug exe 경로가 등록되면 로그인 때 콘솔 창과 함께
//! 개발 서버(127.0.0.1)를 찾는 빈 화면이 뜸.

/// Windows: 로그인 자동시작 레지스트리 값을 설정에 맞춘다.
///
/// debug 빌드에서는 아무것도 하지 않는다. `enabled` 면 현재 exe 경로를 따옴표로 감싸
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 의 `muneo-claude-usage-tray` 값으로 쓰고, 아니면 값을 지운다(없어서 실패해도 무시).
/// 매 기동 시 호출되어 값이 어긋나 있으면 고친다.
///
/// # 인자
/// - `enabled`: true 면 등록, false 면 삭제
///
/// # 반환
/// 레지스트리 열기·쓰기나 현재 exe 경로 조회 실패 시 `Err`.
///
/// # 참조
/// `std::env::current_exe`, 레지스트리 Run 키.
#[cfg(windows)]
pub fn apply(enabled: bool) -> std::io::Result<()> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    /// 자동시작 값이 놓이는 HKCU 하위 레지스트리 키 경로.
    const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// Run 키 안에서 이 앱이 쓰는 값 이름.
    const VALUE_NAME: &str = "muneo-claude-usage-tray";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey(RUN_PATH)?;

    if enabled {
        let exe = std::env::current_exe()?;
        let value = format!("\"{}\"", exe.display());
        run.set_value(VALUE_NAME, &value)?;
    } else {
        // 미등록 상태에서 삭제 실패는 무시.
        let _ = run.delete_value(VALUE_NAME);
    }
    Ok(())
}

/// macOS: 로그인 자동시작 LaunchAgent plist 를 설정에 맞춘다.
///
/// debug 빌드에서는 아무것도 하지 않는다. `enabled` 면 현재 exe 를 `RunAtLoad` 로 실행하는 plist 를
/// `~/Library/LaunchAgents/co.kr.muneo.usage-tray.plist` 에 쓰되(exe 경로의 `&`, `<` 는 이스케이프), 내용이 같으면 다시 쓰지 않는다.
/// 아니면 plist 를 지운다(실패 무시). 홈 디렉터리를 모르면 아무것도 하지 않고 Ok.
///
/// # 인자
/// - `enabled`: true 면 등록, false 면 삭제
///
/// # 반환
/// 현재 exe 경로 조회나 폴더 생성·파일 쓰기 실패 시 `Err`.
///
/// # 참조
/// `std::env::current_exe`, plist 파일.
#[cfg(target_os = "macos")]
pub fn apply(enabled: bool) -> std::io::Result<()> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    /// LaunchAgent 레이블이자 plist 파일 이름(확장자 제외).
    const LABEL: &str = "co.kr.muneo.usage-tray";

    let Some(base) = directories::BaseDirs::new() else {
        return Ok(());
    };
    let dir = base.home_dir().join("Library").join("LaunchAgents");
    let plist = dir.join(format!("{LABEL}.plist"));

    if enabled {
        let exe = std::env::current_exe()?;
        let exe = exe.display().to_string().replace('&', "&amp;").replace('<', "&lt;");
        let text = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
"#
        );
        // 내용이 같으면 다시 쓰지 않음(매 기동 자가 치유).
        if std::fs::read_to_string(&plist).ok().as_deref() != Some(text.as_str()) {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&plist, text)?;
        }
    } else {
        let _ = std::fs::remove_file(&plist);
    }
    Ok(())
}

/// 그 밖의 OS: 자동시작을 지원하지 않으므로 아무것도 하지 않는다.
///
/// # 인자
/// - `_enabled`: 사용하지 않음
///
/// # 반환
/// 항상 `Ok(())`.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn apply(_enabled: bool) -> std::io::Result<()> {
    Ok(())
}
