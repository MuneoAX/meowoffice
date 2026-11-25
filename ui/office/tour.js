/**
 * @file 처음 사용자 안내 (OfficeTour). 기획: docs/ONBOARDING_HINTS.md
 * 화면 가운데 환영 배너 → 영역 하나만 밝게 남기는 스포트라이트 말풍선 4단계 → 큰 마우스 조작 안내 순서로 보여 준다.
 * 처음 한 번 office.js 가 저절로 시작하고 위쪽 [?] 메뉴에서 다시 볼 수 있다. 끝내거나 건너뛰면 localStorage office.tour = done.
 *
 * 공개 API: OfficeTour.start(opts) · OfficeTour.seen() · OfficeTour.isOpen()
 * 의존: window.__office (office.js 개발용 핸들: engine·scene·camera·cats·demo·tourFocus), BABYLON
 */
// 처음 사용자 안내 (기획: docs/ONBOARDING_HINTS.md)
// - 0: 화면 가운데 환영 배너
// - 1~4: 영역 하나를 밝게 남기고 나머지는 어둡게(스포트라이트) + 말풍선 설명
// - 5: 화면 가운데 큰 마우스 조작 안내
// 처음 한 번 저절로(착지 연출이 끝난 뒤), 위쪽 [?] 메뉴에서 다시 보기. 끝내거나 건너뛰면 office.tour = done
'use strict';

/**
 * @typedef {Object} TourStep 안내 한 단계
 * @property {boolean} [hero] 가운데 환영 카드(로고 표시)
 * @property {(string|function(): ?DOMRect)} [target] 밝힐 곳: CSS 선택자 또는 DOMRect 를 돌려주는 함수. 없으면 가운데 카드
 * @property {boolean} [track] 고양이 한 마리를 카메라로 따라가며 밝힘 (없으면 고양이 사진)
 * @property {boolean} [controls] 마우스 조작 표를 본문에 넣음
 * @property {string} title 제목
 * @property {string} text 본문 (HTML 허용: br·b)
 * @property {string} [next] 다음 단추 글자 (기본: 마지막이면 시작하기, 아니면 다음)
 */

/**
 * @typedef {Object} TourOptions OfficeTour.start 옵션
 * @property {function(): void} [onEnd] 안내가 끝나거나 건너뛰었을 때 부를 함수
 */

/**
 * 처음 사용자 안내 모듈 (즉시 실행 함수로 감싼 전역 객체).
 * 상태(root·hole·card·idx·onEnd·trackId·side·raf·release)는 안쪽 변수로 두고 start·seen·isOpen 만 내보낸다.
 * @returns {{start: function(TourOptions=): void, seen: function(): boolean, isOpen: function(): boolean}} 공개 API
 */
