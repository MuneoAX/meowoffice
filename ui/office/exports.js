/**
 * @file 공식 내보내기 파일 사용 리포트 화면 (사용량 상세 › "내보내기 리포트" 탭).
 * ChatGPT·Claude·Gemini(Takeout) 공식 내보내기 파일을 골라 넣으면 Rust 가 이 PC 안에서만 분석하고, 이 파일이 집계 결과를 그린다.
 * 대화 본문은 화면·저장·전송 어디에도 없다(집계 숫자만).
 * 공개 API: OfficeExports.render(body, { invoke, svc, setSvc }).
 * Rust 명령: export_pick(title, filter) · export_analyze(path) · export_saved() · export_save(report) · export_forget(provider).
 * 이벤트: export_progress(진행), tauri://drag-drop(파일 끌어다 놓기).
 * 상태: job.phase = idle → picking → analyzing → idle | error. 한 번에 하나.
 */
/**
 * @typedef {Object} ExportReport
 * @property {"chatgpt"|"claude"|"gemini"} provider 내보내기 종류
 * @property {string} file 파일 이름
 * @property {string} analyzed_at 분석 시각(RFC3339)
 * @property {?string} first_day 첫 활동일 YYYY-MM-DD
 * @property {?string} last_day 마지막 활동일
 * @property {?number} conversations 대화 수(Gemini 는 null)
 * @property {number} user_msgs 사용자 메시지 수
 * @property {number} ai_msgs AI 메시지 수
 * @property {number} user_tokens 사용자 글 추정 토큰
 * @property {number} ai_tokens AI 글 추정 토큰
 * @property {Array<{d: string, convs: number, user: number, ai: number, tok: number}>} daily 활동 있는 날만
 * @property {Array<{model: string, msgs: number}>} models 모델별 AI 메시지 수
 * @property {number[][]} heat [요일(월=0)][시] 사용자 메시지 수
 * @property {number} skipped 건너뛴 항목 수
 * @property {number} undated 날짜 없는 메시지 수
 * @property {boolean} partial 중간에 끊긴 파일인지
 */
'use strict';

