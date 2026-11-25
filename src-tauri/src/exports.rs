//! 공식 내보내기 파일(ChatGPT·Claude·Gemini Takeout) 사용 리포트.
//!
//! 사용자가 고른 내보내기 파일(zip·json·html)을 이 PC 안에서만 읽어 일별 집계로 만든다.
//! 대화 본문은 메모리에서 글자 수만 세고 버린다. 저장·전송·로그 금지.
//! 지원 형식:
//! - ChatGPT: `conversations.json`(또는 샤드 `conversations-000.json`…), 대화마다 `mapping{노드: {message}}`.
//! - Claude: `conversations.json`, 대화마다 `chat_messages[]`(모델 정보 없음).
//! - Gemini(Google Takeout 내 활동): `MyActivity.json` 또는 `.html`(대화 구분·모델 정보 없음).
//!
//! 형식을 실제 파일로 확인하지 못한 부분(Gemini HTML 한국어 날짜 등)은 관대하게 파싱하고 못 읽은 것은 건너뜀·날짜 없음으로 센다.

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::Path;
use std::rc::Rc;
use tauri::{AppHandle, Emitter};

/// 하루치 집계(UI 로 가는 JSON 과 저장 파일 모양이 같다).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayRow {
    /// 날짜 "YYYY-MM-DD".
    pub d: String,
    /// 그날 시작된 대화 수.
    pub convs: u32,
    /// 사용자 메시지 수.
    pub user: u32,
    /// AI 메시지 수.
    pub ai: u32,
    /// 추정 토큰(글자 수 기반).
    pub tok: u64,
}

/// 모델별 AI 메시지 수.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRow {
    /// 모델 이름.
    pub model: String,
    /// AI 메시지 수.
    pub msgs: u64,
}

/// 내보내기 파일 하나의 분석 결과(집계만, 본문 없음).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportReport {
    /// "chatgpt" | "claude" | "gemini".
    pub provider: String,
    /// 파일 이름만(경로 제외).
    pub file: String,
    /// 분석 시각(로컬 RFC3339).
    pub analyzed_at: String,
    /// 활동이 있던 첫 날.
    pub first_day: Option<String>,
    /// 활동이 있던 마지막 날.
    pub last_day: Option<String>,
    /// 대화 수(Gemini 는 None).
    pub conversations: Option<u64>,
    /// 사용자 메시지 수.
    pub user_msgs: u64,
    /// AI 메시지 수.
    pub ai_msgs: u64,
    /// 사용자 글 추정 토큰.
    pub user_tokens: u64,
    /// AI 글 추정 토큰.
    pub ai_tokens: u64,
    /// 활동 있는 날만, 날짜 오름차순.
    pub daily: Vec<DayRow>,
    /// 모델별 메시지 수(많은 순). 모델 정보가 없으면 빈 배열.
    pub models: Vec<ModelRow>,
    /// [요일(월=0)][시] = 사용자 메시지 수.
    pub heat: [[u32; 24]; 7],
    /// 알아볼 수 없어 건너뛴 항목 수.
    pub skipped: u64,
    /// 날짜를 읽지 못한 메시지 수.
    pub undated: u64,
    /// 파일이 중간에 끊겨 읽은 데까지만 센 경우 true.
    pub partial: bool,
}

/// 시간대 선택(테스트는 고정 오프셋).
#[derive(Clone, Copy)]
pub(crate) enum Tz {
    /// 이 PC 의 시간대.
    Local,
    /// 고정 오프셋(테스트 전용).
    #[cfg_attr(not(test), allow(dead_code))]
    Fixed(FixedOffset),
}

impl Tz {
    /// UTC 시각을 이 시간대의 달력 시각으로 바꾼다.
    ///
    /// # 인자
    /// - `t`: UTC 시각
    ///
    /// # 반환
    /// 시간대 적용된 날짜·시각.
    fn naive(&self, t: DateTime<Utc>) -> NaiveDateTime {
        match self {
            Tz::Local => t.with_timezone(&chrono::Local).naive_local(),
            Tz::Fixed(o) => t.with_timezone(o).naive_local(),
        }
    }
}

/// 내보내기 종류.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Chatgpt,
    Claude,
    Gemini,
}

/// 하루 누적(글자 수는 ASCII·그 외로 나눠 센다).
#[derive(Default)]
struct DayAcc {
    convs: u32,
    user: u32,
    ai: u32,
    ascii: u64,
    wide: u64,
}

/// 집계기. 항목을 하나씩 먹이고 `finish` 로 리포트를 만든다.
struct Agg {
    tz: Tz,
    kind: Option<Kind>,
    days: BTreeMap<NaiveDate, DayAcc>,
    heat: [[u32; 24]; 7],
    models: HashMap<String, u64>,
    seen: HashSet<String>,
    conversations: u64,
    user_msgs: u64,
    ai_msgs: u64,
    user_ascii: u64,
    user_wide: u64,
    ai_ascii: u64,
    ai_wide: u64,
    skipped: u64,
    undated: u64,
    /// 읽은 항목 수(진행 표시가 파싱 중에도 읽을 수 있게 공유 칸).
    items: Rc<Cell<u64>>,
}

/// 글자 수를 센다.
///
/// # 인자
/// - `s`: 글
///
/// # 반환
/// (ASCII 글자 수, 그 밖의 글자 수).
fn count_chars(s: &str) -> (u64, u64) {
    let ascii = s.bytes().filter(|b| *b < 0x80).count() as u64;
    (ascii, s.chars().count() as u64 - ascii)
}

/// 글자 수로 토큰을 어림한다(영문·숫자 4글자 ≈ 1토큰, 그 밖 3글자 ≈ 2토큰).
///
/// # 인자
/// - `ascii`: ASCII 글자 수
/// - `wide`: 그 밖의 글자 수
///
/// # 반환
/// 추정 토큰 수.
fn est_tokens(ascii: u64, wide: u64) -> u64 {
    (ascii + 3) / 4 + (wide * 2 + 2) / 3
}

