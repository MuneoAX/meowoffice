/**
 * @file 고양이 아바타 (OfficeCat): 생성·자세·걷기·비켜 가기·문 양보.
 * 고양이 아바타 — 교체 가능한 자리표시자.
 * 렌더러는 이 모듈의 공개 함수(create / setSpot / setPose / setAct / setSignal / setProp / setMood / hop / walk / update / bubbleAnchor)에만 의존한다.
 * 최종 모델(glb)이 정해지면 create 안쪽만 glb 로드로 바꾸고 바깥 계약은 유지한다.
 * 공개 API: BREEDS, setDoors, setKeepOut, create, setSpot, setPose, setAct, setSignal, setProp, setMood, hop, seatRise, walk, isWalking, update, resolveOverlaps, bubbleAnchor, remove, all(ALL).
 * 좌표계: 월드 x·z 가 바닥, y 가 위, 길이 단위 m. 고양이 원점 = 발바닥 중앙, 정면 = -Z. 각도는 라디안 (root.rotation.y 가 heading).
 * 3D 모델(catmodel.js)이 준비돼 있으면 create 가 그것을 쓰고 update 가 CatModel.animate 로 넘긴다. 없으면 구슬(타원체)로 만든 임시 모형을 쓴다.
 *
 * @typedef {Object} Spot 고양이가 서거나 앉는 자리
 * @property {BABYLON.Vector3} pos 자리 위치 (월드, m)
 * @property {number} rotY 바라볼 방향 (root.rotation.y, 라디안)
 * @property {string} [pose='stand'] 도착 뒤 자세 stand | sit | loaf | walk
 * @property {number} [seatY=0.5] 앉을 때 좌석 높이(m)
 *
 * @typedef {Object} Cat 고양이 객체 (create 가 만든다). 모델이 있으면 model/body 가 채워진다
 * @property {string} id 고양이 id
 * @property {string} breed 품종 키
 * @property {string|null} body 체형 키 (임시 모형이면 null)
 * @property {BABYLON.TransformNode} root 고양이 자리 노드 (원점 = 발바닥 중앙, 정면 -Z)
 * @property {BABYLON.AbstractMesh[]} meshes 몸 메시들
 * @property {BABYLON.TransformNode|null} hips 엉덩이 노드 (임시 모형만)
 * @property {BABYLON.TransformNode} head 머리 노드 (모델이면 head 뼈, 없으면 root)
 * @property {BABYLON.TransformNode[]} ears 귀 노드 [왼, 오른] (임시 모형만)
 * @property {BABYLON.TransformNode[]} arms 팔 노드 [왼, 오른] (임시 모형만)
 * @property {BABYLON.TransformNode[]} legs 다리 노드 [왼, 오른] (임시 모형만)
 * @property {BABYLON.TransformNode[]} tail 꼬리 마디 4개 (임시 모형만)
 * @property {Object<string, BABYLON.TransformNode>} props 소품 노드 { board, box, sign } (임시 모형만, 모델이면 model.props)
 * @property {string|null} prop 지금 든 소품 null | board | box | sign
 * @property {BABYLON.Mesh} [torso] 몸통 메시 (임시 모형만, 털 곤두섬용)
 * @property {string} pose 자세 stand | sit | loaf(웅크림) | walk
 * @property {string} act 자세 위에 얹는 동작 idle | type | read | talk | drink | sleep | stamp | nod | shake | highfive | present | sad | sign | fidget | doze ...
 * @property {string|null} signal 신호 null | permission | waiting | thinking | complete | error
 * @property {number} t 이 고양이만의 경과 시간(초, 시작값은 0~10 무작위)
 * @property {BABYLON.Vector3[]|null} path 남은 경로 점들 (걷는 중이 아니면 null)
 * @property {number} heading 바라볼 방향 (라디안)
 * @property {number} mood 기분 0~1 (1 = 좋음)
 * @property {number} hopT 기쁨 뛰기 남은 시간(초)
 * @property {Object} [model] CatModel.attach 가 만든 모델 정보 (CatModelInfo, catmodel.js)
 * @property {number} [seatY] 앉을 좌석 높이(m)
 * @property {BABYLON.Vector3} [base] 경로 위 기준 위치 (비켜선 만큼은 side 로 따로)
 * @property {Spot|null} [goal] 걷기가 끝나면 설 자리
 * @property {function(Cat): void|null} [onArrive] 도착 콜백
 * @property {number} [side] 경로에서 옆으로 비켜선 거리(m, 진행 방향의 옆)
 * @property {number} [wait] 막혀서 기다린 시간(초)
 * @property {number} [gait] 걸음 위상 (임시 모형 다리 흔들기·결재 줄 걷기용)
 * @property {number} [moveK] 지금 이동 비율 0~1
 * @property {number} [hurry] 걷는 속도 배율 (서두르면 1.8, 없으면 1)
 * @property {number} [ghostT] 간격 규칙을 잠시 푸는 남은 시간(초)
 * @property {boolean} [yielding] 마주 오는 고양이에게 길을 양보하는 중인가
 * @property {Cat|null} [meet] 지금 마주 오는 상대 (몸이 완전히 지나칠 때까지 옆 간격 검사에서 빼지 않는다)
 * @property {boolean} [meetYield] 이 마주침에서 내가 비키는 쪽으로 정해졌는가 (meet 가 풀릴 때까지 바뀌지 않음)
 * @property {boolean} [held] 목덜미를 잡혀 들린 상태인가
 * @property {number} [fishK] 낚시 자세 섞임 정도 0~1 (catmodel)
 * @property {boolean} [skating] 언 연못 위에서 미끄러지는 중인가 (openoffice 가 매 프레임 기록)
 * @property {number} [skateK] 스케이트 자세 섞임 정도 0~1 (catmodel)
 * @property {number} [uprightK] 등 펴기 섞임 정도 0~1 (catmodel)
 * @property {boolean} [quad] 바깥 네 발 걷기 모드인가
 * @property {boolean} [landing] 내려오는 중인가 (demo 가 읽음)
 *
 * @typedef {Object} DoorDef setDoors 에 넘기는 문 정의
 * @property {number} cx 문 중심 x (m)
 * @property {number} cz 문 중심 z (m)
 * @property {string} axis 벽에 수직인 축 'x' 또는 'z' (이 축 좌표가 at 보다 큰지로 어느 쪽인지 정함)
 * @property {number} at 벽(문)이 놓인 축 좌표 (m)
 *
 * @typedef {Object} DoorState 문 상태 (DoorDef + 통과 중 고양이와 대기 시각)
 * @property {Map<Cat, number>} users 지금 문을 지나는 고양이 → 출발 쪽 ±1
 * @property {Object<string, number>} waitSince 방향('-1'|'1') → 그쪽 고양이가 기다리기 시작한 시각(clock 초)
 *
 * @typedef {Object} AvoidResult avoid() 결과
 * @property {number} want 옆으로 비켜서려는 목표 거리(m, 진행 방향의 옆 기준, 양수 = 비킴)
 * @property {number} speedK 속도 배율 0~1 (0 이면 멈춤)
 * @property {number} px 진행 방향의 옆 단위벡터 x
 * @property {number} pz 진행 방향의 옆 단위벡터 z
 * @property {boolean} [yielding] 길을 양보하는 중인가
 * @property {Cat|null} [meet] 지금 마주 오는 상대 (지나칠 때까지 옆 간격 검사에서 빼지 않는다)
 *
 * @typedef {Object} BreedColors 임시 모형 품종 색 묶음 (모두 '#rrggbb')
 * @property {string} body 몸
 * @property {string} belly 배
 * @property {string} muzzle 주둥이
 * @property {string} paw 발
 * @property {string} ear 귀
 * @property {string} tail 꼬리
 * @property {string} tailTip 꼬리 끝
 * @property {string} [tie] 넥타이 (대표만)
 */
'use strict';

