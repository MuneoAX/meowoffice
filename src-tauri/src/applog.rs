//! 앱 로그 — 문제 제보용 하루치 파일 로그(`log` 크레이트 백엔드).
//! 경로: <로컬 앱 데이터>/logs/YYYY-MM-DD.log
//!   (Windows: %LOCALAPPDATA%\muneo\muneo-claude-usage-tray\data\logs). 오늘·어제 파일만 유지.
//! 이 앱은 debug 이상, 다른 크레이트(tauri·updater 등)는 info 이상 기록. 패닉도 기록.
//! 토큰·명령 본문 등 비밀이 될 수 있는 값은 기록하지 않는다(호출부 책임).

use chrono::{Duration as CDuration, Local};
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 이 크레이트의 로그 대상(target) 접두사.
///
/// `FileLogger::enabled` 가 이 접두사로 시작하는 target 은 Debug 이상, 그 밖은 Info 이상으로 거른다.
/// `FileLogger::log` 는 출력할 때 이 접두사를 떼어 모듈 경로만 남긴다(비면 "main").
///
/// # 참조
/// `FileLogger::enabled`, `FileLogger::log` 에서 사용.
const OWN: &str = "muneo_claude_usage_tray";

/// 하루 단위 파일에 한 줄씩 덧붙여 쓰는 `log::Log` 구현.
///
/// 로그 디렉터리와 현재 열린 파일(날짜 포함)을 들고 있다. 필드 `cur` 의 `Mutex` 로 여러 스레드의 기록을 직렬화한다.
///
/// # 참조
/// `init` 이 생성해 `log::set_boxed_logger` 로 설치한다. 기록 파일은 `<dir>/YYYY-MM-DD.log`.
struct FileLogger {
    /// 로그 파일을 두는 디렉터리(`dir()` 의 결과).
    dir: PathBuf,
    /// (날짜, 열린 파일) — 날짜가 바뀌면 새 파일로 + 오래된 파일 정리.
    ///
    /// 아직 파일이 없거나 열기에 실패하면 None. 잠금을 얻지 못하면(오염) 그 줄은 버린다.
    cur: Mutex<Option<(String, File)>>,
}

impl Log for FileLogger {
    /// 이 로그 줄을 기록할지 정한다.
    ///
    /// target 이 `OWN` 으로 시작하면 Debug 이상, 아니면(tauri·updater 등) Info 이상만 통과시킨다.
    ///
    /// # 인자
    /// - `m`: 로그 메타데이터(레벨·target)
    ///
    /// # 반환
    /// 기록해야 하면 true.
    ///
    /// # 참조
    /// `FileLogger::log` 가 호출.
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= if m.target().starts_with(OWN) { Level::Debug } else { Level::Info }
    }

    /// 로그 한 줄을 오늘 날짜 파일에 덧붙인다.
    ///
    /// `enabled` 를 통과한 기록만 "시:분:초.밀리초 레벨 [모듈] 메시지" 형태로 만든다. debug 빌드에서는 stderr 에도 찍는다.
    /// `cur` 잠금을 잡고, 날짜가 바뀌었거나 파일이 없으면 `prune` 으로 옛 파일을 지우고 오늘 파일을 append 모드로 연다.
    /// 쓰기 실패는 무시한다.
    ///
    /// # 인자
    /// - `r`: 기록할 로그 레코드
    ///
    /// # 참조
    /// `FileLogger::enabled`, `prune` 호출. 파일: `<dir>/YYYY-MM-DD.log`.
    fn log(&self, r: &Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let now = Local::now();
        let day = now.format("%Y-%m-%d").to_string();
        let target = r.target().strip_prefix(OWN).map(|t| t.trim_start_matches("::")).unwrap_or(r.target());
        let line =
            format!("{} {:<5} [{}] {}\n", now.format("%H:%M:%S%.3f"), r.level(), if target.is_empty() { "main" } else { target }, r.args());
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        let Ok(mut cur) = self.cur.lock() else { return };
        if cur.as_ref().is_none_or(|(d, _)| *d != day) {
            prune(&self.dir);
            *cur = OpenOptions::new().create(true).append(true).open(self.dir.join(format!("{day}.log"))).ok().map(|f| (day, f));
        }
        if let Some((_, f)) = cur.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    /// `log::Log` 요구 사항. 줄마다 바로 쓰므로 할 일이 없다.
    fn flush(&self) {}
}

