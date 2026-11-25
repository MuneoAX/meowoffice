/**
 * @file 공통 로딩 표시 (OfficeLoading): 고양이 발자국이 한 걸음씩 찍히며 걸어가는 애니메이션.
 * 시간이 걸리는 일(대화 만들기, 새 고양이 출근, 업데이트 확인, 내역 불러오기 등)을 기다리는 동안 어디서나 같은 모양으로 쓴다.
 * 쓰는 법은 네 가지다.
 *   - OfficeLoading.el(text, opts)             발자국 + 글자 요소 하나를 만들어 준다 (본문 안에 직접 넣을 때: "불러오는 중…" 자리)
 *   - OfficeLoading.cover(target, text, opts)  target 위를 반투명으로 덮고 가운데에 띄운다 → { done() } (창·카드·화면 전체)
 *   - OfficeLoading.wrap(promise, target, text, opts)  promise 가 끝날 때까지 cover. 금방 끝나면(기본 180ms 안) 아예 안 띄운다 → 같은 promise
 *   - OfficeLoading.button(btn, promise)       단추를 누른 일이 끝날 때까지 단추를 잠그고 안에 작은 발자국을 돌린다 → 같은 promise
 * 모양은 office.css 의 .paw-load* 규칙. 색은 currentColor 를 따르므로 놓인 곳의 글자색을 쓴다(덮개에서는 브랜드 색).
 * 전역 의존: 없음 (DOM 만).
 */
'use strict';

const OfficeLoading = (() => {
  // 발바닥 하나 (발가락 넷 + 볼록살). 새 대화 단추의 발바닥과 같은 모양
  const PAW = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="4.6" cy="10.4" rx="2.3" ry="3"/><ellipse cx="9.4" cy="5.6" rx="2.4" ry="3.2"/><ellipse cx="14.8" cy="5.6" rx="2.4" ry="3.2"/><ellipse cx="19.6" cy="10.4" rx="2.3" ry="3"/><path d="M12.1 10.8c-3.4 0-6.3 3.3-6.3 6.3 0 2.2 1.7 3.5 3.7 3.5 1 0 1.7-.5 2.6-.5s1.6.5 2.6.5c2 0 3.7-1.3 3.7-3.5 0-3-2.9-6.3-6.3-6.3z"/></g></svg>';
  /**
   * 발자국 + 글자 요소를 만든다.
   * @param {string} [text] 곁에 적을 글자 (없으면 발자국만)
   * @param {{size?: 'sm'|'md'|'lg', steps?: number}} [opts] 크기(기본 md)·발자국 수(기본 4)
   * @returns {HTMLElement} .paw-load 요소 (role=status)
   */
  function el(text, opts = {}) {
    const box = document.createElement('div');
    box.className = 'paw-load ' + (opts.size || 'md');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const track = document.createElement('div');
    track.className = 'paw-load-t';
    const n = opts.steps || 4;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'paw-load-p ' + (i % 2 ? 'r' : 'l'); // 왼발·오른발 번갈아
      p.style.animationDelay = (i * 0.22).toFixed(2) + 's';
      p.style.animationDuration = (n * 0.22 + 0.5).toFixed(2) + 's';
      p.innerHTML = PAW;
      track.appendChild(p);
    }
    box.appendChild(track);
    if (text) { const s = document.createElement('span'); s.className = 'paw-load-x'; s.textContent = text; box.appendChild(s); }
    return box;
  }
  /**
   * target 위를 덮는 로딩 표시를 띄운다.
   * @param {HTMLElement} target 덮을 요소 (position 이 static 이면 relative 로 바꿔 둔다)
   * @param {string} [text] 글자
   * @param {{size?: 'sm'|'md'|'lg', dim?: boolean}} [opts] 크기, dim=false 면 바탕을 가리지 않는다
   * @returns {{done: function(): void, el: HTMLElement}} done() 을 부르면 사라진다 (여러 번 불러도 됨)
   */
  function cover(target, text, opts = {}) {
    const ov = document.createElement('div');
    ov.className = 'paw-cover' + (opts.dim === false ? ' clear' : '');
    ov.appendChild(el(text, { size: opts.size || 'lg' }));
    if (target && getComputedStyle(target).position === 'static') target.style.position = 'relative';
    (target || document.body).appendChild(ov);
    let gone = false;
    return {
      el: ov,
      done() {
        if (gone) return;
        gone = true;
        ov.classList.add('out');
        setTimeout(() => ov.remove(), 180);
      },
    };
  }
  /**
   * promise 가 끝날 때까지 target 을 덮는다. delay 안에 끝나면 띄우지 않는다(깜박임 방지).
   * @template T
   * @param {Promise<T>} promise 기다릴 일
   * @param {HTMLElement} target 덮을 요소
   * @param {string} [text] 글자
   * @param {{delay?: number, size?: 'sm'|'md'|'lg', dim?: boolean}} [opts] delay 기본 180ms
   * @returns {Promise<T>} 같은 결과·같은 오류를 그대로 넘긴다
   */
  function wrap(promise, target, text, opts = {}) {
    let c = null;
    const timer = setTimeout(() => { c = cover(target, text, opts); }, opts.delay == null ? 180 : opts.delay);
    const end = () => { clearTimeout(timer); if (c) c.done(); };
    return Promise.resolve(promise).then((v) => { end(); return v; }, (e) => { end(); throw e; });
  }
  /**
   * 단추가 시킨 일이 끝날 때까지 단추를 잠그고 안에 작은 발자국을 돌린다.
   * @template T
   * @param {HTMLButtonElement} btn 단추
   * @param {Promise<T>} promise 기다릴 일
   * @returns {Promise<T>} 같은 결과·같은 오류
   */
  function button(btn, promise) {
    const was = btn.disabled;
    btn.disabled = true; btn.classList.add('paw-busy');
    const p = el('', { size: 'sm', steps: 3 });
    btn.appendChild(p);
    const end = () => { p.remove(); btn.classList.remove('paw-busy'); btn.disabled = was; };
    return Promise.resolve(promise).then((v) => { end(); return v; }, (e) => { end(); throw e; });
  }
  return { el, cover, wrap, button };
})();
