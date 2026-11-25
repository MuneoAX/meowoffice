/**
 * @file 시작 연출 (OfficeIntro). 고양이들이 패러글라이더를 타고 하늘에서 내려와 제자리에 착지한다.
 * 날개 = 위로 둥글게 휜 칸 나뉜 천(윗면 서비스 색, 아랫면 연한 파랑) + 줄 + 윗면 정중앙 서비스 로고.
 * 로고 = models/logos/<서비스>.svg(없으면 .png) 를 흰 원 위에, 파일이 없으면 색 원 + 간단한 무늬(임시). 착지하면 날개가 접히며 사라지고 고양이는 살짝 뛴다.
 * 머리 위 서비스 동전(coin) 도 여기서 만든다 (위치·회전은 office.js 가 매 프레임 맞춘다).
 *
 * 공개 API: OfficeIntro.start(scene, cats, opts) → IntroRun · OfficeIntro.coin(scene, provider) → BABYLON.TransformNode
 * 의존: BABYLON, 전역 OfficeSound(있을 때만, 착지 소리)
 */
// 시작 연출: 고양이들이 패러글라이더를 타고 하늘에서 내려와 제자리에 착지한다.
// - 날개: 위로 둥글게 휜 칸 나뉜 천(윗면 서비스 색, 아랫면 연한 파랑) + 줄 + 윗면 정중앙에 서비스 로고
// - 로고: models/logos/<서비스>.svg(또는 .png) 가 있으면 그 그림을 흰 원 위에, 없으면 색 원 + 간단한 무늬(임시)
// - 착지하면 날개가 접히며 사라지고 고양이는 살짝 뛴다. 모두 내려오면 done.
'use strict';

/**
 * @typedef {("claude"|"chatgpt"|"antigravity")} Provider 서비스 이름. 날개·동전 색과 로고 표를 고르는 열쇠이며 모르는 값은 claude 로 본다
 */

/**
 * @typedef {Object} Wing 패러글라이더 하나
 * @property {BABYLON.TransformNode} root 날개 전체의 부모 노드 (고양이 뿌리에 붙임)
 * @property {BABYLON.Mesh[]} meshes 천 칸·아랫면·줄·로고 메시 (그림자 등록·클릭 제외에 씀)
 */

/**
 * @typedef {Object} Flight 고양이 한 마리의 낙하 상태
 * @property {Cat} cat 내려오는 고양이
 * @property {BABYLON.Vector3} base 착지할 자리
 * @property {number} h 지금 높이(m)
 * @property {number} h0 처음 높이(m)
 * @property {?Wing} w 날개 (접혀 사라지면 null)
 * @property {BABYLON.Vector3} drift 바람에 밀려 들어오는 처음 어긋남 (높이에 비례해 줄어듦)
 * @property {number} phase 흔들림 위상
 * @property {number} speed 내려오는 속도(m/s)
 * @property {boolean} landed 착지했는지
 * @property {number} fold 날개 접힘 정도 0~1
 */

/**
 * @typedef {Object} IntroRun 진행 중인 시작 연출
 * @property {boolean} done 모두 착지하고 날개가 사라졌는지
 * @property {function(number): void} tick 지난 시간(초)만큼 진행
 */

/**
 * 시작 연출 모듈 (즉시 실행 함수로 감싼 전역 객체).
 * 재질 캐시(mats)를 안쪽에 두고 start·coin 만 내보낸다.
 * @returns {{start: function(BABYLON.Scene, Cat[], Object=): IntroRun, coin: function(BABYLON.Scene, Provider=): BABYLON.TransformNode}} 공개 API
 */
