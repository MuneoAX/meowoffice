/**
 * @file 모든 창(오피스 office/ · 알림 notify.html) 공통 — 각 창 스크립트보다 먼저 로드.
 * 창 구분은 <html data-win="panel|notify">. 공통 도우미·출처 뱃지를 여기 모음.
 * 알림 종류(분류) 자체는 Rust alerts::KINDS 가 단일 정의 — 설정 화면은 get_config().alert_kinds 로 받아 그림.
 * 전역 공개: TAURI · invoke · WIN · $ · escapeHtml · fmtAgo · sourceName · projectTag · sourceBadges ·
 *   MEOW_LOCATIONS · meowLocation · setMeowLocation · meowProviders.
 */
/**
 * @typedef {Object} Alert
 * @property {string} key 알림 고유 키 (id@버전 형태, 접두사로 서비스 판정)
 * @property {string} id 세션 등 원본 id
 * @property {string} title 제목
 * @property {string} message 본문
 * @property {string} state need_input | done | update | status | recovered | review_ready 등
 * @property {string} env 출처: local | bridge | cloud | update | status
 * @property {string} url 열기 링크(없으면 빈 문자열)
 * @property {string} updated_at 갱신 시각(ISO)
 * @property {boolean} [agent] 서브·백그라운드 에이전트에서 온 알림
 * @property {string} project 프로젝트 이름(모르면 빈 값)
 * @property {string} kind 종류 id (alerts.rs KINDS)
 * @property {"claude"|"chatgpt"|"antigravity"|"app"} provider 서비스 id (alerts.rs Alert)
 */
/**
 * @typedef {Object} Place
 * @property {string} name 표시 이름
 * @property {number} lat 위도
 * @property {number} lon 경도
 * @property {string} tz IANA 시간대 (예: "Asia/Seoul")
 */
/**
 * @typedef {Object} MeowLocation
 * @property {string} id "auto" | 미리 정한 도시 id | "custom"
 * @property {string} name 표시 이름
 * @property {number} lat 위도
 * @property {number} lon 경도
 * @property {string} tz IANA 시간대
 */

// Tauri 글로벌 API (withGlobalTauri). Tauri 밖(브라우저)에서 열면 invoke = null → 패널은 데모 데이터로 렌더.
const TAURI = window.__TAURI__;
const invoke = TAURI ? TAURI.core.invoke : null;
const WIN = document.documentElement.dataset.win || "";

/**
 * id 로 DOM 요소 가져오기(getElementById 줄임).
 * @param {string} id 요소 id
 * @returns {HTMLElement|null} 요소
 */
const $ = (id) => document.getElementById(id);
/**
 * HTML 특수문자(& < > ") 이스케이프.
 * 문자열이 아니어도 String() 으로 바꾼 뒤 처리. 템플릿 문자열에 사용자 값을 넣을 때 사용.
 * @param {*} s 이스케이프할 값
 * @returns {string} 안전한 문자열
 */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/**
 * 경과 시간 표기(현재 언어, Intl 사용).
 * "방금" / "3분 전"·"3 minutes ago" / "2시간 전" / "3일 전"(7일 미만), 그 이상은 월/일(예: "10월 18일"·"Oct 18"). 값이 없으면 빈 문자열.
 * @param {string} iso 시각(ISO 8601)
 * @returns {string} 표기 문자열
 * @see notify.js · panel.js 의 카드 경과 표시, I18N.lang
 */
const fmtAgo = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  const lang = typeof I18N !== "undefined" ? I18N.lang() : "ko";
  if (s < 60) return t("common.ago.now");
  const rtf = (n, unit) => new Intl.RelativeTimeFormat(lang, { numeric: "always", style: "short" }).format(-n, unit);
  if (s < 3600) return rtf(Math.floor(s / 60), "minute");
  if (s < 86400) return rtf(Math.floor(s / 3600), "hour");
  if (s < 86400 * 7) return rtf(Math.floor(s / 86400), "day");
  return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(d);
};

// 화면 오류도 앱 로그에 남김(문제 제보용). 로그 머리말 = 창 이름.
if (invoke) {
  window.addEventListener("error", (e) => invoke("log_ui", { level: "error", message: `${WIN}: ${e.message} @ ${e.filename}:${e.lineno}` }));
  window.addEventListener("unhandledrejection", (e) => invoke("log_ui", { level: "error", message: `${WIN}: ${e.reason}` }));
  // 보안 정책(CSP)에 막힌 불러오기도 남김 — 정책을 좁힌 뒤 빠진 주소를 찾기 위해
  const cspSeen = new Set();
  window.addEventListener("securitypolicyviolation", (e) => {
    const k = `${e.violatedDirective}|${e.blockedURI}`;
    if (cspSeen.has(k)) return;
    cspSeen.add(k);
    invoke("log_ui", { level: "warn", message: `${WIN}: CSP 차단 ${e.violatedDirective} ${e.blockedURI}` });
  });
}

