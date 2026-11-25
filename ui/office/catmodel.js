/**
 * @file 고양이 3D 모델(glb) 연결부 (CatModel).
 * 고양이 3D 모델(glb) 연결부. OfficeCat 의 바깥 계약은 그대로 두고 겉모습만 이 모델로 그린다.
 * - 모델: models/cats/cat_<체형>.glb (뼈 24, 동작 13, 텍스처 UV 하나). 체형마다 뼈 이름·동작 이름이 같다.
 * - 품종: models/cats/skins/<품종>.webp (체형 UV 에 맞춘 털 무늬. 원본 PNG 는 assets/src3d, npm run optimize-assets 가 WebP 로 변환). 품종마다 체형이 정해져 있다.
 * - 동작 선택은 고양이 상태(pose/act/prop/signal)로 정하고, 꼬리·귀·뛰기·털 세우기는 코드로 덧붙인다.
 * 공개 API: preload, ready, bodies, breeds, breedName, attach(고양이에 모델 붙이기), animate(매 프레임), anchor(말풍선 기준점), keyStrikes(타자 타격 수).
 * 좌표계: 고양이 root 원점 = 발바닥 중앙, 정면 -Z, 위 +Y, 길이 단위 m. 관절 회전은 glTF 관절 자기 축 기준 사원수/라디안(도 표기는 각 표에 명시).
 *
 * @typedef {Object} GaitCfg 걷기 동작별 [한 주기(초), 그 주기에 나아가는 거리(m)]
 * @property {number[]} walk 두 발 걷기 [주기초, 거리m]
 * @property {number[]} carry 물건 들고 걷기
 * @property {number[]} walk4 네 발 걷기
 *
 * @typedef {Object} BodyCfg 체형 설정 (BODIES 의 값)
 * @property {string} file glb 파일 이름 (models/cats/ 아래)
 * @property {number} sitDrop 앉는 동작에서 엉덩이가 원점보다 높은 만큼(m). 앉을 때 이만큼 더 내린다
 * @property {number} ear 귀 눕히기 세기 배율 (접힌 귀는 0.3, 그 밖엔 1)
 * @property {boolean} quad 바깥에서 네 발로 걷는가 (일반형·접힌귀형). 아니면 두 발로 걷고 쉴 때 앞발 들고 선다 (장모형·짧은다리형)
 * @property {number} [legScale] 다리 길이 배율 (허벅지 뼈를 길이 방향으로만 줄임, 짧은다리형 0.7)
 * @property {GaitCfg} gait 걷는 동작 한 주기(초)와 그동안 나아가는 거리(m)
 *
 * @typedef {Object} BreedInfo 품종 도감 한 칸 (BREEDS 의 값)
 * @property {string} body 체형 키 (BODIES 의 키)
 * @property {number} [ears] 귀 크기 배율 (없으면 1)
 *
 * @typedef {Object} CatProps 소품 노드 묶음 (makeProps 결과, 평소엔 비활성)
 * @property {BABYLON.TransformNode} board 결재판 (몸 앞)
 * @property {BABYLON.TransformNode} box 배달 상자 (몸 앞)
 * @property {BABYLON.TransformNode} sign 질문 팻말 (오른손 뼈에 붙음)
 *
 * @typedef {Object} CatModelInfo attach() 가 돌려주는 모델 정보. 고양이 객체의 cat.model 로 달린다
 * @property {BABYLON.TransformNode} top 모델 최상위 노드 (cat.root 의 자식, 크기 z=-1)
 * @property {BABYLON.AbstractMesh[]} meshes 모델 메시들
 * @property {Object<string, BABYLON.TransformNode>} nodes 뼈 이름(고양이 id 접두사 뺌) → 뼈 노드
 * @property {Object<string, BABYLON.Quaternion>} rest 꼬리 4마디·귀 2개의 기본 자세 회전
 * @property {Object<string, BABYLON.AnimationGroup>} groups 동작 이름 → 동작 그룹
 * @property {string|null} anim 지금 재생 중인 동작 이름
 * @property {BABYLON.StandardMaterial} mat 품종 털 재질 (같은 품종끼리 공유)
 * @property {string} body 체형 키
 * @property {string} breed 품종 키
 * @property {BodyCfg} cfg 체형 설정 (BODIES[body])
 * @property {number} legDrop 짧게 줄인 다리만큼 몸을 내리는 높이(m)
 * @property {BABYLON.Vector3|null} tailPivot 꼬리 첫 마디 회전 중심 보정 벡터 (tailRingOffset 결과)
 * @property {CatProps} props 소품 노드
 * @property {BABYLON.TransformNode} [tie] 대표 넥타이 (대표만)
 * @property {{x:number, z:number}} [lastPos] 지난 프레임 위치 (걷는 속도 계산용, animate 가 채움)
 * @property {number} [speed] 실제 이동 속도(m/s, 부드럽게 보정, animate 가 채움)
 * @property {number[]} [tailAng] 꼬리 마디별 현재 방향각(도, animate 가 채움)
 * @property {number} [tailLift] 꼬리가 바닥에 묻히지 않게 앞 마디를 들어 올린 각(도, 0~90, animate 가 조절)
 * @property {Object<string, BABYLON.Vector3>} [tailPos] 꼬리 마디 기본 위치 (animate 가 채움)
 * @property {number|null} [strike] 타자 동작의 지난 호출 때 칸 번호 0~7 (keyStrikes 가 채움)
 *
 * @typedef {Object} Cat OfficeCat 고양이 객체 중 이 파일이 읽고 쓰는 필드만 (전체 모양은 cat.js 의 Cat)
 * @property {string} id 고양이 id
 * @property {BABYLON.TransformNode} root 고양이 자리 노드 (원점 = 발바닥 중앙, 정면 -Z)
 * @property {CatModelInfo} model 이 파일이 붙인 모델 정보
 * @property {string} pose 자세 stand | sit | loaf | walk
 * @property {string} act 행동 idle | type | stamp | talk | nod | shake | drink | highfive | read | present | groom | sleep | doze | sign | sad | fidget ...
 * @property {string|null} prop 소품 null | board | box | sign
 * @property {string|null} signal 신호 null | permission | waiting | thinking | complete | error
 * @property {boolean} [quad] 지금 바깥 네 발 걷기 모드인가
 * @property {boolean} [held] 목덜미를 잡혀 들린 상태인가
 * @property {boolean} [fishing] 낚시 자리에서 낚시 중인가
 * @property {number} [fishK] 낚시 팔 자세 섞임 정도 0~1
 * @property {boolean} [skating] 언 연못 위에서 미끄러지는 중인가 (openoffice 가 기록)
 * @property {number} [skateK] 스케이트 자세 섞임 정도 0~1
 * @property {{bottom: BABYLON.Vector3, dir: BABYLON.Vector3}|null} [fishRod] 낚싯대 아랫끝(월드)과 방향(월드 단위벡터)
 * @property {number} [uprightK] 등 펴기 섞임 정도 0~1
 * @property {number} t 이 고양이만의 경과 시간(초)
 * @property {number} [mood] 기분 0~1 (1 = 좋음)
 * @property {number} hopT 뛰기 남은 시간(초)
 * @property {number} [seatY] 앉는 좌석 높이(m)
 */
'use strict';

