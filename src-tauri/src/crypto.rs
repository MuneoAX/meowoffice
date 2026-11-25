//! 로컬 비밀 암호화 — Windows DPAPI(현재 사용자 계정·머신에 묶임).
//! admin_api_key 를 평문으로 디스크에 두지 않기 위함. 같은 사용자만 복호 가능.

/// Windows DPAPI(crypt32)·LocalFree(kernel32) 의 FFI 선언 모음.
#[cfg(windows)]
mod sys {
    use std::os::raw::c_void;

    /// DPAPI 가 입출력에 쓰는 `DATA_BLOB`(길이 + 바이트 포인터) 구조체.
    ///
    /// `CryptProtectData`·`CryptUnprotectData` 에 넘기며, 출력 블롭의 메모리는 `LocalFree` 로 해제해야 한다.
    #[repr(C)]
    pub struct DataBlob {
        /// `pb` 가 가리키는 바이트 수.
        pub cb: u32,
        /// 바이트 버퍼 시작 주소(없으면 null).
        pub pb: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        /// 평문 블롭을 현재 사용자 계정에 묶어 암호화하는 Windows API.
        ///
        /// # 반환
        /// 성공하면 0 이 아닌 값, 실패하면 0. 성공 시 `data_out` 의 버퍼는 호출자가 `LocalFree` 로 해제한다.
        ///
        /// # 참조
        /// `encrypt` 가 호출.
        pub fn CryptProtectData(
            data_in: *const DataBlob,
            desc: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        /// `CryptProtectData` 로 만든 암호문을 복호하는 Windows API.
        ///
        /// # 반환
        /// 성공하면 0 이 아닌 값, 실패하면 0. 성공 시 `data_out` 의 버퍼는 호출자가 `LocalFree` 로 해제한다.
        ///
        /// # 참조
        /// `decrypt` 가 호출.
        pub fn CryptUnprotectData(
            data_in: *const DataBlob,
            desc_out: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// Windows API 가 할당해 돌려준 버퍼를 해제한다.
        ///
        /// # 참조
        /// `encrypt`, `decrypt` 가 출력 블롭을 복사한 뒤 호출.
        pub fn LocalFree(h: *mut c_void) -> *mut c_void;
    }
}

/// 바이트열을 소문자 16진수 문자열로 바꾼다.
///
/// # 인자
/// - `b`: 변환할 바이트
///
/// # 반환
/// 바이트당 2글자인 16진수 문자열.
///
/// # 참조
/// `encrypt` 가 호출.
#[cfg(windows)]
fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// 16진수 문자열을 바이트열로 되돌린다.
///
/// # 인자
/// - `s`: 16진수 문자열(ASCII, 길이는 짝수)
///
/// # 반환
/// 변환된 바이트. 비 ASCII·홀수 길이·16진수가 아닌 글자가 있으면 None.
///
/// # 참조
/// `decrypt` 가 호출.
#[cfg(windows)]
fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// 평문을 Windows DPAPI 로 암호화해 16진수 문자열로 돌려준다.
///
/// 평문 바이트를 `DataBlob` 으로 감싸 `CryptProtectData` 로 암호화하고, 출력 블롭을 복사해 `LocalFree` 로 해제한 뒤 16진수로 바꾼다.
/// 결과는 같은 사용자 계정·머신에서만 복호할 수 있다.
///
/// # 인자
/// - `plain`: 암호화할 평문 문자열
///
/// # 반환
/// 암호문의 16진수 문자열. API 실패나 출력이 없으면 None.
///
/// # 참조
/// `to_hex`, `sys::CryptProtectData`, `sys::LocalFree`. `config::set_admin_key` 가 호출.
#[cfg(windows)]
pub fn encrypt(plain: &str) -> Option<String> {
    use std::os::raw::c_void;
    use std::ptr;
    unsafe {
        let mut input = plain.as_bytes().to_vec();
        let blob_in = sys::DataBlob { cb: input.len() as u32, pb: input.as_mut_ptr() };
        let mut out = sys::DataBlob { cb: 0, pb: ptr::null_mut() };
        let ok = sys::CryptProtectData(&blob_in, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 0, &mut out);
        if ok == 0 || out.pb.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out.pb, out.cb as usize).to_vec();
        sys::LocalFree(out.pb as *mut c_void);
        Some(to_hex(&bytes))
    }
}

/// `encrypt` 가 만든 16진수 암호문을 평문으로 복호한다.
///
/// 16진수를 바이트로 되돌린 뒤 `CryptUnprotectData` 로 복호하고, 출력 블롭을 복사해 `LocalFree` 로 해제한 뒤 UTF-8 문자열로 해석한다.
///
/// # 인자
/// - `hex`: `encrypt` 의 결과 형식(16진수) 문자열
///
/// # 반환
/// 평문. 16진수가 잘못됐거나 다른 사용자·머신에서 만든 암호문이거나 UTF-8 이 아니면 None.
///
/// # 참조
/// `from_hex`, `sys::CryptUnprotectData`, `sys::LocalFree`. `config::admin_key` 가 호출.
#[cfg(windows)]
pub fn decrypt(hex: &str) -> Option<String> {
    use std::os::raw::c_void;
    use std::ptr;
    let mut data = from_hex(hex)?;
    unsafe {
        let blob_in = sys::DataBlob { cb: data.len() as u32, pb: data.as_mut_ptr() };
        let mut out = sys::DataBlob { cb: 0, pb: ptr::null_mut() };
        let ok = sys::CryptUnprotectData(&blob_in, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 0, &mut out);
        if ok == 0 || out.pb.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out.pb, out.cb as usize).to_vec();
        sys::LocalFree(out.pb as *mut c_void);
        String::from_utf8(bytes).ok()
    }
}

/// Windows 가 아닌 OS: 암호화 수단이 없으므로 항상 None.
///
/// # 인자
/// - `_plain`: 사용하지 않음
///
/// # 반환
/// 항상 None(`config::set_admin_key` 는 이 OS 에서 이 함수를 쓰지 않고 평문 접두를 붙임).
#[cfg(not(windows))]
pub fn encrypt(_plain: &str) -> Option<String> {
    None
}
/// Windows 가 아닌 OS: 복호 수단이 없으므로 항상 None.
///
/// # 인자
/// - `_hex`: 사용하지 않음
///
/// # 반환
/// 항상 None.
#[cfg(not(windows))]
pub fn decrypt(_hex: &str) -> Option<String> {
    None
}