const OfficeIntro = (() => {
  const V3 = BABYLON.Vector3;
  // 서비스별 날개 색 (윗면). 고양이에 provider 가 없으면 claude
  const WING = { claude: '#e8915a', chatgpt: '#3fae8c', antigravity: '#5b8def' };
  const UNDER = '#7aa2f0';
  const LOGO_DIR = 'models/logos/';

  const mats = new Map();
  /**
   * 색 재질 하나 만들기 (같은 key 는 재사용).
   * 캐시(mats)에 있으면 그대로 돌려준다. 없으면 확산색 hex, 약한 반사의 StandardMaterial 을 만들고 shared 표시를 달아 캐시한다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} key 캐시 열쇠
   * @param {string} hex 확산색 (#rrggbb)
   * @returns {BABYLON.StandardMaterial} 재질
   */
  function color(scene, key, hex) {
    if (mats.has(key)) return mats.get(key);
    const m = new BABYLON.StandardMaterial('intro_' + key, scene);
    m.diffuseColor = BABYLON.Color3.FromHexString(hex);
    m.specularColor = new BABYLON.Color3(0.12, 0.12, 0.12);
    m.metadata = { shared: true };
    mats.set(key, m);
    return m;
  }

  /**
   * 로고 재질: 그림 파일이 있으면 쓰고, 없으면 캔버스로 임시 로고.
   * 256 칸 동적 텍스처에 흰 원 + 서비스 색 원 + 무늬(안티그래비티 별, ChatGPT 꽃잎, 그 외 방사형)를 먼저 그려 즉시 쓸 수 있게 한다.
   * 그 뒤 models/logos 의 svg → png 순으로 불러 성공하면 흰 원 위에 가로세로 비율을 지켜 다시 그린다. 조명과 상관없이 색 그대로(emissive).
   * @param {BABYLON.Scene} scene 장면
   * @param {Provider} provider 서비스 이름
   * @returns {BABYLON.StandardMaterial} 로고 재질 (key = logo_서비스, 캐시됨)
   */
  function logo(scene, provider) {
    const key = 'logo_' + provider;
    if (mats.has(key)) return mats.get(key);
    const m = new BABYLON.StandardMaterial('intro_' + key, scene);
    m.specularColor = BABYLON.Color3.Black();
    m.backFaceCulling = false;
    const S = 256;
    const dyn = new BABYLON.DynamicTexture('logoDyn_' + provider, { width: S, height: S }, scene, true);
    const g = dyn.getContext();
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.48, 0, Math.PI * 2); g.fill();
    g.fillStyle = WING[provider] || WING.claude;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.42, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineCap = 'round';
    if (provider === 'antigravity') {
      // 네 갈래 별
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? S * 0.07 : S * 0.3;
        g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
      }
      g.closePath(); g.fill();
    } else if (provider === 'chatgpt') {
      g.lineWidth = S * 0.05;
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.beginPath(); g.ellipse(S / 2 + Math.cos(a) * S * 0.08, S / 2 + Math.sin(a) * S * 0.08, S * 0.2, S * 0.09, a, 0, Math.PI * 2); g.stroke(); }
    } else {
      // 방사형 별무늬
      g.lineWidth = S * 0.055;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, r0 = S * 0.07, r1 = S * (i % 2 ? 0.27 : 0.33);
        g.beginPath(); g.moveTo(S / 2 + Math.cos(a) * r0, S / 2 + Math.sin(a) * r0); g.lineTo(S / 2 + Math.cos(a) * r1, S / 2 + Math.sin(a) * r1); g.stroke();
      }
    }
    dyn.update();
    dyn.hasAlpha = true;
    m.diffuseTexture = dyn;
    m.emissiveTexture = dyn; // 조명·그림자와 상관없이 로고 색 그대로
    m.disableLighting = true;
    m.useAlphaFromDiffuseTexture = true;
    // 로고 파일(svg 먼저, 없으면 png)이 있으면 흰 원 위에 다시 그린다 (날개 색과 겹쳐도 잘 보이게)
    /**
     * 불러온 로고 그림을 흰 원 위에 다시 그리기.
     * 캔버스를 비우고 흰 원을 칠한 뒤, 그림을 66% 상자 안에 가로세로 비율대로 가운데 맞춰 그리고 텍스처를 갱신한다.
     * @param {HTMLImageElement} img 불러온 로고 그림
     * @returns {void}
     */
    const draw = (img) => {
      g.clearRect(0, 0, S, S);
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(S / 2, S / 2, S * 0.48, 0, Math.PI * 2); g.fill();
      // 가로세로 비율 유지 (글자형 로고처럼 넓은 그림도 찌그러지지 않게)
      const box = S * 0.66, r = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const w = r >= 1 ? box : box * r, h = r >= 1 ? box / r : box;
      g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      dyn.update();
    };
    /**
     * 로고 파일을 확장자 순서대로 불러보기.
     * 성공하면 draw, 실패하면 다음 확장자로 재귀한다. 목록이 비면 임시 로고를 그대로 쓴다.
     * @param {string[]} exts 시도할 확장자 목록 (예: ["svg","png"])
     * @returns {void}
     * @see draw
     */
    const tryLoad = (exts) => {
      if (!exts.length) return;
      const img = new Image();
      img.onload = () => draw(img);
      img.onerror = () => tryLoad(exts.slice(1));
      img.src = LOGO_DIR + provider + '.' + exts[0];
    };
    tryLoad(['svg', 'png']);
    m.metadata = { shared: true };
    mats.set(key, m);
    return m;
  }

  /**
   * 두 점 사이를 잇는 가는 줄(원기둥) 만들기.
   * 길이·중간점으로 원기둥을 놓고, 위쪽 축에서 방향 벡터로 가는 회전축·각도를 구해 회전시킨다.
   * @param {BABYLON.Scene} scene 장면
   * @param {BABYLON.Vector3} a 시작점
   * @param {BABYLON.Vector3} b 끝점
   * @param {BABYLON.TransformNode} parent 붙일 부모
   * @param {BABYLON.Material} mat 재질
   * @returns {BABYLON.Mesh} 줄 메시
   */
  function line(scene, a, b, parent, mat) {
    const d = b.subtract(a), len = d.length();
    const c = BABYLON.MeshBuilder.CreateCylinder('gLine', { height: len, diameter: 0.008, tessellation: 3 }, scene);
    c.material = mat;
    c.parent = parent;
    c.position = a.add(d.scale(0.5));
    const up = new V3(0, 1, 0), dir = d.normalize();
    const axis = V3.Cross(up, dir);
    const ang = Math.acos(Math.max(-1, Math.min(1, V3.Dot(up, dir))));
    if (axis.lengthSquared() > 1e-8) c.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis.normalize(), ang);
    return c;
  }

  /**
   * 패러글라이더 하나 (고양이 등 높이 harnessY 에 줄이 모인다).
   * 7 칸의 납작한 구를 반지름 1.15 의 호 위에 겹쳐 놓고 칸마다 아랫면 판과 앞·뒤 줄을 단다. 윗면 정중앙에 서비스 로고 원판을 얹는다.
   * 모든 메시는 클릭 대상에서 제외한다.
   * @param {BABYLON.Scene} scene 장면
   * @param {Provider} provider 서비스 이름 (날개 윗면 색)
   * @param {number} harnessY 줄이 모이는 높이(고양이 뿌리 기준, m)
   * @returns {Wing} 날개 노드와 메시 목록
   * @see color, logo, line
   */
  function wing(scene, provider, harnessY) {
    const root = new BABYLON.TransformNode('glider', scene);
    const top = color(scene, 'wing_' + provider, WING[provider] || WING.claude);
    const under = color(scene, 'under', UNDER);
    const rope = color(scene, 'rope', '#f4efe6');
    const N = 7, R = 1.15, span = 1.1, Y0 = harnessY + 1.75; // 칸 수, 휜 반지름, 반 각도(rad), 날개 꼭대기 높이
    const meshes = [];
    const harness = new V3(0, harnessY, 0);
    for (let i = 0; i < N; i++) {
      const th = -span + (2 * span * i) / (N - 1);
      const x = R * Math.sin(th), y = Y0 + R * Math.cos(th) - R;
      const cell = BABYLON.MeshBuilder.CreateSphere('cell', { diameter: 1, segments: 8 }, scene);
      cell.scaling.set(0.5, 0.2, 0.72); // 옆 칸과 겹치게 (칸 사이 틈 없이)
      cell.position.set(x, y, 0);
      cell.rotation.z = -th;
      cell.material = top;
      cell.parent = root;
      const bot = BABYLON.MeshBuilder.CreateBox('cellUnder', { width: 0.44, height: 0.02, depth: 0.64 }, scene);
      bot.position.set(x - Math.sin(th) * 0.05, y - Math.cos(th) * 0.05, 0); // 칸 안쪽 아랫면 (밑에서 볼 때만 보임)
      bot.rotation.z = -th;
      bot.material = under;
      bot.parent = root;
      meshes.push(cell, bot);
      // 줄: 칸 아랫면 앞·뒤에서 고양이 등으로
      if (i % 2 === 0 || i === N - 1) {
        for (const zz of [-0.18, 0.18]) meshes.push(line(scene, new V3(x - Math.sin(th) * 0.08, y - Math.cos(th) * 0.08, zz), harness, root, rope));
      }
    }
    // 로고: 윗면 정중앙
    const disc = BABYLON.MeshBuilder.CreateDisc('logo', { radius: 0.17, tessellation: 28, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.scaling.x = -1; // 위에서 볼 때 좌우가 뒤집혀 보여서 바로잡음 (글자형 로고)
    disc.position.set(0, Y0 + 0.103, 0);
    disc.material = logo(scene, provider);
    disc.parent = root;
    meshes.push(disc);
    for (const m of meshes) m.isPickable = false;
    return { root, meshes };
  }

  /**
   * 시작 연출.
   * cats: 이미 제자리에 놓인 고양이들. 고양이마다 날개를 달고 7~15m 위·남서쪽 바람에서 시작해 내려오게 한다. 내려오는 동안 held 로 목덜미 잡힌 자세를 쓴다.
   * opts.shadows: 그림자 생성기 (날개 그림자). 반환 api.tick(dt) 를 매 프레임 부르면 낙하 → 착지(폴짝·소리) → 날개 접기 순으로 진행하고, 모두 끝나면 api.done = true.
   * @param {BABYLON.Scene} scene 장면
   * @param {Cat[]} cats 내려올 고양이들
   * @param {{shadows: BABYLON.ShadowGenerator}} [opts={}] 옵션
   * @returns {IntroRun} { tick(dt), done }
   * @see wing, OfficeSound.play
   */
  function start(scene, cats, opts = {}) {
    const flights = cats.map((cat, i) => {
      const base = cat.root.position.clone();
      const h0 = 7 + Math.random() * 6 + (i % 4) * 0.8;
      const w = wing(scene, cat.provider || 'claude', 0.42);
      w.root.parent = cat.root;
      if (opts.shadows) w.meshes.forEach((m) => opts.shadows.addShadowCaster(m));
      // 바람 따라 남서쪽에서 미끄러져 들어온다
      const drift = new V3(-2.2 - Math.random(), 0, 1.6 + Math.random());
      cat.held = true; // 날개에 매달려 내려오는 동안: 목덜미 잡혀 들린 것과 같은 축 늘어진 자세 (catmodel.js LIMP)
      return { cat, base, h: h0, h0, w, drift, phase: Math.random() * 6, speed: 1.7 + Math.random() * 0.5, landed: false, fold: 0 };
    });
    const api = {
      done: false,
      /**
       * 연출 한 걸음 진행.
       * 아직 안 내려온 고양이는 높이를 줄이며 바람 흔들림을 주고, 닿으면 원래 자세·위치로 돌려 폴짝(hopT)과 기쁜 소리를 낸다.
       * 내려온 고양이의 날개는 납작해지며 뒤로 넘어가 사라진다. 움직일 것이 하나도 없으면 done = true.
       * @param {number} dt 지난 시간(초)
       * @returns {void}
       */
      tick(dt) {
        let busy = false;
        for (const f of flights) {
          const r = f.cat.root;
          if (!f.landed) {
            f.h = Math.max(0, f.h - f.speed * dt);
            f.phase += dt;
            const k = f.h / f.h0;
            r.position.set(f.base.x + f.drift.x * k, f.base.y + f.h, f.base.z + f.drift.z * k);
            r.rotation.z = Math.sin(f.phase * 1.4) * 0.1 * k; // 바람에 살짝 흔들림
            if (f.h <= 0) {
              f.landed = true;
              f.cat.held = false; // 착지: 원래 자세로
              r.position.copyFrom(f.base);
              r.rotation.z = 0;
              f.cat.hopT = 0.3; // 착지하며 폴짝
              if (typeof OfficeSound !== 'undefined') OfficeSound.play('happy', f.cat.breed);
            }
            busy = true;
          } else if (f.w) {
            // 날개 접기: 납작해지며 뒤로 넘어가 사라짐
            f.fold = Math.min(1, f.fold + dt * 1.8);
            f.w.root.scaling.set(1 - f.fold * 0.6, 1 - f.fold * 0.9, 1 - f.fold * 0.6);
            f.w.root.rotation.x = f.fold * 1.2;
            if (f.fold >= 1) {
              if (opts.shadows) f.w.meshes.forEach((m) => opts.shadows.removeShadowCaster(m));
              f.w.root.dispose();
              f.w = null;
            } else busy = true;
          }
        }
        if (!busy) api.done = true;
      },
    };
    return api;
  }

  // ── 머리 위 상태 알약 ─────────────────────────────────────
  // 장면 위 라벨은 무채색(방 표지판과 같은 계열): 연회색 반투명 바탕·회색 글자·옅은 테두리. 상태 구분은 문구로 한다
  const PILL_BG = 'rgba(248,248,249,0.72)', PILL_FG = '#4b505c', PILL_LINE = 'rgba(31,36,48,0.08)';
  const PILL_H = 0.17; // 알약 높이(m, 배율 1)
  const PILL_MAX_W = 1.3; // 알약 전체 폭 상한(m, 확대 적용 후) — 고양이 간격보다 좁게
  const COIN_R = 0.125; // 동전 반지름(m, 배율 1)
  const PILL_PX = 96; // 알약 텍스처 높이(칸)
  const pillCache = new Map(); // 문구|분류 → { mat, w } (텍스처는 문구 종류만큼만 만들고 고양이끼리 나눠 쓴다)
  let measureCtx = null;
  /**
   * 상태 알약 재질: 무채색 둥근 막대 바탕에 회색 글자. 같은 문구·분류는 한 번만 그린다.
   * 왼쪽 끝은 동전이 덮으므로 동전 반지름만큼 글자를 오른쪽으로 민다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} txt 문구
   * @param {string} cls 분류 (OfficeStatus 의 busy | idle | wait | perm | done | err | off)
   * @returns {{mat: BABYLON.StandardMaterial, w: number}} 재질과 알약 가로 길이(m, 배율 1)
   */
  function pillMat(scene, txt, cls) {
    const key = txt + '|' + cls;
    const hit = pillCache.get(key);
    if (hit) return hit;
    const H = PILL_PX, font = `700 ${Math.round(H * 0.52)}px Pretendard, "Malgun Gothic", system-ui, sans-serif`;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const padL = Math.round((COIN_R / PILL_H) * H) + Math.round(H * 0.16), padR = Math.round(H * 0.38);
    const W = Math.ceil(padL + measureCtx.measureText(txt).width + padR);
    const dyn = new BABYLON.DynamicTexture('pillDyn_' + key, { width: W, height: H }, scene, true);
    const g = dyn.getContext();
    g.clearRect(0, 0, W, H);
    g.fillStyle = PILL_BG;
    g.beginPath(); g.moveTo(H / 2, 2); g.lineTo(W - H / 2, 2); g.arc(W - H / 2, H / 2, H / 2 - 2, -Math.PI / 2, Math.PI / 2); g.lineTo(H / 2, H - 2); g.arc(H / 2, H / 2, H / 2 - 2, Math.PI / 2, Math.PI * 1.5); g.closePath(); g.fill();
    g.strokeStyle = PILL_LINE; g.lineWidth = 3; g.stroke();
    g.font = font; g.textBaseline = 'middle'; g.fillStyle = PILL_FG;
    g.fillText(txt, padL, H / 2 + 3);
    dyn.update();
    dyn.hasAlpha = true;
    const m = new BABYLON.StandardMaterial('intro_pill_' + key, scene);
    m.diffuseTexture = dyn; m.emissiveTexture = dyn; m.opacityTexture = dyn;
    m.disableLighting = true;
    m.specularColor = BABYLON.Color3.Black();
    m.backFaceCulling = false;
    m.metadata = { shared: true };
    const r = { mat: m, w: (W / H) * PILL_H };
    pillCache.set(key, r);
    return r;
  }

  /**
   * 머리 위 서비스 동전과 상태 알약.
   * 동전(얇은 원기둥 테두리 + 앞뒤 원판 로고)은 제자리에서 돌고, 그 뒤쪽 한 장짜리 빌보드 판이 동전 오른쪽으로 가로로 늘어나며 현재 하는 일을 글자로 보여 준다.
   * 상태 문구가 바뀌면 알약이 줄어들었다가 새 문구로 다시 늘어난다. 텍스처는 문구가 처음 나올 때만 그린다(pillMat).
   * 카메라가 멀수록 전체를 키워 멀리서도 읽히게 한다. 모든 메시는 클릭 대상에서 제외한다.
   * 반환 노드의 update(dt, anchor, view, spin, label) 를 매 프레임 office.js 가 부른다.
   * @param {BABYLON.Scene} scene 장면
   * @param {Provider} provider 서비스 이름
   * @returns {BABYLON.TransformNode} 동전 노드 (update 메서드가 붙어 있다)
   * @see color, logo, pillMat, office.js placeCoins
   */
  function coin(scene, provider) {
    const node = new BABYLON.TransformNode('coin', scene);
    const spinner = new BABYLON.TransformNode('coinSpin', scene);
    spinner.parent = node;
    const rim = BABYLON.MeshBuilder.CreateCylinder('coinRim', { height: 0.035, diameter: COIN_R * 2, tessellation: 24 }, scene);
    rim.rotation.x = Math.PI / 2;
    rim.material = color(scene, 'coin_' + provider, WING[provider] || WING.claude);
    rim.parent = spinner;
    for (const side of [-1, 1]) {
      const f = BABYLON.MeshBuilder.CreateDisc('coinFace', { radius: 0.105, tessellation: 24 }, scene);
      f.material = logo(scene, provider);
      f.position.z = side * 0.019;
      if (side < 0) f.rotation.y = Math.PI; // 앞뒤 모두 바깥을 보게
      f.parent = spinner;
    }
    const pill = BABYLON.MeshBuilder.CreatePlane('coinPill', { width: 1, height: PILL_H }, scene);
    pill.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    pill.parent = node;
    pill.setEnabled(false);
    for (const m of node.getChildMeshes()) m.isPickable = false;

    let shown = null, k = 0, w = 1; // 지금 보이는 문구 열쇠, 늘어난 정도 0~1, 알약 가로(m)
    /**
     * 한 프레임 진행: 위치·크기·회전·알약 늘어남을 맞춘다.
     * @param {number} dt 지난 시간(초)
     * @param {BABYLON.Vector3} anchor 고양이 머리 위 기준점(월드)
     * @param {{pos: BABYLON.Vector3, right: BABYLON.Vector3, fwd: BABYLON.Vector3}} view 카메라 위치·오른쪽·앞 방향
     * @param {number} spin 동전 회전각(라디안)
     * @param {?[string, string]} label [문구, 분류] (없으면 알약을 접는다)
     * @returns {number} 동전·알약 위쪽 끝의 월드 높이 (말풍선이 그 위에 놓이게)
     */
    node.update = (dt, anchor, view, spin, label) => {
      // 멀수록 키우되 상한 1.8배, 알약 전체 폭(동전 포함)이 책상 무리 고양이 간격(약 1.47m)을 넘지 않게 눌러 서로 덮지 않게 한다
      const wide = pill.isEnabled() ? w + COIN_R : COIN_R * 2;
      const s = Math.max(0.8, Math.min(1.8, Math.max(1, BABYLON.Vector3.Distance(view.pos, anchor) / 10), PILL_MAX_W / wide));
      const lift = 0.06 + COIN_R * s;
      node.scaling.setAll(s);
      node.position.set(anchor.x, anchor.y + lift, anchor.z);
      spinner.rotation.y = spin;
      const key = label ? label[0] + '|' + label[1] : null;
      if (key !== shown) {
        k = Math.max(0, k - dt * 7); // 먼저 줄어든다
        if (k <= 0.001) {
          shown = key;
          if (label) { const r = pillMat(scene, label[0], label[1]); pill.material = r.mat; w = r.w; }
        }
      } else if (key) k = Math.min(1, k + dt * 4.5);
      const e = k * k * (3 - 2 * k);
      pill.setEnabled(e > 0.01);
      if (e > 0.01) {
        pill.scaling.x = w * e;
        // 왼쪽 끝은 동전 한가운데에 두고 오른쪽(카메라 기준)으로 늘린다. 판은 동전 뒤쪽으로 조금 밀어 동전이 늘 앞에 보이게
        pill.position.set(view.right.x * w * e / 2 + view.fwd.x * 0.04, view.right.y * w * e / 2 + view.fwd.y * 0.04, view.right.z * w * e / 2 + view.fwd.z * 0.04);
      }
      return anchor.y + lift + COIN_R * s;
    };
    return node;
  }

  return { start, coin };
})();