const CatModel = (() => {
  /**
   * Babylon 3차원 벡터(V3)·사원수(Q) 약칭.
   */
  const V3 = BABYLON.Vector3, Q = BABYLON.Quaternion;
  /**
   * 체형 glb 폴더 (ui 기준 상대 경로).
   * @type {string}
   */
  const DIR = 'models/cats/';
  /**
   * 품종 털 무늬 PNG 폴더.
   * @type {string}
   */
  const SKIN = DIR + 'skins/';
  // glTF 루트는 (회전 π, 크기 z -1) 로 들어오는데 이러면 정면이 +Z 다.
  // 회전을 없애고 z -1 만 남기면 좌우가 맞으면서 정면이 우리 규칙(-Z)이 된다.
  /**
   * 체형 키(standard 일반형 · foldear 접힌귀형 · longhair 장모형 · shortleg 짧은다리형) → 체형 설정(BodyCfg) 표.
   * 단위: sitDrop·걸음 거리는 m, 걸음 주기는 초. 접힌귀형 gait 은 일반형 값 × 발 이동 폭 비율.
   * - sitDrop: 앉는 동작에서 엉덩이가 원점보다 높은 만큼
   * - gait: 걷는 동작의 한 주기(초)와 그동안 나아가는 거리(m). 접힌귀형은 일반형 값 × 발 이동 폭 비율
   * - ear: 귀 눕히기 세기 (접힌 귀는 조금만)
   * - legScale: 다리 길이 배율 (허벅지 뼈를 길이 방향으로만 줄이고, 서거나 걸을 때 몸을 그만큼 내린다)
   * - quad: 바깥에서 네 발로 걷는가 (일반형·접힌귀형). 아니면 두 발로 걷고 쉴 때 앞발 들고 선다 (장모형·짧은다리형)
   * @type {Object<string, BodyCfg>}
   */
  const BODIES = {
    standard: { file: 'cat_standard.glb', sitDrop: 0.14, ear: 1, quad: true, gait: { walk: [1.0, 0.246], carry: [1.0, 0.248], walk4: [0.8, 0.238] } },
    foldear: { file: 'cat_foldear.glb', sitDrop: 0.12, ear: 0.3, quad: true, gait: { walk: [1.0, 0.207], carry: [1.0, 0.211], walk4: [0.8, 0.199] } },
    longhair: { file: 'cat_longhair.glb', sitDrop: 0.10, ear: 1, quad: false, gait: { walk: [1.0, 0.187], carry: [1.0, 0.19], walk4: [0.8, 0.187] } },
    // ai: AI 로 만든 고양이(품종마다 파일·자체 텍스처, 힉스필드 리깅 사람형 뼈). 뼈 회전·크기·위치는 코드로 손대지 않고 동작만 재생한다. speed = 걷는 속도(m/s), 동작 이름은 AI_CLIP 으로 옮긴다
    ai: { file: null, ai: true, sitDrop: -0.01, ear: 0, quad: false, speed: 0.6, gait: { walk: [1.0, 0.285], carry: [1.0, 0.285], walk4: [1.0, 0.285] } },
    shortleg: { file: 'cat_shortleg.glb', sitDrop: 0.06, ear: 1, quad: false, legScale: 0.7, gait: { walk: [1.0, 0.15], carry: [1.0, 0.151], walk4: [0.8, 0.15] } },
  };
  /**
   * 품종 도감 16종 (+ 대표). body: 체형, ears: 귀 크기 배율
   * 키 → { body 체형 키, ears(선택) }. 보이는 이름은 사전 cat.breed.<키> (breedName). 털 무늬 PNG 이름이 키와 같다.
   * @type {Object<string, BreedInfo>}
   */
  const BREEDS = {
    siamese: { body: 'standard' },
    russian_blue: { body: 'standard' },
    persian: { body: 'ai', file: 'ai/persian.glb' }, // AI 장모형 기본 모델(Tripo 생성·리깅)
    scottish_fold: { body: 'ai', file: 'ai/scottish_fold.glb' }, // AI 접힌귀형 기본 모델
    munchkin: { body: 'ai', file: 'ai/munchkin.glb' }, // AI 짧은다리형 기본 모델
    maine_coon: { body: 'longhair' },
    bengal: { body: 'standard' },
    sphynx: { body: 'standard', ears: 1.35 },
    ragdoll: { body: 'longhair' },
    norwegian_forest: { body: 'longhair' },
    turkish_angora: { body: 'longhair' },
    korean_cheese: { body: 'ai', file: 'ai/korean_cheese.glb' },
    korean_tabby: { body: 'standard' },
    korean_calico: { body: 'standard' },
    korean_tuxedo: { body: 'standard' },
    american_shorthair: { body: 'standard' },
    boss: { body: 'standard' },
  };
  /**
   * 체형 키 → 불러온 glb 컨테이너 (불러오기에 실패한 체형은 없음).
   * @type {Object<string, BABYLON.AssetContainer>}
   */
  const containers = {};
  /**
   * 품종 → 컨테이너 키 (ai 체형은 파일마다 따로, 그 밖엔 체형 키).
   * @param {string} breed 품종 키
   * @param {string} [body] 체형 키 (없으면 품종이 정한 체형)
   * @returns {string}
   */
  const ckey = (breed, body) => { const b = body || (BREEDS[breed] && BREEDS[breed].body); return b === 'ai' ? 'ai:' + (BREEDS[breed] && BREEDS[breed].file) : b; };
  /**
   * ai 체형 동작 이름 → 모델이 가진 동작 그룹 (pick 결과를 힉스필드 동작으로 옮김). 없는 것은 idle.
   * @type {Object<string, string>}
   */
  const AI_CLIP = { carry: 'walk', walk4: 'walk', drink: 'sit', sit_talk: 'sit', sleep: 'sit', sit_up: 'sit', roll: 'sit', groom: 'idle', skate: 'walk', hold: 'idle' };
  /**
   * ai 체형 뼈 이름 별칭 → 실제 뼈 ('mixamorig:' 접두어와 대소문자를 뗀 이름). 소품·클릭 위치·말풍선 기준점 참조용이며 뼈 회전 보정에는 쓰지 않는다.
   * @type {Object<string, string>}
   */
  const AI_ALIAS = { head: 'head', neck: 'neck', chest: 'spine2', spine: 'spine1', root: 'hips', 'upper_arm.L': 'leftarm', 'upper_arm.R': 'rightarm', 'forearm.L': 'leftforearm', 'forearm.R': 'rightforearm', 'hand.L': 'lefthand', 'hand.R': 'righthand', 'thigh.L': 'leftupleg', 'thigh.R': 'rightupleg', 'shin.L': 'leftleg', 'shin.R': 'rightleg', 'foot.L': 'leftfoot', 'foot.R': 'rightfoot' };
  /** 체형별 추가 동작(스케이트·발라당) 원본 — attach 가 고양이마다 뼈 이름으로 이어 붙인다 */
  const extraAnims = {};
  /**
   * 체형별 꼬리 뿌리 꺾임 중심 (모델 공간 좌표 m, fixRumpWeights 가 구함).
   * @type {Object<string, BABYLON.Vector3>}
   */
  const tailRing = {}; // 체형별 꼬리 뿌리 꺾임 중심 (모델 공간, fixRumpWeights 가 구함)
  /**
   * 품종 털 재질 캐시: '<체형>:<품종>' → StandardMaterial.
   * @type {Map<string, BABYLON.StandardMaterial>}
   */
  const mats = new Map();

  /**
   * 꼬리 뿌리 살갗 손질 (모양·UV 는 그대로, 뼈 가중치만 고친다. 모델 파일은 건드리지 않는다)
   * 1) 엉덩이 윗면 정점이 허리·가슴 뼈에 0.4 가까이 묶여 있어, 허리를 젖히거나 숙이면 꼬리 뿌리와 길게 찢어진다 → 그 가중치를 엉덩이 뼈로 옮긴다
   * 2) 꼬리 첫 마디 뼈는 뿌리 고리에서 갑자기 100% 로 돌아, 마디를 크게 꺾으면(서기 때 거의 수직으로 내림) 몸과 꼬리 사이 면이
   *    뾰족하게 찢어진다 → 고리에서 마디 길이 45% 까지는 엉덩이 뼈 가중치를 섞어 서서히 꺾이게 한다
   * 순서: 첫·둘째 마디 살의 무게중심으로 꼬리 방향 d·마디 길이 L 을 구하고 → 고리 중심을 찾고 → 반경 0.14 m 안 정점의 가중치를 고친다.
   * 필수 뼈(hips, tail_01, tail_02)나 정점 데이터가 없거나 정점이 뼈 8개 이상(Extra 버퍼)을 쓰면 null.
   * @param {BABYLON.Mesh} mesh 뼈대(skeleton)가 붙은 몸 메시 (정점 가중치가 제자리에서 바뀐다)
   * @returns {BABYLON.Vector3|null} 꼬리 뿌리 고리 중심(회전 중심으로 삼을 자리, 모델 공간) 또는 null
   */
  function fixRumpWeights(mesh) {
    const VB = BABYLON.VertexBuffer;
    const names = mesh.skeleton.bones.map((b) => b.name);
    const hip = names.indexOf('hips'), t1 = names.indexOf('tail_01'), t2 = names.indexOf('tail_02');
    if (hip < 0 || t1 < 0 || t2 < 0) return null;
    const pos = mesh.getVerticesData(VB.PositionKind);
    const ids = mesh.getVerticesData(VB.MatricesIndicesKind);
    const w = mesh.getVerticesData(VB.MatricesWeightsKind);
    if (!pos || !ids || !w || mesh.getVerticesData(VB.MatricesIndicesExtraKind)) return null;
    const N = pos.length / 3;
    /**
     * 정점 i 가 뼈 bone 에 받는 가중치 합 (슬롯 4개 중 그 뼈를 가리키는 것들).
     * @param {number} i 정점 번호
     * @param {number} bone 뼈 번호
     * @returns {number} 0~1 가중치
     */
    const wOf = (i, bone) => { let s = 0; for (let j = 0; j < 4; j++) if (ids[i * 4 + j] === bone) s += w[i * 4 + j]; return s; };
    /**
     * 정점 i 의 모델 공간 위치.
     * @param {number} i 정점 번호
     * @returns {BABYLON.Vector3} 위치(m)
     */
    const vert = (i) => new V3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    // 첫 마디·둘째 마디 살의 무게중심 → 꼬리 방향 d 와 마디 길이 L
    const c1 = new V3(0, 0, 0), c2 = new V3(0, 0, 0); let n1 = 0, n2 = 0;
    for (let i = 0; i < N; i++) {
      if (wOf(i, t1) > 0.5) { c1.addInPlace(vert(i)); n1++; }
      if (wOf(i, t2) > 0.5) { c2.addInPlace(vert(i)); n2++; }
    }
    if (!n1 || !n2) return null;
    c1.scaleInPlace(1 / n1); c2.scaleInPlace(1 / n2);
    const L = V3.Distance(c1, c2), d = c2.subtract(c1).normalize();
    // 고리: 첫 마디 살 중 꼬리 쪽으로 가장 덜 나간 정점들의 중심
    let smin = Infinity, wmax = 0;
    const sOf = new Float32Array(N);
    for (let i = 0; i < N; i++) wmax = Math.max(wmax, wOf(i, t1));
    const thr = Math.min(0.8, wmax * 0.9); // 접힌귀형은 첫 마디 가중치가 낮게 퍼져 있다
    for (let i = 0; i < N; i++) { sOf[i] = V3.Dot(vert(i).subtract(c1), d); if (wOf(i, t1) > thr) smin = Math.min(smin, sOf[i]); }
    const ring = new V3(0, 0, 0); let nr = 0;
    for (let i = 0; i < N; i++) if (wOf(i, t1) > thr && sOf[i] < smin + 0.02) { ring.addInPlace(vert(i)); nr++; }
    if (!nr) return null;
    ring.scaleInPlace(1 / nr);
    const Z = L * 0.45;
    // 반경: 고리 가까이만 손질 (몸통 다른 곳은 그대로)
    const R2 = 0.14 * 0.14;
    const move = new Set(['spine', 'chest', 'neck'].map((n) => names.indexOf(n)).filter((i) => i >= 0));
    let changed = false;
    for (let i = 0; i < N; i++) {
      const near = V3.DistanceSquared(vert(i), ring) <= R2;
      // 1) 엉덩이 윗면: 허리·가슴 가중치 → 엉덩이
      if (near) for (let j = 0; j < 4; j++) if (w[i * 4 + j] > 0 && move.has(ids[i * 4 + j])) { ids[i * 4 + j] = hip; changed = true; }
      // 2) 고리 근처 꼬리 살: 첫 마디 가중치 일부를 엉덩이로 (고리 0% → 고리+Z 에서 원래 값)
      const w1 = wOf(i, t1);
      if (w1 > 0 && near) {
        const f = Math.max(0, Math.min(1, (sOf[i] - smin) / Z));
        if (f >= 1) continue;
        const give = w1 * (1 - f);
        let slotHip = -1, slotFree = -1;
        for (let j = 0; j < 4; j++) { if (ids[i * 4 + j] === hip && w[i * 4 + j] > 0) slotHip = j; if (w[i * 4 + j] <= 0 && slotFree < 0) slotFree = j; }
        const slot = slotHip >= 0 ? slotHip : slotFree;
        if (slot < 0) continue;
        for (let j = 0; j < 4; j++) if (ids[i * 4 + j] === t1) w[i * 4 + j] *= f;
        if (slotHip < 0) ids[i * 4 + slot] = hip;
        w[i * 4 + slot] += give;
        changed = true;
      }
    }
    if (changed) {
      mesh.setVerticesData(VB.MatricesIndicesKind, ids, false, 4);
      mesh.setVerticesData(VB.MatricesWeightsKind, w, false, 4);
    }
    return ring.add(d.scale(Z * 0.5)); // 꺾이는 중심은 섞는 구간 가운데쯤
  }

  /**
   * 체형 하나의 glb 를 불러 containers[body] 에 넣는다.
   * 꼬리 4마디·귀 2개의 동작 트랙은 지워(코드가 직접 움직임) 두고, 뼈대 메시마다 fixRumpWeights 로 꼬리 뿌리를 손질해 첫 결과를 tailRing 에 둔다.
   * 실패하면 경고만 남기고 넘어간다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} body 체형 키 (BODIES 의 키)
   * @returns {Promise<void>}
   * @see fixRumpWeights
   */
  /**
   * 눈 그림 칸 (털 무늬 1024px 기준). scripts/paint-cat-face.mjs 의 EYE_RECT 와 같아야 한다 — 그 스크립트가 품종마다 이 칸에 홍채·동공·반짝임을 그린다.
   * @type {{x:number, y:number, w:number, h:number}}
   */
  const EYE_RECT = { x: 980, y: 24, w: 36, h: 54 };
  /**
   * 눈 조각의 UV 를 눈 그림 칸으로 편다(모델 파일은 그대로, 불러온 뒤 한 번).
   * 모델의 눈은 따로 떨어진 타원 조각이고 UV 가 색 띠의 한 점(u > 0.94, v 0.58~0.72)을 가리켜 단색이었다.
   * 왼쪽·오른쪽 눈(정점 x 부호)마다 앞에서 본 x·y 범위를 칸 안으로 옮겨, 눈 하나에 칸 그림 하나가 앞모습 그대로 입혀지게 한다.
   * 같은 체형의 고양이는 이 기하를 함께 쓰므로 체형마다 한 번이면 된다.
   * @param {BABYLON.AbstractMesh} mesh 체형 메시
   * @returns {void}
   */
  function remapEyeUV(mesh) {
    if (!mesh.getVerticesData) return;
    const uv = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind), pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    if (!uv || !pos) return;
    const sides = [[], []];
    for (let i = 0; i < uv.length / 2; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1];
      if (u > 0.94 && v > 0.58 && v < 0.72) sides[pos[i * 3] < 0 ? 0 : 1].push(i);
    }
    if (!sides[0].length || !sides[1].length) return;
    for (const ids of sides) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of ids) { x0 = Math.min(x0, pos[i * 3]); x1 = Math.max(x1, pos[i * 3]); y0 = Math.min(y0, pos[i * 3 + 1]); y1 = Math.max(y1, pos[i * 3 + 1]); }
      let z1 = -Infinity;
      for (const i of ids) z1 = Math.max(z1, pos[i * 3 + 2]);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (const i of ids) {
        const nu = (pos[i * 3] - x0) / (x1 - x0 || 1), nv = (pos[i * 3 + 1] - y0) / (y1 - y0 || 1);
        uv[i * 2] = (EYE_RECT.x + 0.5 + nu * (EYE_RECT.w - 1)) / 1024;
        uv[i * 2 + 1] = (EYE_RECT.y + 0.5 + (1 - nv) * (EYE_RECT.h - 1)) / 1024; // 무늬는 위가 v 0 — 눈 위쪽이 칸 위쪽
        // 눈 키우기: 눈 가운데 기준으로 가로·세로를 EYE_SCALE 배. 가장자리가 얼굴 곡면에 묻히지 않게 바깥쪽일수록 조금 앞으로(z) 낸다
        const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy;
        const edge = Math.min(1, Math.hypot(dx / ((x1 - x0) / 2 || 1), dy / ((y1 - y0) / 2 || 1)));
        pos[i * 3] = cx + dx * EYE_SCALE;
        pos[i * 3 + 1] = cy + dy * EYE_SCALE;
        pos[i * 3 + 2] += EYE_LIFT * edge * edge;
      }
    }
    mesh.setVerticesData(BABYLON.VertexBuffer.UVKind, uv, false);
    mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, pos, false);
    mesh.refreshBoundingInfo && mesh.refreshBoundingInfo(true);
  }
  /** 눈 크기 배율(모델 원래 눈 대비)과 가장자리 앞으로 내기(m) — remapEyeUV */
  const EYE_SCALE = 1.3, EYE_LIFT = 0.012;
  /** 목 둘레 배율(1 = 모델 그대로) — slimNeck */
  const NECK = 0.8;
  /**
   * 목 둘레 줄이기(사용자 2026-11-25 "목이 너무 두껍다"): 목 뼈 가중치가 있는 정점을 목 가운데 축(x 0, 목 가중 평균 z) 쪽으로 당긴다.
   * 가중치만큼만 당겨 머리·가슴 쪽 이음새는 부드럽게 이어진다. 높이(y)는 그대로. 모델 파일은 그대로, 체형마다 한 번.
   * @param {BABYLON.AbstractMesh} mesh 체형 메시(뼈대 있음)
   * @returns {void}
   */
  function slimNeck(mesh) {
    if (NECK === 1 || !mesh.skeleton || !mesh.getVerticesData) return;
    const bi = mesh.skeleton.getBoneIndexByName('neck');
    const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const mi = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsKind);
    if (bi < 0 || !pos || !mi || !mw) return;
    const n = pos.length / 3, w = new Float32Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) if (mi[i * 4 + j] === bi) w[i] += mw[i * 4 + j];
    // 목 가중치는 머리·가슴과 나눠 가져 0.6 을 넘는 정점이 없다 → 가장 큰 목 가중치로 나눠 0~1 로 맞추고, 축 z 는 가중 평균
    let cz = 0, cw = 0, wmax = 0;
    for (let i = 0; i < n; i++) { wmax = Math.max(wmax, w[i]); if (w[i] > 0.02) { cz += pos[i * 3 + 2] * w[i]; cw += w[i]; } }
    if (!cw || !wmax) return;
    cz /= cw;
    for (let i = 0; i < n; i++) {
      if (w[i] < 0.02) continue;
      const f = 1 - (1 - NECK) * Math.min(1, w[i] / wmax);
      pos[i * 3] *= f;
      pos[i * 3 + 2] = cz + (pos[i * 3 + 2] - cz) * f;
    }
    mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, pos, false);
  }
  /** 위팔 뼈 좌우 위치 배율(1 = 모델 그대로) — attach 의 어깨 좁히기 */
  const SHOULDER = 0.66; // 사용자 2026-11-25: 0.82 에서 다시 80% 로

  /**
   * 체형 → 얼굴 정보(모델 공간 = 정점 좌표): 코끝, 입 선(ω) 경로, 혀 뿌리 자리·방향, 크기 기준(눈 너비). faceGeo 가 채우고 makeMouth 가 쓴다.
   * @type {Object<string, {nose:number[], mouth:number[][], tongueAt:number[], tongueDir:number[], ew:number}>}
   */
  const face = {};
  /**
   * 코 아래 입 선(ω)·혀 자리를 구해 face[body] 에 둔다(체형마다 한 번, remapEyeUV 다음). 코 안의 분홍은 무늬에 그린다(scripts/paint-cat-face.mjs).
   * 코 = 색 띠 어두운 칸(u > 0.94, v > 0.88)을 쓰는 정점 중 가운데(|x| < 0.04, 코 테두리) — 바깥쪽 같은 칸 정점은 수염.
   * 입 선은 코 아래 두 개의 아래 반원(ω)과 코에서 내려오는 짧은 세로선. 점마다 가까운 얼굴 정점의 가장 앞(z)에 살짝 띄워 얼굴 곡면을 따른다.
   * @param {BABYLON.AbstractMesh} mesh 체형 메시
   * @param {string} body 체형 키
   * @returns {void}
   */
  function faceGeo(mesh, body) {
    if (!mesh.getVerticesData) return;
    const uv = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind), pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    if (!uv || !pos) return;
    const n = uv.length / 2, nose = [];
    let ex0 = Infinity, ex1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1], x = pos[i * 3];
      if (u > 0.94 && v > 0.88 && Math.abs(x) < 0.04) nose.push(i);
      if (u > 0.95 && v * 1024 > EYE_RECT.y - 1 && v * 1024 < EYE_RECT.y + EYE_RECT.h + 1 && x > 0) { ex0 = Math.min(ex0, x); ex1 = Math.max(ex1, x); } // 오른눈 너비(펴 둔 UV 로 찾음)
    }
    if (!nose.length) return;
    let tip = nose[0], ny0 = Infinity;
    for (const i of nose) {
      if (pos[i * 3 + 2] > pos[tip * 3 + 2]) tip = i;
      ny0 = Math.min(ny0, pos[i * 3 + 1]);
    }
    const T = [pos[tip * 3], pos[tip * 3 + 1], pos[tip * 3 + 2]];
    const ew = isFinite(ex1 - ex0) && ex1 > ex0 ? ex1 - ex0 : 0.07;
    // 얼굴 겉면 높이: (x, y) 근처(반지름 rr) 얼굴 정점 중 가장 앞의 z. 코·눈 조각은 뺀다
    const rr = ew * 0.09;
    const zAt = (x, y) => {
      let z = -Infinity;
      for (let i = 0; i < n; i++) {
        if (uv[i * 2] > 0.94) continue;
        const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
        if (pz < T[2] - 0.08 || Math.abs(px - x) > rr || Math.abs(py - y) > rr) continue;
        if (pz > z) z = pz;
      }
      return isFinite(z) ? z : T[2] - 0.01;
    };
    const r = ew * 0.17, y0 = ny0 - ew * 0.24; // ω 반원 반지름, 반원 윗줄 높이(코 밑에서 조금 아래)
    // ω: 왼끝(-2r) → 가운데(0) → 오른끝(+2r). 반원마다 가운데가 아래로 처진다(a: π → 2π 의 sin 은 음수)
    const omega = [];
    for (let k = 0; k <= 16; k++) {
      const s = k <= 8 ? -1 : 1, j = k <= 8 ? k : k - 8; // 왼 반원 0..8, 오른 반원 1..8 (가운데 점 한 번만)
      const a = Math.PI + (Math.PI * j) / 8;
      omega.push([s * r + r * Math.cos(a), y0 + r * Math.sin(a), 0]);
    }
    const lift = ew * 0.03;
    const place = (p) => [p[0], p[1], zAt(p[0], p[1]) + lift];
    face[body] = {
      nose: T,
      philtrum: [[0, ny0 - ew * 0.02, 0], [0, y0, 0]].map(place), // 코에서 내려오는 세로선
      mouth: omega.map(place),
      tongueAt: [0, y0 - r * 0.6, zAt(0, y0 - r * 0.6) - ew * 0.06],
      tongueDir: [0, -0.45, 1],
      ew,
    };
  }

  /** 입·혀 재질(모든 고양이 공유) */
  let mouthMat = null, tongueMat = null, mouthInMat = null;
  /**
   * 입 선(ω·세로선)과 혀를 머리 뼈에 붙인다. 혀는 입 안에 숨어 있다가 tongue() 로 내민다.
   * 위치는 face[body](모델 공간)를 머리 뼈 국소 좌표로 옮겨 놓는다 — 머리를 따라 움직임.
   * @param {BABYLON.Scene} scene 장면
   * @param {Cat} cat 고양이
   * @param {CatModelInfo} model 모델 정보 (model.tongue 가 채워짐)
   * @param {string} body 체형 키
   * @returns {void}
   */
  /**
   * AI 모델(Tripo 등)의 입 자리를 메시에서 찾는다: 코끝(가운데 세로줄에서 가장 앞) → 그 조금 아래 얼굴 겉면이 입.
   * 결과는 face[key] = { ai, mouthAt, tongueAt, tongueDir, ew } (모델 공간). makeMouth 가 입 속·혀를 머리 뼈에 붙인다.
   * @param {BABYLON.AbstractMesh} mesh 뼈대 있는 메시
   * @param {string} key 컨테이너 키
   * @returns {void}
   */
  function faceAI(mesh, key) {
    const pos = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const mi = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData && mesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsKind);
    if (!pos || !mi || !mw || !mesh.skeleton) return;
    const hb = mesh.skeleton.bones.findIndex((b) => /(^|:)Head$/i.test(b.name));
    // 머리 뼈에 주로 묶인 정점 = 머리. 털이 긴 품종은 이마·정수리 털이 가장 앞으로 나오므로, 코는 머리 높이의 아래쪽 10~35% 에서만 찾는다(장모종은 50% 높이 이마 털이 코보다 앞으로 나옴)
    const isHead = (v) => { let w = 0; for (let j = 0; j < 4; j++) if (mi[v * 4 + j] === hb) w += mw[v * 4 + j]; return w > 0.5; };
    let y0 = Infinity, y1 = -Infinity, hx0 = Infinity, hx1 = -Infinity;
    for (let v = 0; v < pos.length / 3; v++) if (isHead(v)) { const x = pos[v * 3], y = pos[v * 3 + 1]; y0 = Math.min(y0, y); y1 = Math.max(y1, y); hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); }
    if (!isFinite(y0)) return;
    const H = y1 - y0, ew = (hx1 - hx0) * 0.16; // 눈 하나 너비 정도(크기 기준)
    let nose = -1;
    for (let v = 0; v < pos.length / 3; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (Math.abs(x) < 0.015 && y > y0 + H * 0.1 && y < y0 + H * 0.35 && isHead(v) && (nose < 0 || z > pos[nose * 3 + 2])) nose = v;
    }
    if (nose < 0) return;
    const ny = pos[nose * 3 + 1];
    let mz = -Infinity, my = ny - ew * 0.35;
    for (let v = 0; v < pos.length / 3; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (Math.abs(x - pos[nose * 3]) < ew * 0.15 && y < ny - ew * 0.2 && y > ny - ew * 0.55 && z > mz) { mz = z; my = y; }
    }
    if (!isFinite(mz)) mz = pos[nose * 3 + 2] - ew * 0.1;
    const nx = pos[nose * 3]; // 얼굴이 정가운데가 아닐 수 있어(장모종) 코의 좌우 위치에 맞춘다
    face[key] = { ai: true, mouthAt: [nx, my, mz + ew * 0.05], tongueAt: [nx, my, mz - ew * 0.05], tongueDir: [0, -0.35, 1], ew };
  }
  /** 입 벌리기 0(닫힘)~1. AI 모델은 입 속(어두운 빨강 타원)을 세로로 키워 벌린 입처럼 보인다(옛 모델은 입 선이 그대로라 무시) */
  function mouthOpen(cat, k) {
    const mo = cat.model && cat.model.mouthIn;
    if (!mo) return;
    const on = k > 0.03;
    if (mo.isEnabled() !== on) mo.setEnabled(on);
    if (on) mo.scaling.y = mo.metadata.h * k;
  }
  function makeMouth(scene, cat, model, body) {
    const f = face[model.ckey || body] || face[body], head = model.nodes.head, top = model.top;
    if (!f || !head || !top) return;
    const chain = [];
    for (let nd = head; nd; nd = nd.parent) chain.unshift(nd);
    for (const nd of chain) nd.computeWorldMatrix(true);
    const W = top.getWorldMatrix(), Hinv = BABYLON.Matrix.Invert(head.getWorldMatrix());
    const toHead = (p) => V3.TransformCoordinates(V3.TransformCoordinates(new V3(p[0], p[1], p[2]), W), Hinv);
    if (!mouthMat) {
      mouthMat = new BABYLON.StandardMaterial('cat:mouth', scene);
      mouthMat.diffuseColor = BABYLON.Color3.FromHexString('#3a2523');
      mouthMat.specularColor = new BABYLON.Color3(0, 0, 0);
      mouthMat.metadata = { shared: true };
      tongueMat = new BABYLON.StandardMaterial('cat:tongue', scene);
      tongueMat.diffuseColor = BABYLON.Color3.FromHexString('#f07f93');
      tongueMat.specularColor = new BABYLON.Color3(0.25, 0.18, 0.2);
      tongueMat.metadata = { shared: true };
    }
    const rad = f.ew * 0.03;
    if (f.ai) {
      // AI 모델: 입 선은 무늬에 이미 그려져 있다 → 벌릴 때 보이는 입 속(어두운 빨강 납작한 타원)만 입 자리에 붙인다(평소엔 숨김)
      if (!mouthInMat) {
        mouthInMat = new BABYLON.StandardMaterial('cat:mouthIn', scene);
        mouthInMat.diffuseColor = BABYLON.Color3.FromHexString('#6b2433'); mouthInMat.specularColor = new BABYLON.Color3(0.05, 0.02, 0.03); mouthInMat.metadata = { shared: true };
      }
      const mi = BABYLON.MeshBuilder.CreateSphere(`${cat.id}:mouthIn`, { segments: 8 }, scene);
      mi.parent = head; mi.position = toHead(f.mouthAt);
      const h = f.ew * 0.42;
      mi.scaling.set(f.ew * 0.55, h, f.ew * 0.14);
      mi.metadata = { h };
      mi.material = mouthInMat; mi.isPickable = false;
      mi.setEnabled(false);
      model.mouthIn = mi;
    }
    const lines = (f.ai ? [] : [f.philtrum, f.mouth]).map((pts, i) => {
      const tube = BABYLON.MeshBuilder.CreateTube(`${cat.id}:mouth${i}`, { path: pts.map(toHead), radius: rad, tessellation: 6, cap: BABYLON.Mesh.CAP_ALL }, scene);
      tube.material = mouthMat; tube.parent = head; tube.isPickable = false;
      return tube;
    });
    // 혀: 뿌리(root)를 입 안에 두고 앞(+z)으로 뻗는 납작한 타원체. root 의 z 크기로 내밀기
    const root = new BABYLON.TransformNode(`${cat.id}:tongueRoot`, scene);
    root.parent = head;
    root.position = toHead(f.tongueAt);
    const dir = toHead([f.tongueAt[0] + f.tongueDir[0], f.tongueAt[1] + f.tongueDir[1], f.tongueAt[2] + f.tongueDir[2]]).subtract(root.position).normalize();
    const base = new Q();
    Q.FromUnitVectorsToRef(V3.Forward(), dir, base);
    root.rotationQuaternion = base.clone();
    const len = f.ew * 0.62, wid = f.ew * 0.42;
    const tg = BABYLON.MeshBuilder.CreateSphere(`${cat.id}:tongue`, { segments: 10 }, scene);
    tg.scaling.set(wid, f.ew * 0.11, len);
    tg.position.z = len * 0.5;
    tg.parent = root; tg.material = tongueMat; tg.isPickable = false;
    root.setEnabled(false);
    model.mouth = lines;
    model.tongue = { root, base, k: 0 };
  }
  /**
   * 혀 내밀기. k 0(숨김)~1(다 내밂), flick 은 혀끝을 위아래로 튕기는 각도(rad, 핥기).
   * @param {Cat} cat 고양이 (cat.model.tongue)
   * @param {number} k 내민 정도 0~1
   * @param {number} [flick=0] 위(-)·아래(+) 튕김 각도(rad)
   * @returns {void}
   */
  function tongue(cat, k, flick = 0) {
    const t = cat.model && cat.model.tongue;
    if (!t) return;
    t.k = k;
    const on = k > 0.02;
    if (t.root.isEnabled() !== on) t.root.setEnabled(on);
    if (!on) return;
    t.root.scaling.set(0.7 + 0.3 * k, 1, k);
    t.root.rotationQuaternion = t.base.multiply(Q.RotationAxis(V3.Right(), flick));
  }
  async function load(scene, body, key = body, file = BODIES[body].file) {
    try {
      const c = await BABYLON.LoadAssetContainerAsync(DIR + file, scene);
      if (BODIES[body].ai) { // 자체 텍스처·재질을 그대로 쓴다: 손질·추가 동작 없음. 재질은 고양이끼리 공유하므로 지울 때 같이 지우지 않게 표시
        c.materials.forEach((m) => { m.metadata = { ...(m.metadata || {}), shared: true }; });
        for (const me of c.meshes) if (me.skeleton && !face[key]) faceAI(me, key);
        containers[key] = c;
        return;
      }
      // 꼬리·귀 트랙은 지운다 (코드가 직접 움직임)
      for (const g of c.animationGroups) {
        for (const ta of g.targetedAnimations.slice()) {
          if (/^(tail_0\d|ear\.[LR])$/.test(ta.target && ta.target.name)) g.removeTargetedAnimation(ta.animation);
        }
      }
      for (const me of c.meshes) if (me.skeleton) { const p = fixRumpWeights(me); if (p && !tailRing[body]) tailRing[body] = p; }
      for (const me of c.meshes) { remapEyeUV(me); faceGeo(me, body); slimNeck(me); }
      containers[key] = c;
      // 추가 동작(스케이트·발라당): Blender assets/cats/hi3d/extra_actions.py 로 체형마다 만든 뼈대+동작 파일. 꼬리·귀 트랙은 같은 이유로 지운다
      try {
        const a = await BABYLON.LoadAssetContainerAsync(DIR + 'anims_' + body + '.glb', scene);
        for (const g of a.animationGroups) for (const ta of g.targetedAnimations.slice()) if (/^(tail_0\d|ear\.[LR])$/.test(ta.target && ta.target.name)) g.removeTargetedAnimation(ta.animation);
        extraAnims[body] = a.animationGroups;
      } catch (e) { console.warn(`추가 동작(${body})을 불러오지 못했습니다`, e && e.message); }
    } catch (e) {
      console.warn(`고양이 모델(${body})을 불러오지 못했습니다`, e && e.message);
    }
  }
  /**
   * 모든 체형 모델을 한꺼번에 미리 불러온다. 이미 일반형이 있으면 아무것도 안 한다.
   * 일반형(standard)이 없으면 경고하고 false — 이 경우 OfficeCat 이 임시 모형을 쓴다.
   * @param {BABYLON.Scene} scene 장면
   * @returns {Promise<boolean>} 일반형 모델이 준비됐으면 true
   * @see load
   */
  async function preload(scene) {
    if (containers.standard) return true;
    const aiFiles = [...new Set(Object.values(BREEDS).filter((b) => b.body === 'ai').map((b) => b.file))];
    await Promise.all(Object.keys(BODIES).filter((b) => !BODIES[b].ai).map((b) => load(scene, b)).concat(aiFiles.map((f) => load(scene, 'ai', 'ai:' + f, f))).concat([
      BABYLON.LoadAssetContainerAsync('models/props/skate.glb', scene).then((c) => { skateC = c; c.materials.forEach((m) => { m.metadata = { ...(m.metadata || {}), shared: true }; }); }, // 스케이트 재질은 모든 고양이가 함께 쓴다 — 고양이 하나 지울 때 같이 지우면 안 됨(cat.js remove)
        (e) => console.warn('스케이트 모델을 불러오지 못했습니다', e && e.message)),
    ]));
    if (!containers.standard) console.warn('일반형 모델이 없어 임시 모형을 씁니다');
    return !!containers.standard;
  }
  /**
   * 3D 모델을 쓸 수 있는가 (일반형 모델이 불러와졌는가).
   * @returns {boolean}
   */
  const ready = () => !!containers.standard;
  /**
   * 불러온 체형 키 목록 (BODIES 에 적힌 정해진 순서, 불러온 순서와 무관).
   * @returns {string[]}
   */
  const bodies = () => Object.keys(BODIES).filter((b) => containers[b] || (b === 'ai' && Object.keys(containers).some((k) => k.startsWith('ai:')))); // 정해진 순서 (불러온 순서와 무관)
  /**
   * 쓸 수 있는 품종 (대표 제외, 체형 모델이 불러와진 것만)
   * @returns {string[]} 품종 키 목록
   */
  const breeds = () => Object.keys(BREEDS).filter((k) => k !== 'boss' && containers[ckey(k)]);
  /**
   * 품종의 한글 이름 (모르는 키는 키 그대로).
   * @param {string} k 품종 키
   * @returns {string}
   */
  const breedName = (k) => (BREEDS[k] ? t('cat.breed.' + k) : k);

  /**
   * 품종 털 재질을 얻는다 (체형·품종 쌍마다 하나, 캐시됨).
   * 품종 PNG 를 UV 채널 0 으로 입히고(invertY 끔, 가장자리 늘이기) 얼려 둔다. 고양이를 지울 때 같이 지우지 않도록 metadata.shared 로 표시한다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} breed 품종 키 (skins/<품종>.webp)
   * @param {string} body 체형 키
   * @returns {BABYLON.StandardMaterial} 공유 재질
   */
  function material(scene, breed, body) {
    const key = body + ':' + breed;
    if (mats.has(key)) return mats.get(key);
    const tex = new BABYLON.Texture(SKIN + breed + '.webp', scene, { invertY: false, samplingMode: BABYLON.Texture.TRILINEAR_SAMPLINGMODE });
    tex.coordinatesIndex = 0;
    tex.wrapU = tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    const m = new BABYLON.StandardMaterial('cat:' + key, scene);
    m.diffuseTexture = tex;
    m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    m.metadata = { shared: true }; // 같은 품종 고양이들이 함께 씀 — 고양이 하나 지울 때 같이 지우면 안 됨
    m.freeze();
    mats.set(key, m);
    return m;
  }

  /**
   * 꼬리 첫 마디 뼈(tail_01) 위치는 꼬리 살 시작보다 앞쪽에 있어, 뼈 위치를 축으로 크게 돌리면 꼬리 뿌리 살이 반대쪽으로 휘둘린다.
   * 꺾임 중심(ring)을 축으로 삼도록, 기본 자세에서 뼈 위치 → 꺾임 중심 벡터(첫 마디 부모 = 엉덩이 뼈 국소 좌표)를 구해 둔다. 못 구하면 null
   * @param {BABYLON.TransformNode} top 모델 최상위 노드 (월드 행렬 역변환 기준)
   * @param {Object<string, BABYLON.TransformNode>} nodes 뼈 이름 → 뼈 노드
   * @param {BABYLON.Vector3} [ring] 꼬리 뿌리 꺾임 중심 (모델 공간, tailRing[체형])
   * @returns {BABYLON.Vector3|null} 뼈 위치 → 꺾임 중심 벡터 (m), 구할 수 없으면 null
   */
  function tailRingOffset(top, nodes, ring) {
    if (!ring || !nodes.tail_01) return null;
    top.computeWorldMatrix(true);
    const inv = BABYLON.Matrix.Invert(top.getWorldMatrix());
    return ring.subtract(V3.TransformCoordinates(nodes.tail_01.getAbsolutePosition(), inv));
  }

  /**
   * cat(OfficeCat 객체)에 모델을 붙인다. 반환: 모델 정보
   * 품종·체형이 모르는 값이면 korean_cheese / standard 로 대신한다. 모델을 인스턴스로 복제해 cat.root 아래에 놓고 (크기 z=-1),
   * 품종 재질을 입히고, 클릭을 받을 보이지 않는 상자(pick:<id>)를 만든다. 뼈 노드·기본 자세·동작 그룹을 모아 두고,
   * 짧은다리형이면 허벅지를 줄이고 몸을 내리며(legDrop), 소품(makeProps)과 대표 넥타이(makeTie)를 만든다.
   * @param {BABYLON.Scene} scene 장면
   * @param {Cat} cat 모델을 붙일 고양이 (cat.id, cat.root 를 읽음)
   * @param {string} breed 품종 키 (BREEDS 에 없으면 korean_cheese)
   * @param {string} [body] 체형 키 (없으면 품종이 정한 체형, 불러오지 못했으면 standard)
   * @returns {CatModelInfo} 모델 정보
   * @see material
   * @see makeProps
   * @see makeTie
   * @see tailRingOffset
   */
  function attach(scene, cat, breed, body) {
    if (!BREEDS[breed]) breed = 'korean_cheese';
    body = body || BREEDS[breed].body;
    const key = ckey(breed, body);
    if (!containers[key]) body = 'standard'; // 불러오지 못했으면 일반형 + 품종 무늬
    const container = containers[body === 'ai' ? key : body];
    const ai = !!BODIES[body].ai;
    const inst = container.instantiateModelsToScene((n) => `${cat.id}:${n}`, false, { doNotInstantiate: true });
    const top = inst.rootNodes[0];
    top.parent = cat.root;
    top.rotationQuaternion = Q.Identity();
    top.scaling.set(1, 1, -1);
    const meshes = top.getChildMeshes();
    const mat = ai ? null : material(scene, breed, body); // ai: 모델 자체 재질 유지
    for (const m of meshes) {
      if (mat) m.material = mat;
      m.isPickable = false; // 뼈대 메시는 기본 자세 기준으로 판정돼 옆 고양이가 잡힘 → 아래 클릭 상자로
      m.metadata = { catId: cat.id };
      m.alwaysSelectAsActiveMesh = false;
    }
    // 클릭 상자: 고양이 자리(root)를 따라다니는 보이지 않는 상자 — 누른 고양이 한 마리만 정확히 잡힌다
    const pick = BABYLON.MeshBuilder.CreateBox('pick:' + cat.id, { width: 0.5, height: 0.92, depth: 0.46 }, scene);
    pick.parent = cat.root;
    pick.position.y = 0.46;
    pick.isVisible = false;
    pick.isPickable = true;
    pick.metadata = { catId: cat.id };
    const nodes = {};
    for (const t of top.getChildTransformNodes(false)) nodes[t.name.replace(cat.id + ':', '')] = t;
    if (ai) {
      const low = {};
      for (const [k, n] of Object.entries(nodes)) low[k.replace(/^mixamorig:/, '').toLowerCase()] = n;
      for (const [a, b] of Object.entries(AI_ALIAS)) if (low[b]) nodes[a] = low[b];
    }
    const rest = {};
    for (const k of ['tail_01', 'tail_02', 'tail_03', 'tail_04', 'ear.L', 'ear.R']) {
      const n = nodes[k];
      if (n) rest[k] = (n.rotationQuaternion || Q.FromEulerVector(n.rotation)).clone();
    }
    const groups = {};
    for (const g of inst.animationGroups) {
      g.stop();
      g.enableBlending = true;
      g.blendingSpeed = 0.12;
      groups[g.name.replace(cat.id + ':', '')] = g;
    }
    // 추가 동작을 이 고양이 뼈에 이어 붙인다(뼈 이름이 같다)
    if (ai) for (const [a, b] of Object.entries(AI_CLIP)) if (!groups[a] && groups[b]) groups[a] = groups[b]; // 동작 이름 별칭 (같은 그룹)
    for (const src of extraAnims[body] || []) {
      const g = src.clone(`${cat.id}:${src.name}`, (t) => nodes[t.name] || null);
      for (const ta of g.targetedAnimations.slice()) if (!ta.target) g.removeTargetedAnimation(ta.animation);
      g.stop(); g.enableBlending = true; g.blendingSpeed = 0.12;
      groups[src.name] = g;
    }
    const ears = BREEDS[breed].ears;
    if (ears) for (const k of ['ear.L', 'ear.R']) if (nodes[k]) nodes[k].scaling.setAll(ears);
    const model = { top, meshes, nodes, rest, groups, anim: null, mat, body, breed, cfg: BODIES[body], legDrop: 0 };
    const k = BODIES[body].legScale;
    if (k && !ai && nodes['thigh.L']) {
      // 줄어든 다리 길이만큼 몸을 내린다 (발이 바닥에 닿게)
      top.computeWorldMatrix(true);
      const inv = BABYLON.Matrix.Invert(cat.root.computeWorldMatrix(true));
      /**
       * 뼈 n 의 높이(고양이 자리 좌표계 y, m).
       * @param {string} n 뼈 이름
       * @returns {number}
       */
      const y = (n) => V3.TransformCoordinates(nodes[n].getAbsolutePosition(), inv).y;
      // 엉덩이 관절 ~ 발목 관절 사이만 줄어든다 (발바닥 두께는 그대로)
      model.legDrop = (y('thigh.L') - (nodes['foot.L'] ? y('foot.L') : 0)) * (1 - k);
      // 동작(애니메이션)이 매 프레임 크기를 1로 되돌리므로, 동작 계산 뒤에 다시 줄인다
      const thighs = [nodes['thigh.L'], nodes['thigh.R']];
      /**
       * 짧은다리형: 동작(애니메이션)이 매 프레임 크기를 1로 되돌리므로 동작 계산 직후 허벅지 크기를 다시 줄이는 콜백.
       * 모델이 지워지면 스스로 관찰을 해제한다.
       * @returns {void}
       */
      const ob = scene.onAfterAnimationsObservable.add(() => {
        if (top.isDisposed()) { scene.onAfterAnimationsObservable.remove(ob); return; }
        for (const n of thighs) n.scaling.set(1, k, 1);
      });
    }
    // 어깨 좁히기(사용자 2026-11-25 "어깨가 너무 넓다"): 위팔 뼈를 몸 가운데 쪽으로 SHOULDER 배. 모델 파일은 그대로.
    // 동작이 뼈 위치를 쓰는 경우 매 프레임 되돌아오므로 동작 계산 직후에 다시 옮긴다(동작이 안 쓰면 처음 값을 기준으로 — 곱이 쌓이지 않게)
    const arms = ['upper_arm.L', 'upper_arm.R'].map((k) => nodes[k]).filter(Boolean).map((n) => ({ n, src: n.position.x, last: NaN }));
    if (arms.length && SHOULDER !== 1 && !ai) {
      const ob = scene.onAfterAnimationsObservable.add(() => {
        if (top.isDisposed()) { scene.onAfterAnimationsObservable.remove(ob); return; }
        for (const a of arms) {
          if (a.n.position.x !== a.last) a.src = a.n.position.x; // 동작이 새로 쓴 값
          a.n.position.x = a.src * SHOULDER;
          a.last = a.n.position.x;
        }
      });
    }
    model.tailPivot = tailRingOffset(top, nodes, tailRing[body]); // 꼬리 첫 마디가 도는 중심을 뼈 위치 → 꼬리 뿌리 고리로 옮기는 벡터 (animate 에서 씀)
    // 소품: 결재판·상자는 몸 앞, 팻말은 오른손
    model.props = makeProps(scene, cat, model);
    if (breed === 'boss') makeTie(scene, cat, model);
    model.ckey = key;
    makeMouth(scene, cat, model, body);
    return model;
  }

  /**
   * 색 상자 하나를 만든다 (소품 부품용: 반사 없음, 클릭 안 잡힘).
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name 메시·재질 이름
   * @param {number} w 가로(m)
   * @param {number} h 높이(m)
   * @param {number} d 깊이(m)
   * @param {string} hex 색 '#rrggbb'
   * @param {BABYLON.TransformNode} parent 붙일 부모
   * @param {number} x 부모 기준 x(m)
   * @param {number} y 부모 기준 y(m)
   * @param {number} z 부모 기준 z(m)
   * @returns {BABYLON.Mesh} 만든 상자
   */
  function box(scene, name, w, h, d, hex, parent, x, y, z) {
    const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    const mt = new BABYLON.StandardMaterial(name, scene);
    mt.diffuseColor = BABYLON.Color3.FromHexString(hex);
    mt.specularColor = BABYLON.Color3.Black();
    m.material = mt;
    m.parent = parent;
    m.position.set(x, y, z);
    m.isPickable = false;
    return m;
  }
  /** 스케이트 크기 배율 (사용자 Blender 배치, assets/props/skate.blend) */
  const SKATE_SCALE = 1.15;
  /** 스케이트 자리: 발목 뼈에서 앞 0.077m · 아래 0.038m (cat.root 기준: 앞 = -Z) */
  const SKATE_OFF = new V3(0, -0.038, -0.077);
  /** 스케이트를 신으면 날이 바닥(얼음)에 닿게 몸을 들어 올리는 높이(m) — 서 있는 자세에서 날 밑이 바닥 아래 0.064m */
  const SKATE_LIFT = 0.064;
  /** 스케이트 모델 (preload 가 불러 둠, 없으면 스케이트를 그리지 않음) */
  let skateC = null;
  /**
   * 소품을 만들고 모두 꺼 둔다: 결재판·상자는 몸 앞(front 노드), 팻말은 오른손 뼈(없으면 root 에 고정 위치), 책·스케이트는 trackGear 가 손·발 자리로 옮긴다.
   * front 노드는 animate 가 입에 무는 자세 등에서 위치·배율을 바꾼다.
   * @param {BABYLON.Scene} scene 장면
   * @param {Cat} cat 소품을 붙일 고양이
   * @param {CatModelInfo} model 모델 정보 (nodes['hand.R'] 를 읽음)
   * @returns {CatProps} { board, box, sign } 소품 노드
   * @see box
   */
  function makeProps(scene, cat, model) {
    const front = new BABYLON.TransformNode(cat.id + ':propFront', scene);
    front.parent = cat.root;
    const board = new BABYLON.TransformNode('board', scene); board.parent = front; board.position.set(0, 0.36, -0.24); board.rotation.x = -0.35;
    box(scene, 'b1', 0.2, 0.26, 0.015, '#b98f63', board, 0, 0, 0);
    box(scene, 'b2', 0.17, 0.21, 0.005, '#fbfaf6', board, 0, -0.01, -0.01);
    box(scene, 'b3', 0.08, 0.03, 0.02, '#a7adb8', board, 0, 0.12, -0.012);
    const crate = new BABYLON.TransformNode('box', scene); crate.parent = front; crate.position.set(0, 0.36, -0.3);
    box(scene, 'c1', 0.3, 0.22, 0.24, '#d9b07c', crate, 0, 0, 0);
    box(scene, 'c2', 0.31, 0.03, 0.06, '#c99558', crate, 0, 0.11, 0);
    const sign = new BABYLON.TransformNode('sign', scene);
    const hand = model.nodes['hand.R'];
    sign.parent = hand || cat.root;
    if (!hand) sign.position.set(-0.3, 0.9, -0.1);
    box(scene, 's1', 0.025, 0.3, 0.025, '#8a6a4a', sign, 0, 0.12, 0);
    box(scene, 's2', 0.3, 0.2, 0.02, '#fff4dc', sign, 0, 0.32, 0);
    box(scene, 's3', 0.05, 0.1, 0.004, '#3b3f4a', sign, 0, 0.32, -0.013);
    const props = { board, box: crate, sign };
    for (const p of Object.values(props)) p.setEnabled(false);
    // 책(읽는 중)·스케이트(얼음 위)는 cat.prop 이 아니라 하는 일·상태로 켜고, 매 프레임 손·발 뼈 자리로 옮긴다(trackGear)
    // 책: 책등을 축으로 왼쪽(bL)·오른쪽(bR) 반쪽이 165°쯤 펼쳐진다(각 7.5° 꺾임). 종이 묶음은 두께가 있고, 책등 쪽은 종이가 더 꺾여 들어간 주름(골),
    // 등 바깥은 둥근 책등. 덮으면 오른쪽 반이 접혀 올라간 두꺼운 책(shut 표지·옆 책등). 넘기는 한 장(flip). 상태는 trackGear 가 정한다
    const COVER = '#7a3b3b', PAPER = '#f7f3e8';
    const book = new BABYLON.TransformNode('book', scene); book.parent = cat.root;
    const bL = new BABYLON.TransformNode('bookL', scene); bL.parent = book;
    const bR = new BABYLON.TransformNode('bookR', scene); bR.parent = book;
    for (const [node, sx] of [[bL, -1], [bR, 1]]) {
      box(scene, 'bk_cover', 0.13, 0.17, 0.008, COVER, node, sx * 0.065, 0, 0); // 표지
      box(scene, 'bk_pages', 0.112, 0.155, 0.018, PAPER, node, sx * 0.068, 0, 0.013); // 종이 묶음(두께)
      const g = box(scene, 'bk_gutter', 0.016, 0.155, 0.014, '#ece6d6', node, sx * 0.01, 0, 0.009); // 책등 쪽 주름(골): 더 꺾여 들어감
      g.rotation.y = sx * 0.35;
    }
    const spine = BABYLON.MeshBuilder.CreateCylinder('bk_spine', { diameter: 0.026, height: 0.17, tessellation: 12, arc: 0.5 }, scene); // 둥근 책등(바깥)
    spine.parent = book; spine.position.z = -0.002; spine.rotation.y = Math.PI / 2; spine.isPickable = false;
    const sm = new BABYLON.StandardMaterial('bk_spine', scene); sm.diffuseColor = BABYLON.Color3.FromHexString('#5f2c2c'); sm.specularColor = BABYLON.Color3.Black(); spine.material = sm;
    const shut = new BABYLON.TransformNode('bookShut', scene); shut.parent = bL; // 덮은 책: 위 표지 + 옆 책등
    box(scene, 'bk_shut', 0.13, 0.17, 0.008, COVER, shut, -0.065, 0, 0.028);
    box(scene, 'bk_side', 0.01, 0.17, 0.036, '#5f2c2c', shut, -0.13, 0, 0.014);
    const flip = new BABYLON.TransformNode('bookFlip', scene); flip.parent = book; // 넘기는 종이 한 장 (책등이 축)
    box(scene, 'bk5', 0.112, 0.15, 0.003, '#fbf8ef', flip, 0.064, 0, 0.024);
    book.setEnabled(false);
    model.book = book;
    model.bookParts = { bL, bR, shut, flip, spine };
    // 커피 잔: 흰 머그 + 커피 + 손잡이 (커피를 들고 가거나 마시는 동안 오른 앞발)
    const cup = new BABYLON.TransformNode('cup', scene); cup.parent = cat.root;
    const mug = BABYLON.MeshBuilder.CreateCylinder('cup_m', { diameter: 0.065, height: 0.075, tessellation: 14 }, scene); mug.parent = cup; mug.isPickable = false;
    const mm = new BABYLON.StandardMaterial('cup_m', scene); mm.diffuseColor = BABYLON.Color3.FromHexString('#f6f4ef'); mm.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2); mug.material = mm;
    const cof = BABYLON.MeshBuilder.CreateCylinder('cup_c', { diameter: 0.056, height: 0.004, tessellation: 14 }, scene); cof.parent = cup; cof.position.y = 0.036; cof.isPickable = false;
    const cm = new BABYLON.StandardMaterial('cup_c', scene); cm.diffuseColor = BABYLON.Color3.FromHexString('#5b3a22'); cm.specularColor = BABYLON.Color3.Black(); cof.material = cm;
    const hd = BABYLON.MeshBuilder.CreateTorus('cup_h', { diameter: 0.04, thickness: 0.009, tessellation: 12 }, scene); hd.parent = cup; hd.position.x = 0.036; hd.rotation.x = Math.PI / 2; hd.isPickable = false; hd.material = mm;
    // 커피 줄기: 머신에서 컵으로 흘러내림(내리는 동안만)
    const stream = BABYLON.MeshBuilder.CreateCylinder('cup_s', { diameter: 0.012, height: 0.14, tessellation: 6 }, scene); stream.parent = cup; stream.position.y = 0.11; stream.isPickable = false; stream.material = cm;
    cup.scaling.setAll(1.7); // 고양이 몸에 견줘 잘 보이는 머그 크기 (지름 11cm·높이 13cm) — 원래 크기로는 평소 화면에서 안 보였다
    cup.setEnabled(false);
    model.cup = cup;
    // 김: 잔 위로 피어오르는 흰 방울 둘 (trackGear 가 올리고 옅게 한다)
    const stm = new BABYLON.StandardMaterial('cup_steam', scene); stm.diffuseColor = BABYLON.Color3.White(); stm.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9); stm.specularColor = BABYLON.Color3.Black(); stm.alpha = 0.9;
    const steam = [0, 1].map((i) => { const p = BABYLON.MeshBuilder.CreateSphere('cup_st' + i, { diameter: 0.03, segments: 5 }, scene); p.parent = cup; p.isPickable = false; p.material = stm; p.setEnabled(false); return p; });
    model.cupParts = { cof, stream, steam };
    // 생선 간식(간식을 받아 먹는 동안 두 앞발 사이)
    const fish = new BABYLON.TransformNode('fish', scene); fish.parent = cat.root;
    const fb = BABYLON.MeshBuilder.CreateSphere('fish_b', { diameter: 0.1, segments: 8 }, scene); fb.parent = fish; fb.scaling.set(1.5, 0.75, 0.45); fb.isPickable = false;
    const ft = BABYLON.MeshBuilder.CreateCylinder('fish_t', { diameterTop: 0, diameterBottom: 0.08, height: 0.06, tessellation: 3 }, scene); ft.parent = fish; ft.position.x = 0.095; ft.rotation.z = Math.PI / 2; ft.scaling.z = 0.3; ft.isPickable = false;
    const fm = new BABYLON.StandardMaterial('fish', scene); fm.diffuseColor = BABYLON.Color3.FromHexString('#f0a24a'); fm.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15); fb.material = fm; ft.material = fm;
    fish.setEnabled(false);
    model.fish = fish;
    // 스케이트: 사용자가 Blender 에서 다듬은 모델(assets/props/skate.blend → models/props/skate.glb). 기준점 = 발목, 앞 = -Z(cat.root 기준)
    model.skates = ['L', 'R'].map((side) => {
      const sk = new BABYLON.TransformNode('skate' + side, scene); sk.parent = cat.root;
      if (skateC) {
        const inst = skateC.instantiateModelsToScene((n) => `${cat.id}:sk${side}:${n}`, false, { doNotInstantiate: true });
        const r = inst.rootNodes[0];
        r.parent = sk; r.position.setAll(0); r.rotationQuaternion = Q.Identity(); r.scaling.set(SKATE_SCALE, SKATE_SCALE, -SKATE_SCALE); // 고양이 모델과 같은 좌우 손질(z 뒤집기)
        for (const m of r.getChildMeshes()) m.isPickable = false;
      }
      sk.setEnabled(false);
      return sk;
    });
    return props;
  }
  /**
   * 대표 고양이의 빨간 넥타이를 만들어 cat.root 에 붙이고 model.tie 로 둔다 (animate 가 서 있을 때만 보이게 켠다).
   * @param {BABYLON.Scene} scene 장면
   * @param {Cat} cat 대표 고양이
   * @param {CatModelInfo} model 모델 정보 (model.tie 가 채워짐)
   * @returns {void}
   * @see box
   */
  function makeTie(scene, cat, model) {
    const chest = model.nodes.chest;
    const t = new BABYLON.TransformNode('tie', scene);
    t.parent = cat.root;
    t.position.set(0, 0.38, -0.2);
    box(scene, 'tie1', 0.05, 0.12, 0.02, '#d4483b', t, 0, -0.04, 0);
    box(scene, 'tie2', 0.06, 0.035, 0.025, '#d4483b', t, 0, 0.03, 0);
    model.tie = t;
    if (!chest) return;
  }

  /**
   * 목덜미 잡힘(들림) 때 기본 자세에 더하는 관절 회전: 고개 숙임, 팔·다리 늘어짐 (관절 자기 축 기준)
   * 사용자가 Blender 에서 직접 잡은 자세(2026-11-17, pose_held 장면)를 기본 자세(idle 첫 프레임) 대비 회전으로 옮긴 값 (glTF 관절 자기 축, x y z w)
   * 몸 전체 앞으로 기울임 → 가슴·목 숙임 → 양팔 축 늘어뜨림(왼팔을 잡아 오른팔은 좌우 대칭)
   * [뼈 이름, 곱할 사원수(x y z w, 단위 사원수)] 쌍의 목록. hookHeld 가 동작 재생 직후 뼈 회전에 오른쪽으로 곱한다.
   * @type {Array<[string, BABYLON.Quaternion]>}
   */
  const LIMP = [
    ['root', new Q(0.1435, 0, 0, 0.9897)],
    ['chest', new Q(-0.1716, 0, 0, 0.9852)],
    ['neck', new Q(-0.1895, 0, 0, 0.9819)],
    ['upper_arm.L', new Q(-0.0131, -0.1476, -0.2374, 0.9601)],
    ['forearm.L', new Q(-0.1515, -0.0308, -0.0707, 0.9854)],
    ['hand.L', new Q(-0.1252, -0.0055, 0.0042, 0.9921)],
    ['upper_arm.R', new Q(-0.0131, 0.1476, 0.2374, 0.9601)],
    ['forearm.R', new Q(-0.1515, 0.0308, 0.0707, 0.9854)],
    ['hand.R', new Q(-0.1252, 0.0055, -0.0042, 0.9921)],
    ['foot.L', new Q(-0.3124, 0, 0, 0.9499)],
    ['foot.R', new Q(-0.3124, 0, 0, 0.9499)],
  ];

  /**
   * 들린 고양이 목록. 장면 동작 재생(scene.render 안) 직후에 LIMP 를 곱해야 다음 재생 전까지 남는다
   * (OfficeCat.update → animate 는 scene.render 보다 먼저 불려서, 거기서 바꾼 관절은 idle 동작이 덮어쓴다)
   * @type {Set<Cat>}
   */
  const HELD = new Set();
  /**
   * LIMP 적용 콜백을 이미 걸어 둔 장면 (장면마다 한 번만 걸기 위함).
   * @type {BABYLON.Scene|null}
   */
  let heldHooked = null;
  /**
   * 장면의 동작 계산 직후(onAfterAnimations)에 HELD 고양이마다 LIMP 회전을 곱하는 콜백을 한 번만 건다.
   * 콜백은 모델이 없거나 더 이상 들리지 않은 고양이를 HELD 에서 빼 준다.
   * @param {BABYLON.Scene} scene 장면
   * @returns {void}
   * @see LIMP
   */
  function hookHeld(scene) {
    if (heldHooked === scene) return;
    heldHooked = scene;
    /**
     * HELD 고양이마다 LIMP 목록의 각 관절 회전을 현재 회전에 곱한다. 들림이 풀렸거나 모델이 없으면 HELD 에서 뺀다.
     * @returns {void}
     */
    scene.onAfterAnimationsObservable.add(() => {
      for (const cat of HELD) {
        const nodes = cat.model && cat.model.nodes;
        if (!nodes || !cat.held || cat.model.cfg.ai) { HELD.delete(cat); continue; }
        for (const [k, d] of LIMP) {
          const n = nodes[k];
          if (n && n.rotationQuaternion) n.rotationQuaternion = n.rotationQuaternion.multiply(d);
        }
      }
    });
  }
  /**
   * 들렸을 때 꼬리 마디(tail_01~04)별 굽힘(라디안, 관절 X 축 회전, 음수 = 아래). 18.7° 15.0° 20.6° 41.2° 에 해당.
   * @type {number[]}
   */
  const TAIL_HELD = [-0.3256, -0.2616, -0.3587, -0.7186]; // 들렸을 때 꼬리 마디별 굽힘(rad): 18.7° 15.0° 20.6° 41.2°
  /**
   * 들렸을 때 귀 회전: 관절 X -35° (x y z w 사원수).
   * @type {BABYLON.Quaternion}
   */
  const EAR_HELD = new Q(-0.3007, 0, 0, 0.9537); // 들렸을 때 귀: 관절 X -35°
  /**
   * 들렸을 때 늘어나는 관절과 그 Y(길이) 방향 배율: [관절 이름, 배율]. 목·가슴·허리가 조금씩 늘어난다.
   * @type {Array<[string, number]>}
   */
  const STRETCH = [['spine', 1.12], ['chest', 1.1], ['neck', 1.15]]; // 들렸을 때 늘어나는 비율

  /**
   * 낚시 자세: 사용자가 Blender 에서 잡은 자세(cat_hi3d_work.blend 장면 pose_fish, 앉기 sit 기준)
   * 팔 6관절의 glTF 국소 회전 — 두 앞발을 배 앞에 모아 낚싯대를 쥔다. 동작(sit) 재생 직후(afterAnimations)에 fishK 만큼 덮어쓴다
   * [관절 이름, 목표 사원수(x y z w)] 쌍. 왼쪽·오른쪽 관절은 좌우 대칭이다.
   * @type {Array<[string, BABYLON.Quaternion]>}
   */
  const FISH_POSE = [
    ['upper_arm.L', new Q(-0.56337, -0.04349, 0.72213, 0.39907)],
    ['forearm.L', new Q(-0.21714, -0.02986, -0.10529, 0.96999)],
    ['hand.L', new Q(-0.23002, -0.00866, 0.0167, 0.973)],
    ['upper_arm.R', new Q(-0.56337, 0.04349, -0.72213, 0.39907)],
    ['forearm.R', new Q(-0.21714, 0.02986, 0.10529, 0.96999)],
    ['hand.R', new Q(-0.23002, 0.00866, -0.0167, 0.973)],
  ];
  /**
   * 낚싯대 방향(고양이 모델 공간 = top 의 자식, glTF): 앞·위·살짝 오른쪽. 두 앞발 가운데를 지나고 뒤끝은 그보다 0.05 뒤
   * 길이 1 의 단위벡터.
   * @type {BABYLON.Vector3}
   */
  const FISH_ROD_DIR = new V3(-0.1772, 0.5557, 0.8123).normalize();
  /**
   * 손목(관절) → 앞발 가운데 오프셋 (모델 공간, m). 낚싯대 자리 계산에 쓴다.
   * @type {BABYLON.Vector3}
   */
  const PAW_FROM_WRIST = new V3(0, -0.019, 0.02); // 손목(관절) → 앞발 가운데
  /**
   * 낚시 자세를 덮어쓸 고양이 목록 (fishK > 0 인 동안).
   * @type {Set<Cat>}
   */
  const FISHERS = new Set();
  /**
   * 낚시 자세 콜백을 이미 걸어 둔 장면.
   * @type {BABYLON.Scene|null}
   */
  let fishHooked = null;
  /**
   * 장면의 동작 계산 직후에 FISHERS 고양이마다 낚시 자세를 입히고 낚싯대 자리를 갱신하는 콜백을 한 번만 건다.
   * 팔 6관절을 FISH_POSE 로 fishK 만큼 Slerp 하고, 두 손 가운데에서 낚싯대 아랫끝·방향을 월드 좌표로 구해 cat.fishRod 에 둔다 (openoffice 가 읽어 대를 놓음).
   * 들려 있으면 늘어지는 자세가 우선이라 건너뛰고, fishK 가 0 이면 FISHERS 에서 빼고 fishRod 를 지운다.
   * @param {BABYLON.Scene} scene 장면
   * @returns {void}
   * @see FISH_POSE
   */
  function hookFish(scene) {
    if (fishHooked === scene) return;
    fishHooked = scene;
    /**
     * FISHERS 고양이마다 낚시 자세 덮어쓰기와 cat.fishRod 갱신을 한다. 낚시가 끝났거나 모델이 없으면 FISHERS 에서 뺀다.
     * @returns {void}
     */
    scene.onAfterAnimationsObservable.add(() => {
      for (const cat of FISHERS) {
        const m = cat.model;
        if (!m || !m.nodes || !(cat.fishK > 0)) { FISHERS.delete(cat); cat.fishRod = null; continue; }
        if (cat.held) continue; // 들려 있으면 늘어지는 자세가 우선
        for (const [k, q] of FISH_POSE) {
          const n = m.nodes[k];
          if (n) n.rotationQuaternion = Q.Slerp(n.rotationQuaternion || Q.FromEulerVector(n.rotation), q, cat.fishK);
        }
        // 낚싯대 자리(월드): 체형마다 팔 길이가 달라 실제 앞발 위치를 따라간다 (openoffice 가 읽어 대를 놓는다)
        const hl = m.nodes['hand.L'], hr = m.nodes['hand.R'];
        if (!hl || !hr) continue;
        hl.computeWorldMatrix(true); hr.computeWorldMatrix(true);
        const tw = m.top.computeWorldMatrix(true), inv = BABYLON.Matrix.Invert(tw);
        const mid = V3.TransformCoordinates(V3.Center(hl.getAbsolutePosition(), hr.getAbsolutePosition()), inv).addInPlace(PAW_FROM_WRIST);
        const bottom = mid.subtract(FISH_ROD_DIR.scale(0.05));
        cat.fishRod = { bottom: V3.TransformCoordinates(bottom, tw), dir: V3.TransformNormal(FISH_ROD_DIR, tw).normalize() };
      }
    });
  }

  /**
   * 책·스케이트를 손·발 뼈 자리로 옮긴다 (동작이 무엇이든 손발을 따라가게).
   * 책: 읽는 중(act 'read', 다른 소품 없음, 걷기·들림 아님)이면 두 손 가운데, 종이가 얼굴 쪽 위를 보게 기울인다.
   * 스케이트: 얼음 위(skateK > 0.3)면 양발 발목 뼈 자리에. 뼈 자리는 지난 프레임 동작 기준(한 프레임 늦음, 눈에 띄지 않음).
   * @param {Cat} cat 고양이
   * @param {CatModelInfo} m 모델 정보
   * @returns {void}
   */
  function trackGear(cat, m) {
    if (!m.book || !m.nodes) return;
    // 책: 덮은 책을 들고 다니거나(cat.book 'closed'), 앉아 펼쳐 읽는다(cat.book 'open' 또는 하는 일 read). 꺼내기·꽂기(reach) 순간엔 손에 없다
    const bookState = cat.held || cat.prop || cat.act === 'reach' ? null : cat.book === 'closed' ? 'closed' : (cat.book === 'open' || cat.act === 'read') && cat.pose !== 'walk' ? 'open' : cat.book === 'open' ? 'closed' : null;
    const reading = !!bookState;
    // 커피 잔: 'fill'(머신 아래 조리대 위에 놓고 커피가 차오름) · 'place'(반납: 조리대 위) · 그 밖에 들고 있음(오른 앞발, 마시는 동작이면 입으로)
    const sipping = (cat.cup || cat.act === 'drink') && !cat.held && !cat.prop;
    if (m.cup) m.cup.setEnabled(sipping);
    const eating = cat.act === 'eat' && !cat.prop && !cat.held && cat.pose !== 'walk';
    if (m.fish) m.fish.setEnabled(eating);
    const skating = (cat.skateK || 0) > 0.3 && !cat.held;
    m.book.setEnabled(reading);
    for (const s of m.skates) s.setEnabled(skating);
    if (!reading && !skating && !eating && !sipping) return;
    const inv = BABYLON.Matrix.Invert(cat.root.computeWorldMatrix(true));
    /**
     * 뼈의 자리(고양이 root 좌표).
     * @param {string} key 뼈 이름
     * @returns {?BABYLON.Vector3}
     */
    const at = (key) => { const n = m.nodes[key]; if (!n) return null; n.computeWorldMatrix(true); return V3.TransformCoordinates(n.getAbsolutePosition(), inv); };
    if (eating && m.fish) {
      const hl = at('hand.L'), hr = at('hand.R');
      if (hl && hr) m.fish.position.copyFrom(V3.Center(hl, hr)).addInPlaceFromFloats(0, 0.04, -0.03);
    }
    if (reading) {
      const hl = at('hand.L'), hr = at('hand.R');
      const P = m.bookParts, open = bookState === 'open';
      P.bR.setEnabled(open); P.shut.setEnabled(!open); P.spine.setEnabled(open);
      P.bL.position.x = open ? 0 : 0.065; // 덮으면 왼쪽 반이 가운데로
      P.bL.rotation.y = open ? 0.13 : 0; P.bR.rotation.y = open ? -0.13 : 0; // 펼치면 165°쯤 — 두 반쪽 가장자리가 읽는 쪽(+Z)으로 살짝 올라온다
      // 펼쳐 읽는 동안 3.5초마다 한 장을 넘긴다(0.6초 동안 책등을 축으로 오른쪽 → 왼쪽, 읽는 쪽(+Z)으로 들려 넘어간다)
      const ph = ((cat.t || 0) % 3.5) / 0.6;
      P.flip.setEnabled(open && ph < 1);
      if (open && ph < 1) P.flip.rotation.y = -Math.PI * ph;
      if (open && hl && hr) {
        m.book.position.copyFrom(V3.Center(hl, hr)).addInPlaceFromFloats(0, 0.03, -0.05);
        m.book.rotation.set(-0.75, 0, 0); // 펼치면 종이(+Z)가 위·뒤(얼굴)를 본다
      } else if (!open && hr) {
        // 덮은 책은 오른 앞발에만 쥔다: 몸 옆에 세로로(책 면이 옆을 보게), 걸을 때 팔 흔들림을 따라간다
        m.book.position.copyFrom(hr).addInPlaceFromFloats(0.02, -0.02, 0);
        m.book.rotation.set(0, Math.PI / 2, 0);
      }
    }
    if (sipping && m.cup) {
      const onCounter = cat.cup === 'fill' || cat.cup === 'place';
      const fill = cat.cup === 'fill' ? Math.min(1, ((cat.t || 0) - (cat.cupT0 || 0)) / 3) : 1;
      m.cupParts.stream.setEnabled(cat.cup === 'fill' && fill < 1);
      m.cupParts.cof.setEnabled(fill > 0.85);
      if (onCounter) m.cup.position.set(0, 0.95, -0.85); // 고양이 앞 조리대 위(커피 머신 아래) — 고양이 자리 기준
      else {
        if (cat.cup === 'hand' && !m.cfg.ai && !SIPPERS.has(cat)) { SIPPERS.add(cat); hookSip(cat.root.getScene()); } // 잔 든 팔 자세
        const hr = at('hand.R');
        if (hr) m.cup.position.copyFrom(hr).addInPlaceFromFloats(0, 0.02, -0.03);
      }
      // 마시는 모습: 입으로 가져갈 때 잔을 얼굴 쪽으로 기울이고, 들고 있는 동안에는 김이 두 줄기 피어오른다 (기울였을 때·조리대에 놓였을 때는 김을 끈다)
      const up = !onCounter && cat.cup === 'hand' ? cat.sipUp || 0 : 0;
      m.cup.rotation.x = up * 0.75;
      const steamOn = !onCounter && fill >= 1 && up < 0.3;
      m.cupParts.steam.forEach((p, i) => {
        p.setEnabled(steamOn);
        if (!steamOn) return;
        const u = (((cat.t || 0) * 0.55 + i * 0.5) % 1); // 0 → 1 로 올라가며 커졌다 옅어진다
        p.position.set(Math.sin(u * 5 + i * 2) * 0.008, 0.05 + u * 0.09, 0);
        p.scaling.setAll(0.5 + u * 0.9);
        p.visibility = 0.55 * (1 - u);
      });
    }
    if (skating) {
      for (const [i, key] of ['foot.L', 'foot.R'].entries()) {
        const p = at(key);
        if (p) m.skates[i].position.copyFrom(p).addInPlace(SKATE_OFF); // 발목을 따라간다(몸은 SKATE_LIFT 만큼 들려 있다)
      }
    }
  }

  /**
   * 스케이트 자세: 기본 선 자세(idle)에 더하는 관절 회전(도, 관절 자기 축). 상체는 앞으로 숙이고 얼굴은 정면, 두 팔은 옆으로 벌려 균형.
   * X 축 (음수 = 앞으로 숙임, UPRIGHT_DEG 와 같은 축). 등 펴기(UPRIGHT_DEG)가 먼저 곱해지므로 합쳐서 약간 숙은 정도가 된다
   * @type {Object<string, number>}
   */
  const SKATE_DEG = { spine: -20, chest: -10, neck: 12, head: 14 };
  /** 팔 벌림(rad, Z 축: 왼팔 +, 오른팔 -. LIMP 의 팔 늘어뜨림이 왼팔 Z 음수이므로 그 반대) */
  const SKATE_ARM = 0.6;
  /** 지칠 때 팔 흔들림(rad) */
  const SKATE_ARM_SWING = 0.15;
  /** 다리 번갈아 밀기(rad, thigh X 축) */
  const SKATE_LEG = 0.42;
  /** 한 번 지치는 주기 1.6초 (cat.js 의 SKATE_STRIDE 와 같은 값) */
  const SKATE_STRIDE = (Math.PI * 2) / 1.6;
  /**
   * 스케이트 자세를 덮어쓸 고양이 목록 (skateK > 0 인 동안).
   * @type {Set<Cat>}
   */
  const SKATING = new Set();
  /**
   * 스케이트 자세 콜백을 이미 걸어 둔 장면.
   * @type {BABYLON.Scene|null}
   */
  let skateHooked = null;
  /**
   * 장면의 동작 계산 직후에 SKATING 고양이마다 스케이트 자세 회전을 곱하는 콜백을 한 번만 건다.
   * 허리·가슴·목·머리는 SKATE_DEG 만큼 숙이고, 두 팔은 벌려 지치는 박자(cat.t × SKATE_STRIDE)로 흔들고, 허벅지는 번갈아 민다. 모두 skateK 를 곱한다. 들려 있으면 건너뛰고, skateK 가 0 이면 목록에서 뺀다.
   * @param {BABYLON.Scene} scene 장면
   * @returns {void}
   * @see SKATE_DEG
   */
  function hookSkate(scene) {
    if (skateHooked === scene) return;
    skateHooked = scene;
    /**
     * SKATING 고양이마다 관절 회전을 곱한다.
     * @returns {void}
     */
    scene.onAfterAnimationsObservable.add(() => {
      for (const cat of SKATING) {
        const nodes = cat.model && cat.model.nodes;
        const k = cat.skateK || 0;
        if (!nodes || !(k > 0)) { SKATING.delete(cat); continue; }
        if (cat.held) continue;
        const ph = Math.sin(cat.t * SKATE_STRIDE);
        /**
         * 관절 n 의 회전에 축 axis 로 ang(rad) 만큼 더 돌린다.
         * @param {string} key 뼈 이름
         * @param {BABYLON.Vector3} axis 회전축
         * @param {number} ang 각도(rad)
         * @returns {void}
         */
        const turn = (key, axis, ang) => {
          const n = nodes[key];
          if (n && n.rotationQuaternion) n.rotationQuaternion = n.rotationQuaternion.multiply(Q.RotationAxis(axis, ang));
        };
        for (const key of Object.keys(SKATE_DEG)) turn(key, V3.Right(), SKATE_DEG[key] * k * Math.PI / 180);
        turn('upper_arm.L', V3.Forward(), (SKATE_ARM + SKATE_ARM_SWING * ph) * k);
        turn('upper_arm.R', V3.Forward(), -(SKATE_ARM - SKATE_ARM_SWING * ph) * k);
        turn('thigh.L', V3.Right(), SKATE_LEG * ph * k);
        turn('thigh.R', V3.Right(), -SKATE_LEG * ph * k);
      }
    });
  }

  /**
   * 커피 잔을 든 고양이들 (오른팔 자세를 덧입힐 대상). trackGear 가 넣고, 잔을 내려놓으면 콜백이 뺀다.
   * @type {Set<Cat>}
   */
  const SIPPERS = new Set();
  /**
   * 잔 드는 팔 자세 콜백을 이미 걸어 둔 장면.
   * @type {BABYLON.Scene|null}
   */
  let sipHooked = null;
  // 잔 든 오른팔 자세 [위팔 앞으로 들기(rad, Right 축), 위팔 옆 벌림(rad, Forward 축), 아래팔 굽힘(rad, Right 축)]
  // REST = 가슴 앞에 들고 있기(걸을 때·앉아 쉴 때), UP = 입으로 가져가 홀짝
  const SIP_REST = [0.8, 0.7, -0.2], SIP_UP = [1.4, 1.2, -0.3]; // 앉은 기본 동작(sit) 기준: UP 은 손이 입 앞에 오도록 수치로 찾은 값, REST 는 그 절반쯤(가슴 앞)
  const SIP_EVERY = 4.6, SIP_LEN = 1.7; // 홀짝 주기(초)·한 번 걸리는 시간(초)
  /**
   * 장면의 동작 계산 직후에 잔 든 고양이의 오른팔을 들어 올리는 콜백을 한 번만 건다.
   * 원래 동작(sit·drink·walk)은 팔을 거의 내리고 있어 잔이 엉덩이 옆에 달려 안 보인다 → 잔을 가슴 앞에 들고(REST), 앉아서 마실 때는 SIP_EVERY 초마다 입으로 가져간다(UP).
   * @param {BABYLON.Scene} scene 장면
   * @returns {void}
   * @see trackGear
   */
  function hookSip(scene) {
    if (sipHooked === scene) return;
    sipHooked = scene;
    scene.onAfterAnimationsObservable.add(() => {
      for (const cat of SIPPERS) {
        const nodes = cat.model && cat.model.nodes;
        if (!nodes || cat.cup !== 'hand' || cat.held || cat.prop || cat.root.isDisposed()) { cat.sipUp = 0; SIPPERS.delete(cat); continue; } // 잔을 내려놓았거나 퇴근한 고양이는 뺀다
        const tune = window.__sipTune; // 개발용: [REST, UP, 강제 up(0~1)]
        const R0 = tune ? tune[0] : SIP_REST, R1 = tune ? tune[1] : SIP_UP;
        const ph = ((cat.t || 0) % SIP_EVERY) / SIP_LEN;
        let up = cat.pose === 'sit' && ph < 1 ? Math.sin(ph * Math.PI) ** 0.6 : 0; // 올렸다 잠깐 머물고 내린다
        if (tune && tune[2] != null) up = tune[2];
        const turn = (key, axis, ang) => { const n = nodes[key]; if (n && n.rotationQuaternion && ang) n.rotationQuaternion = n.rotationQuaternion.multiply(Q.RotationAxis(axis, ang)); };
        turn('upper_arm.R', V3.Right(), R0[0] + (R1[0] - R0[0]) * up);
        turn('upper_arm.R', V3.Forward(), R0[1] + (R1[1] - R0[1]) * up);
        turn('forearm.R', V3.Right(), R0[2] + (R1[2] - R0[2]) * up);
        turn('head', V3.Right(), -0.22 * up); // 홀짝일 때 고개를 살짝 젖힌다
        cat.sipUp = up; // 잔 기울기·김(trackGear)이 같이 쓴다
      }
    });
  }

  /**
   * 두 발 자세(서기·두 발 걷기·들기)의 등 펴기: 원래 동작은 상체가 앞으로 숙어 구부정하다.
   * 동작 재생 직후(afterAnimations) 허리·가슴을 뒤로 젖혀 목에서 엉덩이까지 등선이 세로로 곧게 이어지게 하고,
   * 목·머리를 같은 만큼 되돌려 얼굴은 그대로 정면을 본다. 관절 X 양수 = 뒤로 젖힘 (음수 = 앞으로 숙임)
   * 각도(도): [허리, 가슴, 목, 머리]. 앞으로 나오는 배는 사용자도 원한 결과
   * 뼈 이름 → 관절 X 축 회전 각도(도). uprightK(0~1) 를 곱해 쓴다.
   * @type {Object<string, number>}
   */
  const UPRIGHT_DEG = { spine: 20, chest: 20, neck: -18, head: -20 };
  /**
   * 등 펴기를 적용할 동작(pick 결과) 이름들.
   * @type {Set<string>}
   */
  const UPRIGHT_ACTS = new Set(['idle', 'walk', 'carry', 'hold', 'raise_hand']);
  /**
   * 등 펴기를 덮어쓸 고양이 목록 (uprightK > 0 인 동안).
   * @type {Set<Cat>}
   */
  const UPRIGHT = new Set();
  /**
   * 등 펴기 콜백을 이미 걸어 둔 장면.
   * @type {BABYLON.Scene|null}
   */
  let uprightHooked = null;
  /**
   * 장면의 동작 계산 직후에 UPRIGHT 고양이마다 등 펴기 회전을 곱하는 콜백을 한 번만 건다.
   * 각 관절 회전에 X 축 회전(UPRIGHT_DEG[뼈] × uprightK 도)을 곱한다. uprightK 가 0 이면 UPRIGHT 에서 뺀다.
   * @param {BABYLON.Scene} scene 장면
   * @returns {void}
   * @see UPRIGHT_DEG
   */
  function hookUpright(scene) {
    if (uprightHooked === scene) return;
    uprightHooked = scene;
    /**
     * UPRIGHT 고양이마다 허리·가슴·목·머리 관절을 UPRIGHT_DEG 만큼 뒤로 젖힌다.
     * @returns {void}
     */
    scene.onAfterAnimationsObservable.add(() => {
      for (const cat of UPRIGHT) {
        const nodes = cat.model && cat.model.nodes;
        const k = cat.uprightK || 0;
        if (!nodes || !(k > 0)) { UPRIGHT.delete(cat); continue; }
        for (const key of Object.keys(UPRIGHT_DEG)) {
          const n = nodes[key];
          if (!n || !n.rotationQuaternion) continue;
          n.rotationQuaternion = n.rotationQuaternion.multiply(Q.RotationAxis(V3.Right(), UPRIGHT_DEG[key] * k * Math.PI / 180));
        }
      }
    });
  }

  /**
   * 상태 → 동작 이름
   * 들림 → idle, 걷기 → walk4(네 발)/carry(결재판·상자)/walk, 앉기 → sit_type/sit_talk/drink/sit, 웅크림 → sleep,
   * 서 있을 때는 팻말·손들기 → raise_hand, 결재판·상자·읽기·발표 → hold, 그루밍 → groom, 졸기 → sleep, 바깥 쉬기(두 발 체형) → sit_up, 나머지 → idle.
   * @param {Cat} cat 고양이 (pose, act, prop, signal, quad, held, model.cfg 를 읽음)
   * @returns {string} 모델 동작 그룹 이름 (m.groups 의 키)
   */
  function pick(cat) {
    const act = cat.act || 'idle', prop = cat.prop;
    const quad = cat.quad && cat.model.cfg.quad;
    if (cat.held) return 'idle'; // 목덜미를 잡혀 들린 상태: 기본 자세에서 거의 멈춰 축 처진다
    if (cat.skating) return cat.model.groups.skate ? 'skate' : 'idle'; // 얼음 위: Blender 에서 만든 스케이트 동작(없으면 선 자세 + hookSkate)
    if (act === 'roll' && cat.model.groups.roll && cat.pose !== 'sit') return 'roll'; // 간식을 받고 발라당 (Blender extra_actions.py)
    if (cat.pose === 'walk') return quad ? 'walk4' : prop === 'box' || prop === 'board' ? 'carry' : 'walk'; // 덮은 책은 오른손에만 쥐고 걸으므로 팔은 보통 걸음처럼 흔든다
    if (cat.pose === 'sit') {
      if (act === 'type' || act === 'stamp') return 'sit_type';
      if (act === 'read') return 'sit_type'; // 앞발을 앞으로 모은 자세로 책을 든다 (아주 느리게 — animate 의 speedRatio)
      if (act === 'talk' || act === 'nod' || act === 'shake') return 'sit_talk';
      if (act === 'drink' && cat.cup === 'hand') return cat.model.cfg.ai ? 'drink' : 'sit'; // 잔을 들었으면 기본 앉은 동작 위에 팔 자세를 덧입힌다 (hookSip) — 마시기 동작과 겹치면 팔이 두 번 돈다
      if (act === 'drink' || act === 'eat') return 'drink'; // 앉아서 간식 먹기는 마시기 동작으로
      if (act === 'highfive') return 'sit_talk';
      return 'sit';
    }
    if (cat.pose === 'loaf') return 'sleep';
    if (act === 'reach') return 'raise_hand'; // 책장에서 책을 꺼내거나 꽂는다
    if (prop === 'sign' || act === 'sign' || act === 'highfive' || cat.signal === 'permission' && !prop) return 'raise_hand';
    if (prop === 'board' || prop === 'box' || act === 'read' || act === 'present' || act === 'eat') return 'hold'; // 서서 먹기: 앞발로 생선 간식을 든다
    if (act === 'groom') return 'groom';
    if (act === 'sleep' || act === 'doze') return 'sleep';
    if (cat.quad && !cat.model.cfg.quad) return 'sit_up'; // 바깥에서 쉴 때 앞발 들고 서기
    return 'idle';
  }

  /**
   * 꼬리 마디(tail_01~04) 방향각(도): 엉덩이 뼈 기준 뒤 수평이 0°, 위로 올라가면 +. 허리에서 이어 앞 마디는 곧게, 끝에서 말려 올라간다
   * 꼬리 종류(tailKind 결과) → [첫 마디, 둘째, 셋째, 넷째] 방향각(도).
   * @type {Object<string, number[]>}
   */
  const TAIL_POSE = {
    stand: [-85, -25, -5, 30], // 서 있기: 엉덩이 맨 아래에서 거의 수직으로 내려와 바닥을 따라 뒤로 뻗다가 끝이 살짝 위로 (L 모양)
    sit: [-35, -15, 10, 45],
    walk: [-80, -25, -5, 35], // 두 발 걷기·들고 걷기: 서 있기와 같은 L 모양
    walk4: [15, 20, 35, 60], // 네 발: 등과 일직선으로 뒤로 뻗다가 위로 부드럽게 말림
    sleep: [-30, -20, 0, 30],
  };
  /**
   * 몸에서 꼬리가 나오는 자리 옮김 (엉덩이 뼈 기준 [위아래, 앞뒤] m). 꼬리 뿌리는 이제 모델 파일에서 엉덩이 맨 아래로 옮겨 두었으므로 코드로는 옮기지 않는다(0)
   * (예전엔 꼬리 뼈만 옮겨 엉덩이 면과 꼬리 뿌리 면이 찢어져 뾰족한 면(뿔)이 생겼다). 자리를 더 손볼 일이 있으면 모델(move_tail_root.py)에서 한다
   * 체형 키 → [위아래, 앞뒤] (m). 서기·걷기가 아닐 때만 쓴다.
   * @type {Object<string, number[]>}
   */
  const TAIL_BASE = { standard: [0, 0], foldear: [0, 0], longhair: [0, 0], shortleg: [0, 0] };
  /**
   * 체형별 꼬리 들어 올림 시작값(도). 처음엔 어림값이고, 알맞은 값을 찾을 때마다 고쳐 적는다(animate).
   * @type {Object<string, number>}
   */
  const liftSeed = { shortleg: 60, longhair: 12 };
  /**
   * 꼬리 자세 종류를 고른다: 앉으면 sit, 웅크림·자는 중이면 sleep, 걸으면 walk4(네 발)/walk, 나머지 stand.
   * @param {Cat} cat 고양이
   * @param {CatModelInfo} m 고양이의 모델 정보 (m.cfg.quad 를 읽음)
   * @returns {string} TAIL_POSE 의 키 (stand | sit | walk | walk4 | sleep)
   */
  function tailKind(cat, m) {
    if (cat.pose === 'sit') return 'sit';
    if (cat.pose === 'loaf' || cat.act === 'sleep' || cat.act === 'doze' || cat.act === 'roll') return 'sleep'; // 발라당 누웠을 때도 느슨하게 늘어뜨린다 (서 있는 꼬리 모양이면 누운 몸에서 어색하게 말린다)
    if (cat.pose === 'walk') return cat.quad && m.cfg.quad && !cat.skating ? 'walk4' : 'walk';
    return 'stand';
  }

  /**
   * 매 프레임 모델 연출 (OfficeCat.update 가 부름).
   * 순서: 동작 그룹 고르기·전환 → 실제 이동 속도로 걸음 재생 속도 맞추기 → 높이(앉기·뛰기·다리 줄임) → 소품 켜기·입에 물기 →
   * 꼬리(TAIL_POSE 로 마디 방향각 따라가기, 흔들림·보정) → 귀 눕히기 → 등 펴기·낚시·스케이트 자세 섞임 갱신 → 오류 털 곤두섬 → 들림(시계추·늘어짐).
   * 관절을 덮어쓰는 작업(등 펴기·낚시·들림)은 장면 동작 계산 뒤에 해야 해서 hook* 콜백 목록에 고양이를 넣어 두기만 한다.
   * @param {Cat} cat 고양이 (cat.model 이 있어야 함. uprightK, fishK, hopT 를 갱신함)
   * @param {number} dt 지난 프레임 이후 경과 시간(초)
   * @returns {void}
   * @see pick
   * @see tailKind
   * @see hookUpright
   * @see hookFish
   * @see hookSkate
   * @see hookHeld
   */
  function animate(cat, dt) {
    const m = cat.model;
    // 회전 속도(rad/s, 부드럽게): 스케이트에서 도는 안쪽으로 몸을 기울이는 데 쓴다
    const yaw = cat.root.rotation.y;
    let dy = yaw - (m.lastYaw ?? yaw);
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    if (dt > 0) m.turn = (m.turn || 0) + (dy / dt - (m.turn || 0)) * Math.min(1, dt * 5);
    m.lastYaw = yaw;
    const name = pick(cat);
    if (name !== m.anim) {
      const old = m.groups[m.anim];
      if (old) old.stop();
      const g = m.groups[name] || m.groups.idle;
      if (g && g === old) { /* 같은 동작 그룹(ai 별칭): 다시 시작하지 않음 */ }
      else if (g) {
        g.speedRatio = 1;
        g.start(true, 1);
        g.goToFrame(Math.random() * (g.to - g.from) + g.from);
      }
      m.anim = name;
    }
    // 실제로 움직인 속도로 발걸음 속도를 맞춘다 (속도 × 주기 ÷ 보폭)
    const p = cat.root.position;
    if (m.lastPos && dt > 0) {
      const v = Math.hypot(p.x - m.lastPos.x, p.z - m.lastPos.z) / dt;
      m.speed = m.speed == null ? v : m.speed + (v - m.speed) * Math.min(1, dt * 8);
    }
    m.lastPos = { x: p.x, z: p.z };
    // 혀: 그루밍이면 핥기(내밀었다 들이며 혀끝을 위아래로 튕김), 간식 먹기면 가끔 입맛 다시기
    if (m.tongue) {
      const tt = cat.t || 0;
      let tk = 0, fl = 0;
      if (cat.act === 'groom') { tk = Math.max(0, Math.sin(tt * 3.4)) ** 0.6; fl = -0.35 * Math.sin(tt * 10.2); }
      else if (cat.act === 'eat') { const s = Math.sin(tt * 2.2); tk = s > 0.75 ? (s - 0.75) * 2.4 : 0; fl = -0.4 * Math.sin(tt * 12); }
      if (tk || m.tongue.k) tongue(cat, tk, fl);
    }
    // 입 벌리기(AI 모델): 핥을 때는 혀와 함께, 먹을 때는 씹듯이, 말하기·손들기·환호 때는 야옹 하듯 열었다 닫았다
    if (m.mouthIn) {
      const tt = cat.t || 0;
      let mk = 0;
      if (cat.act === 'groom') mk = 0.4 + 0.6 * Math.max(0, Math.sin(tt * 3.4)) ** 0.6;
      else if (cat.act === 'eat') mk = 0.25 + 0.55 * Math.max(0, Math.sin(tt * 7));
      else if (cat.act === 'talk' || cat.act === 'present' || cat.act === 'sign' || cat.act === 'highfive' || m.anim === 'cheer' || m.anim === 'raise_hand') mk = 0.6 * Math.max(0, Math.sin(tt * 5.5)) ** 0.8;
      mouthOpen(cat, mk);
    }
    const g = m.groups[m.anim];
    if (g) {
      const gait = m.cfg.gait[m.anim];
      g.speedRatio = cat.held ? 0.08 : gait ? Math.max(0.25, Math.min(6, (m.speed || 0) * gait[0] / gait[1])) : cat.act === 'fidget' ? 1.8 : cat.act === 'read' ? 0.12 : 1; // 읽기: 타자 동작을 거의 멈춰 책을 든 자세로
    }

    // 높이: 앉으면 좌석 높이에 맞춰 내린다, 기쁘면 뛴다
    const t = cat.t;
    let y = 0;
    if (cat.pose === 'sit') y = Math.max(0, (cat.seatY || 0.5) - m.cfg.sitDrop);
    if (cat.hopT > 0) { cat.hopT -= dt; y += Math.abs(Math.sin(cat.hopT * 9)) * 0.18; }
    if (cat.pose === 'stand' || cat.pose === 'walk') y -= m.legDrop; // 짧게 줄인 다리
    y += SKATE_LIFT * (cat.skateK || 0); // 스케이트를 신으면 날이 얼음에 닿게
    m.top.position.y = y;

    // 소품: 두 발이면 몸 앞(손), 네 발 자세(밖에서 걷기·엎드려 기다리기)면 입에 문다
    for (const [k, pr] of Object.entries(m.props)) pr.setEnabled(cat.prop === k);
    const fours = (cat.quad && m.cfg.quad && cat.pose === 'walk') || cat.pose === 'loaf';
    const mouth = fours && (cat.prop === 'board' || cat.prop === 'box');
    const front = m.props.board.parent, board = m.props.board;
    if (!board.metadata) board.metadata = { pos: board.position.clone(), rx: board.rotation.x }; // 손에 들 때 자리
    if (mouth && m.nodes.head) {
      // 머리 위치를 고양이 자리 좌표로 옮겨 입 앞에 둔다
      const inv = BABYLON.Matrix.Invert(cat.root.computeWorldMatrix(true));
      const hp = V3.TransformCoordinates(m.nodes.head.getAbsolutePosition(), inv);
      const s = 0.6;
      front.scaling.setAll(s);
      if (cat.prop === 'board') {
        // 결재판은 눕혀서(종이가 위) 클립 쪽 끝을 문다: 판 가운데를 입에서 판 길이 절반만큼 앞에 둔다
        // 입은 머리 관절(목)보다 앞으로 0.34, 아래로 0.04 (얼굴 앞면)
        front.position.set(0, hp.y - 0.07, hp.z - 0.34 - 0.13 * s);
        front.rotation.x = 0;
        board.position.set(0, 0, 0);
        board.rotation.x = Math.PI / 2 - 0.12; // 종이(앞면 -Z)가 위로, 앞쪽 끝이 살짝 처지게
      } else {
        // 상자: 손 위치 기준(y 0.36, z -0.27)이 축소된 뒤 입 앞에 오게
        front.position.set(0, hp.y - 0.04 - 0.36 * s, hp.z - 0.34 + 0.27 * s);
        front.rotation.x = 0.35;
      }
    } else {
      front.position.set(0, 0, 0);
      front.scaling.setAll(1);
      front.rotation.x = 0;
    }
    if (!(mouth && cat.prop === 'board')) { board.position.copyFrom(board.metadata.pos); board.rotation.x = board.metadata.rx; }
    if (m.tie) m.tie.setEnabled(cat.pose !== 'loaf' && cat.pose !== 'walk');
    trackGear(cat, m);

    // 꼬리 좌우 흔들기(기본 패시브, 사용자 설명 2026-11-25): 평소엔 가만히 있다가 가끔 살랑살랑, 기분 좋으면(간식·발라당) 살랑살랑,
    // 짜증 나거나 힘들면(기분 낮음) 빠르게 크게 휙휙. 주의 필요(결재·질문)면 빠르게, 오류면 꼿꼿이, 자면 거의 안 움직임
    const urgent = cat.signal === 'permission' || cat.signal === 'waiting' || cat.act === 'sign';
    const err = cat.signal === 'error';
    const low = 1 - (cat.mood ?? 1);
    const held = !!cat.held;
    const treat = cat.act === 'eat' || cat.act === 'roll';
    const rolling = cat.act === 'roll'; // 발라당 뒹굴 때는 꼬리를 크게 좌우로 흔든다
    const sleepy = cat.act === 'sleep' || cat.act === 'doze';
    const cross = low > 0.45; // 짜증·지침
    if (m.tailSeed == null) m.tailSeed = Math.random() * 6.28;
    const calm = Math.max(0, Math.sin(cat.t * 0.21 + m.tailSeed)) ** 1.5; // 평소: 0(가만히) ↔ 1(살랑) 을 천천히 오간다
    const amp = held ? 0.6 : err ? 0.03 : rolling ? 0.8 : treat ? 0.38 : urgent ? 0.45 : sleepy ? 0.05 : cross ? 0.3 + 0.3 * low : 0.2 * calm;
    const spd = held ? 16 : rolling ? 6 : treat ? 3.2 : urgent ? 6 : cross ? 5 + 6 * low : cat.pose === 'walk' ? 3 : 1.6; // 들리면 꼬리만 빠르게 좌우로
    // 들리지 않을 때: 꼬리는 허리(엉덩이 뼈)에서 등줄기를 이어 뒤로 나와 앞 마디는 곧게, 끝에서 위로 말린다 (마디 방향각 TAIL_POSE)
    // 들리면: 원래 위로 말린 꼬리를 일직선으로 펴서 아래로 축 늘어뜨린다(Blender 에서 맞춘 마디별 각도, 관절 X 음수 = 아래)
    const tailKeys = ['tail_01', 'tail_02', 'tail_03', 'tail_04'];
    const tp = TAIL_POSE[tailKind(cat, m)];
    const kind = tailKind(cat, m);
    const base = kind === 'stand' || kind === 'walk' ? [0, 0] : TAIL_BASE[m.body] || [0, 0];
    const fresh = !m.tailAng;
    if (fresh) m.tailAng = tp.slice();
    const tk = Math.min(1, dt * 6);
    // 꼬리가 바닥에 묻히지 않게: 서기·걷기 때 둘째~끝 마디의 가장 낮은 높이(지난 프레임 기준)가 바닥 위 4.5cm 보다 낮으면 앞 두 마디를 조금씩 들어 올린다.
    // 다리가 짧거나(먼치킨) 털이 긴 체형처럼 엉덩이가 낮아도 저절로 맞는다. 여유(7.5cm)가 생기면 천천히 내리고, 그 사이에서는 그대로 둔다(떨림 방지)
    if (m.tailLift == null) m.tailLift = liftSeed[m.body] || 0; // 같은 체형이 먼저 찾아 둔 값에서 시작 (일어서자마자 꼬리가 잠깐 묻히지 않게)
    const onGround = (kind === 'stand' || kind === 'walk' || kind === 'walk4') && !held && cat.act !== 'roll'; // 발라당 누웠을 때는 꼬리가 바닥에 닿는 게 정상
    if (onGround && !fresh) {
      let lowY = Infinity;
      for (const k of ['tail_02', 'tail_03', 'tail_04']) { const nd = m.nodes[k]; if (nd) lowY = Math.min(lowY, nd.getAbsolutePosition().y); }
      lowY -= cat.root.position.y;
      if (lowY < 0.045) m.tailLift = Math.min(90, (m.tailLift || 0) + (90 + (0.045 - lowY) * 3000) * dt); // 많이 묻혔을수록 빨리 든다 (앉았다 일어선 직후 등)
      else if (lowY > 0.075) m.tailLift = Math.max(0, (m.tailLift || 0) - 15 * dt);
      else liftSeed[m.body] = m.tailLift; // 알맞은 높이를 찾았다: 이 체형의 다음 고양이는 여기서 시작
    }
    const lift = onGround ? m.tailLift || 0 : 0; // 앉거나 들렸을 때는 쓰지 않되 값은 남겨 둔다 (다시 서면 바로 그만큼 든다)
    let prevTheta = 0;
    /**
     * 꼬리 마디 하나(k = tail_01~04, i = 0~3)의 회전·위치를 정한다.
     * 들리면 마디별 늘어짐(TAIL_HELD)+빠른 좌우 흔들림, 아니면 목표 방향각(TAIL_POSE)으로 부드럽게 다가가고 마디 사이 차이만큼 회전한다.
     * 첫 마디는 기본 자세에서 돌아간 만큼 위치를 보정해 꺾임 중심이 제자리에 있게 한다.
     * @param {string} k 꼬리 마디 뼈 이름
     * @param {number} i 마디 번호 0~3
     * @returns {void}
     */
    tailKeys.forEach((k, i) => {
      const n = m.nodes[k], r = m.rest[k];
      if (!n || !r) return;
      if (!m.tailPos) m.tailPos = {};
      if (!m.tailPos[k]) m.tailPos[k] = n.position.clone();
      // 꼬리가 몸에서 나오는 자리는 엉덩이 끝 쪽으로 옮긴다 (들렸을 땐 원래 자리)
      if (i === 0) n.position.set(m.tailPos[k].x, m.tailPos[k].y + (held ? 0 : base[0]), m.tailPos[k].z + (held ? 0 : base[1]));
      if (held) {
        // 한 마디만 크게 꺾으면 면이 접히므로 네 마디에 나눠 꺾는다. 좌우 흔들림은 끝으로 갈수록 크게
        const a = amp * (0.25 + i * 0.3);
        const sway = Q.RotationAxis(V3.Forward(), Math.sin(t * spd - i * 0.35) * a);
        const lift = Q.RotationAxis(V3.Right(), TAIL_HELD[i]);
        n.rotationQuaternion = r.multiply(sway).multiply(lift);
        m.tailAng[i] = tp[i];
        return;
      }
      const goal = tp[i] + (i === 0 ? lift : i === 1 ? lift * 0.6 : i === 2 ? lift * 0.25 : 0) - low * 12 + (err ? (i + 1) * 12 : 0);
      m.tailAng[i] = fresh ? goal : m.tailAng[i] + (goal - m.tailAng[i]) * tk;
      // 방향각 φ(뒤 수평 0°, 위 +) → 누적 X 회전 θ = φ - 90°. 마디 회전은 부모 대비 차이
      const theta = (m.tailAng[i] - 90) * Math.PI / 180;
      const sway = Q.RotationAxis(V3.Forward(), Math.sin(t * spd - i * 0.6) * amp * (0.5 + i * 0.35));
      n.rotationQuaternion = Q.RotationAxis(V3.Right(), theta - prevTheta).multiply(sway);
      // 첫 마디: 기본 자세에서 돌아간 만큼(D = 지금 회전 × 기본 회전의 역) 고리 중심이 제자리에 있도록 위치를 보정 (뼈 위치 O → O + (I - D)(P - O))
      if (i === 0 && m.tailPivot) {
        const D = n.rotationQuaternion.multiply(Q.Inverse(r));
        const rot = new V3(); m.tailPivot.rotateByQuaternionToRef(D, rot);
        n.position.addInPlace(m.tailPivot.subtract(rot));
      }
      prevTheta = theta;
    });
    // 귀: 잘 때·기분 나쁠 때·오류 때 눕힘
    let droop = low * 0.5;
    if (cat.act === 'sleep' || cat.act === 'doze' || cat.act === 'sad') droop = 0.7;
    if (err) droop = 1.0;
    if (urgent) droop = -0.1;
    /**
     * 귀 하나(i = 0 왼쪽, 1 오른쪽)를 기본 자세에서 droop 만큼 눕힌다 (들렸을 때는 EAR_HELD 로 고정).
     * @param {string} k 귀 뼈 이름
     * @param {number} i 0 = 왼쪽, 1 = 오른쪽 (회전 방향 부호)
     * @returns {void}
     */
    ['ear.L', 'ear.R'].forEach((k, i) => {
      const n = m.nodes[k], r = m.rest[k];
      if (!n || !r) return;
      const s = i === 0 ? 1 : -1;
      // 들렸을 때(집기·패러글라이더): 겁먹은 고양이처럼 귀를 바깥쪽 뒤로 35° 눕힘 (Blender 에서 맞춘 값, 양쪽 같음)
      if (held) { n.rotationQuaternion = r.multiply(EAR_HELD); return; }
      n.rotationQuaternion = r.multiply(Q.RotationAxis(V3.Forward(), s * droop * 0.9 * m.cfg.ear));
    });
    // 두 발로 서거나 걷는 중이면 등을 편다 (관절 덮어쓰기는 afterAnimations 에서)
    const upGoal = UPRIGHT_ACTS.has(name) && !cat.held && !m.cfg.ai ? 1 : 0;
    const uk = cat.uprightK || 0;
    cat.uprightK = upGoal > uk ? Math.min(1, uk + dt * 4) : Math.max(0, uk - dt * 4);
    if (cat.uprightK > 0) { hookUpright(cat.root.getScene()); UPRIGHT.add(cat); }
    // 낚시 중(낚시 자리에 앉음): 낚싯대를 잡는 팔 자세를 부드럽게 넣고 뺀다 (관절 덮어쓰기는 afterAnimations 에서)
    const fishGoal = cat.fishing && cat.pose === 'sit' && !cat.held && !m.cfg.ai ? 1 : 0;
    const fk = cat.fishK || 0;
    cat.fishK = fishGoal > fk ? Math.min(1, fk + dt * 3) : Math.max(0, fk - dt * 4);
    if (cat.fishK > 0) { hookFish(cat.root.getScene()); FISHERS.add(cat); }
    // 얼음 위 스케이트: 상체 숙임·팔 벌림·다리 밀기를 부드럽게 넣고 뺀다 (관절 덮어쓰기는 afterAnimations 에서)
    const sg = cat.skating && !cat.held ? 1 : 0;
    const sk = cat.skateK || 0;
    cat.skateK = sg > sk ? Math.min(1, sk + dt * 4) : Math.max(0, sk - dt * 4);
    if (cat.skateK > 0 && !m.groups.skate && !m.cfg.ai) { hookSkate(cat.root.getScene()); SKATING.add(cat); } // 스케이트 동작(anims_*.glb)이 없을 때만 코드로 덮어쓴다
    // 오류: 털 곤두섬 (살짝 부풀었다 줄었다)
    const puff = err ? 1.05 + Math.sin(t * 20) * 0.01 : 1;
    m.top.scaling.set(puff, puff, -puff); // z 부호 유지 (좌우 뒤집힘 방지)
    // 목덜미 잡힘: 몸 전체가 시계추처럼 살짝 흔들리고, 고개·팔다리는 아래로 축 늘어진다
    if (held) {
      m.top.rotationQuaternion = Q.RotationAxis(V3.Forward(), Math.sin(t * 2.4) * 0.07); // 시계추처럼 살짝 흔들림 (기울임은 root 관절이)
      hookHeld(cat.root.getScene());
      HELD.add(cat); // 관절 굽힘은 동작(idle) 재생이 끝난 뒤에 덮어써야 남는다 → afterAnimations 에서
      // 잡힌 목덜미 가죽이 늘어나고 몸통도 축 늘어진다: 목·가슴·허리 관절을 길이 방향(관절 Y)으로 조금씩 늘린다 (고양이 몸은 늘어난다)
      if (!m.cfg.ai) for (const [k, sy] of STRETCH) if (m.nodes[k]) m.nodes[k].scaling.set(1, sy, 1);
    } else {
      HELD.delete(cat);
      if (m.top.rotationQuaternion && (m.top.rotationQuaternion.x || m.top.rotationQuaternion.z)) {
        m.top.rotationQuaternion = Q.Identity();
        if (!m.cfg.ai) for (const [k] of STRETCH) if (m.nodes[k]) m.nodes[k].scaling.set(1, 1, 1);
      }
    }
    if (!held && cat.skateK > 0) m.top.rotationQuaternion = Q.RotationAxis(V3.Forward(), Math.max(-0.2, Math.min(0.2, m.turn * 0.09)) * cat.skateK); // 도는 안쪽으로 몸 기울기
  }

  /**
   * 타자 동작에서 앞발이 자판에 닿은 횟수 (호출 사이에 새로 닿았으면 그 수). 동작 1초에 좌우 번갈아 8번
   * 동작 한 주기를 8칸으로 나눠 칸이 바뀌면 1 을 돌려준다. 타자 동작이 아니면 상태를 비우고 0.
   * @param {Cat} cat 고양이 (cat.model.anim, groups.sit_type 을 읽음)
   * @returns {number} 이번 호출 사이 새로 닿은 횟수 (0 또는 1)
   */
  function keyStrikes(cat) {
    const m = cat.model;
    if (!m || m.anim !== 'sit_type') { if (m) m.strike = null; return 0; }
    const g = m.groups.sit_type;
    const a = g && g.animatables && g.animatables[0];
    if (!a) return 0;
    const t = ((a.masterFrame - g.from) / (g.to - g.from || 1)) % 1; // 0~1 (한 주기)
    const k = Math.floor(t * 8);
    const prev = m.strike;
    m.strike = k;
    if (prev == null || prev === k) return 0;
    return 1;
  }

  /**
   * 말풍선 기준점: 머리 뼈 위
   * 머리 뼈가 없으면 root 위 1.0 m, 있으면 머리 뼈 월드 위치 위 0.42 m.
   * @param {Cat} cat 고양이
   * @returns {BABYLON.Vector3} 월드 좌표 (m)
   */
  function anchor(cat) {
    const h = cat.model.nodes.head;
    if (!h) return cat.root.position.add(new V3(0, 1.0, 0));
    const p = h.getAbsolutePosition();
    return new V3(p.x, p.y + 0.42, p.z);
  }

  /**
   * 공개 API: preload, ready, bodies, breeds, breedName, attach, animate, anchor, keyStrikes.
   */
  return { preload, ready, bodies, breeds, breedName, attach, animate, anchor, keyStrikes, tongue };
})();