/// 값에서 시각을 읽는다.
///
/// 숫자(초, 1e11 초과면 밀리초)·ISO 문자열·숫자 문자열을 받는다.
///
/// # 인자
/// - `v`: JSON 값
///
/// # 반환
/// UTC 시각. 못 읽으면 None.
fn parse_time(v: &Value) -> Option<DateTime<Utc>> {
    match v {
        Value::Number(n) => {
            let x = n.as_f64()?;
            if !(x > 0.0) {
                return None;
            }
            let ms = if x > 1e11 { x as i64 } else { (x * 1000.0) as i64 };
            DateTime::<Utc>::from_timestamp_millis(ms)
        }
        Value::String(s) => {
            let s = s.trim();
            if let Ok(t) = DateTime::parse_from_rfc3339(s) {
                return Some(t.with_timezone(&Utc));
            }
            if let Ok(t) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
                return Some(Utc.from_utc_datetime(&t));
            }
            s.parse::<f64>().ok().and_then(|f| parse_time(&serde_json::json!(f)))
        }
        _ => None,
    }
}

/// `<`…`>` 구간만 제거한다(엔티티는 그대로).
///
/// # 인자
/// - `s`: HTML 조각
///
/// # 반환
/// 태그를 뺀 글.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Takeout 활동 날짜 문구를 읽는다(영어 "Nov 3, 2025, 10:12:13 AM KST", 한국어 "2025. 11. 3. 오후 5:14:40 KST").
///
/// 적힌 그대로의 로컬 시각으로 보고 시간대 변환은 하지 않는다.
///
/// # 인자
/// - `s`: 날짜 문구
///
/// # 반환
/// 날짜·시각. 못 읽으면 None.
fn parse_takeout_date(s: &str) -> Option<NaiveDateTime> {
    let s = s.replace(['\u{a0}', '\u{202f}'], " ").replace("&nbsp;", " ");
    let mut toks: Vec<&str> = s.split_whitespace().collect();
    if let Some(last) = toks.last() {
        let up = last.to_ascii_uppercase();
        if up != "AM" && up != "PM" && last.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            toks.pop();
        }
    }
    let s = toks.join(" ");
    if let Ok(t) = NaiveDateTime::parse_from_str(&s, "%b %d, %Y, %I:%M:%S %p") {
        return Some(t);
    }
    let k = s.replace("오전", "AM").replace("오후", "PM");
    NaiveDateTime::parse_from_str(&k, "%Y. %m. %d. %p %I:%M:%S").ok()
}

impl Agg {
    /// 빈 집계기를 만든다.
    ///
    /// # 인자
    /// - `tz`: 날짜·시각을 읽을 시간대
    fn new(tz: Tz) -> Self {
        Agg {
            tz,
            kind: None,
            days: BTreeMap::new(),
            heat: [[0; 24]; 7],
            models: HashMap::new(),
            seen: HashSet::new(),
            conversations: 0,
            user_msgs: 0,
            ai_msgs: 0,
            user_ascii: 0,
            user_wide: 0,
            ai_ascii: 0,
            ai_wide: 0,
            skipped: 0,
            undated: 0,
            items: Rc::new(Cell::new(0)),
        }
    }

    /// 메시지 하나를 센다.
    ///
    /// # 인자
    /// - `user`: 사용자 메시지면 true
    /// - `when`: 시각(없으면 날짜 없음으로 셈)
    /// - `ascii`, `wide`: 글자 수
    /// - `model`: AI 메시지의 모델 이름(있을 때만)
    fn msg(&mut self, user: bool, when: Option<NaiveDateTime>, ascii: u64, wide: u64, model: Option<&str>) {
        if user {
            self.user_msgs += 1;
            self.user_ascii += ascii;
            self.user_wide += wide;
        } else {
            self.ai_msgs += 1;
            self.ai_ascii += ascii;
            self.ai_wide += wide;
            if let Some(m) = model.filter(|m| !m.is_empty()) {
                *self.models.entry(m.to_string()).or_insert(0) += 1;
            }
        }
        match when {
            Some(t) => {
                let d = self.days.entry(t.date()).or_default();
                if user {
                    d.user += 1;
                    self.heat[t.weekday().num_days_from_monday() as usize][t.hour() as usize] += 1;
                } else {
                    d.ai += 1;
                }
                d.ascii += ascii;
                d.wide += wide;
            }
            None => self.undated += 1,
        }
    }

    /// 대화 하나를 센다.
    ///
    /// # 인자
    /// - `when`: 대화 시작 시각
    fn conv(&mut self, when: Option<NaiveDateTime>) {
        self.conversations += 1;
        if let Some(t) = when {
            self.days.entry(t.date()).or_default().convs += 1;
        }
    }

    /// 항목 하나(대화 또는 활동 기록)를 모양으로 서비스를 판별해 센다.
    ///
    /// 처음 판별된 서비스로 고정되고 다른 모양은 건너뛴 항목으로 센다.
    ///
    /// # 인자
    /// - `v`: JSON 항목
    fn item(&mut self, v: &Value) {
        self.items.set(self.items.get() + 1);
        let Some(o) = v.as_object().filter(|o| !o.is_empty()) else {
            self.skipped += 1;
            return;
        };
        let shape = if o.get("mapping").is_some_and(|m| m.is_object()) {
            Some(Kind::Chatgpt)
        } else if o.get("chat_messages").is_some_and(|m| m.is_array()) || (o.get("messages").is_some_and(|m| m.is_array()) && o.contains_key("uuid")) {
            Some(Kind::Claude)
        } else if o.get("time").is_some_and(|t| t.is_string()) && (o.contains_key("title") || o.contains_key("header")) {
            Some(Kind::Gemini)
        } else {
            None
        };
        let Some(shape) = shape else {
            self.skipped += 1;
            return;
        };
        if *self.kind.get_or_insert(shape) != shape {
            self.skipped += 1;
            return;
        }
        match shape {
            Kind::Chatgpt => self.chatgpt(v),
            Kind::Claude => self.claude(v),
            Kind::Gemini => self.gemini(v),
        }
    }

