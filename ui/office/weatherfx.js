/**
 * @file 오피스 날씨 효과: 비·이슬비·뇌우(빗줄기 + 번개), 우박(흰 알갱이가 떨어져 튐 + 번개), 눈, 안개, 흐림(햇빛·하늘 어둡게 — daylight.js setWeather).
 * 빗방울·눈송이는 카메라가 보는 곳 둘레에서만, 지붕 없는 건물 안(본관·양 날개)에는 내리지 않는다 (중정은 바깥이라 내림).
 * 계절(위치의 날짜·남북반구): 봄 연두 / 여름 짙은 초록 + 잔디에 풀 / 가을 단풍 + 낙엽 / 겨울 잎 나무는 가지만, 눈 오면 땅이 하얗게.
 * 0°C 이하면 연못이 얼고 연잎이 사라진다 (frozen() 으로 알림 → 낚시 대신 스케이트). 소나무·덤불은 사계절 그대로.
 * 바람: 평균·순간 풍속이 기준을 넘으면 빗줄기·눈이 기울고, 나무·덤불이 흔들리고, 낙엽(겨울 제외)이 날린다. 순간 풍속이 평균보다 크면 돌풍이 가끔 확 분다.
 * 개발용: ?weather=rain|snow|fog|cloudy|thunder|hail|drizzle|clear  ?season=spring|summer|autumn|winter  ?temp=-3  ?wind=45  ?gust=75 (km/h)
 * 공개 API: OfficeWeatherFx.start(scene, opts) → { apply(weather), season(), frozen() }, OfficeWeatherFx.inBuilding(x, z).
 * 전역 의존: BABYLON, OfficePalette, meowLocation (common.js).
 */
/**
 * @typedef {Object} FxWeather
 * @property {string} kind 날씨 종류 (weather.js 의 WeatherResult.kind: clear|partly|cloudy|fog|drizzle|rain|snow|thunder|hail)
 * @property {number} [temp] 기온(°C)
 * @property {number} [wind] 평균 풍속(km/h)
 * @property {number} [gust] 순간 최대 풍속(km/h)
 */
/**
 * @typedef {Object} GroundDeco
 * @property {Array<[number, number, number, number]>} [grass] 여름 풀 [x, z, 회전, 크기]
 * @property {Array<[number, number, number]>} [leaves] 가을 낙엽 [x, z, 회전]
 */
/**
 * @typedef {Object} WeatherFxOpts
 * @property {BABYLON.ArcRotateCamera} camera 카메라(target·radius 로 내릴 자리 결정)
 * @property {{setWeather: function, flash: function}} [day] 낮·밤 객체(daylight.js 의 start 결과)
 * @property {"low"|"mid"|"high"} [quality="mid"] 화질(입자 수)
 * @property {GroundDeco|null} [ground=null] 바닥 장식 좌표
 */
'use strict';