/// 로그 디렉터리 경로를 구한다.
///
/// `ProjectDirs("co.kr","muneo","muneo-claude-usage-tray")` 의 로컬 데이터 디렉터리 아래 `logs`. 구할 수 없으면 임시 폴더의 `muneo-claude-usage-tray-logs`.
///
/// # 반환
/// 로그 디렉터리 경로(만들지는 않음).
///
/// # 참조
/// `init`, `export` 가 사용. 다른 모듈(`update`, `office`)도 `dir().with_file_name(...)` 으로 같은 상위 폴더에 상태 파일을 둔다.
pub fn dir() -> PathBuf {
    directories::ProjectDirs::from("co.kr", "muneo", "muneo-claude-usage-tray")
        .map(|d| d.data_local_dir().join("logs"))
        .unwrap_or_else(|| std::env::temp_dir().join("muneo-claude-usage-tray-logs"))
}

/// 로거를 설치하고 패닉도 로그에 남기도록 훅을 건다.
///
/// 로그 디렉터리를 만들고 `FileLogger` 를 전역 로거로 설치하면 최대 레벨을 Debug 로 올린다(이미 설치돼 있으면 레벨은 그대로).
/// 기본 패닉 훅을 보관한 뒤, 패닉 정보를 `error` 로 남기고 원래 훅을 이어서 호출하는 훅으로 교체한다. main 시작 시 1회.
///
/// # 참조
/// `dir`, `FileLogger` 사용. 파일: `<dir>/YYYY-MM-DD.log`.
pub fn init() {
    let dir = dir();
    let _ = std::fs::create_dir_all(&dir);
    if log::set_boxed_logger(Box::new(FileLogger { dir, cur: Mutex::new(None) })).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("패닉: {info}");
        default(info);
    }));
}

/// 어제보다 오래된 로그 파일을 지운다.
///
/// 디렉터리의 `*.log` 중 이름이 10자(YYYY-MM-DD)이고 어제 날짜 문자열보다 앞서는 파일을 삭제한다. 읽기·삭제 실패는 무시한다.
///
/// # 인자
/// - `dir`: 로그 디렉터리
///
/// # 참조
/// `FileLogger::log` 가 날짜 전환 시 호출.
fn prune(dir: &Path) {
    let keep = (Local::now() - CDuration::days(1)).format("%Y-%m-%d").to_string();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(day) = name.strip_suffix(".log") {
            if day.len() == 10 && day < keep.as_str() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// 어제+오늘 로그를 머리글과 함께 한 텍스트로 모은다.
///
/// 로그 폴더의 `*.log` 를 이름순으로 모아, 맨 위에 앱 버전·OS·아키텍처·모은 시각 머리글을 쓰고 파일마다 구분선과 내용을 잇는다.
///
/// # 인자
/// - `version`: 머리글에 적을 앱 버전 문자열
///
/// # 반환
/// 모은 텍스트. 폴더·파일 읽기 실패 시 `Err`.
///
/// # 참조
/// `dir` 호출. `export`(바탕화면 저장)·`remotelog`(원격 접수)가 사용.
pub fn collect(version: &str) -> std::io::Result<String> {
    let dir = dir();
    let mut files: Vec<PathBuf> =
        std::fs::read_dir(&dir)?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "log")).collect();
    files.sort();
    let mut out = format!(
        "Meowffice {version} · {} {} · 내보낸 시각 {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    for f in files {
        out.push_str(&format!("\n===== {} =====\n", f.file_name().unwrap_or_default().to_string_lossy()));
        out.push_str(&String::from_utf8_lossy(&std::fs::read(&f)?));
    }
    Ok(out)
}

/// 어제+오늘 로그를 한 파일로 합쳐 바탕화면(없으면 로그 폴더)에 저장한다.
///
/// 내용은 `collect` 와 같다. 바탕화면 경로를 구하지 못하면 로그 폴더에 저장한다. 파일 이름은 `muneo-claude-tray-log-YYYYMMDD-HHMM.txt`.
///
/// # 인자
/// - `version`: 머리글에 적을 앱 버전 문자열
///
/// # 반환
/// 저장한 파일 경로. 폴더 읽기·파일 읽기·쓰기 실패 시 `Err`.
///
/// # 참조
/// `collect`, `dir` 호출. 내보내기 파일 쓰기.
pub fn export(version: &str) -> std::io::Result<PathBuf> {
    let out = collect(version)?;
    let dest_dir = directories::UserDirs::new().and_then(|u| u.desktop_dir().map(Path::to_path_buf)).unwrap_or_else(dir);
    let dest = dest_dir.join(format!("muneo-claude-tray-log-{}.txt", Local::now().format("%Y%m%d-%H%M")));
    std::fs::write(&dest, out)?;
    Ok(dest)
}
