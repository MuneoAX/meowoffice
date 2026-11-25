/**
 * @file 사무실 채팅 도크 (OfficeChat). 설계서: docs/CHAT-DESIGN.md 7장.
 * 오른쪽 도크 #chatDock: 탭 [정보 | 대화]. 대화 탭은 목록(과거 기록 + 실시간 조각) · 도구 항목(접힘) · 결재 대기 줄 · 입력창 · 보기만 안내.
 * 대화 본문의 주인은 Rust(runner)다. 이 파일은 붙었다 떼는 뷰: chat_open(현재 턴 live) + chat_history(끝난 부분) 로 그리고,
 * "chat" 이벤트 {key, seq, ev} 로 이어 그린다. ev.t 는 snake_case 종류(state·rekey·user_message·turn_start·delta·message·tool_start·tool_end·approval·approval_done·usage·turn_end·notice).
 * 보안: 모델 출력은 전부 글자로만 그린다(md.js 는 innerHTML 을 쓰지 않음). 대화 본문을 log_ui·console 로 보내지 않는다(오류는 종류만).
 * Tauri 명령: chat_services · chat_sessions · chat_open · chat_history · chat_new · chat_send · chat_interrupt · chat_fork · chat_takeover · chat_close · pick_folder · answer_permit · get_permits · get_config · claude_login · provider_login · open_url.
 * 공개 API: OfficeChat.{ init(stage, opts), show(key), hide(), isOpen(), setInfo(c, bodyHtml, extra), onEvent(payload), openNew() }.
 *
 * @typedef {Object} ChatOpts
 * @property {HTMLElement} widgets 도크를 붙일 #widgets
 * @property {function(string, *=):Promise<*>} invoke Tauri invoke
 * @property {function(string):void} toast 토스트
 * @property {function():void} onClose 도크 × (고양이 선택 해제)
 * @property {function(string):?Object} chatInfo 열쇠 → chat_sessions 항목 (없으면 null)
 * @property {function():string[]} recentFolders 새 대화용 최근 작업 폴더들
 * @property {function(string, string, string=):void} onCreated 새 대화·사본이 만들어짐 (열쇠, 서비스, 새 대화에서 고른 고양이 품종 — 안 골랐으면 '')
 * @property {function():Array<{id:string, name:string, level:number}>} [catChoices] 새 대화에서 고를 수 있는 고양이(품종)들
 * @property {{show: function(HTMLCanvasElement, string): void, set: function(string): void, hide: function(): void, turn: function(number, number): void}} [catPreview] 고른 고양이를 돌려 보여 주는 미리보기 (OfficeCatPreview)
 * @property {function(string, string):void} onRekey 세션 열쇠가 바뀜 (이전, 새)
 * @property {function(string):void} onChanged 세션 목록이 바뀔 만한 일이 있었음(닫기 등) — 목록 다시 읽기
 * @property {function(string):void} openTarget 세션을 터미널·앱에서 열기 (열쇠)
 */
'use strict';

