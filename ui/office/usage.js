/**
 * @file 사용량 상세 (트레이 패널의 플랜·토큰·API 크레딧 화면을 오피스 스타일로).
 * 탭: Claude 플랜(모든 한도·사용 비중·추가 사용량·크레딧) / 토큰 사용량(이 PC Claude Code: 오늘·7일·30일, 모델별·추이) / API 크레딧(Console).
 * 서비스: 현황 카드에서 고른 탭을 따라 연다 (Claude / ChatGPT / Antigravity). 머리의 서비스 탭으로 바꿀 수도 있다.
 * ChatGPT·Antigravity 탭: 플랜 한도(+로그인 안내) / 토큰 사용량 (Rust get_provider_tokens, Claude 와 같은 차트·표).
 * 서비스 탭 본문 = [계정 · 웹 블록(항상, Rust get_web_services: 바로가기·장애 상태)] → [도구 블록(연결 상태 snap.state 에 따름)].
 * 내보내기 리포트 탭(export): 서비스별 공식 내보내기 파일 분석 결과 (@see OfficeExports.render, ui/office/exports.js).
 * 공개 API: OfficeUsage.init(stage, { invoke, openSettings(pane), getPlan(), getProvider(name), providerOn(name) }) → { open({ svc, tab }?), close() }.
 */
/**
 * @typedef {Object} UsageOpts
 * @property {function(string, Object=):Promise<*>} [invoke] Tauri invoke (없으면 시연 자료)
 * @property {function(string):void} [openSettings] 설정 열기(pane)
 * @property {function():(ClaudePlan|null)} [getPlan] Claude 플랜 (office.js 가 받아 둔 값)
 * @property {function(string):(ProviderSnapshot|null)} [getProvider] 서비스 스냅샷 (ProviderSnapshot 은 settings.js 정의)
 * @property {function(string):boolean} [providerOn] 서비스 연동이 켜져 있는지
 */
/**
 * @typedef {Object} UsageLimit
 * @property {string} kind session | weekly_all | weekly_scoped 등
 * @property {string} label 화면 이름
 * @property {number} percent 사용 %
 * @property {string} [resets_at] 초기화 시각(ISO)
 * @property {number} [share_of_weekly] 주간 전체 중 비중(%)
 * @property {number} [allowance_of_weekly] 허용 비중(%)
 */
/**
 * @typedef {Object} ClaudePlan
 * @property {string} plan 요금제 이름
 * @property {{name: string}} account 계정
 * @property {UsageLimit[]} limits 한도 목록
 * @property {Array<{name: string, percent: number}>} breakdown 주간 사용 비중
 * @property {{used: number, limit: (number|null), currency: string}|null} extra 추가 사용량
 * @property {{balance: number, currency: string, promos: Array<{name: string, remaining: number, expires_at: (string|null)}>}|null} credits 사용 크레딧
 * @property {Array<{label: string, percent: number, resets_at: (string|null), terms: (string|undefined)}>} promos 프로모션
 */
/**
 * @typedef {Object} TokenUsage
 * @property {number} days 집계 일수
 * @property {number} total 토큰 합계
 * @property {number} turns 응답 수
 * @property {number} [running] 실행 중 세션 수
 * @property {Array<{model: string, total: number, turns: number}>} by_model 모델별
 * @property {TrendItem[]} trend 추이
 * @property {"hour"|"day"} trend_unit 추이 단위
 */
/**
 * @typedef {Object} TrendItem
 * @property {string} label 축 라벨
 * @property {string} [key] 툴팁에 쓸 이름(없으면 label)
 * @property {number} total 값
 */
/**
 * @typedef {Object} ApiUsage
 * @property {boolean} configured Admin API 키 설정됨
 * @property {{total: number, daily: Array<{date: string, amount: number}>, by_model: Array<{model: string, amount: number}>}} [report] 이번 달 보고서
 * @property {number} [allocated] 월 할당 크레딧(USD)
 * @property {string} [error] 오류 문구
 */
'use strict';

