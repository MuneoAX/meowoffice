/**
 * @file 날씨: 사무실 위치(meowLocation)의 현재 날씨를 Open-Meteo 에서 받는다 (키 없음, 보내는 것은 좌표뿐).
 * 30분마다 갱신, 위치를 바꾸면 바로. 받은 값은 localStorage meow.weather 에 두고 "meow-weather" 이벤트로 알린다.
 * kind: clear | partly | cloudy | fog | drizzle | rain | snow | thunder | hail (WMO 날씨 코드에서)
 * 공개 API: MeowWeather.{ start, refresh, get, kindOf, icon, desc, searchPlace, timezoneAt }.
 */
/**
 * @typedef {Object} WeatherResult
 * @property {number} lat 요청 위도
 * @property {number} lon 요청 경도
 * @property {string} place 위치 표시 이름
 * @property {number} at 받은 시각(ms epoch)
 * @property {number|undefined} code WMO 날씨 코드
 * @property {string} kind clear|partly|cloudy|fog|drizzle|rain|snow|thunder|hail|unknown
 * @property {number} temp 기온(°C, 반올림)
 * @property {number} cloud 구름량(%)
 * @property {number} precip 강수량(mm)
 * @property {number} wind 평균 풍속(km/h, 지상 10m, 반올림)
 * @property {number} gust 순간 최대 풍속(km/h, 지상 10m, 반올림)
 * @property {string} tz 시간대 이름
 */
/**
 * @typedef {Object} PlaceResult
 * @property {string} name 지명
 * @property {string} label "지명, 행정구역, 나라" 표시용
 * @property {number} lat 위도(소수 4자리)
 * @property {number} lon 경도(소수 4자리)
 * @property {string} tz IANA 시간대
 */
'use strict';