const OfficeExports = (() => {
  /** 사용량 서비스 탭 → 내보내기 종류. */
  const PROVIDER = { claude: 'claude', chatgpt: 'chatgpt', antigravity: 'gemini' };
  /** 내보내기 종류 → 사용량 서비스 탭. */
  const SVC_OF = { claude: 'claude', chatgpt: 'chatgpt', gemini: 'antigravity' };
  /** 분석 작업 상태. phase: idle | picking | analyzing | error. */
  let job = { phase: 'idle', done: 0, total: 0, items: 0, error: '' };
  /** 종류별 보관: provider → { report, saved, saveFail }. */
  const store = {};
  /** 저장된 결과를 한 번 읽었는지. */
  let loaded = false;
  /** 추이 단위(month | day). */
  let unit = 'month';
  /** 추이 지표(convs | msgs | tok). */
  let metric = 'msgs';
  /** 지금 그리는 루트 요소와 호출 맥락. */
  let rootEl = null, ctx = null, wired = false;

  /**
   * HTML 특수문자 이스케이프.
   * @param {*} s 값
   * @returns {string} 안전한 문자열
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /**
   * 큰 수 줄임 표기(B·M·K).
   * @param {number} n 수
   * @returns {string} 표기
   */
  const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0));
  /**
   * 현재 언어로 숫자 표기.
   * @param {number} n 수
   * @returns {string} 표기
   */
  const num = (n) => Number(n || 0).toLocaleString(I18N.lang());

  /**
   * 사용량 상세 본문에 그린다(탭이 열릴 때마다 호출).
   * 저장된 결과를 처음 한 번 불러오고, 끌어다 놓기·진행 이벤트 연결도 처음 한 번만 한다.
   * @param {HTMLElement} body 사용량 상세 본문 칸
   * @param {{invoke: ?function(string, Object=):Promise<*>, svc: string, setSvc: function(string):void}} o 맥락
   * @returns {void}
   * @see paint, wire
   */
  function render(body, o) {
    ctx = o;
    body.innerHTML = '<div class="ex-root"></div>';
    rootEl = body.firstChild;
    rootEl.addEventListener('click', onClick);
    if (!wired) { wired = true; wire(); }
    if (!loaded && o.invoke) {
      loaded = true;
      o.invoke('export_saved').then((m) => {
        for (const [p, report] of Object.entries(m || {})) if (!store[p]) store[p] = { report, saved: true };
        paint();
      }).catch(() => { /* 저장 파일 없음 */ });
    }
    paint();
  }

  /**
   * 진행 이벤트·끌어다 놓기·언어 변경을 한 번만 연결한다.
   * @returns {void}
   */
  function wire() {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) {
      ev.listen('export_progress', (e) => {
        if (job.phase !== 'analyzing') return;
        job = Object.assign(job, e.payload || {});
        paint();
      });
      ev.listen('tauri://drag-drop', (e) => {
        const p = e.payload && e.payload.paths && e.payload.paths[0];
        if (p && visible() && (job.phase === 'idle' || job.phase === 'error')) start(p);
      });
    }
    window.addEventListener('meow-lang', () => paint());
  }

  /**
   * 내보내기 탭이 지금 화면에 보이는지.
   * @returns {boolean} 보이면 true
   */
  function visible() { return !!(rootEl && rootEl.isConnected && rootEl.getClientRects().length > 0); }

  /**
   * 클릭 위임: data-ex 속성으로 동작을 구분한다.
   * @param {MouseEvent} e 클릭 이벤트
   * @returns {void}
   */
  function onClick(e) {
    const b = e.target.closest('[data-ex]');
    if (!b || b.disabled) return;
    const [k, v] = b.dataset.ex.split(':');
    if (k === 'pick') pick();
    else if (k === 'save') save();
    else if (k === 'forget') forget();
    else if (k === 'unit') { unit = v; paint(); }
    else if (k === 'metric') { metric = v; paint(); }
  }

  /**
   * 파일 고르기 창을 열고 고르면 분석을 시작한다.
   * @returns {Promise<void>}
   * @see start
   */
  async function pick() {
    if (job.phase === 'picking' || job.phase === 'analyzing') return;
    if (!ctx.invoke) { job = { phase: 'error', error: 'app_only' }; paint(); return; }
    job = { phase: 'picking', error: '' };
    paint();
    let path = null;
    try { path = await ctx.invoke('export_pick', { title: t('exp.pick.title'), filter: t('exp.pick.filter') }); } catch (_) { /* 취소와 같게 */ }
    if (!path) { job = { phase: 'idle', error: '' }; paint(); return; }
    start(path);
  }

  /**
   * 파일 분석을 시작하고 끝나면 결과를 보관한다.
   * 이 탭이 보이고 결과 종류가 현재 서비스 탭과 다르면 그 서비스 탭으로 옮긴다.
   * @param {string} path 파일 경로
   * @returns {Promise<void>}
   */
  async function start(path) {
    if (!ctx || !ctx.invoke) return;
    job = { phase: 'analyzing', done: 0, total: 0, items: 0, error: '' };
    paint();
    try {
      const r = await ctx.invoke('export_analyze', { path });
      store[r.provider] = { report: r, saved: false };
      job = { phase: 'idle', error: '' };
      if (visible() && SVC_OF[r.provider] !== ctx.svc && ctx.setSvc) ctx.setSvc(SVC_OF[r.provider]);
      else paint();
    } catch (e) {
      job = { phase: 'error', error: String(e) };
      paint();
    }
  }

  /**
   * 지금 보이는 종류의 결과를 저장한다(집계만).
   * @returns {Promise<void>}
   */
  async function save() {
    const e = store[PROVIDER[ctx.svc] || 'claude'];
    if (!e || !ctx.invoke) return;
    try { await ctx.invoke('export_save', { report: e.report }); e.saved = true; e.saveFail = false; } catch (_) { e.saveFail = true; }
    paint();
  }

  /**
   * 저장한 결과를 지운다(화면의 결과는 유지).
   * @returns {Promise<void>}
   */
  async function forget() {
    const p = PROVIDER[ctx.svc] || 'claude';
    const e = store[p];
    if (!e || !ctx.invoke) return;
    try { await ctx.invoke('export_forget', { provider: p }); e.saved = false; } catch (_) { /* 그대로 */ }
    paint();
  }

  /**
   * 오류 코드를 문구로 바꾼다. 모르는 코드는 일반 문구에 코드를 붙인다.
   * @param {string} code 오류 코드
   * @returns {string} 문구
   */
  function errText(code) {
    const k = 'exp.err.' + code;
    return t(k) !== k ? t(k) : t('exp.err.other', { msg: code });
  }

  /**
   * 일별 자료를 추이 막대 목록으로 만든다.
   * 월별은 달로 합산(첫~마지막 달 사이 빈 달은 0), 일별은 마지막 활동일 기준 90일(빈 날은 0).
   * @param {ExportReport} r 리포트
   * @returns {Array<{label: string, key: string, total: number}>} 막대 목록
   */
  function series(r) {
    const val = (d) => (metric === 'convs' ? d.convs : metric === 'tok' ? d.tok : d.user + d.ai);
    if (!r.daily.length) return [];
    const out = [];
    if (unit === 'month') {
      const m = {};
      for (const d of r.daily) m[d.d.slice(0, 7)] = (m[d.d.slice(0, 7)] || 0) + val(d);
      let [y, mo] = r.first_day.slice(0, 7).split('-').map(Number);
      const [ly, lm] = r.last_day.slice(0, 7).split('-').map(Number);
      while (y < ly || (y === ly && mo <= lm)) {
        const key = y + '-' + String(mo).padStart(2, '0');
        out.push({ label: key, key, total: m[key] || 0 });
        if (++mo > 12) { mo = 1; y++; }
      }
      return out;
    }
    const m = {};
    for (const d of r.daily) m[d.d] = val(d);
    const [y, mo, da] = r.last_day.split('-').map(Number);
    for (let i = 89; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, mo - 1, da - i));
      const key = dt.toISOString().slice(0, 10);
      out.push({ label: key.slice(5), key, total: m[key] || 0 });
    }
    return out;
  }

  /**
   * 추이 막대 차트(사용량 상세 차트와 같은 틀).
   * @param {Array<{label: string, key: string, total: number}>} items 막대 목록
   * @param {function(number):string} fmt 값 표기
   * @returns {string} HTML
   */
  function chartHtml(items, fmt) {
    if (!items.length) return '<div class="us-empty">–</div>';
    const W = 100, H = 40, pad = 2, n = items.length;
    const max = items.reduce((m, x) => Math.max(m, x.total), 0) || 1;
    const colW = W / n, bw = colW * 0.9;
    let bars = '';
    items.forEach((it, i) => {
      const cx = (i + 0.5) * colW;
      const top = it.total > 0 ? Math.min(H - pad - (it.total / max) * (H - 2 * pad), H - pad - 1) : H - pad - 0.6;
      bars += `<rect class="ex-bar${it.total > 0 ? '' : ' zero'}" x="${(cx - bw / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bw.toFixed(2)}" height="${(H - pad - top).toFixed(2)}"><title>${esc(it.key)} · ${esc(fmt(it.total))}</title></rect>`;
    });
    const step = Math.max(1, Math.ceil(n / 6));
    let ax = '';
    for (let i = 0; i < n; i += step) ax += `<span style="left:${((i + 0.5) * colW).toFixed(2)}%">${esc(items[i].label)}</span>`;
    return `<div class="us-trend"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="us-spark"><defs><linearGradient id="ex-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b6dff"/><stop offset="1" stop-color="#5b8cff"/></linearGradient></defs>${bars}</svg></div><div class="us-axis">${ax}</div>`;
  }

  /**
   * 요일(7행) × 시간대(24열) 분포.
   * @param {ExportReport} r 리포트
   * @returns {string} HTML
   */
  function heatHtml(r) {
    const f = new Intl.DateTimeFormat(I18N.lang(), { weekday: 'short' });
    const names = Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 0, 1 + i)));
    const max = r.heat.reduce((m, row) => Math.max(m, ...row), 0) || 1;
    let h = '<div class="ex-heat">';
    r.heat.forEach((row, d) => {
      h += `<span>${esc(names[d])}</span>`;
      row.forEach((n, hr) => {
        const tip = esc(t('exp.heat.cell', { day: names[d], hour: hr, n }));
        h += n > 0 ? `<i style="opacity:${(0.15 + 0.85 * n / max).toFixed(2)}" title="${tip}"></i>` : `<i class="z" title="${tip}"></i>`;
      });
    });
    h += '<span></span>';
    for (let hr = 0; hr < 24; hr++) h += `<span class="ex-hh">${hr % 6 === 0 ? hr : ''}</span>`;
    return h + '</div>';
  }

  /**
   * 파일을 고르기 전 안내(받는 법·개인정보·끌어다 놓기).
   * @param {string} p 내보내기 종류
   * @returns {string} HTML
   */
  function introHtml(p) {
    return `<p class="ex-how">${esc(t('exp.how.' + p))}</p><p class="ex-priv">${esc(t('exp.privacy'))}</p><p class="us-sub">${esc(t('exp.drop'))}</p>`;
  }

  /**
   * 결과 리포트 화면.
   * 요약 · 한 줄 요약 · 추이 · 모델별 · 요일·시간대 · 주석 · 메타.
   * @param {ExportReport} r 리포트
   * @param {{saved: boolean}} entry 보관 정보
   * @returns {string} HTML
   */
  function reportHtml(r, entry) {
    const p = r.provider;
    if (r.conversations == null && metric === 'convs') metric = 'msgs';
    const msgs = r.user_msgs + r.ai_msgs;
    const dayMs = 86400000;
    const span = r.first_day ? Math.round((Date.parse(r.last_day) - Date.parse(r.first_day)) / dayMs) + 1 : 0;
    let h = `<div class="us-big ex-big">
      <div><small>${esc(t('exp.sum.period'))}</small><b style="font-size:16px">${esc(r.first_day || '–')} ~ ${esc(r.last_day || '–')}</b><div class="us-sub">${esc(t('exp.sum.days', { span, active: r.daily.length }))}</div></div>
      <div><small>${esc(t('exp.sum.convs'))}</small><b>${r.conversations == null ? '–' : num(r.conversations)}</b></div>
      <div><small>${esc(t('exp.sum.msgs'))}</small><b>${num(msgs)}</b><div class="us-sub">${esc(t('exp.sum.split', { user: num(r.user_msgs), ai: num(r.ai_msgs) }))}</div></div>
      <div><small>${esc(t('exp.sum.tokens'))}</small><b>${tok(r.user_tokens + r.ai_tokens)}</b><div class="us-sub">${esc(t('exp.sum.split', { user: tok(r.user_tokens), ai: tok(r.ai_tokens) }))}</div></div>
    </div>`;
    if (r.daily.length) {
      const top = r.daily.reduce((m, d) => (d.user + d.ai > m.user + m.ai ? d : m), r.daily[0]);
      h += `<div class="us-sub">${esc(t('exp.sum.busiest', { day: top.d, n: num(top.user + top.ai) }))} · ${esc(t('exp.sum.avg', { n: (msgs / r.daily.length).toFixed(1) }))}</div>`;
    }
    const fmt = metric === 'tok' ? tok : num;
    const btn = (k, v, label) => `<button data-ex="${k}:${v}"${(k === 'unit' ? unit : metric) === v ? ' class="on"' : ''}>${esc(label)}</button>`;
    h += `<div class="us-h">${esc(t('exp.chart.title'))}</div><div class="ex-toggles">
      <div class="us-days">${btn('unit', 'month', t('exp.unit.month'))}${btn('unit', 'day', t('exp.unit.day'))}</div>
      <div class="us-days">${r.conversations == null ? '' : btn('metric', 'convs', t('exp.metric.convs'))}${btn('metric', 'msgs', t('exp.metric.msgs'))}${btn('metric', 'tok', t('exp.metric.tok'))}</div></div>`;
    h += chartHtml(series(r), fmt);
    h += `<div class="us-h">${esc(t('exp.models.title'))}</div>`;
    if (r.models.length) {
      const mx = r.models[0].msgs || 1;
      h += r.models.slice(0, 12).map((m) => `<div class="us-model"><span title="${esc(m.model)}">${esc(m.model)}</span><div class="us-bar"><i style="width:${(m.msgs / mx * 100).toFixed(1)}%;background:linear-gradient(90deg,#8b6dff,#5b8cff)"></i></div><b>${num(m.msgs)}</b></div>`).join('');
    } else h += `<div class="us-sub">${esc(t('exp.models.none'))}</div>`;
    h += `<div class="us-h">${esc(t('exp.heat.title'))}</div>${heatHtml(r)}`;
    const notes = ['exp.note.estimate', 'exp.note.tz', 'exp.note.scope.' + p];
    let nh = notes.map((k) => `<div class="us-note">${esc(t(k))}</div>`).join('');
    if (r.skipped > 0) nh += `<div class="us-note">${esc(t('exp.note.skipped', { n: num(r.skipped) }))}</div>`;
    if (r.undated > 0) nh += `<div class="us-note">${esc(t(p === 'gemini' ? 'exp.note.undated.gemini' : 'exp.note.undated', { n: num(r.undated) }))}</div>`;
    if (r.partial) nh += `<div class="us-note">${esc(t('exp.note.partial'))}</div>`;
    h += nh;
    h += `<div class="us-sub">${esc(t('exp.meta', { file: r.file, when: new Date(r.analyzed_at).toLocaleString(I18N.lang()) }))}${entry.saved ? ' · ' + esc(t('exp.meta.saved')) : ''}</div>`;
    return h;
  }

  /**
   * 화면을 상태에서 그대로 그린다. 루트 요소가 문서에서 떨어졌으면(다른 탭으로 바뀜) 아무것도 하지 않는다.
   * @returns {void}
   */
  function paint() {
    if (!rootEl || !rootEl.isConnected || !ctx) return;
    const p = PROVIDER[ctx.svc] || 'claude';
    const entry = store[p];
    const busy = job.phase === 'picking' || job.phase === 'analyzing';
    let h = `<div class="us-h" style="margin-top:0">${esc(t('exp.title.' + p))}</div>`;
    if (job.phase === 'analyzing') {
      const pct = job.total > 0 ? Math.min(100, Math.floor(job.done / job.total * 100)) : 0;
      h += `<div class="ex-prog"><div class="us-sub">${esc(t('exp.progress', { pct }))} · ${esc(t('exp.progress.items', { n: num(job.items) }))}</div><div class="us-bar big"><i style="width:${pct}%"></i></div></div>`;
    } else {
      if (job.phase === 'picking') h += `<div class="us-sub">${esc(t('exp.picking'))}</div>`;
      if (job.phase === 'error') h += `<div class="ex-err">${esc(errText(job.error))}</div>`;
      h += entry ? reportHtml(entry.report, entry) : introHtml(p);
    }
    h += `<div class="ex-acts"><button class="us-btn" data-ex="pick"${busy ? ' disabled' : ''}>${esc(t(entry ? 'exp.pick.again' : 'exp.pick'))}</button>`;
    if (entry && job.phase !== 'analyzing') {
      h += `<button class="us-btn" data-ex="save"${entry.saved ? ' disabled' : ''}>${esc(t(entry.saved ? 'exp.saved' : 'exp.save'))}</button>`;
      if (entry.saved) h += `<button class="us-btn ex-ghost" data-ex="forget">${esc(t('exp.forget'))}</button>`;
    }
    h += '</div>';
    if (entry && job.phase !== 'analyzing') h += `<div class="us-sub">${esc(t('exp.save.hint'))}${entry.saveFail ? ' · ' + esc(t('exp.save.fail')) : ''}</div>`;
    rootEl.innerHTML = h;
  }

  return { render };
})();