    /// 중복 대화 id 인지 확인하고 처음 보는 id 면 기록한다.
    ///
    /// # 반환
    /// 이미 본 id 면 true.
    fn dup(&mut self, id: Option<&str>) -> bool {
        match id {
            Some(id) => !self.seen.insert(id.to_string()),
            None => false,
        }
    }

    /// ChatGPT 대화 하나를 센다(가지도 전부, 숨김·도구 호출·생각 과정 제외).
    fn chatgpt(&mut self, c: &Value) {
        let id = c.get("conversation_id").or_else(|| c.get("id")).and_then(|x| x.as_str());
        if self.dup(id) {
            return;
        }
        let conv_time = c.get("create_time").and_then(parse_time).map(|t| self.tz.naive(t));
        let default_model = c.get("default_model_slug").and_then(|x| x.as_str());
        let Some(mapping) = c.get("mapping").and_then(|m| m.as_object()) else { return };
        let mut counted = 0u32;
        let mut first: Option<NaiveDateTime> = None;
        for node in mapping.values() {
            let Some(m) = node.get("message").filter(|m| m.is_object()) else { continue };
            if m.pointer("/metadata/is_visually_hidden_from_conversation").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            const SKIP: [&str; 8] = [
                "user_editable_context", "model_editable_context", "tether_browsing_display", "tether_browsing_code",
                "sonic_webpage", "system_error", "thoughts", "reasoning_recap",
            ];
            let ctype = m.pointer("/content/content_type").and_then(|x| x.as_str()).unwrap_or("");
            if SKIP.contains(&ctype) {
                continue;
            }
            let role = m.pointer("/author/role").and_then(|x| x.as_str()).unwrap_or("");
            let user = match role {
                "user" => true,
                "assistant" => false,
                _ => continue,
            };
            if !user && m.get("recipient").and_then(|x| x.as_str()).is_some_and(|r| r != "all") {
                continue;
            }
            let (mut a, mut w) = (0u64, 0u64);
            let mut nonspace = false;
            let mut obj_part = false;
            let mut add = |s: &str| {
                let (x, y) = count_chars(s);
                a += x;
                w += y;
                if !s.trim().is_empty() {
                    nonspace = true;
                }
            };
            let parts = m.pointer("/content/parts").and_then(|p| p.as_array());
            if let Some(parts) = parts {
                for p in parts {
                    match p {
                        Value::String(s) => add(s),
                        Value::Object(o) => {
                            obj_part = true;
                            if let Some(s) = o.get("text").and_then(|x| x.as_str()) {
                                add(s);
                            }
                        }
                        _ => {}
                    }
                }
            }
            if let Some(s) = m.pointer("/content/text").and_then(|x| x.as_str()) {
                add(s);
            }
            if user {
                if parts.is_none_or(|p| p.is_empty()) {
                    continue;
                }
            } else if !nonspace && !obj_part {
                continue;
            }
            let when = m.get("create_time").and_then(parse_time).map(|t| self.tz.naive(t)).or(conv_time);
            let model = if user { None } else { m.pointer("/metadata/model_slug").and_then(|x| x.as_str()).or(default_model) };
            if first.is_none() {
                first = when;
            }
            counted += 1;
            self.msg(user, when, a, w, model);
        }
        if counted > 0 {
            self.conv(conv_time.or(first));
        }
    }