const OfficeWeatherFx = (() => {
  /** 바람 단계 기준(km/h). 평균 풍속 = 보퍼트 풍력 계급 하한, 순간 풍속 = 한 계급 위 하한(3단계는 기상청 강풍주의보 순간풍속 20 m/s = 72 km/h).
   *  1단계 보퍼트 5(29~, 잎 달린 작은 나무가 흔들림) · 2단계 보퍼트 6(39~, 큰 가지가 흔들림) · 3단계 보퍼트 7(50~ ≒ 강풍주의보 14 m/s, 나무 전체가 흔들림) */
  const WIND_LEVELS = [{ wind: 29, gust: 39 }, { wind: 39, gust: 50 }, { wind: 50, gust: 72 }];
  /** 돌풍으로 보는 차이(km/h): 순간 풍속이 평균보다 10노트(18.5 km/h) 이상 크면 (항공 기상 METAR 돌풍 보고 기준) */
  const GUSTY_DIFF = 18.5;
  /** 장면에서 바람이 불어 가는 쪽(고정, 단위벡터 x·z) */
  const WIND_DIR = (() => { const l = Math.hypot(1, 0.35); return { x: 1 / l, z: -0.35 / l }; })();
  /** 단계별 빗줄기 기울기(수평 속도 ÷ 낙하 속도): 약 7° · 17° · 29° */
  const LEAN = [0, 0.12, 0.3, 0.55];
  /** 입자 종류별 기울기 배율: 눈은 가벼워 많이, 우박은 무거워 적게 */
  const LEAN_K = { rain: 1, thunder: 1, drizzle: 1.3, snow: 4, hail: 0.6 };
  /** 단계별 나무·덤불 흔들림 진폭(rad) */
  const SWAY = [0, 0.012, 0.025, 0.04];
  /** 번개가 치는 종류 */
  const STORM = new Set(['thunder', 'hail']);
  /** 종류별 입자 묶음 (hail 의 drizzle 은 뇌우의 비 표현) */
  const FALL = { rain: ['rain'], drizzle: ['drizzle'], thunder: ['thunder'], snow: ['snow'], hail: ['hail', 'hailBounce', 'drizzle'] };
  /** 날리는 잎 색(계절별, 겨울 없음) */
  const LEAF_FLY = { spring: ['#f7c9d4', '#c2e59a'], summer: ['#7dbb67', '#5fa25a'], autumn: ['#e39a3b', '#c8572d'] };

  /**
   * (x, z) 가 지붕 있는 건물 바닥 안인지.
   * 건물 바닥 (openoffice.js BUILDING 과 같음): 본관 x[0,32] z[18,28], 날개 x[0,10]·x[22,32] z[0,18]. 중정은 바깥.
   * @param {number} x 장면 x
   * @param {number} z 장면 z
   * @returns {boolean} 건물 안이면 true
   * @see spawnFall
   */
  const inBuilding = (x, z) => (z >= 18 && z <= 28 && x >= 0 && x <= 32) || (z >= 0 && z < 18 && ((x >= 0 && x <= 10) || (x >= 22 && x <= 32)));

  /**
   * 날씨 효과·계절 표현을 장면에 붙인다.
   * 비·눈 입자 그림 텍스처, 계절별 나무 잎색·잔디·언덕·연못 재질, 여름 풀·가을 낙엽 인스턴스를 준비한다. apply(w) 로 날씨(입자·흐림·안개·번개)와 계절·결빙을 한꺼번에 바꾼다. 위치가 바뀌거나 10분마다 계절을 다시 계산한다.
   * @param {BABYLON.Scene} scene 장면
   * @param {WeatherFxOpts} opts 카메라·낮밤·화질·바닥 장식
   * @returns {{apply: function(FxWeather|null):void, season: function():string, frozen: function():boolean}} 날씨 적용 함수, 현재 계절, 연못이 얼었는지
   * @see daylight.js setWeather · flash, weather.js MeowWeather
   */
  function start(scene, { camera, day, quality = 'mid', ground = null }) {
    const params = new URLSearchParams(location.search);
    const V3 = BABYLON.Vector3;
    const scale = { low: 0.45, mid: 0.75, high: 1 }[quality] || 0.75;
    // 빗줄기 · 눈송이 그림
    const streak = new BABYLON.DynamicTexture('rainTex', { width: 8, height: 64 }, scene, true);
    {
      const g = streak.getContext(); const gr = g.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, 'rgba(210,225,255,0)'); gr.addColorStop(0.5, 'rgba(225,235,255,0.9)'); gr.addColorStop(1, 'rgba(210,225,255,0)');
      g.fillStyle = gr; g.fillRect(1, 0, 6, 64);
      g.globalCompositeOperation = 'destination-in'; // 가로로도 가운데가 진하게
      const gx = g.createLinearGradient(0, 0, 8, 0); gx.addColorStop(0, 'rgba(0,0,0,0)'); gx.addColorStop(0.5, 'rgba(0,0,0,1)'); gx.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gx; g.fillRect(0, 0, 8, 64); g.globalCompositeOperation = 'source-over';
      streak.update(); streak.hasAlpha = true;
    }
    const flake = new BABYLON.DynamicTexture('snowTex', { width: 32, height: 32 }, scene, true);
    {
      const g = flake.getContext(); const gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32); flake.update(); flake.hasAlpha = true;
    }
    // 눈 결정: 여섯 가지 + 곁가지 + 가운데 육각, 둘레에 옅은 빛. 작게 보여도 깨지지 않게 크게 그리고 밉맵·삼선형 보간을 쓴다 (둥근 점 flake 는 우박용으로 남긴다)
    const crystal = new BABYLON.DynamicTexture('snowCrystalTex', { width: 128, height: 128 }, scene, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
    {
      const g = crystal.getContext();
      const gr = g.createRadialGradient(64, 64, 2, 64, 64, 60);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#ffffff'; g.lineCap = 'round'; g.lineJoin = 'round';
      g.translate(64, 64);
      for (let i = 0; i < 6; i++) {
        g.save(); g.rotate((i * Math.PI) / 3);
        g.lineWidth = 9; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -52); g.stroke(); // 가지
        g.lineWidth = 7;
        for (const [at, len] of [[-22, 15], [-38, 11]]) { // 곁가지 두 쌍
          g.beginPath(); g.moveTo(0, at); g.lineTo(-len, at - len * 0.8); g.moveTo(0, at); g.lineTo(len, at - len * 0.8); g.stroke();
        }
        g.restore();
      }
      g.lineWidth = 6; g.beginPath();
      for (let i = 0; i <= 6; i++) { const a = (i * Math.PI) / 3; g[i ? 'lineTo' : 'moveTo'](Math.sin(a) * 13, -Math.cos(a) * 13); }
      g.stroke();
      g.setTransform(1, 0, 0, 1, 0, 0);
      crystal.update(); crystal.hasAlpha = true;
    }
    const leafTex = new BABYLON.DynamicTexture('leafFlyTex', { width: 16, height: 16 }, scene, true);
    {
      const g = leafTex.getContext(); g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(8, 8, 7, 4, 0.5, 0, Math.PI * 2); g.fill();
      leafTex.update(); leafTex.hasAlpha = true;
    }
    /**
     * 떨어지는 입자가 나타날 자리를 뽑는 함수 만들기.
     * 땅에 닿을 자리를 카메라가 보는 곳 둘레(반지름은 화각에 맞춤 7~30)에서 뽑고, 그 자리와 낙하의 3/4 지점(벽 높이쯤)이 건물 밖이면 채택한다(8번까지). 시작점은 그 자리에서 바람 반대쪽으로 기운 만큼 물린다. 끝내 못 찾으면 화면 밖(-60, -60).
     * @param {number} h 입자가 시작하는 높이
     * @param {number} k 종류별 기울기 배율 (LEAN_K)
     * @returns {function(*, BABYLON.Vector3):void} 파티클 시스템의 startPositionFunction
     * @see leanNow
     */
    const spawnFall = (h, k) => (wm, pos) => {
      const c = camera.target, R = Math.min(30, Math.max(7, camera.radius * 0.6));
      const d = leanNow * k * h, dx = WIND_DIR.x * d, dz = WIND_DIR.z * d;
      let x = c.x, z = c.z, ok = false;
      for (let i = 0; i < 8 && !ok; i++) {
        x = c.x + (Math.random() * 2 - 1) * R; z = c.z + (Math.random() * 2 - 1) * R;
        ok = !inBuilding(x, z) && !inBuilding(x - dx * 0.25, z - dz * 0.25);
      }
      if (!ok) pos.set(-60, h, -60); else pos.set(x - dx, h + Math.random() * 2, z - dz);
    };
    /**
     * 우박이 바닥에서 튀는 자리 뽑기: 카메라 둘레의 건물 밖 땅 위(높이 0.03).
     * @param {*} wm 사용 안 함
     * @param {BABYLON.Vector3} pos 결과 자리
     * @returns {void}
     */
    const spawnGround = (wm, pos) => {
      const c = camera.target, R = Math.min(30, Math.max(7, camera.radius * 0.6));
      let x = c.x, z = c.z, ok = false;
      for (let i = 0; i < 8 && !ok; i++) {
        x = c.x + (Math.random() * 2 - 1) * R; z = c.z + (Math.random() * 2 - 1) * R;
        ok = !inBuilding(x, z);
      }
      if (!ok) pos.set(-60, 0.03, -60); else pos.set(x, 0.03, z);
    };
    /**
     * 날리는 잎이 나타날 자리 뽑기: 시작점과 바람 앞 3.5m·7m 지점이 모두 건물 밖.
     * @param {*} wm 사용 안 함
     * @param {BABYLON.Vector3} pos 결과 자리
     * @returns {void}
     */
    const spawnBlow = (wm, pos) => {
      const c = camera.target, R = Math.min(30, Math.max(7, camera.radius * 0.6));
      let x = c.x, z = c.z, ok = false;
      for (let i = 0; i < 8 && !ok; i++) {
        x = c.x + (Math.random() * 2 - 1) * R; z = c.z + (Math.random() * 2 - 1) * R;
        ok = !inBuilding(x, z) && !inBuilding(x + WIND_DIR.x * 3.5, z + WIND_DIR.z * 3.5) && !inBuilding(x + WIND_DIR.x * 7, z + WIND_DIR.z * 7);
      }
      if (!ok) pos.set(-60, 0.2, -60); else pos.set(x, 0.2 + Math.random() * 2.2, z);
    };
    /**
     * 날씨 종류별 파티클 시스템 만들기.
     * 눈은 느리고 작게 흩날리고, 비·뇌우는 길게 늘린 빗줄기(뇌우가 더 굵고 많음), 이슬비는 가늘게. 우박은 흰 알갱이가 빠르게 떨어지는 hail 과 바닥에서 튀는 hailBounce. 화질 배율(scale)로 개수를 조절하고 미리 돌려 둔 채 시작한다. 바람 기울기를 매 프레임 넣기 위해 처음 방향(d1·d2)과 배율(k)을 함께 돌려준다.
     * @param {"rain"|"drizzle"|"thunder"|"snow"|"hail"|"hailBounce"} kind 입자 종류
     * @returns {{ps: BABYLON.ParticleSystem, d1: BABYLON.Vector3, d2: BABYLON.Vector3, k: number}} 시작된 파티클 시스템과 방향 기록
     */
    function system(kind) {
      if (kind === 'hail' || kind === 'hailBounce') return hailSystem(kind);
      const snow = kind === 'snow';
      const heavy = kind === 'rain' || kind === 'thunder';
      const cap = Math.round((snow ? 1800 : heavy ? 3600 : 1600) * scale);
      const ps = new BABYLON.ParticleSystem('wx-' + kind, cap, scene);
      ps.particleTexture = snow ? crystal : streak;
      ps.emitter = V3.Zero();
      ps.startPositionFunction = spawnFall(snow ? 9 : 13, LEAN_K[kind]);
      ps.emitRate = snow ? cap / 9 : cap / 0.95;
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      if (snow) {
        ps.minSize = 0.09; ps.maxSize = 0.2; // 결정 모양이 보일 만큼 (둥근 점일 때는 0.05~0.11)
        ps.minInitialRotation = 0; ps.maxInitialRotation = Math.PI * 2;
        ps.minAngularSpeed = -1.2; ps.maxAngularSpeed = 1.2; // 빙글빙글 돌며 내린다
        ps.minLifeTime = 8; ps.maxLifeTime = 10;
        ps.direction1 = new V3(-0.25, -1, -0.2); ps.direction2 = new V3(0.25, -1, 0.2);
        ps.minEmitPower = 0.9; ps.maxEmitPower = 1.3;
        ps.color1 = new BABYLON.Color4(1, 1, 1, 0.9); ps.color2 = new BABYLON.Color4(0.92, 0.95, 1, 0.75);
        ps.colorDead = new BABYLON.Color4(1, 1, 1, 0);
      } else {
        ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED;
        ps.minSize = 0.07; ps.maxSize = 0.1;
        ps.minScaleY = heavy ? 4 : 2.5; ps.maxScaleY = heavy ? 6 : 3.5; // 빗줄기 길이
        ps.minLifeTime = 0.85; ps.maxLifeTime = 0.95;
        ps.direction1 = new V3(-0.04, -1, 0.02); ps.direction2 = new V3(0.02, -1, 0.05);
        ps.minEmitPower = 14; ps.maxEmitPower = 16;
        const a = heavy ? 0.62 : 0.42;
        ps.color1 = new BABYLON.Color4(0.78, 0.84, 0.95, a); ps.color2 = new BABYLON.Color4(0.7, 0.78, 0.92, a * 0.8);
        ps.colorDead = new BABYLON.Color4(0.7, 0.78, 0.92, 0);
      }
      ps.preWarmCycles = 60; ps.preWarmStepOffset = 5;
      ps.start();
      return { ps, d1: ps.direction1.clone(), d2: ps.direction2.clone(), k: LEAN_K[kind] };
    }
    /**
     * 우박 입자 만들기.
     * hail: 흰 알갱이가 곧게 빠르게 떨어짐. hailBounce: 바닥에서 위로 튀어 중력으로 떨어지는 짧은 알갱이.
     * @param {"hail"|"hailBounce"} kind 입자 종류
     * @returns {{ps: BABYLON.ParticleSystem, d1: BABYLON.Vector3, d2: BABYLON.Vector3, k: number}} 시작된 시스템과 방향 기록
     */
    function hailSystem(kind) {
      const bounce = kind === 'hailBounce';
      const cap = Math.round((bounce ? 420 : 900) * scale);
      const ps = new BABYLON.ParticleSystem('wx-' + kind, cap, scene);
      ps.particleTexture = flake;
      ps.emitter = V3.Zero();
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      ps.color1 = new BABYLON.Color4(1, 1, 1, 0.95); ps.color2 = new BABYLON.Color4(bounce ? 1 : 0.9, bounce ? 1 : 0.95, 1, bounce ? 0.95 : 0.9);
      if (bounce) {
        ps.startPositionFunction = spawnGround;
        ps.minSize = 0.04; ps.maxSize = 0.08;
        ps.minLifeTime = 0.28; ps.maxLifeTime = 0.45;
        ps.direction1 = new V3(-0.6, 1, -0.6); ps.direction2 = new V3(0.6, 1, 0.6);
        ps.minEmitPower = 1.4; ps.maxEmitPower = 2.4;
        ps.gravity = new V3(0, -9.8, 0);
        ps.colorDead = new BABYLON.Color4(1, 1, 1, 0);
        ps.emitRate = cap / 0.4;
      } else {
        ps.startPositionFunction = spawnFall(13, LEAN_K.hail);
        ps.minSize = 0.06; ps.maxSize = 0.11;
        ps.minLifeTime = 1.0; ps.maxLifeTime = 1.1;
        ps.direction1 = new V3(-0.03, -1, -0.03); ps.direction2 = new V3(0.03, -1, 0.03);
        ps.minEmitPower = 12.5; ps.maxEmitPower = 14;
        ps.colorDead = new BABYLON.Color4(1, 1, 1, 0.6);
        ps.emitRate = cap / 1.05;
      }
      ps.preWarmCycles = 60; ps.preWarmStepOffset = 5;
      ps.start();
      return { ps, d1: ps.direction1.clone(), d2: ps.direction2.clone(), k: bounce ? 0 : LEAN_K.hail };
    }

    let systems = [], kindNow = '', flashT = 0, nextFlash = 0;
    /** 바람 상태: level 0~3(WIND_LEVELS), gusty 돌풍이 부는가 */
    const wind = { level: 0, gusty: false };
    let leanNow = 0, burst = 0, burstT = 0, nextGust = 3, windT = 0, swayOn = false, trees = null, leavesPs = null, seasonCur = 'spring', frozenNow = false;
    /**
     * 날씨 종류를 바꾼다(같은 종류면 무시).
     * 이전 입자는 멈추고 1.5초 뒤 정리, 새 종류의 입자 묶음(FALL)을 만든다. 종류별 흐림(dim)·안개(fog) 정도를 낮·밤 계산(day.setWeather)에 넘기고 다음 번개 시각을 정한다.
     * @param {FxWeather|null} w 날씨 (null 이면 맑음)
     * @returns {void}
     * @see system, daylight.js setWeather
     */
    function apply(w) {
      const kind = w ? w.kind : 'clear';
      if (kind === kindNow) return;
      kindNow = kind;
      for (const o of systems) { o.ps.stop(); setTimeout(() => o.ps.dispose(), 1500); }
      systems = (FALL[kind] || []).map(system);
      // 흐림·안개 정도 → 낮·밤 계산에 넘긴다 (햇빛·하늘·안개)
      const dim = { clear: 0, partly: 0.2, cloudy: 0.55, fog: 0.5, drizzle: 0.6, rain: 0.7, snow: 0.5, thunder: 0.85, hail: 0.85 }[kind] ?? 0;
      const fog = { fog: 1, snow: 0.3 }[kind] ?? 0; // 비(이슬비·비·뇌우·우박)에는 뿌옇게 하지 않는다 — 화면이 흐려 보여서 뺐다. 안개 날씨와 눈만 남김
      if (day && day.setWeather) day.setWeather({ dim, fog });
      nextFlash = 4 + Math.random() * 8;
    }
    /**
     * 뇌우·우박: 가끔 번쩍(매 프레임 확인).
     * 번개 종류(STORM)일 때만 동작. 다음 번개까지 시간이 지나면 0.35초 번개를 시작해 day.flash 로 밝기를 줄여 가며 보내고(70% 는 강하게, 나머지는 약하게), 아니면 0 을 보낸다.
     * @param {number} dt 지난 시간(초)
     * @returns {void}
     * @see daylight.js flash
     */
    function flashTick(dt) {
      if (!STORM.has(kindNow) || !day || !day.flash) return;
      nextFlash -= dt;
      if (nextFlash <= 0) { flashT = 0.35; nextFlash = 6 + Math.random() * 14; }
      if (flashT > 0) { flashT -= dt; day.flash(Math.max(0, flashT / 0.35) * (Math.random() < 0.7 ? 1 : 0.4)); } else day.flash(0);
    }
    /**
     * 바람 갱신(매 프레임).
     * 돌풍 포락선(0.4초 만에 오르고 1.8초에 걸쳐 잦아듦), 입자 방향 기울기, 나무·덤불 흔들림(바람 0이면 다시 고정), 날리는 잎 방출률을 계산한다.
     * @param {number} dt 지난 시간(초)
     * @returns {void}
     * @see applyWind, WIND_LEVELS
     */
    function windTick(dt) {
      windT += dt;
      if (wind.gusty) {
        nextGust -= dt;
        if (nextGust <= 0) { burstT = 2.2; nextGust = 5 + Math.random() * 6; }
      }
      if (burstT > 0) {
        burstT -= dt;
        const e = 2.2 - burstT;
        burst = e < 0.4 ? e / 0.4 : Math.max(0, burstT / 1.8);
      } else burst = 0;
      const gain = 1 + 0.8 * burst;
      leanNow = LEAN[wind.level] * gain;
      for (const o of systems) {
        if (!(o.k > 0)) continue;
        o.ps.direction1.x = o.d1.x + WIND_DIR.x * leanNow * o.k; o.ps.direction1.z = o.d1.z + WIND_DIR.z * leanNow * o.k;
        o.ps.direction2.x = o.d2.x + WIND_DIR.x * leanNow * o.k; o.ps.direction2.z = o.d2.z + WIND_DIR.z * leanNow * o.k;
      }
      // 나무·덤불 흔들림 (캡처 확인: 빗줄기 기운 쪽으로 눕는지)
      const on = wind.level > 0;
      if (on || swayOn) {
        if (!trees) trees = scene.meshes.filter((m) => /^@(tree|treeBare|pine|bush):/.test(m.name));
        const amp = SWAY[wind.level] * gain;
        for (const m of trees) {
          if (!on) { m.rotation.x = 0; m.rotation.z = 0; m.freezeWorldMatrix(); continue; }
          if (!swayOn) m.unfreezeWorldMatrix();
          if (!m.isEnabled()) continue;
          const a = amp * (0.6 + Math.sin(windT * 1.7 + m.position.x * 0.35 + m.position.z * 0.25) * 0.8 + Math.sin(windT * 4.3 + m.position.x) * 0.25);
          const cy = Math.cos(m.rotation.y), sy = Math.sin(m.rotation.y);
          const lx = WIND_DIR.x * cy - WIND_DIR.z * sy, lz = WIND_DIR.x * sy + WIND_DIR.z * cy; // 인스턴스 y 회전만큼 되돌린 바람 방향
          m.rotation.x = a * lz; m.rotation.z = -a * lx;
        }
        swayOn = on;
      }
      // 날리는 잎
      if (wind.level >= 2 && !leavesPs) {
        const cap = Math.round(140 * scale);
        const lp = new BABYLON.ParticleSystem('wx-leaves', cap, scene);
        lp.particleTexture = leafTex; lp.emitter = V3.Zero(); lp.startPositionFunction = spawnBlow;
        lp.minSize = 0.07; lp.maxSize = 0.13; lp.minLifeTime = 1.2; lp.maxLifeTime = 2.0;
        lp.direction1 = new V3(WIND_DIR.x, -0.08, WIND_DIR.z - 0.25); lp.direction2 = new V3(WIND_DIR.x, 0.22, WIND_DIR.z + 0.25);
        lp.minEmitPower = 3; lp.maxEmitPower = 5.5; lp.gravity = new V3(0, -0.6, 0);
        lp.minAngularSpeed = -6; lp.maxAngularSpeed = 6; lp.minInitialRotation = 0; lp.maxInitialRotation = Math.PI * 2;
        lp.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
        lp.color1 = new BABYLON.Color4(1, 1, 1, 1); lp.color2 = new BABYLON.Color4(1, 1, 1, 1); lp.colorDead = new BABYLON.Color4(1, 1, 1, 0);
        lp.emitRate = 0; lp.start();
        leavesPs = lp;
      }
      if (leavesPs) {
        const pal = LEAF_FLY[seasonCur];
        if (pal) { leavesPs.color1 = BABYLON.Color4.FromColor3(BABYLON.Color3.FromHexString(pal[0]), 1); leavesPs.color2 = BABYLON.Color4.FromColor3(BABYLON.Color3.FromHexString(pal[1]), 1); }
        leavesPs.emitRate = wind.level >= 2 && pal && kindNow !== 'snow' ? (leavesPs.getCapacity() / 3) * (wind.level - 1) * gain : 0;
      }
    }
    scene.onBeforeRenderObservable.add(() => {
      const dt = scene.getEngine().getDeltaTime() / 1000;
      flashTick(dt);
      windTick(dt);
    });
    // ── 계절 ─────────────────────────────────────────────
    const P = OfficePalette;
    /**
     * "#rrggbb" → Color3.
     * @param {string} h 색 문자열
     * @returns {BABYLON.Color3}
     */
    const C = (h) => BABYLON.Color3.FromHexString(h);
    /**
     * 얼려 둔 재질을 잠깐 풀어 고치고 다시 얼린다.
     * 재질이 없으면 무시.
     * @param {BABYLON.Material|null} m 재질
     * @param {function(BABYLON.Material):void} fn 고치는 함수
     * @returns {void}
     */
    const edit = (m, fn) => { if (!m) return; m.unfreeze(); fn(m); m.freeze(); };
    const leafMats = { leaf: P.mat(scene, 'leaf', { tree: 1 }), leafDark: P.mat(scene, 'leafDark', { tree: 1 }), leafLight: P.mat(scene, 'leafLight', { tree: 1 }) };
    const bareMat = P.mat(scene, 'trunk', { bare: 1 }); // 뒷산 잎 나무의 겨울 가지 (openoffice.js '@mound')
    const LEAF = {
      spring: { leaf: '#9fd27f', leafDark: '#6fae5c', leafLight: '#c2e59a' },
      summer: { leaf: '#5fa25a', leafDark: '#3f7f45', leafLight: '#7dbb67' },
      autumn: { leaf: '#e39a3b', leafDark: '#c8572d', leafLight: '#f2c14e' },
      winter: { leaf: '#5fa25a', leafDark: '#3f7f45', leafLight: '#7dbb67' }, // 겨울엔 잎 나무를 끄고(공원) 잎 재질을 투명하게 해(뒷산) 안 보임
    };
    // 계절 꽃밭 견본 (openoffice.js '@flowers*'): 봄 튤립 / 여름 활짝 / 가을 시든 다섯 송이 / 겨울 흙만
    const FLOWER_BED = { spring: '@flowers', summer: '@flowersSummer', autumn: '@flowersAutumn', winter: '@flowersWinter' };
    const LAWN = { spring: '#b3d496', summer: '#9ccb7c', autumn: '#c7cc8e', winter: '#bcc3a6', snow: '#eef2f5' };
    const lawnMats = [P.mat(scene, 'lawn'), P.mat(scene, 'ground')];
    // 뒷산 언덕: 공을 늘린 모양이라 텍스처는 늘어나서 단색만 (가을은 낙엽 텍스처 평균 톤)
    const hillMat = P.mat(scene, 'hill');
    const HILL = { spring: '#a9d08e', summer: '#9cc785', autumn: '#c09c5c', winter: '#b3ba9c', snow: '#eef2f5' };
    // 계절 바닥 타일 텍스처 (textures/ground_<계절>.jpg, 이음매 없음). 220m 잔디판에 6m마다 반복. 필요할 때 한 번만 불러옴
    //   봄 연두 + 들꽃·벚꽃잎 / 여름 짙은 잔디 + 클로버 / 가을 마른 풀 + 단풍잎 / 겨울 마른 풀 + 서리 / 눈 — 겨울·눈엔 숨은 고양이 발자국
    const groundTex = {};
    const seasonGround = (k) => {
      if (!groundTex[k]) {
        const t = new BABYLON.Texture(`textures/ground_${k}.jpg`, scene);
        t.uScale = t.vScale = 220 / 6;
        t.anisotropicFilteringLevel = 8;
        groundTex[k] = t;
      }
      return groundTex[k];
    };
    const waterMat = P.mat(scene, 'water', { emissive: 0.15 }), lilyMat = P.mat(scene, 'leaf', { lily: 1 });
    const WATER = waterMat.diffuseColor.clone(), WATER_E = waterMat.emissiveColor.clone();
    /**
     * 여름 풀: 잎 셋을 엇갈린 작은 풀포기 하나를 얇은 인스턴스(thin instance)로 깐다.
     * ground.grass 좌표마다 한 포기. 평소엔 꺼 두고 여름에만 켠다.
     * @returns {BABYLON.Mesh} 풀 메시
     * @see applySeason
     */
    const tuft = (() => {
      const parts = [0, 1.05, 2.1].map((a, i) => {
        const b = BABYLON.MeshBuilder.CreatePlane('blade', { width: 0.16, height: 0.2 + i * 0.03, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        b.rotation.y = a; b.position.y = 0.1 + i * 0.015; b.bakeCurrentTransformIntoVertices();
        return b;
      });
      const m = BABYLON.Mesh.MergeMeshes(parts, true);
      m.name = 'summerGrass';
      const mt = new BABYLON.StandardMaterial('summerGrassMat', scene);
      mt.diffuseColor = C('#6fae4f'); mt.specularColor = BABYLON.Color3.Black(); mt.backFaceCulling = false;
      m.material = mt; m.isPickable = false;
      const list = (ground && ground.grass) || [];
      const mats = new Float32Array(list.length * 16);
      list.forEach(([x, z, r, sc], i) => BABYLON.Matrix.Compose(new V3(sc, sc, sc), BABYLON.Quaternion.RotationYawPitchRoll(r, 0, 0), new V3(x, 0, z)).copyToArray(mats, i * 16));
      if (list.length) m.thinInstanceSetBuffer('matrix', mats, 16, true);
      m.setEnabled(false);
      return m;
    })();
    /**
     * 가을 낙엽: 바닥에 누운 작은 잎을 얇은 인스턴스로 깐다.
     * 색은 주황·빨강·노랑·갈색을 돌려 쓴다. ground.leaves 좌표마다 하나. 평소엔 꺼 두고 가을에만 켠다.
     * @returns {BABYLON.Mesh} 낙엽 메시
     * @see applySeason
     */
    const leaves = (() => {
      const m = BABYLON.MeshBuilder.CreateDisc('fallen', { radius: 0.07, tessellation: 5 }, scene);
      m.rotation.x = Math.PI / 2; m.bakeCurrentTransformIntoVertices();
      const mt = new BABYLON.StandardMaterial('fallenMat', scene);
      mt.specularColor = BABYLON.Color3.Black(); mt.backFaceCulling = false;
      m.material = mt; m.isPickable = false;
      const list = (ground && ground.leaves) || [];
      const mats = new Float32Array(list.length * 16), cols = new Float32Array(list.length * 4);
      const PAL = ['#e39a3b', '#c8572d', '#f2c14e', '#a8642c', '#d9762f'].map(C);
      list.forEach(([x, z, r], i) => {
        BABYLON.Matrix.Compose(new V3(1, 1, 1), BABYLON.Quaternion.RotationYawPitchRoll(r, 0, 0), new V3(x, 0.012, z)).copyToArray(mats, i * 16);
        const c = PAL[i % PAL.length]; cols.set([c.r, c.g, c.b, 1], i * 4);
      });
      if (list.length) { m.thinInstanceSetBuffer('matrix', mats, 16, true); m.thinInstanceSetBuffer('color', cols, 4, true); }
      m.setEnabled(false);
      return m;
    })();

    /**
     * 태양의 겉보기 황경(도, 0~360). 춘분 0°, 입하 45°, 하지 90°, 입추 135°, 추분 180°, 입동 225°, 동지 270°, 입춘 315°.
     * 간단한 근사식(Meeus)으로 오차 약 0.01°(시각으로 15분 안팎) — 절기 날짜를 해마다 따로 적어 두지 않아도 된다.
     * @param {Date} d 시각
     * @returns {number} 황경(도)
     */
    function sunLongitude(d) {
      const T = (d.getTime() / 86400000 + 2440587.5 - 2451545) / 36525, R = Math.PI / 180;
      const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
      const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * R;
      const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
      const lon = L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * R);
      return ((lon % 360) + 360) % 360;
    }
    /**
     * 지금 계절.
     * ?season= 이 있으면 그 값. 아니면 태양 황경(sunLongitude)으로 판정한다: 입동(225°)부터 겨울, 단풍 무렵(202°, 10월 중순)부터 가을, 입하(45°)부터 여름, 춘분(0°)부터 봄. 남반구는 반년 민다.
     * @returns {string} spring | summer | autumn | winter
     * @see meowLocation (common.js)
     */
    function seasonNow() {
      const q = params.get('season');
      if (q) return q;
      const loc = typeof meowLocation === 'function' ? meowLocation() : { lat: 37.5, tz: 'Asia/Seoul' };
      // 절기 기준(태양 황경). 겨울은 입동(225°, 11/7경)부터, 여름은 입하(45°, 5/5경)부터.
      // 다만 풍경이 실제와 어긋나지 않게 봄 풀빛은 춘분(0°, 3/20경)부터, 단풍은 북한산 첫 단풍 무렵(202°, 10/15경)부터 보인다 — 그 사이는 앞 계절 풍경을 유지한다
      let lon = sunLongitude(new Date());
      if (loc.lat < 0) lon = (lon + 180) % 360; // 남반구는 반년 밀림
      return lon >= 225 ? 'winter' : lon >= 202 ? 'autumn' : lon >= 45 ? 'summer' : 'spring';
    }
    let seasonKey = '';
    /**
     * 계절·눈·결빙에 맞춰 장면을 바꾼다.
     * 결빙 여부는 frozenNow 에 기록해 frozen() 으로 알린다(키가 같아도 갱신).
     * 계절·눈 여부·결빙(기온 ≤ 0°C, ?temp= 로 덮어쓰기) 조합이 바뀔 때만 동작. 겨울엔 잎 나무를 끄고 가지만 나무를 켜며, 잎·잔디(계절 텍스처, 눈 오면 눈)·언덕 색, 여름 풀·가을 낙엽 표시, 연못 얼음·연잎 숨김을 맞춘다.
     * @param {FxWeather|null} w 날씨
     * @returns {void}
     * @see seasonNow, edit, seasonGround
     */
    function applySeason(w) {
      const season = seasonNow();
      const tq = params.get('temp');
      const temp = tq != null ? +tq : w && w.temp != null ? w.temp : null;
      const snowing = w && w.kind === 'snow';
      const frozen = temp != null && temp <= 0;
      frozenNow = frozen; seasonCur = season;
      const key = [season, snowing, frozen].join('|');
      if (key === seasonKey) return;
      seasonKey = key;
      const winter = season === 'winter';
      const bed = FLOWER_BED[season];
      for (const m of scene.meshes) {
        if (m.name.startsWith('@tree:')) m.setEnabled(!winter);
        else if (m.name.startsWith('@treeBare:')) m.setEnabled(winter);
        else if (m.name.startsWith('@flowers')) m.setEnabled(m.name.slice(0, m.name.indexOf(':')) === bed);
      }
      // 잎 색. 겨울에는 잎을 투명하게(뒷산 잎 나무 — 통짜 메시라 재질로 숨긴다. 공원 잎 나무는 위에서 나무째 껐다), 대신 뒷산의 겨울 가지 재질을 보이게
      for (const [k, h] of Object.entries(LEAF[season])) edit(leafMats[k], (m) => { m.diffuseColor = C(h); m.alpha = winter ? 0 : 1; });
      edit(bareMat, (m) => { m.alpha = winter ? 1 : 0; });
      edit(hillMat, (m) => { m.diffuseColor = C(snowing ? HILL.snow : HILL[season]); });
      const gk = snowing ? 'snow' : season;
      for (const lm of lawnMats) edit(lm, (m) => {
        m.diffuseTexture = seasonGround(gk); // 계절 텍스처 (색은 텍스처 그대로)
        m.diffuseColor = C('#ffffff');
      });
      tuft.setEnabled(season === 'summer' && !snowing);
      leaves.setEnabled(season === 'autumn' && !snowing);
      edit(waterMat, (m) => { m.diffuseColor = frozen ? C('#dbe8f0') : WATER; m.emissiveColor = frozen ? C('#2a3036') : WATER_E; m.specularColor = frozen ? new BABYLON.Color3(0.5, 0.55, 0.6) : new BABYLON.Color3(0.06, 0.06, 0.06); });
      edit(lilyMat, (m) => { m.alpha = frozen ? 0 : 1; });
    }
    setInterval(() => applySeason(lastW), 10 * 60e3); // 날짜가 바뀌어 계절이 넘어갈 때
    window.addEventListener('meow-location', () => { seasonKey = ''; applySeason(lastW); });
    let lastW = null;
    const apply0 = apply;
    /**
     * 날씨와 계절을 한 번에 적용(공개 apply).
     * 마지막 날씨를 기억해 두고 apply + applySeason 을 부른다.
     * @param {FxWeather|null} w 날씨
     * @returns {void}
     * @see apply, applySeason
     */
    function applyAll(w) { lastW = w; apply0(w); applyWind(w); applySeason(w); }
    /**
     * 바람 입력을 단계(wind.level)와 돌풍 여부로 바꾼다.
     * ?wind= · ?gust= (km/h)가 있으면 그 값, 없으면 날씨의 wind·gust. 평균 또는 순간 풍속이 단계 기준(WIND_LEVELS)을 넘는 가장 높은 단계. 순간-평균 ≥ GUSTY_DIFF 면 돌풍.
     * @param {FxWeather|null} w 날씨
     * @returns {void}
     */
    function applyWind(w) {
      const q = (k) => (params.get(k) != null ? +params.get(k) : null);
      const ws = q('wind') ?? (w && w.wind) ?? 0, gs = q('gust') ?? (w && w.gust) ?? 0;
      let lv = 0;
      WIND_LEVELS.forEach((L, i) => { if (ws >= L.wind || gs >= L.gust) lv = i + 1; });
      wind.level = lv; wind.gusty = lv > 0 && gs - ws >= GUSTY_DIFF;
    }
    applyWind(null);
    applySeason(null);
    /**
     * start 의 공개 API 묶음.
     * apply(w), 현재 계절을 알려 주는 season(), 연못이 얼었는지 알려 주는 frozen().
     * @returns {{apply: function, season: function, frozen: function():boolean}}
     */
    return { apply: applyAll, season: seasonNow, frozen: () => frozenNow };
  }
  /**
   * 모듈 공개 API 묶음.
   * start(scene, opts) · inBuilding(x, z).
   * @returns {{start: function, inBuilding: function}}
   */
  return { start, inBuilding };
})();
