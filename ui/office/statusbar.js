/**
 * 사무실 아래 상태 바 (높이 28px, 창 맨 아래).
 * 왼쪽: 시스템 사용률(CPU·메모리·배터리, 앱 명령 sys_stats 를 2초마다)과 화면 그리기 횟수(fps).
 * 오른쪽: 확대 막대 자리(office.js 가 zoomSlot 에 막대를 채운다).
 * 상태 바를 켜면 body 에 has-sb 를 붙여 #stage(3D 화면·위젯)를 그만큼 줄인다 — 위젯·도크·안내가 상태 바와 겹치지 않는다.
 * 공개 API: OfficeStatusBar.init({ scene, onResize }) → { zoomSlot }
 */
const OfficeStatusBar = (() => {
  const POLL_MS = 2000;
  const GB = 1024 ** 3;
  /**
   * 사용률 칸 하나: 이름 + 작은 막대 + 숫자.
   * @param {string} key 칸 이름(data-k)
   * @param {string} label 보이는 이름
   * @returns {string} HTML
   */
  const meter = (key, label, i18nKey) => `<span class="sb-it" data-k="${key}" hidden><em${i18nKey ? ` data-i18n="${i18nKey}"` : ''}>${label}</em><i class="sb-m"><b></b></i><span class="sb-v"></span></span>`;

  /**
   * 칸 값 쓰기. 값이 없으면 칸을 숨긴다.
   * @param {HTMLElement} bar 상태 바
   * @param {string} key 칸 이름
   * @param {?number} pct 막대 비율(0~100, 막대 없는 칸은 null)
   * @param {?string} text 숫자 문구 (null 이면 칸 숨김)
   * @param {string} [title] 툴팁
   * @returns {void}
   */
  function put(bar, key, pct, text, title) {
    const it = bar.querySelector(`.sb-it[data-k="${key}"]`);
    if (!it) return;
    it.hidden = text == null;
    if (text == null) return;
    it.querySelector('.sb-v').textContent = text;
    const m = it.querySelector('.sb-m');
    if (m) {
      m.hidden = pct == null;
      if (pct != null) {
        m.firstChild.style.width = Math.max(2, Math.min(100, pct)) + '%';
        m.dataset.lv = pct >= 92 ? 'hi' : pct >= 80 ? 'mid' : '';
      }
    }
    it.title = title || '';
  }

  /**
   * 상태 바를 만들어 body 맨 아래에 붙이고 측정을 시작한다.
   * @param {{scene: BABYLON.Scene, onResize?: function(): void}} o 장면(그린 횟수 세기용), 화면 크기가 바뀐 뒤 부를 함수(엔진 resize)
   * @returns {{zoomSlot: HTMLElement}} 확대 막대를 넣을 자리
   */
  function init(o) {
    const bar = document.createElement('footer');
    bar.id = 'statusbar';
    bar.innerHTML = `<div class="sb-sys">${meter('cpu', 'CPU')}${meter('mem', t('status.bar.mem'), 'status.bar.mem')}${meter('bat', t('status.bar.bat'), 'status.bar.bat')}<span class="sb-it" data-k="fps" data-i18n-title="status.bar.fpsTip" title="${t('status.bar.fpsTip')}"><em data-i18n="status.bar.screen">${t('status.bar.screen')}</em><span class="sb-v">–</span></span></div><div class="sb-zoom"></div>`;
    document.body.appendChild(bar);
    document.body.classList.add('has-sb');
    if (o.onResize) o.onResize();

    // 화면 그린 횟수: 렌더 루프가 쉬는 동안(움직임 없음)은 일부러 적게 그리므로 실제 그린 횟수를 센다
    let frames = 0, since = performance.now();
    if (o.scene) o.scene.onAfterRenderObservable.add(() => { frames++; });
    /**
     * 1초마다 fps 칸 갱신.
     * @returns {void}
     */
    const fpsTick = () => {
      const now = performance.now();
      const fps = Math.round((frames * 1000) / Math.max(1, now - since));
      frames = 0; since = now;
      put(bar, 'fps', null, `${fps} fps`, t('status.bar.fpsTip'));
    };
    setInterval(() => { if (!document.hidden) fpsTick(); }, 1000);

    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (!inv) return { zoomSlot: bar.querySelector('.sb-zoom') }; // 브라우저 시연: 시스템 칸 없음
    let busy = false;
    /**
     * sys_stats 를 불러 CPU·메모리·배터리 칸을 갱신. 창이 가려졌거나 이전 호출이 안 끝났으면 건너뛴다.
     * @returns {Promise<void>}
     */
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const s = await inv('sys_stats');
        put(bar, 'cpu', s.cpu, s.cpu == null ? null : `${Math.round(s.cpu)}%`, t('status.bar.cpuTip'));
        if (s.memTotal) {
          const p = (100 * s.memUsed) / s.memTotal;
          put(bar, 'mem', p, `${Math.round(p)}%`, t('status.bar.memTip', { used: (s.memUsed / GB).toFixed(1), total: (s.memTotal / GB).toFixed(1) }));
        } else put(bar, 'mem', null, null);
        if (s.battery != null) {
          put(bar, 'bat', s.battery, `${s.battery}%${s.charging ? ' ⚡' : ''}`, s.charging ? t('status.bar.batCharging') : t('status.bar.batTip'));
          const m = bar.querySelector('.sb-it[data-k="bat"] .sb-m');
          m.dataset.lv = s.battery <= 10 ? 'hi' : s.battery <= 20 ? 'mid' : ''; // 배터리는 낮을수록 경고
        } else put(bar, 'bat', null, null);
      } catch (e) {
        // 명령이 없는 옛 앱·일시 실패: 칸만 숨긴다
        put(bar, 'cpu', null, null); put(bar, 'mem', null, null); put(bar, 'bat', null, null);
      } finally { busy = false; }
    };
    poll();
    setInterval(poll, POLL_MS);
    return { zoomSlot: bar.querySelector('.sb-zoom') };
  }

  return { init };
})();