    /// Claude 대화 하나를 센다(생각 과정·도구 호출 글 제외, 사용자 첨부 글 포함).
    fn claude(&mut self, c: &Value) {
        let id = c.get("uuid").or_else(|| c.get("id")).and_then(|x| x.as_str());
        if self.dup(id) {
            return;
        }
        let conv_time = c.get("created_at").and_then(parse_time).map(|t| self.tz.naive(t));
        let conv_model = c.get("model").and_then(|x| x.as_str());
        let Some(msgs) = c.get("chat_messages").or_else(|| c.get("messages")).and_then(|m| m.as_array()) else { return };
        for m in msgs {
            let role = m.get("sender").or_else(|| m.get("role")).and_then(|x| x.as_str()).unwrap_or("");
            let user = match role {
                "human" | "user" => true,
                "assistant" => false,
                _ => continue,
            };
            let (mut a, mut w) = (0u64, 0u64);
            let mut found = false;
            match m.get("content") {
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        let ty = b.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        if ty == "text" || ty == "voice_note" {
                            if let Some(s) = b.get("text").and_then(|x| x.as_str()) {
                                let (x, y) = count_chars(s);
                                a += x;
                                w += y;
                                found = true;
                            }
                        }
                    }
                }
                Some(Value::String(s)) => {
                    let (x, y) = count_chars(s);
                    a += x;
                    w += y;
                    found = true;
                }
                _ => {}
            }
            if !found {
                if let Some(s) = m.get("text").and_then(|x| x.as_str()) {
                    let (x, y) = count_chars(s);
                    a += x;
                    w += y;
                }
            }
            if user {
                if let Some(att) = m.get("attachments").and_then(|x| x.as_array()) {
                    for at in att {
                        if let Some(s) = at.get("extracted_content").and_then(|x| x.as_str()) {
                            let (x, y) = count_chars(s);
                            a += x;
                            w += y;
                        }
                    }
                }
            }
            let when = m.get("created_at").and_then(parse_time).map(|t| self.tz.naive(t)).or(conv_time);
            self.msg(user, when, a, w, if user { None } else { conv_model });
        }
        self.conv(conv_time);
    }

    /// Gemini 활동(JSON) 항목 하나를 센다.
    fn gemini(&mut self, e: &Value) {
        let is_gemini = |s: &str| {
            let l = s.to_lowercase();
            l.contains("gemini") || l.contains("bard")
        };
        let from_header = e.get("header").and_then(|x| x.as_str()).is_some_and(is_gemini);
        let from_products = e.get("products").and_then(|x| x.as_array()).is_some_and(|p| p.iter().any(|x| x.as_str().is_some_and(is_gemini)));
        if !from_header && !from_products {
            self.skipped += 1;
            return;
        }
        let mut resp = String::new();
        if let Some(items) = e.get("safeHtmlItem").and_then(|x| x.as_array()) {
            for it in items {
                if let Some(h) = it.get("html").and_then(|x| x.as_str()) {
                    resp.push_str(&strip_tags(h));
                }
            }
        }
        let title = e.get("title").and_then(|x| x.as_str()).unwrap_or("");
        if resp.trim().is_empty() && !title.starts_with("Prompted ") {
            self.skipped += 1;
            return;
        }
        let when = e.get("time").and_then(parse_time).map(|t| self.tz.naive(t));
        let prompt = title.strip_prefix("Prompted ").unwrap_or(title);
        let (a, w) = count_chars(prompt);
        self.msg(true, when, a, w, None);
        if !resp.trim().is_empty() {
            let (a, w) = count_chars(&resp);
            self.msg(false, when, a, w, None);
        }
    }

    /// 집계를 끝내 리포트로 만든다.
    ///
    /// # 인자
    /// - `file`: 파일 이름
    /// - `partial`: 읽다가 끊겼는지
    fn finish(self, file: &str, partial: bool) -> ExportReport {
        let provider = match self.kind {
            Some(Kind::Chatgpt) => "chatgpt",
            Some(Kind::Claude) => "claude",
            _ => "gemini",
        };
        let daily: Vec<DayRow> = self
            .days
            .iter()
            .map(|(d, a)| DayRow { d: d.format("%Y-%m-%d").to_string(), convs: a.convs, user: a.user, ai: a.ai, tok: est_tokens(a.ascii, a.wide) })
            .collect();
        let mut models: Vec<ModelRow> = self.models.into_iter().map(|(model, msgs)| ModelRow { model, msgs }).collect();
        models.sort_by(|a, b| b.msgs.cmp(&a.msgs).then_with(|| a.model.cmp(&b.model)));
        ExportReport {
            provider: provider.to_string(),
            file: file.to_string(),
            analyzed_at: chrono::Local::now().to_rfc3339(),
            first_day: daily.first().map(|d| d.d.clone()),
            last_day: daily.last().map(|d| d.d.clone()),
            conversations: if self.kind == Some(Kind::Gemini) { None } else { Some(self.conversations) },
            user_msgs: self.user_msgs,
            ai_msgs: self.ai_msgs,
            user_tokens: est_tokens(self.user_ascii, self.user_wide),
            ai_tokens: est_tokens(self.ai_ascii, self.ai_wide),
            daily,
            models,
            heat: self.heat,
            skipped: self.skipped,
            undated: self.undated,
            partial,
        }
    }
}

/// Takeout HTML 한 장을 집계에 먹인다(HTML 파서 없이 문자열 처리).
///
/// `outer-cell` 칸마다: 제품 이름에 gemini/bard 가 없으면 건너뜀, 본문을 `<br>` 로 나눠
/// 날짜로 읽히는 첫 조각 앞은 프롬프트·뒤는 응답으로 본다. 날짜가 없으면 첫 조각이 프롬프트.
///
/// # 인자
/// - `html`: 파일 내용
/// - `agg`: 집계기
fn feed_html(html: &str, agg: &mut Agg) {
    if agg.kind.is_none() {
        agg.kind = Some(Kind::Gemini);
    }
    for cell in html.split("class=\"outer-cell").skip(1) {
        agg.items.set(agg.items.get() + 1);
        let product = cell
            .split_once("mdl-typography--title")
            .and_then(|(_, r)| r.split_once('>'))
            .and_then(|(_, r)| r.split_once("</p>"))
            .map(|(t, _)| t.to_lowercase())
            .unwrap_or_default();
        if !product.contains("gemini") && !product.contains("bard") {
            agg.skipped += 1;
            continue;
        }
        let Some((_, rest)) = cell.split_once("content-cell") else {
            agg.skipped += 1;
            continue;
        };
        let rest = rest.split_once('>').map(|(_, r)| r).unwrap_or("");
        let body = rest.split("content-cell").next().unwrap_or(rest);
        let body = body.replace("<br/>", "<br>").replace("<br />", "<br>");
        let pieces: Vec<String> = body.split("<br>").map(|p| strip_tags(p).trim().to_string()).filter(|p| !p.is_empty()).collect();
        let date_at = pieces.iter().position(|p| parse_takeout_date(p).is_some());
        let (prompt, resp, when) = match date_at {
            Some(k) => (pieces[..k].join(" "), pieces[k + 1..].join(" "), parse_takeout_date(&pieces[k])),
            None => (pieces.first().cloned().unwrap_or_default(), pieces.iter().skip(1).cloned().collect::<Vec<_>>().join(" "), None),
        };
        let prompt = prompt.strip_prefix("Prompted ").unwrap_or(&prompt).to_string();
        let (a, w) = count_chars(&prompt);
        agg.msg(true, when, a, w, None);
        if !resp.trim().is_empty() {
            let (a, w) = count_chars(&resp);
            agg.msg(false, when, a, w, None);
        }
    }
}

/// zip 안에서 읽을 멤버 선택 결과.
#[derive(Debug, PartialEq)]
enum Members {
    /// 대화 파일들(읽을 순서대로 `files` 위치).
    Conversations(Vec<usize>),
    /// Gemini 활동 JSON.
    GeminiJson(usize),
    /// Gemini 활동 HTML.
    GeminiHtml(usize),
    /// 해당 없음.
    None,
}

