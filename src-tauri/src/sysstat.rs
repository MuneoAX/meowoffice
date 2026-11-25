//! 시스템 사용률 — 사무실 아래 상태 바(좌하단)에 보일 CPU·메모리·배터리.
//! Windows API 를 직접 부른다(GetSystemTimes·GlobalMemoryStatusEx·GetSystemPowerStatus). 추가 크레이트 없음.
//! CPU 사용률은 두 번 잰 시각 사이의 차이로 계산하므로 직전 값을 전역에 둔다(첫 호출은 None).
//! Windows 가 아니면 모든 값이 None 이다(상태 바가 그 칸을 숨긴다).

use serde::Serialize;

/// 상태 바에 보낼 값. 못 잰 값은 None.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SysStats {
    /// 전체 CPU 사용률(0~100). 첫 호출은 비교할 직전 값이 없어 None.
    pub cpu: Option<f32>,
    /// 사용 중인 물리 메모리(바이트).
    pub mem_used: Option<u64>,
    /// 전체 물리 메모리(바이트).
    pub mem_total: Option<u64>,
    /// 배터리 잔량(0~100). 배터리가 없거나 알 수 없으면 None.
    pub battery: Option<u8>,
    /// 전원 연결 여부(배터리가 있을 때만 의미).
    pub charging: Option<bool>,
}

/// 직전 CPU 시간(유휴, 커널, 사용자 — 100ns 단위). 커널 시간에 유휴가 포함된다.
#[cfg(windows)]
static LAST_CPU: std::sync::Mutex<Option<(u64, u64, u64)>> = std::sync::Mutex::new(None);

/// FILETIME → u64.
#[cfg(windows)]
fn ft(t: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

/// 직전 호출 이후의 전체 CPU 사용률.
///
/// # 반환
/// 0~100. 첫 호출이거나 API 가 실패하면 None.
#[cfg(windows)]
fn cpu() -> Option<f32> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetSystemTimes;
    let zero = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut idle, mut kernel, mut user) = (zero(), zero(), zero());
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let now = (ft(&idle), ft(&kernel), ft(&user));
    let mut last = LAST_CPU.lock().unwrap_or_else(|e| e.into_inner());
    let prev = last.replace(now)?;
    let idle_d = now.0.saturating_sub(prev.0);
    let total_d = now.1.saturating_sub(prev.1) + now.2.saturating_sub(prev.2);
    if total_d == 0 {
        return None;
    }
    Some((100.0 * (total_d.saturating_sub(idle_d)) as f64 / total_d as f64).clamp(0.0, 100.0) as f32)
}

/// 물리 메모리 (사용, 전체) 바이트.
#[cfg(windows)]
fn mem() -> Option<(u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 || m.ullTotalPhys == 0 {
        return None;
    }
    Some((m.ullTotalPhys.saturating_sub(m.ullAvailPhys), m.ullTotalPhys))
}

/// 배터리 (잔량 %, 전원 연결). 배터리가 없거나 알 수 없으면 None.
#[cfg(windows)]
fn battery() -> Option<(u8, bool)> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return None;
    }
    // BatteryFlag 128 = 배터리 없음, 255 = 알 수 없음. BatteryLifePercent 255 = 알 수 없음.
    if s.BatteryFlag & 128 != 0 || s.BatteryFlag == 255 || s.BatteryLifePercent > 100 {
        return None;
    }
    Some((s.BatteryLifePercent, s.ACLineStatus == 1))
}

/// 지금 시스템 사용률을 잰다.
///
/// # 반환
/// 잰 값들. Windows 가 아니면 모두 None.
#[cfg(windows)]
fn measure() -> SysStats {
    let (mem_used, mem_total) = mem().map_or((None, None), |(u, t)| (Some(u), Some(t)));
    let (battery, charging) = battery().map_or((None, None), |(p, c)| (Some(p), Some(c)));
    SysStats { cpu: cpu(), mem_used, mem_total, battery, charging }
}

#[cfg(not(windows))]
fn measure() -> SysStats {
    SysStats::default()
}

/// 상태 바가 2초마다 부르는 명령.
///
/// # 반환
/// CPU·메모리·배터리. 못 잰 칸은 None.
#[tauri::command]
pub fn sys_stats() -> SysStats {
    measure()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn measures_memory_and_cpu_on_second_call() {
        let _ = measure();
        std::thread::sleep(std::time::Duration::from_millis(120));
        let s = measure();
        let (u, t) = (s.mem_used.unwrap(), s.mem_total.unwrap());
        assert!(t > 0 && u <= t);
        let c = s.cpu.unwrap();
        assert!((0.0..=100.0).contains(&c));
    }
}