const MeowWeather = (() => {
  const KEY = 'meow.weather';
  const EVERY = 30 * 60e3;
  let cur = null;
  let started = false;

  /**
   * WMO 날씨 코드 → 날씨 종류.
   * 코드 범위별로 clear/partly/cloudy/fog/drizzle/rain/snow/thunder/hail 로 나눈다. 96·99(우박을 동반한 뇌우)는 hail. null 은 unknown, 어느 범위에도 안 맞으면 cloudy.
   * @param {number|null|undefined} code WMO 날씨 코드
   * @returns {string} 날씨 종류
   */
  function kindOf(code) {
    if (code == null) return 'unknown';
    if (code === 0) return 'clear';
    if (code <= 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code === 96 || code === 99) return 'hail';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }
  const ICON = {
    clear: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    partly: '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
    cloudy: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    fog: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7"/><path d="M17 21H9"/>',
    drizzle: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1"/><path d="M8 14v1"/><path d="M16 19v1"/><path d="M16 14v1"/><path d="M12 21v1"/><path d="M12 16v1"/>',
    rain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    snow: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/>',
    thunder: '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/>',
    hail: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v2"/><path d="M8 14v2"/><path d="M16 20h.01"/><path d="M8 20h.01"/><path d="M12 16v2"/><path d="M12 22h.01"/>',
    unknown: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  };
  /**
   * 날씨 종류의 SVG 아이콘 HTML.
   * 알 수 없는 종류는 unknown 아이콘.
   * @param {string} kind 날씨 종류
   * @returns {string} <svg> HTML
   * @see ICON
   */
  const icon = (kind) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[kind] || ICON.unknown}</svg>`;
  /**
   * 날씨 종류의 현재 언어 설명 문구.
   * i18n 의 t 가 있으면 "weather.<kind>" 키, 없으면 kind 그대로.
   * @param {string} kind 날씨 종류
   * @returns {string} 설명
   * @see t (i18n/i18n.js)
   */
  const desc = (kind) => (typeof t === 'function' ? t('weather.' + kind) : kind);

  /**
   * localStorage(meow.weather)에 둔 지난 날씨 읽기.
   * @returns {WeatherResult|null} 저장값, 없거나 읽기 실패면 null
   */
  function cached() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  /**
   * "meow-weather" 이벤트로 현재 날씨(cur)를 알린다.
   * @returns {void}
   */
  function emit() { window.dispatchEvent(new CustomEvent('meow-weather', { detail: cur })); }

  /**
   * 현재 위치의 날씨를 받아 저장하고 알린다.
   * 강제가 아니고 같은 위치의 값이 30분 안이면 재사용. 받으면 localStorage 저장, 실패하면 같은 위치의 지난 값만 유지, 끝에 emit.
   * @param {boolean} [force] true 면 캐시 무시
   * @returns {Promise<WeatherResult|null>} 현재 날씨
   * @see meowLocation (common.js), kindOf, emit, cached
   */
  async function refresh(force) {
    const loc = typeof meowLocation === 'function' ? meowLocation() : null;
    if (!loc || loc.lat == null) return cur;
    const old = cur || cached();
    if (!force && old && old.lat === loc.lat && old.lon === loc.lon && Date.now() - old.at < EVERY - 5000) { cur = old; emit(); return cur; }
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,cloud_cover,precipitation,is_day,wind_speed_10m,wind_gusts_10m&timezone=auto`;
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const c = j.current || {};
      cur = { lat: loc.lat, lon: loc.lon, place: loc.name, at: Date.now(), code: c.weather_code, kind: kindOf(c.weather_code), temp: Math.round(c.temperature_2m), cloud: c.cloud_cover ?? 0, precip: c.precipitation ?? 0, wind: Math.round(c.wind_speed_10m ?? 0), gust: Math.round(c.wind_gusts_10m ?? 0), tz: j.timezone || '' };
      try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (_) { /* 이번만 */ }
    } catch (e) {
      // 못 받으면 지난 값(같은 위치일 때만) 유지
      cur = old && old.lat === loc.lat && old.lon === loc.lon ? old : null;
    }
    emit();
    return cur;
  }

  /**
   * 날씨 자동 갱신 시작(한 번만).
   * 즉시 한 번 받고, 30분마다 강제 갱신하며, "meow-location" 이벤트(위치 변경) 때도 바로 갱신한다.
   * @returns {void}
   * @see refresh
   */
  function start() {
    if (started) return;
    started = true;
    refresh(false);
    setInterval(() => refresh(true), EVERY);
    window.addEventListener('meow-location', () => refresh(true));
  }
  /**
   * 좌표의 시간대 조회 (현재 위치로 맞출 때).
   * Open-Meteo forecast 응답의 timezone 을 쓴다. 실패하면 null.
   * @param {number} lat 위도
   * @param {number} lon 경도
   * @returns {Promise<string|null>} IANA 시간대
   */
  async function timezoneAt(lat, lon) {
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`);
      const j = await r.json();
      return j.timezone || null;
    } catch (_) { return null; }
  }
  /** 도시 검색 보조: 두 글자 한글 검색이 공식 이름과 달라 못 찾을 때 붙여 다시 찾는 행정구역 꼬리(searchPlace 참고). */
  const SUFFIX = ['특별시', '광역시', '특별자치시', '특별자치도', '시', '도', '군'];
  /**
   * 도시 이름 검색.
   * 두 글자 검색은 이름이 정확히 같아야만 찾아져서("서울" → 공식 이름 "서울특별시") 없으면 행정구역 꼬리(SUFFIX)를 붙여 다시 찾는다.
   * 결과는 시간대가 있는 것만, 같은 좌표(소수 2자리)는 한 번만, 최대 8개.
   * @param {string} q 검색어
   * @returns {Promise<PlaceResult[]>} [{ name, label, lat, lon, tz }]
   * @see I18N.apiLang, Open-Meteo geocoding API
   */
  async function searchPlace(q) {
    const lang = typeof I18N !== 'undefined' ? I18N.apiLang() : 'ko';
    /**
     * 이름 하나로 지오코딩 API 를 한 번 조회.
     * HTTP 오류면 예외.
     * @param {string} name 검색 이름
     * @returns {Promise<Object[]>} API results 배열(없으면 빈 배열)
     */
    const one = async (name) => {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=${lang}&format=json`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).results || [];
    };
    let list = await one(q);
    if (!list.length && /^[가-힣]+$/.test(q)) {
      const more = await Promise.all(SUFFIX.map((sx) => one(q + sx).catch(() => [])));
      const seen = new Set();
      list = more.flat().filter((x) => { const k = x.latitude.toFixed(2) + ',' + x.longitude.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
    }
    return list.filter((x) => x.timezone).map((x) => ({
      name: x.name,
      label: [x.name, x.admin1 && x.admin1 !== x.name ? x.admin1 : '', x.country].filter(Boolean).join(', '),
      lat: +x.latitude.toFixed(4), lon: +x.longitude.toFixed(4), tz: x.timezone,
    }));
  }
  return { start, refresh, get: () => cur || cached(), kindOf, icon, desc, searchPlace, timezoneAt };
})();
