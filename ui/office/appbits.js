/**
 * @file 앱 공통 기능 모음 (OfficeApp). 예전 트레이 관리 창에서 사무실 창으로 옮겨 온 기능들.
 * 위쪽 막대의 업데이트 단추, 업데이트 완료 안내 카드, Claude 로그인 안내 카드, 알림 읽음 처리를 맡는다.
 * 스크립트 전역 상수 OfficeApp 하나만 내보내고, office.js 가 위쪽 막대를 만든 뒤 OfficeApp.start 를 부른다.
 *
 * 공개 API: OfficeApp.start(opts) → { onAlertsShown, onPlan, onAlerts }
 * Tauri 명령: check_update · install_update · get_update · take_update_notes · current_notes · get_plan · cred_stamp · claude_login · open_url · mark_alerts_read
 * Tauri 이벤트: update · update_notes
 * PlanSnap · AlertEntry 모양은 office.js 위쪽 typedef 참고
 */
// 앱 공통 기능 (예전 트레이 관리 창에서 옮겨 옴): 업데이트 단추 · 업데이트 완료 안내 · Claude 로그인 안내 · 알림 읽음 처리
// OfficeApp.start({ invoke, listen, toast, bar, stage, alertsVisible() }) → { onPlan(snap), onAlerts(list) }
'use strict';

/**
 * @typedef {Object} UpdateInfo 새 버전 정보 (Rust update::Available)
 * @property {string} version 새 버전 번호
 * @property {string} notes 변경 내역 (여러 줄 문자열, 비면 빈 문자열)
 */

/**
 * @typedef {(null|"no_credentials"|"expired"|"auth")} LoginKind 로그인 안내 종류 (PlanSnap.error_kind 중 로그인 문제만). null 이면 안내 없음
 */

/**
 * @typedef {Object} OfficeAppOptions OfficeApp.start 에 넘기는 설정
 * @property {?function(string, Object=): Promise<*>} invoke Tauri invoke (브라우저 시연이면 null)
 * @property {?function(string, function(Object): void): *} listen Tauri event.listen (없으면 null)
 * @property {function(string): void} toast 화면 아래 알림 문구 띄우기
 * @property {?HTMLElement} bar 위쪽 막대 (업데이트 단추를 #fsBtn 앞에 끼운다)
 * @property {HTMLElement} stage 안내 카드를 붙일 무대 요소
 * @property {function(): boolean} [alertsVisible] 최근 알림 카드가 펼쳐져 있는지
 * @property {function(): AlertEntry[]} [lastAlerts] 마지막으로 받은 알림 기록
 * @property {function(PlanSnap): void} [onPlanRefreshed] 로그인 안내에서 다시 확인해 플랜을 얻었을 때 office.js 로 돌려주는 콜백
 */

/**
 * 앱 공통 기능 모듈 (즉시 실행 함수로 감싼 전역 객체).
 * start 하나만 내보낸다. 상태는 start 호출 안의 지역 변수로 둔다.
 * @returns {{start: function(OfficeAppOptions): {onAlertsShown: function(): void, onPlan: function(PlanSnap): void, onAlerts: function(AlertEntry[]): void}}} 공개 API
 * @see start
 */
