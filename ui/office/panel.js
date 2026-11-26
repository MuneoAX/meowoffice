/**
 * @file 사무실 위 화면 구성 (시안: design/AI 코딩 에이전트 가상 오피스 대시보드.png).
 * - 왼쪽: 현황(활성 세션 수 + 추이, 사용 한도 고리·막대, 프로젝트별 세션 수)
 * - 오른쪽 위: Live · 날짜·시각 · 결재/간식/소리/화질/전체 화면 · 오른쪽: 업무 현황(고양이마다 지금 하는 일), 최근 알림
 * - 왼쪽 아래: 고른 고양이 상세 · 오른쪽 아래: 확대 막대(office.js, 확대했을 때만)
 * 밝은 반투명 카드. 카드 머리를 누르면 접고 펼침(기억함). 데이터는 office.js 가 update() 로 넣는다.
 * 공개 API: OfficePanel.{ init(stage, opts), update(data), select(id), unselect(), resetLayout(), alertsVisible(), onUsage(fn) }.
 * 카드 위치·접힘·탭은 localStorage(office.layout · office.collapsed · office.overTab)에 저장.
 */
/**
 * @typedef {Object} PanelOpen
 * @property {string} [kind] "alert" 등 열기 종류
 * @property {string} [url] 열 링크
 * @property {string} [project] 프로젝트 이름 (office.js 가 해석하는 열기 지시)
 */
/**
 * @typedef {Object} PanelCat
 * @property {string} id 고양이(세션) id
 * @property {string} name 고양이 이름
 * @property {number} [treats] 남은 간식(고양이에게 줄 수 있는 수)
 * @property {{level: number, xp: number, next: number}} [level] 고양이(품종) 레벨 — 받아 온 간식이 경험치 (demo.levelOf)
 * @property {string} provider claude | chatgpt | antigravity
 * @property {string} title 작업 제목
 * @property {string} project 프로젝트
 * @property {string} doing work|fish|read|board|meeting|coffee|rest|walk
 * @property {string} [alert] permission|question|deliver|error
 * @property {boolean} [busy] 일하는 중
 * @property {boolean} [leaving] 퇴근 중
 * @property {boolean} [landing] 출근 중
 * @property {boolean} [atDesk] 자리에 앉았는지
 * @property {string} [startedAt] 시작 시각(ISO)
 * @property {string} [lastAt] 마지막 활동(ISO)
 * @property {PanelOpen} [open] 세션 열기 지시
 */
/**
 * @typedef {Object} PanelPlan
 * @property {string} name 계정 이름
 * @property {{plan?: string, limits?: ProviderLimit[]}} plan 요금제 이름과 한도 목록 (ProviderLimit 은 settings.js 정의)
 */
/**
 * @typedef {Object} PanelEnded
 * @property {string} title 제목
 * @property {string} project 프로젝트
 * @property {string} [lastAt] 마지막 활동(ISO)
 * @property {PanelOpen} open 이어서 열기 지시
 */
/**
 * @typedef {Object} PanelData
 * @property {PanelCat[]} cats 고양이(활성 세션) 목록
 * @property {Object<string,PanelPlan|null>} [plans] 서비스별 플랜(claude|chatgpt|antigravity)
 * @property {string} [name] 예전 단일 계정 이름
 * @property {Object} [plan] 예전 단일 플랜
 * @property {Alert[]} alerts 최근 알림(Alert + read·resolved, common.js 의 Alert)
 * @property {PanelEnded[]} [ended] 지난 세션
 */
/**
 * @typedef {Object} PanelOpts
 * @property {function(string):void} [onFocus] 고양이 행 클릭(고양이 id)
 * @property {function():void} [onUnselect] 상세 닫기
 * @property {function(PanelOpen):void} [onOpen] 세션·알림 열기
 * @property {function():void} [onAlertsShown] 최근 알림이 펼쳐져 보임
 * @property {function(?string):void} [onChat] 고양이를 고름(고양이 id)·해제(null): 채팅 도크 열기·닫기. 주면 상세 카드 대신 도크를 쓴다
 * @property {function(PanelCat, string, {logo: string, chip: string}):void} [onInfo] 도크 '정보' 탭에 넣을 본문 HTML(고른 고양이, 본문, 로고·상태 칩 HTML)
 * @property {function():({time?: Date, tz?: string, place?: string, phase?: string, label?: string}|null)} [clock] 오피스 시계·낮밤 정보
 */
/**
 * @typedef {Object} CardEntry
 * @property {"l"|"r"} h 가로 기준 모서리
 * @property {number} x 그 모서리에서의 거리(px)
 * @property {"t"|"b"} v 세로 기준 모서리
 * @property {number} y 그 모서리에서의 거리(px)
 */
/**
 * @typedef {Object} Rect
 * @property {number} l 왼쪽
 * @property {number} t 위
 * @property {number} r 오른쪽
 * @property {number} b 아래
 */
'use strict';

