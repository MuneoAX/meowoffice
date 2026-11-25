//! 본체(Rust) 사용자 문구 다국어(한국어·영어).
//!
//! 화면 JS 는 `ui/i18n/i18n.js` 의 `t('영역.항목')` 을 쓰고, 이 모듈은 같은 키 이름 방식(소문자·점 구분, 예: `tray.office`)으로
//! 본체가 만드는 문구(트레이 메뉴·툴팁, 알림 카드, 화면 토스트로 나가는 오류, 상태 표시, 대화 상자 …)를 번역한다.
//!
//! # 쓰는 법
//! - 고정 문구: `i18n::t("tray.office")` → `&'static str`. 현재 언어에 없으면 한국어, 한국어에도 없으면 키 자체를 돌려준다.
//! - 자리표시 문구: `i18n::tf("tip.permits", &[("n", &n.to_string())])` → 문구 속 `{n}` 을 값으로 바꾼 `String`.
//! - 새 문구는 `i18n/table.rs` 의 `TABLE` 에 `("키", "한국어", "English")` 한 줄로 더한다(키는 표에서 유일해야 하며 테스트가 검사).
//!   한국어·영어 문구의 `{자리표시}` 이름은 같아야 한다(테스트가 검사).
//!
//! # 언어 정하기
//! - 시작할 때: 설정 `lang`("auto"|"ko"|"en") — auto 면 OS 언어(한국어면 ko, 그 밖은 en). `init` 이 한 번 부른다.
//! - 실행 중: 화면이 `set_lang` 명령으로 알려 주는 값이 우선(`set`).
//! - 로그(`log::*`)·테스트 데이터·외부 프로토콜 값은 번역하지 않는다.

use std::sync::atomic::{AtomicU8, Ordering};

mod table;

/// 지원 언어.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    /// 한국어.
    Ko,
    /// 영어.
    En,
}

impl Lang {
    /// 언어 코드("ko"|"en")에서 `Lang` 을 만든다. 그 밖의 값은 None.
    pub fn parse(code: &str) -> Option<Lang> {
        match code.trim().to_ascii_lowercase().as_str() {
            "ko" => Some(Lang::Ko),
            "en" => Some(Lang::En),
            _ => None,
        }
    }

    /// 언어 코드 문자열.
    pub fn code(self) -> &'static str {
        match self {
            Lang::Ko => "ko",
            Lang::En => "en",
        }
    }
}

/// 현재 언어(0 = 한국어, 1 = 영어). 초기값은 한국어이며 `init` 이 정한다.
static CURRENT: AtomicU8 = AtomicU8::new(0);

/// 현재 언어.
pub fn lang() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == 1 {
        Lang::En
    } else {
        Lang::Ko
    }
}

/// 현재 언어를 바꾼다.
pub fn set(l: Lang) {
    CURRENT.store(if l == Lang::En { 1 } else { 0 }, Ordering::Relaxed);
}

/// OS 언어로 정한 언어: 한국어면 ko, 그 밖(읽지 못함 포함)은 en.
pub fn os_lang() -> Lang {
    match sys_locale::get_locale() {
        Some(l) if l.trim().to_ascii_lowercase().starts_with("ko") => Lang::Ko,
        _ => Lang::En,
    }
}

/// 사용자가 고른 값("auto"|"ko"|"en")을 실제 언어로 바꾼다. 알 수 없는 값은 auto 로 본다.
pub fn resolve(choice: &str) -> Lang {
    Lang::parse(choice).unwrap_or_else(os_lang)
}

/// 시작 언어를 설정값(`Config::lang`)으로 정한다. `main` 의 시작 루틴이 한 번 부른다.
pub fn init(choice: &str) {
    set(resolve(choice));
}

/// 키의 현재 언어 문구. 현재 언어에 없으면 한국어, 그래도 없으면 키 자체.
pub fn t(key: &'static str) -> &'static str {
    t_in(lang(), key)
}

/// 지정한 언어의 문구(전역 언어를 건드리지 않음).
pub fn t_in(l: Lang, key: &'static str) -> &'static str {
    for (k, ko, en) in table::TABLE {
        if *k == key {
            return if l == Lang::En && !en.is_empty() { en } else { ko };
        }
    }
    key
}

/// `t` 의 결과에서 `{이름}` 자리를 값으로 바꾼 문구.
///
/// # 인자
/// - `key`: 문구 키
/// - `args`: (이름, 값) 목록. 문구에 없는 이름은 무시, 값이 없는 `{이름}` 은 그대로 둔다.
pub fn tf(key: &'static str, args: &[(&str, &str)]) -> String {
    tf_in(lang(), key, args)
}

/// `tf` 의 지정 언어 판.
pub fn tf_in(l: Lang, key: &'static str, args: &[(&str, &str)]) -> String {
    let mut s = t_in(l, key).to_string();
    for (name, val) in args {
        s = s.replace(&format!("{{{name}}}"), val);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 문구 속 `{이름}` 자리표시 목록(정렬).
    fn holes(s: &str) -> Vec<String> {
        let mut v = Vec::new();
        let mut rest = s;
        while let Some(i) = rest.find('{') {
            let Some(j) = rest[i..].find('}') else { break };
            v.push(rest[i + 1..i + j].to_string());
            rest = &rest[i + j + 1..];
        }
        v.sort();
        v
    }

    #[test]
    fn table_is_consistent() {
        let mut seen = std::collections::HashSet::new();
        for (k, ko, en) in table::TABLE {
            assert!(seen.insert(*k), "중복 키: {k}");
            assert!(!ko.is_empty() && !en.is_empty(), "빈 문구: {k}");
            assert_eq!(holes(ko), holes(en), "자리표시 불일치: {k}");
            assert!(!en.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)), "영어 문구에 한글: {k}");
        }
    }

    #[test]
    fn fallback_and_placeholders() {
        assert_eq!(t_in(Lang::Ko, "없는.키"), "없는.키");
        assert_eq!(tf_in(Lang::En, "tip.permits", &[("n", "3")]), "3 permission request(s)");
        assert_eq!(tf_in(Lang::Ko, "tip.permits", &[("n", "3")]), "권한 요청 3건");
        assert_eq!(resolve("ko"), Lang::Ko);
        assert_eq!(resolve("en"), Lang::En);
    }
}