/// zip 안 파일 목록에서 읽을 멤버를 고른다(순수 함수).
///
/// `conversations.json`·`conversations-<숫자>.json` 중 가장 얕은 깊이의 것(`conversations.json` 먼저, 샤드는 숫자 순).
/// 없으면 바로 위 폴더 이름에 "gemini" 가 든 json·html(파일 이름에 activity/활동 이 든 것 우선, 그다음 json 우선, 같은 종류면 큰 파일).
///
/// # 인자
/// - `files`: (zip 안 경로, 크기)
///
/// # 반환
/// `Members`.
fn pick_members(files: &[(String, u64)]) -> Members {
    let usable: Vec<(usize, &str, u64)> = files.iter().enumerate().filter(|(_, (n, _))| !n.starts_with("__MACOSX/")).map(|(i, (n, s))| (i, n.as_str(), *s)).collect();
    let mut conv: Vec<(usize, u64, usize)> = Vec::new(); // (깊이, 순서 키, 위치)
    for (i, n, _) in &usable {
        let depth = n.matches('/').count();
        let base = n.rsplit('/').next().unwrap_or("").to_lowercase();
        if base == "conversations.json" {
            conv.push((depth, 0, *i));
        } else if let Some(num) = base.strip_prefix("conversations-").and_then(|r| r.strip_suffix(".json")) {
            if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(k) = num.parse::<u64>() {
                    conv.push((depth, k + 1, *i));
                }
            }
        }
    }
    if let Some(min) = conv.iter().map(|c| c.0).min() {
        let mut v: Vec<(u64, usize)> = conv.iter().filter(|c| c.0 == min).map(|c| (c.1, c.2)).collect();
        v.sort();
        return Members::Conversations(v.into_iter().map(|x| x.1).collect());
    }
    let mut best: Option<(bool, bool, u64, usize)> = None; // (활동 파일 이름인가, json 인가, 크기, 위치)
    for (i, n, size) in &usable {
        let lower = n.to_lowercase();
        let ext = lower.rsplit('.').next().unwrap_or("");
        let is_json = ext == "json";
        if !(is_json || ext == "html" || ext == "htm") {
            continue;
        }
        let mut comps = lower.rsplit('/');
        comps.next();
        if !comps.next().is_some_and(|p| p.contains("gemini")) {
            continue;
        }
        let stem = lower.rsplit('/').next().unwrap_or("");
        let is_activity = stem.contains("activity") || stem.contains("활동");
        let cand = (is_activity, is_json, *size, *i);
        if best.is_none_or(|b| (cand.0, cand.1, cand.2) > (b.0, b.1, b.2)) {
            best = Some(cand);
        }
    }
    match best {
        Some((_, true, _, i)) => Members::GeminiJson(i),
        Some((_, false, _, i)) => Members::GeminiHtml(i),
        None => Members::None,
    }
}

/// 최상위 배열(또는 `{"conversations": [...]}`)의 항목을 하나씩 콜백에 넘기는 스트리밍 읽기.
struct Items<'a, F: FnMut(Value)> {
    f: &'a mut F,
    manifest: &'a mut bool,
}

impl<'de, F: FnMut(Value)> DeserializeSeed<'de> for Items<'_, F> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de, F: FnMut(Value)> Visitor<'de> for Items<'_, F> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("배열 또는 객체")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(v) = seq.next_element::<Value>()? {
            (self.f)(v);
        }
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(k) = map.next_key::<String>()? {
            if k == "conversations" {
                map.next_value_seed(Items { f: &mut *self.f, manifest: &mut *self.manifest })?;
            } else {
                if k == "data_files" {
                    *self.manifest = true;
                }
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

/// JSON 을 스트리밍으로 읽어 항목마다 집계에 먹인다(메모리는 항목 하나 크기).
///
/// serde_json 은 바이트 단위로 읽으므로 호출 쪽이 `BufReader` 로 감싸야 한다.
///
/// # 인자
/// - `r`: 읽기 원천
/// - `agg`: 집계기
/// - `manifest`: Claude 내려받기 목록(`data_files`)을 봤으면 true 로 바뀜
///
/// # 반환
/// 끝까지 읽었으면 true, 중간 JSON 오류면 false(그때까지는 집계됨).
fn feed_json<R: Read>(r: R, agg: &mut Agg, manifest: &mut bool) -> bool {
    let mut de = serde_json::Deserializer::from_reader(r);
    let mut f = |v: Value| agg.item(&v);
    Items { f: &mut f, manifest }.deserialize(&mut de).is_ok()
}

/// 읽은 바이트 수를 알리는 Read 래퍼.
struct Progress<'a, R> {
    inner: R,
    tick: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Progress<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        (self.tick)(n as u64);
        Ok(n)
    }
}

/// 내보내기 파일(zip·json·html)을 분석한다.
///
/// # 인자
/// - `path`: 파일 경로
/// - `tz`: 시간대
/// - `progress`: (읽은 바이트, 전체 바이트, 읽은 항목 수) 콜백
///
/// # 반환
/// 리포트. 실패 코드: "open" "zip" "no_data" "claude_manifest" "json" "unknown".
///
/// # 참조
/// `pick_members`, `feed_json`, `feed_html`, `Agg::finish`. `export_analyze` 가 호출.
pub(crate) fn analyze_path(path: &Path, tz: Tz, progress: &mut dyn FnMut(u64, u64, u64)) -> Result<ExportReport, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let file = std::fs::File::open(path).map_err(|_| "open".to_string())?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut agg = Agg::new(tz);
    let items = agg.items.clone();
    let mut manifest = false;
    let mut json_err = false;
    if ext == "zip" {
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "zip".to_string())?;
        let files: Vec<(String, u64)> = (0..zip.len())
            .map(|i| match zip.by_index(i) {
                Ok(f) if !f.is_dir() => (f.name().to_string(), f.size()),
                _ => (String::new(), 0),
            })
            .collect();
        let picked = pick_members(&files);
        let order: Vec<usize> = match &picked {
            Members::Conversations(v) => v.clone(),
            Members::GeminiJson(i) | Members::GeminiHtml(i) => vec![*i],
            Members::None => return Err("no_data".into()),
        };
        let total: u64 = order.iter().map(|i| files[*i].1).sum();
        let mut done = 0u64;
        let mut tick = |n: u64| {
            done += n;
            progress(done, total, items.get());
        };
        for i in order {
            let Ok(entry) = zip.by_index(i) else { return Err("zip".into()) };
            if let Members::GeminiHtml(_) = picked {
                let mut buf = Vec::new();
                BufReader::new(Progress { inner: entry, tick: &mut tick }).read_to_end(&mut buf).map_err(|_| "zip".to_string())?;
                feed_html(&String::from_utf8_lossy(&buf), &mut agg);
            } else if !feed_json(BufReader::with_capacity(1 << 16, Progress { inner: entry, tick: &mut tick }), &mut agg, &mut manifest) {
                json_err = true;
            }
        }
    } else if ext == "html" || ext == "htm" {
        let mut buf = Vec::new();
        BufReader::new(file).read_to_end(&mut buf).map_err(|_| "open".to_string())?;
        feed_html(&String::from_utf8_lossy(&buf), &mut agg);
        progress(size, size, items.get());
    } else {
        let mut done = 0u64;
        let mut tick = |n: u64| {
            done += n;
            progress(done, size, items.get());
        };
        if !feed_json(BufReader::with_capacity(1 << 16, Progress { inner: file, tick: &mut tick }), &mut agg, &mut manifest) {
            json_err = true;
        }
    }
    if agg.user_msgs + agg.ai_msgs == 0 {
        return Err(if manifest {
            "claude_manifest"
        } else if json_err {
            "json"
        } else {
            "unknown"
        }
        .into());
    }
    Ok(agg.finish(&name, json_err))
}