const OfficePanel = (() => {
  /**
   * HTML 특수문자(& < > " ') 이스케이프.
   * null/undefined 는 빈 문자열.
   * @param {*} s 이스케이프할 값
   * @returns {string} 안전한 문자열
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PROVIDER = { claude: ['Claude', '#e8915a'], chatgpt: ['ChatGPT', '#3fae8c'], antigravity: ['Antigravity', '#5b8def'] };
  /**
   * 서비스 로고 아이콘 HTML (색 점 대신).
   * 알 수 없거나 비어 있으면 claude.
   * @param {string} [k] 서비스 id
   * @returns {string} <i class="pv-logo …"> HTML
   * @see esc
   */
  const logo = (k) => `<i class="pv-logo pv-${esc(k || 'claude')}" aria-hidden="true"></i>`;
  const OPEN_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const STATE_KEY = { need_input: 'panel.state.need_input', review_ready: 'panel.state.review_ready', done: 'panel.state.done', error: 'panel.state.error' };
  const lc = () => (typeof I18N !== 'undefined' ? I18N.lang() : 'ko'); // 날짜·시간 표기 언어
  const PROJ_COLORS = ['#f0a35e', '#5b8def', '#d9b44a', '#7a6ff0', '#4fb08a', '#e0708f'];

  let root, onFocus = () => {}, onUnselect = () => {}, onOpen = () => {}, onAlertsShown = () => {}, clockFn = null, onUsage = () => {}, onChat = () => {}, onInfo = () => {}, docked = false;
  const collapsed = (() => { try { return JSON.parse(localStorage.getItem('office.collapsed') || '{}'); } catch (e) { return {}; } })();
  const history = []; // 활성 세션 수 추이 (1분마다)
  let lastSample = 0;
  let selected = null;
  // 저장값이 서비스 이름이 아니면(0.6.0 에서 대화 도크의 정보/대화 탭 클릭이 'info'·'chat' 으로 저장되던 문제) '전체'로
  const okTab = (v) => (v === 'all' || Object.prototype.hasOwnProperty.call(PROVIDER, v) ? v : 'all');
  let overTab = (() => { try { return okTab(localStorage.getItem('office.overTab') || 'all'); } catch (e) { return 'all'; } })();

  /**
   * 접고 펼 수 있는 카드(.wg) 요소 만들기.
   * 머리·본문 틀을 만들고, 머리를 누르면 접힘 상태를 토글해 localStorage(office.collapsed)에 저장. 최근 알림이 펼쳐지면 onAlertsShown 호출.
   * @param {string} id 카드 id("over"|"cats"|"alerts")
   * @param {string} title 머리 제목(HTML)
   * @param {string} [icon] 머리 아이콘(HTML)
   * @returns {HTMLElement} <section class="wg">
   * @see init, dragCard
   */
  function card(id, title, icon) {
    const el = document.createElement('section');
    el.className = 'wg' + (collapsed[id] ? ' closed' : '');
    el.dataset.id = id;
    el.innerHTML = `<header><span class="wg-ic">${icon || ''}</span><span class="wg-t" data-i18n="${title}">${t(title)}</span><span class="wg-n"></span><span class="wg-x" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg></span></header><div class="wg-b"></div>`;
    el.querySelector('header').onclick = () => {
      el.classList.toggle('closed');
      collapsed[id] = el.classList.contains('closed');
      try { localStorage.setItem('office.collapsed', JSON.stringify(collapsed)); } catch (e) { /* 저장 못 해도 동작 */ }
      if (id === 'alerts' && !collapsed[id]) onAlertsShown();
    };
    return el;
  }
  /**
   * 초기화까지 남은 시간 문구.
   * "3일 2시간 뒤 초기화" / "2시간 5분 뒤 초기화" / "5분 뒤 초기화". 이미 지났거나 값이 틀리면 빈 문자열.
   * @param {string} iso 초기화 시각(ISO)
   * @returns {string} 문구
   */
  const untilText = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return '';
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
    return h >= 24 ? t('panel.until.dh', { d: Math.floor(h / 24), h: h % 24 }) : h ? t('panel.until.hm', { h, m }) : t('panel.until.m', { m });
  };
  /**
   * 경과 시간 문구.
   * "방금" / "n분 전" / "n시간 전" / "n일 전". 미래·잘못된 값이면 빈 문자열.
   * @param {string} iso 시각(ISO)
   * @returns {string} 문구
   */
  const agoText = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return '';
    return s < 60 ? t('panel.ago.now') : s < 3600 ? t('panel.ago.m', { n: Math.floor(s / 60) }) : s < 86400 ? t('panel.ago.h', { n: Math.floor(s / 3600) }) : t('panel.ago.d', { n: Math.floor(s / 86400) });
  };
  /**
   * 진행 시간 문구.
   * 1시간 이상이면 "n시간 m분", 아니면 "m분 s초". 잘못된 값이면 "-".
   * @param {string} iso 시작 시각(ISO)
   * @returns {string} 문구
   */
  const durText = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return '-';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? t('panel.dur.hm', { h, m }) : t('panel.dur.ms', { m, s: Math.floor(s % 60) });
  };
  /**
   * 시각을 "HH:MM:SS"(24시간, ko-KR)로.
   * 잘못된 값이면 "-".
   * @param {string} iso 시각(ISO)
   * @returns {string} 시각 문구
   */
  const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleTimeString(lc(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };

  let wOver, wCats, wAlerts, wSel, clockEl, bellBtn;
  /**
   * 패널 위젯을 만들어 무대(stage)에 붙인다.
   * 위쪽 막대(Live·시계·낮밤·날씨·알림 단추)와 카드 3장(현황·업무 현황·최근 알림)·고른 고양이 카드를 만들고, 클릭 위임(탭·열기·행 선택·상세 닫기)·날씨 표시·1초 시계를 건다. 카드 끌기·저장 위치는 layoutInit.
   * @param {HTMLElement} stage 위젯을 붙일 무대 요소
   * @param {PanelOpts} [opts={}] 콜백 묶음
   * @returns {void}
   * @see card, layoutInit, update, MeowWeather (weather.js)
   */
  function init(stage, opts = {}) {
    onFocus = opts.onFocus || onFocus;
    onUnselect = opts.onUnselect || onUnselect;
    onOpen = opts.onOpen || onOpen;
    onAlertsShown = opts.onAlertsShown || onAlertsShown;
    onChat = opts.onChat || onChat; onInfo = opts.onInfo || onInfo; docked = !!opts.onChat; // 채팅 도크가 있으면 고른 고양이 상세는 도크의 '정보' 탭에
    clockFn = opts.clock || null;
    root = document.createElement('div');
    root.id = 'widgets';
    // 앱 이름
    // 위쪽 막대: Live · 시각 · 기존 HUD 단추들
    const top = document.createElement('div');
    top.className = 'topbar';
    top.innerHTML = `<div class="pill live"><i></i>Live<span class="clock"></span><span class="dayph"></span><span class="wx" hidden></span></div>`;
    clockEl = top.querySelector('.clock');
    for (const id of ['hud', 'fsBtn']) { const el = document.getElementById(id); if (el) top.appendChild(el); }
    bellBtn = document.createElement('button');
    bellBtn.className = 'ib';
    bellBtn.title = t('panel.bell'); bellBtn.setAttribute('data-i18n-title', 'panel.bell');
    bellBtn.innerHTML = (window.__icon ? window.__icon('bell') : '🔔') + '<em class="bad" hidden></em>';
    /**
     * 알림 단추: 최근 알림 카드 접기/펼치기.
     * 접힘 상태를 office.collapsed 에 저장하고, 펼쳐지면 onAlertsShown 을 부른다.
     * @returns {void}
     */
    bellBtn.onclick = () => { wAlerts.classList.toggle('closed'); collapsed.alerts = wAlerts.classList.contains('closed'); try { localStorage.setItem('office.collapsed', JSON.stringify(collapsed)); } catch (e) { /* 무시 */ } if (!collapsed.alerts) onAlertsShown(); };
    top.insertBefore(bellBtn, top.querySelector('#fsBtn'));
    const left = document.createElement('div'); left.className = 'wg-col wg-left';
    const right = document.createElement('div'); right.className = 'wg-col wg-right';
    wOver = card('over', 'panel.card.over', '📁');
    wCats = card('cats', 'panel.card.cats', '🐾');
    wAlerts = card('alerts', 'panel.card.alerts', '🔔');
    left.append(wOver);
    right.append(wCats, wAlerts);
    // 아래: 고른 고양이 상세 + 범례
    wSel = document.createElement('section');
    wSel.className = 'wg sel';
    wSel.dataset.id = 'sel'; // 끌어 옮긴 위치 저장 키
    wSel.hidden = true;
    root.append(top, left, right, wSel); // 앱 이름·설명은 창 제목 줄에 (화면 안 이름표는 뺌) // 상태 범례는 뺌: 상태는 고양이마다 말풍선·자세로 보인다
    stage.appendChild(root);
    layoutInit();
    /**
     * 패널 클릭 위임 처리.
     * data-tab(서비스 탭) → 탭 저장·다시 그림, data-open-cat/-ended/-al → onOpen, data-cat(고양이 행) → select+onFocus, data-usage → onUsage(현재 탭), .sel-x → 상세 닫기.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see select, unselect, update, onOpen, onFocus, onUsage
     */
    root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab && !tab.closest('.chat-dock')) { overTab = okTab(tab.dataset.tab); try { localStorage.setItem('office.overTab', overTab); } catch (err) { /* 무시 */ } lastOver = ''; if (lastData) update(lastData); return; }
      const op = e.target.closest('[data-open-cat]');
      if (op) { const c = (lastData && lastData.cats || []).find((x) => x.id === op.dataset.openCat); if (c) onOpen(c.open); return; }
      const en = e.target.closest('[data-ended]');
      if (en) { const x = (lastData && lastData.ended || [])[+en.dataset.ended]; if (x) onOpen(x.open); return; }
      const alr = e.target.closest('[data-al]');
      if (alr) { const a = (lastData && lastData.alerts || [])[+alr.dataset.al]; if (a) onOpen({ kind: 'alert', url: a.url || '', project: a.project || '' }); return; }
      const row = e.target.closest('[data-cat]');
      if (row) { select(row.dataset.cat); onFocus(row.dataset.cat); }
      if (e.target.closest('[data-usage]')) onUsage(overTab); // 지금 고른 서비스 탭으로 상세를 연다
      if (e.target.closest('.sel-x')) { unselect(); onUnselect(); }
    });
    const dayEl = top.querySelector('.dayph');
    // 날씨: 아이콘 + 기온 (사무실 위치 기준, weather.js)
    const wxEl = top.querySelector('.wx');
    /**
     * 상단 날씨 표시(아이콘 + 기온 + 툴팁).
     * 날씨가 없거나 unknown 이면 숨긴다. 툴팁은 weather.title 문구(장소·설명·기온·기준 시각).
     * @param {WeatherResult|null} w 날씨 결과(weather.js 의 WeatherResult)
     * @returns {void}
     * @see MeowWeather.icon · desc · get
     */
    const showWx = (w) => {
      if (!w || w.kind === 'unknown' || typeof MeowWeather === 'undefined') { wxEl.hidden = true; return; }
      wxEl.hidden = false;
      wxEl.className = 'wx ' + w.kind;
      wxEl.innerHTML = MeowWeather.icon(w.kind) + `<b>${esc(Math.round(w.temp))}°</b>`;
      const tm = new Date(w.at).toLocaleTimeString(typeof I18N !== 'undefined' ? I18N.lang() : 'ko', { hour: '2-digit', minute: '2-digit' });
      wxEl.title = typeof t === 'function' ? t('weather.title', { place: w.place || '', desc: MeowWeather.desc(w.kind), temp: Math.round(w.temp), time: tm }) : '';
    };
    window.addEventListener('meow-weather', (e) => showWx(e.detail));
    if (typeof MeowWeather !== 'undefined') showWx(MeowWeather.get());
    /**
     * 1초마다 상단 시계·낮밤 표시 갱신.
     * clock() 의 시각·시간대로 날짜와 시각을 쓰고, 위치 툴팁과 낮밤 단계(day/night/dawn/dusk) 아이콘·이름을 단계가 바뀔 때만 바꾼다.
     * @returns {void}
     * @see clockFn (opts.clock)
     */
    const tick = () => {
      const st = clockFn && clockFn();
      const d = (st && st.time) || new Date();
      clockEl.textContent = d.toLocaleString(lc(), { timeZone: (st && st.tz) || undefined, month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      clockEl.title = st && st.place ? t('panel.clock.place', { place: st.place }) : '';
      if (st && st.phase) {
        const ic = { day: 'sun', night: 'moon', dawn: 'sunrise', dusk: 'sunset' }[st.phase];
        const html = (window.__icon ? window.__icon(ic) : '') + st.label;
        const dk = st.phase + lc();
        if (dayEl.dataset.k !== dk) { dayEl.innerHTML = html; dayEl.dataset.k = dk; dayEl.className = 'dayph ' + st.phase; }
      }
    };
    tick();
    setInterval(tick, 1000);
  }
  // ── 카드 끌어 옮기기: 8px 격자 + 자석(창 가장자리·다른 카드 모서리) + 겹침 피함 + 저장 ──────────
  // 카드마다 따로 옮긴다(열 전체가 아님): 옮긴 카드는 열(.wg-col)에서 빠져나와 #widgets 에 직접 놓이고,
  // 안 옮긴 카드는 기존대로 열 안에서 쌓인다. 위치는 가까운 모서리 기준(h:l|r, v:t|b)으로 저장해 창 크기가 바뀌어도 자연스럽다.
  // 고른 고양이 카드(.wg.sel)도 옮길 수 있다. 열이 없어 기본 자리는 CSS 의 왼쪽 아래이고, 본문을 통째로 다시 그리므로 끌기는 카드에서 위임으로 듣는다.
  const GRID = 8, MARGIN = 16, GAP = 16, MAGNET = 10, MOVE_MIN = 4;
  const TOP = 80; // 위쪽 툴바 띠(새 대화 단추·위쪽 막대, 화면 위 80px): 패널은 이 아래에만 놓인다 — 끌기·자석·빈자리 찾기·다시 놓기 모두
  const ORDER = ['over', 'cats', 'alerts']; // 기본 열 안 순서 (over = 왼쪽 열, 나머지 = 오른쪽 열)
  let layout = (() => { try { return JSON.parse(localStorage.getItem('office.layout') || '{}') || {}; } catch (e) { return {}; } })();
  let guide = null;
  /**
   * 카드 위치(layout)를 localStorage(office.layout)에 저장.
   * @returns {void}
   */
  const saveLayout = () => { try { localStorage.setItem('office.layout', JSON.stringify(layout)); } catch (e) { /* 저장 못 해도 동작 */ } };
  /**
   * 위젯 루트의 화면 사각형.
   * @returns {DOMRect}
   */
  const rootBox = () => root.getBoundingClientRect();
  /**
   * 옮길 수 있는 카드 4장.
   * @returns {HTMLElement[]} [현황, 업무 현황, 최근 알림, 고른 고양이]
   */
  const cardsOf = () => [wOver, wCats, wAlerts, wSel, root && root.querySelector('.chat-dock')].filter(Boolean); // 대화 도크는 chat.js 가 나중에 붙인다
  /**
   * 카드 위치(루트 기준 px) → 가까운 모서리 기준 저장값.
   * 창 크기가 바뀌어도 자연스럽게 하려고 가까운 가로·세로 모서리에서의 거리로 저장한다.
   * @param {number} x 카드 왼쪽
   * @param {number} y 카드 위
   * @param {number} w 카드 너비
   * @param {number} h 카드 높이
   * @param {number} W 루트 너비
   * @param {number} H 루트 높이
   * @returns {CardEntry} 저장값
   * @see applyEntry
   */
  function toEntry(x, y, w, h, W, H) {
    const hl = x + w / 2 < W / 2, vt = y + h / 2 < H / 2;
    return { h: hl ? 'l' : 'r', x: Math.round(hl ? x : W - x - w), v: vt ? 't' : 'b', y: Math.round(vt ? y : H - y - h) };
  }
  /**
   * 저장값(CardEntry)을 카드 style 에 반영.
   * 기준 모서리 쪽 left/right, top/bottom 만 채우고 반대쪽은 비운다.
   * @param {HTMLElement} el 카드
   * @param {CardEntry} e 저장값
   * @returns {void}
   * @see toEntry
   */
  function applyEntry(el, e) {
    const s = el.style;
    s.left = e.h === 'l' ? e.x + 'px' : ''; s.right = e.h === 'r' ? e.x + 'px' : '';
    s.top = e.v === 't' ? e.y + 'px' : ''; s.bottom = e.v === 'b' ? e.y + 'px' : '';
  }
  /**
   * 카드를 열에서 빼 #widgets 에 직접 놓는다(보이는 자리 그대로).
   * 이미 free 면 아무것도 안 한다.
   * @param {HTMLElement} el 카드
   * @returns {void}
   * @see setHome
   */
  function setFree(el) { // 열에서 빼서 #widgets 에 직접 놓음 (보이는 자리 그대로)
    if (el.classList.contains('free')) return;
    const r = el.getBoundingClientRect(), o = rootBox();
    root.appendChild(el);
    el.classList.add('free');
    el.style.left = r.left - o.left + 'px'; el.style.top = r.top - o.top + 'px'; el.style.right = ''; el.style.bottom = '';
  }
  /**
   * 카드를 기본 열로 되돌린다.
   * free·dragging·bad 클래스와 위치 style 을 지우고 ORDER 순서에 맞는 자리(왼쪽 열 = over, 오른쪽 열 = 나머지)에 끼워 넣는다.
   * @param {HTMLElement} el 카드
   * @returns {void}
   * @see setFree, ORDER
   */
  function setHome(el) { // 기본 열로 되돌림
    el.classList.remove('free', 'dragging', 'bad');
    el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    if (el === wSel || el.dataset.id === 'dock') return; // 열이 없다: CSS 기본 자리(고른 고양이 = 왼쪽 아래, 도크 = 오른쪽)
    const col = root.querySelector(el.dataset.id === 'over' ? '.wg-left' : '.wg-right');
    const next = ORDER.slice(ORDER.indexOf(el.dataset.id) + 1).map((id) => col.querySelector(`.wg[data-id="${id}"]`)).find(Boolean);
    col.insertBefore(el, next || null);
  }
  /**
   * 끌 때 피할 사각형들: 위쪽 막대, 다른 카드(고른 고양이 카드 포함) (루트 기준).
   * 숨은 요소와 크기 0 인 요소는 뺀다.
   * @param {HTMLElement} except 제외할 요소(끄는 카드)
   * @returns {Rect[]} 사각형 목록
   * @see snapPos, freeSpot
   */
  function obstacles(except) {
    const o = rootBox(), out = [];
    for (const el of [...root.querySelectorAll('.topbar, .wg, .chat-dock')]) {
      if (el === except || el.hidden || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ l: r.left - o.left, t: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top });
    }
    return out;
  }
  /**
   * 두 사각형이 겹치는지.
   * @param {Rect} a 사각형 A
   * @param {Rect} b 사각형 B
   * @returns {boolean} 겹치면 true
   */
  const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  /**
   * 한 축 맞춤: 자석(가장자리 ±MAGNET) 우선, 없으면 격자.
   * starts/ends = 시작·끝 변이 붙을 좌표들. 결과는 [lo, hi] 범위로 제한한다.
   * @param {number} pos 현재 위치
   * @param {number} size 카드 크기
   * @param {number} lo 최소 위치
   * @param {number} hi 최대 위치
   * @param {number[]} starts 시작 변이 붙을 좌표들
   * @param {number[]} ends 끝 변이 붙을 좌표들
   * @returns {{pos: number, line: (number|null)}} 맞춘 위치와 붙은 변의 선(없으면 null)
   * @see snapPos
   */
  function snapAxis(pos, size, lo, hi, starts, ends) {
    let best = null;
    for (const t of starts) { const d = Math.abs(t - pos); if (d <= MAGNET && (!best || d < best.d)) best = { d, pos: t, line: t }; }
    for (const t of ends) { const d = Math.abs(t - size - pos); if (d <= MAGNET && (!best || d < best.d)) best = { d, pos: t - size, line: t }; }
    const clamp = (v) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    if (best) return { pos: clamp(best.pos), line: best.line };
    return { pos: clamp(lo + Math.round((pos - lo) / GRID) * GRID), line: null };
  }
  /**
   * 카드 위치를 자석·격자에 맞춘다(가로·세로).
   * 창 가장자리(여백)와 장애물 사각형(간격 GAP)을 붙을 좌표로 모아 snapAxis 를 두 축에 적용.
   * @param {number} x 위치 x
   * @param {number} y 위치 y
   * @param {number} w 카드 너비
   * @param {number} h 카드 높이
   * @param {number} W 루트 너비
   * @param {number} H 루트 높이
   * @param {Rect[]} obs 장애물
   * @returns {{x: number, y: number, lx: (number|null), ly: (number|null)}} 맞춘 위치와 안내선 좌표
   * @see snapAxis, obstacles
   */
  function snapPos(x, y, w, h, W, H, obs) {
    const xs = [MARGIN], xe = [W - MARGIN], ys = [TOP], ye = [H - MARGIN];
    for (const o of obs) { xs.push(o.l, o.r + GAP); xe.push(o.r, o.l - GAP); ys.push(o.t, o.b + GAP); ye.push(o.b, o.t - GAP); }
    const sx = snapAxis(x, w, MARGIN, W - MARGIN - w, xs, xe), sy = snapAxis(y, h, TOP, H - MARGIN - h, ys, ye);
    return { x: sx.pos, y: sy.pos, lx: sx.line, ly: sy.line };
  }
  /**
   * 겹치면 격자 위에서 가장 가까운 빈 자리를 찾는다.
   * 처음 위치가 비어 있으면 그대로. 아니면 격자를 훑으며 장애물과 여백 8px 이상 떨어진 가장 가까운 칸을 고른다.
   * @param {number} x 원하는 x
   * @param {number} y 원하는 y
   * @param {number} w 카드 너비
   * @param {number} h 카드 높이
   * @param {number} W 루트 너비
   * @param {number} H 루트 높이
   * @param {Rect[]} obs 장애물
   * @returns {({x: number, y: number}|null)} 빈 자리, 없으면 null
   * @see hit
   */
  function freeSpot(x, y, w, h, W, H, obs) {
    const box = (px, py) => ({ l: px, t: py, r: px + w, b: py + h });
    if (!obs.some((o) => hit(box(x, y), o))) return { x, y };
    let best = null;
    for (let py = TOP; py <= H - MARGIN - h; py += GRID) {
      for (let px = MARGIN; px <= W - MARGIN - w; px += GRID) {
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (best && d >= best.d) continue;
        if (!obs.some((o) => hit(box(px, py), { l: o.l - GRID, t: o.t - GRID, r: o.r + GRID, b: o.b + GRID }))) best = { d, x: px, y: py }; // 빈 자리는 여백 8px 두고
      }
    }
    return best;
  }
  /**
   * 끄는 동안만 보이는 안내 표시: 연한 점 격자 + 여백선 + 자석이 붙은 변의 선.
   * 안내 요소를 처음 한 번 만들고, on 으로 켜고 끄며 lx/ly 위치에 세로·가로 선을 그린다(null 이면 숨김).
   * @param {boolean} on 켜기/끄기
   * @param {number|null} [lx] 세로선 x 좌표
   * @param {number|null} [ly] 가로선 y 좌표
   * @returns {void}
   */
  function showGuide(on, lx, ly) {
    if (!guide) {
      guide = document.createElement('div');
      guide.className = 'wg-guide';
      guide.innerHTML = '<i class="gx"></i><i class="gy"></i>';
      root.prepend(guide);
    }
    guide.classList.toggle('on', on);
    const gx = guide.querySelector('.gx'), gy = guide.querySelector('.gy');
    gx.style.display = lx == null ? 'none' : 'block'; if (lx != null) gx.style.left = lx + 'px';
    gy.style.display = ly == null ? 'none' : 'block'; if (ly != null) gy.style.top = ly + 'px';
  }
  // ── 영역 재배치기: 위젯·영역은 서로 겹치지 않는다 (위쪽 막대, 대화 도크, 왼쪽·오른쪽 열, 옮겨 둔 카드, 고른 고양이 카드) ──
  // 창 크기·카드 높이·도크 열림이 바뀔 때마다 fit 한 곳에서 다시 맞춘다. 우선순위: 고정 영역 → 왼쪽 열 → 오른쪽 열 → 옮겨 둔 카드.
  // 옮겨 둔 카드는 사용자가 놓은 자리(layout 저장값)에서 출발해, 겹치면 가까운 빈 자리로 '잠시' 비킨다(저장값은 그대로라 도크가 닫히면 돌아온다).
  const COL_MIN_W = 240; // 오른쪽 열을 이보다 좁게 줄여야 하면 도크가 열린 동안 숨긴다
  /**
   * 요소의 루트 기준 사각형. 숨었거나 크기가 0 이면 null.
   * @param {?Element} el 요소
   * @returns {?Rect}
   */
  function rectOf(el) {
    if (!el || el.hidden || el.closest('[hidden]')) return null;
    const r = el.getBoundingClientRect(), o = rootBox();
    if (!r.width || !r.height) return null;
    return { l: r.left - o.left, t: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top };
  }
  /**
   * 대화 도크의 사각형 (열려 있을 때). 도크는 chat.js 가 #widgets 안에 붙인다.
   * @returns {?Rect}
   */
  const dockRect = () => { const d = root.querySelector('.chat-dock'); return d && !d.classList.contains('free') ? rectOf(d) : null; }; // 옮겨 둔 도크는 카드처럼 3) 에서
  /**
   * 오른쪽 열이 비켜야 하는 도크 폭(px) — chat.js 가 #widgets 의 --dock-w 로 알린다.
   * @returns {number}
   */
  const dockW = () => parseFloat(getComputedStyle(root).getPropertyValue('--dock-w')) || 0;
  let fitQueued = false;
  const parked = {}; // 자리가 없어 기본 자리로 돌아간 카드 → 그때의 화면 조건(창 크기·도크 열림). 조건이 바뀔 때만 다시 시도한다(매 프레임 왕복 방지)
  /**
   * 다음 프레임에 한 번 fit (관찰자가 몰려 불러도 한 번만).
   * @returns {void}
   */
  function fitSoon() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fit(); });
  }
  /**
   * 모든 영역을 겹치지 않게 다시 맞춘다.
   * 1) 왼쪽 열 높이 = 아래쪽 고정 영역(기본 자리의 고른 고양이 카드)까지 남은 공간.
   * 2) 오른쪽 열 폭 = 왼쪽 열과 도크 사이에 남은 공간(최대 300). COL_MIN_W 보다 좁으면 숨김(도크를 닫으면 다시 보임). 높이 = 바닥까지.
   * 3) 옮겨 둔 카드: 저장 자리에서 출발해 화면 안으로 맞추고, 앞서 놓인 영역과 겹치면 가장 가까운 빈 자리(freeSpot)로, 빈 자리가 없으면 원래 열로 잠시 돌아간다.
   * 끄는 중인 카드는 건드리지 않는다.
   * @returns {void}
   * @see freeSpot, applyEntry, setHome, setFree
   */
  function fit() {
    if (!root) return;
    const o = rootBox(), W = o.width, H = o.height;
    if (!W || !H || root.querySelector('.dragging')) return; // 끄는 중(카드·도크)에는 손대지 않는다
    const leftCol = root.querySelector('.wg-left'), rightCol = root.querySelector('.wg-right');
    const fixed = [rectOf(root.querySelector('.topbar')), dockRect()];
    const selHome = !wSel.classList.contains('free') ? rectOf(wSel) : null; // 기본 자리(왼쪽 아래)의 고른 고양이 카드
    if (selHome) fixed.push(selHome);
    // 1) 왼쪽 열: 위 22px(좁은 창에서 위쪽 막대가 왼쪽 열 위까지 오면 그 아래)에서 아래 고정 영역 위까지
    const lL = 22, lR = 22 + (leftCol.offsetWidth || 0), bar = fixed[0];
    const lTop = bar && bar.l < lR + GAP ? bar.b + GAP : 22;
    leftCol.style.top = lTop + 'px';
    let lBottom = H - MARGIN;
    for (const f of fixed) if (f && f.t > lTop && f.l < lR && f.r > lL) lBottom = Math.min(lBottom, f.t - GAP);
    leftCol.style.maxHeight = Math.max(120, lBottom - lTop) + 'px';
    // 2) 오른쪽 열: 도크 왼쪽에서 왼쪽 열 오른쪽까지
    const dk = root.querySelector('.chat-dock');
    const rRight = 26 + (dk && dk.classList.contains('free') ? 0 : dockW()), leftR = rectOf(leftCol); // 도크를 옮겨 두었으면 오른쪽 열은 비키지 않는다
    rightCol.style.right = rRight + 'px';
    const room = W - rRight - (leftR ? leftR.r + GAP : MARGIN);
    const rw = Math.min(300, room);
    rightCol.classList.toggle('squeezed', rw < COL_MIN_W);
    rightCol.style.width = rw >= COL_MIN_W ? rw + 'px' : '';
    rightCol.style.maxHeight = Math.max(120, H - MARGIN - 82) + 'px';
    // 3) 옮겨 둔 카드
    const dkOpen = !!(dk && !dk.hidden);
    const sig = `${Math.round(W)}x${Math.round(H)}|${dkOpen}`;
    let again = false; // 이번에 기본 자리로 돌아간 것이 있으면 열·다른 카드를 그 결과로 한 번 더 맞춘다(같은 조건에선 재시도하지 않으니 끝난다)
    const placed = fixed.filter(Boolean);
    for (const c of [leftR, rectOf(rightCol)]) if (c) placed.push(c);
    for (const el of cardsOf().sort((a, b) => (b.dataset.id === 'dock') - (a.dataset.id === 'dock'))) { // 큰 도크를 먼저 놓는다 (작은 카드가 먼저 자리를 차지하면 도크가 들어갈 곳이 없다)
      const e = layout[el.dataset.id];
      if (!e) continue; // 열에 있는 카드
      if (!el.classList.contains('free')) { // 지난번에 자리가 없어 기본 자리로 돌아간 카드: 화면 조건이 바뀌었을 때만 다시 시도
        if (parked[el.dataset.id] === sig) continue;
        setFree(el); applyEntry(el, e);
      }
      const r = el.getBoundingClientRect();
      if (!r.width) continue; // 숨은 카드(고르지 않은 고양이 카드, 좁은 창)
      const w = r.width, h = r.height;
      let x = e.h === 'l' ? e.x : W - e.x - w, y = e.v === 't' ? e.y : H - e.y - h;
      x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, W - MARGIN - w));
      y = Math.min(Math.max(y, TOP), Math.max(TOP, H - MARGIN - h));
      const spot = freeSpot(x, y, w, h, W, H, placed);
      if (!spot) { setHome(el); parked[el.dataset.id] = sig; again = true; continue; } // 빈 자리가 없음: 저장값은 두고 기본 자리로
      delete parked[el.dataset.id];
      el.style.left = spot.x + 'px'; el.style.top = spot.y + 'px'; el.style.right = el.style.bottom = '';
      placed.push({ l: spot.x, t: spot.y, r: spot.x + w, b: spot.y + h });
    }
    if (again) fitSoon();
  }
  /**
   * 화면 안의 영역끼리 겹치는 쌍 (점검용: 창 크기별 겹침 0 확인).
   * @returns {string[]} '이름 × 이름' 목록 (없으면 빈 배열)
   */
  function overlaps() {
    const items = [['topbar', root.querySelector('.topbar')], ['left', root.querySelector('.wg-left')], ['right', root.querySelector('.wg-right')]];
    for (const el of cardsOf()) if (el.classList.contains('free') || el === wSel || el.dataset.id === 'dock') items.push([el.dataset.id, el]);
    const rs = items.map(([n, el]) => [n, el && getComputedStyle(el).display !== 'none' ? rectOf(el) : null]).filter(([, r]) => r);
    const out = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (hit(rs[i][1], rs[j][1])) out.push(rs[i][0] + ' × ' + rs[j][0]);
    return out;
  }
  /**
   * 카드 위치를 모두 기본으로 되돌린다.
   * 저장값(office.layout)을 지우고 모든 카드를 기본 열로.
   * @returns {void}
   * @see setHome
   */
  function resetLayout() {
    layout = {};
    try { localStorage.removeItem('office.layout'); } catch (e) { /* 무시 */ }
    for (const el of cardsOf()) { setHome(el); el.style.height = el.style.maxHeight = ''; el.classList.remove('hsized'); }
    fitSoon();
  }
  /**
   * 카드 머리를 끌어 카드를 옮기게 한다.
   * 포인터를 4px 이상 움직이면 끌기 시작: 카드를 열에서 빼고 격자·자석에 맞추며 겹치면 빨갛게(bad) 표시. 놓으면 겹침 없는 빈 자리를 찾아 저장하고, 없으면 끌기 전 자리나 기본 열로 되돌린다. 끈 직후의 클릭은 접고 펼침으로 취급하지 않는다.
   * @param {HTMLElement} el 카드(.wg)
   * @returns {void}
   * @see setFree, setHome, snapPos, freeSpot, showGuide, saveLayout
   */
  function dragCard(el) {
    let st = null, swallow = false;
    // 머리는 카드 본문을 다시 그리면 새 요소가 되므로(고른 고양이 카드) 카드에서 위임으로 듣는다
    el.addEventListener('click', (e) => { if (swallow && e.target.closest('header')) { swallow = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true); // 끈 뒤에는 접고 펼침 안 함
    /**
     * 머리에서 포인터를 누르면 끌기 후보 상태를 만들고 창 전체에서 move·end 를 듣는다.
     * 버튼·링크·입력 위에서 누르거나 보조 버튼이면 무시.
     * @param {PointerEvent} e 포인터 이벤트
     * @returns {void}
     */
    el.addEventListener('pointerdown', (e) => {
      if (e.button || !e.isPrimary || !e.target.closest('header') || e.target.closest('button, a, input, select, textarea')) return;
      st = { id: e.pointerId, sx: e.clientX, sy: e.clientY, on: false };
      // 빨리 끌어 머리를 벗어나도, 카드를 열에서 옮겨 심어도(포인터 캡처가 풀림) 계속 받도록 창에서 듣는다
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    });
    /**
     * 끄는 중 포인터 이동 처리.
     * 처음 4px 넘으면 끌기 시작(자리 기억·free 전환·장애물 계산·안내 켬). 이후 이동량을 snapPos 로 맞춰 카드를 옮기고 겹침 여부를 표시한다.
     * @param {PointerEvent} e 포인터 이벤트
     * @returns {void}
     * @see snapPos, obstacles, showGuide
     */
    const move = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
      if (!st.on) {
        if (Math.hypot(dx, dy) < MOVE_MIN) return; // 안 움직인 클릭은 접고 펼침
        st.on = true;
        const r0 = el.getBoundingClientRect(), o0 = rootBox();
        st.prev = el.classList.contains('free') ? toEntry(r0.left - o0.left, r0.top - o0.top, r0.width, r0.height, o0.width, o0.height) : null;
        setFree(el);
        el.classList.add('dragging');
        const r = el.getBoundingClientRect(), o = rootBox();
        st.x0 = r.left - o.left; st.y0 = r.top - o.top; st.w = r.width; st.h = r.height;
        st.obs = obstacles(el);
        showGuide(true);
      }
      const o = rootBox(), W = o.width, H = o.height;
      const s = snapPos(st.x0 + dx, st.y0 + dy, st.w, st.h, W, H, st.obs);
      st.cur = s;
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; el.style.right = el.style.bottom = '';
      el.classList.toggle('bad', st.obs.some((b) => hit({ l: s.x, t: s.y, r: s.x + st.w, b: s.y + st.h }, b)));
      showGuide(true, s.lx, s.ly);
    };
    /**
     * 포인터를 떼거나 취소했을 때 끌기 마무리.
     * 끌지 않았으면 그대로(클릭). 끌었으면 안내를 끄고 빈 자리(freeSpot)에 놓아 저장한다. 취소·자리 없음이면 이전 자리 또는 기본 열로.
     * @param {PointerEvent} e pointerup | pointercancel
     * @returns {void}
     * @see freeSpot, toEntry, applyEntry, setHome, saveLayout
     */
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s = st; st = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      if (!s.on) return;
      swallow = true; setTimeout(() => { swallow = false; }, 0);
      el.classList.remove('dragging', 'bad');
      showGuide(false);
      const o = rootBox(), W = o.width, H = o.height;
      const spot = e.type === 'pointercancel' ? null : freeSpot(s.cur.x, s.cur.y, s.w, s.h, W, H, s.obs);
      if (spot) {
        layout[el.dataset.id] = toEntry(spot.x, spot.y, s.w, s.h, W, H);
        applyEntry(el, layout[el.dataset.id]);
      } else if (s.prev) { // 놓을 자리가 없음 → 끌기 전 자리로
        applyEntry(el, s.prev);
      } else { // 열에서 빼기 전 자리로
        setHome(el); delete layout[el.dataset.id];
      }
      saveLayout();
      delete parked[el.dataset.id]; // 새로 놓은 자리로 다시 시도
      fitSoon(); // 열 높이·다른 카드 자리를 다시 맞춘다
    };
  }
  /**
   * 카드·도크 아래 가장자리를 위아래로 끌어 높이를 조절한다(최소 140px, 최대 루트 높이 - 88px).
   * 높이는 layout[key] 에 저장(office.layout)하고 style.height 로 쓴다. 내용은 카드 안에서 스크롤한다.
   * 손잡이 요소는 두지 않는다(고른 고양이 카드는 본문을 다시 그린다): 아래 가장자리 10px 를 눌렀는지 좌표로 본다.
   * @param {HTMLElement} el 카드 또는 도크
   * @param {string} key layout 키 (hSel | hDock)
   * @returns {void}
   * @see saveLayout, fitSoon
   */
  function attachResize(el, key) {
    const EDGE = 10, MIN_H = 140;
    const maxH = () => Math.max(MIN_H, rootBox().height - 88);
    const applyH = () => { const v = +layout[key]; if (v > 0) { el.style.height = Math.min(Math.max(v, MIN_H), maxH()) + 'px'; el.style.maxHeight = 'none'; el.classList.add('hsized'); } };
    // 아래 모서리에 붙어 있는 카드(기본 자리의 고른 고양이 카드, 아래 기준으로 저장된 카드)는 높이가 위로 자라므로 위쪽 가장자리를 잡는다
    const flipped = () => el.style.top === '' && (el.style.bottom !== '' || (el === wSel && !el.classList.contains('free')));
    const onEdge = (e) => {
      const r = el.getBoundingClientRect(), up = flipped();
      el.classList.toggle('hup', up);
      return (up ? e.clientY >= r.top - 2 && e.clientY <= r.top + EDGE : e.clientY >= r.bottom - EDGE && e.clientY <= r.bottom + 2) && e.clientX >= r.left && e.clientX <= r.right;
    };
    const skip = (e) => e.target.closest && e.target.closest('input, textarea, select');
    let st = null;
    el.addEventListener('pointermove', (e) => { if (!st) el.style.cursor = onEdge(e) && !skip(e) ? 'ns-resize' : ''; });
    el.addEventListener('pointerdown', (e) => {
      if (e.button || !e.isPrimary || !onEdge(e) || skip(e)) return;
      e.preventDefault(); e.stopPropagation();
      st = { id: e.pointerId, y0: e.clientY, h0: el.getBoundingClientRect().height, sg: flipped() ? -1 : 1 };
      el.classList.add('resizing');
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    }, true);
    const mv = (e) => {
      if (!st || e.pointerId !== st.id) return;
      layout[key] = Math.round(Math.min(Math.max(st.h0 + st.sg * (e.clientY - st.y0), MIN_H), maxH()));
      applyH();
    };
    const up = (e) => {
      if (!st || e.pointerId !== st.id) return;
      st = null; el.classList.remove('resizing');
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      saveLayout(); fitSoon();
    };
    el.__applyH = applyH;
    applyH();
    window.addEventListener('resize', applyH);
  }
  /**
   * 대화 도크도 카드처럼 머리(.chat-head)를 끌어 옮기게 한다. chat.js 가 도크를 #widgets 에 붙일 때 한 번.
   * 저장된 자리(layout.dock)가 있으면 그 자리로.
   * @param {HTMLElement} d 도크(.chat-dock)
   * @returns {void}
   * @see dragCard
   */
  function attachDock(d) {
    if (d.dataset.id === 'dock') return;
    d.dataset.id = 'dock';
    dragCard(d);
    attachResize(d, 'hDock');
    if (window.MutationObserver) new MutationObserver(fitSoon).observe(d, { attributes: true, attributeFilter: ['hidden'] }); // 도크 열고 닫기
    fitSoon();
    const e = layout.dock;
    if (e && (e.h === 'l' || e.h === 'r') && (e.v === 't' || e.v === 'b') && isFinite(e.x) && isFinite(e.y)) { setFree(d); applyEntry(d, e); } else delete layout.dock;
  }
  /**
   * 카드 끌기를 연결하고 저장된 위치를 복원한다.
   * 각 카드에 dragCard, 저장값이 올바르면 free 로 놓고(잘못된 저장값은 버림), 영역 재배치기(fit)를 창 크기·카드·열 높이·도크 열림 변화에 건다.
   * @returns {void}
   * @see dragCard, fit
   */
  function layoutInit() {
    for (const el of cardsOf()) dragCard(el);
    attachResize(wSel, 'hSel');
    for (const el of cardsOf()) {
      const e = layout[el.dataset.id];
      if (e && (e.h === 'l' || e.h === 'r') && (e.v === 't' || e.v === 'b') && isFinite(e.x) && isFinite(e.y)) { setFree(el); applyEntry(el, e); } else delete layout[el.dataset.id];
    }
    fitSoon();
    window.addEventListener('resize', fitSoon);
    // 접고 펼쳐 카드 높이가 바뀔 때, 고른 고양이 카드가 나타나고 사라질 때, 열 높이가 바뀔 때
    if (window.ResizeObserver) { const ro = new ResizeObserver(fitSoon); for (const el of [...cardsOf(), ...root.querySelectorAll('.wg-col, .topbar')]) ro.observe(el); }
    // 대화 도크: chat.js 가 #widgets 에 --dock-w 를 쓰고(style), 도크의 hidden 을 바꾼다. 오른쪽 열은 0.18초 동안 미끄러지므로 끝난 뒤 한 번 더
    if (window.MutationObserver) {
      new MutationObserver(fitSoon).observe(root, { attributes: true, attributeFilter: ['style'] });
      // 도크가 붙는 순간만 본다(직계 자식만). 카드 본문·시계 같은 하위 변경으로는 다시 맞추지 않는다
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('chat-dock')) attachDock(n); })
        .observe(root, { childList: true });
    }
    root.querySelector('.wg-right').addEventListener('transitionend', fitSoon);
    const d0 = root.querySelector('.chat-dock'); if (d0) attachDock(d0);
  }
  /**
   * 고양이의 현재 상태 문구와 CSS 클래스.
   * 상태 표는 status.js(OfficeStatus)에 있고 머리 위 알약과 같이 쓴다.
   * @type {(c: PanelCat) => [string, string]}
   */
  const status = OfficeStatus.of;
  /**
   * 고른 고양이 상세 HTML (왼쪽 아래 카드 또는 오른쪽 도크의 '정보' 탭).
   * bare 가 true 면 머리(로고·이름·상태·닫기)를 빼고 본문(서비스·프로젝트·작업·진행 시간·마지막 갱신)만 돌려준다.
   * @param {PanelCat} c 고양이
   * @param {boolean} [bare=false] 본문만
   * @returns {string} HTML
   * @see status, update
   */
  function selHtml(c, bare) {
    const [dtxt, dcls] = status(c);
    const [ptxt] = PROVIDER[c.provider] || PROVIDER.claude;
    const body = `<div class="sel-p">${esc(ptxt)}${c.project ? ' · ' + esc(c.project) : ''}</div>
        <div class="sel-g"><div><small>${t('panel.sel.task')}</small><b>${esc(c.title || '-')}</b></div>
        <div><small>${t('panel.sel.elapsed')}</small><b>${esc(c.startedAt ? durText(c.startedAt) : '-')}</b></div>
        <div><small>${t('panel.sel.last')}</small><b>${esc(c.lastAt ? hhmm(c.lastAt) : '-')}</b></div>${c.level ? `<div><small>${t('panel.sel.level')}</small><b>Lv.${c.level.level}</b><small class="lv-next">${t('panel.sel.nextLv', { n: c.level.next - c.level.xp })}</small></div>` : ''}</div>`;
    if (bare) return body;
    return `<header><span class="coin-logo" title="${esc(ptxt)}">${logo(c.provider)}</span><span class="wg-t">${esc(c.name)}</span><span class="chip ${dcls}">${esc(dtxt)}</span><button class="sel-x" title="${t('panel.sel.close')}">×</button></header>
        <div class="wg-b">${body}</div>`;
  }
  /**
   * 고양이를 골라 상세 카드를 보인다.
   * @param {string} id 고양이 id
   * @returns {void}
   * @see update
   */
  function select(id) { selected = id; lastSel = ''; if (docked) { wSel.hidden = true; onChat(id); if (lastData && (lastData.cats || []).some((x) => x.id === id)) update(lastData); } else wSel.hidden = false; }
  /**
   * 고른 고양이를 해제하고 상세 카드를 숨긴다.
   * @returns {void}
   */
  function unselect() { selected = null; wSel.hidden = true; if (docked) onChat(null); }

  /**
   * 사용 한도 고리(SVG) HTML.
   * 0~100 으로 제한한 비율만큼 둘레(stroke-dasharray)를 채운다. 누르면 사용량 상세(data-usage).
   * @param {number} pct 사용 %
   * @param {string} color 채움 색
   * @returns {string} <svg> HTML
   */
  function ring(pct, color) {
    const r = 22, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct)) / 100;
    return `<svg class="ring" viewBox="0 0 56 56" data-usage style="cursor:pointer"><circle cx="28" cy="28" r="${r}" class="rb"/><circle cx="28" cy="28" r="${r}" class="rf" style="stroke:${color};stroke-dasharray:${(c * v).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
  }
  /**
   * 활성 세션 수 추이 미니 그래프(SVG) HTML.
   * 값이 2개 미만이면 빈 그래프. 최소~최대로 정규화한 선 + 아래 채움.
   * @param {number[]} vals 값 목록(오래된 것부터)
   * @returns {string} <svg> HTML
   */
  function spark(vals) {
    if (vals.length < 2) return '<svg class="spark" viewBox="0 0 100 34"></svg>';
    const max = Math.max(...vals, 1), min = Math.min(...vals), n = vals.length;
    const pts = vals.map((v, i) => `${((i / (n - 1)) * 100).toFixed(1)},${(30 - ((v - min) / Math.max(1, max - min)) * 26).toFixed(1)}`);
    return `<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><polyline points="0,34 ${pts.join(' ')} 100,34" class="sa"/><polyline points="${pts.join(' ')}" class="sl"/></svg>`;
  }
  /**
   * 사용 %에 따른 색(여유 = 기본 색 문어AI).
   * 85% 이상 빨강, 60% 이상 주황, 아니면 보라.
   * @param {number} p 사용 %
   * @returns {string} 색 코드
   */
  const sevColor = (p) => (p >= 85 ? '#e5534b' : p >= 60 ? '#e3a43a' : '#8b6dff'); // 여유 = 기본 색(문어AI)

  let lastOver = '', lastCats = '', lastAlerts = '', lastSel = '';
  /**
   * 마지막으로 받은 패널 데이터(탭 전환 등 다시 그릴 때 재사용).
   * @type {PanelData|null}
   */
  let lastData = null;
  /**
   * office.js 가 넣어 주는 데이터로 패널 전체를 갱신한다.
   * 1분마다 활성 세션 수를 추이에 쌓고, 현황(서비스 탭·활성 세션·한도·프로젝트)·업무 현황(요청 우선·최근 순)·지난 세션·최근 알림(최대 8)·알림 배지·고른 고양이 상세를 만든다. 지난번과 HTML 이 같으면 DOM 은 건드리지 않는다.
   * @param {PanelData} data 고양이·플랜·알림·지난 세션
   * @returns {void}
   * @see card 본문 .wg-b, ring, spark, sevColor, untilText, agoText, durText, hhmm
   */
  function update(data) {
    if (!root) return;
    lastData = data;
    const cats = data.cats || [];
    const now = Date.now();
    if (now - lastSample > 60e3 || !history.length) { history.push(cats.length); if (history.length > 30) history.shift(); lastSample = now; }
    else history[history.length - 1] = cats.length;
    const delta = history.length > 1 ? cats.length - history[0] : 0;
    // 현황: 서비스 탭(전체 · Claude · ChatGPT · Antigravity) → 활성 세션 · 한도 · 프로젝트
    const plans = data.plans || { claude: data.plan ? { name: data.name, plan: data.plan } : null };
    const tabCats = overTab === 'all' ? cats : cats.filter((c) => (c.provider || 'claude') === overTab);
    const count = (pv) => cats.filter((c) => (c.provider || 'claude') === pv).length;
    const tabs = `<div class="ov-tabs" role="tablist">` + [['all', t('panel.tab.all'), null], ...Object.entries(PROVIDER).map(([k, [nm, col]]) => [k, nm, col])]
      .map(([k, nm, col]) => `<button role="tab" data-tab="${k}" title="${nm}" class="${overTab === k ? 'on' : ''}" aria-selected="${overTab === k}">${col ? logo(k) : ''}${{ chatgpt: 'GPT' }[k] || nm}<small>${k === 'all' ? cats.length : count(k)}</small></button>`).join('') + `</div>`;
    /**
     * 서비스의 플랜과 대표 한도 찾기.
     * 한도 목록에서 kind 가 session(5시간)·weekly_all(주간 전체)인 항목을 고른다.
     * @param {string} pv 서비스 id
     * @returns {{pl: (PanelPlan|null|undefined), s5: (ProviderLimit|undefined), wk: (ProviderLimit|undefined)}}
     */
    const limitsOf = (pv) => {
      const pl = plans[pv];
      const lim = (pl && pl.plan && pl.plan.limits) || [];
      return { pl, s5: lim.find((l) => l.kind === 'session'), wk: lim.find((l) => l.kind === 'weekly_all') };
    };
    const projects = {};
    for (const c of tabCats) { const k = c.project || t('panel.project.other'); projects[k] = (projects[k] || 0) + 1; }
    const plist = Object.entries(projects).sort((a, b) => b[1] - a[1]);
    let mid = '';
    if (overTab === 'all') {
      // 서비스마다 한 줄: 세션 수 · 5시간 한도
      mid = Object.entries(PROVIDER).map(([k, [nm, col]]) => {
        const { pl, s5 } = limitsOf(k);
        const right = s5 ? `<b style="color:${sevColor(s5.percent)}">${Math.round(s5.percent)}%</b>` : `<span class="ov-na">${pl ? '-' : t('panel.ov.notLinked')}</span>`;
        return `<div class="svc" data-tab="${k}">${logo(k)}<span>${nm}</span><small>${t('panel.ov.sessions', { n: count(k) })}</small>${right}</div>`;
      }).join('');
    } else {
      const { pl, s5, wk } = limitsOf(overTab);
      if (!pl) mid = `<div class="ov-na-box">${esc(t('panel.ov.noAccount', { name: PROVIDER[overTab][0] }))}<br><small>${t('panel.ov.noAccountHint')}</small></div>`;
      else {
        mid = `<div class="ov-row"><div><div class="ov-l">${esc(pl.name || t('panel.ov.account'))}${pl.plan && pl.plan.plan ? ` · ${esc(pl.plan.plan)}` : ''}</div>`
          + `<div class="ov-big">${s5 ? Math.round(s5.percent) + '<small>%</small>' : '-'}</div><div class="ov-s">${esc((s5 && s5.label) || t('panel.ov.limit5h'))}${s5 && s5.resets_at ? ' · ' + esc(untilText(s5.resets_at)) : ''}</div></div>`
          + (s5 ? ring(s5.percent, sevColor(s5.percent)) : '') + `</div>`
          + (wk ? `<div class="lim"><div class="lim-h"><span>${esc(wk.label || t('panel.ov.weeklyAll'))}</span><b>${Math.round(wk.percent)}%</b></div><div class="bar"><i style="width:${Math.min(100, wk.percent)}%;background:${sevColor(wk.percent)}"></i></div><div class="ov-s">${esc(wk.resets_at ? untilText(wk.resets_at) : '')}</div></div>` : '');
      }
    }
    const over = tabs
      + `<div class="ov-row"><div><div class="ov-l">${t('panel.ov.active')}</div><div class="ov-big">${tabCats.length}${overTab === 'all' && delta ? `<span class="ov-d ${delta > 0 ? 'up' : 'dn'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}</div></div>${overTab === 'all' ? spark(history) : ''}</div>`
      + `<div class="ov-sep"></div>` + mid
      + `<div class="ov-sep"></div><div class="ov-h">${t('panel.ov.projects')}</div>`
      + (plist.length ? plist.slice(0, 6).map(([k, n]) => `<div class="pj"><span>${esc(k)}</span><b>${n}</b></div>`).join('') : `<div class="wg-empty">${t('panel.ov.noSessions')}</div>`)
      + `<button class="ov-more" data-usage>${t('panel.ov.more')} <span>›</span></button>`;
    if (over !== lastOver) { wOver.querySelector('.wg-b').innerHTML = over; lastOver = over; }
    // 업무 현황
    // 순서: 요청(결정 필요)이 맨 위, 나머지는 최근 활동 순
    /**
     * 업무 현황 정렬 우선순위: 요청(결정 필요)이 맨 위.
     * @param {PanelCat} c 고양이
     * @returns {number} 0 = 요청 있음, 1 = 그 외
     */
    const order = (c) => (c.alert ? 0 : 1);
    /**
     * 고양이의 최근 활동 시각(ms).
     * lastAt → startedAt 순, 없으면 0.
     * @param {PanelCat} c 고양이
     * @returns {number} epoch ms
     */
    const when = (c) => Date.parse(c.lastAt || c.startedAt || '') || 0;
    const rows = cats.slice().sort((a, b) => order(a) - order(b) || when(b) - when(a) || String(a.title || a.project).localeCompare(String(b.title || b.project))).map((c) => {
      const [ptxt, pcol] = PROVIDER[c.provider] || PROVIDER.claude;
      const [dtxt, dcls] = status(c);
      return `<div class="cat-row ${c.id === selected ? 'on' : ''}" data-cat="${esc(c.id)}" title="${t('panel.row.goto')}">
        <span class="coin-logo" title="${ptxt}">${logo(c.provider)}</span>
        <div class="cat-m"><div class="cat-t">${esc(c.title || c.project || c.name)}</div>
        <div class="cat-s">${esc(c.name)}${c.level ? ` · Lv.${c.level.level}` : ''}${c.project && c.title ? ' · ' + esc(c.project) : ''}</div></div>
        <span class="chip ${dcls}">${esc(dtxt)}</span>${c.open ? `<button class="row-open" data-open-cat="${esc(c.id)}" title="${t('panel.row.open')}">${OPEN_IC}</button>` : ''}</div>`;
    }).join('');
    // 지난 세션: 끝난 로컬 세션(새 터미널에서 재개) · 지난 클라우드 세션(링크) — 예전 관리 창의 세션 목록
    const ended = (data.ended || []).map((x, i) => `<div class="end-row" data-ended="${i}" title="${t('panel.row.resume')}">
        <div class="cat-m"><div class="cat-t">${esc(x.title || x.project || t('panel.row.untitled'))}</div><div class="cat-s">${esc([x.project, x.lastAt ? agoText(x.lastAt) : ''].filter(Boolean).join(' · '))}</div></div>
        <span class="row-open">${OPEN_IC}</span></div>`).join('');
    const catsHtml = (rows || `<div class="wg-empty">${t('panel.ov.noSessions')}</div>`) + (ended ? `<div class="end-h">${t('panel.row.ended')}</div>${ended}` : '');
    if (catsHtml !== lastCats) { wCats.querySelector('.wg-b').innerHTML = catsHtml; lastCats = catsHtml; }
    wCats.querySelector('.wg-n').textContent = cats.length || '';
    // 최근 알림
    const al = (data.alerts || []).slice(0, 8);
    const alHtml = al.length ? al.map((e, i) => `<div class="al-row link ${e.resolved || e.read ? 'seen' : 'unread'}" data-al="${i}" title="${t('panel.al.open')}"><span class="al-svc" title="${esc((PROVIDER[e.provider] || [e.provider === 'app' ? 'Meowffice' : 'Claude'])[0])}">${logo(e.provider)}</span><span class="row-open al-open">${OPEN_IC}</span>
        <div class="al-t">${esc(e.title)}</div><div class="al-m">${esc(e.message)}</div>
        <div class="al-s">${esc(e.resolved ? t('panel.state.resolved') : t(STATE_KEY[e.state] || 'panel.state.other'))}${e.project ? ' · ' + esc(e.project) : ''} · ${esc(agoText(e.updated_at))}</div></div>`).join('')
      : `<div class="wg-empty">${t('panel.al.none')}</div>`;
    if (alHtml !== lastAlerts) { wAlerts.querySelector('.wg-b').innerHTML = alHtml; lastAlerts = alHtml; }
    // 숫자는 안 읽은 알림 수 — 카드를 펼쳐 확인하면(mark_alerts_read) 사라짐. 끝난(resolved) 건은 읽음으로 침
    const openN = (data.alerts || []).filter((e) => !e.resolved && !e.read).length;
    wAlerts.querySelector('.wg-n').textContent = openN || '';
    const b = bellBtn.querySelector('.bad'); b.hidden = !openN; b.textContent = openN;
    // 고른 고양이 상세
    if (selected) {
      const c = cats.find((x) => x.id === selected);
      if (!c) { selected = null; wSel.hidden = true; if (docked) onChat(null); return; }
      if (docked) { // 도크의 '정보' 탭으로
        const [dtxt, dcls] = status(c);
        onInfo(c, selHtml(c, true), { logo: logo(c.provider), chip: `<span class="chip ${dcls}">${esc(dtxt)}</span>` });
        return;
      }
      const html = selHtml(c);
      if (html !== lastSel) { wSel.innerHTML = html; lastSel = html; }
    }
  }

  /**
   * 최근 알림 카드가 펼쳐져 보이는지 (읽음 처리 판단용).
   * @returns {boolean}
   */
  function alertsVisible() { return !!wAlerts && !wAlerts.classList.contains('closed'); }

  /**
   * 공개 API 묶음.
   * init · resetLayout · update · select · unselect · alertsVisible 와, 사용량 상세를 여는 콜백을 등록하는 onUsage(fn) 를 노출한다.
   * @returns {{init: function, resetLayout: function, update: function, select: function, unselect: function, alertsVisible: function, onUsage: function(function(string):void):void}}
   */
  // 언어가 바뀌면 캐시를 비우고 본문을 다시 그린다 (카드 제목·툴팁은 data-i18n 으로 I18N.apply 가 채움)
  window.addEventListener('meow-lang', () => { lastOver = lastCats = lastAlerts = lastSel = ''; if (lastData) update(lastData); });

  return { init, resetLayout, update, select, unselect, alertsVisible, overlaps, onUsage: (fn) => { onUsage = fn; } };
})();