const OfficeApp = (() => {
  /**
   * HTML 에 끼워 넣을 문자열 이스케이프.
   * null·undefined 는 빈 문자열로, & < > " 따옴표 를 엔티티로 바꾼다.
   * @param {*} s 원본 값 (문자열로 바꿔 처리)
   * @returns {string} 안전하게 바뀐 문자열
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  };
  /**
   * 아이콘 이름으로 선 아이콘 SVG 문자열 만들기.
   * ICON 표의 경로를 24칸 선 아이콘 틀에 끼운다.
   * @param {string} k ICON 의 키 ("download" | "refresh")
   * @returns {string} <svg> 마크업
   */
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  // ── 로그인 안내 (Claude Code 자격 증명이 없거나 만료·거부) ──
  const INSTALL_CMD = 'irm https://claude.ai/install.ps1 | iex';
  /**
   * 명령어 한 줄과 복사 단추 HTML 만들기.
   * 단추의 data-copy 를 mkCard 의 클릭 처리가 읽어 클립보드에 복사한다.
   * @param {string} cmd 보여 줄 명령어
   * @returns {string} HTML 조각
   * @see mkCard
   */
  const cmdRow = (cmd) => `<div class="ap-cmd"><code>${esc(cmd)}</code><button data-copy="${esc(cmd)}">복사</button></div>`;
  const LOGIN = {
    no_credentials: {
      title: 'Claude 로그인이 필요합니다',
      lead: 'Meowffice 는 Claude Code 의 로그인 정보로 사용 한도와 세션을 봅니다. 아래 순서로 한 번만 설정하면 됩니다.',
      steps: [
        `<b>Claude Code 설치</b> — PowerShell 을 열고 실행하세요.${cmdRow(INSTALL_CMD)}<div class="ap-muted">Node.js 가 있으면 <code>npm install -g @anthropic-ai/claude-code</code> 도 됩니다</div>`,
        `<b>로그인</b> — 아래 <b>Claude Code 로그인</b> 을 누르면 브라우저가 열립니다. <b>Claude 구독 계정</b>(Pro·Max 등)으로 로그인하세요.<div class="ap-muted">직접 하려면 터미널에서:</div>${cmdRow('claude auth login')}`,
        '로그인이 끝나면 자동으로 연결됩니다. 그 뒤로는 Claude Code 를 쓰지 않아도 됩니다.',
      ],
    },
    expired: {
      title: '로그인이 만료되었습니다',
      lead: 'Claude Code 를 한동안 쓰지 않아 로그인 정보가 만료되었습니다. Claude Code 를 한 번 실행하면 저절로 갱신됩니다.',
      steps: [`터미널에서 실행한 뒤 화면이 뜨면 종료(<code>/exit</code>)하고 <b>다시 확인</b> 을 누르세요.${cmdRow('claude')}`, '또는 아래 <b>Claude Code 로그인</b> 으로 다시 로그인하세요. 끝나면 자동으로 연결됩니다.'],
    },
    auth: {
      title: '인증에 실패했습니다',
      lead: '저장된 로그인 정보가 거부되었습니다. Claude Code 에서 다시 로그인하세요.',
      steps: ['아래 <b>Claude Code 로그인</b> 을 누르고, 열린 브라우저에서 구독 계정으로 로그인하세요.', '로그인이 끝나면 자동으로 연결됩니다.'],
    },
  };

  /**
   * 앱 공통 기능 시작.
   * 업데이트 단추를 위쪽 막대에 달고, 안내 카드 둘(업데이트 완료·로그인)을 만들며, 키 입력·창 포커스·Tauri 이벤트를 연결한다.
   * 사무실 창을 열 때 마지막 확인이 10분 넘었으면 3초 뒤 조용히 새 버전을 확인한다.
   * 반환 객체: onAlertsShown() = 알림 카드가 펼쳐졌을 때 읽음 처리 재시도, onPlan(snap) = 플랜 결과에 따라 로그인 안내 열기·닫기, onAlerts(list) = 알림 목록이 바뀔 때 읽음 처리.
   * @param {OfficeAppOptions} o 설정
   * @returns {{onAlertsShown: function(): void, onPlan: function(PlanSnap): void, onAlerts: function(AlertEntry[]): void}} 사무실이 부르는 공개 함수
   * @see check_update, install_update, get_update, take_update_notes, get_plan, mark_alerts_read
   */
  function start(o) {
    const { invoke, listen, toast, bar, stage } = o;

    // ── 업데이트 단추 (위쪽 막대): 확인 → 새 버전 있으면 설치 → 설치 중(앱이 닫혔다 다시 켜짐) ──
    let pending = null; let installing = false; let checking = false; // installing: 설치(내려받기) 진행 중, checking: 단추로 연 확인이 진행 중
    const upd = document.createElement('button');
    upd.className = 'ib ap-upd';
    /**
     * 업데이트 단추 모양 맞추기.
     * 새 버전이 있으면 내려받기 아이콘과 N 배지·설치 안내 툴팁, 없으면 새로고침 아이콘과 확인 안내 툴팁.
     * pending 에 새 버전을 기억하고 단추를 다시 누를 수 있게 켠다.
     * @param {?UpdateInfo} u 새 버전 정보 (없으면 null)
     * @returns {void}
     */
    const showUpdate = (u) => {
      pending = u || null;
      upd.disabled = installing; // 설치 중에는 확인 이벤트가 와도 단추를 다시 켜지 않는다 (이중 설치 방지)
      upd.classList.toggle('new', !!u);
      upd.innerHTML = svg(u ? 'download' : 'refresh') + (u ? `<em class="bad">N</em>` : '');
      upd.title = u ? `새 버전 ${u.version} — 눌러서 바뀌는 내용 보기` : '업데이트 (마지막 업데이트 내역 보기 · 새 버전이 있으면 설치)';
    };
    /**
     * 새 버전 설치 (업데이트 대기 중 카드의 [업데이트]).
     * 설치가 끝나면 앱이 닫혔다 다시 켜지므로 성공 쪽에서는 돌아오지 않는다. 실패하면 토스트로 알리고 단추를 되돌린다.
     * @param {UpdateInfo} u 설치할 새 버전
     * @returns {Promise<void>}
     * @see install_update
     */
    const install = async (u) => {
      if (!invoke || installing) return;
      toast(`새 버전 ${u.version} 설치 중… 끝나면 다시 시작합니다`);
      installing = true; upd.disabled = true;
      try { await invoke('install_update'); } catch (e) { installing = false; toast('업데이트 실패: ' + e); showUpdate(u); }
    };
    /**
     * 업데이트 단추 클릭: 언제나 업데이트 창(설정 창 같은 가운데 카드)을 연다.
     * 새 버전이 있으면 '업데이트 대기 중' — 바뀌는 내용과 켜진 [업데이트]. 없으면 지금 버전의 마지막 업데이트 내역과 꺼진 [업데이트].
     * 어느 쪽이든 [확인] 은 닫기. 새 버전을 아직 모르면 먼저 확인한다(확인에 실패하면 그 사실을 창에 적는다).
     * @returns {Promise<void>}
     * @see check_update, current_notes, showPending, showCurrent, showUpdate, stampCheck
     */
    upd.onclick = async () => {
      if (!invoke || installing || checking) return;
      if (pending) { showPending(pending); return; }
      upd.disabled = true; checking = true; // 확인·내역 조회가 끝날 때까지 다시 누르지 못하게
      let failed = '', ld = null, cur = null, found = null;
      try {
        ld = typeof OfficeLoading !== 'undefined' ? OfficeLoading.cover(stage, '업데이트 확인 중…', { dim: false }) : null; // 확인·내역 조회가 끝날 때까지 (공통 로딩 표시)
        try {
          found = (await invoke('check_update')) || null;
          stampCheck();
        } catch (e) { failed = String(e); }
        if (!found) { try { cur = await invoke('current_notes'); } catch (e) { /* 내역 없이 연다 */ } }
      } finally { // 무슨 일이 있어도 덮개를 걷고 단추를 되돌린다 (안 그러면 단추가 영영 꺼진 채 남는다)
        try { if (ld) ld.done(); } catch (e) { /* 무시 */ }
        checking = false;
        showUpdate(found || pending); // 단추 모양·켜짐 복구 (내역을 구하는 사이 새 버전 소식이 왔으면 그것을 유지)
      }
      if (pending) { showPending(pending); return; }
      showCurrent(cur || { version: '', notes: '' }, failed);
    };
    showUpdate(null);
    // 사무실 창을 열 때: 마지막 확인이 10분 넘게 지났으면 조용히 다시 확인 (앱은 10초 뒤·1시간마다 따로 확인)
    const LAST_KEY = 'office.updateChecked';
    /**
     * 마지막 업데이트 확인 시각을 localStorage 에 기록.
     * 저장소를 못 써도 조용히 넘어간다.
     * @returns {void}
     */
    const stampCheck = () => { try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) { /* 무시 */ } };
    /**
     * 마지막 업데이트 확인 시각 읽기.
     * 기록이 없거나 저장소를 못 쓰면 0.
     * @returns {number} 밀리초 시각 (없으면 0)
     */
    const lastCheck = () => { try { return +localStorage.getItem(LAST_KEY) || 0; } catch (e) { return 0; } };
    if (invoke && Date.now() - lastCheck() > 10 * 60 * 1000) {
      setTimeout(() => {
        if (pending) return;
        invoke('check_update').then((u) => { stampCheck(); if (u && !pending) showUpdate(u); }, () => {});
      }, 3000);
    }
    if (bar) bar.insertBefore(upd, bar.querySelector('#fsBtn'));

    // ── 화면 가운데 안내 카드: 업데이트 완료 · 로그인 안내를 따로 둬 서로 덮어쓰지 않게 ──
    /**
     * 화면 가운데 안내 카드 하나 만들기.
     * 배경 오버레이와 카드를 stage 에 붙이고 숨겨 둔다. 업데이트 완료·로그인 안내를 각각 따로 만들어 서로 덮어쓰지 않게 한다.
     * 오버레이 바깥·× 단추·data-ap="close" 단추는 닫기, data-copy 단추는 클립보드 복사 후 토스트.
     * @param {string} cls 오버레이에 더할 클래스 이름
     * @returns {{ov: HTMLElement, open: function(string, string, function(): void=): void, hide: function(): void, close: function(): void}} 카드 제어 객체. open(제목, 본문 HTML, 닫을 때 부를 함수), hide = 콜백 없이 숨김, close = 닫고 콜백 호출
     */
    function mkCard(cls) {
      const ov = document.createElement('div');
      ov.className = 'us-overlay ap-ov ' + cls;
      ov.hidden = true;
      ov.innerHTML = '<div class="us-card ap-card" role="dialog"><header><div class="us-t"><b class="ap-title"></b></div><button class="us-x" title="닫기">×</button></header><div class="us-b ap-body"></div></div>';
      stage.appendChild(ov);
      let onClose = null;
      const c = {
        ov,
        /**
         * 카드 열기.
         * 제목은 텍스트로, 본문은 HTML 로 채우고 닫을 때 부를 함수를 기억한 뒤 보인다.
         * @param {string} title 제목
         * @param {string} html 본문 HTML
         * @param {function(): void} [close] 사용자가 닫을 때 부를 함수
         * @returns {void}
         */
        open(title, html, close) { ov.querySelector('.ap-title').textContent = title; ov.querySelector('.ap-body').innerHTML = html; onClose = close || null; ov.hidden = false; },
        /**
         * 카드를 콜백 없이 조용히 숨기기.
         * @returns {void}
         */
        hide() { ov.hidden = true; onClose = null; },
        /**
         * 카드 닫기.
         * 숨긴 뒤 기억해 둔 닫힘 콜백이 있으면 한 번만 호출한다.
         * @returns {void}
         */
        close() { ov.hidden = true; if (onClose) { const f = onClose; onClose = null; f(); } },
      };
      ov.addEventListener('click', async (e) => {
        if (e.target === ov || e.target.closest('.us-x') || e.target.closest('[data-ap="close"]')) return c.close();
        const cp = e.target.closest('[data-copy]');
        if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('복사됨: ' + cp.dataset.copy); } catch (_) { toast(cp.dataset.copy); } }
      });
      return c;
    }
    const notesCard = mkCard('ap-notes-ov'), loginCard = mkCard('ap-login-ov');
    // Esc: 맨 위 안내 카드 하나만 닫고 다른 창(설정 등)까지 닫지 않게 여기서 멈춤.
    // 업데이트 완료 안내가 열려 있으면 Enter = 확인, 화살표는 막음 (뒤에 깔린 처음 안내가 넘어가지 않게)
    /**
     * 키 입력 가로채기 (캡처 단계).
     * 업데이트 완료 안내가 열려 있으면 Enter = 확인, 좌우 화살표는 막아 뒤에 깔린 처음 안내가 넘어가지 않게 한다.
     * Esc 는 맨 위 안내 카드 하나만 닫고 전파를 멈춰 다른 창(설정 등)까지 닫지 않게 한다.
     * @param {KeyboardEvent} e 키 이벤트
     * @returns {void}
     */
    window.addEventListener('keydown', (e) => {
      const notesOpen = !notesCard.ov.hidden;
      if (notesOpen && (e.key === 'Enter' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.stopImmediatePropagation(); e.preventDefault();
        if (e.key === 'Enter') notesCard.close();
        return;
      }
      if (e.key !== 'Escape') return;
      const top = notesOpen ? notesCard : !loginCard.ov.hidden ? loginCard : null;
      if (top) { e.stopImmediatePropagation(); top.close(); }
    }, true);

    // 업데이트 완료 안내: 앱에서 설치한 새 버전으로 다시 켜졌을 때 1회
    /**
     * 변경 내역 목록 HTML (업데이트 완료·업데이트 대기 중 카드가 같이 쓴다).
     * 변경 내역을 줄별로 나눠 # 로 시작하는 줄은 소제목, 나머지는 - * • 머리표를 뗀 목록 항목으로 만든다.
     * 머리표 줄이 하나라도 있으면 머리표 없는 줄("새 기능" 처럼)도 소제목으로 본다. 내용이 없으면 안내 문구.
     * @param {UpdateInfo} u 버전 정보 (notes)
     * @returns {string} <ul class="ap-notes"> HTML
     * @see showWhatsNew, showPending
     */
    const notesList = (u) => {
      const lines = String(u.notes || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const BULLET = /^[-*•]\s*/;
      const hasBullets = lines.some((l) => BULLET.test(l));
      const isHead = (l) => /^#+\s*/.test(l) || (hasBullets && !BULLET.test(l));
      const li = lines.length
        ? lines.map((l) => (isHead(l) ? `<li class="head">${esc(l.replace(/^#+\s*/, ''))}</li>` : `<li>${esc(l.replace(BULLET, ''))}</li>`)).join('')
        : '<li class="ap-muted">등록된 변경 내역이 없습니다.</li>';
      return `<ul class="ap-notes">${li}</ul>`;
    };
    const showWhatsNew = (u) => notesCard.open(`v${u.version} 업데이트 완료`, notesList(u) + '<div class="ap-btns"><button class="ap-btn pri" data-ap="close">확인</button></div>');
    /**
     * 업데이트 대기 중 카드: 업데이트 이력과 같은 카드에 제목만 바꿔, 설치될 새 버전의 바뀌는 내용과 [업데이트]·[취소] 단추를 나란히.
     * @param {UpdateInfo} u 새 버전 정보
     * @returns {void}
     * @see install
     */
    function showPending(u) {
      notesCard.open(`v${u.version} 업데이트 대기 중`, notesList(u) + '<div class="ap-btns"><button class="ap-btn" data-ap="close">확인</button><button class="ap-btn pri" data-ap="install">업데이트</button></div>');
    }
    /**
     * 새 버전이 없을 때의 업데이트 창: 지금 버전의 마지막 업데이트 내역 + [확인] + 꺼진 [업데이트].
     * @param {UpdateInfo} u 지금 버전과 그 변경 내역 (내역을 못 구했으면 notes 가 빈 문자열)
     * @param {string} [failed] 업데이트 확인이 실패했으면 그 까닭 (창 위에 적는다)
     * @returns {void}
     * @see showPending
     */
    function showCurrent(u, failed) {
      const head = failed ? `<p class="ap-muted">업데이트 확인 실패: ${esc(failed)}</p>` : '<p class="ap-muted">최신 버전입니다. 아래는 마지막 업데이트 내역입니다.</p>';
      notesCard.open(u.version ? `v${u.version} 업데이트 내역` : '업데이트 내역', head + notesList(u) + '<div class="ap-btns"><button class="ap-btn" data-ap="close">확인</button><button class="ap-btn pri" disabled title="업데이트할 새 버전이 없습니다">업데이트</button></div>');
    }
    notesCard.ov.addEventListener('click', (e) => { if (e.target.closest('[data-ap="install"]') && pending) { notesCard.hide(); install(pending); } });

    // 로그인 안내: 같은 종류를 사용자가 닫으면 다시 띄우지 않음
    let loginKind = null, loginDismissed = null, loginOpen = false, wait = null;
    /**
     * 로그인 완료 기다리기(주기 확인) 중단.
     * wait 타이머를 멈추고 비운다.
     * @returns {void}
     */
    const stopWait = () => { clearInterval(wait); wait = null; };
    /**
     * 로그인 카드의 연결 상태 줄 문구 바꾸기.
     * 카드 안에 .ap-conn 이 있을 때만 클래스와 글자를 갈아 끼운다.
     * @param {string} text 보일 문구
     * @param {string} [cls] 더할 클래스 (예: "err")
     * @returns {void}
     */
    const setConn = (text, cls) => { const el = loginCard.ov.querySelector('.ap-conn'); if (el) { el.className = 'ap-conn' + (cls ? ' ' + cls : ''); el.textContent = text; } };
    /**
     * 로그인 안내 카드 열기·닫기.
     * 알 수 없는 종류(null 포함)면 닫힘 기록을 지우고 열려 있으면 닫는다. 같은 종류를 사용자가 이미 닫았거나 이미 떠 있으면 다시 띄우지 않는다.
     * 새로 열 때 종류별 안내문(LOGIN)으로 본문을 채우고, 닫히면 완료 대기를 멈추며 그 종류를 닫힘으로 기억한다.
     * @param {LoginKind} kind 안내 종류
     * @returns {void}
     */
    function showLogin(kind) {
      const g = LOGIN[kind];
      if (!g) { loginDismissed = null; if (loginOpen) { loginOpen = false; stopWait(); loginCard.hide(); } return; }
      if (loginDismissed === kind || (loginOpen && loginKind === kind)) return;
      loginKind = kind; loginOpen = true;
      loginCard.open(g.title, `<p class="ap-lead">${esc(g.lead)}</p><ol class="ap-steps">${g.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
        <div class="ap-conn"></div>
        <div class="ap-btns"><button class="ap-btn" data-ap="help">설치 안내 열기</button><button class="ap-btn" data-ap="retry">다시 확인</button><button class="ap-btn pri" data-ap="login">Claude Code 로그인</button></div>`,
      () => { loginOpen = false; loginDismissed = loginKind; stopWait(); });
    }
    /**
     * 로그인 카드 단추 처리.
     * help = 설치 안내 페이지 열기. retry = get_plan(force) 로 다시 확인해 plan 이 오면 안내를 닫고 onPlanRefreshed 로 알린다.
     * login = 새 콘솔에서 claude 로그인을 띄우고 자격 증명 파일 표식(cred_stamp)이 바뀌면 바로, 아니면 15초마다 get_plan 으로 확인한다 (2초 간격 점검, 최대 5분).
     * @param {MouseEvent} e 클릭 이벤트 (data-ap 단추 위임)
     * @returns {Promise<void>}
     * @see open_url, get_plan, cred_stamp, claude_login, showLogin, setConn
     */
    loginCard.ov.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ap]');
      if (!b || !invoke) return;
      if (b.dataset.ap === 'help') invoke('open_url', { url: 'https://claude.ai/download' }).catch((er) => toast(String(er)));
      if (b.dataset.ap === 'retry') {
        setConn('확인 중…');
        const snap = await invoke('get_plan', { force: true }).catch(() => null);
        if (snap && snap.plan) { toast('연결되었습니다'); showLogin(null); o.onPlanRefreshed && o.onPlanRefreshed(snap); } else setConn((snap && snap.error) || '아직 로그인 정보를 찾지 못했습니다.', 'err');
      }
      if (b.dataset.ap === 'login') {
        // 새 콘솔에서 claude auth login → 자격 증명 파일이 바뀌면 바로 확인 (최대 5분, 15초마다는 직접 조회)
        let base = await invoke('cred_stamp').catch(() => null);
        try { await invoke('claude_login'); } catch (er) { setConn(String(er) === 'not_installed' ? 'Claude Code 가 설치되어 있지 않습니다 — 먼저 설치하세요.' : '실행 실패: ' + er, 'err'); return; }
        setConn('브라우저에서 로그인을 마치세요… 끝나면 저절로 연결됩니다.');
        stopWait();
        const t0 = Date.now();
        let last = t0, checking = false;
        wait = setInterval(async () => {
          if (!loginOpen || Date.now() - t0 > 5 * 60e3) return stopWait();
          if (checking) return;
          const st = await invoke('cred_stamp').catch(() => null);
          if (st === base && Date.now() - last < 15e3) return;
          base = st; last = Date.now(); checking = true;
          const snap = await invoke('get_plan', { force: true }).catch(() => null);
          checking = false;
          if (snap && snap.plan) { stopWait(); toast('로그인되었습니다'); showLogin(null); o.onPlanRefreshed && o.onPlanRefreshed(snap); }
        }, 2000);
      }
    });

    // ── 알림 읽음: 오피스가 앞에 있고 최근 알림 카드가 펼쳐져 있으면 읽음 (트레이 숫자 배지 해제) ──
    /**
     * 알림 읽음 처리.
     * 사무실 창이 앞에 있고 최근 알림 카드가 펼쳐져 있으며 안 읽은 알림이 있을 때만 mark_alerts_read 를 불러 트레이 숫자 배지를 푼다.
     * @param {AlertEntry[]} list 알림 기록
     * @returns {void}
     * @see mark_alerts_read
     */
    const onAlerts = (list) => {
      if (invoke && document.hasFocus() && o.alertsVisible && o.alertsVisible() && (list || []).some((e) => !e.read)) invoke('mark_alerts_read').catch(() => {});
    };
    window.addEventListener('focus', () => o.lastAlerts && onAlerts(o.lastAlerts()));

    if (invoke) {
      invoke('get_update').then(showUpdate, () => {});
      /**
       * 설치 직후 변경 내역 가져와 안내 카드 띄우기.
       * 앱이 저장해 둔 내역을 한 번 꺼내(take) 있으면 showWhatsNew 로 보인다.
       * @returns {Promise<void>}
       * @see take_update_notes, showWhatsNew
       */
      const takeNotes = () => invoke('take_update_notes').then((u) => u && showWhatsNew(u), () => {});
      takeNotes();
      if (listen) {
        listen('update', (e) => showUpdate(e.payload));
        listen('update_notes', takeNotes);
      }
    }
    /**
     * start 의 공개 함수 묶음.
     * onAlertsShown() = 마지막 알림 목록으로 읽음 처리 재시도. onPlan(snap) = plan 이 있으면 로그인 안내 닫기, 없으면 error_kind 에 맞는 안내 열기(snap 이 없으면 아무것도 안 함). onAlerts = 위의 읽음 처리.
     * @returns {{onAlertsShown: function(): void, onPlan: function(PlanSnap): void, onAlerts: function(AlertEntry[]): void}}
     * @see showLogin, onAlerts
     */
    return { onAlertsShown: () => o.lastAlerts && onAlerts(o.lastAlerts()), onPlan: (snap) => snap && (snap.plan ? showLogin(null) : showLogin(snap.error_kind)), onAlerts };
  }
  /**
   * 모듈 공개 API.
   * @returns {{start: function(OfficeAppOptions): Object}}
   */
  return { start };
})();