/// 내보내기 파일 고르기 창을 연다(Windows·macOS). 그 밖 OS 는 None.
///
/// # 인자
/// - `window`: 부모 창
/// - `title`: 창 제목
/// - `filter`: 파일 종류 이름
///
/// # 반환
/// 고른 파일 경로. 취소하면 None.
#[tauri::command]
pub async fn export_pick(window: tauri::WebviewWindow, title: String, filter: String) -> Option<String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let f = rfd::AsyncFileDialog::new().set_title(&title).add_filter(&filter, &["zip", "json", "html"]).set_parent(&window).pick_file().await;
        return f.map(|f| f.path().to_string_lossy().to_string());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (window, title, filter);
        None
    }
}

/// 동시에 하나만 분석하게 하는 표시.
static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `BUSY` 를 Drop 때(패닉 포함) 풀어 주는 가드.
struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 내보내기 파일을 분석한다(백그라운드 스레드). 진행은 `export_progress` 이벤트로 알린다.
///
/// # 인자
/// - `app`: 앱 핸들
/// - `path`: 파일 경로
///
/// # 반환
/// 리포트. 실패는 오류 코드 문자열("busy" 포함).
///
/// # 참조
/// `analyze_path`. 로그에는 경로·본문·제목을 남기지 않는다.
#[tauri::command]
pub async fn export_analyze(app: AppHandle, path: String) -> Result<ExportReport, String> {
    if BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("busy".into());
    }
    let guard = BusyGuard;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let start = std::time::Instant::now();
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let r = analyze_path(Path::new(&path), Tz::Local, &mut |done, total, items| {
            if last.elapsed().as_millis() >= 150 {
                last = std::time::Instant::now();
                let _ = app.emit("export_progress", serde_json::json!({ "done": done, "total": total, "items": items }));
            }
        });
        if let Ok(rep) = &r {
            log::info!("내보내기 분석: {} 대화 {} 메시지 {} ({}ms)", rep.provider, rep.conversations.unwrap_or(0), rep.user_msgs + rep.ai_msgs, start.elapsed().as_millis());
        }
        r
    })
    .await
    .map_err(|_| "unknown".to_string())?
}

/// 집계 저장 파일 경로(debug 빌드는 `.dev.json`).
fn saved_path() -> std::path::PathBuf {
    crate::applog::dir().with_file_name(if cfg!(debug_assertions) { "exports-report.dev.json" } else { "exports-report.json" })
}

/// 저장 파일을 읽는다(없거나 깨졌으면 빈 맵).
///
/// # 인자
/// - `path`: 저장 파일 경로
fn load_at(path: &Path) -> BTreeMap<String, ExportReport> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// 저장 파일에 쓴다(상위 폴더 생성 포함).
///
/// # 인자
/// - `path`: 저장 파일 경로
/// - `map`: 서비스별 리포트
///
/// # 반환
/// 실패 시 "save".
fn save_at(path: &Path, map: &BTreeMap<String, ExportReport>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "save".to_string())?;
    }
    let s = serde_json::to_string(map).map_err(|_| "save".to_string())?;
    std::fs::write(path, s).map_err(|_| "save".to_string())
}

/// 저장해 둔 리포트를 서비스별로 돌려준다.
///
/// # 반환
/// provider → 리포트.
#[tauri::command]
pub fn export_saved() -> BTreeMap<String, ExportReport> {
    load_at(&saved_path())
}

/// 리포트(집계만)를 저장한다.
///
/// # 인자
/// - `report`: 저장할 리포트
///
/// # 반환
/// 서비스 이름이 올바르지 않거나 쓰기에 실패하면 "save".
#[tauri::command]
pub fn export_save(report: ExportReport) -> Result<(), String> {
    if !["chatgpt", "claude", "gemini"].contains(&report.provider.as_str()) {
        return Err("save".into());
    }
    let p = saved_path();
    let mut m = load_at(&p);
    m.insert(report.provider.clone(), report);
    save_at(&p, &m)
}