const OfficeUsage = (() => {
  /**
   * HTML 특수문자(& < > " ') 이스케이프.
   * null/undefined 는 빈 문자열.
   * @param {*} s 이스케이프할 값
   * @returns {string} 안전한 문자열
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /**
   * 토큰 수 줄임 표기.
   * 1e9 이상 "B", 1e6 이상 "M", 1e3 이상 "K"(소수 1자리), 그 외 정수 문자열. 빈 값은 "0".
   * @param {number} n 토큰 수
   * @returns {string} 표기
   */
  const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0));
  /**
   * 금액 표기(소수 2자리, 천 단위 쉼표).
   * USD 는 "$" 접두, 그 외 통화는 통화 코드 + 공백.
   * @param {number} n 금액
   * @param {string} [cur="USD"] 통화 코드
   * @returns {string} 표기
   */
  const usd = (n, cur = 'USD') => (cur === 'USD' ? '$' : cur + ' ') + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /**
   * 사용 %에 따른 색.
   * 85% 이상 빨강, 60% 이상 주황, 아니면 보라.
   * @param {number} p 사용 %
   * @returns {string} 색 코드
   */
  const sev = (p) => (p >= 85 ? '#e5534b' : p >= 60 ? '#e3a43a' : '#8b6dff');
  /**
   * 초기화까지 남은 시간 + 초기화 시각 문구.
   * "n일 m시간 / n시간 m분 / m분 뒤 초기화 · 날짜 요일 시각". 이미 지났거나 잘못된 값이면 빈 문자열.
   * @param {string} iso 초기화 시각(ISO)
   * @returns {string} 문구
   */
  const until = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return '';
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
    const left = h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
    const at = new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    return `${left} 뒤 초기화 · ${at}`;
  };
  /**
   * 추이 막대 그래프(SVG + 축 라벨) HTML.
   * items 를 막대로, 값이 이전보다 줄면 bar-down 색, 0 은 얇은 선. 막대마다 투명 히트 영역에 data-tip(JSON: 날짜·값·이전 대비)을 달아 마우스 툴팁에 쓴다. 라벨은 약 6개만 표시.
   * @param {TrendItem[]} items 막대 데이터
   * @param {function(number):string} fmt 값 표시 함수
   * @param {"hour"|"day"} unit 툴팁 문구 단위(이전 시간 대비 / 전일 대비)
   * @returns {string} HTML
   * @see mousemove 툴팁(init)
   */
  function trendHtml(items, fmt, unit) {
    if (!items.length) return '<div class="us-empty">기록이 없습니다</div>';
    const W = 100, H = 40, pad = 2, n = items.length;
    const max = items.reduce((m, x) => Math.max(m, x.total), 0) || 1;
    const colW = W / n, bw = colW * 0.9;
    const yOf = (v) => H - pad - (v / max) * (H - 2 * pad);
    let bars = '', hits = '';
    const pts = [];
    items.forEach((it, i) => {
      const cx = (i + 0.5) * colW, y = yOf(it.total);
      const up = i === 0 || it.total >= items[i - 1].total;
      const cls = it.total > 0 ? (up ? 'bar-up' : 'bar-down') : 'zero';
      const top = it.total > 0 ? Math.min(y, H - pad - 1) : H - pad - 0.6;
      bars += `<rect class="tbar ${cls}" x="${(cx - bw / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bw.toFixed(2)}" height="${(H - pad - top).toFixed(2)}"/>`;
      const prev = i > 0 ? items[i - 1].total : null;
      const tip = esc(JSON.stringify({ d: it.key || it.label, a: fmt(it.total), p: prev == null ? null : (it.total >= prev ? '▲ ' : '▼ ') + fmt(Math.abs(it.total - prev)) + (unit === 'hour' ? ' (이전 시간 대비)' : ' (전일 대비)'), u: prev == null || it.total >= prev }));
      hits += `<rect class="d-hit" x="${(i * colW).toFixed(2)}" y="0" width="${colW.toFixed(2)}" height="${H}" data-tip="${tip}"/>`;
      pts.push(`${cx.toFixed(2)},${y.toFixed(2)}`);
    });
    const line = n > 1 ? `<path d="M${pts.join(' L')}" class="spark-line"/>` : '';
    const step = Math.max(1, Math.ceil(n / 6));
    let ax = '';
    for (let i = 0; i < n; i += step) ax += `<span style="left:${((i + 0.5) * colW).toFixed(2)}%">${esc(items[i].label)}</span>`;
    return `<div class="us-trend"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="us-spark">${bars}${line}${hits}</svg></div><div class="us-axis">${ax}</div>`;
  }

  /**
   * 문구 번역(i18n.js 가 없으면 키 그대로).
   * @param {string} k 문구 키
   * @param {Object<string,*>} [p] 자리표시 값
   * @returns {string} 번역 문구
   */
  const tr = (k, p) => (typeof I18N !== 'undefined' ? I18N.t(k, p) : k);

  const COLORS = ['#8b6dff', '#29b7c0', '#e8915a', '#7a6ff0', '#4fb08a', '#e0708f', '#d9b44a'];

  // 브라우저 시연용 자료
  const DEMO = {
    plan: { plan: 'Max 20x', account: { name: '시연 계정' }, limits: [
      { kind: 'session', label: '5시간 세션', percent: 42, resets_at: new Date(Date.now() + 2.3 * 3600e3).toISOString() },
      { kind: 'weekly_all', label: '주간 · 전체 모델', percent: 67, resets_at: new Date(Date.now() + 2.4 * 86400e3).toISOString() },
      { kind: 'weekly_scoped', label: '주간 · Fable', percent: 30, resets_at: new Date(Date.now() + 2.4 * 86400e3).toISOString(), share_of_weekly: 15, allowance_of_weekly: 50 },
    ], breakdown: [{ name: 'Claude Code', percent: 88 }, { name: 'Chats', percent: 12 }], extra: { used: 12.5, limit: 50, currency: 'USD' }, credits: null, promos: [] },
    /**
     * 브라우저 시연용 토큰 사용량 자료 만들기.
     * 일수에 비례한 합계·응답 수·모델별·무작위 추이를 만든다. 1일이면 24개 시간별, 아니면 일별.
     * @param {number} days 일수(1·7·30)
     * @returns {TokenUsage}
     */
    local: (days) => ({ days, total: 48e6 * days / 7, turns: 420 * days, by_model: [{ model: 'claude-opus-5-5', total: 31e6 * days / 7, turns: 260 * days }, { model: 'claude-sonnet-5-5', total: 14e6 * days / 7, turns: 130 * days }, { model: 'claude-haiku-5-5', total: 3e6 * days / 7, turns: 30 * days }],
      trend: Array.from({ length: days === 1 ? 24 : days }, (_, i) => ({ label: days === 1 ? `${i}시` : `${i + 1}`, total: Math.round((0.4 + Math.random()) * 2e6) })), trend_unit: days === 1 ? 'hour' : 'day' }),
    api: { configured: false },
    web: [
      { id: 'claude', label: 'Claude', account: 'Anthropic', url: 'https://claude.ai', tool: 'claude', alertable: false, alerts_on: true, checked: true, issue: null, status_page: 'https://status.claude.com' },
      { id: 'chatgpt', label: 'ChatGPT', account: 'OpenAI', url: 'https://chatgpt.com', tool: 'chatgpt', alertable: true, alerts_on: false, checked: true, issue: null, status_page: 'https://status.openai.com' },
      { id: 'gemini', label: 'Gemini', account: 'Google', url: 'https://gemini.google.com', tool: 'antigravity', alertable: true, alerts_on: false, checked: true, issue: null, status_page: 'https://www.google.com/appsstatus/dashboard' },
    ],
  };
  /** 서비스 표시 이름 · 토큰 기록 출처 문구 */
  const SVC_NAME = { claude: 'Claude Code', chatgpt: 'ChatGPT(Codex)', antigravity: 'Antigravity' };
  /** 로그인 안내 문구와 버튼 이름 (버튼을 눌러야만 실행한다) */
  const LOGIN = {
    chatgpt: { btn: 'Codex 로그인', how: '버튼을 누르면 터미널에서 <code>codex login</code> 을 실행합니다. Codex CLI 를 못 찾으면 Codex 앱을 엽니다.' },
    antigravity: { btn: 'Antigravity 앱 열기', how: '버튼을 누르면 Antigravity 앱을 엽니다. 앱에서 Google 계정으로 로그인하세요.' },
  };

  let root, opts, tab = 'plan', days = 7, svc = 'claude', web = null;
  const SVC = [['claude', 'Claude', '#e8915a'], ['chatgpt', 'ChatGPT', '#3fae8c'], ['antigravity', 'Antigravity', '#5b8def']];
  /**
   * 사용량 상세 오버레이를 만들어 무대에 붙인다.
   * 머리(서비스 탭·플랜/토큰/API 탭)와 본문 틀을 만들고, 클릭 위임(닫기·서비스·탭·기간·설정 열기·로그인), Esc 닫기, 차트 호버 툴팁을 건다. 처음엔 숨김.
   * @param {HTMLElement} stage 붙일 무대 요소
   * @param {UsageOpts} [o={}] 주입 도구
   * @returns {void}
   * @see render, close, loginClick
   */
  function init(stage, o = {}) {
    opts = o;
    root = document.createElement('div');
    root.className = 'us-overlay';
    root.hidden = true;
    root.innerHTML = `<div class="us-card" role="dialog" aria-label="사용량 상세">
      <header class="us-head3">
        <div class="us-r1"><b>사용량 상세</b><button class="us-x" title="닫기 (Esc)">×</button></div>
        <nav class="us-svc">${SVC.map(([k, t]) => `<button data-svc="${k}"><i class="pv-logo pv-${k}" aria-hidden="true"></i>${t}</button>`).join('')}</nav>
        <nav class="us-tabs"><button data-t="plan">플랜 한도</button><button data-t="tokens">토큰 사용량</button><button data-t="api" data-claude-only>API 크레딧</button><button data-t="export" data-i18n="exp.tab"></button></nav>
      </header>
      <div class="us-acct"></div><div class="us-b"></div></div>`;
    stage.appendChild(root);
    I18N.apply(root);
    /**
     * 오버레이 클릭 위임 처리.
     * 배경·× → 닫기, data-svc/t/days → 상태 바꾸고 다시 그림, data-settings → 닫고 설정 열기, data-login → 로그인 단추 처리.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see close, render, loginClick, opts.openSettings
     */
    root.addEventListener('click', (e) => {
      if (e.target === root || e.target.closest('.us-x')) return close();
      const sv = e.target.closest('[data-svc]'); if (sv) { svc = sv.dataset.svc; render(); return; }
      const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; render(); return; }
      const d = e.target.closest('[data-days]'); if (d) { days = Number(d.dataset.days); render(); return; }
      const u = e.target.closest('[data-url]');
      if (u) { e.preventDefault(); if (opts.invoke) opts.invoke('open_url', { url: u.dataset.url }).catch(() => {}); return; }
      const s = e.target.closest('[data-settings]'); if (s) e.preventDefault();
      if (s && opts.openSettings) { close(); opts.openSettings(s.dataset.settings); return; }
      const lg = e.target.closest('[data-login]'); if (lg) loginClick(lg);
    });
    /**
     * Esc 키로 상세 닫기(열려 있을 때만).
     * @param {KeyboardEvent} e 키 이벤트
     * @returns {void}
     * @see close
     */
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
    // 차트 호버 툴팁 (패널과 같은 모양)
    const tip = document.createElement('div');
    tip.className = 'us-tip';
    tip.hidden = true;
    root.appendChild(tip);
    /**
     * 차트 막대 위 호버 툴팁.
     * .d-hit 의 data-tip(JSON)을 읽어 날짜·값·이전 대비를 마우스 근처에 보이고, 그 밖이면 숨긴다.
     * @param {MouseEvent} e 마우스 이벤트
     * @returns {void}
     * @see trendHtml
     */
    root.addEventListener('mousemove', (e) => {
      const h = e.target.closest && e.target.closest('.d-hit');
      if (!h) { tip.hidden = true; return; }
      const t = JSON.parse(h.dataset.tip);
      tip.innerHTML = `<div class="tip-date">${esc(t.d)}</div><div class="tip-amt">${esc(t.a)}</div>${t.p ? `<div class="tip-delta ${t.u ? 'up' : 'down'}">${esc(t.p)}</div>` : ''}`;
      tip.hidden = false;
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY - 12 + 'px';
    });
    root.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
  /**
   * 사용량 상세를 연다.
   * 문자열이면 Claude 의 탭(plan|tokens|api), 객체면 서비스(svc, 모르면 claude)와 탭을 지정. 보이게 하고 render.
   * @param {string|{svc?: string, tab?: string}} [o] 탭 이름 또는 { svc, tab }
   * @returns {void}
   * @see render
   */
  function open(o) {
    if (typeof o === 'string') tab = o;
    else if (o) { if (o.svc) svc = SVC.some(([k]) => k === o.svc) ? o.svc : 'claude'; if (o.tab) tab = o.tab; }
    root.hidden = false;
    render();
    loadWeb();
  }
  /**
   * 사용량 상세를 닫는다(숨김).
   * @returns {void}
   */
  function close() { root.hidden = true; }

  /**
   * Tauri 명령 호출 도우미.
   * invoke 가 없거나 호출이 실패하면 null.
   * @param {string} cmd 명령 이름
   * @param {Object} [args] 인자
   * @returns {Promise<*>|null} 결과 또는 null
   * @see opts.invoke
   */
  const call = async (cmd, args) => (opts.invoke ? opts.invoke(cmd, args).catch(() => null) : null);
  /**
   * '불러오는 중' 표시 요소 (공통 로딩 표시 OfficeLoading 이 있으면 발자국 애니메이션, 없으면 글자만).
   * @returns {HTMLElement}
   */
  const loadingEl = () => {
    const w = document.createElement('div');
    w.className = 'us-load';
    w.appendChild(typeof OfficeLoading !== 'undefined' ? OfficeLoading.el('불러오는 중…') : document.createTextNode('불러오는 중…'));
    return w;
  };
  /**
   * 현재 서비스·탭에 맞는 본문을 그린다.
   * 탭 단추 강조·Claude 전용 탭 표시를 맞춘 뒤, Claude 는 plan/tokens/api 중 하나(get_local · get_api_usage 호출), 다른 서비스는 플랜 한도(오피스가 받아 둔 값) 또는 토큰(get_provider_tokens)을 그린다. 비동기 응답이 늦게 와도 그사이 탭·서비스가 바뀌었으면 버린다.
   * @returns {Promise<void>}
   * @see planHtml, tokensHtml, apiHtml, providerHtml, OfficeExports.render(export 탭), Tauri 명령 get_local · get_api_usage · get_provider_tokens
   */
  async function render() {
    for (const b of root.querySelectorAll('.us-svc button')) b.classList.toggle('on', b.dataset.svc === svc);
    for (const b of root.querySelectorAll('.us-tabs button')) b.classList.toggle('on', b.dataset.t === tab);
    // API 크레딧(Console) 탭은 Claude 만. 다른 서비스는 플랜 한도·토큰 사용량 두 탭
    for (const b of root.querySelectorAll('[data-claude-only]')) b.hidden = svc !== 'claude';
    if (svc !== 'claude' && tab === 'api') tab = 'plan';
    paintAccount();
    for (const b of root.querySelectorAll('.us-tabs button')) b.classList.toggle('on', b.dataset.t === tab);
    const body = root.querySelector('.us-b');
    // 내보내기 리포트 탭: 서비스 탭을 따라 그 서비스의 공식 내보내기 파일 리포트 (exports.js)
    if (tab === 'export') { OfficeExports.render(body, { invoke: opts.invoke, svc, setSvc: (s) => { svc = s; render(); } }); return; }
    if (svc !== 'claude') {
      if (tab !== 'tokens' || (opts.providerOn && !opts.providerOn(svc))) { body.innerHTML = providerHtml(svc); return; }
      body.replaceChildren(loadingEl());
      const want = svc, wantTab = tab;
      const r = opts.invoke ? await call('get_provider_tokens', { name: svc, days }) : null;
      if (want === svc && wantTab === tab && !root.hidden) body.innerHTML = tokensHtml(r, svc);
      return;
    }
    body.replaceChildren(loadingEl());
    const want = tab;
    let html = '';
    if (tab === 'plan') html = planHtml((opts.getPlan && opts.getPlan()) || (opts.invoke ? null : DEMO.plan));
    else if (tab === 'tokens') html = tokensHtml(opts.invoke ? await call('get_local', { days }) : DEMO.local(days), 'claude');
    else html = apiHtml(opts.invoke ? await call('get_api_usage', { force: false }) : DEMO.api);
    if (want === tab && !root.hidden) body.innerHTML = html;
  }

  /**
   * 웹 서비스 표·장애 상태를 받아 계정 블록을 다시 그린다.
   * Tauri 밖이면 시연 자료. 실패하면 빈 목록(블록 없음).
   * @returns {Promise<void>}
   * @see paintAccount, Tauri 명령 get_web_services
   */
  async function loadWeb() {
    web = opts.invoke ? (await call('get_web_services')) || [] : DEMO.web;
    paintAccount();
  }
  /**
   * 계정 블록 자리(.us-acct)를 현재 서비스·탭에 맞게 채운다. 플랜 한도 탭에서만 보인다.
   * @returns {void}
   * @see accountHtml
   */
  function paintAccount() {
    const el = root.querySelector('.us-acct');
    if (el) el.innerHTML = tab === 'plan' ? accountHtml(svc) : '';
  }
  /**
   * 계정 · 웹 블록 HTML: 서비스 로고·계정 · 장애 상태 칩 · [웹에서 열기] · 장애 설명 · 알림 켜기 안내, 그 아래 "도구" 머리.
   * 도구가 없어도 보인다(웹 서비스만 쓰는 사용자용). 해당 서비스가 표에 없으면 빈 문자열.
   * @param {string} name 서비스 이름("claude" | "chatgpt" | "antigravity")
   * @returns {string} HTML
   * @see loadWeb, 계정 → 도구: Rust providers::WEB_SERVICES
   */
  function accountHtml(name) {
    const w = (web || []).find((x) => x.tool === name);
    if (!w) return '';
    const [cls, chip] = w.issue ? ['bad', tr('web.state.issue')] : !w.alerts_on ? ['off', tr('web.state.off')] : !w.checked ? ['', tr('web.state.checking')] : ['ok', tr('web.state.ok')];
    const issue = w.issue ? `<div class="us-web-d">${esc(w.issue.detail)} <a href="#" data-url="${esc(w.issue.url)}">${esc(tr('web.detail'))}</a></div>` : '';
    const hint = w.alertable && !w.alerts_on ? `<div class="us-web-d">${esc(tr('web.alerts.hint'))} <a href="#" data-settings="alerts">${esc(tr('web.alerts.goto'))}</a></div>` : '';
    return `<div class="us-web">
      <div class="us-web-h"><i class="pv-logo pv-${esc(w.id)}" aria-hidden="true"></i><b>${esc(w.label)}</b><small>${esc(tr('web.account', { account: w.account }))}</small>
        <span class="us-web-st ${cls}">${esc(chip)}</span>
        <button class="us-web-open" data-url="${esc(w.url)}">${esc(tr('web.open'))}</button></div>${issue}${hint}
    </div>
    <div class="us-h us-tool-h">${esc(tr('web.tool', { tool: SVC_NAME[name] || name }))}</div>`;
  }

  /**
   * Claude 플랜 한도 화면 HTML.
   * 한도별 막대(사용 %·초기화 시각·주간 비중) → 주간 사용 비중 막대 → 추가 사용량 → 사용 크레딧 → 프로모션 순.
   * @param {ClaudePlan|null} p 플랜 정보
   * @returns {string} HTML
   * @see sev, until, usd
   */
  function planHtml(p) {
    if (!p) return '<div class="us-empty">플랜 정보를 아직 불러오지 못했어요. 잠시 뒤 다시 열어 보세요.</div>';
    const lim = p.limits || [];
    const rows = lim.map((l) => {
      const pct = Math.max(0, Math.min(100, l.percent || 0));
      const share = l.share_of_weekly != null ? `<div class="us-sub">주간 전체의 ${Math.round(l.share_of_weekly)}% 사용${l.allowance_of_weekly != null ? ` · 허용 ${Math.round(l.allowance_of_weekly)}%` : ''}</div>` : '';
      return `<div class="us-lim"><div class="us-lh"><span>${esc(l.label || l.kind)}</span><b style="color:${sev(pct)}">${Math.round(pct)}%</b></div>
        <div class="us-bar"><i style="width:${pct}%;background:${sev(pct)}"></i></div>
        <div class="us-sub">${esc(l.resets_at ? until(l.resets_at) : '')}</div>${share}</div>`;
    }).join('');
    const br = (p.breakdown || []).filter((b) => b.percent > 0);
    const brHtml = br.length ? `<div class="us-h">주간 사용 비중</div><div class="us-stack">${br.map((b, i) => `<i style="width:${b.percent}%;background:${COLORS[i % COLORS.length]}" title="${esc(b.name)} ${Math.round(b.percent)}%"></i>`).join('')}</div>
      <div class="us-legend">${br.map((b, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(b.name)} ${Math.round(b.percent)}%</span>`).join('')}</div>` : '';
    const ex = p.extra ? `<div class="us-h">추가 사용량</div><div class="us-kv"><span>이번 달 사용</span><b>${usd(p.extra.used, p.extra.currency)}${p.extra.limit != null ? ` / ${usd(p.extra.limit, p.extra.currency)}` : ''}</b></div>` : '';
    const cr = p.credits ? `<div class="us-h">사용 크레딧</div><div class="us-kv"><span>잔액</span><b>${usd(p.credits.balance, p.credits.currency)}</b></div>${(p.credits.promos || []).map((t) => `<div class="us-kv"><span>${esc(t.name)}</span><b>${usd(t.remaining, p.credits.currency)}${t.expires_at ? ` · ${new Date(t.expires_at).toLocaleDateString('ko-KR')} 만료` : ''}</b></div>`).join('')}` : '';
    const pr = (p.promos || []).length ? `<div class="us-h">프로모션</div>${p.promos.map((x) => `<div class="us-lim"><div class="us-lh"><span>${esc(x.label)}</span><b>${Math.round(x.percent)}%</b></div><div class="us-bar"><i style="width:${Math.min(100, x.percent)}%;background:${sev(x.percent)}"></i></div><div class="us-sub">${esc(x.resets_at ? until(x.resets_at) : x.terms || '')}</div></div>`).join('')}` : '';
    return `<div class="us-acc"><b>${esc((p.account && p.account.name) || '계정')}</b>${p.plan ? `<span>${esc(p.plan)}</span>` : ''}</div>
      <div class="us-grid">${rows || '<div class="us-empty">한도 정보가 없습니다</div>'}</div>${brHtml}${ex}${cr}${pr}`;
  }

  /**
   * 로그인 안내 상자 HTML (설치돼 있는데 로그아웃·만료일 때).
   * 버튼은 사용자가 눌러야만 실행된다(data-login). 정의되지 않은 서비스면 빈 문자열.
   * @param {string} name 서비스 이름
   * @param {string} title 서비스 표시 이름
   * @param {boolean} expired true 면 "만료" 문구
   * @returns {string} HTML 또는 빈 문자열
   * @see LOGIN, loginClick
   */
  function loginGuide(name, title, expired) {
    const g = LOGIN[name];
    if (!g) return '';
    return `<div class="us-login"><b>${esc(title)} ${expired ? '로그인이 만료되었어요' : '에 로그인되어 있지 않아요'}</b>
      <p>${g.how}</p><button class="us-btn" data-login="${esc(name)}">${esc(g.btn)}</button><small class="us-login-msg"></small></div>`;
  }
  /**
   * 로그인 안내의 [로그인] 단추 처리.
   * 단추를 잠그고 provider_login 을 실행해(Tauri 밖이면 "app" 으로 간주) 안내 문구를 바꾼다. 4초 뒤 단추를 푼다.
   * @param {HTMLButtonElement} btn 눌린 단추(data-login = 서비스 이름)
   * @returns {Promise<void>}
   * @see Tauri 명령 provider_login
   */
  async function loginClick(btn) {
    const msg = btn.parentElement.querySelector('.us-login-msg');
    btn.disabled = true;
    try {
      const how = opts.invoke ? await opts.invoke('provider_login', { name: btn.dataset.login }) : 'app';
      if (msg) msg.textContent = how === 'cli' ? '터미널 창에서 로그인을 진행하세요. 끝나면 이 화면을 다시 열어 주세요.' : '앱을 열었어요. 앱에서 로그인한 뒤 이 화면을 다시 열어 주세요.';
    } catch (e) { if (msg) msg.textContent = '실행하지 못했어요: ' + e; }
    setTimeout(() => { btn.disabled = false; }, 4000);
  }

  /**
   * ChatGPT·Antigravity 플랜 화면 HTML: 계정·요금제 · 한도 · 최근 세션.
   * Rust get_provider 값(오피스가 10초마다 받아 둔 것)을 쓴다. 연동 꺼짐·불러오는 중·미설치(state)·로그인 필요(안내)를 먼저 걸러내고, 한도 막대·최근 세션 12개·기준 시각을 그린다.
   * @param {string} name 서비스 이름("chatgpt" | "antigravity")
   * @returns {string} HTML
   * @see opts.providerOn, opts.getProvider, loginGuide, sev, until
   */
  function providerHtml(name) {
    const title = (SVC.find(([k]) => k === name) || [])[1] || name;
    if (opts.providerOn && !opts.providerOn(name)) {
      return `<div class="us-empty">${esc(title)} 연동이 꺼져 있어요.<br><button class="us-btn" data-settings="${esc(name)}">설정 › ${esc(title)} 에서 켜기</button></div>`;
    }
    const p = opts.getProvider ? opts.getProvider(name) : null;
    if (!p) return '<div class="us-empty">불러오는 중이에요. 잠시 뒤 다시 열어 보세요.</div>';
    if (p.state === 'not_installed') return `<div class="us-empty">${esc(tr('usage.tool.missing', { tool: SVC_NAME[name] || title }))}</div>`;
    if (p.state === 'logged_out') return loginGuide(name, title, false) || `<div class="us-empty">${esc(title)} 에 로그인되어 있지 않아요.${p.error ? `<br><small>${esc(p.error)}</small>` : ''}</div>`;
    const rows = (p.limits || []).filter((l) => l.percent != null).map((l) => {
      const pct = Math.max(0, Math.min(100, l.percent));
      return `<div class="us-lim"><div class="us-lh"><span>${esc(l.label || l.kind)}</span><b style="color:${sev(pct)}">${Math.round(pct)}%</b></div>
        <div class="us-bar"><i style="width:${pct}%;background:${sev(pct)}"></i></div>
        <div class="us-sub">${esc(l.resets_at ? until(l.resets_at) : '')}</div></div>`;
    }).join('');
    const ST = { busy: ['일하는 중', 'busy'], idle: ['쉬는 중', 'idle'], '': ['끝남', 'off'] };
    const ses = (p.sessions || []).slice(0, 12).map((x) => {
      const [st, cls] = ST[x.status] || ST[''];
      const when = x.last_at ? new Date(x.last_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      return `<div class="us-ses"><span class="chip ${cls}">${st}</span><div><b>${esc(x.title || '(제목 없음)')}</b><small>${esc([x.project, when].filter(Boolean).join(' · '))}</small></div></div>`;
    }).join('');
    const at = p.fetched_at ? new Date(p.fetched_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    return `${p.state === 'expired' ? loginGuide(name, title, true) : ''}<div class="us-acc"><b>${esc(p.account || '계정')}</b>${p.plan ? `<span>${esc(p.plan)}</span>` : ''}</div>
      <div class="us-grid">${rows || `<div class="us-empty">한도 정보가 없습니다${p.error ? `<br><small>${esc(p.error)}</small>` : ''}</div>`}</div>
      ${rows && p.error ? `<div class="us-note">※ ${esc(p.error)}</div>` : ''}
      <div class="us-h">최근 세션</div>${ses || '<div class="us-empty">최근 24시간 세션이 없습니다</div>'}
      <div class="us-note">※ ${esc(at)} 기준 · 이 PC 의 ${esc(title)} 기록</div>`;
  }

  /**
   * 토큰 사용량 화면 HTML (Claude·ChatGPT·Antigravity 공통).
   * 기간 단추(오늘·7일·30일) → 토큰·응답 수·실행 중 세션 → 추이 그래프 → 모델별 막대. 값이 없으면 읽지 못했다는 안내.
   * @param {TokenUsage|null} r 사용 기록(Rust get_local · get_provider_tokens)
   * @param {string} name 서비스 이름
   * @returns {string} HTML
   * @see trendHtml, tok, SVC_NAME
   */
  function tokensHtml(r, name) {
    const what = SVC_NAME[name] || SVC_NAME.claude;
    const sel = `<div class="us-days">${[[1, '오늘'], [7, '7일'], [30, '30일']].map(([d, t]) => `<button data-days="${d}" class="${d === days ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    if (!r) return sel + `<div class="us-empty">이 PC 의 ${esc(what)} 사용 기록을 읽지 못했어요.</div>`;
    const models = (r.by_model || []).slice().sort((a, b) => b.total - a.total);
    const max = Math.max(1, ...models.map((m) => m.total));
    const trend = r.trend || [];
    return sel + `<div class="us-big"><div><small>토큰</small><b>${tok(r.total)}</b></div><div><small>응답 수</small><b>${(r.turns || 0).toLocaleString()}</b></div><div><small>실행 중 세션</small><b>${r.running ?? '-'}</b></div></div>
      <div class="us-h">${r.trend_unit === 'hour' ? '시간대별 추이 (오늘)' : `일별 추이 (최근 ${r.days || days}일)`}</div>${trendHtml(trend, (v) => tok(v) + ' 토큰', r.trend_unit)}
      <div class="us-note">※ 이 PC 의 ${esc(what)} 기록 기준 (캐시 토큰 포함${name === 'chatgpt' ? ' · 다른 에이전트에서 가져온 세션은 제외' : ''})</div>
      <div class="us-h">모델별</div>${models.length ? models.map((m, i) => `<div class="us-model"><span>${esc(m.model)}</span><div class="us-bar"><i style="width:${(m.total / max) * 100}%;background:${COLORS[i % COLORS.length]}"></i></div><b>${tok(m.total)}</b></div>`).join('') : '<div class="us-empty">사용 기록이 없습니다</div>'}`;
  }

  /**
   * API 크레딧(Console) 화면 HTML.
   * 키 미설정이면 설정 안내, 보고서가 없으면 오류, 있으면 이번 달 사용액·할당·남은 금액·일별 추이·모델별 사용액.
   * @param {ApiUsage|null} a Rust get_api_usage 결과
   * @returns {string} HTML
   * @see trendHtml, usd, sev
   */
  function apiHtml(a) {
    if (!a || !a.configured) {
      return `<div class="us-empty">Claude API(Console) 사용액을 보려면 Admin API 키가 필요해요.<br><button class="us-btn" data-settings="claude">설정 › Claude 에서 키 입력</button></div>`;
    }
    if (!a.report) return `<div class="us-empty">불러오지 못했어요: ${esc(a.error || '알 수 없는 오류')}</div>`;
    const r = a.report, alloc = a.allocated || 0, pct = alloc > 0 ? Math.min(100, (r.total / alloc) * 100) : 0;
    const daily = (r.daily || []).map((d) => ({ label: `${+d.date.slice(5, 7)}/${+d.date.slice(8, 10)}`, key: d.date, total: d.amount }));
    const models = (r.by_model || []).slice().sort((x, y) => y.amount - x.amount), mmax = Math.max(0.01, ...models.map((m) => m.amount));
    return `<div class="us-big"><div><small>이번 달 사용액</small><b>${usd(r.total)}</b></div>${alloc > 0 ? `<div><small>할당</small><b>${usd(alloc)}</b></div><div><small>남은 금액</small><b>${usd(Math.max(0, alloc - r.total))}</b></div>` : ''}</div>
      ${alloc > 0 ? `<div class="us-bar big"><i style="width:${pct}%;background:${sev(pct)}"></i></div>` : ''}
      <div class="us-h">일별 사용액</div>${trendHtml(daily, (v) => usd(v), 'day')}
      <div class="us-h">모델별</div>${models.map((m, i) => `<div class="us-model"><span>${esc(m.model)}</span><div class="us-bar"><i style="width:${(m.amount / mmax) * 100}%;background:${COLORS[i % COLORS.length]}"></i></div><b>${usd(m.amount)}</b></div>`).join('')}`;
  }

  /**
   * 공개 API 묶음.
   * init(stage, opts) · open(탭 또는 { svc, tab }) · close().
   * @returns {{init: function, open: function, close: function}}
   */
  return { init, open, close };
})();
