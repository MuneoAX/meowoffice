/**
 * @file 낮·밤: 컴퓨터 시각에 맞춰 해와 달이 지나가고, 아침·낮·노을·밤 분위기를 조명에 입힌다.
 * - 해 위치: 사무실 위치(meowLocation, 없으면 서울) 기준 간단한 천문 계산(날짜별 적위 + 시간각). 장면 좌표는 +X 동, -Z 남, +Y 위
 * - 달: 해 반대편 하늘(시간각 + 12시간)로 지나간다(위상은 생략)
 * - 그림자 빛(sun)은 해가 떠 있으면 해, 지면 달 쪽에서 비춘다
 * - 밤이면 실내 간접조명: 벽 위 띠 조명 + 바닥에 번지는 불빛(가산 혼합 판)
 * 개발용: ?time=19:30 으로 시각 고정, ?dayspeed=600 으로 600배 빨리
 * 공개 API: OfficeDay.start(scene, opts) → { update(dt), state, sunAt, setWeather(w), flash(k) }, OfficeDay.sunAt(date).
 * 전역 의존: BABYLON, meowLocation (common.js).
 */
/**
 * @typedef {Object} DayState
 * @property {string} phase night | dawn | dusk | day
 * @property {string} label 화면 표시 이름(밤·아침·노을·낮)
 * @property {Date} time 지금 시각(?time·?dayspeed 반영)
 * @property {string} [tz] 사무실 시간대
 * @property {string} [place] 사무실 위치 이름
 * @property {number} night 밤 정도 0~1
 */
/**
 * @typedef {Object} SunPos
 * @property {number} alt 해 고도(라디안)
 * @property {number} az 방위(라디안, 남쪽 0, 서쪽 +)
 * @property {number} H 시간각(라디안)
 * @property {number} decl 태양 적위(라디안)
 */
/**
 * @typedef {Object} LineTop
 * @property {number} x0 시작 x
 * @property {number} x1 끝 x
 * @property {number} z0 시작 z
 * @property {number} z1 끝 z (유리벽 윗선 사각 범위)
 */
/**
 * @typedef {Object} LampPoint
 * @property {number} gx 바닥 x
 * @property {number} gz 바닥 z
 * @property {number} [r] 반지름(없으면 기본 크기)
 */
/**
 * @typedef {Object} OutdoorLights
 * @property {LampPoint[]} street 가로등
 * @property {LampPoint[]} garden 정원등
 * @property {LampPoint[]} up 조명등(위로)
 * @property {LampPoint[]} [tree] 나무 조명
 * @property {Array<[number, number, number]>} [fairy] 꼬마전구 좌표
 * @property {Array<{pts: Array<{x: number, z: number}>, closed: boolean, half: number}>} [lines] 길 라인 조명
 */
/**
 * @typedef {Object} DayOpts
 * @property {BABYLON.DirectionalLight} sun 그림자 빛
 * @property {BABYLON.HemisphericLight} hemi 하늘 반구광
 * @property {*} shadows 그림자 생성기
 * @property {BABYLON.DefaultRenderingPipeline} [pipe] 후처리(노출 조절)
 * @property {BABYLON.Vector3} [center] 장면 중심
 * @property {LineTop[]} [lineTops=[]] 유리벽 윗선 구간
 * @property {number} [lineY=2.8] 라인 조명 높이
 * @property {LampPoint[]} [streetLamps=[]] 예전 가로등 목록
 * @property {OutdoorLights|null} [lights=null] 바깥 조명 묶음
 */
'use strict';