/// 저장한 리포트 하나를 지운다.
///
/// # 인자
/// - `provider`: "chatgpt" | "claude" | "gemini"
///
/// # 반환
/// 쓰기에 실패하면 "save".
#[tauri::command]
pub fn export_forget(provider: String) -> Result<(), String> {
    let p = saved_path();
    let mut m = load_at(&p);
    if m.remove(&provider).is_none() {
        return Ok(());
    }
    save_at(&p, &m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 테스트용 +9시간 시간대.
    fn kst() -> Tz {
        Tz::Fixed(FixedOffset::east_opt(9 * 3600).unwrap())
    }

    /// 항목들을 먹여 리포트를 만든다.
    fn run(items: Vec<Value>) -> ExportReport {
        let mut a = Agg::new(kst());
        for v in &items {
            a.item(v);
        }
        a.finish("t.json", false)
    }

    /// ChatGPT 대화: 시스템·도구 호출·컨텍스트·생각 과정은 빼고 사용자 1·AI 1만 센다.
    #[test]
    fn chatgpt_counts() {
        // 1700000000 = 2023-11-14 22:13:20 UTC = 11-15 07:13:20 KST (수요일)
        let msg = |role: &str, ctype: &str, parts: Value, extra: Value| {
            let mut m = json!({"author": {"role": role}, "create_time": 1700000000.5, "content": {"content_type": ctype, "parts": parts}, "metadata": {}});
            if let Some(o) = extra.as_object() {
                for (k, v) in o {
                    if k == "recipient" {
                        m["recipient"] = v.clone();
                    } else {
                        m["metadata"][k] = v.clone();
                    }
                }
            }
            json!({"message": m})
        };
        let c = json!({"id": "c1", "create_time": 1700000000.0, "default_model_slug": "gpt-4", "mapping": {
            "a": msg("system", "text", json!([""]), json!({})),
            "b": msg("user", "text", json!(["hello wor"]), json!({})),
            "c": msg("assistant", "code", json!(["print(1)"]), json!({"recipient": "python"})),
            "d": msg("assistant", "text", json!(["abcdefgh"]), json!({"model_slug": "gpt-5"})),
            "e": msg("user", "user_editable_context", json!(["x"]), json!({})),
            "f": msg("assistant", "thoughts", json!(["hmm"]), json!({})),
        }});
        let r = run(vec![c]);
        assert_eq!((r.user_msgs, r.ai_msgs, r.conversations), (1, 1, Some(1)));
        assert_eq!(r.models, vec![ModelRow { model: "gpt-5".into(), msgs: 1 }]);
        assert_eq!(r.first_day.as_deref(), Some("2023-11-15"));
        assert_eq!(r.heat[2][7], 1);
        assert_eq!(r.user_tokens, est_tokens(9, 0));
        assert_eq!(r.daily[0].convs, 1);
    }

    /// 같은 id 는 한 번만 세고 빈 객체는 건너뜀.
    #[test]
    fn chatgpt_dedupe_and_junk() {
        let c = json!({"id": "c1", "create_time": 1700000000.0, "mapping": {"b": {"message": {"author": {"role": "user"}, "content": {"content_type": "text", "parts": ["hi"]}}}}});
        let r = run(vec![c.clone(), c, json!({})]);
        assert_eq!(r.conversations, Some(1));
        assert_eq!(r.skipped, 1);
    }

    /// Claude 대화: 생각 과정·도구 호출 글은 빼고 첨부 글은 포함, 모델 없음.
    #[test]
    fn claude_counts() {
        let c = json!({"uuid": "u1", "created_at": "2025-11-03T01:00:00Z", "chat_messages": [
            {"sender": "human", "created_at": "2025-11-03T01:00:00Z", "content": [{"type": "text", "text": "abcd"}], "attachments": [{"extracted_content": "efgh"}]},
            {"sender": "assistant", "created_at": "2025-11-03T01:00:05Z", "content": [{"type": "thinking", "thinking": "zzzzzzzz"}, {"type": "text", "text": "wxyz"}, {"type": "tool_use", "input": {"a": "bbbbbbbb"}}]},
            {"sender": "assistant", "created_at": "2025-11-03T01:00:09Z", "text": "12345678"},
        ]});
        let r = run(vec![c]);
        assert_eq!((r.user_msgs, r.ai_msgs), (1, 2));
        assert_eq!(r.user_tokens, est_tokens(8, 0));
        assert_eq!(r.ai_tokens, est_tokens(12, 0));
        assert!(r.models.is_empty());
        assert_eq!(r.first_day.as_deref(), Some("2025-11-03"));
    }

    /// Gemini JSON: Gemini 항목은 사용자 1·AI 1, 다른 제품 항목은 건너뜀, 대화 수 없음.
    #[test]
    fn gemini_json() {
        let g = json!({"header": "Gemini Apps", "title": "Prompted hi", "time": "2025-11-03T01:00:00.123Z", "products": ["Gemini Apps"], "safeHtmlItem": [{"html": "<p>hello</p>"}]});
        let s = json!({"header": "Search", "title": "Searched for x", "time": "2025-11-03T01:00:00Z"});
        let r = run(vec![g, s]);
        assert_eq!((r.user_msgs, r.ai_msgs, r.conversations, r.skipped), (1, 1, None, 1));
    }

    /// Gemini HTML: 영어·한국어 날짜 칸은 날짜 반영, 날짜 없는 칸은 undated.
    #[test]
    fn gemini_html() {
        let cell = |mid: &str| format!("<div class=\"outer-cell mdl-cell\"><div class=\"mdl-grid\"><div class=\"header-cell\"><p class=\"mdl-typography--title\">Gemini Apps<br></p></div><div class=\"content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1\">{mid}</div><div class=\"content-cell mdl-cell mdl-typography--caption\">Products:<br>Gemini Apps</div></div></div>");
        let html = format!(
            "<html><body>{}{}{}</body></html>",
            cell("Prompted hello<br>Nov 3, 2025, 10:12:13 AM KST<br><p>answer</p>"),
            cell("안녕<br>2025. 11. 4. 오후 5:14:40 KST<br>응답"),
            cell("no date here"),
        );
        let mut a = Agg::new(kst());
        feed_html(&html, &mut a);
        let r = a.finish("a.html", false);
        assert_eq!(r.daily.len(), 2);
        assert_eq!(r.first_day.as_deref(), Some("2025-11-03"));
        assert_eq!(r.last_day.as_deref(), Some("2025-11-04"));
        assert_eq!(r.undated, 1);
        assert_eq!((r.user_msgs, r.ai_msgs), (3, 2));
    }

    /// Takeout 날짜: 영어·한국어 읽기, 쓰레기는 None.
    #[test]
    fn takeout_date() {
        let d = parse_takeout_date("Nov 3, 2025, 10:12:13 AM KST").unwrap();
        assert_eq!(d.to_string(), "2025-11-03 10:12:13");
        let d = parse_takeout_date("2025. 11. 3. 오후 5:14:40 KST").unwrap();
        assert_eq!(d.to_string(), "2025-11-03 17:14:40");
        assert!(parse_takeout_date("그냥 글").is_none());
    }

    /// zip 멤버 고르기: 샤드 순서, 기본 파일 우선, Gemini json 우선, 해당 없음.
    #[test]
    fn pick_members_rules() {
        let f = |v: &[&str]| v.iter().map(|s| (s.to_string(), 10u64)).collect::<Vec<_>>();
        assert_eq!(pick_members(&f(&["conversations-001.json", "conversations-000.json"])), Members::Conversations(vec![1, 0]));
        assert_eq!(pick_members(&f(&["conversations-000.json", "conversations.json"])), Members::Conversations(vec![1, 0]));
        assert_eq!(pick_members(&f(&["x/conversations.json", "conversations.json", "__MACOSX/conversations.json"])), Members::Conversations(vec![1]));
        assert_eq!(pick_members(&f(&["Takeout/My Activity/Gemini Apps/MyActivity.html", "Takeout/My Activity/Gemini Apps/MyActivity.json"])), Members::GeminiJson(1));
        assert_eq!(pick_members(&f(&["Takeout/My Activity/Gemini Apps/MyActivity.html"])), Members::GeminiHtml(0));
        assert_eq!(pick_members(&f(&["readme.txt", "users.json"])), Members::None);
        // 업로드 파일이 더 커도 활동 파일 이름이 먼저
        let big = vec![("Takeout/My Activity/Gemini Apps/upload.json".to_string(), 999u64), ("Takeout/My Activity/Gemini Apps/MyActivity.html".to_string(), 10u64)];
        assert_eq!(pick_members(&big), Members::GeminiHtml(1));
    }

    /// `{"conversations":[…]}` 감싼 형태 인식, `data_files` 목록은 claude_manifest 오류.
    #[test]
    fn wrapper_and_manifest() {
        let dir = std::env::temp_dir().join(format!("exp_wrap_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = json!({"uuid": "u", "chat_messages": [{"sender": "human", "created_at": "2025-01-01T00:00:00Z", "text": "hi"}]});
        let p1 = dir.join("a.json");
        std::fs::write(&p1, json!({"conversations": [c]}).to_string()).unwrap();
        let r = analyze_path(&p1, kst(), &mut |_, _, _| {}).unwrap();
        assert_eq!(r.provider, "claude");
        let p2 = dir.join("m.json");
        std::fs::write(&p2, json!({"data_files": [{"name": "conversations-000.zip"}]}).to_string()).unwrap();
        assert_eq!(analyze_path(&p2, kst(), &mut |_, _, _| {}).unwrap_err(), "claude_manifest");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 시각 읽기: 초·밀리초·ISO(Z, +00:00)·null.
    #[test]
    fn parse_time_forms() {
        let want = DateTime::<Utc>::from_timestamp(1700000000, 0).unwrap();
        assert_eq!(parse_time(&json!(1700000000)), Some(want));
        assert_eq!(parse_time(&json!(1700000000000i64)), Some(want));
        assert_eq!(parse_time(&json!("2023-11-14T22:13:20Z")), Some(want));
        assert_eq!(parse_time(&json!("2023-11-14T22:13:20+00:00")), Some(want));
        assert_eq!(parse_time(&Value::Null), None);
    }

    /// 글자 수 세기와 토큰 어림.
    #[test]
    fn tokens_estimate() {
        assert_eq!(count_chars("ab한글"), (2, 2));
        assert_eq!(est_tokens(8, 3), 4);
    }

    /// 중간에 잘린 JSON 은 읽은 데까지 집계하고 partial 표시.
    #[test]
    fn truncated_json_is_partial() {
        let dir = std::env::temp_dir().join(format!("exp_trunc_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = json!({"uuid": "u", "chat_messages": [{"sender": "human", "created_at": "2025-01-01T00:00:00Z", "text": "hi"}]}).to_string();
        let p = dir.join("t.json");
        std::fs::write(&p, format!("[{c}, {{\"uuid\": \"v\", \"chat_mess")).unwrap();
        let r = analyze_path(&p, kst(), &mut |_, _, _| {}).unwrap();
        assert!(r.partial);
        assert_eq!(r.user_msgs, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// zip 안 conversations.json 을 끝까지 읽어 ChatGPT 로 판별.
    #[test]
    fn zip_end_to_end() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("exp_zip_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = json!([{"id": "c1", "create_time": 1700000000.0, "mapping": {"b": {"message": {"author": {"role": "user"}, "content": {"content_type": "text", "parts": ["hi"]}}}}}]);
        let p = dir.join("export.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            z.start_file("conversations.json", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
            z.write_all(c.to_string().as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let r = analyze_path(&p, kst(), &mut |_, _, _| {}).unwrap();
        assert_eq!(r.provider, "chatgpt");
        assert_eq!(r.file, "export.zip");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 저장 후 다시 읽으면 같다.
    #[test]
    fn save_roundtrip() {
        let dir = std::env::temp_dir().join(format!("exp_save_{}", std::process::id()));
        let p = dir.join("sub").join("r.json");
        let r = run(vec![json!({"uuid": "u", "chat_messages": [{"sender": "human", "created_at": "2025-01-01T00:00:00Z", "text": "hi"}]})]);
        let mut m = BTreeMap::new();
        m.insert(r.provider.clone(), r);
        save_at(&p, &m).unwrap();
        assert_eq!(load_at(&p), m);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