// ── 출처 뱃지(카드·목록) ───────────────────────────────────────
/** 알림 출처(Alert.env) → 뱃지. 앱 자체 알림(update·status)은 뱃지 대신 이름만. */
const ORIGIN_BADGES = {
  local: { get label() { return t("common.origin.local"); }, cls: "tag-local" }, // getter: 언어가 바뀌어도 그릴 때마다 현재 언어
  bridge: { get label() { return t("common.origin.bridge"); }, cls: "tag-remote" },
  cloud: { get label() { return t("common.origin.cloud"); }, cls: "tag-cloud" },
};
const APP_SOURCES = { update: "Meowffice", get status() { return t("common.src.status"); } };
const AGENT_BADGE = { get label() { return t("common.badge.agent"); }, cls: "tag-agent" };

/**
 * 출처 이름(목록 부제용).
 * ORIGIN_BADGES 라벨 → APP_SOURCES 이름 → env 원문 → 빈 문자열 순.
 * @param {Alert} a 알림
 * @returns {string} 출처 이름
 * @see ORIGIN_BADGES, APP_SOURCES
 */
const sourceName = (a) => ORIGIN_BADGES[a.env]?.label || APP_SOURCES[a.env] || a.env || "";

/**
 * 프로젝트 이름 뱃지 HTML.
 * 여러 프로젝트를 돌릴 때 어디서 온 알림인지 구분. 이름이 없거나 제목과 같으면(제목이 곧 프로젝트) 빈 문자열.
 * @param {string} name 프로젝트 이름
 * @param {string} [title] 알림 제목
 * @returns {string} 뱃지 HTML 또는 빈 문자열
 * @see escapeHtml
 */
const projectTag = (name, title) =>
  name && name !== title ? `<span class="tag tag-proj" title="${escapeHtml(t("common.project.title", { name }))}">${escapeHtml(name)}</span>` : "";

/**
 * 카드 뱃지 HTML.
 * [에이전트] [로컬|원격 제어|클라우드], 앱 알림은 이름 텍스트. env 가 ORIGIN_BADGES 에 없으면 이름만, 있으면 에이전트 알림에 에이전트 뱃지를 앞에 붙인다.
 * @param {Alert|{env: string, agent?: boolean}} a 알림
 * @returns {string} 뱃지 HTML
 * @see ORIGIN_BADGES, AGENT_BADGE, sourceName
 */
function sourceBadges(a) {
  const tag = (b) => `<span class="tag ${b.cls}">${b.label}</span>`;
  const origin = ORIGIN_BADGES[a.env];
  if (!origin) return `<span class="a-env">${escapeHtml(sourceName(a))}</span>`;
  return (a.agent ? tag(AGENT_BADGE) : "") + tag(origin);
}

// ── 사무실 위치·시간대 (오피스 해·달·시각 기준). 이 PC 에만 저장(localStorage) ──────────
const MEOW_LOCATIONS = [
  { id: "auto", get name() { return t("common.loc.auto_tz"); } },
  { id: "seoul", get name() { return t("common.city.seoul"); }, lat: 37.57, lon: 126.98, tz: "Asia/Seoul" },
  { id: "busan", get name() { return t("common.city.busan"); }, lat: 35.18, lon: 129.08, tz: "Asia/Seoul" },
  { id: "tokyo", get name() { return t("common.city.tokyo"); }, lat: 35.68, lon: 139.69, tz: "Asia/Tokyo" },
  { id: "shanghai", get name() { return t("common.city.shanghai"); }, lat: 31.23, lon: 121.47, tz: "Asia/Shanghai" },
  { id: "taipei", get name() { return t("common.city.taipei"); }, lat: 25.03, lon: 121.56, tz: "Asia/Taipei" },
  { id: "hongkong", get name() { return t("common.city.hongkong"); }, lat: 22.32, lon: 114.17, tz: "Asia/Hong_Kong" },
  { id: "singapore", get name() { return t("common.city.singapore"); }, lat: 1.35, lon: 103.82, tz: "Asia/Singapore" },
  { id: "hanoi", get name() { return t("common.city.hanoi"); }, lat: 21.03, lon: 105.85, tz: "Asia/Bangkok" },
  { id: "bangkok", get name() { return t("common.city.bangkok"); }, lat: 13.76, lon: 100.5, tz: "Asia/Bangkok" },
  { id: "sydney", get name() { return t("common.city.sydney"); }, lat: -33.87, lon: 151.21, tz: "Australia/Sydney" },
  { id: "berlin", get name() { return t("common.city.berlin"); }, lat: 52.52, lon: 13.4, tz: "Europe/Berlin" },
  { id: "london", get name() { return t("common.city.london"); }, lat: 51.51, lon: -0.13, tz: "Europe/London" },
  { id: "newyork", get name() { return t("common.city.newyork"); }, lat: 40.71, lon: -74.01, tz: "America/New_York" },
  { id: "la", get name() { return t("common.city.la"); }, lat: 37.77, lon: -122.42, tz: "America/Los_Angeles" },
];
/**
 * 사무실 위치·시간대 읽기(오피스 해·달·시각·날씨 기준).
 * localStorage meow.location 을 읽어 직접 고른 곳(custom) → 미리 정한 도시 → 자동 순으로 해석. 자동이면 컴퓨터 시간대와 같은 시간대의 도시를 쓰고, 없으면 경도만 시간대 오프셋으로 추정한다.
 * @returns {MeowLocation} 고른 위치 { id, name, lat, lon, tz }
 * @see MEOW_LOCATIONS, setMeowLocation, MeowWeather.refresh, t (i18n)
 */