const OfficeCat = (() => {
  /**
   * Babylon 3차원 벡터 약칭.
   */
  const V3 = BABYLON.Vector3;

  /**
   * 품종 = 색 묶음. 최종 모델에서는 팔레트 이미지 한 장으로 대체된다.
   * 임시 모형용 표: 품종 키(cheese · tuxedo · siamese · boss) → 부위별 색('#rrggbb').
   * @type {Object<string, BreedColors>}
   */
  const BREEDS = {
    cheese: { body: '#f2b06a', belly: '#fff7ec', muzzle: '#fff7ec', paw: '#fff7ec', ear: '#f2b06a', tail: '#f2b06a', tailTip: '#e59a4d' },
    tuxedo: { body: '#35383f', belly: '#fbfaf8', muzzle: '#fbfaf8', paw: '#fbfaf8', ear: '#35383f', tail: '#35383f', tailTip: '#35383f' },
    siamese: { body: '#f4e7d4', belly: '#fbf3e7', muzzle: '#6e4c3c', paw: '#6e4c3c', ear: '#6e4c3c', tail: '#6e4c3c', tailTip: '#5a3c2f' },
    // 대표(사용자 아바타): 회색 + 빨간 넥타이. 나중에 사용자가 고른다.
    boss: { body: '#9aa3b2', belly: '#eef0f4', muzzle: '#eef0f4', paw: '#eef0f4', ear: '#9aa3b2', tail: '#9aa3b2', tailTip: '#7e8796', tie: '#d4483b' },
  };
  /**
   * 임시 모형 소품 색 표 ('#rrggbb'): 결재판(paper·board·clip·ink), 상자(box·tape), 팻말(sign·stick).
   * @type {Object<string, string>}
   */
  const PROP = { paper: '#fbfaf6', board: '#b98f63', clip: '#a7adb8', box: '#d9b07c', tape: '#c99558', sign: '#fff4dc', stick: '#8a6a4a', ink: '#3b3f4a' };
  /**
   * 품종과 상관없이 고정인 얼굴 색 ('#rrggbb'): 눈·눈 반짝임·코·귀 안쪽.
   * @type {Object<string, string>}
   */
  const FIXED = { eye: '#1d1f24', shine: '#ffffff', nose: '#f19aa3', earInner: '#f7b7bd' };

  /**
   * 색('#rrggbb') → 공용 재질 캐시.
   * @type {Map<string, BABYLON.StandardMaterial>}
   */
  const mats = new Map();
  /**
   * 만든 고양이 전체 (비켜 가기용). 공개 API 의 all 로도 나간다.
   * @type {Cat[]}
   */
  const ALL = []; // 만든 고양이 전체 (비켜 가기용)

  // ── 문 양보: 문은 한 번에 한 방향으로만 지난다 ─────────────────────
  // 문 가까이(DOOR_R)에서 경로가 벽을 넘어가면 통과를 신청한다. 반대 방향 고양이가 문을 쓰는 중이면 문 앞에서 기다린다.
  // 한쪽이 오래(DOOR_FAIR 초) 기다리면 지금 방향의 새 신청은 받지 않아 번갈아 지나가게 한다.
  /**
   * 문 상태 목록. { cx, cz, axis, at, users: Map(cat → 출발 쪽 ±1), waitSince: { '-1': t, '1': t } }
   * @type {DoorState[]}
   */
  const DOORS = []; // { cx, cz, axis, at, users: Map(cat → 출발 쪽 ±1), waitSince: { '-1': t, '1': t } }
  /**
   * DOOR_R: 문 중심에서 이 거리(m) 안이면 통과 신청 대상. DOOR_FAIR: 반대쪽이 이 시간(초) 넘게 기다리면 지금 방향의 새 신청은 받지 않는다.
   */
  const DOOR_R = 1.6, DOOR_FAIR = 3;
  /**
   * 문 목록을 통째로 바꾼다 (사무실을 열 때 한 번).
   * 각 문에 빈 users·waitSince 를 붙여 DOORS 에 담는다.
   * @param {DoorDef[]} list 문 정의 목록
   * @returns {void}
   */
  function setDoors(list) {
    DOORS.length = 0;
    for (const d of list) DOORS.push({ ...d, users: new Map(), waitSince: {} });
  }
  /**
   * 물체 간격 띠 (사무실이 넘겨준다, 없으면 null). push: 점을 띠 밖으로 민 점, exempt: 경로 출발·도착 근처라 뺄 물체들.
   * @type {{push: function(number, number, Set=): {x:number, z:number}, exempt: function(Array<{x:number, z:number}>): Set}|null}
   */
  let keepOut = null;
  /**
   * 물체 간격 띠를 정한다 (사무실을 열 때 한 번). 걷는 고양이는 매 프레임 이 띠 밖으로 밀린다.
   * @param {{push: Function, exempt: Function}|null} h openoffice 의 keepOut (null 이면 끔)
   * @returns {void}
   * @see stepMove
   */
  function setKeepOut(h) { keepOut = h || null; }
  /**
   * 문 d 의 벽 어느 쪽에 점 (x, z) 가 있는가.
   * @param {DoorState} d 문
   * @param {number} x 월드 x (m)
   * @param {number} z 월드 z (m)
   * @returns {number} -1 또는 1 (벽 위면 1)
   */
  const sideOf = (d, x, z) => Math.sign((d.axis === 'x' ? x : z) - d.at) || 1;
  /**
   * 이번 걸음에 문을 지나가도 되는가. 문과 상관없으면 true
   * 문 가까이(DOOR_R)에서 앞으로 2.5 m 안 경로가 벽을 넘으면 통과를 신청한다. 반대 방향 고양이가 쓰는 중이거나 반대쪽이 DOOR_FAIR 초 넘게 기다렸으면 false(기다림).
   * 이미 통과 중이면 벽을 0.5 m 넘었거나 문에서 멀어질 때 users 에서 뺀다.
   * @param {Cat} cat 걷는 고양이 (cat.base, cat.path 를 읽음)
   * @param {number} now 문 양보용 시계(초)
   * @returns {boolean} 지나가도 되면 true, 문 앞에서 차례를 기다려야 하면 false
   * @see sideOf
   */
  function doorPass(cat, now) {
    const p = cat.base;
    let ok = true;
    for (const d of DOORS) {
      const near = Math.hypot(p.x - d.cx, p.z - d.cz) < DOOR_R;
      const s = sideOf(d, p.x, p.z);
      // 앞으로 2.5 m 안에서 벽 반대편으로 넘어가는가
      let crosses = false, dist = 0, prev = p;
      if (near && cat.path) for (const q of cat.path) {
        dist += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q;
        if (sideOf(d, q.x, q.z) !== s) { crosses = true; break; }
        if (dist > 2.5) break;
      }
      const mine = d.users.get(cat);
      if (mine !== undefined) {
        // 이미 지나는 중: 벽을 0.5 m 넘었거나 문에서 멀어지면 끝
        const past = sideOf(d, p.x, p.z) !== mine && Math.abs((d.axis === 'x' ? p.x : p.z) - d.at) > 0.5;
        if (past || !near || !cat.path) d.users.delete(cat);
        continue;
      }
      if (!crosses) continue;
      let against = false;
      for (const [o, side] of d.users) {
        if (!o.path || !o.root.isEnabled()) { d.users.delete(o); continue; }
        if (side !== s) against = true;
      }
      const otherWait = d.waitSince[-s];
      const unfair = otherWait !== undefined && now - otherWait > DOOR_FAIR && d.users.size > 0;
      if (against || unfair) {
        if (d.waitSince[s] === undefined) d.waitSince[s] = now;
        ok = false;
      } else {
        d.users.set(cat, s);
        if (d.waitSince[s] !== undefined) {
          // 이쪽에 아직 기다리는 고양이가 있는지는 다음 신청 때 다시 정해진다
          delete d.waitSince[s];
        }
      }
    }
    return ok;
  }
  /**
   * 문 양보용 시계(초). update 가 첫 고양이일 때 프레임당 한 번 더한다.
   * @type {number}
   */
  let clock = 0;
  /**
   * 색 하나의 공용 재질을 얻는다 (색별 캐시, 얼림, 고양이를 지울 때 지우지 않도록 shared 표시).
   * @param {BABYLON.Scene} scene 장면
   * @param {string} hex '#rrggbb'
   * @returns {BABYLON.StandardMaterial} 공용 재질
   */
  function mat(scene, hex) {
    if (mats.has(hex)) return mats.get(hex);
    const m = new BABYLON.StandardMaterial('cat_' + hex, scene);
    m.diffuseColor = BABYLON.Color3.FromHexString(hex);
    m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    m.metadata = { shared: true }; // 색별 공용 재질
    m.freeze();
    mats.set(hex, m);
    return m;
  }

  /**
   * 타원체(지름 1 구를 sx·sy·sz 로 늘림) 메시를 만들어 부모에 붙인다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name 메시 이름
   * @param {number} sx x 방향 지름(m)
   * @param {number} sy y 방향 지름(m)
   * @param {number} sz z 방향 지름(m)
   * @param {string} hex 색 '#rrggbb'
   * @param {BABYLON.TransformNode} parent 붙일 부모
   * @param {number} x 부모 기준 x(m)
   * @param {number} y 부모 기준 y(m)
   * @param {number} z 부모 기준 z(m)
   * @param {number} [seg=12] 구 분할 수
   * @returns {BABYLON.Mesh} 만든 메시
   * @see mat
   */
  function ell(scene, name, sx, sy, sz, hex, parent, x, y, z, seg = 12) {
    const m = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 1, segments: seg }, scene);
    m.scaling.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.material = mat(scene, hex);
    m.parent = parent;
    return m;
  }
  /**
   * 빈 변환 노드(관절 자리)를 만들어 부모에 붙인다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name 노드 이름
   * @param {BABYLON.TransformNode} parent 붙일 부모
   * @param {number} x 부모 기준 x(m)
   * @param {number} y 부모 기준 y(m)
   * @param {number} z 부모 기준 z(m)
   * @returns {BABYLON.TransformNode} 만든 노드
   */
  function node(scene, name, parent, x, y, z) {
    const n = new BABYLON.TransformNode(name, scene);
    n.parent = parent;
    n.position.set(x, y, z);
    return n;
  }

  /**
   * 고양이 하나. 원점 = 발바닥 중앙, 정면 = -Z, 서 있는 키 약 0.9 m
   * 3D 모델이 준비돼 있으면(CatModel.ready()) 모델을 붙인 고양이를, 아니면 타원체로 만든 임시 모형(머리·귀·팔·다리·꼬리 4마디·소품)을 돌려준다.
   * 만든 고양이는 ALL 에 들어간다. 모든 메시는 클릭을 받고 metadata.catId 를 가진다.
   * @param {BABYLON.Scene} scene 장면
   * @param {{id: string, breed?: string, body?: (string|null)}} opts id 고양이 id, breed 품종 키(기본 'korean_cheese'), body 체형 키(기본 null = 품종이 정함)
   * @returns {Cat} 새 고양이
   * @see CatModel.attach
   * @see ell
   * @see node
   */
  function create(scene, { id, breed = 'korean_cheese', body = null }) {
    // 3D 모델이 준비돼 있으면 그것을 쓴다 (catmodel.js). 없으면 아래 임시 모형.
    if (typeof CatModel !== 'undefined' && CatModel.ready()) {
      const root = new BABYLON.TransformNode('cat:' + id, scene);
      const cat = {
        id, breed, body, root, meshes: [], hips: null, head: null, ears: [], arms: [], legs: [], tail: [], props: {}, prop: null,
        pose: 'stand', act: 'idle', signal: null, t: Math.random() * 10, path: null, heading: 0, mood: 1, hopT: 0,
      };
      cat.model = CatModel.attach(scene, cat, breed, body);
      cat.body = cat.model.body;
      cat.breed = cat.model.breed;
      cat.meshes = cat.model.meshes;
      cat.head = cat.model.nodes.head || root;
      ALL.push(cat);
      return cat;
    }
    const c = BREEDS[breed] || BREEDS.cheese;
    const root = new BABYLON.TransformNode('cat:' + id, scene);
    const meshes = [];
    /**
     * 메시를 meshes 목록에 넣고 그대로 돌려준다 (임시 모형 부품 모으기).
     * @param {BABYLON.Mesh} m 메시
     * @returns {BABYLON.Mesh} 같은 메시
     */
    const M = (m) => (meshes.push(m), m);

    const hips = node(scene, 'hips', root, 0, 0.2, 0);
    const torso = M(ell(scene, 'torso', 0.3, 0.32, 0.27, c.body, hips, 0, 0.12, 0, 14));
    M(ell(scene, 'belly', 0.2, 0.22, 0.1, c.belly, hips, 0, 0.1, -0.1, 10));

    const head = node(scene, 'head', hips, 0, 0.42, 0);
    M(ell(scene, 'skull', 0.5, 0.4, 0.38, c.body, head, 0, 0, 0, 16));
    M(ell(scene, 'muzzle', 0.17, 0.11, 0.08, c.muzzle, head, 0, -0.07, -0.16, 10));
    for (const s of [-1, 1]) {
      M(ell(scene, 'eye', 0.062, 0.08, 0.03, FIXED.eye, head, s * 0.105, 0.0, -0.165, 10));
      M(ell(scene, 'shine', 0.02, 0.022, 0.01, FIXED.shine, head, s * 0.105 + s * 0.01, 0.022, -0.181, 6));
    }
    M(ell(scene, 'nose', 0.035, 0.022, 0.02, FIXED.nose, head, 0, -0.045, -0.193, 8));

    const ears = [];
    for (const s of [-1, 1]) {
      const pivot = node(scene, 'ear', head, s * 0.13, 0.14, 0.01);
      pivot.rotation.z = -s * 0.32;
      const outer = BABYLON.MeshBuilder.CreateCylinder('earO', { diameterTop: 0, diameterBottom: 0.17, height: 0.17, tessellation: 12 }, scene);
      outer.scaling.z = 0.45;
      outer.position.y = 0.07;
      outer.material = mat(scene, c.ear);
      outer.parent = pivot;
      const inner = BABYLON.MeshBuilder.CreateCylinder('earI', { diameterTop: 0, diameterBottom: 0.11, height: 0.12, tessellation: 10 }, scene);
      inner.scaling.z = 0.25;
      inner.position.set(0, 0.055, -0.025);
      inner.material = mat(scene, FIXED.earInner);
      inner.parent = pivot;
      M(outer); M(inner);
      ears.push(pivot);
    }

    const arms = [];
    for (const s of [-1, 1]) {
      const sh = node(scene, 'shoulder', hips, s * 0.12, 0.2, 0);
      sh.rotation.z = s * 0.75; // A 자세
      M(ell(scene, 'arm', 0.09, 0.2, 0.09, c.body, sh, 0, -0.09, 0, 10));
      M(ell(scene, 'hand', 0.09, 0.09, 0.09, c.paw, sh, 0, -0.2, 0, 8));
      arms.push(sh);
    }
    const legs = [];
    for (const s of [-1, 1]) {
      const hip = node(scene, 'hip', hips, s * 0.075, 0.0, 0);
      M(ell(scene, 'leg', 0.11, 0.2, 0.11, c.body, hip, 0, -0.08, 0, 10));
      M(ell(scene, 'foot', 0.11, 0.07, 0.15, c.paw, hip, 0, -0.165, -0.03, 8));
      legs.push(hip);
    }

    // 꼬리: 마디 4개 사슬. 각 마디를 돌려 휘게 한다 (최종 모델의 tail_01~04 와 같은 구조).
    const tail = [];
    let parent = node(scene, 'tailBase', hips, 0, 0.04, 0.12);
    parent.rotation.x = -1.1;
    for (let i = 0; i < 4; i++) {
      const seg = node(scene, 'tail' + i, parent, 0, i === 0 ? 0 : 0.1, 0);
      const hex = i === 3 ? c.tailTip : c.tail;
      M(ell(scene, 'tailSeg', 0.065, 0.13, 0.065, hex, seg, 0, 0.05, 0, 8));
      seg.rotation.x = 0.35;
      tail.push(seg);
      parent = seg;
    }

    if (c.tie) {
      M(ell(scene, 'tie', 0.05, 0.16, 0.03, c.tie, hips, 0, 0.17, -0.135, 6));
      M(ell(scene, 'knot', 0.06, 0.04, 0.03, c.tie, hips, 0, 0.26, -0.13, 6));
    }

    // 소품: 결재판(가슴 앞), 상자(두 팔 앞), 팻말(오른손)
    /**
     * 임시 모형 소품 상자 하나를 만든다.
     * @param {string} n 메시 이름
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
    const box = (n, w, h, d, hex, parent, x, y, z) => {
      const m = BABYLON.MeshBuilder.CreateBox(n, { width: w, height: h, depth: d }, scene);
      m.position.set(x, y, z);
      m.material = mat(scene, hex);
      m.parent = parent;
      return m;
    };
    const boardN = node(scene, 'propBoard', hips, 0, 0.17, -0.2);
    boardN.rotation.x = -0.35;
    box('board', 0.2, 0.26, 0.015, PROP.board, boardN, 0, 0, 0);
    box('paper', 0.17, 0.21, 0.004, PROP.paper, boardN, 0, -0.01, -0.01);
    box('clip', 0.08, 0.03, 0.02, PROP.clip, boardN, 0, 0.12, -0.012);
    box('line1', 0.12, 0.012, 0.002, PROP.ink, boardN, 0, 0.04, -0.013);
    box('line2', 0.1, 0.012, 0.002, PROP.ink, boardN, -0.01, 0.0, -0.013);
    const boxN = node(scene, 'propBox', hips, 0, 0.16, -0.25);
    box('box', 0.3, 0.22, 0.24, PROP.box, boxN, 0, 0, 0);
    box('tape', 0.31, 0.03, 0.06, PROP.tape, boxN, 0, 0.11, 0);
    const signN = node(scene, 'propSign', arms[1], 0, -0.22, 0);
    box('stick', 0.025, 0.42, 0.025, PROP.stick, signN, 0, -0.2, 0);
    box('sign', 0.32, 0.22, 0.02, PROP.sign, signN, 0, -0.44, 0);
    box('q', 0.05, 0.1, 0.004, PROP.ink, signN, 0, -0.44, -0.013);
    const props = { board: boardN, box: boxN, sign: signN };
    for (const n of Object.values(props)) n.setEnabled(false);

    for (const m of root.getChildMeshes()) { m.isPickable = true; m.metadata = { catId: id }; }

    const cat = {
      id, breed, root, meshes: root.getChildMeshes(), hips, head, ears, arms, legs, tail, props, prop: null, torso,
      pose: 'stand', act: 'idle', signal: null, t: Math.random() * 10, path: null, heading: 0, mood: 1, hopT: 0,
    };
    ALL.push(cat);
    return cat;
  }

  // ── 위치·자세·행동 ────────────────────────────────────────────────
  // pose: stand | sit(좌석 높이 seatY) | loaf(웅크림) | walk
  // act : idle | type | read | talk | drink | sleep  (자세 위에 얹는 팔·머리 동작)

  /**
   * 고양이를 자리에 바로 놓는다 (위치·방향·heading 설정).
   * @param {Cat} cat 고양이
   * @param {Spot} spot 자리 (pos, rotY 를 읽음)
   * @returns {void}
   */
  function setSpot(cat, spot) {
    cat.root.position.copyFrom(spot.pos);
    cat.root.rotation.y = spot.rotY;
    cat.heading = spot.rotY;
  }

  /**
   * 자세를 바꾼다 (stand | sit | loaf | walk). 앉을 때는 좌석 높이도 함께 둔다.
   * @param {Cat} cat 고양이
   * @param {string} pose 자세 stand | sit | loaf | walk
   * @param {number} [seatY=0.5] 좌석 높이(m)
   * @returns {void}
   */
  function setPose(cat, pose, seatY = 0.5) {
    cat.pose = pose;
    cat.seatY = seatY;
  }

  /**
   * 자세 위에 얹는 동작을 바꾼다 (idle | type | read | talk | drink | sleep ...). 빈 값이면 idle.
   * @param {Cat} cat 고양이
   * @param {string|null} act 동작 이름
   * @returns {void}
   */
  function setAct(cat, act) { cat.act = act || 'idle'; }

  /**
   * 소품: null | board(결재판) | box(배달 상자) | sign(질문 팻말)
   * 임시 모형은 cat.props 노드를 켜고 끈다 (모델은 animate 가 prop 을 보고 켬).
   * @param {Cat} cat 고양이
   * @param {string|null} prop 소품 이름 (빈 값이면 소품 없음)
   * @returns {void}
   */
  function setProp(cat, prop) {
    cat.prop = prop || null;
    for (const [k, n] of Object.entries(cat.props || {})) n.setEnabled(k === cat.prop);
  }
  /**
   * 선 자세의 몸이 앉은 자세(seatY)와 같은 높이가 되려면 뿌리를 얼마나 들어야 하는가.
   * 소파 위로 뛰어오를 때 뿌리 높이를 이만큼까지 올려 두었다가, 착지하며 뿌리를 0 으로 되돌리고 앉은 자세로 바꾸면 몸이 튀지 않는다.
   * 모델은 앉으면 max(0, seatY - sitDrop), 서면 -legDrop 만큼 몸 높이가 달라지고 임시 모형은 엉덩이가 0.2 → seatY + 0.02 로 바뀐다.
   * @param {Cat} cat 고양이
   * @param {number} seatY 좌석 높이(m)
   * @returns {number} 뿌리를 들어야 하는 높이(m, 0 이상)
   * @see CatModel.animate
   */
  function seatRise(cat, seatY) {
    const m = cat.model;
    if (m) return Math.max(0, seatY - m.cfg.sitDrop) + (m.legDrop || 0);
    return Math.max(0, seatY - 0.18);
  }
  /**
   * 기쁨 뛰기 (초)
   * @param {Cat} cat 고양이
   * @param {number} [sec=1.2] 뛰는 시간(초)
   * @returns {void}
   */
  function hop(cat, sec = 1.2) { cat.hopT = sec; }
  /**
   * 기분 0~1
   * 범위 밖 값은 0~1 로 자른다.
   * @param {Cat} cat 고양이
   * @param {number} m 기분 (1 = 좋음)
   * @returns {void}
   */
  function setMood(cat, m) { cat.mood = Math.max(0, Math.min(1, m)); }

  /**
   * signal: null | permission | waiting | thinking | complete — 귀·꼬리·팔로 신호
   * @param {Cat} cat 고양이
   * @param {string|null} signal 신호 이름
   * @returns {void}
   */
  function setSignal(cat, signal) { cat.signal = signal; }

  /**
   * 경로(점 목록)를 따라 걷고, 끝나면 spot 의 방향·자세로 멈춘다
   * 경로를 y=0 의 새 벡터로 복사해 cat.path 로 두고, 자세를 walk 로 바꾼 뒤 기준 위치(base)·옆으로 비킨 거리(side)·기다린 시간(wait)을 초기화한다.
   * 실제 이동은 update → stepMove 가 한다.
   * @param {Cat} cat 고양이
   * @param {Array<{x: number, z: number}>} points 가야 할 점들 (월드 x·z, m)
   * @param {Spot|null} spot 도착 뒤 설 자리 (없으면 그냥 선다)
   * @param {function(Cat): void} [onArrive] 도착했을 때 불리는 콜백
   * @returns {void}
   * @see stepMove
   */
  function walk(cat, points, spot, onArrive) {
    cat.path = points.map((p) => new V3(p.x, 0, p.z));
    cat.goal = spot;
    cat.onArrive = onArrive;
    cat.pose = 'walk';
    cat.act = 'idle';
    cat.root.position.y = 0;
    cat.base = cat.root.position.clone(); // 경로 위 위치 (비켜선 만큼은 side 로 따로 둔다)
    cat.side = 0;
    cat.wait = 0;
  }

  /**
   * 경로를 따라 걷는 중인가.
   * @param {Cat} cat 고양이
   * @returns {boolean}
   */
  function isWalking(cat) { return !!(cat.path && cat.path.length); }

  /**
   * 걷는 속도(m/s): SPEED_IN = 실내 두 발, SPEED_OUT = 바깥 네 발 (걸음 동작 보폭에 맞춤).
   */
  const SKATE_SPEED = 1.5; // m/s: 얼음 위 평균 속도
  const SKATE_STRIDE = (Math.PI * 2) / 1.6; // 한 번 지치는 주기 1.6초 (catmodel.js 의 SKATE_STRIDE 와 같은 값)
  const SPEED_IN = 0.8, SPEED_OUT = 1.0; // m/s: 실내 두 발, 바깥 네 발 (걸음 동작 보폭에 맞춤)
  /**
   * 두 발 걷기에서 걸음 동작이 보이는 목표 배속 (약 3.4배속). 보폭이 짧은 체형의 속도를 정하는 데 쓴다.
   * @type {number}
   */
  const BIPED_RATE = 3.4;
  /**
   * 걷는 속도(m/s): 네 발(바깥 + 네 발 체형)은 SPEED_OUT. 두 발은 SPEED_IN 이되 보폭이 짧은 체형(장모·짧은다리)은
   * 걸음 동작이 같은 빠르기(약 3.4배속)로 보이게 보폭에 비례해 느리게 — 장모형이 밖에서 5~6배속으로 발을 휘저어 네 발처럼 보이던 문제
   * @param {Cat} cat 고양이 (quad, model.cfg 를 읽음)
   * @returns {number} 이동 속도(m/s)
   */
  function walkSpeed(cat) {
    if (cat.skating) return SKATE_SPEED * (0.85 + 0.25 * Math.abs(Math.sin(cat.t * SKATE_STRIDE))); // 지칠 때 빨라졌다 미끄러지며 느려짐
    const cfg = cat.model && cat.model.cfg;
    if (cfg && cfg.speed) return cfg.speed; // ai 체형: 모델 걷기 동작에 맞춘 속도
    if (cat.quad && (!cfg || cfg.quad)) return SPEED_OUT;
    const g = cfg && cfg.gait && cfg.gait.walk;
    return g ? Math.min(SPEED_IN, (g[1] / g[0]) * BIPED_RATE) : SPEED_IN;
  }
  /**
   * 각도 a 에서 b 로 가장 짧은 방향으로 k(0~1) 만큼 다가간다 (2π 감김 처리).
   * @param {number} a 현재 각도 (라디안)
   * @param {number} b 목표 각도 (라디안)
   * @param {number} k 다가갈 비율 0~1
   * @returns {number} 새 각도 (라디안)
   */
  function angleLerp(a, b, k) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
  }

  // ── 비켜 가기 (고양이끼리 겹치지 않기) ──────────────────────────
  // 규칙
  //  1) 몸 간격 BODY 안으로는 다가가지 않는다 (앞을 막으면 멈춤).
  //  2) 마주 오면 한 마리만 비킨다: 요청 처리 중(결재판·상자·팻말·신호)인 고양이가 우선, 같으면 번호가 작은 쪽이 우선.
  //     비키는 쪽은 옆으로 물러서서 멈춰 기다리고, 상대가 지나가면 다시 간다. 우선인 쪽은 살짝 오른쪽으로 붙어 지나간다.
  //  3) 같은 쪽으로 앞서 가는 고양이는 간격을 두고 따라간다. 가로질러 오면 우선이 아닌 쪽이 멈춘다.
  //  4) 서 있거나 앉은 고양이는 먼 쪽으로 돌아간다.
  //  (얼음 위(skating)에서는 옆으로 비키지 않고 속도로만 간격을 맞춘다: 고리 밖은 잔교·물가)
  //  5) 오래 막히면 비키는 쪽이 더 물러설 뿐, 앞을 뚫고 지나가지 않는다.
  //  6) 마지막 안전장치: resolveOverlaps() 가 매 프레임 너무 가까운 쌍을 떼어 놓는다 (걷는 쪽을 민다).
  // 경로를 따라가는 기준점(base)은 그대로 두고, 옆으로 비켜선 거리(side)만 따로 둔다.
  /**
   * 앞을 살피는 거리(m).
   * @type {number}
   */
  const LOOK = 1.8; // 앞을 살피는 거리
  /**
   * 고양이 몸 간격 (중심 사이, m). 3D 모델 머리 폭 약 0.52 m + 여유 — 붙지 않게
   * @type {number}
   */
  const BODY = 0.65; // 고양이 몸 간격 (중심 사이). 3D 모델 머리 폭 약 0.52 m + 여유 — 붙지 않게
  /**
   * 서 있는 고양이 옆을 지날 때 간격(m).
   * @type {number}
   */
  const GAP = 0.75; // 서 있는 고양이 옆을 지날 때 간격
  /**
   * 우선인 쪽이 오른쪽으로 붙는 거리(m).
   * @type {number}
   */
  const KEEP_RIGHT = 0.3; // 우선인 쪽이 붙는 거리
  /**
   * 비키는 쪽이 옆으로 물러서는 거리(m).
   * @type {number}
   */
  const STEP_ASIDE = 0.68; // 비키는 쪽이 물러서는 거리
  /**
   * 길 우선순위: 요청 처리 중(소품·신호가 있는) 고양이가 1, 아니면 0.
   * @param {Cat} c 고양이
   * @returns {number} 1 또는 0
   */
  const prio = (c) => (c.prop || c.signal ? 1 : 0);
  /**
   * a 가 b 에게 길을 양보해야 하는가: 우선순위가 낮거나, 같으면 id 가 큰(문자열 비교) 쪽이 양보한다.
   * @param {Cat} a 나
   * @param {Cat} b 상대
   * @returns {boolean} a 가 양보하면 true
   * @see prio
   */
  const yields = (a, b) => prio(a) < prio(b) || (prio(a) === prio(b) && a.id > b.id);
  /**
   * 앞쪽 고양이를 살펴 비켜설 거리와 속도 배율을 정한다 (위 규칙 1~5).
   * ALL 의 다른 고양이 중 앞쪽 LOOK 안, 옆 간격 GAP 안인 것만 보고, 상대가 멈췄으면 돌아가고, 같은 쪽으로 가면 간격 유지, 마주 오면 한 마리만 비키고, 가로질러 오면 우선이 아닌 쪽이 멈춘다.
   * 목적지 근처(남은 거리 0.9 m 미만)에서는 비킨 거리를 경로로 되돌린다. window.__noAvoid 가 켜져 있으면 끈다 (개발용).
   * @param {Cat} cat 걷는 고양이 (base, side, wait 를 읽음)
   * @param {{x: number, z: number}} d 진행 방향 단위벡터 (월드 x·z)
   * @param {number} remain 남은 경로 길이(m)
   * @returns {AvoidResult} 비켜설 목표 거리(want), 속도 배율(speedK), 옆 방향(px, pz), 양보 중 여부(yielding)
   * @see yields
   */
  function avoid(cat, d, remain) {
    const px = d.z, pz = -d.x; // 진행 방향의 옆 (모든 고양이가 같은 규칙)
    if (window.__noAvoid) return { want: 0, speedK: 1, px, pz }; // 개발용: 비교 측정 때 끄기
    let want = 0, speedK = 1, yielding = false;
    // 마주 오는 상대(meet)는 한 번 정하면 지나칠 때까지 옆 간격 검사에서 빼지 않는다:
    // 비켜서 옆 간격이 GAP+0.2 를 넘는 순간 상대가 '안 보여' 다시 제 길로 돌아오고 → 다시 마주쳐 떠는 것을 막는다(히스테리시스).
    // 비키는 쪽·지나가는 쪽 역할도 마주침이 끝날 때까지 고정한다 (도중에 소품·신호로 우선순위가 바뀌어도 뒤집히지 않음).
    // 상대 중심이 내 옆을 지나간 뒤에도 몸(BODY)이 완전히 벗어날 때까지는 마주침을 이어 간다:
    // 중심이 스치자마자 제 길(side 0)로 돌아오면 아직 겹친 몸 사이 간격 규칙에 막혀 둘 다 제자리에서 떠는 것을 막는다.
    const prevMeet = cat.meet, prevYield = cat.meetYield;
    cat.meet = null;
    cat.meetYield = undefined;
    for (const o of ALL) {
      if (o === cat || !o.root.isEnabled()) continue;
      const op = o.root.position;
      const rx = op.x - cat.base.x, rz = op.z - cat.base.z;
      const along = rx * d.x + rz * d.z;
      const keep = o === prevMeet; // 이어 가는 마주침
      if (along > LOOK || along < -(keep ? BODY + 0.2 : BODY)) continue;
      const lat = rx * px + rz * pz;
      const myX = cat.side;
      if (along <= 0.02 && !keep) continue;
      if (Math.abs(lat - myX) > GAP + 0.2 && !keep) continue;
      const moving = !!(o.path && o.path.length);
      let od = null;
      if (moving && o.path[0]) {
        const tx = o.path[0].x - o.base.x, tz = o.path[0].z - o.base.z, l = Math.hypot(tx, tz) || 1;
        od = { x: tx / l, z: tz / l };
      }
      const dot = od ? od.x * d.x + od.z * d.z : 0;
      const passed = along <= 0.02; // 중심은 이미 지나쳤고 몸이 벗어나길 기다리는 중
      // 나에게 양보해 멈춘(또는 막혀 서 있는) 고양이는 서 있는 고양이처럼 돌아서 지나간다
      const stalled = moving && ((o.wait || 0) > 0.3 || (o.yielding && !yields(cat, o)));
      if (stalled && !passed && along < 1.2) {
        const w = lat > myX ? lat - GAP : lat + GAP;
        if (Math.abs(w) > Math.abs(want)) want = Math.max(-STEP_ASIDE, Math.min(STEP_ASIDE, w));
        speedK = Math.min(speedK, 0.45);
        continue;
      }
      if (moving && dot > 0.5) {
        // 3) 같은 쪽: 간격 유지
        speedK = Math.min(speedK, Math.max(0, (along - 0.85) / 0.5)); // 앞 고양이와 0.85 m 이상
      } else if (moving && dot < (keep ? -0.1 : -0.3)) {
        // 2) 마주 옴: 한 마리만 비킨다 (이어 가는 중에는 경계에서 깜박이지 않게 기준을 느슨하게)
        cat.meet = o;
        const iYield = keep && prevYield !== undefined ? prevYield : yields(cat, o);
        cat.meetYield = iYield;
        if (iYield) {
          yielding = true;
          want = Math.max(want, STEP_ASIDE + (cat.wait > 2 ? 0.15 : 0));
          // 옆으로 충분히 물러설 때까지는 멈춰 기다린다
          if (!passed && (Math.abs(cat.side - want) > 0.08 || along < 1.4)) speedK = Math.min(speedK, Math.abs(cat.side - want) > 0.08 ? 0 : 0.3);
        } else {
          want = Math.max(want, KEEP_RIGHT);
        }
      } else if (passed) {
        continue; // 지나친 상대가 더는 마주 오지 않으면(방향을 틀었으면) 무시
      } else if (moving) {
        // 3) 가로질러 옴: 우선이 아닌 쪽이 멈춤
        if (along < 1.3 && yields(cat, o)) speedK = Math.min(speedK, Math.max(0, (along - 0.75) / 0.5));
      } else {
        // 4) 서 있는 고양이: 먼 쪽으로 돌아감
        const w = lat > myX ? lat - GAP : lat + GAP;
        if (Math.abs(w) > Math.abs(want)) want = Math.max(-STEP_ASIDE, Math.min(STEP_ASIDE, w));
        if (along < 0.8) speedK = Math.min(speedK, 0.35);
      }
    }
    // 목적지 근처(의자 앞 등 좁은 곳)에서는 경로로 복귀 (비키는 중이면 유지)
    if (remain < 0.9 && !yielding) want *= Math.max(0, (remain - 0.3) / 0.6);
    if (cat.skating) want = 0; // 얼음 위에서는 옆으로 비키지 않는다. 간격은 속도로만 맞춘다
    return { want, speedK, px, pz, yielding };
  }

  /**
   * 마지막 안전장치: 너무 가까운 고양이 쌍을 떼어 놓는다. 걷는 쪽만 민다 (앉은·줄 선 고양이는 고정).
   * 둘 다 걸으면 반반, 한쪽만 걸으면 그쪽만 MIN(0.58 m) 이 될 때까지 base 와 root 위치를 밀어낸다. 매 프레임 불린다.
   * @param {Cat[]} [cats=ALL] 검사할 고양이들
   * @returns {void}
   * @see isWalking
   */
  function resolveOverlaps(cats = ALL) {
    const MIN = 0.58; // 이보다 가까우면 걷는 쪽을 밀어낸다
    for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) {
      const a = cats[i], b = cats[j];
      const am = isWalking(a), bm = isWalking(b);
      if (!am && !bm) continue;
      const pa = a.root.position, pb = b.root.position;
      let dx = pb.x - pa.x, dz = pb.z - pa.z;
      let d = Math.hypot(dx, dz);
      if (d >= MIN) continue;
      if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }
      const push = MIN - d, nx = dx / d, nz = dz / d;
      const wa = am && bm ? 0.5 : am ? 1 : 0, wb = 1 - wa;
      if (wa) { a.base.x -= nx * push * wa; a.base.z -= nz * push * wa; pa.x -= nx * push * wa; pa.z -= nz * push * wa; }
      if (wb) { b.base.x += nx * push * wb; b.base.z += nz * push * wb; pb.x += nx * push * wb; pb.z += nz * push * wb; }
    }
  }

  /**
   * 걷는 고양이 한 프레임 이동.
   * 순서: 진행 방향·남은 길이 → avoid(비켜 가기) → doorPass(문 양보) → 6초 넘게 막히면 ghost(간격 규칙 잠시 해제) → 몸 간격 검사 후 경로를 따라 전진 → side 보간 → 위치·방향 갱신.
   * 경로가 끝나면 goal 의 자리·방향·자세로 놓고 onArrive 콜백을 부른다.
   * @param {Cat} cat 걷는 고양이 (path 가 있어야 함)
   * @param {number} dt 지난 프레임 이후 경과 시간(초)
   * @returns {void}
   * @see avoid
   * @see doorPass
   * @see walkSpeed
   */
  function stepMove(cat, dt) {
    // 불변식: 경로를 걷는 동안은 걷는 자세·바닥 높이. 끊기지 않은 앉기 움직임이 자세를 덮어써도 여기서 되돌린다.
    if (cat.pose !== 'walk') cat.pose = 'walk';
    cat.root.position.y = 0;
    if (!cat.base) cat.base = cat.root.position.clone();
    const base = cat.base;
    const tgt0 = cat.path[0];
    let dir = { x: 0, z: 1 };
    if (tgt0) {
      const l = Math.hypot(tgt0.x - base.x, tgt0.z - base.z);
      if (l > 1e-4) dir = { x: (tgt0.x - base.x) / l, z: (tgt0.z - base.z) / l };
    }
    let remain = 0, prev = base;
    for (const q of cat.path) { remain += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q; }
    const av = avoid(cat, dir, remain);
    const doorOk = doorPass(cat, clock);
    const { want, px, pz, yielding } = av;
    // 마지막 안전장치: 6초 넘게 막히면(좁은 틈에 갇힘) 간격 규칙을 잠시 풀고 지나간다 — 영영 멈추는 것보다 낫다.
    // 예전엔 12초였는데, 책상 사이 한 마리 폭 길에서 한 쌍이 오래 막히면 뒤가 줄줄이 밀려 정체가 번졌다. 6초로 줄이니 3초 넘는 멈춤이 1/8 아래로 줄었다(시뮬레이션 4회)
    if (cat.wait > 6) cat.ghostT = 2.5; // 한 번 풀리면 2.5초 동안 빠져나간다
    cat.ghostT = Math.max(0, (cat.ghostT || 0) - dt);
    const ghost = cat.ghostT > 0;
    const speedK = ghost ? 1 : av.speedK;
    cat.yielding = yielding;
    // 1) 몸 간격 규칙: 다음 위치를 미리 계산해, 다른 고양이와 BODY 안으로 더 가까워지는 움직임은 하지 않는다.
    //    갇힘 해제(ghost) 동안만 이 규칙을 푼다. (예전의 '6초 막히면 0.48m 까지 비집기' 단계는 해제 기준이 6초가 되면서 없어졌다)
    const minBody = ghost ? 0 : BODY;
    /**
     * (x, z) 로 가면 다른 고양이와 minBody 안으로 더 가까워지는가 (이미 가까운 쌍이 멀어지는 움직임은 허용).
     * @param {number} x 가려는 월드 x (m)
     * @param {number} z 가려는 월드 z (m)
     * @returns {boolean} 막히면 true
     */
    const blocked = (x, z) => {
      for (const o of ALL) {
        if (o === cat || !o.root.isEnabled()) continue;
        const op = o.root.position;
        const dNew = Math.hypot(op.x - x, op.z - z);
        if (dNew >= minBody) continue;
        const dOld = Math.hypot(op.x - cat.root.position.x, op.z - cat.root.position.z);
        if (dNew < dOld - 1e-4) return true;
      }
      return false;
    };
    // 앞으로 갈 거리만큼 경로를 따라간 위치 (아직 적용 안 함)
    /**
     * 앞으로 갈 거리만큼 경로를 따라간 위치 (아직 적용 안 함)
     * @param {number} dist 갈 거리(m)
     * @returns {{x: number, z: number, used: number, head: number}} 새 위치, 지나간 경로 점 개수, 바라볼 방향(라디안)
     */
    const advance = (dist) => {
      let x = base.x, z = base.z, i = 0, head = cat.heading;
      while (dist > 0 && i < cat.path.length) {
        const t = cat.path[i];
        const dx = t.x - x, dz = t.z - z, l = Math.hypot(dx, dz);
        if (l < 1e-4) { i++; continue; }
        head = Math.atan2(-dx, -dz);
        if (dist < l) { x += (dx / l) * dist; z += (dz / l) * dist; dist = 0; break; }
        x = t.x; z = t.z; dist -= l; i++;
      }
      return { x, z, used: i, head };
    };
    const newSide = cat.side + (want - cat.side) * Math.min(1, dt * 4);
    let step = advance(walkSpeed(cat) * dt * speedK * (cat.hurry || 1)); // hurry: 일 시작한 세션은 서둘러 자리로
    let moved = true;
    if (!doorOk && !ghost) { step = advance(0); moved = false; } // 문 앞에서 차례 기다림 (제자리)
    if (blocked(step.x + px * newSide, step.z + pz * newSide)) {
      // 앞으로는 못 가도 옆으로 비키기는 해 본다
      step = advance(0);
      if (blocked(step.x + px * newSide, step.z + pz * newSide)) moved = false;
      else { cat.side = newSide; moved = false; }
    } else {
      cat.side = newSide;
    }
    const progressed = moved && speedK > 0.05;
    cat.wait = progressed ? 0 : cat.wait + dt;
    cat.gait = (cat.gait || 0) + dt * 9 * (progressed ? Math.max(0.15, speedK) : 0.1);
    cat.moveK = progressed ? speedK : 0.15;
    if (moved) {
      cat.path.splice(0, step.used);
      base.x = step.x; base.z = step.z;
      cat.heading = step.head;
    }
    const pos = cat.root.position;
    pos.x = base.x + px * cat.side;
    pos.z = base.z + pz * cat.side;
    // 물체 간격 띠: 비켜서거나 길이 물체에 바짝 붙어도 몸이 물체를 스치거나 뚫지 않게 띠 밖으로 민다.
    // 밀림 양(kx, kz)은 부드럽게 따라가게 해서 띠 경계에서 튀지 않는다. 출발·도착 근처의 자기 가구는 뺀다(koEx).
    if (keepOut) {
      if (cat.koPath !== cat.path) { cat.koPath = cat.path; cat.koEx = keepOut.exempt([base, ...cat.path]); }
      const q = keepOut.push(pos.x, pos.z, cat.koEx);
      const k = Math.min(1, dt * 12);
      cat.kx = (cat.kx || 0) + (q.x - pos.x - (cat.kx || 0)) * k;
      cat.kz = (cat.kz || 0) + (q.z - pos.z - (cat.kz || 0)) * k;
      // 따라가는 중에도 띠 안으로 0.1 m 넘게 남으면(모퉁이에서 옆 비킴이 휘둘려 물체 쪽으로 넘어갈 때) 바로 다 민다
      const q2 = keepOut.push(pos.x + cat.kx, pos.z + cat.kz, cat.koEx);
      if (Math.hypot(q2.x - pos.x - cat.kx, q2.z - pos.z - cat.kz) > 0.1) { cat.kx = q2.x - pos.x; cat.kz = q2.z - pos.z; }
      pos.x += cat.kx; pos.z += cat.kz;
    }
    cat.root.rotation.y = angleLerp(cat.root.rotation.y, cat.heading, Math.min(1, dt * 10));
    if (!cat.path.length) {
      const g = cat.goal;
      cat.path = null;
      cat.root.position.x = base.x; cat.root.position.z = base.z;
      cat.side = 0;
      cat.kx = 0; cat.kz = 0; cat.koPath = null; cat.koEx = null;
      if (g) {
        cat.root.position.set(g.pos.x, g.pos.y || 0, g.pos.z);
        cat.heading = g.rotY;
        cat.pose = g.pose || 'stand';
        cat.seatY = g.seatY || 0.5;
      } else {
        cat.pose = 'stand';
      }
      const f = cat.onArrive;
      cat.onArrive = null;
      if (f) f(cat);
    }
  }

  /**
   * 매 프레임. dt 초
   * 걷는 중이면 stepMove 로 이동하고, 아니면 heading 쪽으로 몸을 돌린다. 모델 고양이는 CatModel.animate 로 넘기고 끝, 임시 모형은 다리·꼬리·귀·팔·고개를 자세와 동작에 맞춰 흔든다.
   * @param {Cat} cat 고양이
   * @param {number} dt 지난 프레임 이후 경과 시간(초)
   * @returns {void}
   * @see stepMove
   * @see CatModel.animate
   */
  function update(cat, dt) {
    cat.t += dt;
    if (cat === ALL[0]) clock += dt; // 문 양보용 시계 (프레임당 한 번)
    const t = cat.t;
    if (isWalking(cat)) stepMove(cat, dt);
    else cat.root.rotation.y = angleLerp(cat.root.rotation.y, cat.heading ?? cat.root.rotation.y, Math.min(1, dt * 8));
    if (cat.model) { CatModel.animate(cat, dt); return; }

    const urgent = cat.signal === 'permission' || cat.signal === 'waiting' || cat.act === 'sign';
    const err = cat.signal === 'error';
    const pose = cat.pose, act = cat.act || 'idle';
    const low = 1 - (cat.mood ?? 1); // 기분이 나쁠수록 1

    // 다리·몸 높이
    let hipY = 0.2, legX = [0, 0];
    if (pose === 'sit') { hipY = cat.seatY + 0.02; legX = [-1.35, -1.35]; }
    else if (pose === 'loaf') { hipY = 0.1; legX = [-1.5, -1.5]; }
    else if (pose === 'walk') {
      const ph = cat.gait || 0;
      legX = [Math.sin(ph) * 0.55, -Math.sin(ph) * 0.55];
      hipY = 0.2 + Math.abs(Math.cos(ph)) * 0.02;
    } else if (act === 'fidget') {
      // 발 동동
      const ph = t * 9;
      legX = [Math.max(0, Math.sin(ph)) * -0.35, Math.max(0, -Math.sin(ph)) * -0.35];
    }
    if (cat.hopT > 0) {
      cat.hopT -= dt;
      hipY += Math.abs(Math.sin(cat.hopT * 9)) * 0.22;
    }
    cat.legs.forEach((l, i) => { l.rotation.x = legX[i]; });
    cat.hips.position.y = hipY + (pose === 'walk' ? 0 : Math.sin(t * 2.2) * 0.006);
    cat.hips.rotation.x = act === 'sleep' || act === 'doze' ? 0.25 : act === 'present' ? 0.12 : act === 'sad' ? 0.15 : 0;
    // 오류: 털이 곤두섬
    const puff = err ? 1.12 + Math.sin(t * 20) * 0.015 : 1;
    cat.torso.scaling.set(0.3 * puff, 0.32 * puff, 0.27 * puff);

    // 꼬리: 평소 느리게, 주의 필요하면 빠르게 크게, 오류면 꼿꼿이, 기분 나쁘면 축 처짐
    const amp = err ? 0.04 : urgent ? 0.5 : act === 'sleep' || act === 'doze' ? 0.06 : 0.18 * (1 - low * 0.6);
    const spd = urgent ? 6 : pose === 'walk' ? 3 : act === 'fidget' ? 4 : 1.6;
    cat.tail.forEach((s, i) => { s.rotation.z = Math.sin(t * spd - i * 0.6) * amp; s.rotation.x = err ? 0.05 : 0.35 + low * 0.25; });
    // 귀: 주의 필요면 쫑긋, 잘 때·기분 나쁠 때 눕힘, 오류면 납작
    cat.ears.forEach((e, i) => {
      const s = i === 0 ? -1 : 1;
      let base = urgent ? 0.12 : act === 'sleep' || act === 'doze' ? 0.6 : 0.32 + Math.max(0, Math.sin(t * 0.7 + i)) * 0.06;
      if (act === 'sad') base = 0.9;
      if (err) base = 1.0;
      base += low * 0.45;
      e.rotation.z = -s * base;
    });

    // 팔
    const [L, Rr] = cat.arms;
    L.rotation.set(0, 0, -0.75); Rr.rotation.set(0, 0, 0.75);
    if (cat.prop === 'box') {
      [L, Rr].forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * 0.32; a.rotation.x = act === 'present' ? -1.55 : -1.3; });
    } else if (cat.prop === 'board') {
      if (pose === 'walk') { L.rotation.x = -Math.sin(cat.gait || 0) * 0.5; Rr.rotation.set(-1.1, 0, 0.35); }
      else { [L, Rr].forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * 0.35; a.rotation.x = -1.1; }); }
    } else if (cat.prop === 'sign' || act === 'highfive') {
      Rr.rotation.z = 2.75 + Math.sin(t * (act === 'highfive' ? 3 : 5)) * 0.12; // 손 들기
    } else if (act === 'stamp') {
      // 대표: 도장 찍기 (팔을 들었다 내리기)
      const k = Math.abs(Math.sin(t * 7));
      Rr.rotation.set(-1.0 - k * 0.7, 0, 0.3);
    } else if (cat.signal === 'permission') {
      Rr.rotation.z = 2.6 + Math.sin(t * 5) * 0.25;
    } else if (pose === 'walk') {
      const ph = cat.gait || 0;
      L.rotation.x = -Math.sin(ph) * 0.5; Rr.rotation.x = Math.sin(ph) * 0.5;
    } else if (act === 'type' && !urgent) {
      [L, Rr].forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * 0.25; a.rotation.x = -1.2 + Math.sin(t * 14 + i * 1.7) * 0.08; });
    } else if (act === 'read') {
      [L, Rr].forEach((a, i) => { a.rotation.z = (i ? 1 : -1) * 0.3; a.rotation.x = -1.0; });
    } else if (act === 'talk') {
      Rr.rotation.x = -0.9 + Math.sin(t * 3.1) * 0.35; Rr.rotation.z = 0.5;
    } else if (act === 'drink') {
      Rr.rotation.x = -1.6 - Math.max(0, Math.sin(t * 0.8)) * 0.5; Rr.rotation.z = 0.35;
    } else if (act === 'sleep') {
      L.rotation.z = -0.2; Rr.rotation.z = 0.2; L.rotation.x = Rr.rotation.x = -1.2;
    } else if (err) {
      L.rotation.z = -1.3; Rr.rotation.z = 1.3; // 놀라서 팔 벌림
    }

    // 고개
    cat.head.rotation.set(0, 0, 0);
    if (cat.signal === 'waiting' || act === 'sign') cat.head.rotation.z = Math.sin(t * 1.5) * 0.15;
    else if (act === 'talk') { cat.head.rotation.x = Math.sin(t * 2.4) * 0.08; cat.head.rotation.y = Math.sin(t * 0.9) * 0.3; }
    else if (act === 'nod') cat.head.rotation.x = Math.max(0, Math.sin(t * 8)) * 0.3;
    else if (act === 'shake') cat.head.rotation.y = Math.sin(t * 9) * 0.35;
    else if (act === 'read') cat.head.rotation.x = 0.25;
    else if (act === 'sleep' || act === 'doze') cat.head.rotation.x = 0.35 + Math.sin(t * 1.2) * 0.05;
    else if (act === 'sad') cat.head.rotation.x = 0.3;
    else if (cat.prop === 'board' && pose !== 'walk') cat.head.rotation.x = 0.12;
    cat.head.rotation.x += low * 0.12;
  }

  /**
   * 고양이를 장면과 목록에서 없앤다 (세션이 끝나 퇴근)
   * ALL·문 users 에서 빼고, 낚시·등 펴기·들림 상태를 풀고, 동작 그룹을 지우고, 노드를 지운다. 공용 재질은 남기고 이 고양이만의 재질만 지운다.
   * @param {Cat} cat 없앨 고양이
   * @returns {void}
   */
  function remove(cat) {
    const i = ALL.indexOf(cat);
    if (i >= 0) ALL.splice(i, 1);
    cat.skateK = 0; cat.skating = false;
    cat.fishK = 0; // catmodel FISHERS 가 지워진 노드에 IK 를 걸지 않게
    cat.uprightK = 0; cat.held = false; // 등 펴기·들림 목록에서도 빠지게 (지워진 노드에 매 프레임 계산·메모리 누수 방지)
    for (const d of DOORS) d.users.delete(cat);
    if (cat.model && cat.model.groups) for (const g of Object.values(cat.model.groups)) g.dispose();
    // 공용 재질(품종 털·색)은 남기고 이 고양이만의 재질(소품 등)만 지운다.
    // 예전엔 dispose(false, true) 로 공용 재질까지 지워, 퇴근한 고양이와 같은 품종 고양이·다시 출근한 고양이 몸이 안 보였다 (머리 위 로고만 남음)
    const own = new Set();
    for (const m of cat.root.getChildMeshes(false)) if (m.material && !(m.material.metadata && m.material.metadata.shared)) own.add(m.material);
    cat.root.dispose(false, false);
    for (const mt of own) mt.dispose(true, true);
  }

  /**
   * 말풍선을 띄울 머리 위 지점(월드 좌표)
   * 모델이면 CatModel.anchor, 임시 모형이면 머리 노드 위 0.42 m.
   * @param {Cat} cat 고양이
   * @returns {BABYLON.Vector3} 월드 좌표 (m)
   * @see CatModel.anchor
   */
  function bubbleAnchor(cat) {
    if (cat.model) return CatModel.anchor(cat);
    return BABYLON.Vector3.TransformCoordinates(new V3(0, 0.42, 0), cat.head.getWorldMatrix());
  }

  /**
   * 공개 API: BREEDS, setDoors, setKeepOut, create, setSpot, setPose, setAct, setSignal, setProp, setMood, hop, seatRise, walk, isWalking, update, resolveOverlaps, bubbleAnchor, remove, all(ALL).
   */
  return { BREEDS, setDoors, setKeepOut, create, setSpot, setPose, setAct, setSignal, setProp, setMood, hop, seatRise, walk, isWalking, update, resolveOverlaps, bubbleAnchor, remove, all: ALL };
})();