const OfficeChat = (() => {
  const MAX_DOM = 400; // 한 번에 붙여 두는 항목 수 상한
  const PAGE = 40; // 기록 한 페이지(항목 수)
  const MIN_OLDER = 10; // '이전 대화 더 보기' 한 번에 최소로 붙일 항목 수(모자라면 다음 페이지까지 이어 읽음)
  const BUSY = new Set(['sending', 'streaming', 'awaiting_approval', 'interrupting']);
  const STATE_KEY = { view_only: 'view', idle: 'idle', sending: 'sending', streaming: 'streaming', awaiting_approval: 'approval', interrupting: 'stopping', error: 'error' };
  const INSTALL_URL = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://github.com/openai/codex', gemini: 'https://github.com/google-gemini/gemini-cli' };
  const TOOL_IC = { command: '>_', file: '✎', mcp: '⚙', web: '↗', other: '·' };

  /** @type {ChatOpts} */
  let o = null;
  let dock, headEl, tabsEl, infoEl, paneEl, bannerEl, listEl, latestBtn, olderBtn, costEl, formEl, ta, sendBtn, menuEl;
  let cur = null; // 지금 도크에 보이는 열쇠
  let tab = (() => { try { return localStorage.getItem('office.chatTab') === 'info' ? 'info' : 'chat'; } catch (e) { return 'chat'; } })();
  let curInfo = null; // 패널이 준 고양이 정보 { c, logo, chip }
  let lastInfoHtml = '';
  let uid = 0;
  let sticky = true; // 목록이 맨 아래에 붙어 있는지
  let confirmTake = false;
  /** @type {Map<string, Object>} 열쇠 → 세션 모델 */
  const S = new Map();
  const dirty = new Set();
  let flushTimer = 0;
  let pollTimer = 0;

  const tr = (k, p) => (typeof t === 'function' ? t(k, p) : k);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /**
   * 열쇠 → 서비스 이름 ("claude" | "codex" | "gemini" | "antigravity" | "cloud").
   * @param {string} key 세션 열쇠
   * @returns {string}
   */
  function svcOf(key) {
    if (key.startsWith('L:')) return 'claude';
    if (key.startsWith('C:')) return 'cloud';
    if (key.startsWith('P:chatgpt:')) return 'codex';
    if (key.startsWith('P:gemini:')) return 'gemini';
    if (key.startsWith('P:antigravity:')) return 'antigravity';
    return 'claude';
  }
  const capable = (key) => svcOf(key) !== 'antigravity';
  const live = () => !!(o && o.invoke);
  /**
   * 오류 종류만 뽑기(본문 금지). 문자열이면 그대로, 객체면 첫 키. 소문자 snake_case 40자 이내가 아니면 'other'.
   * @param {*} e 오류
   * @returns {string} 소문자 snake_case 종류
   */
  function kindOf(e) {
    let k = e;
    if (e && typeof e === 'object') k = Object.keys(e)[0] || '';
    k = String(k || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return /^[a-z0-9_]{1,40}$/.test(k) ? k : 'other'; // 경로·본문이 섞인 문자열은 버린다 (로그로 나가므로)
  }
  /**
   * 오류 종류 → 안내 문구.
   * @param {string} kind 종류
   * @returns {string}
   */
  function errText(kind) {
    if (kind.includes('busy_limit')) return tr('chat.err.busy_limit');
    if (kind.includes('auth') || kind === 'unauthorized') return tr('chat.err.auth');
    if (kind.includes('limit')) return tr('chat.err.limit', { when: '' }).replace(/\s+이후/, '').replace(/\s*after\s*\./, '.');
    if (kind.includes('exit') || kind.includes('process') || kind.includes('timeout')) return tr('chat.err.exit');
    return tr('chat.err.other');
  }
  const bad = (what, e) => { try { o.invoke('log_ui', { level: 'warn', message: `chat: ${what} ${kindOf(e)}` }); } catch (_) { /* 무시 */ } };

  // ── 모델 ────────────────────────────────────────────────
  /**
   * 세션 모델 만들기(없으면).
   * @param {string} key 열쇠
   * @returns {Object}
   */
  function model(key) {
    let s = S.get(key);
    if (!s) {
      s = { key, state: 'idle', canSend: false, why: '', meta: null, seq: 0, loaded: false, loading: false, noBackend: false, items: [], start: 0, next: null, loadingOlder: false,
        byId: new Map(), pending: [], liveStart: -1, liveUser: '', turnEnded: false, cost: null, ctx: null, err: '', refreshing: 0 };
      S.set(key, s);
    }
    return s;
  }
  const isBusy = (s) => BUSY.has(s.state);
  const sendable = (s) => s.loaded && !s.noBackend && (s.state === 'idle' || s.state === 'error') && s.canSend !== false;
  /**
   * 기록 항목(HistItem) → 화면 항목.
   * @param {Object} h HistItem {id, role, text, tool, at}
   * @returns {Object}
   */
  function fromHist(h) {
    if (h.role === 'tool' || h.tool) {
      const tl = h.tool || {};
      return { u: ++uid, kind: 'tool', id: h.id, tool: { kind: tl.kind || 'other', title: tl.title || '', detail: tl.detail || '', ok: tl.ok == null ? null : !!tl.ok, summary: tl.summary || '' } };
    }
    return { u: ++uid, kind: h.role === 'user' ? 'user' : 'assistant', id: h.id, text: h.text || '' };
  }

  // ── 그리기: 항목 ─────────────────────────────────────────
  /**
   * 항목 하나의 요소를 만든다(it.el 에 보관).
   * @param {Object} it 항목
   * @returns {HTMLElement}
   */
  function build(it) {
    let e;
    if (it.kind === 'user') {
      e = el('div', 'chat-msg user'); e.appendChild(el('div', 'chat-bub', it.text));
    } else if (it.kind === 'assistant') {
      e = el('div', 'chat-msg asst'); it.bub = el('div', 'chat-bub md'); e.appendChild(it.bub); paintAsst(it);
    } else if (it.kind === 'tool') {
      e = el('details', 'chat-tool');
      const sm = el('summary');
      it.icEl = el('span', 'chat-tool-ic'); it.ttEl = el('span', 'chat-tool-t'); it.stEl = el('span', 'chat-tool-st');
      sm.append(it.icEl, it.ttEl, it.stEl);
      it.detEl = el('pre', 'chat-tool-d'); it.resEl = el('pre', 'chat-tool-r');
      e.append(sm, it.detEl, it.resEl); paintTool(it);
    } else if (it.kind === 'perm') {
      e = el('div', 'chat-perm'); paintPerm(it, e);
    } else {
      e = el('div', 'chat-note', it.text);
    }
    it.el = e;
    return e;
  }
  /**
   * 답변 말풍선 다시 그리기 (마크다운, 스트리밍 중이면 끝에 커서).
   * @param {Object} it 답변 항목
   * @returns {void}
   */
  function paintAsst(it) {
    if (!it.bub) return;
    it.bub.replaceChildren(MeowMd.render(it.text || ''));
    it.bub.classList.toggle('streaming', !!it.streaming);
    it.painted = Date.now();
  }
  /**
   * 도구 항목 갱신(제목·상태·본문·결과).
   * @param {Object} it 도구 항목
   * @returns {void}
   */
  function paintTool(it) {
    const tl = it.tool;
    it.icEl.textContent = TOOL_IC[tl.kind] || TOOL_IC.other;
    it.ttEl.textContent = tl.title || tl.kind;
    const st = tl.ok === true ? 'ok' : tl.ok === false ? 'fail' : it.running ? 'run' : '';
    it.stEl.className = 'chat-tool-st ' + st;
    it.stEl.textContent = st === 'ok' ? tr('chat.tool.ok') : st === 'fail' ? tr('chat.tool.fail') : st === 'run' ? tr('chat.tool.running') : '';
    it.detEl.textContent = tl.detail || '';
    it.detEl.hidden = !tl.detail;
    it.resEl.textContent = tl.summary || '';
    it.resEl.hidden = !tl.summary;
  }
  /**
   * 결재 대기 줄 그리기. 도구 승인: 수락/거절. 질문: 선택지 단추(한 개 고르는 질문만) + 거절.
   * @param {Object} it 결재 항목 { permit, question, info }
   * @param {HTMLElement} e 줄 요소
   * @returns {void}
   */
  function paintPerm(it, e) {
    e.replaceChildren();
    const info = it.info;
    e.appendChild(el('div', 'chat-perm-h', tr('chat.perm.title') + (info && info.tool ? ' — ' + info.tool : '')));
    if (info && info.kind === 'question' && Array.isArray(info.questions)) {
      it.picks = it.picks || {};
      for (const q of info.questions) {
        const box = el('div', 'chat-perm-q');
        box.appendChild(el('div', 'chat-perm-qt', q.question || q.header || ''));
        if (!q.multiSelect) {
          const row = el('div', 'chat-perm-opts');
          for (const op of q.options || []) {
            const b = el('button', 'chat-btn' + (it.picks[q.question] === op.label ? ' on' : ''), op.label);
            b.type = 'button'; b.title = op.description || '';
            b.addEventListener('click', () => {
              it.picks[q.question] = op.label;
              if ((info.questions || []).every((x) => x.multiSelect || it.picks[x.question] != null)) answerPermit(it, true, it.picks);
              else paintPerm(it, e);
            });
            row.appendChild(b);
          }
          box.appendChild(row);
        }
        e.appendChild(box);
      }
    } else if (info) {
      if (info.description) e.appendChild(el('div', 'chat-perm-d', info.description));
      if (info.detail) e.appendChild(el('pre', 'chat-perm-pre', info.detail));
    }
    const row = el('div', 'chat-perm-acts');
    if (!(info && info.kind === 'question')) {
      const ok = el('button', 'chat-btn pri', tr('chat.perm.allow')); ok.type = 'button'; ok.disabled = !!it.answering;
      ok.addEventListener('click', () => answerPermit(it, true));
      row.appendChild(ok);
    }
    const no = el('button', 'chat-btn', tr('chat.perm.deny')); no.type = 'button'; no.disabled = !!it.answering;
    no.addEventListener('click', () => answerPermit(it, false));
    row.appendChild(no);
    e.appendChild(row);
  }
  /**
   * 결재 응답 보내기 (answer_permit). 이미 끝난 요청이면 줄을 치운다.
   * @param {Object} it 결재 항목
   * @param {boolean} allow 수락 여부
   * @param {Object} [answers] 질문 답 (질문 문구 → 선택)
   * @returns {Promise<void>}
   */
  async function answerPermit(it, allow, answers) {
    if (it.answering) return;
    it.answering = true; if (it.el) paintPerm(it, it.el);
    try { await o.invoke('answer_permit', { id: it.permit, allow, answers: answers || null }); } catch (e) { o.toast(tr('chat.perm.gone')); dropItem(S.get(cur), it); }
  }
  /**
   * 결재 항목의 내용(도구·명령·질문)을 get_permits 에서 찾아 채운다.
   * @param {Object} s 세션
   * @param {Object} it 결재 항목
   * @returns {Promise<void>}
   */
  async function fillPerm(s, it) {
    try {
      const list = await o.invoke('get_permits');
      const p = (list || []).find((x) => x.id === it.permit);
      if (p) { it.info = p; if (it.el) paintPerm(it, it.el); }
    } catch (e) { /* 줄은 기본 문구로 둔다 */ }
  }
  /**
   * 항목 치우기(모델 + 화면).
   * @param {?Object} s 세션
   * @param {Object} it 항목
   * @returns {void}
   */
  function dropItem(s, it) {
    if (!s) return;
    const i = s.items.indexOf(it);
    if (i < 0) return;
    s.items.splice(i, 1);
    if (i < s.start) s.start--;
    if (s.end != null && i < s.end) s.end--;
    if (s.liveStart > i) s.liveStart--;
    if (it.el) it.el.remove();
  }

  // ── 목록 붙이기·덜기 ───────────────────────────────────
  const nearBottom = () => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
  const toBottom = () => { listEl.scrollTop = listEl.scrollHeight; sticky = true; latestBtn.hidden = true; };
  /**
   * 현재 세션의 목록을 처음부터 다시 그린다 (붙어 있는 구간 start 이후만).
   * @param {Object} s 세션
   * @returns {void}
   */
  function paintAll(s) {
    listEl.replaceChildren();
    s.end = null; s.start = Math.max(s.start, s.items.length - MAX_DOM); // 숨어 있던 사이 쌓인 항목도 상한 안에서만 그린다
    if (!s.items.length) {
      if (s.loaded || s.loadErr) listEl.appendChild(el('div', 'chat-empty', tr('chat.empty')));
      else { const w = el('div', 'chat-empty'); w.appendChild(typeof OfficeLoading !== 'undefined' ? OfficeLoading.el(tr('chat.loading')) : document.createTextNode(tr('chat.loading'))); listEl.appendChild(w); } // 대화 기록을 불러오는 중
    }
    const frag = document.createDocumentFragment();
    for (let i = s.start; i < s.items.length; i++) frag.appendChild(s.items[i].el || build(s.items[i]));
    listEl.appendChild(frag);
    paintOlder(s);
    toBottom();
  }
  /**
   * "이전 대화 더 보기" 단추 표시 여부.
   * @param {Object} s 세션
   * @returns {void}
   */
  function paintOlder(s) { olderBtn.hidden = !(s.start > 0 || s.next); }
  /**
   * 새 항목을 맨 아래에 붙인다. 400개를 넘으면 위쪽(과거)을 뗀다(모델은 남김).
   * @param {Object} s 세션
   * @param {Object} it 항목
   * @returns {void}
   */
  function append(s, it) {
    const detached = s.end != null && s.end < s.items.length; // 과거를 위로 더 불러와 아래쪽을 떼어 둔 상태
    s.items.push(it);
    if (s.key !== cur) return;
    if (detached) { latestBtn.hidden = false; return; }
    const empty = listEl.querySelector('.chat-empty'); if (empty) empty.remove();
    const stick = sticky;
    listEl.appendChild(it.el || build(it));
    while (s.items.length - s.start > MAX_DOM) { const old = s.items[s.start]; if (old.el) { old.el.remove(); old.el = null; } s.start++; }
    paintOlder(s);
    if (stick) toBottom(); else latestBtn.hidden = false;
  }
  /**
   * 위로 더 불러와 붙은 항목이 상한(MAX_DOM)을 넘으면 아래쪽을 화면에서만 뗀다(모델·요소는 남김). 맨 아래로 내려가면 paintAll 이 다시 붙인다.
   * @param {Object} s 세션
   * @returns {void}
   */
  function trimBottom(s) {
    let end = s.end != null ? s.end : s.items.length;
    while (end - s.start > MAX_DOM) { end--; const it = s.items[end]; if (it && it.el && it.el.parentNode === listEl) it.el.remove(); }
    s.end = end < s.items.length ? end : null;
    if (s.end != null) latestBtn.hidden = false;
  }
  /**
   * 위로 올려 보다 맨 위에 닿으면 더 불러온다: 모델에 남은 과거 → 없으면 chat_history(next_cursor).
   * @param {Object} s 세션
   * @returns {Promise<void>}
   */
  async function older(s) {
    if (s.key !== cur) return;
    if (s.start > 0) {
      const from = Math.max(0, s.start - 50);
      const h0 = listEl.scrollHeight, t0 = listEl.scrollTop;
      const frag = document.createDocumentFragment();
      for (let i = from; i < s.start; i++) frag.appendChild(s.items[i].el || build(s.items[i]));
      listEl.insertBefore(frag, listEl.firstChild);
      s.start = from;
      listEl.scrollTop = t0 + (listEl.scrollHeight - h0);
      trimBottom(s);
      paintOlder(s);
      return;
    }
    if (!s.next || s.loadingOlder) return;
    s.loadingOlder = true; olderBtn.disabled = true;
    try {
      // 한 페이지가 비거나 아주 작을 수 있다(큰 도구 결과·그림 줄이 윈도를 채우면 메시지가 몇 개 안 나옴) — 눈에 띄게 붙을 때까지 몇 페이지 이어 읽는다.
      let add = [], guard = 0;
      while (s.next && add.length < MIN_OLDER && guard++ < 8) {
        const h = await o.invoke('chat_history', { key: s.key, cursor: s.next, limit: PAGE });
        const got = ((h && h.items) || []).map(fromHist);
        const nx = (h && h.next_cursor) || null;
        s.next = nx && nx !== s.next ? nx : null; // 같은 커서가 돌아오면 끝으로 본다(무한 반복 방지)
        add = got.concat(add);
      }
      s.items.unshift(...add);
      s.start = 0;
      if (s.liveStart >= 0) s.liveStart += add.length;
      if (s.key === cur) {
        const h0 = listEl.scrollHeight, t0 = listEl.scrollTop;
        const frag = document.createDocumentFragment();
        for (const it of add) frag.appendChild(build(it));
        listEl.insertBefore(frag, listEl.firstChild);
        listEl.scrollTop = t0 + (listEl.scrollHeight - h0);
        trimBottom(s);
        paintOlder(s);
      }
    } catch (e) { bad('history', e); } finally { s.loadingOlder = false; olderBtn.disabled = false; }
  }

  // ── 이벤트 적용 ─────────────────────────────────────────
  /**
   * 현재 턴의 시작 위치를 정한다(끝난 턴 뒤의 새 턴이면 이전 구간은 확정으로 둠).
   * @param {Object} s 세션
   * @returns {void}
   */
  function beginTurn(s) {
    if (s.turnEnded) { s.liveStart = -1; s.turnEnded = false; s.liveUser = ''; }
    if (s.liveStart < 0) s.liveStart = s.items.length;
  }
  /**
   * 화면 갱신 예약: 답변 조각은 rAF 당 1회로 모아 그린다(20KB 넘는 말풍선은 250ms 간격).
   * @param {Object} it 다시 그릴 답변 항목
   * @returns {void}
   */
  function schedule(it) {
    dirty.add(it);
    if (flushTimer) return;
    flushTimer = requestAnimationFrame(flush);
  }
  /**
   * 예약된 갱신을 한꺼번에 반영.
   * @returns {void}
   */
  function flush() {
    flushTimer = 0;
    const stick = sticky;
    let again = false;
    for (const it of dirty) {
      if (!it.el || !it.el.isConnected) { dirty.delete(it); continue; }
      if ((it.text || '').length > 20000 && Date.now() - (it.painted || 0) < 250) { again = true; continue; }
      dirty.delete(it); paintAsst(it);
    }
    if (stick && cur) toBottom(); else if (cur && !sticky) latestBtn.hidden = false;
    if (again) flushTimer = requestAnimationFrame(flush);
  }
  /**
   * 서버 쪽 항목 id 로 답변 항목 찾기(없으면 만든다).
   * @param {Object} s 세션
   * @param {string} id 서버 항목 id
   * @returns {Object}
   */
  function asstItem(s, id) {
    const k = 'm:' + id;
    let it = s.byId.get(k);
    if (!it) { it = { u: ++uid, kind: 'assistant', id, text: '', streaming: true }; s.byId.set(k, it); beginTurn(s); append(s, it); }
    return it;
  }
  /**
   * 이벤트 하나를 모델에 반영하고 화면을 갱신한다.
   * @param {Object} s 세션
   * @param {Object} ev 공통 이벤트 (ev.t 로 종류 구분)
   * @returns {void}
   */
  function apply(s, ev) {
    switch (ev.t) {
      case 'state':
        s.state = ev.state || s.state;
        s.canSend = !(s.state === 'view_only');
        if (s.state !== 'view_only') confirmTake = false;
        if (s.state === 'view_only' && ev.reason) s.why = ev.reason;
        if (s.state !== 'error') s.err = '';
        break;
      case 'rekey': {
        const old = s.key;
        S.delete(old); s.key = ev.to; S.set(ev.to, s);
        if (cur === old) cur = ev.to;
        if (o.onRekey) o.onRekey(old, ev.to);
        break;
      }
      case 'user_message': {
        beginTurn(s);
        s.liveUser = ev.text || '';
        append(s, { u: ++uid, kind: 'user', id: ev.id, text: ev.text || '' });
        s.err = '';
        break;
      }
      case 'turn_start': beginTurn(s); break;
      case 'delta': { const it = asstItem(s, ev.item); it.text += ev.text || ''; it.streaming = true; schedule(it); break; }
      case 'message': { const it = asstItem(s, ev.item); it.text = ev.text || ''; it.streaming = false; schedule(it); break; }
      case 'tool_start': {
        beginTurn(s);
        const it = { u: ++uid, kind: 'tool', id: ev.item, running: true, tool: { kind: ev.kind || 'other', title: ev.title || '', detail: ev.detail || '', ok: null, summary: '' } };
        s.byId.set('t:' + ev.item, it); append(s, it);
        break;
      }
      case 'tool_end': {
        const it = s.byId.get('t:' + ev.item);
        if (it) { it.running = false; it.tool.ok = !!ev.ok; it.tool.summary = ev.summary || ''; if (it.el) paintTool(it); }
        break;
      }
      case 'approval': {
        const it = { u: ++uid, kind: 'perm', permit: ev.permit, question: !!ev.question, info: null };
        s.byId.set('p:' + ev.permit, it); beginTurn(s); append(s, it); fillPerm(s, it);
        break;
      }
      case 'approval_done': { const it = s.byId.get('p:' + ev.permit); if (it) { s.byId.delete('p:' + ev.permit); dropItem(s, it); } break; }
      case 'usage': s.cost = ev.cost_usd != null ? ev.cost_usd : null; s.ctx = ev.context_pct != null ? ev.context_pct : null; break;
      case 'turn_end': {
        for (const it of s.items) if (it.kind === 'assistant' && it.streaming) { it.streaming = false; schedule(it); }
        for (const it of s.items) if (it.kind === 'tool' && it.running) { it.running = false; if (it.el) paintTool(it); }
        for (const it of s.items.filter((x) => x.kind === 'perm')) dropItem(s, it);
        s.turnEnded = true;
        if (ev.outcome === 'failed') s.err = kindOf(ev.error) || 'failed';
        refreshTail(s);
        break;
      }
      case 'notice': {
        const k = 'chat.notice.' + String(ev.code || '');
        const txt = tr(k) !== k ? tr(k) : tr('chat.notice.other', { code: ev.code || '' });
        append(s, { u: ++uid, kind: 'note', text: txt });
        break;
      }
      default: break; // 모르는 종류는 무시
    }
    if (s.key === cur) { paintHead(); paintBanner(); paintInput(); }
  }
  /**
   * 끝난 턴을 기록에서 다시 읽어 그 턴 구간을 교체한다 (조각과 확정본 불일치 방지).
   * 기록 첫 페이지에서 이번 턴의 사용자 말을 찾지 못하면(턴이 너무 길거나 기록이 아직 없음) 실시간 항목을 그대로 둔다.
   * @param {Object} s 세션
   * @returns {Promise<void>}
   */
  async function refreshTail(s) {
    const mark = s.liveStart, user = s.liveUser;
    if (mark < 0 || !user) return;
    const ticket = ++s.refreshing;
    try {
      const h = await o.invoke('chat_history', { key: s.key, cursor: null, limit: PAGE });
      if (ticket !== s.refreshing || s.liveStart !== mark) return;
      const arr = (h && h.items) || [];
      let j = -1;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].role === 'user' && arr[i].text === user) { j = i; break; }
      if (j < 0) return;
      const tail = arr.slice(j).map(fromHist);
      const removed = s.items.splice(mark);
      for (const it of removed) { if (it.el) it.el.remove(); dirty.delete(it); }
      for (const [k, it] of [...s.byId]) if (removed.includes(it)) s.byId.delete(k);
      s.items.push(...tail);
      if (s.start > s.items.length) s.start = Math.max(0, s.items.length - MAX_DOM);
      s.liveStart = -1; s.turnEnded = false; s.liveUser = '';
      if (s.key === cur) { const stick = sticky; paintAll(s); if (!stick) { latestBtn.hidden = false; } }
    } catch (e) { bad('tail', e); }
  }
  /**
   * "chat" 이벤트 수신 (office.js 가 listen 으로 연결).
   * 아직 열지 않은 세션의 이벤트는 버리고(열 때 chat_open 이 현재 턴을 준다), 여는 중이면 모아 뒀다 seq 보다 새 것만 적용한다.
   * @param {{key: string, seq: number, ev: Object}} p 이벤트 {key, seq, ev}
   * @returns {void}
   */
  function onEvent(p) {
    if (!p || !p.key || !p.ev) return;
    const s = S.get(p.key);
    if (!s) return;
    if (s.loading) { s.pending.push(p); return; }
    if (typeof p.seq === 'number') { if (p.seq <= s.seq) return; s.seq = p.seq; }
    apply(s, p.ev);
  }

  // ── 불러오기 ────────────────────────────────────────────
  /**
   * 세션을 처음 열 때: chat_open(상태·현재 턴) + chat_history(최신 1페이지) 를 읽어 모델을 채운다.
   * 명령이 없거나 실패하면 조용히 noBackend 로 표시하고 입력을 막는다.
   * @param {Object} s 세션
   * @returns {Promise<void>}
   */
  async function load(s) {
    if (s.loading || s.loaded) return;
    s.loading = true; s.noBackend = false; s.loadErr = false;
    if (s.key === cur) paintAll(s);
    try {
      const op = await o.invoke('chat_open', { key: s.key });
      s.state = op.state || 'idle'; s.canSend = op.can_send !== false && s.state !== 'view_only'; s.why = op.why || ''; s.meta = op.meta || null; s.seq = op.seq || 0;
      let hist = [];
      try {
        const h = await o.invoke('chat_history', { key: s.key, cursor: null, limit: PAGE });
        hist = ((h && h.items) || []);
        s.next = (h && h.next_cursor) || null;
      } catch (e) { bad('history', e); }
      const liveEvs = (op.live || []).map((x) => (x && x.ev ? x.ev : x));
      // 진행 중 턴은 기록에도 일부 있을 수 있어: 실시간 버퍼의 사용자 말부터는 기록에서 뺀다
      const lu = liveEvs.find((x) => x && x.t === 'user_message');
      if (lu) {
        for (let i = hist.length - 1; i >= 0; i--) if (hist[i].role === 'user' && hist[i].text === lu.text) { hist = hist.slice(0, i); break; }
      }
      s.items = hist.map(fromHist); s.start = Math.max(0, s.items.length - MAX_DOM);
      s.loaded = true; s.loading = false;
      for (const ev of liveEvs) if (ev && ev.t) apply(s, ev);
      const pend = s.pending; s.pending = [];
      for (const p of pend) { if (typeof p.seq === 'number') { if (p.seq <= s.seq) continue; s.seq = p.seq; } apply(s, p.ev); }
    } catch (e) {
      s.loading = false; s.pending = [];
      s.items = [];
      if (/not.?found|unknown.?command/i.test(String((e && e.message) || e))) { s.noBackend = true; s.loaded = true; } // 명령 자체가 없을 때만 업데이트 안내
      else { s.loadErr = true; s.loaded = false; } // 일시 오류: 다시 열면 재시도
      bad('open', e);
    }
    if (s.key === cur) { paintAll(s); paintHead(); paintBanner(); paintInput(); }
  }
  /**
   * 보기만 상태에서 상태만 다시 읽는다(목록은 그대로). 5초마다 + '다시 확인' 단추.
   * @param {Object} s 세션
   * @returns {Promise<void>}
   */
  async function recheck(s) {
    if (s.rechecking) return; // 5초 폴링과 단추가 겹쳐 chat_open 이 동시에 돌지 않게
    s.rechecking = true;
    try {
      const op = await o.invoke('chat_open', { key: s.key });
      s.state = op.state || s.state; s.why = op.why || ''; s.canSend = op.can_send !== false && s.state !== 'view_only';
      if (s.state !== 'view_only') confirmTake = false;
      if (s.key === cur) { paintHead(); paintBanner(); paintInput(); }
    } catch (e) { bad('recheck', e); } finally { s.rechecking = false; }
  }

  // ── 그리기: 도크 틀·머리·띠·입력 ─────────────────────────
  /**
   * 오른쪽 위젯 열을 도크 폭만큼 밀기 위한 CSS 변수.
   * @param {boolean} open 도크 열림 여부
   * @returns {void}
   */
  function setDockVar(open) {
    o.widgets.style.setProperty('--dock-w', open ? Math.max(0, Math.min(dock.offsetWidth + 16, o.widgets.clientWidth - 300 - 52)) + 'px' : '0px');
  }
  /**
   * 머리(로고·이름·상태 칩·폴더·모드·메뉴·닫기) 그리기.
   * @returns {void}
   */
  function paintHead() {
    if (!cur) return;
    const s = S.get(cur);
    const ci = o.chatInfo ? o.chatInfo(cur) : null;
    headEl.replaceChildren();
    const logo = el('span', 'chat-logo');
    if (curInfo && curInfo.logo) logo.innerHTML = curInfo.logo; // 패널이 만든 고정 로고 마크업(모델 출력 아님)
    const name = el('span', 'chat-name', (curInfo && curInfo.c && curInfo.c.name) || (ci && (ci.title || ci.project)) || svcOf(cur));
    headEl.append(logo, name);
    if (s && s.loaded && tab === 'chat' && !s.noBackend) {
      const k = STATE_KEY[s.state] || 'idle';
      headEl.appendChild(el('span', 'chat-chip st-' + k, tr('chat.state.' + k)));
    } else if (curInfo && curInfo.chip) {
      const w = el('span', 'chat-chip-w'); w.innerHTML = curInfo.chip; headEl.appendChild(w); // 패널이 만든 상태 칩 마크업
    }
    const cwd = (ci && ci.cwd) || (s && s.meta && s.meta.cwd) || '';
    if (cwd) { const tail = cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/'); const f = el('span', 'chat-folder', tail); f.title = tail; headEl.appendChild(f); }
    const mode = s && s.meta && s.meta.mode ? String(s.meta.mode) : '';
    if (mode && tr('chat.mode.' + mode) !== 'chat.mode.' + mode) headEl.appendChild(el('span', 'chat-chip mode', tr('chat.mode.' + mode)));
    const sp = el('span', 'chat-sp'); headEl.appendChild(sp);
    if (capable(cur) && svcOf(cur) !== 'cloud') {
      const more = el('button', 'chat-ib', '⋯'); more.type = 'button'; more.setAttribute('aria-label', 'menu');
      more.addEventListener('click', (e) => { e.stopPropagation(); menuEl.hidden = !menuEl.hidden; });
      headEl.appendChild(more);
    }
    const x = el('button', 'chat-ib chat-x', '×'); x.type = 'button';
    x.addEventListener('click', () => { if (o.onClose) o.onClose(); hide(); });
    headEl.appendChild(x);
  }
  /**
   * 안내 띠: 보기만 사유·단추, 오류, 과금·Codex 안내(닫을 수 있음).
   * @returns {void}
   */
  function paintBanner() {
    bannerEl.replaceChildren();
    const s = cur && S.get(cur);
    if (!s) return;
    const add = (cls, text, btns) => {
      const b = el('div', 'chat-ban ' + cls);
      b.appendChild(el('div', 'chat-ban-t', text));
      if (btns && btns.length) { const r = el('div', 'chat-ban-b'); for (const x of btns) r.appendChild(x); b.appendChild(r); }
      bannerEl.appendChild(b);
      return b;
    };
    const btn = (label, fn, cls) => {
      const b = el('button', 'chat-btn' + (cls ? ' ' + cls : ''), label); b.type = 'button';
      // 비동기 동작은 끝날 때까지 눌러도 다시 시작하지 않게 막는다(사본 중복 생성·재확인 겹침 방지)
      b.addEventListener('click', () => { if (b.disabled) return; const r = fn(); if (r && typeof r.then === 'function') { b.disabled = true; r.finally(() => { b.disabled = false; }); } });
      return b;
    };
    if (s.noBackend) { add('warn', tr('chat.err.no_backend')); return; }
    if (s.loadErr) { add('warn', tr('chat.err.load'), [btn(tr('chat.retry'), () => { s.loadErr = false; load(s); }, 'pri')]); return; }
    if (svcOf(cur) === 'cloud') { add('info', tr('chat.view.cloud')); return; }
    if (s.state === 'view_only') {
      const known = ['open_elsewhere', 'just_written', 'in_use', 'maybe_open', 'cloud'];
      const b = add('info', tr(known.includes(s.why) ? 'chat.view.' + s.why : 'chat.view.default'), [
        btn(tr('chat.fork'), () => doFork(s), 'pri'),
        ...(s.why === 'maybe_open' ? [btn(tr('chat.takeover'), () => { confirmTake = true; paintBanner(); })] : []),
        btn(tr('chat.recheck'), () => recheck(s)),
      ]);
      if (confirmTake && s.why === 'maybe_open') {
        b.appendChild(el('div', 'chat-ban-c', tr('chat.takeover.confirm')));
        const r = el('div', 'chat-ban-b');
        r.append(btn(tr('chat.takeover'), () => doTakeover(s), 'pri'), btn(tr('chat.new.cancel'), () => { confirmTake = false; paintBanner(); }));
        b.appendChild(r);
      }
    }
    if (s.err) add('err', errText(s.err));
    const svc = svcOf(cur);
    const note = svc === 'claude' ? 'chat.bill.claude' : svc === 'codex' ? 'chat.codex.note' : '';
    if (note) {
      let hidden = false;
      try { hidden = localStorage.getItem('office.chatNote.' + svc) === '1'; } catch (e) { /* 무시 */ }
      if (!hidden) {
        const b = add('note', tr(note));
        const x = el('button', 'chat-ban-x', '×'); x.type = 'button';
        x.addEventListener('click', () => { try { localStorage.setItem('office.chatNote.' + svc, '1'); } catch (e) { /* 무시 */ } paintBanner(); });
        b.appendChild(x);
      }
    }
  }
  /**
   * 입력창·보내기/중단 단추·예상 비용 표시.
   * @returns {void}
   */
  function paintInput() {
    const s = cur && S.get(cur);
    const can = !!s && sendable(s);
    const busy = !!s && isBusy(s);
    const off = !s || s.noBackend || s.state === 'view_only' || !capable(cur) || svcOf(cur) === 'cloud';
    formEl.hidden = off;
    ta.disabled = !s || !s.loaded || busy && s.state === 'interrupting';
    const stopMode = busy;
    sendBtn.textContent = stopMode ? tr('chat.stop') : tr('chat.send');
    sendBtn.classList.toggle('stop', stopMode);
    sendBtn.disabled = stopMode ? s.state === 'interrupting' : !can;
    const ci = o.chatInfo ? o.chatInfo(cur) : null;
    ta.placeholder = tr('chat.placeholder', { name: (curInfo && curInfo.c && curInfo.c.name) || (ci && ci.title) || '' });
    costEl.hidden = !(s && s.cost != null);
    if (s && s.cost != null) costEl.textContent = tr('chat.bill.cost', { cost: Number(s.cost).toFixed(4) }) + (s.ctx != null ? ` · ${Math.round(s.ctx)}%` : '');
  }
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 8 * 20 + 16) + 'px'; };
  const draftKey = () => 'office.chatDraft.' + cur;
  const saveDraft = () => { if (!cur) return; try { if (ta.value) sessionStorage.setItem(draftKey(), ta.value); else sessionStorage.removeItem(draftKey()); } catch (e) { /* 무시 */ } };
  const loadDraft = () => { try { ta.value = (cur && sessionStorage.getItem(draftKey())) || ''; } catch (e) { ta.value = ''; } autosize(); };

  // ── 동작 ────────────────────────────────────────────────
  /**
   * 자동 수락이 켜져 있으면 처음 한 번만(office.chatAutoWarned) 토스트로 알린다 (기존 세션의 첫 전송용).
   * @param {string} key 세션 열쇠
   * @returns {Promise<void>}
   */
  async function autoWarnOnce(key) {
    try {
      if (localStorage.getItem('office.chatAutoWarned') === '1') return;
      const svc = svcOf(key);
      let on = false;
      if (svc === 'claude') { const c = await o.invoke('get_config'); on = !!(c && c.auto_allow); }
      else if (svc === 'codex') { const h = await o.invoke('get_provider_hook', { name: 'chatgpt' }); on = !!(h && h.auto_allow); }
      if (on) { o.toast(tr('chat.new.auto_warn')); localStorage.setItem('office.chatAutoWarned', '1'); }
    } catch (e) { /* 무시 */ }
  }
  /**
   * 입력창 글을 보낸다 (chat_send). 실패하면 글을 되돌리고 안내 띠에 종류만 보인다.
   * @returns {Promise<void>}
   */
  async function send() {
    const s = cur && S.get(cur);
    const text = ta.value.trim();
    if (!s || !text || !sendable(s)) return;
    ta.value = ''; autosize(); saveDraft();
    s.err = '';
    autoWarnOnce(s.key);
    try { await o.invoke('chat_send', { key: s.key, text }); } catch (e) {
      ta.value = text; autosize(); saveDraft();
      s.err = kindOf(e) || 'failed'; bad('send', e);
      if (s.key === cur) { paintBanner(); }
    }
  }
  /**
   * 답변 중단 (chat_interrupt).
   * @returns {Promise<void>}
   */
  async function stop() {
    const s = cur && S.get(cur);
    if (!s) return;
    try { await o.invoke('chat_interrupt', { key: s.key }); } catch (e) { bad('interrupt', e); }
  }
  /**
   * 사본으로 이어가기 (chat_fork) → 새 세션을 사무실에 알린다.
   * @param {Object} s 원본 세션
   * @returns {Promise<void>}
   */
  async function doFork(s) {
    if (s.forking) return; // 그리는 중 단추가 새로 만들어져도 사본이 두 번 만들어지지 않게
    s.forking = true;
    try {
      const r = await o.invoke('chat_fork', { key: s.key });
      if (r && r.key) o.onCreated(r.key, svcOf(s.key));
    } catch (e) { bad('fork', e); o.toast(tr('chat.new.fail')); } finally { s.forking = false; }
  }
  /**
   * 여기서 이어받기 (chat_takeover, 확인을 거친 뒤).
   * @param {Object} s 세션
   * @returns {Promise<void>}
   */
  async function doTakeover(s) {
    confirmTake = false;
    try { await o.invoke('chat_takeover', { key: s.key }); await recheck(s); } catch (e) { bad('takeover', e); }
    if (s.key === cur) paintBanner();
  }
  /**
   * 대화 닫기 (chat_close). 답변 중이면 거부된다.
   * @returns {Promise<void>}
   */
  async function doClose() {
    const s = cur && S.get(cur);
    if (!s) return;
    if (isBusy(s)) { o.toast(tr('chat.close.busy')); return; }
    try { await o.invoke('chat_close', { key: s.key }); S.delete(s.key); if (o.onChanged) o.onChanged(s.key); if (o.onClose) o.onClose(); hide(); } catch (e) { bad('close', e); o.toast(tr('chat.close.busy')); }
  }

  /**
   * 탭 전환 (정보 | 대화). 마지막 탭은 office.chatTab 에 저장.
   * @param {string} name "info" | "chat"
   * @returns {void}
   */
  function setTab(name) {
    if (name === 'chat' && cur && !capable(cur)) name = 'info';
    tab = name;
    try { localStorage.setItem('office.chatTab', name); } catch (e) { /* 무시 */ }
    for (const b of tabsEl.querySelectorAll('button')) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    infoEl.hidden = name !== 'info';
    paneEl.hidden = name !== 'chat';
    if (name === 'chat' && cur) {
      const s = model(cur);
      if (!s.loaded && !s.loading) load(s); else paintAll(s);
      loadDraft(); paintBanner(); paintInput();
      setTimeout(() => { try { ta.focus(); } catch (e) { /* 무시 */ } }, 0);
    }
    paintHead();
  }

  // ── 공개: 열기·닫기 ─────────────────────────────────────
  /**
   * 도크에 이 열쇠의 대화를 보인다 (이미 열려 있으면 탭만 맞춘다).
   * @param {string} key 세션(고양이) 열쇠
   * @param {string} [forceTab] 주면 마지막 탭 대신 이 탭으로 연다 ("chat" 등)
   * @returns {void}
   */
  function show(key, forceTab) {
    if (!o || !key) return;
    const same = cur === key && !dock.hidden;
    if (!same) { saveDraft(); cur = key; lastInfoHtml = ''; if (!curInfo || curInfo.c.id !== key) curInfo = null; infoEl.replaceChildren(); }
    dock.hidden = false;
    for (const b of tabsEl.querySelectorAll('button')) b.disabled = b.dataset.tab === 'chat' && !capable(key);
    setDockVar(true);
    if (forceTab) setTab(forceTab);
    else if (!same) setTab(capable(key) ? tab : 'info'); else paintHead();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { const s = cur && S.get(cur); if (s && s.loaded && s.state === 'view_only' && !dock.hidden && tab === 'chat') recheck(s); }, 5000);
  }
  /**
   * 도크 닫기 (선택 해제 쪽에서 호출).
   * @returns {void}
   */
  function hide() {
    if (!dock) return;
    saveDraft(); dock.hidden = true; menuEl.hidden = true; cur = null; curInfo = null;
    clearInterval(pollTimer); setDockVar(false);
  }
  const isOpen = () => !!dock && !dock.hidden;
  /**
   * 패널이 만든 '정보' 탭 본문을 받는다.
   * @param {PanelCat} c 고른 고양이
   * @param {string} html 본문 HTML (패널이 만든 고정 마크업, 글은 esc 처리됨)
   * @param {{logo: string, chip: string}} extra 로고·상태 칩 HTML
   * @returns {void}
   */
  function setInfo(c, html, extra) {
    if (!dock || c.id !== cur) return;
    const first = !curInfo;
    curInfo = { c, logo: extra.logo, chip: extra.chip };
    if (html !== lastInfoHtml) { infoEl.innerHTML = html; lastInfoHtml = html; }
    if (first || tab === 'info') paintHead();
    else { const ch = headEl.querySelector('.chat-name'); if (ch && ch.textContent !== c.name) paintHead(); }
  }

  // ── 새 대화 창 ──────────────────────────────────────────
  let modal = null, opening = false;
  const LOAD = typeof OfficeLoading !== 'undefined' ? OfficeLoading : null; // 공통 로딩 표시 (loading.js)
  /**
   * 새 대화 창을 연다: 고양이 · 서비스 · 작업 폴더만 보이고, 승인 방식·최근 폴더·설치 안내·과금 안내는 '옵션 더보기' 로 접어 둔다(신뢰·자동 수락 경고는 해당될 때 늘 보임).
   * @returns {Promise<void>}
   */
  async function openNew() {
    if (!live() || modal || opening) return;
    opening = true; // 준비(서비스·설정 조회)하는 동안 또 눌러도 창이 두 번 뜨지 않게
    let services = [];
    let cfg = null, codexAuto = false;
    const prep = (async () => {
      try { services = (await o.invoke('chat_services')) || []; } catch (e) { bad('services', e); }
      try { cfg = await o.invoke('get_config'); } catch (e) { /* 무시 */ }
      try { const h = await o.invoke('get_provider_hook', { name: 'chatgpt' }); codexAuto = !!(h && h.auto_allow); } catch (e) { /* 무시 */ }
    })();
    try { await (LOAD ? LOAD.wrap(prep, o.widgets, tr('chat.new.preparing'), { dim: false }) : prep); } finally { opening = false; }
    const have = new Map(services.map((x) => [String(x.service).toLowerCase(), x]));
    const rows = ['claude', 'codex', 'gemini'].map((id) => ({ id, ...(have.get(id) || { installed: id !== 'gemini', logged_in: true }) }));
    const recent = (o.recentFolders ? o.recentFolders() : []).slice(0, 8);
    const choices = o.catChoices ? o.catChoices() : []; // 고를 수 있는 고양이(품종)들: { id, name, level }
    const st = { svc: (rows.find((r) => r.installed && r.logged_in) || rows[0]).id, cwd: recent[0] || '', mode: 'ask', busy: false, breed: '', more: false }; // breed '' = 아무나(열쇠로 정해짐)
    modal = el('div', 'chat-modal');
    const mine = modal; // 이 창 (닫기가 다른 창을 건드리지 않게 제 것만 기억)
    const card = el('div', 'chat-modal-c');
    modal.appendChild(card);
    const gone = new AbortController(); // 창이 닫힐 때 전역(window) 리스너를 한꺼번에 뗀다
    const close = () => {
      if (!mine || modal !== mine) return; // 이미 닫혔다 (대화를 만드는 동안 Esc·바깥 클릭으로 먼저 닫은 경우 등)
      document.removeEventListener('keydown', onKey, true); gone.abort();
      if (o.catPreview) o.catPreview.hide();
      mine.remove(); modal = null;
    };
    // 고양이 고르기: 가운데에 고른 고양이가 방석에 앉아 천천히 도는 미리보기, 그 아래 좌우로 넘기는 캐러셀('아무나' + 품종들)
    let catBox = null;
    if (choices.length) {
      catBox = el('div', 'chat-catbox');
      const items = [{ id: '', name: tr('chat.new.cat_any'), level: 0 }].concat(choices);
      const pv = el('div', 'chat-catpv');
      const cv = document.createElement('canvas'); cv.className = 'chat-catpv-c';
      const any = el('div', 'chat-catpv-any', '?');
      const nm = el('div', 'chat-catpv-n');
      pv.append(cv, any, nm);
      // 미리보기를 끌면 고양이를 돌려 본다 (좌우 = 돌리기, 위아래 = 카메라 높이)
      let pvX = null, pvY = 0;
      pv.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; pvX = e.clientX; pvY = e.clientY; pv.setPointerCapture(e.pointerId); pv.classList.add('drag'); });
      pv.addEventListener('pointermove', (e) => { if (pvX == null) return; if (o.catPreview && o.catPreview.turn) o.catPreview.turn(e.clientX - pvX, e.clientY - pvY); pvX = e.clientX; pvY = e.clientY; });
      const pvEnd = () => { pvX = null; pv.classList.remove('drag'); };
      pv.addEventListener('pointerup', pvEnd); pv.addEventListener('pointercancel', pvEnd);
      const car = el('div', 'chat-car');
      const prev = el('button', 'chat-car-a', '‹'), next = el('button', 'chat-car-a', '›'); prev.type = next.type = 'button';
      const track = el('div', 'chat-car-t');
      /**
       * 고양이를 고른다: 캐러셀 표시·미리보기·이름표를 맞추고 고른 카드를 가운데로 민다.
       * @param {string} id 품종 키 ('' = 아무나)
       * @param {boolean} [smooth] 부드럽게 밀기
       * @returns {void}
       */
      const pickCat = (id, smooth) => {
        if (modal !== mine) return; // 이미 닫힌 창
        st.breed = id;
        const i = Math.max(0, items.findIndex((c) => c.id === id));
        cards.forEach((b, k) => b.classList.toggle('on', k === i));
        const b = cards[i];
        center(b, smooth);
        any.hidden = !!id;
        nm.textContent = id ? items[i].name + ' · Lv.' + items[i].level : tr('chat.new.cat_any_note');
        try { if (o.catPreview) o.catPreview.set(id); } catch (e) { bad('preview', e); } // 미리보기가 안 돼도 고르기는 된다
      };
      /**
       * 카드 b 를 줄 가운데로 민다 (고르기·다시 붙인 뒤 위치 맞추기가 함께 쓴다).
       * @param {HTMLElement} b 카드
       * @param {boolean} [smooth] 부드럽게 밀기
       * @returns {void}
       */
      const center = (b, smooth) => {
        // 고른 카드를 줄 가운데로: 화면 좌표로 계산한다(부모 기준 offset 은 배치에 따라 어긋남). 끝에서 끝으로 넘어갈 때처럼 멀리 가면 부드럽게 밀지 않고 바로 옮긴다 — 멀리 미는 도중 멈춰 고른 카드가 안 보이던 것
        const tr0 = track.getBoundingClientRect(), br = b.getBoundingClientRect();
        const left = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, track.scrollLeft + (br.left - tr0.left) - (track.clientWidth - br.width) / 2));
        const far = Math.abs(left - track.scrollLeft) > track.clientWidth * 1.2;
        track.style.scrollSnapType = 'none'; // 맞춤(스냅)이 옮기는 도중 끼어들지 않게 잠깐 끈다
        track.scrollTo({ left, behavior: smooth && !far ? 'smooth' : 'auto' });
        clearTimeout(track._snapT); track._snapT = setTimeout(() => { track.style.scrollSnapType = ''; }, 450);
      };
      const cards = items.map((c) => {
        const b = el('button', 'chat-car-i'); b.type = 'button';
        b.append(el('b', '', c.name), el('small', '', c.id ? 'Lv.' + c.level : tr('chat.new.cat_any_sub')));
        b.addEventListener('click', () => pickCat(c.id, true));
        track.appendChild(b);
        return b;
      });
      const step = (d) => { const i = Math.max(0, items.findIndex((c) => c.id === st.breed)); pickCat(items[(i + d + items.length) % items.length].id, true); };
      prev.addEventListener('click', () => step(-1));
      next.addEventListener('click', () => step(1));
      track.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { track.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false }); // 세로 휠로도 좌우로 넘긴다
      // 끌어서 넘기기: 누른 채 좌우로 끌면 줄이 따라 움직인다 (6px 넘게 끌었으면 그 손놀림은 카드 고르기로 치지 않는다)
      let dragX = null, dragL = 0, dragged = false;
      track.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragX = e.clientX; dragL = track.scrollLeft; dragged = false; });
      window.addEventListener('pointermove', (e) => {
        if (dragX == null) return;
        const dx = e.clientX - dragX;
        if (Math.abs(dx) > 6) { dragged = true; track.classList.add('drag'); }
        if (dragged) track.scrollLeft = dragL - dx;
      }, { signal: gone.signal });
      window.addEventListener('pointerup', () => { dragX = null; track.classList.remove('drag'); }, { signal: gone.signal });
      track.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
      car.append(prev, track, next);
      catBox.append(el('div', 'chat-lb', tr('chat.new.cat')), pv, car);
      try { if (o.catPreview) o.catPreview.show(cv, st.breed); else cv.hidden = true; } catch (e) { bad('preview', e); cv.hidden = true; } // 미리보기를 못 띄워도 고르기는 된다
      catBox.recenter = () => { const b = cards[Math.max(0, items.findIndex((c) => c.id === st.breed))]; if (b && b.isConnected) center(b, false); };
      requestAnimationFrame(() => pickCat(st.breed, false)); // 붙은 뒤 폭이 정해지면 가운데로
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!st.busy) close(); } }; // 대화를 만드는 중에는 닫지 않는다
    document.addEventListener('keydown', onKey, true);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal && !st.busy) close(); });
    const warned = (() => { try { return localStorage.getItem('office.chatAutoWarned') === '1'; } catch (e) { return true; } })();
    const billSeen = (() => { try { return localStorage.getItem('office.chatBillSeen') === '1'; } catch (e) { return true; } })(); // Claude 과금 안내를 이미 보고 대화를 시작한 적이 있는가
    const paint = () => {
      card.replaceChildren();
      card.appendChild(el('h3', 'chat-modal-h', tr('chat.new.title')));
      const x = el('button', 'chat-modal-x', '×'); x.type = 'button'; x.title = tr('chat.new.cancel'); x.addEventListener('click', close); // 오른쪽 위 닫기
      card.appendChild(x);
      // 고양이: 이 대화를 맡을 고양이(품종)를 고른다. '아무나' 면 예전처럼 알아서 정해진다
      if (catBox) { card.appendChild(catBox); if (catBox.recenter) requestAnimationFrame(catBox.recenter); } // 한 번 만든 것을 다시 붙인다 (미리보기 화면이 그리기마다 새로 만들어지지 않게). 떼었다 붙이면 줄 위치가 처음으로 돌아가므로 다시 맞춘다
      // 서비스: 쓸 수 있는 것만 단추 한 줄로 (설치 안 된 서비스·설치 안내는 '옵션 더보기' 안)
      card.appendChild(el('div', 'chat-lb', tr('chat.new.service')));
      const sv = el('div', 'chat-modes');
      for (const r of rows.filter((x) => x.installed)) {
        const b = el('button', 'chat-mode' + (st.svc === r.id ? ' on' : ''), tr('chat.svc.' + r.id)); b.type = 'button';
        b.addEventListener('click', () => { st.svc = r.id; paint(); });
        sv.appendChild(b);
      }
      card.appendChild(sv);
      const curSvc = rows.find((r) => r.id === st.svc);
      if (curSvc && curSvc.installed && curSvc.logged_in === false && curSvc.id !== 'gemini') { // 고른 서비스에 로그인이 필요할 때만 안내
        const g = el('button', 'chat-link', tr('chat.new.login')); g.type = 'button';
        g.addEventListener('click', () => { (curSvc.id === 'claude' ? o.invoke('claude_login') : o.invoke('provider_login', { name: 'chatgpt' })).catch((e) => { bad('login', e); o.toast(tr('chat.login.fail')); }); });
        card.appendChild(g);
      }
      // 작업 폴더: 지금 고른 폴더 하나 + [폴더 고르기] (최근 폴더 목록은 '옵션 더보기' 안)
      card.appendChild(el('div', 'chat-lb', tr('chat.new.folder')));
      const fl = el('div', 'chat-folders');
      if (st.cwd) { const cw = el('div', 'chat-fold on', st.cwd.split(/[\/]/).filter(Boolean).slice(-2).join('/') || st.cwd); cw.title = st.cwd; fl.appendChild(cw); }
      const pick = el('button', 'chat-btn', tr('chat.new.pick')); pick.type = 'button';
      pick.addEventListener('click', async () => { try { const p = await o.invoke('pick_folder'); if (p) { st.cwd = p; paint(); } } catch (e) { bad('pick', e); } });
      fl.appendChild(pick);
      card.appendChild(fl);
      // 꼭 알아야 하는 경고만 늘 보인다: 처음 쓰는 폴더의 신뢰 안내, 자동 수락 경고
      if (st.svc === 'claude' && st.cwd && !recent.includes(st.cwd)) card.appendChild(el('div', 'chat-ban note', tr('chat.trust')));
      if (((st.svc === 'claude' && cfg && cfg.auto_allow) || (st.svc === 'codex' && codexAuto)) && !warned) card.appendChild(el('div', 'chat-ban warn', tr('chat.new.auto_warn')));
      // 과금 안내: Claude 로 처음 대화를 시작하기 전 한 번은 늘 보인다 (한 번 시작한 뒤에는 '옵션 더보기' 안에서만)
      if (st.svc === 'claude' && !billSeen && !st.more) card.appendChild(el('div', 'chat-ban note', tr('chat.bill.claude')));
      // 옵션 더보기: 승인 방식 · 최근 폴더 · 설치 안 된 서비스 · 과금 안내 (평소엔 접어 둔다)
      const moreB = el('button', 'chat-link chat-more', tr(st.more ? 'chat.new.less' : 'chat.new.more')); moreB.type = 'button';
      moreB.addEventListener('click', () => { st.more = !st.more; paint(); });
      card.appendChild(moreB);
      if (st.more) {
        card.appendChild(el('div', 'chat-lb', tr('chat.new.mode')));
        const md = el('div', 'chat-modes');
        for (const m of ['ask', 'accept_edits', 'read_only']) {
          const b = el('button', 'chat-mode' + (st.mode === m ? ' on' : ''), tr('chat.mode.' + m)); b.type = 'button';
          b.addEventListener('click', () => { st.mode = m; paint(); });
          md.appendChild(b);
        }
        card.appendChild(md);
        if (recent.length > 1) {
          card.appendChild(el('div', 'chat-lb', tr('chat.new.recent')));
          const rf = el('div', 'chat-folders');
          for (const f of recent) {
            const b = el('button', 'chat-fold' + (st.cwd === f ? ' on' : ''), f.split(/[\/]/).filter(Boolean).slice(-2).join('/') || f); b.type = 'button'; b.title = f;
            b.addEventListener('click', () => { st.cwd = f; paint(); });
            rf.appendChild(b);
          }
          card.appendChild(rf);
        }
        for (const r of rows.filter((x) => !x.installed)) { // 설치 안 된 서비스: 설치 안내
          const b = el('div', 'chat-svc dis');
          const lab = el('button', 'chat-svc-b', tr('chat.svc.' + r.id)); lab.type = 'button'; lab.disabled = true;
          b.appendChild(lab);
          const g = el('button', 'chat-link', tr('chat.new.install')); g.type = 'button';
          g.addEventListener('click', () => { o.invoke('open_url', { url: INSTALL_URL[r.id] }).catch(() => { o.toast(INSTALL_URL[r.id]); }); }); // 막히면 주소를 보여 준다
          b.appendChild(g);
          b.appendChild(el('div', 'chat-svc-n chat-addr', INSTALL_URL[r.id])); // 복사할 수 있는 주소
          if (r.id === 'gemini') b.appendChild(el('div', 'chat-svc-n', tr('chat.gemini.install')));
          card.appendChild(b);
        }
        if (st.svc === 'claude') card.appendChild(el('div', 'chat-ban note', tr('chat.bill.claude')));
        else if (st.svc === 'codex') card.appendChild(el('div', 'chat-ban note', tr('chat.codex.note')));
      }
      const err = el('div', 'chat-ban err'); err.hidden = true; card.appendChild(err);
      const acts = el('div', 'chat-modal-a');
      const cancel = el('button', 'chat-btn', tr('chat.new.cancel')); cancel.type = 'button'; cancel.addEventListener('click', close);
      const go = el('button', 'chat-btn pri', tr('chat.new.start')); go.type = 'button';
      const cur0 = rows.find((r) => r.id === st.svc);
      go.disabled = st.busy || !cur0 || !cur0.installed || cur0.logged_in === false;
      go.addEventListener('click', async () => {
        if (!st.cwd) { err.textContent = tr('chat.new.no_folder'); err.hidden = false; return; }
        st.busy = true; go.disabled = true;
        try {
          const making = o.invoke('chat_new', { service: st.svc, cwd: st.cwd, mode: st.mode, trustAck: true });
          const r = await (LOAD ? LOAD.wrap(making, card, tr('chat.new.calling'), { delay: 120 }) : making); // 고양이를 부르는 동안 창을 덮는다
          if ((st.svc === 'claude' && cfg && cfg.auto_allow) || (st.svc === 'codex' && codexAuto)) { try { localStorage.setItem('office.chatAutoWarned', '1'); } catch (e) { /* 무시 */ } }
          if (st.svc === 'claude') { try { localStorage.setItem('office.chatBillSeen', '1'); } catch (e) { /* 무시 */ } }
          close();
          if (r && r.key) o.onCreated(r.key, st.svc, st.breed);
        } catch (e) {
          bad('new', e); st.busy = false; go.disabled = false;
          const k = kindOf(e);
          err.textContent = k.includes('busy_limit') ? tr('chat.err.busy_limit') : tr('chat.new.fail'); err.hidden = false;
        }
      });
      acts.append(cancel, go);
      card.appendChild(acts);
    };
    paint();
    o.widgets.appendChild(modal);
  }

  // ── 시작 ────────────────────────────────────────────────
  /**
   * 도크 요소를 만들어 #widgets 에 붙이고 이벤트를 건다.
   * @param {ChatOpts} opts 콜백 묶음
   * @returns {void}
   */
  function init(opts) {
    o = opts;
    dock = el('section', 'chat-dock'); dock.id = 'chatDock'; dock.hidden = true;
    headEl = el('header', 'chat-head');
    tabsEl = el('nav', 'chat-tabs'); tabsEl.setAttribute('role', 'tablist');
    for (const [k, lab] of [['info', 'chat.tab.info'], ['chat', 'chat.tab.chat']]) {
      const b = el('button', null, tr(lab)); b.type = 'button'; b.dataset.tab = k; b.setAttribute('role', 'tab');
      b.addEventListener('click', () => setTab(k));
      tabsEl.appendChild(b);
    }
    infoEl = el('div', 'chat-info wg-b');
    paneEl = el('div', 'chat-pane');
    bannerEl = el('div', 'chat-bans');
    const wrap = el('div', 'chat-listw');
    listEl = el('div', 'chat-list');
    olderBtn = el('button', 'chat-older', tr('chat.older')); olderBtn.type = 'button'; olderBtn.hidden = true;
    olderBtn.addEventListener('click', () => { const s = cur && S.get(cur); if (s) older(s); });
    latestBtn = el('button', 'chat-latest', tr('chat.latest')); latestBtn.type = 'button'; latestBtn.hidden = true;
    latestBtn.addEventListener('click', () => { const s = cur && S.get(cur); if (s && s.end != null) paintAll(s); else toBottom(); });
    wrap.append(listEl, latestBtn);
    costEl = el('div', 'chat-cost'); costEl.hidden = true;
    formEl = el('form', 'chat-form');
    ta = el('textarea', 'chat-ta'); ta.rows = 1;
    sendBtn = el('button', 'chat-send', tr('chat.send')); sendBtn.type = 'submit';
    formEl.append(ta, sendBtn);
    menuEl = el('div', 'chat-menu'); menuEl.hidden = true;
    for (const [lab, fn] of [['chat.menu.fork', () => { const s = cur && S.get(cur); if (s) doFork(s); }], ['chat.menu.close', doClose]]) {
      const b = el('button', null, tr(lab)); b.type = 'button';
      b.addEventListener('click', () => { menuEl.hidden = true; fn(); });
      menuEl.appendChild(b);
    }
    const open = el('button', null, tr('chat.menu.open')); open.type = 'button'; open.dataset.open = '1';
    open.addEventListener('click', () => { menuEl.hidden = true; if (cur && o.openTarget) o.openTarget(cur); });
    menuEl.appendChild(open);
    paneEl.append(bannerEl, olderBtn, wrap, costEl, formEl);
    dock.append(headEl, tabsEl, infoEl, paneEl, menuEl);
    o.widgets.appendChild(dock);

    listEl.addEventListener('scroll', () => {
      sticky = nearBottom();
      if (sticky) latestBtn.hidden = true;
      const s = cur && S.get(cur);
      if (s && sticky && s.end != null) paintAll(s);
      if (s && listEl.scrollTop < 30) older(s);
    });
    ta.addEventListener('input', () => { autosize(); saveDraft(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return; // 줄바꿈·한글 조합 중 Enter 는 무시
      e.preventDefault(); send();
    });
    formEl.addEventListener('submit', (e) => { e.preventDefault(); const s = cur && S.get(cur); if (s && isBusy(s)) stop(); else send(); });
    document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) menuEl.hidden = true; });
    window.addEventListener('resize', () => { if (!dock.hidden) setDockVar(true); });
    window.addEventListener('meow-lang', () => {
      for (const b of tabsEl.querySelectorAll('button')) b.textContent = tr('chat.tab.' + b.dataset.tab);
      if (cur) { paintHead(); paintBanner(); paintInput(); }
    });
  }

  return { init, show, hide, isOpen, setInfo, onEvent, openNew };
})();