const OfficeDay = (() => {
  const V3 = BABYLON.Vector3, C3 = BABYLON.Color3;
  const RAD = Math.PI / 180;
  /**
   * 사무실 위치(위치: common.js 의 meowLocation, 없으면 서울).
   * @returns {{lat: number, lon: number, tz: string, name?: string}} 위치 (MeowLocation)
   * @see meowLocation (common.js)
   */
  const loc = () => (typeof meowLocation === 'function' ? meowLocation() : { lat: 37.57, lon: 126.98, tz: 'Asia/Seoul' });
  /**
   * 그 시간대의 날짜·시각과 UTC 와의 차(시간).
   * Intl.DateTimeFormat 으로 연·월·일·시·분·초를 읽고, 같은 값을 UTC 로 본 시각과 실제 시각의 차로 오프셋(시간)을 구한다.
   * @param {Date} d 시각
   * @param {string} tz IANA 시간대
   * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, offset: number}}
   */
  function partsIn(d, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const o = {};
    for (const p of f.formatToParts(d)) o[p.type] = Number(p.value);
    const asUtc = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second);
    return { ...o, offset: Math.round((asUtc - d.getTime()) / 60000) / 60 };
  }

  /**
   * 날짜 → 해 고도·방위(라디안). 방위는 남쪽 0, 서쪽 +.
   * 연중 일수로 적위, 시간대·경도로 태양시를 구해 시간각을 만들고 구면 삼각법으로 고도·방위를 계산한다(경도 보정 포함).
   * @param {Date} d 시각
   * @returns {SunPos} 해 위치
   * @see loc, partsIn
   */
  function sunAt(d) {
    const L = loc(), p = partsIn(d, L.tz), LAT = L.lat * RAD;
    const N = Math.floor((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 0)) / 86400e3);
    const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + N)) / 365);
    const hours = p.hour + p.minute / 60 + p.second / 3600;
    const solar = hours + (L.lon - p.offset * 15) / 15; // 경도 보정 (예: 서울은 표준시보다 약 32분 늦게 정오)
    const H = (solar - 12) * 15 * RAD;
    const alt = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT));
    return { alt, az, H, decl };
  }
  /**
   * 고도·방위 → 장면 안 방향(하늘 쪽 단위 벡터).
   * @param {number} alt 고도(라디안)
   * @param {number} az 방위(라디안)
   * @returns {BABYLON.Vector3} 단위 벡터
   */
  const dirOf = (alt, az) => new V3(-Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  /**
   * 두 색 사이를 섞는다.
   * k 는 0~1 로 제한.
   * @param {BABYLON.Color3} a 색 A
   * @param {BABYLON.Color3} b 색 B
   * @param {number} k 섞는 비율
   * @returns {BABYLON.Color3}
   */
  const mix = (a, b, k) => C3.Lerp(a, b, Math.max(0, Math.min(1, k)));
  /**
   * smoothstep: e0 이하 0, e1 이상 1, 사이는 부드럽게.
   * @param {number} e0 시작
   * @param {number} e1 끝
   * @param {number} x 값
   * @returns {number} 0~1
   */
  const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  /**
   * "#rrggbb" → Color3.
   * @param {string} h 색 문자열
   * @returns {BABYLON.Color3}
   */
  const hex = (h) => C3.FromHexString(h);

  // 분위기 색 (해 고도 기준): 밤 → 여명·노을 → 낮
  const SKY = { night: hex('#1b2238'), dusk: hex('#e8a07a'), day: hex('#eef0f6') };
  const SUN = { low: hex('#ff9a5a'), day: hex('#fff3e4') };
  const MOON = hex('#9fb4ff');
  const HEMI = { night: hex('#7d89bd'), dusk: hex('#f3c1a4'), day: hex('#fffbf7') };

  /**
   * 낮·밤 시스템을 장면에 붙이고 매 프레임 호출할 update 를 돌려준다.
   * 실내·바깥 불빛 바닥판, 길 라인 조명, 벽 띠 조명, 유리 윗선 조명, 천장 반구광(밤에만)과 해·달 공을 만든다. update(dt) 가 0.5초마다 해·달 위치, 빛 색·세기, 하늘색·안개, 불빛 밝기를 낮/노을/밤 정도로 맞추고 화면 표시용 state 를 갱신한다. 위치가 바뀌면(meow-location·storage) 바로 다시 계산한다.
   * @param {BABYLON.Scene} scene 장면
   * @param {DayOpts} opts 조명·설정 묶음
   * @returns {{update: function(number):DayState, state: DayState, sunAt: function(Date):SunPos, setWeather: function({dim?: number, fog?: number}):void, flash: function(number):void}}
   * @see sunAt, weatherfx.js 의 setWeather · flash 호출
   */
  function start(scene, { sun, hemi, shadows, pipe, center = new V3(16, 0, 12), lineTops = [], lineY = 2.8, streetLamps = [], lights = null }) {
    const params = new URLSearchParams(location.search);
    const fixed = params.get('time');
    const speed = Number(params.get('dayspeed')) || 1;
    const t0 = Date.now();
    /**
     * 장면의 현재 시각.
     * ?time=HH:MM 이면 사무실 시간대의 그 시각으로 고정해 시작하고, ?dayspeed 배수로 빨리 흐르게 한다. 없으면 컴퓨터 시각.
     * @returns {Date} 현재 시각
     */
    const now = () => {
      if (fixed) {
        const [h, m] = fixed.split(':').map(Number);
        const base = new Date(t0), p = partsIn(base, loc().tz);
        const want = base.getTime() - ((p.hour - (h || 0)) * 3600 + (p.minute - (m || 0)) * 60 + p.second) * 1000;
        return new Date(want + (Date.now() - t0) * speed);
      }
      return new Date(t0 + (Date.now() - t0) * speed);
    };

    // 하늘의 해·달 (멀리 떠 있는 빛나는 공)
    /**
     * 하늘의 해·달(멀리 떠 있는 빛나는 공) 메시 만들기.
     * 조명 영향 없는 발광 구. 안개·픽킹 제외.
     * @param {string} name 메시 이름
     * @param {BABYLON.Color3} color 발광색
     * @param {number} r 반지름
     * @returns {BABYLON.Mesh}
     */
    const body = (name, color, r) => {
      const m = BABYLON.MeshBuilder.CreateSphere(name, { diameter: r * 2, segments: 12 }, scene);
      const mt = new BABYLON.StandardMaterial(name + 'M', scene);
      mt.emissiveColor = color; mt.disableLighting = true;
      m.material = mt; m.isPickable = false; m.applyFog = false;
      return m;
    };
    const sunBall = body('sunBall', hex('#ffd27a'), 4);
    const moonBall = body('moonBall', hex('#e8eeff'), 2.6);
    const SKY_R = 140;

    // ── 실내 간접조명 ────────────────────────────────────────
    // 바닥 불빛: 가운데가 밝고 가장자리로 사라지는 원 (가산 혼합)
    const poolTex = new BABYLON.DynamicTexture('poolTex', { width: 128, height: 128 }, scene, true);
    {
      const g = poolTex.getContext();
      const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,214,150,0.9)'); gr.addColorStop(0.35, 'rgba(255,200,135,0.55)'); gr.addColorStop(0.7, 'rgba(255,192,125,0.18)'); gr.addColorStop(1, 'rgba(255,190,120,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128); poolTex.update(); poolTex.hasAlpha = true;
    }
    const poolMat = new BABYLON.StandardMaterial('poolMat', scene);
    poolMat.emissiveTexture = poolTex; poolMat.opacityTexture = poolTex; poolMat.disableLighting = true;
    poolMat.alphaMode = BABYLON.Engine.ALPHA_ADD; poolMat.backFaceCulling = false;
    const POOLS = [
      // 업무실
      [2.55, 3.5, 4.2], [6.35, 3.5, 4.2], [2.55, 8.5, 4.2], [6.35, 8.5, 4.2], [2.55, 13.5, 4.2], [6.35, 13.5, 4.2],
      // 복도(ㄷ자)
      [9.25, 4, 2.2], [9.25, 10, 2.2], [9.25, 16, 2.2], [4, 19.1, 2.4], [10, 19.1, 2.4], [16, 19.1, 2.4], [22, 19.1, 2.4], [28, 19.1, 2.4], [22.85, 4, 2.2], [22.85, 10, 2.2], [22.85, 16, 2.2],
      // 회의실 · 로비 · 라운지
      [3.15, 23.5, 4.5], [9.05, 23.5, 4.5], [16, 24.5, 5.5], [25.6, 25.4, 5], [30.4, 22, 3.5], [25.6, 21.6, 3.2],
      // 서재 · 카페
      [28, 3, 4.5], [24.6, 3, 3], [26.5, 12.5, 4.5], [28.8, 16.1, 3], [24.5, 14, 3.2],
    ];
    const pools = POOLS.map(([x, z, s]) => {
      const p = BABYLON.MeshBuilder.CreateGround('lightPool', { width: s * 1.45, height: s * 1.45 }, scene); // 넓고 은은하게 겹치도록
      p.position.set(x, 0.025, z); p.material = poolMat; p.isPickable = false;
      return p;
    });
    // 바깥 조명 바닥 불빛 (밤에만, 가산 혼합 원). 종류마다 한 메시로 합쳐 그리기 부담을 줄인다
    const L = lights || { street: streetLamps, garden: [], up: [] };
    /**
     * 바깥 조명 바닥 불빛(밤에만, 가산 혼합 원) 메시 하나로 합치기.
     * 종류마다 한 메시로 합쳐 그리기 부담을 줄인다. 처음엔 투명(visibility 0), update 가 밤 정도에 따라 키운다.
     * @param {LampPoint[]} list 조명 위치들
     * @param {number} size 기본 크기
     * @returns {BABYLON.Mesh|null} 합친 메시, 목록이 비면 null
     */
    const poolsOf = (list, size) => {
      if (!list.length) return null;
      const parts = list.map((q) => {
        const g = BABYLON.MeshBuilder.CreateGround('lp', { width: q.r ? (q.r + 0.9) * 2 : size, height: q.r ? (q.r + 0.9) * 2 : size }, scene);
        g.position.set(q.gx, 0.03, q.gz);
        return g;
      });
      const m = BABYLON.Mesh.MergeMeshes(parts, true, true);
      m.name = 'outdoorLightPools'; m.material = poolMat; m.isPickable = false; m.visibility = 0;
      return m;
    };
    const lampPools = [poolsOf(L.street, 4.2), poolsOf(L.garden, 1.7), poolsOf(L.up, 2.4), poolsOf(L.tree || [], 3)];
    const LAMP_K = [0.55, 0.6, 0.5, 0.28];
    // 나무 꼬마전구: 작은 빛나는 알갱이를 한 메시로 (밤에만 켜고 살짝 반짝임)
    let fairy = null;
    if (L.fairy && L.fairy.length) {
      const parts = L.fairy.map(([x, y, z], i) => {
        const b = BABYLON.MeshBuilder.CreateBox('fb', { size: 0.055 }, scene);
        b.position.set(x, y, z); b.rotation.set(i * 0.7, i * 1.3, 0);
        return b;
      });
      fairy = BABYLON.Mesh.MergeMeshes(parts, true, true);
      fairy.name = 'fairyLights'; fairy.isPickable = false;
      const fm = new BABYLON.StandardMaterial('fairyMat', scene);
      fm.disableLighting = true; fm.emissiveColor = hex('#ffd890');
      fairy.material = fm; fairy.setEnabled(false);
    }
    // 길 라인 조명: 길 바닥 양 가장자리를 따라 가는 빛 줄 + 바닥에 번지는 띠 (가산 혼합)
    const lineGlowTex = new BABYLON.DynamicTexture('lineGlowTex', { width: 4, height: 64 }, scene, true);
    {
      const g = lineGlowTex.getContext();
      const gr = g.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, 'rgba(255,205,140,0)'); gr.addColorStop(0.5, 'rgba(255,214,160,0.95)'); gr.addColorStop(1, 'rgba(255,205,140,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 4, 64); lineGlowTex.update(); lineGlowTex.hasAlpha = true;
    }
    const lineGlowMat = new BABYLON.StandardMaterial('pathLineGlow', scene);
    lineGlowMat.emissiveTexture = lineGlowTex; lineGlowMat.opacityTexture = lineGlowTex; lineGlowMat.disableLighting = true;
    lineGlowMat.alphaMode = BABYLON.Engine.ALPHA_ADD; lineGlowMat.backFaceCulling = false;
    const stripMat = new BABYLON.StandardMaterial('pathLineStrip', scene);
    stripMat.disableLighting = true; stripMat.emissiveColor = hex('#ffe2b0');
    /**
     * 꺾은선을 step 간격으로 촘촘히 (닫힌 줄이면 끝→처음도).
     * @param {Array<{x: number, z: number}>} pts 꼭짓점
     * @param {boolean} closed 닫힌 줄인지
     * @param {number} step 간격
     * @returns {Array<{x: number, z: number}>} 촘촘한 점들
     */
    const resample = (pts, closed, step) => {
      const out = [], n = pts.length, segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n], len = Math.hypot(b.x - a.x, b.z - a.z), k = Math.max(1, Math.ceil(len / step));
        for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, z: a.z + ((b.z - a.z) * j) / k });
      }
      if (!closed) out.push({ x: pts[n - 1].x, z: pts[n - 1].z });
      return out;
    };
    /**
     * 점에서 꺾은선까지의 최단 거리.
     * 각 선분에 수선을 내려 가장 가까운 거리를 취한다.
     * @param {number} x 점 x
     * @param {number} z 점 z
     * @param {Array<{x: number, z: number}>} pts 꼭짓점
     * @param {boolean} closed 닫힌 줄인지
     * @returns {number} 거리
     */
    const distPoly = (x, z, pts, closed) => {
      let d = Infinity; const n = pts.length, segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n], vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
        d = Math.min(d, Math.hypot(x - a.x - vx * t, z - a.z - vz * t));
      }
      return d;
    };
    /**
     * 꺾은선을 옆으로 off 만큼 민 줄 위에 폭 w 띠 메시 만들기.
     * hide(x, z) 가 참인 곳(다른 길 바닥 위)은 끊는다. v: 0~1 가로 텍스처 좌표.
     * @param {Array<{x: number, z: number}>} pts 꼭짓점
     * @param {boolean} closed 닫힌 줄인지
     * @param {number} off 옆으로 민 거리
     * @param {number} w 띠 폭
     * @param {number} y 높이
     * @param {function(number, number):boolean} hide 끊을 곳 판정
     * @returns {BABYLON.Mesh|null} 띠 메시, 이을 구간이 없으면 null
     * @see distPoly
     */
    const band = (pts, closed, off, w, y, hide) => {
      const pos = [], uv = [], idx = [], n = pts.length, keep = [];
      for (let i = 0; i < n; i++) {
        const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const cx = pts[i].x - tz * off, cz = pts[i].z + tx * off;
        keep.push(!hide(cx, cz));
        pos.push(cx + tz * w / 2, y, cz - tx * w / 2, cx - tz * w / 2, y, cz + tx * w / 2);
        uv.push(0, 0, 0, 1);
      }
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) { const j = (i + 1) % n; if (keep[i] && keep[j]) idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1); }
      if (!idx.length) return null;
      const m = new BABYLON.Mesh('pl', scene);
      const vd = new BABYLON.VertexData(); vd.positions = pos; vd.indices = idx; vd.uvs = uv;
      vd.normals = pos.map((_, k) => (k % 3 === 1 ? 1 : 0)); vd.applyToMesh(m);
      return m;
    };
    let lineGlow = null, lineStrip = null;
    if (L.lines && L.lines.length) {
      const g = [], st = [];
      const lines = L.lines.map((ln) => ({ ...ln, fine: resample(ln.pts, ln.closed, 0.25) }));
      lines.forEach((ln, li) => {
        // 다른 길 바닥(가장자리 띠 포함) 위에 오면 끊음: 교차로·합류 지점에서 빛 줄이 길을 가로지르지 않게
        /**
         * 다른 길 바닥(가장자리 띠 포함) 위인지.
         * 교차로·합류 지점에서 빛 줄이 길을 가로지르지 않게 끊는 판정.
         * @param {number} x 점 x
         * @param {number} z 점 z
         * @returns {boolean} 다른 길 위면 true
         * @see distPoly
         */
        const hide = (x, z) => lines.some((o, oi) => oi !== li && distPoly(x, z, o.pts, o.closed) < o.half + 0.18);
        for (const side of [-1, 1]) {
          const gm = band(ln.fine, ln.closed, side * ln.half, 0.5, 0.02, hide);
          const sm = band(ln.fine, ln.closed, side * ln.half, 0.035, 0.026, hide);
          if (gm) g.push(gm); if (sm) st.push(sm);
        }
      });
      lineGlow = BABYLON.Mesh.MergeMeshes(g, true, true); lineGlow.name = 'pathLineGlow'; lineGlow.material = lineGlowMat; lineGlow.isPickable = false; lineGlow.visibility = 0;
      lineStrip = BABYLON.Mesh.MergeMeshes(st, true, true); lineStrip.name = 'pathLineStrip'; lineStrip.material = stripMat; lineStrip.isPickable = false;
    }
    // 벽 위 띠 조명 (높은 벽 안쪽 위 끝)
    const coveMat = new BABYLON.StandardMaterial('coveMat', scene);
    coveMat.disableLighting = true; coveMat.emissiveColor = hex('#ffcf8f');
    const COVES = [[16, 2.62, 27.72, 31.6, 0.05], [31.72, 2.62, 14, 0.05, 27.6]];
    const coves = COVES.map(([x, y, z, w, d]) => {
      const m = BABYLON.MeshBuilder.CreateBox('cove', { width: w, height: 0.05, depth: d }, scene);
      m.position.set(x, y, z); m.material = coveMat; m.isPickable = false;
      return m;
    });
    // 유리벽 윗선을 따라 두른 라인 조명
    const lineMat = new BABYLON.StandardMaterial('lineLightMat', scene);
    lineMat.disableLighting = true; lineMat.emissiveColor = hex('#ffd9a3');
    // 빛 번짐: 위가 밝고 아래로 사라지는 세로 띠 (가산 혼합), 유리 양면
    const washTex = new BABYLON.DynamicTexture('washTex', { width: 8, height: 128 }, scene, true);
    {
      const g = washTex.getContext();
      const gr = g.createLinearGradient(0, 0, 0, 128);
      gr.addColorStop(0, 'rgba(255,214,160,0.95)'); gr.addColorStop(0.25, 'rgba(255,205,150,0.45)'); gr.addColorStop(1, 'rgba(255,200,140,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 8, 128); washTex.update(); washTex.hasAlpha = true;
    }
    const washMat = new BABYLON.StandardMaterial('washMat', scene);
    washMat.emissiveTexture = washTex; washMat.opacityTexture = washTex; washMat.disableLighting = true;
    washMat.alphaMode = BABYLON.Engine.ALPHA_ADD; washMat.backFaceCulling = false;
    const WASH_H = 1.1;
    const washes = [];
    const lines = lineTops.map((w) => {
      const along = w.x1 - w.x0 > w.z1 - w.z0;
      const len = along ? w.x1 - w.x0 : w.z1 - w.z0;
      // 유리 윗선 바로 아래에 붙은 등 (아래를 비추는 납작한 띠)
      const m = BABYLON.MeshBuilder.CreateBox('lineLight', { width: along ? len : 0.06, height: 0.03, depth: along ? 0.06 : len }, scene);
      m.position.set((w.x0 + w.x1) / 2, lineY - 0.075, (w.z0 + w.z1) / 2);
      m.material = lineMat; m.isPickable = false;
      for (const side of [-1, 1]) {
        const p = BABYLON.MeshBuilder.CreatePlane('lineWash', { width: len, height: WASH_H, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        p.position.set((w.x0 + w.x1) / 2 + (along ? 0 : side * 0.035), lineY - 0.09 - WASH_H / 2, (w.z0 + w.z1) / 2 + (along ? side * 0.035 : 0));
        if (!along) p.rotation.y = Math.PI / 2;
        p.material = washMat; p.isPickable = false;
        washes.push(p);
      }
      return m;
    });
    // 밤에 켜지는 실내 천장 조명: 위에서 아래로 내리비추는 반구광 (책상·바닥·고양이 머리 윗면이 밝고, 옆면은 은은하게)
    const indoor = new BABYLON.HemisphericLight('indoorCeiling', new V3(0, 1, 0), scene);
    indoor.diffuse = hex('#fff1dc'); indoor.groundColor = hex('#7a6a58'); indoor.specular = hex('#2a2620');
    indoor.intensity = 0;
    // 바깥 땅·길·나무·가로등에는 비추지 않음 (가구는 원점에 있는 원본의 인스턴스라 위치로 거르지 않고 바깥 것만 뺀다)
    const OUT = /^(ground|path|lawn|road|fCourt|loop|cloop|con|conE|pier|plank|post|canopy|mat$|tpl:pond|tpl:fountain|fountainJet|coping|tpl:tree|tpl:pine|tpl:bush|tpl:rock|tpl:flowers|tpl:bench|tpl:statue|tpl:lantern|tpl:streetLamp|tpl:gardenLight|tpl:upLight|outdoorLightPools|tpl:mound|tpl:bigTree)/i; // 천장 조명은 실내만 (길·잔교·정문 차양 등 바깥은 뺀다)
    indoor.excludedMeshes = scene.meshes.filter((m) => OUT.test(m.name));

    const state = { phase: '', label: '', time: new Date(), night: 0 };
    let acc = 1;
    // 날씨 (weatherfx.js): dim 0~1 = 구름으로 햇빛·하늘이 어두워진 정도, fog 0~1 = 안개, flash 0~1 = 번개
    const wx = { dim: 0, fog: 0, flash: 0 };
    const GRAY = hex('#9aa3b0');
    /**
     * 낮·밤 갱신(매 프레임 호출, 0.5초마다만 실제 계산).
     * 해 고도에서 낮·노을·밤 정도를 구하고, 해·달 위치와 그림자 빛(해 → 지면 달), 하늘빛·배경색·안개·노출, 실내외 불빛 밝기를 맞춘다. 날씨(wx: dim·fog·flash) 영향을 곱해 반영하고 state 를 채운다.
     * @param {number} dt 지난 시간(초)
     * @returns {DayState} state (같은 객체)
     * @see sunAt, partsIn, setWeather, flash
     */
    function update(dt) {
      acc += dt;
      if (acc < 0.5) return state; // 2번/초면 충분
      acc = 0;
      const d = now();
      const s = sunAt(d);
      const altD = s.alt / RAD;
      // 낮 정도: 고도 -6° 이하 0 → 10° 이상 1. 노을 정도: 해가 낮게 걸린 정도
      const day = smooth(-6, 10, altD);
      const low = Math.max(0, 1 - Math.abs(altD - 2) / 10) * (altD > -6 ? 1 : 0);
      const night = 1 - smooth(-10, -2, altD);
      // 해·달 위치
      const sd = dirOf(s.alt, s.az);
      sunBall.position.copyFrom(center.add(sd.scale(SKY_R)));
      sunBall.isVisible = s.alt > -0.05;
      const mAlt = -s.alt * 0.9 + 0.12, mAz = s.az + Math.PI; // 해 반대편 하늘
      const md = dirOf(mAlt, mAz);
      moonBall.position.copyFrom(center.add(md.scale(SKY_R)));
      moonBall.isVisible = mAlt > -0.05;
      // 그림자 빛: 해 → (해 지면) 달
      const key = s.alt > -0.03 ? sd : md;
      const keyAlt = Math.max(0.18, key.y); // 너무 눕지 않게 (그림자가 끝없이 길어짐)
      const kd = new V3(key.x, keyAlt, key.z).normalize();
      sun.direction = kd.scale(-1);
      sun.position = center.add(kd.scale(40));
      if (s.alt > -0.03) {
        sun.diffuse = mix(SUN.low, SUN.day, smooth(2, 20, altD));
        sun.intensity = (0.15 + 0.5 * day) * (1 - 0.7 * wx.dim);
      } else {
        sun.diffuse = MOON;
        sun.intensity = 0.4 * night * (1 - 0.6 * wx.dim); // 달빛 (그림자도 달 쪽으로), 구름 끼면 약하게
      }
      // 하늘빛·배경색
      hemi.diffuse = night > 0.5 ? mix(HEMI.dusk, HEMI.night, (night - 0.5) * 2) : mix(HEMI.dusk, HEMI.day, day);
      hemi.diffuse = mix(hemi.diffuse, HEMI.dusk, low * 0.6);
      hemi.intensity = (0.4 + 0.4 * day + 0.06 * low + 0.14 * night) * (1 - 0.18 * wx.dim) + 1.6 * wx.flash; // 밤하늘 밝기(달빛 반사) · 번개
      hemi.groundColor = mix(hex('#2a2f45'), hex('#b8adb3'), day);
      const sky = mix(mix(SKY.night, SKY.dusk, smooth(-10, -1, altD)), SKY.day, day);
      const skyC = mix(mix(sky, SKY.dusk, low * 0.7), mix(GRAY, sky, night * 0.7), wx.dim * 0.65);
      scene.clearColor = new BABYLON.Color4(...skyC.asArray(), 1);
      if (wx.fog > 0.01) {
        scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogDensity = 0.006 + 0.03 * wx.fog;
        scene.fogColor = skyC;
      } else scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
      if (pipe) pipe.imageProcessing.exposure = 0.88 + 0.04 * night;
      // 실내 간접조명
      for (const p of pools) p.visibility = 0.32 * night + 0.06 * low;
      lampPools.forEach((p, i) => { if (!p) return; p.visibility = (LAMP_K[i] || 0.55) * night + 0.1 * low; }); // 바깥 등은 해 질 녘부터 켜짐
      const lit = Math.max(night, low * 0.5);
      if (fairy) { fairy.setEnabled(lit > 0.15); fairy.material.emissiveColor = hex('#ffd890').scale(0.6 + 0.4 * lit); }
      if (lineGlow) lineGlow.visibility = 0.3 * night + 0.06 * low;
      if (lineStrip) {
        // 꺼진 줄을 어둡게 남기면 바닥에 검은 선으로 보인다 → 불이 꺼지면 투명하게 사라지고, 다 꺼지면 그리지 않는다
        const k = Math.min(1, lit / 0.25);
        lineStrip.setEnabled(k > 0.01);
        lineStrip.visibility = k;
        stripMat.emissiveColor = hex('#ffe2b0').scale(0.5 + 0.5 * lit);
      }
      coveMat.emissiveColor = hex('#ffcf8f').scale(0.25 + 0.75 * night);
      lineMat.emissiveColor = hex('#ffd9a3').scale(0.35 + 0.65 * Math.max(night, low * 0.6));
      for (const p of washes) p.visibility = 0.45 * night + 0.12 * low;
      indoor.intensity = 0.9 * night + 0.1 * low; // 밤에 천장 조명 켜짐 (해 질 녘부터 조금씩)
      // 화면 표시용
      const h = partsIn(d, loc().tz).hour;
      state.phase = night > 0.6 ? 'night' : low > 0.35 ? (h < 12 ? 'dawn' : 'dusk') : 'day';
      state.label = t('world.phase.' + state.phase);
      state.time = d;
      state.tz = loc().tz;
      state.place = loc().name;
      state.night = night;
      return state;
    }
    update(1);
    // 위치를 바꾸면 바로 다시 계산 (같은 창: meow-location, 다른 창: storage)
    /**
     * 위치가 바뀌었을 때 바로 다시 계산.
     * @returns {void}
     * @see update
     */
    const again = () => { acc = 1; update(0); };
    window.addEventListener('meow-location', again);
    window.addEventListener('storage', (e) => { if (e.key === 'meow.location') again(); });
    /**
     * 날씨(구름·안개)를 반영하고 바로 다시 계산.
     * @param {{dim?: number, fog?: number}} w 구름 어두움·안개 0~1 (weatherfx.js 가 넘김)
     * @returns {void}
     * @see update
     */
    function setWeather(w) { wx.dim = w.dim || 0; wx.fog = w.fog || 0; again(); }
    /**
     * 번개 밝기 반영(변화가 0.02 미만이면 무시).
     * @param {number} k 번개 밝기 0~1
     * @returns {void}
     * @see update
     */
    function flash(k) { if (Math.abs(k - wx.flash) < 0.02) return; wx.flash = k; again(); }
    return { update, state, sunAt, setWeather, flash };
  }

  /**
   * 공개 API 묶음.
   * start(scene, opts) · sunAt(date).
   * @returns {{start: function, sunAt: function}}
   */
  return { start, sunAt };
})();
