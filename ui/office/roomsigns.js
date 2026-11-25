/**
 * @file 방 표지판 (OfficeRoomSigns): 사무실 각 방(구역) 바닥 가까이에 "이름 · 용도" 표지를 띄운다.
 * 3D 위치를 화면 좌표로 바꿔 HTML 글자를 얹는 방식(고양이 말풍선과 같음) — 글자가 선명하고 한/영 전환이 쉽다.
 * 멀리서 볼 때(카메라 반경이 클 때)만 보이고, 고양이를 가까이 볼 때는 흐려져 사라진다(말풍선·고양이를 가리지 않게).
 * 방 위치는 openoffice.js 의 건물 배치(왼쪽 날개 업무실, 본관 회의실·로비·라운지, 오른쪽 날개 서재·카페, 중정, 공원)를 따른다.
 * 공개 API: OfficeRoomSigns.start({ scene, camera, stage }) → { update() }.
 * 전역 의존: BABYLON, t (i18n.js).
 */
'use strict';

const OfficeRoomSigns = (() => {
  /**
   * 방 목록: [i18n 키, x, z]. 표지는 바닥(y 0.05) 위치를 기준으로 화면에 얹는다.
   * 좌표는 openoffice.js 의 구역 경계 안쪽, 통로·문 앞을 피한 곳.
   * @type {Array<[string, number, number]>}
   */
  const ROOMS = [
    ['work', 4.3, 9.0], // 왼쪽 날개 업무실 x[0,8.6] z[0,18]
    ['meetA', 3.1, 21.2], // 회의실 A x[0,6.1] z[20.2,28]
    ['meetB', 9.05, 21.2], // 회의실 B x[6.1,12]
    ['lobby', 16.4, 20.4], // 로비·대표실 x[12,20.8] z[18,28]
    ['lounge', 26.3, 21.4], // 라운지 x[20.8,32] z[20.2,28]
    ['cafe', 27.8, 15.6], // 카페 x[23.6,32] z[8.3,18]
    ['library', 27.8, 1.6], // 서재 x[23.6,32] z[0,8.3]
    ['court', 18.6, 14.6], // 중정 (연못 북동쪽 물 위, 잔교·결재 줄과 떨어진 자리)
    ['park', -7.2, -11.2], // 공원 (연못 x-7.2 z-7.5 남쪽)
  ];
  /** 보이기 시작하는 카메라 반경(이보다 가까우면 숨김) / 완전히 보이는 반경. */
  const FADE_NEAR = 14, FADE_FULL = 20;

  /**
   * 표지 스타일을 문서에 한 번만 넣는다 (office.css 를 건드리지 않고 이 모듈 안에 둠).
   * @returns {void}
   */
  function injectStyle() {
    if (document.getElementById('roomSignStyle')) return;
    const st = document.createElement('style');
    st.id = 'roomSignStyle';
    st.textContent = `
      .room-signs { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
      .room-sign { position: absolute; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center;
        padding: 3px 9px 4px; border-radius: 8px; background: rgba(248, 248, 249, .7); color: #4b505c; white-space: nowrap;
        border: 1px solid rgba(31, 36, 48, .08); box-shadow: 0 1px 3px rgba(31, 36, 48, .06); transition: opacity .25s;
        font-family: "Pretendard", system-ui, sans-serif; }
      .room-sign b { font-size: 11.5px; font-weight: 600; line-height: 1.3; }
      .room-sign small { font-size: 9.5px; color: #8a8f9a; line-height: 1.25; }`;
    document.head.appendChild(st);
  }

  /**
   * 표지판을 만들고 매 프레임 위치를 맞추는 객체를 돌려준다.
   * 표지 층은 말풍선 층(#bubbles) 바로 앞에 넣어 말풍선·위젯이 표지를 덮게 한다.
   * @param {{scene: BABYLON.Scene, camera: BABYLON.ArcRotateCamera, stage: HTMLElement}} o 장면·카메라·표지를 얹을 요소(#stage)
   * @returns {{update: function(): void}} update 를 렌더 루프에서 부른다
   */
  function start(o) {
    injectStyle();
    const layer = document.createElement('div');
    layer.className = 'room-signs';
    layer.setAttribute('aria-hidden', 'true');
    const stage = o.stage || document.body, bubbles = document.getElementById('bubbles');
    if (bubbles && bubbles.parentNode === stage) stage.insertBefore(layer, bubbles); else stage.appendChild(layer);
    const items = ROOMS.map(([key, x, z]) => {
      const el = document.createElement('div');
      el.className = 'room-sign';
      el.append(document.createElement('b'), document.createElement('small'));
      layer.appendChild(el);
      return { key, el, pos: new BABYLON.Vector3(x, 0.05, z) };
    });
    /**
     * 현재 언어로 표지 글자를 채운다 (언어가 바뀌면 다시).
     * @returns {void}
     */
    const fill = () => {
      for (const it of items) {
        it.el.firstChild.textContent = typeof t === 'function' ? t(`room.${it.key}`) : it.key;
        it.el.lastChild.textContent = typeof t === 'function' ? t(`room.${it.key}.use`) : '';
      }
    };
    fill();
    window.addEventListener('meow-lang', fill);
    let lastOpacity = -1;
    /**
     * 표지 위치·투명도 갱신. 카메라가 가까우면 숨기고, 화면 밖·카메라 뒤면 감춘다.
     * @returns {void}
     */
    function update() {
      const r = o.camera.radius;
      const op = Math.max(0, Math.min(1, (r - FADE_NEAR) / (FADE_FULL - FADE_NEAR)));
      if (op !== lastOpacity) { layer.style.opacity = String(op); layer.style.display = op > 0 ? '' : 'none'; lastOpacity = op; }
      if (op <= 0) return;
      const w = layer.clientWidth, h = layer.clientHeight;
      const vp = o.camera.viewport.toGlobal(w, h), tm = o.scene.getTransformMatrix();
      for (const it of items) {
        const p = BABYLON.Vector3.Project(it.pos, BABYLON.Matrix.Identity(), tm, vp);
        const vis = p.z > 0 && p.z < 1 && p.x > -60 && p.y > -30 && p.x < w + 60 && p.y < h + 30;
        it.el.style.display = vis ? '' : 'none';
        if (vis) { it.el.style.left = `${p.x.toFixed(1)}px`; it.el.style.top = `${p.y.toFixed(1)}px`; }
      }
    }
    return { update };
  }

  return { start };
})();
