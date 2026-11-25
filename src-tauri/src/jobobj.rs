//! Windows Job Object — 채팅 실행기가 띄운 자식 프로세스(claude·codex app-server)와 그 후손을 한 묶음으로 관리.
//! `KILL_ON_JOB_CLOSE` 라서 앱이 비정상 종료해도(핸들이 닫히면) 자식이 남지 않고, `terminate` 로 프로세스 트리를 한 번에 끝낸다.
//! Windows 가 아니면 아무것도 하지 않는다(종료는 호출한 쪽이 `Child::kill` 로 대신).

/// 프로세스 묶음 핸들. 닫히면(Drop) 묶음 안의 프로세스가 모두 종료된다.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// 핸들은 스레드 사이로 옮겨도 안전(커널 객체).
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// `KILL_ON_JOB_CLOSE` 가 켜진 새 Job 을 만든다.
    ///
    /// # 반환
    /// 만들었으면 `Some`. 생성·설정 실패는 None(호출한 쪽이 `Child::kill` 로 대신).
    pub fn new() -> Option<Job> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job { handle })
        }
    }

    /// 자식 프로세스를 이 Job 에 넣는다.
    ///
    /// # 인자
    /// - `child`: 방금 띄운 자식
    ///
    /// # 반환
    /// 넣었으면 true.
    pub fn assign(&self, child: &std::process::Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as _) != 0 }
    }

    /// Job 안의 모든 프로세스 pid(후손 포함). 조회 실패는 빈 목록.
    ///
    /// `claude.cmd` 로 띄우면 `Child::id()` 는 cmd.exe 라서, 세션 파일(`sessions/<pid>.json`)을 쓰는 후손 node 의 pid 는 여기서만 얻는다.
    pub fn pids(&self) -> Vec<u32> {
        use windows_sys::Win32::System::JobObjects::{JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST};
        // 머리(2×u32) + pid 배열. 64개를 넘는 묶음은 앞쪽 64개만(턴 하나의 프로세스 수로 충분).
        const CAP: usize = 64;
        let mut buf = vec![0u64; 1 + CAP];
        unsafe {
            let ok = QueryInformationJobObject(
                self.handle,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                (buf.len() * std::mem::size_of::<u64>()) as u32,
                std::ptr::null_mut(),
            );
            // 목록이 모자라면 FALSE(ERROR_MORE_DATA) 여도 채워진 만큼은 유효하다.
            let p = buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST;
            let n = ((*p).NumberOfProcessIdsInList as usize).min(CAP);
            if ok == 0 && n == 0 {
                return Vec::new();
            }
            let list = std::ptr::addr_of!((*p).ProcessIdList) as *const usize;
            (0..n).map(|i| *list.add(i) as u32).collect()
        }
    }

    /// Job 안의 프로세스를 모두 즉시 종료한다.
    pub fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
impl Job {
    /// Windows 가 아니면 Job 을 만들지 않는다.
    pub fn new() -> Option<Job> {
        None
    }
    /// 아무것도 하지 않음.
    pub fn assign(&self, _child: &std::process::Child) -> bool {
        false
    }
    /// 빈 목록.
    pub fn pids(&self) -> Vec<u32> {
        Vec::new()
    }
    /// 아무것도 하지 않음.
    pub fn terminate(&self) {}
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    /// Job 에 넣은 자식이 terminate 로 끝나는지 확인한다.
    #[test]
    fn terminate_kills_child() {
        let mut child = std::process::Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1 >nul"]).creation_flags(0x0800_0000).spawn().unwrap();
        let job = Job::new().expect("job");
        assert!(job.assign(&child));
        job.terminate();
        let st = child.wait().unwrap();
        assert!(!st.success());
    }

    /// Job 의 pid 목록에 자식(cmd)과 그 후손(ping)이 함께 잡히는지 확인한다.
    #[test]
    fn pids_include_descendants() {
        let mut child = std::process::Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1 >nul"]).creation_flags(0x0800_0000).spawn().unwrap();
        let job = Job::new().expect("job");
        assert!(job.assign(&child));
        let mut pids = Vec::new();
        for _ in 0..30 {
            pids = job.pids();
            if pids.len() >= 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(pids.contains(&child.id()), "{pids:?}");
        assert!(pids.len() >= 2, "{pids:?}");
        job.terminate();
        let _ = child.wait();
    }
}