function meowLocation() {
  let id = "auto";
  try { id = localStorage.getItem("meow.location") || "auto"; } catch (_) {}
  // 직접 고른 곳 (도시 검색·현재 위치): meow.location = "custom", 좌표·시간대는 meow.location.custom
  if (id === "custom") {
    try {
      const c = JSON.parse(localStorage.getItem("meow.location.custom") || "null");
      if (c && c.tz && isFinite(c.lat) && isFinite(c.lon)) return { id: "custom", name: c.name, lat: c.lat, lon: c.lon, tz: c.tz };
    } catch (_) {}
  }
  const picked = MEOW_LOCATIONS.find((l) => l.id === id && l.tz);
  if (picked) return picked;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
  const same = MEOW_LOCATIONS.find((l) => l.tz === tz);
  const autoName = (n) => (typeof t === "function" ? t("loc.auto.name", { name: n }) : n);
  if (same) return { ...same, id: "auto", name: autoName(same.name) };
  const off = -new Date().getTimezoneOffset() / 60;
  return { id: "auto", name: autoName(tz), lat: 37.5, lon: off * 15, tz };
}
/**
 * 사무실 위치 저장 + "meow-location" 이벤트 알림.
 * id 와 (custom 이면) 좌표·시간대를 localStorage 에 저장하고 window 에 CustomEvent("meow-location") 를 보낸다(날씨·낮밤 갱신 트리거).
 * @param {string} id "auto" | 미리 정한 도시 id | "custom"
 * @param {Place} [place] custom 일 때 { name, lat, lon, tz }
 * @returns {void}
 * @see meowLocation
 */
function setMeowLocation(id, place) {
  try {
    localStorage.setItem("meow.location", id);
    if (id === "custom" && place) localStorage.setItem("meow.location.custom", JSON.stringify({ name: place.name, lat: place.lat, lon: place.lon, tz: place.tz }));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent("meow-location"));
}

// ── 다른 AI 서비스(ChatGPT·Antigravity) 연동 켬: 설정 파일이 원본, localStorage 는 화면용 사본 ──────────
const MEOW_PROVIDERS = ["chatgpt", "antigravity"];
const meowProviders = {
  /**
   * 이 서비스 연동이 켜져 있는지(화면용 사본).
   * localStorage meow.provider.<이름> 이 "on" 인지 본다. 저장소를 못 읽으면 false.
   * @param {string} n 서비스 이름("chatgpt" | "antigravity")
   * @returns {boolean} 켜짐 여부
   */
  on(n) { try { return localStorage.getItem("meow.provider." + n) === "on"; } catch (_) { return false; } },
  /**
   * 설정 파일 → 화면 사본 동기화.
   * 설정 파일이 원본. 한 번도 저장한 적 없으면(None) 예전 화면 저장값을 설정 파일로 옮김. 있으면 각 서비스 값을 localStorage 사본에 덮어쓰고 바뀐 게 있는지 알린다.
   * @returns {Promise<boolean>} 바뀐 게 있으면 true
   * @see Tauri 명령 get_providers_on, set_provider_on
   */
  async sync() {
    if (!invoke) return false;
    let list = null;
    try { list = await invoke("get_providers_on"); } catch (_) { return false; }
    if (list == null) {
      for (const n of MEOW_PROVIDERS) await invoke("set_provider_on", { name: n, on: meowProviders.on(n) }).catch(() => {});
      return false;
    }
    let changed = false;
    for (const n of MEOW_PROVIDERS) {
      const v = list.includes(n);
      if (v !== meowProviders.on(n)) changed = true;
      try { localStorage.setItem("meow.provider." + n, v ? "on" : "off"); } catch (_) {}
    }
    return changed;
  },
  /**
   * 연동 켜기·끄기: 화면 사본과 설정 파일에 바로 저장.
   * @param {string} n 서비스 이름
   * @param {boolean} on 켤지 여부
   * @returns {Promise<void>}
   * @see Tauri 명령 set_provider_on
   */
  async set(n, on) {
    try { localStorage.setItem("meow.provider." + n, on ? "on" : "off"); } catch (_) {}
    if (invoke) await invoke("set_provider_on", { name: n, on });
  },
};