const OfficeTour = (() => {
  const KEY = 'office.tour';
  /**
   * HTML 에 끼워 넣을 문자열 이스케이프.
   * null·undefined 는 빈 문자열, & < > " 따옴표 를 엔티티로 바꾼다.
   * @param {*} s 원본 값
   * @returns {string} 안전한 문자열
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /**
   * 마우스 그림 SVG 만들기.
   * 본체 윤곽에 가운데 줄을 긋고, btn 에 따라 왼쪽·오른쪽 버튼 또는 휠을 채워 눌린 곳을 보인다.
   * @param {("L"|"R"|"W"|string)} btn 눌린 곳 (왼쪽 · 오른쪽 · 휠, 그 외는 표시 없음)
   * @returns {string} <svg> 마크업
   */
  const MOUSE = (btn) => `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v7" stroke="currentColor" stroke-width="1.6"/>${btn === 'L' ? '<path d="M12 3.8a5.2 5.2 0 0 0-5.2 5.2V10H12Z" fill="currentColor"/>' : btn === 'R' ? '<path d="M12 3.8a5.2 5.2 0 0 1 5.2 5.2V10H12Z" fill="currentColor"/>' : btn === 'W' ? '<rect x="10.9" y="5.5" width="2.2" height="4" rx="1.1" fill="currentColor"/>' : ''}</svg>`;
  const CONTROLS = [
    ['L', 'tour.mouse.click.b', 'tour.mouse.click.d'],
    ['L', 'tour.mouse.drag.b', 'tour.mouse.drag.d'],
    ['L', 'tour.mouse.pan.b', 'tour.mouse.pan.d'],
    ['R', 'tour.mouse.rot.b', 'tour.mouse.rot.d'],
    ['W', 'tour.mouse.wheel.b', 'tour.mouse.wheel.d'],
  ];

  // 단계: target = 밝힐 곳(선택자 또는 함수 → DOMRect), 없으면 가운데 카드
  const STEPS = [
    {
      hero: true,
      title: 'tour.welcome.title',
      text: 'tour.welcome.text',
      next: 'tour.welcome.next',
    },
    {
      target: () => catRect(),
      track: true, // 고른 고양이 한 마리를 따라감, 없으면 고양이 사진
      title: 'tour.cat.title',
      text: 'tour.cat.text',
    },
    {
      target: '.wg[data-id="cats"]', // 옮겨도 따라가도록 카드 기준
      title: 'tour.cats.title',
      text: 'tour.cats.text',
    },
    {
      target: () => rectOf('#hud .h-q') || rectOf('.topbar'),
      title: 'tour.permit.title',
      text: 'tour.permit.text',
    },
    {
      target: '.wg[data-id="over"]',
      title: 'tour.over.title',
      text: 'tour.over.text',
    },
    {
      controls: true,
      title: 'tour.ctl.title',
      text: 'tour.ctl.text',
      next: 'tour.ctl.next',
    },
  ];

  let root = null, hole = null, card = null, idx = 0, onEnd = null;
  let trackId = null, side = null, raf = 0, release = null; // 따라가는 고양이 · 말풍선 쪽(단계마다 고정) · 매 프레임 갱신 · 카메라 되돌리기

  /**
   * 선택자로 찾은 요소의 화면 사각형.
   * 요소가 없거나 숨겨졌거나 크기가 0 이면 null.
   * @param {string} sel CSS 선택자
   * @returns {?DOMRect} 뷰포트 기준 사각형
   */
  function rectOf(sel) {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }
  // 고양이 한 마리를 골라 카메라를 확대해 계속 따라감(자리에 앉은 고양이 먼저), 없으면 null → 고양이 사진
  const CAT_BOX = 120;
  /**
   * 고양이의 월드 좌표를 화면(CSS 픽셀) 좌표로 투영.
   * 고양이 뿌리 위치에서 up 만큼 위 지점을 카메라 변환으로 캔버스 위치로 바꾼 뒤, 캔버스의 화면 위치와 크기 비율을 반영한다.
   * 위에 있는 CAT_BOX 는 스포트라이트 상자의 최소 크기(120)이다.
   * @param {Object} o window.__office 핸들 ({engine: BABYLON.Engine, scene: BABYLON.Scene, camera: BABYLON.ArcRotateCamera})
   * @param {Cat} c 고양이
   * @param {number} [up=0.45] 뿌리에서 올릴 높이(m). 0.45 몸통, 1.3 머리, 0 발
   * @returns {{x: number, y: number}} 화면 좌표(px)
   */
  function catPoint(o, c, up = 0.45) {
    const w = o.engine.getRenderWidth(), h = o.engine.getRenderHeight();
    const cv = o.engine.getRenderingCanvas().getBoundingClientRect();
    const p = BABYLON.Vector3.Project(c.root.position.add(new BABYLON.Vector3(0, up, 0)), BABYLON.Matrix.Identity(), o.scene.getTransformMatrix(), o.camera.viewport.toGlobal(w, h));
    return { x: cv.left + p.x * cv.width / w, y: cv.top + p.y * cv.height / h };
  }
  /**
   * 따라가던 고양이 놓아 주기.
   * 카메라 되돌리기 함수(release)가 있으면 호출해 원래 화각으로 부드럽게 돌려보내고 trackId 를 비운다.
   * @returns {void}
   * @see OfficeTour tourFocus (office.js)
   */
  function letGo() { if (release) { release(); release = null; } trackId = null; }
  /**
   * 화면 좌표가 위젯에 가려지는지 검사.
   * 화면 가장자리(고양이 상자 절반 + 여유)에 너무 가깝거나, 현황·업무·알림 카드·위쪽 막대·선택된 카드(.wg.sel)·상태 바 사각형(여유 포함) 안에 있으면 가려진 것으로 본다.
   * @param {number} x 화면 x(px)
   * @param {number} y 화면 y(px)
   * @returns {boolean} 가려지면 true
   */
  function covered(x, y) {
    const m = CAT_BOX / 2 + 10;
    if (x < m || y < m || x > innerWidth - m || y > innerHeight - m) return true;
    for (const sel of ['.wg[data-id="over"]', '.wg[data-id="cats"]', '.wg[data-id="alerts"]', '.topbar', '.wg.sel', '#statusbar']) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width && x > r.left - m && x < r.right + m && y > r.top - m && y < r.bottom + m) return true;
    }
    return false;
  }
  /**
   * 스포트라이트로 밝힐 고양이 사각형 계산 (고양이 따라가기 단계의 target).
   * 지금 따라가는 고양이가 없거나 가려졌으면(카메라로 따라가는 중이면 가려져도 유지) 새로 고른다: 자리에 앉은 고양이를 우선, 화면 가운데에 가까운 순. 고른 뒤 tourFocus 로 카메라를 확대해 따라가기 시작한다.
   * 사각형 크기는 화면에 보이는 고양이 키(머리~발)에 맞춰 120~300px 으로 정한다. 고를 고양이가 없으면 null (고양이 사진으로 대신).
   * @returns {?DOMRect} 밝힐 사각형 (없으면 null)
   * @see catPoint, covered, letGo, window.__office.tourFocus
   */
  function catRect() {
    const o = window.__office;
    if (!o || !o.cats || !o.cats.length) return null;
    let c = trackId && o.cats.find((k) => k.id === trackId), pt = c && catPoint(o, c);
    if (!c || (!release && covered(pt.x, pt.y))) { // 카메라로 따라가는 중이면 가려져도 그대로
      // 새로 고르기: 자리에 앉은 고양이 → 아무 고양이, 화면 가운데에 가까운 순
      const seated = new Set(((o.demo && o.demo.agents) || []).filter((a) => a.at === a.desk && !a.cat.landing).map((a) => a.cat.id));
      let best = null;
      for (const k of o.cats) {
        if (k.landing || k.held) continue;
        const q = catPoint(o, k);
        if (covered(q.x, q.y)) continue;
        const d = Math.hypot(q.x - innerWidth / 2, q.y - innerHeight / 2) - (seated.has(k.id) ? 10000 : 0);
        if (!best || d < best.d) best = { k, q, d };
      }
      if (!best) { letGo(); return null; }
      letGo();
      trackId = best.k.id; c = best.k; pt = best.q;
      if (o.tourFocus) release = o.tourFocus(trackId);
    }
    // 크기: 화면에 보이는 고양이 키에 맞춤 (확대되는 동안 같이 커짐)
    const hd = catPoint(o, c, 1.3), ft = catPoint(o, c, 0); // 귀 끝까지
    const box = Math.max(CAT_BOX, Math.min(300, Math.abs(ft.y - hd.y) * 1.9));
    const cy = (hd.y + ft.y) / 2;
    return new DOMRect(pt.x - box / 2, cy - box / 2, box, box);
  }

  /**
   * 안내 오버레이 DOM 만들기.
   * 어둡게 덮는 구멍(.tour-hole)과 카드(.tour-card)를 body 에 붙이고, 단추 클릭·키 입력·창 크기 변경 처리를 연결한다.
   * @returns {void}
   * @see onKey, place, go, end
   */
  function build() {
    root = document.createElement('div');
    root.className = 'tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `<div class="tour-hole"><div class="tour-pic" hidden></div></div><div class="tour-card" role="document"></div>`;
    hole = root.querySelector('.tour-hole');
    card = root.querySelector('.tour-card');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'next') go(idx + 1);
      else if (b.dataset.t === 'prev') go(idx - 1);
      else end();
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    document.body.appendChild(root);
  }
  /**
   * 안내 키보드 조작.
   * Esc = 끝내기, 오른쪽 화살표·Enter = 다음, 왼쪽 화살표 = 이전.
   * @param {KeyboardEvent} e 키 이벤트
   * @returns {void}
   */
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') go(idx + 1);
    else if (e.key === 'ArrowLeft') go(idx - 1);
  }

  /**
   * 현재 단계(idx)의 카드 내용 그리기.
   * 진행 점·제목·본문·단추를 채우고(조작 단계면 마우스 표), 따라가던 고양이는 놓은 뒤 말풍선 쪽을 다시 정한다.
   * track 단계면 requestAnimationFrame 으로 매 프레임 위치를 다시 잡고, 350ms 뒤부터는 track 클래스로 구멍이 바로바로 따라가게 한다.
   * @returns {void}
   * @see place, letGo
   */
  function render() {
    const s = STEPS[idx], last = idx === STEPS.length - 1;
    const dots = STEPS.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('');
    const body = s.controls
      ? `<div class="tour-ctrl">${CONTROLS.map(([m, b, d]) => `<div><i>${MOUSE(m)}</i><b>${esc(t(b))}</b><span>${esc(t(d))}</span></div>`).join('')}</div>`
      : '';
    card.className = 'tour-card' + (s.hero ? ' hero' : '') + (s.controls ? ' wide' : '') + (s.target ? ' spot' : '');
    card.innerHTML = `${s.hero ? '<div class="tour-logo"></div>' : ''}
      <h2>${esc(t(s.title))}</h2><p>${t(s.text)}</p>${body}
      <div class="tour-foot">
        <div class="tour-dots">${dots}</div>
        <div class="tour-btns">
          ${last ? '' : '<button data-t="skip" class="t-skip">' + t('tour.skip') + '</button>'}
          ${idx > 0 && !last ? '<button data-t="prev" class="t-prev">' + t('tour.prev') + '</button>' : ''}
          <button data-t="next" class="t-next">${esc(s.next ? t(s.next) : t(last ? 'tour.start' : 'tour.next'))}</button>
        </div>
      </div>`;
    letGo(); side = null;
    place();
    card.querySelector('.t-next').focus({ preventScroll: true });
    cancelAnimationFrame(raf);
    hole.classList.remove('track');
    if (s.track) {
      const t0 = performance.now();
      /**
       * 고양이 따라가기 단계의 프레임 갱신.
       * 안내가 닫혔거나 단계가 바뀌었으면 멈추고, 아니면 구멍·카드 위치를 다시 잡고 다음 프레임을 예약한다.
       * @returns {void}
       * @see place
       */
      const tick = () => {
        if (!root || !STEPS[idx].track) return;
        if (performance.now() - t0 > 350) hole.classList.add('track'); // 처음 옮겨 간 뒤로는 바로바로 따라감
        place(); raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  }

  // 밝힐 곳과 말풍선 위치
  /**
   * 밝힐 곳(구멍)과 말풍선 카드 위치 정하기.
   * 단계의 target 으로 사각형을 얻는다. track 단계인데 고양이가 없으면 화면 가운데에 고양이 사진을 밝힌다. 사각형이 없으면 구멍 없이 가운데 카드로 전체를 어둡게 한다.
   * 말풍선 쪽은 단계마다 한 번만 정해(오른쪽 → 왼쪽 → 아래 → 위 중 들어가는 쪽) 좌우로 튀지 않게 하고, 화면 안에 들어오게 좌표를 제한한다.
   * @returns {void}
   * @see rectOf, catRect
   */
  function place() {
    if (!root) return;
    const s = STEPS[idx];
    let r = null;
    if (s.target) r = typeof s.target === 'function' ? s.target() : rectOf(s.target);
    // 따라갈 고양이가 없으면 화면 가운데에 고양이 사진을 밝혀 보여 줌
    const pic = hole.firstElementChild, usePic = !!s.track && !r;
    pic.hidden = !usePic;
    hole.classList.toggle('pic', usePic);
    if (usePic) r = new DOMRect(innerWidth / 2 - 260, innerHeight / 2 - 90, 180, 180);
    if (!r) {
      // 가운데 카드: 구멍 없이 전체를 어둡게
      hole.style.cssText = `left:${innerWidth / 2}px;top:${innerHeight / 2}px;width:0;height:0;`;
      card.style.cssText = '';
      card.classList.add('center');
      return;
    }
    card.classList.remove('center');
    const pad = 8;
    hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
    // 말풍선: 오른쪽 → 왼쪽 → 아래 → 위 중 들어가는 쪽
    const cw = 360, ch = card.offsetHeight || 220, m = 18;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 쪽은 단계마다 한 번만 정해 말풍선이 좌우로 튀지 않게 (고양이를 따라가면 결국 화면 가운데에 오므로 가운데 기준)
    if (!side) {
      const q = release ? new DOMRect(innerWidth / 2 - 130, innerHeight / 2 - 130, 260, 260) : r;
      side = q.right + m + cw < innerWidth - 12 ? 'l' : q.left - m - cw > 12 ? 'r' : q.bottom + m + ch < innerHeight - 12 ? 't' : 'b';
    }
    let x, y;
    if (side === 'l') { x = r.right + m; y = cy - ch / 2; }
    else if (side === 'r') { x = r.left - m - cw; y = cy - ch / 2; }
    else if (side === 't') { x = cx - cw / 2; y = r.bottom + m; }
    else { x = cx - cw / 2; y = r.top - m - ch; }
    x = Math.max(12, Math.min(innerWidth - cw - 12, x));
    y = Math.max(12, Math.min(innerHeight - ch - 12, y));
    card.style.cssText = `left:${x}px;top:${y}px;width:${cw}px;`;
    card.dataset.side = side;
  }

  /**
   * 단계 이동.
   * 0 미만이면 무시, 마지막을 넘으면 끝낸다. 아니면 idx 를 바꿔 다시 그린다.
   * @param {number} i 이동할 단계 번호
   * @returns {void}
   * @see render, end
   */
  function go(i) {
    if (i < 0) return;
    if (i >= STEPS.length) { end(); return; }
    idx = i;
    render();
  }
  /**
   * 안내 끝내기.
   * localStorage office.tour = done 으로 기록하고, 프레임 갱신·고양이 따라가기·키/크기 처리를 해제하고 오버레이를 지운 뒤 onEnd 를 부른다.
   * @returns {void}
   */
  function end() {
    try { localStorage.setItem(KEY, 'done'); } catch (e) { /* 무시 */ }
    cancelAnimationFrame(raf);
    letGo();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    if (root) root.remove();
    root = null;
    if (onEnd) onEnd();
  }

  /**
   * 안내 시작 (이미 열려 있으면 처음으로).
   * 오버레이가 없으면 만들고 0단계로 간다.
   * @param {TourOptions} [opts={}] 옵션 (onEnd: 끝날 때 부를 함수)
   * @returns {void}
   * @see build, go
   */
  function start(opts = {}) {
    onEnd = opts.onEnd || null;
    if (!root) build();
    go(0);
  }
  /**
   * 안내를 이미 봤는지.
   * localStorage office.tour 가 done 이면 true. 저장소를 못 쓰면 false.
   * @returns {boolean}
   */
  function seen() { try { return localStorage.getItem(KEY) === 'done'; } catch (e) { return false; } }
  /**
   * 안내가 지금 열려 있는지.
   * @returns {boolean}
   */
  function isOpen() { return !!root; }
  window.addEventListener('meow-lang', () => { if (root) render(); }); // 열려 있는 동안 언어가 바뀌면 현재 단계를 다시 그린다
  return { start, seen, isOpen };
})();
