/**
 * @file 개방형 사무실(ㄷ자 건물 + 중정 + 공원)의 공간 정의 모듈.
 * 가구 목록(items)·자리(spots)·통로 선(LINES)·결재판 내려놓는 짧은 줄 자리(DROP)·바깥 조명 자리(LIGHTS)를 모듈 로드 시점에 한 번 계산해 두고,
 * create(scene) 가 Babylon 씬에 건물 골격·가구 인스턴스·낚싯대·미닫이문을 만든 뒤 공개 API 객체를 돌려준다.
 * 고양이가 누구를 어디로 보낼지는 정하지 않고(office.js 담당), 경로 찾기(route·pathTo)와 앉기·일어서기 연출(sit·stand)만 제공한다.
 * 시작할 때 checkLayout()·checkPaths() 가 배치 규칙 위반을 콘솔에 경고한다.
 * 공개 API: OpenOffice.create(scene, {shadows}) → {@link OpenOfficeApi}, OpenOffice.FACE (방향 이름 → rotY).
 * @see OpenOffice
 * @see create
 */
// 개방형 사무실 (ㄷ자 건물 + 중정 + 공원).
//   왼쪽 날개: 업무 책상 24자리 / 본관(가장 안쪽): 토의실 · 로비와 대표실 · 라운지 / 오른쪽 날개: 서재 · 카페
//   중정: 사각 연못(대표실 앞, 배산임수) + 둘레 나무 데크 산책로 + 한가운데 분수대
//   바깥: 곡선 산책로 공원(연못, 조각상, 꽃밭, 조경석), 건물 뒤 나무 언덕
// 이 모듈은 공간과 자리(spot), 길(통로 선), 결재판 내려놓는 줄 자리(DROP)만 정의한다. 누가 어디로 갈지는 정하지 않는다.
//
// ── 배치 규칙 (가구를 옮기거나 더할 때 반드시 지킨다. checkLayout() 이 시작할 때마다 검사해 어기면 콘솔에 경고) ──
// 층(layer): put() 이 모델 이름과 높이로 정한다 (LAYER_OF). 마지막 인자로 직접 줄 수도 있다.
//   floor       깔개·연못·뒷산. 가구 밑에 깔려도 되지만 벽은 넘지 못한다.
//   furniture   기본값. 바닥에 놓는 단단한 물건. 발자국 = 모델 경계 상자를 돌린 사각형 (RADIUS 에 있으면 원).
//   onTop       y > 0 으로 가구 위에 올린 물건 (책·화분·커피 기계·대표 책상 소품). 받침 가구 발자국 안에 있어야 한다.
//   wallMounted 칠판·액자·상부장. 높은 벽(북·동)에 0.12m 안으로 붙되 벽을 파고들지 않는다.
//   outdoor     나무·덤불·돌·꽃밭·벤치·석등·조각상.
// 규칙:
//   (a) furniture·outdoor 발자국은 벽·유리벽과 0.03m 이상 떨어지고, 서로 0.03m 넘게 겹치지 않는다.
//   (b) 예외는 둘뿐: withChair 로 묶은 의자는 자기 앞 책상·탁자 밑으로만 들어가고, onTop 은 받침 가구 위에만 있다.
//   (c) 통로 선(LINES)과 자리마다 드나드는 길(통로 → via → 서는 자리)은 고양이 반지름 0.15m 만큼 비어 있다.
//   (d) 결재판 내려놓는 줄 자리(DROP, 대표 책상 앞 로비)와 문 자리(DOORS)는 비운다.
//   (e) outdoor 는 건물 바닥과 겹치지 않고, 바깥 길 띠(중심선에서 0.8m) 밖에 둔다.
//   (g) 스케이트 길(언 중정 연못 위 고리 + 물가 자리에서 고리 문까지)은 고양이 반지름 만큼 비어 있다.
// 벽에 붙이는 가구는 벽 안쪽 면에서 0.05~0.1m 띄운다. 벽 안쪽 면: 북 z=27.8 · 동 x=31.8 · 서 x=0.2 · 남 z=0.2
//   유리벽 안쪽 면: 왼쪽 날개 x=9.8 · 오른쪽 날개 x=22.2 · 본관 z=18.2
/**
 * @typedef {'floor'|'furniture'|'onTop'|'wallMounted'|'outdoor'} LayerName
 * 배치 검사용 층 이름. put() 이 모델 이름과 높이로 정한다 (layerOf).
 *
 * @typedef {Array} ItemTuple
 * 가구 목록 한 줄: [모델 이름, x, z, rotY, y, override, scale].
 * override 는 Kenney 모델 재질 덮어쓰기 객체(예 {carpet:['dark']}) 또는 undefined, scale 은 배율(없으면 1).
 *
 * @typedef {Object} SpotChair
 * withChair 로 묶인 의자의 인스턴스와 움직임 기준값 (create 가 채운다).
 * @property {BABYLON.InstancedMesh} mesh 의자 인스턴스
 * @property {BABYLON.Vector3} home 의자가 밀려 들어간 제자리
 * @property {BABYLON.Vector3} out 의자 뒤쪽 바깥 방향 단위 벡터 (outDir(rotY))
 *
 * @typedef {Object} Spot
 * 고양이가 서거나 앉는 자리.
 * @property {string} id 자리 이름 (예 'desk-0-s1', 'boss')
 * @property {string} kind 종류 ('desk'|'meeting'|'board'|'present'|'shelf'|'sofa'|'cafe'|'coffee'|'fish'|'skate'|'bench'|'park'|'boss'|'deliver' 등)
 * @property {BABYLON.Vector3} pos 자리 위치 (y 는 발판 높이)
 * @property {number} rotY 바라보는 방향 (FACE 값 규칙)
 * @property {string} pose 자세 ('stand'|'sit'|'loaf' 등, OfficeCat.setPose 가 읽음)
 * @property {number} seatY 앉는 높이
 * @property {string} act 하는 일 ('idle'|'type'|'talk'|'read'|'drink'|'sleep'|'present')
 * @property {(string|null)} taken 자리를 차지한 고양이 id (비면 null)
 * @property {BABYLON.Vector3[]} [via] 드나드는 경유점 (첫 점이 통로 선 쪽, 끝 점이 자리 앞)
 * @property {number} [gate] 스케이트 자리: 고리에 오르내리는 점 번호
 * @property {number} [chairItem] withChair 로 묶인 의자의 items 순번
 * @property {BABYLON.Vector3} [side] 의자 옆 방향 (x, z 부호 벡터)
 * @property {BABYLON.Vector3} [besidePulled] 의자를 뺀 채 옆에 서는 점
 * @property {SpotChair} [chair] 의자 인스턴스 묶음 (create 이후)
 * @property {string} [room] 회의실 이름 ('A'|'B')
 *
 * @typedef {Object} Footprint
 * 검사용 사각형(회전 가능) 또는 원. 벽·문·건물·가구 발자국이 모두 이 모양을 따른다.
 * @property {number} ox 사각형 중심 x
 * @property {number} oz 사각형 중심 z
 * @property {number} hx x 쪽 반폭
 * @property {number} hz z 쪽 반폭
 * @property {number} cs 회전 코사인
 * @property {number} sn 회전 사인
 * @property {number} [r] 원일 때 반지름 (있으면 cx, cz 중심의 원으로 취급)
 * @property {number} [cx] 가구 중심 x
 * @property {number} [cz] 가구 중심 z
 * @property {number} [n] 가구 순번 (items 인덱스)
 * @property {string} [name] 가구(모델) 이름
 * @property {LayerName} [layer] 층
 * @property {number[][]} [corners] 네 귀퉁이 [x, z]
 *
 * @typedef {Footprint & {name:string, x0:number, x1:number, z0:number, z1:number, tall?:boolean, glass?:boolean}} Wall
 * 벽·유리벽 한 조각 (평면 사각형 + 검사용 발자국 필드). tall: 벽걸이가 붙을 수 있는 높은 벽.
 *
 * @typedef {Footprint & {name:string, x0:number, x1:number, z0:number, z1:number, axis:('x'|'z'), at:number, from:number, to:number, g0:number, g1:number}} Door
 * 자동 유리 미닫이문. axis 'x' = x 고정 벽, 'z' = z 고정 벽. at: 벽 위치, from~to: 벽 구간, g0~g1: 문틈 구간.
 *
 * @typedef {{a:BABYLON.Vector3, b:BABYLON.Vector3}} Line
 * 통로 선(선분) 한 개. 고양이는 이 선들을 따라 길을 찾는다.
 *
 * @typedef {Footprint & {n:number, name:string, layer:LayerName, cx:number, cz:number, corners:number[][]}} FootprintItem
 * 가구 한 개의 발자국 (create 가 foot 에 채운다).
 *
 * @typedef {{n:number, name:string, min:BABYLON.Vector3, max:BABYLON.Vector3, c:BABYLON.Vector3}} Obstacle
 * 길 검사용 장애물 상자: 가구 순번·이름, 세계 좌표 최소·최대 모서리, 중심.
 *
 * @typedef {Object} Cat
 * 고양이 한 마리 (catmodel.js / office.js 가 만든 객체). 여기서는 아래 필드만 읽거나 쓴다.
 * @property {string} id 고양이 id (자리 taken 에 들어가는 값)
 * @property {{position:BABYLON.Vector3}} root 고양이 루트 노드 (position 을 움직인다)
 * @property {number} heading 바라보는 각도 (sit 이 자리의 rotY 로 맞춤)
 * @property {string} pose 현재 자세
 * @property {boolean} [fishing] 낚시 중 (팔 자세가 읽음)
 * @property {{bottom:BABYLON.Vector3, dir:BABYLON.Vector3}} [fishRod] 두 앞발이 잡은 낚싯대 뒤끝(세계 좌표)과 방향
 *
 * @typedef {Object} RodEntry
 * 낚시 자리 하나의 낚싯대 묶음.
 * @property {Spot} s 낚시 자리
 * @property {BABYLON.TransformNode} node 자리 기준 부모 노드
 * @property {BABYLON.Mesh} rod 대
 * @property {BABYLON.Mesh} line 줄
 * @property {BABYLON.Mesh} bob 찌
 * @property {number} t 찌 출렁임 시간
 * @property {Cat} [cat] 지금 낚시 중인 고양이
 *
 * @typedef {Object} DoorLeafEntry
 * 미닫이문 한 개의 움직임 상태.
 * @property {Door} d 문
 * @property {BABYLON.TransformNode[]} leaves 문짝 둘
 * @property {number[]} closed 문짝별 닫힌 위치
 * @property {number[]} open 문짝별 열린 위치
 * @property {number[]} off 문짝별 벽 직각 방향 어긋남
 * @property {number} k 열림 정도 0(닫힘)~1(열림)
 *
 * @typedef {{t:number, dur:number, step:function(number):void, done?:function():void, obj?:{position:BABYLON.Vector3}}} Tween
 * 진행 중인 짧은 보간 애니메이션. obj 는 lerpTo 가 표시한 움직이는 대상.
 *
 * @typedef {{pts:BABYLON.Vector3[], slots:{pos:BABYLON.Vector3, rotY:number}[], board:{x:number, z:number, y:number, dy:number, max:number}}} DropLine
 * 결재판 내려놓는 짧은 줄: 줄 자리 점들(pts, 앞에서부터), 서는 자리(slots: 위치·바라보는 방향), 책상 위 결재판 쌓는 자리(board: 바닥 x·z, 첫 장 높이 y, 한 장 두께 dy, 최대 장수 max).
 *
 * @typedef {{x:number, z:number, gx:number, gz:number, why?:string, r?:number}} LampLight
 * 바깥 조명 한 개: 설치 위치(x, z)와 바닥 불빛 가운데(gx, gz).
 *
 * @typedef {Object} OpenOfficeApi
 * create() 가 돌려주는 공개 API.
 * @property {BABYLON.TransformNode} root 사무실 루트 노드
 * @property {Spot[]} spots 모든 자리
 * @property {function(BABYLON.Vector3, BABYLON.Vector3):BABYLON.Vector3[]} route 통로 선 위 경로 찾기
 * @property {function(Spot, BABYLON.Vector3, Object):BABYLON.Vector3[]} pathTo 자리에서 자리로 가는 경로
 * @property {function(Cat, Spot, function():void=):void} sit 앉히기
 * @property {function(Cat, Spot, function():void=):void} stand 일으키기
 * @property {function(Cat, Spot):void} release 끌어 올린 고양이의 움직임 끊기
 * @property {function(boolean):void} setFrozen 중정 연못이 얼었는지 알림 (얼면 낚싯대 숨김, 낚시 대신 스케이트)
 * @property {function():boolean} frozen 중정 연못이 얼었는가
 * @property {function(Cat):(Spot|null)} skating 얼음 위(또는 오르내리는 중)인 고양이의 스케이트 자리, 아니면 null
 * @property {function(number, Cat[]=):void} update 매 프레임 갱신
 * @property {Object} lights 바깥 조명 목록 (LIGHTS)
 * @property {LampLight[]} streetLamps 가로등 목록
 * @property {Object} ground 계절 바닥 (여름 풀·가을 낙엽)
 * @property {function(number=):string[]} checkPaths 출입 경로 충돌 검사
 * @property {function():string[]} checkLayout 배치 규칙 검사
 * @property {function():string[]} checkWalls 벽 침범만 골라낸 검사
 * @property {function(Spot, boolean):void} smoke 책상 연기 켜고 끄기
 * @property {BABYLON.Vector3[]} walkPoints 산책 경유지
 * @property {Object} bounds 건물 치수 (B)
 * @property {{x0:number,x1:number,z0:number,z1:number}[]} glassTops 유리벽 윗선 자리
 * @property {number} wallH 벽 높이
 * @property {{name:string, axis:string, at:number, cx:number, cz:number}[]} doors 문 목록
 * @property {DropLine} drop 결재판 내려놓는 짧은 줄 자리 (대표 책상 앞)
 * @property {function():boolean} boardAdd 대표 책상에 결재판 하나 올리기
 * @property {function():boolean} boardRemove 책상 맨 위 결재판 하나 치우기
 * @property {function():number} boardCount 책상 위 결재판 수
 * @property {function():number} boardClear 결재판 모두 치우기
 * @property {Spot} boss 대표 자리
 * @property {Spot} deliver 배달·보고 자리 (대표 책상 정면, 줄 맨 앞 서쪽 옆)
 * @property {function():boolean} pileAdd 배달 상자 하나 쌓기
 * @property {function():number} pileClear 쌓인 상자 모두 치우기
 * @property {BABYLON.Mesh} boxTemplate 배달 상자 견본
 * @property {function(string):void} unlock 해금 (catTower)
 * @property {function(string):Spot[]} byKind 종류별 자리 목록
 * @property {Spot[]} desks 업무 책상 자리
 * @property {BABYLON.Vector3} center 사무실 중심 (카메라용)
 */
'use strict';

/**
 * 개방형 사무실 모듈 (즉시 실행 함수의 결과).
 * 모듈 로드 때 가구·자리·통로·궤적을 모두 정의하고, 공개 함수는 create 와 FACE 둘뿐이다.
 * @namespace OpenOffice
 * @property {function(BABYLON.Scene, {shadows?:BABYLON.ShadowGenerator}=):Promise<OpenOfficeApi>} create 씬에 사무실을 만든다
 * @property {{south:number, north:number, east:number, west:number}} FACE 방향 이름 → rotY
 * @see create
 */
const OpenOffice = (() => {
  const V3 = BABYLON.Vector3;
  const P = OfficePalette;
  const PI = Math.PI;
  // 회전 규칙: 정면 -Z 기준. 0 → -Z(카메라 쪽), PI → +Z, -PI/2 → +X, PI/2 → -X 를 본다.
  const FACE = { south: 0, north: PI, east: -PI / 2, west: PI / 2 };
  const STEP_TOP = 0.34; // 화이트보드 앞 고양이 발판 윗단 높이

  // 건물: 왼쪽 날개 x[0,10] · 오른쪽 날개 x[22,32] (z[0,18]) · 본관 x[0,32] z[18,28] · 중정 x[10,22] z[0,18]
  const B = { x1: 32, zb: 18, z1: 28, lw: 10, rw: 22, wallH: 2.8, wallT: 0.2, lowH: 0.55 };

  // ── 자리 정의 ───────────────────────────────────────────────
  const spots = []; // { id, kind, pos, rotY, pose, seatY, act, taken, via?, chair? }
  /**
   * 자리(spot)를 하나 만들어 spots 에 넣고 돌려준다.
   * via·chairItem 같은 선택 필드는 나중에 via()·withChair() 가 붙인다.
   * @param {string} id 자리 이름
   * @param {string} kind 자리 종류
   * @param {number} x 자리 x
   * @param {number} z 자리 z
   * @param {number} rotY 바라보는 방향
   * @param {string} [pose='stand'] 자세
   * @param {number} [seatY=0] 앉는 높이
   * @param {string} [act='idle'] 하는 일
   * @param {number} [y=0] 자리 높이 (발판 위면 STEP_TOP)
   * @returns {Spot} 새 자리 (taken 은 null)
   * @see via
   * @see withChair
   */
  function spot(id, kind, x, z, rotY, pose = 'stand', seatY = 0, act = 'idle', y = 0) {
    const s = { id, kind, pos: new V3(x, y, z), rotY, pose, seatY, act, taken: null };
    spots.push(s);
    return s;
  }

  // ── 가구 목록: [모델, x, z, rotY, y, override, scale]
  const items = [];
  const layers = []; // items 와 같은 순번: 'floor' | 'furniture' | 'onTop' | 'wallMounted' | 'outdoor'
  const LAYER_OF = [
    [/^rug|^@pond|^@mound$/, 'floor'],
    [/^@whiteboard$|^@wallArt$|^kitchenCabinetUpper/, 'wallMounted'],
    [/^@bossProps$/, 'onTop'],
    [/^@(tree|pine|bush|rock\d|flowers|bench|statue|fountain|lantern|streetLamp|gardenLight|upLight)$/, 'outdoor'],
  ];
  /**
   * 모델 이름과 높이로 배치 검사용 층을 정한다.
   * LAYER_OF 의 정규식을 위에서부터 맞춰 보고, 없으면 y > 0 이면 onTop, 아니면 furniture.
   * @param {string} m 모델 이름
   * @param {number} y 놓는 높이
   * @returns {LayerName} 층 이름
   * @see put
   */
  const layerOf = (m, y) => { for (const [re, l] of LAYER_OF) if (re.test(m)) return l; return y > 0 ? 'onTop' : 'furniture'; };
  // 둥근 물체의 발자국 반지름 (배율 1 기준). 여기 없으면 모델 경계 상자를 돌린 사각형이 발자국이다.
  const RADIUS = { '@streetLamp': 0.2, '@gardenLight': 0.1, '@upLight': 0.1, '@tree': 1.0, '@pine': 0.95, '@bush': 0.6, '@rock1': 0.5, '@rock2': 0.45, '@flowers': 0.45, '@statue': 0.75, '@bigTree': 0.85, '@fountain': 1.15 };
  /**
   * 가구 한 개를 items 에 넣고 층을 layers 에 기록한다.
   * @param {string} m 모델 이름 (Kenney 모델 또는 '@'로 시작하는 CUSTOM 소품)
   * @param {number} x 중심 x
   * @param {number} z 중심 z
   * @param {number} [rotY=0] 회전
   * @param {number} [y=0] 놓는 높이
   * @param {Object} [override] Kenney 재질 덮어쓰기
   * @param {number} [scale] 배율
   * @param {LayerName} [layer] 층 직접 지정 (없으면 layerOf)
   * @returns {number} items 안의 순번
   * @see layerOf
   */
  const put = (m, x, z, rotY = 0, y = 0, override, scale, layer) => {
    items.push([m, x, z, rotY, y, override, scale]);
    layers.push(layer || layerOf(m, y));
    return items.length - 1;
  };

  // 벽·유리벽(두께 0.2)·문 자리·건물 바닥 (평면 사각형). tall: 창문 있는 높은 벽 (벽걸이가 붙을 수 있는 벽)
  const WALLS = [
    { name: '북쪽 벽', x0: 0, x1: 32, z0: 27.8, z1: 28, tall: true },
    { name: '동쪽 벽', x0: 31.8, x1: 32, z0: 0, z1: 28, tall: true },
    { name: '서쪽 벽', x0: 0, x1: 0.2, z0: 0, z1: 28 },
    { name: '왼쪽 날개 남쪽 벽', x0: 0, x1: 10, z0: 0, z1: 0.2 },
    { name: '오른쪽 날개 남쪽 벽', x0: 22, x1: 32, z0: 0, z1: 0.2 },
    { name: '왼쪽 날개 유리벽', x0: 9.8, x1: 10, z0: 0, z1: 10.3 },
    { name: '왼쪽 날개 유리벽', x0: 9.8, x1: 10, z0: 11.7, z1: 18 },
    { name: '오른쪽 날개 유리벽', x0: 22, x1: 22.2, z0: 0, z1: 6.3 },
    { name: '오른쪽 날개 유리벽', x0: 22, x1: 22.2, z0: 7.7, z1: 18 },
    { name: '본관 유리벽', x0: 10, x1: 12.8, z0: 18, z1: 18.2 },
    { name: '본관 유리벽', x0: 14.2, x1: 22, z0: 18, z1: 18.2 },
  ];
  // 문: 벽 방향(axis 'x' = x 고정 벽, 'z' = z 고정 벽), 벽 위치 at, 벽 구간 from~to, 문틈 g0~g1. 자동으로 열리는 유리 미닫이.
  const DOORS = [
    { name: '왼쪽 날개 옆문', x0: 9.4, x1: 10.6, z0: 10.3, z1: 11.7, axis: 'x', at: 9.9, from: 0, to: 18, g0: 10.3, g1: 11.7 },
    { name: '오른쪽 날개 옆문', x0: 21.4, x1: 22.8, z0: 6.3, z1: 7.7, axis: 'x', at: 22.1, from: 0, to: 18, g0: 6.3, g1: 7.7 },
    { name: '정문', x0: 12.8, x1: 14.2, z0: 17.4, z1: 18.8, axis: 'z', at: 18.1, from: 10, to: 22, g0: 12.8, g1: 14.2 },
  ];
  // 공간 나누는 유리 가벽 (낮은 턱 없이 바닥까지 유리). 문틈은 통로 선이 지나는 곳에만 둔다.
  const PARTS = [
    { name: '업무실 유리벽', axis: 'z', at: 18.0, from: 0.2, to: 8.6, gaps: [[3.75, 5.15]] },
    { name: '업무실 복도 유리벽', axis: 'x', at: 8.6, from: 0.2, to: 18.1, gaps: [[5.3, 6.7], [15.3, 16.7]] },
    { name: '회의실 유리벽', axis: 'z', at: 20.2, from: 0.2, to: 12.0, gaps: [[0.2, 1.5], [10.9, 12.0]] },
    { name: '회의실 유리벽', axis: 'x', at: 12.0, from: 20.3, to: 27.8, gaps: [] },
    { name: '회의실 사이 유리벽', axis: 'x', at: 6.1, from: 20.3, to: 27.8, gaps: [] },
    { name: '라운지 유리벽', axis: 'x', at: 20.8, from: 20.3, to: 27.8, gaps: [] },
    { name: '라운지 유리벽', axis: 'z', at: 20.2, from: 20.7, to: 31.8, gaps: [[20.7, 22.0], [24.75, 26.45], [29.3, 30.7]] },
    { name: '카페 유리벽', axis: 'z', at: 18.0, from: 23.6, to: 31.8, gaps: [[24.9, 26.3]] },
    { name: '서재 유리벽', axis: 'z', at: 8.3, from: 23.6, to: 31.8, gaps: [[24.9, 26.3]] },
    { name: '서재·카페 복도 유리벽', axis: 'x', at: 23.6, from: 0.2, to: 18.1, gaps: [[6.3, 7.7]] },
  ];
  /**
   * 벽 구간을 문틈으로 잘라 [시작, 끝] 조각들.
   * from 부터 to 까지에서 gaps 를 건너뛴 남은 조각만 모은다. gaps 는 from 순으로 정렬돼 있다고 본다.
   * @param {number} from 구간 시작
   * @param {number} to 구간 끝
   * @param {number[][]} gaps 문틈 [g0, g1] 목록
   * @returns {number[][]} [시작, 끝] 조각 목록
   * @see rectAlong
   */
  const pieces = (from, to, gaps) => {
    const out = [];
    let cur = from;
    for (const [g0, g1] of gaps) { if (g0 > cur) out.push([cur, g0]); cur = g1; }
    if (to > cur) out.push([cur, to]);
    return out;
  };
  /**
   * 벽 방향(axis)·위치(at)·구간(a~b)·반두께(half) 로 평면 사각형을 만든다.
   * @param {('x'|'z')} axis 'x' = x 고정 벽, 'z' = z 고정 벽
   * @param {number} at 고정 좌표
   * @param {number} a 구간 시작
   * @param {number} b 구간 끝
   * @param {number} half 벽 반두께
   * @returns {{x0:number, x1:number, z0:number, z1:number}} 평면 사각형
   * @see pieces
   */
  const rectAlong = (axis, at, a, b, half) => (axis === 'x' ? { x0: at - half, x1: at + half, z0: a, z1: b } : { x0: a, x1: b, z0: at - half, z1: at + half });
  for (const w of PARTS) {
    for (const [a, b] of pieces(w.from, w.to, w.gaps)) WALLS.push({ name: w.name, ...rectAlong(w.axis, w.at, a, b, 0.1), glass: true });
    for (const [g0, g1] of w.gaps) DOORS.push({ name: w.name + ' 문', ...rectAlong(w.axis, w.at, g0, g1, 0.7), axis: w.axis, at: w.at, from: w.from, to: w.to, g0, g1 });
  }
  const BUILDING = [{ x0: 0, x1: 10, z0: 0, z1: 18 }, { x0: 22, x1: 32, z0: 0, z1: 18 }, { x0: 0, x1: 32, z0: 18, z1: 28 }];
  // 검사용 사각형 꼴로 맞춤: 중심(ox, oz) · 반폭(hx, hz) · 회전(cs, sn)
  for (const list of [WALLS, DOORS, BUILDING]) for (const w of list) {
    Object.assign(w, { ox: (w.x0 + w.x1) / 2, oz: (w.z0 + w.z1) / 2, hx: (w.x1 - w.x0) / 2, hz: (w.z1 - w.z0) / 2, cs: 1, sn: 0 });
  }
  const TOL = 0.03; // 겹침 허용 오차 · 벽과의 최소 틈
  const CAT_R = 0.15; // 고양이 반지름 (통로 폭 검사)
  const PATH_HALF = 0.8; // 바깥 길 띠의 반폭 (테두리 포함)

  /**
   * rotY 로 바라보는 자리의 등 쪽(의자가 빠지는 쪽) 방향 단위 벡터.
   * @param {number} rotY 회전
   * @returns {BABYLON.Vector3} (sin, 0, cos)
   */
  const outDir = (rotY) => new V3(Math.sin(rotY), 0, Math.cos(rotY));
  const CHAIR_PULL = 0.35; // 의자를 빼는 거리
  const CHAIR_T = 1.9; // 의자에 앉고 내리는 동작 시간 배율 (클수록 느긋하게)
  // 소파·안락의자 쿠션 윗면 높이: 모델(loungeSofa·loungeChair)의 위를 보는 면을 재서 얻은 값. 두 모델 모두 같다
  // (glb 높이 0.46 에 Kenney 배율 2 를 곱한 등받이 0.92 m 의 절반 = 좌석 면 0.46 m).
  const SOFA_TOP = 0.46;
  const SOFA_SEAT = SOFA_TOP + 0.05; // 앉은 자세 좌석 높이(엉덩이 기준). 0.42 로 두면 쿠션에 파묻혔다
  const SOFA_JUMP = 0.28; // 소파에 오르내리는 점프의 포물선 높이(쿠션 윗면 위로 더 솟는 만큼, m)
  const BEHIND = 0.8; // 의자 뒤 통로 쪽으로 나오는 거리
  const SIDE = 0.55; // 의자 옆에 서는 거리
  /**
   * 방금 놓은 의자와 자리를 묶는다. side: 의자 옆 어느 쪽에서 타고 내릴지 [x, z].
   * s.chairItem 에 마지막 items 순번을 기록하고, 의자를 뺀 채 옆에 서는 점(besidePulled)과 드나드는 경유점(via)을 계산한다.
   * @param {Spot} s 의자에 앉는 자리
   * @param {number[]} side 옆 방향 [x, z] (부호만 쓴다)
   * @returns {Spot} 같은 자리 s
   * @see outDir
   */
  function withChair(s, side) {
    s.chairItem = items.length - 1;
    const out = outDir(s.rotY);
    s.side = new V3(side[0], 0, side[1]);
    s.besidePulled = s.pos.add(out.scale(CHAIR_PULL)).add(s.side.scale(SIDE));
    s.via = [s.pos.add(out.scale(BEHIND)).add(s.side.scale(SIDE)), s.besidePulled];
    return s;
  }
  /**
   * 앞쪽 경유점 지정 (첫 점에서 가장 가까운 통로 선까지 곧게 닿아야 함).
   * @param {Spot} s 자리
   * @param {...number[]} pts 경유점 [x, z] 들 (바깥 → 자리 앞 순서)
   * @returns {Spot} 같은 자리 s
   */
  function via(s, ...pts) { s.via = pts.map(([x, z]) => new V3(x, 0, z)); return s; }
  /**
   * (x, z) 에서 (tx, tz) 를 바라보는 rotY.
   * @param {number} x 서 있는 x
   * @param {number} z 서 있는 z
   * @param {number} tx 보는 대상 x
   * @param {number} tz 보는 대상 z
   * @returns {number} rotY
   */
  const faceTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

  // ═══ 왼쪽 날개: 업무 (마주 보는 책상 4개 묶음 x 6). 중정 쪽 x 8.7~9.8 은 복도 ═══
  [[2.55, 3.5], [6.35, 3.5], [2.55, 8.5], [6.35, 8.5], [2.55, 13.5], [6.35, 13.5]].forEach(([cx, cz], p) => {
    for (const sx of [-0.735, 0.735]) {
      const sd = [Math.sign(sx), 0];
      put('@desk', cx + sx, cz - 0.39, 0);
      // 책상 스탠드(관절형): 책상 바깥쪽 뒤 끝에서 앉는 쪽을 비춘다
      put('@deskLamp', cx + sx + Math.sign(sx) * 0.55, cz - 0.39 + 0.2, 0, 0.77);
      put('chairDesk', cx + sx, cz - 1.08, PI, 0, { carpet: ['dark'] });
      withChair(spot(`desk-${p}-s${sx > 0 ? 1 : 0}`, 'desk', cx + sx, cz - 1.08, FACE.north, 'sit', 0.5, 'type'), sd);
      put('@desk', cx + sx, cz + 0.39, PI);
      put('@deskLamp', cx + sx + Math.sign(sx) * 0.55, cz + 0.39 - 0.2, PI, 0.77);
      put('chairDesk', cx + sx, cz + 1.08, 0, 0, { carpet: ['dark'] });
      withChair(spot(`desk-${p}-n${sx > 0 ? 1 : 0}`, 'desk', cx + sx, cz + 1.08, FACE.south, 'sit', 0.5, 'type'), sd);
    }
    put(p % 2 ? 'plantSmall3' : 'plantSmall2', cx, cz, 0, 0.77); // 네 책상 가운데 (바깥 끝은 스탠드 자리)
  });
  put('pottedPlant', 0.55, 0.55);
  put('pottedPlant', 0.55, 17.4);
  // 서쪽 벽 낮은 수납장 (통로 선 사이)
  for (const z of [8.1, 8.9]) put('bookcaseOpenLow', 0.5, z, FACE.east);
  put('books', 0.5, 8.0, 0.3, 0.8);
  put('plantSmall1', 0.5, 8.9, 0, 0.8);

  // ═══ 본관 서쪽: 회의실 둘 (A 서쪽, B 동쪽). 방마다 6인 탁자 + 화이트보드 + 책장, 복도 쪽 문 하나씩 ═══
  for (const [room, cx, door, wbDx, shelfDx] of [['A', 3.15, 0.8, 0.55, -1.85], ['B', 9.05, 11.6, -0.55, 1.85]]) {
    const MZ = 23.5;
    put('rugRectangle', cx, MZ, 0, 0, { carpet: ['rug'], carpetDarker: ['rugDark'] }, 1.45);
    put('table', cx - 0.84, MZ);
    put('table', cx + 0.84, MZ);
    [-1.1, 0, 1.1].forEach((dx, i) => {
      const sd = [dx < 0 ? -1 : 1, 0];
      put('chairModernCushion', cx + dx, MZ - 0.95, PI);
      withChair(spot(`meet-${room}-s${i}`, 'meeting', cx + dx, MZ - 0.95, FACE.north, 'sit', 0.46, 'talk'), sd).room = room;
      put('chairModernCushion', cx + dx, MZ + 0.95, 0);
      withChair(spot(`meet-${room}-n${i}`, 'meeting', cx + dx, MZ + 0.95, FACE.south, 'sit', 0.46, 'talk'), sd).room = room;
    });
    put('@whiteboard', cx + wbDx, 27.7, 0);
    // 화이트보드가 고양이 키보다 높아서 앞에 2단 발판: 앞(26.75)까지 걸어와 발판 위(높이 STEP_TOP)로 올라선다
    put('@catStep', cx + wbDx, 27.28, 0, 0, undefined, undefined, 'floor'); // 고양이가 올라서는 바닥 층 (출입 길 검사에서 빠짐)
    via(spot(`board-${room}`, 'board', cx + wbDx + 0.3, 27.36, FACE.north, 'stand', 0, 'talk', STEP_TOP), [cx + wbDx + 0.3, 26.7]).room = room;
    // 회의 진행 자리 둘: 화이트보드 앞, 벽걸이 TV 앞 (팀 리더가 오가며 설명)
    via(spot(`present-${room}-board`, 'present', cx + wbDx - 0.4, 27.36, FACE.north, 'stand', 0, 'talk', STEP_TOP), [cx + wbDx - 0.4, 26.7]).room = room;
    const tvx = room === 'A' ? 5.25 : 6.95, lx = room === 'A' ? 5.5 : 6.7;
    via(spot(`present-${room}-tv`, 'present', tvx, 23.5, room === 'A' ? FACE.east : FACE.west, 'stand', 0, 'talk'), [lx, 25.6], [tvx + (room === 'A' ? 0.05 : -0.05), 24.4]).room = room;
    const x = cx + shelfDx;
    put('bookcaseClosedWide', x, 27.5, 0);
    put('books', x - 0.4, 27.55, 0, 0.06); // 책장은 위 칸일수록 얕다: 책을 벽 쪽으로 붙인다
    put('books', x + 0.3, 27.6, 0.2, 0.55);
    put('books', x - 0.2, 27.62, -0.1, 1.04);
    spot(`shelf-${room}`, 'shelf', x, 26.6, FACE.north, 'stand', 0, 'read');
    put('pottedPlant', door < cx ? 5.6 : 6.6, 27.45); // 책장 반대쪽 구석
  }

  // ═══ 본관 가운데: 로비 + 대표실 (가장 안쪽, 등 뒤는 벽과 뒷산, 앞은 중정 연못) ═══
  const BOSS = { x: 16, z: 26.1, deskZ: 25.4 };
  put('rugRectangle', 16, 25.3, 0, 0, { carpet: ['rugBoss'], carpetDarker: ['rugBossDark'] }, 1.4);
  // 대표 책상: 일반 책상을 가로로 1.6배 늘인 전용 견본('@bossDesk', 폭 2.34m: x 14.83~17.17) — 결재판 더미·배달 상자 더미·모니터가 여유 있게 놓인다.
  const bossDeskItem = put('@bossDesk', 16, BOSS.deskZ, PI);
  put('@bossProps', 16, BOSS.deskZ, PI);
  put('chairDesk', BOSS.x, BOSS.z, 0, 0, { carpet: ['bossChair'] });
  const bossSpot = spot('boss', 'boss', BOSS.x, BOSS.z, FACE.south, 'sit', 0.5, 'idle');
  bossSpot.taken = 'boss';
  put('pottedPlant', 13.6, 27.45);
  put('pottedPlant', 18.4, 27.45);
  // 크리스마스 트리 자리(연말에만 xmastree.js 가 세움): 로비 한가운데 (본관 복도 z 19.2 와 결재판 줄 둘째 줄 z 23.55 사이, 정문에서 대표 책상으로 가는 축 위). 전나무 가지 반지름 약 1.0m(가장 긴 가지 1.4m)
  // 트리가 서는 철(OfficeXmas.active)에만 배치 검사·고양이 피해 가기에 같은 원으로 들어간다. 가구는 철과 상관없이 이 자리에 두지 않는다
  const XMAS = { x: 16, z: 21.5, r: 1.3 };
  put('@wallArt', 16, 27.76, 0, 1.25);
  put('pottedPlant', 12.4, 18.6);
  put('pottedPlant', 19.6, 18.6);
  // 대기 소파: 로비 동쪽 끝에서 대표 책상 쪽을 본다 (라운지와의 경계. 결재판 줄 x 16~18.6 밖)
  put('loungeSofa', 20.2, 22.4, FACE.west);
  via(spot('wait-0', 'sofa', 20.15, 21.9, FACE.west, 'sit', SOFA_SEAT, 'idle'), [19.4, 21.9]);
  via(spot('wait-1', 'sofa', 20.15, 22.9, FACE.west, 'sit', SOFA_SEAT, 'idle'), [19.4, 22.9]);
  put('pottedPlant', 20.2, 21.05);
  put('pottedPlant', 20.2, 23.75);
  // 배달·작업 완료 보고 자리: 대표 책상 정면, 결재판 줄 맨 앞 자리(16, 24.4)의 서쪽 옆 한 칸(0.85m, 줄은 동쪽으로 늘어서 비어 있음).
  // 대표를 마주 보고 선다 (줄 맨 앞과 같은 자리를 쓰면 줄 고양이와 부딪혀 밀려남)
  const deliverSpot = spot('deliver', 'deliver', 15.15, 24.4, Math.atan2(-(BOSS.x - 15.15), -(BOSS.z - 24.4)), 'stand', 0, 'present');
  // 책상 위 배달 상자 쌓는 자리 (월드 좌표)
  const PILE = [0, 1, 2, 3, 4, 5].map((k) => new V3(16.8 + (k % 2) * 0.2, 0.77 + Math.floor(k / 2) * 0.2, 25.15));
  // 결재판을 내려놓는 짧은 줄 (대표 책상 정면, 로비 안에서만): 맨 앞 자리(16.0, 24.4)에서 책상에 결재판을 올려놓고, 뒤로 동쪽으로 한 줄(0.85m 간격) 늘어서다 둘째 줄(z 23.55)로 꺾인다.
  // 맨 앞 자리는 작업 완료 보고 자리(15.15, 24.4)에서 0.85m, 크리스마스 트리 원(16, 21.5 r1.3)과는 둘째 줄 끝 자리(17.7, 23.55)가 1.3m 넘게 떨어져 있다. 모두 예전 결재 줄이 쓰던 로비 자리라 가구·벽과 겹치지 않는다.
  // 책상 위 결재판 쌓는 자리(board): 책상 서쪽(x 15.25, z 25.2, 책상 폭 x 14.83~17.17) — 동쪽의 배달 상자 더미(x 16.8~17.1)·가운데 화면·키보드·마우스와 겹치지 않는다. 높이는 책상 윗면 0.77 에서 한 장 0.03 씩
  const DROP = (() => {
    const row1 = 24.4, row2 = 23.55;
    const pts = [[16.0, row1], [16.85, row1], [17.7, row1], [18.55, row1], [18.55, row2], [17.7, row2]].map(([x, z]) => new V3(x, 0, z));
    return { pts, slots: pts.map((p) => ({ pos: p, rotY: PI })), enter: [new V3(19.4, 0, 22.6)], exit: [new V3(16.0, 0, 23.55), new V3(12.9, 0, 23.55)], report: [new V3(12.9, 0, 23.55), new V3(15.15, 0, 23.55)], // report: 보고 자리로 드나드는 서쪽 길목들, enter: 줄에 설 때 거쳐 오는 동쪽 길목, exit: 결재판을 놓고 빠져나가는 길목들(한 칸 물러나 서쪽으로)
      board: { x: 15.25, z: 25.2, y: 0.77, dy: 0.03, max: 12 } }; // 책상을 향해(북쪽, rotY π) 선다
  })();

  // ═══ 본관 동쪽: 라운지 ═══
  // 대화 자리: 소파 셋을 ㄷ자로 놓고(남쪽이 트임) 가운데 탁자. 북쪽 소파는 창 밑 벽에 붙인다
  const RUG = { carpet: ['rug'], carpetDarker: ['rugDark'] };
  const LX = 25.6, LZ = 25.6;
  put('rugRectangle', LX, LZ + 0.1, 0, 0, RUG, 1.7);
  put('tableCoffee', LX, LZ, 0);
  put('plantSmall1', LX + 0.3, LZ, 0, 0.46);
  put('books', LX - 0.3, LZ + 0.1, 0.4, 0.46);
  const aisleW = LX - 1.05, aisleE = LX + 1.05; // 소파와 탁자 사이로 드나드는 길
  const LIN = 24.2, LFR = 26.45; // 라운지 통로 선, 북쪽 소파 앞
  put('loungeSofa', LX, 27.34, FACE.south);
  via(spot('sofa-n0', 'sofa', LX - 0.5, 27.29, FACE.south, 'sit', SOFA_SEAT, 'idle'), [aisleW, LIN], [aisleW, LFR], [LX - 0.5, LFR]);
  via(spot('sofa-n1', 'sofa', LX + 0.5, 27.29, FACE.south, 'loaf', 0, 'sleep', SOFA_TOP), [aisleE, LIN], [aisleE, LFR], [LX + 0.5, LFR]);
  put('loungeSofa', LX - 1.85, LZ, FACE.east);
  via(spot('sofa-w0', 'sofa', LX - 1.8, LZ - 0.5, FACE.east, 'sit', SOFA_SEAT, 'idle'), [aisleW, LIN], [aisleW, LZ - 0.5]);
  via(spot('sofa-w1', 'sofa', LX - 1.8, LZ + 0.5, FACE.east, 'sit', SOFA_SEAT, 'read'), [aisleW, LIN], [aisleW, LZ + 0.5]);
  put('loungeSofa', LX + 1.85, LZ, FACE.west);
  via(spot('sofa-e0', 'sofa', LX + 1.8, LZ - 0.5, FACE.west, 'sit', SOFA_SEAT, 'idle'), [aisleE, LIN], [aisleE, LZ - 0.5]);
  via(spot('sofa-e1', 'sofa', LX + 1.8, LZ + 0.5, FACE.west, 'loaf', 0, 'sleep', SOFA_TOP), [aisleE, LIN], [aisleE, LZ + 0.5]);
  put('lampRoundFloor', LX - 1.75, 27.4);
  put('pottedPlant', LX + 1.75, 27.45);
  // 창가 자리: 동쪽 벽에 등을 댄 안락의자 둘 + 사이 탁자
  put('rugRound', 30.6, 22.1, 0, 0, RUG, 1.15);
  put('loungeChair', 31.3, 21.2, FACE.west);
  via(spot('nook-0', 'sofa', 31.25, 21.2, FACE.west, 'sit', SOFA_SEAT, 'read'), [30.0, 21.2]);
  put('tableCoffeeSquare', 31.3, 22.1);
  put('plantSmall2', 31.3, 22.1, 0, 0.46);
  put('loungeChair', 31.3, 23.0, FACE.west);
  via(spot('nook-1', 'sofa', 31.25, 23.0, FACE.west, 'sit', SOFA_SEAT, 'idle'), [30.0, 23.0]);
  put('pottedPlant', 31.45, 19.7);
  // 복도 쪽 작은 자리: 마주 보는 안락의자 둘 + 사이 탁자
  put('rugRound', 25.6, 21.6, 0, 0, RUG, 1.2);
  put('tableCoffeeGlassSquare', 25.6, 21.6);
  put('loungeChair', 24.3, 21.6, FACE.east);
  via(spot('pair-w', 'sofa', 24.35, 21.6, FACE.east, 'sit', SOFA_SEAT, 'idle'), [24.95, 19.2], [24.95, 21.6]);
  put('loungeChair', 26.9, 21.6, FACE.west);
  via(spot('pair-e', 'sofa', 26.85, 21.6, FACE.west, 'sit', SOFA_SEAT, 'read'), [26.25, 19.2], [26.25, 21.6]);
  put('@bigTree', 30.7, 26.8);
  const towerItem = put('@catTower', 31.1, 24.7); // 간식 점수로 해금 (처음엔 숨김)

  // ═══ 오른쪽 날개: 서재(앞) + 카페(뒤) ═══
  // 동쪽 벽: 책장 넷을 나란히
  [2.2, 3.85, 5.5, 7.15].forEach((z, i) => {
    put('bookcaseClosedWide', 31.5, z, FACE.west);
    put('books', 31.55, z - 0.4, FACE.west, 0.06);
    put('books', 31.6, z + 0.3, FACE.west + 0.2, 0.55);
    if (i % 2) put('books', 31.62, z - 0.1, FACE.west - 0.1, 1.04);
  });
  spot('lib-0', 'shelf', 30.75, 3.85, FACE.east, 'stand', 0, 'read');
  spot('lib-1', 'shelf', 30.75, 5.5, FACE.east, 'stand', 0, 'read');
  // 가운데: 열람 탁자 + 의자 넷
  put('rugRectangle', 28.3, 2.85, 0, 0, RUG, 1.3);
  put('table', 28.3, 2.85);
  put('books', 28.3, 2.85, 0.3, 0.65);
  for (const dx of [-0.4, 0.4]) {
    const sd = [Math.sign(dx), 0];
    put('chair', 28.3 + dx, 1.9, PI);
    withChair(spot(`read-s${dx > 0 ? 1 : 0}`, 'shelf', 28.3 + dx, 1.9, FACE.north, 'sit', 0.46, 'read'), sd);
    put('chair', 28.3 + dx, 3.8, 0);
    withChair(spot(`read-n${dx > 0 ? 1 : 0}`, 'shelf', 28.3 + dx, 3.8, FACE.south, 'sit', 0.46, 'read'), sd);
  }
  // 중정 쪽 유리벽: 안락의자 셋과 사이 탁자 둘 (연못을 등지고 책장을 본다)
  [[1.2, [24.95, 1.0]], [3.2, [24.95, 4.7]], [5.2, [24.95, 4.7]]].forEach(([z, from], i) => {
    put('loungeChair', 24.2, z, FACE.east);
    via(spot(`arm-r${i}`, 'sofa', 24.25, z, FACE.east, 'sit', SOFA_SEAT, 'read'), from, [24.95, z]);
  });
  put('tableCoffeeSquare', 24.25, 2.2);
  put('plantSmall3', 24.25, 2.2, 0, 0.46);
  put('tableCoffeeSquare', 24.25, 4.2);
  put('books', 24.25, 4.2, 0.5, 0.46);
  put('lampSquareFloor', 24.05, 0.5);
  put('pottedPlant', 31.4, 0.6);
  // 카페: 동쪽 벽에 붙인 주방
  const KX = 31.3;
  put('kitchenFridge', KX + 0.15, 16.9, FACE.west);
  put('kitchenCabinet', KX, 15.98, FACE.west);
  put('kitchenSink', KX, 15.12, FACE.west);
  put('kitchenCabinetDrawer', KX, 14.26, FACE.west);
  put('kitchenCoffeeMachine', KX + 0.15, 14.26, FACE.west, 0.9);
  put('kitchenCabinet', KX, 13.4, FACE.west);
  put('kitchenMicrowave', KX + 0.15, 13.4, FACE.west, 0.9);
  put('kitchenCabinetUpperDouble', KX + 0.23, 15.1, FACE.west, 1.55);
  via(spot('coffee', 'coffee', 30.3, 14.26, FACE.east, 'stand', 0, 'drink'), [30.3, 17.6]);
  put('pottedPlant', 24.0, 17.45);
  [12.4, 13.26, 14.12].forEach((z, i) => {
    put('kitchenBar', 27.6, z, FACE.west);
    put('stoolBar', 26.85, z, FACE.east);
    via(spot(`stool-${i}`, 'cafe', 26.85, z, FACE.east, 'sit', 0.8, 'drink'), [25.6, z]);
  });
  put('kitchenBarEnd', 27.6, 11.87, FACE.west);
  put('tableRound', 24.55, 12.0, 0);
  put('chairRounded', 24.55, 10.95, FACE.north);
  withChair(spot('ct-a-s', 'cafe', 24.55, 10.95, FACE.north, 'sit', 0.46, 'drink'), [1, 0]);
  put('chairRounded', 24.55, 13.05, FACE.south);
  withChair(spot('ct-a-n', 'cafe', 24.55, 13.05, FACE.south, 'sit', 0.46, 'talk'), [1, 0]);
  put('tableRound', 28.9, 10.4, PI / 2);
  put('chairRounded', 27.95, 10.4, FACE.east);
  withChair(spot('ct-b-w', 'cafe', 27.95, 10.4, FACE.east, 'sit', 0.46, 'drink'), [0, -1]);
  put('chairRounded', 29.85, 10.4, FACE.west);
  withChair(spot('ct-b-e', 'cafe', 29.85, 10.4, FACE.west, 'sit', 0.46, 'talk'), [0, -1]);
  // 찻자리 더: 서쪽 둥근 탁자 하나 더(남북으로 마주 앉기) + 동쪽 둥근 탁자(동서로 마주 앉기)
  put('tableRound', 24.55, 15.6, 0);
  put('chairRounded', 24.55, 14.55, FACE.north);
  withChair(spot('ct-c-s', 'cafe', 24.55, 14.55, FACE.north, 'sit', 0.46, 'drink'), [1, 0]);
  put('chairRounded', 24.55, 16.65, FACE.south);
  withChair(spot('ct-c-n', 'cafe', 24.55, 16.65, FACE.south, 'sit', 0.46, 'talk'), [1, 0]);
  put('tableRound', 28.7, 16.1, PI / 2);
  put('chairRounded', 27.75, 16.1, FACE.east);
  withChair(spot('ct-d-w', 'cafe', 27.75, 16.1, FACE.east, 'sit', 0.46, 'drink'), [0, 1]);
  put('chairRounded', 29.65, 16.1, FACE.west);
  withChair(spot('ct-d-e', 'cafe', 29.65, 16.1, FACE.west, 'sit', 0.46, 'talk'), [0, 1]);
  put('trashcan', 31.5, 9.4);

  // ═══ 중정: 낚시터 호수 (복도에서 문을 한 번 더 나가야 나온다) ═══
  // 연못: 중정 마당을 거의 다 채우는 큰 사각 (북쪽은 본관 벽 아래, 남쪽은 중정 끝, 양옆은 날개 유리벽 앞까지) (반폭 rx·rz). 둘레는 나무 데크(DECK, 폭 1.4m)가 두르고, 데크 폭 한가운데 선(CLOOP)이 고양이 산책로다. 연못 한가운데는 분수대.
  const CPOND = { x: 16, z: 9.55, rx: 4.1, rz: 6.55 };
  const DECK = { x0: 10.5, x1: 21.5, z0: 1.6, z1: 17.5, w: 1.4 };
  /**
   * 점 (x, z) 가 연못 사각 안인가 (m 만큼 넓혀서, 음수면 좁혀서).
   * @param {number} x x
   * @param {number} z z
   * @param {number} [m=0] 여유
   * @returns {boolean} 안이면 true
   */
  const inPond = (x, z, m = 0) => Math.abs(x - CPOND.x) < CPOND.rx + m && Math.abs(z - CPOND.z) < CPOND.rz + m;
  /**
   * 점 (x, z) 가 데크 바깥 사각(연못 포함) 안인가 (m 만큼 넓혀서).
   * @param {number} x x
   * @param {number} z z
   * @param {number} [m=0] 여유
   * @returns {boolean} 안이면 true
   */
  const inDeck = (x, z, m = 0) => x > DECK.x0 - m && x < DECK.x1 + m && z > DECK.z0 - m && z < DECK.z1 + m;
  // 데크 산책로: 데크 폭 가운데를 도는 모서리 둥근 사각 고리 (남쪽 가운데 (16, 4.8) 에서 시작, 0.4m 간격)
  const CLOOP = [];
  {
    const lx0 = DECK.x0 + DECK.w / 2, lx1 = DECK.x1 - DECK.w / 2, lz0 = DECK.z0 + DECK.w / 2, lz1 = DECK.z1 - DECK.w / 2, rr = 0.5;
    const line = (x0, z0, x1, z1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.4)); for (let i = 0; i < n; i++) CLOOP.push(new V3(x0 + ((x1 - x0) * i) / n, 0, z0 + ((z1 - z0) * i) / n)); };
    const arc = (cx, cz, a0) => { for (let i = 0; i < 4; i++) { const a = a0 + (i / 4) * (PI / 2); CLOOP.push(new V3(cx + Math.cos(a) * rr, 0, cz + Math.sin(a) * rr)); } };
    line(CPOND.x, lz0, lx1 - rr, lz0); arc(lx1 - rr, lz0 + rr, -PI / 2);
    line(lx1, lz0 + rr, lx1, lz1 - rr); arc(lx1 - rr, lz1 - rr, 0);
    line(lx1 - rr, lz1, lx0 + rr, lz1); arc(lx0 + rr, lz1 - rr, PI / 2);
    line(lx0, lz1 - rr, lx0, lz0 + rr); arc(lx0 + rr, lz0 + rr, PI);
    line(lx0 + rr, lz0, CPOND.x, lz0);
  }
  /**
   * 점 목록에서 (x, z) 에 가장 가까운 점을 찾는 함수를 만든다.
   * @param {BABYLON.Vector3[]} list 후보 점들
   * @returns {function(number, number):BABYLON.Vector3} (x, z) → 가장 가까운 점
   */
  const nearestOf = (list) => (x, z) => list.reduce((b, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(b.x - x, b.z - z) ? p : b), list[0]);
  const nearestC = nearestOf(CLOOP);
  // 잔교: 북쪽 데크 서쪽 부분에서 연못 가운데(분수대) 쪽으로 남쪽·약간 동쪽으로 한 줄 내민 낚시 데크 (폭 1.2m). 끝은 분수대 받침(r 1.15)에서 2m 넘게 떨어진다
  const PIER = (() => {
    const a = nearestC(13.1, DECK.z1 - DECK.w / 2), b = new V3(14.5, 0, 12.5);
    const L = Math.hypot(b.x - a.x, b.z - a.z), d = new V3((b.x - a.x) / L, 0, (b.z - a.z) / L);
    return { a, b, d, n: new V3(-d.z, 0, d.x), L, w: 1.2 };
  })();
  /** 점이 잔교 위(m 만큼 넓혀서)인가. */
  const onPier = (x, z, m = 0) => {
    const t = (x - PIER.a.x) * PIER.d.x + (z - PIER.a.z) * PIER.d.z, u = (x - PIER.a.x) * PIER.n.x + (z - PIER.a.z) * PIER.n.z;
    return t > -m && t < PIER.L + m && Math.abs(u) < PIER.w / 2 + m;
  };
  // 낚시 보트: 잔교 서쪽(왼쪽) 옆 물 위에 길이로 나란히 띄운다 (뱃머리는 잔교 끝보다 조금 앞). 잔교 끝 정면은 분수대·스케이트 고리와 너무 가까워 옆으로 댄다.
  // 배는 공개 모델(Kenney 노 젓는 작은 배, 원본 선체 길이 2.38m·폭 1.42m, 노 끝에서 끝 2.74m)을 0.66배로 쓴다: 선체 길이 1.58m(hl 반길이)·폭 0.94m(hw 반폭).
  // 노가 양옆으로 0.9m 씩 뻗으므로 가운데 선을 잔교 축에서 서쪽으로 1.55m 띄운다(잔교 반폭 0.6 + 노 0.9 + 여유). 뱃머리 쪽 높은 갑판(seatA)과 가운데 바닥(seatB)이 낚시 자리다. 통(BUCKET)은 잔교 동쪽 끝 가까이
  const BOAT = (() => {
    const t0 = PIER.L - 0.7, hl = 0.79, hw = 0.47, off = 1.55;
    const x = PIER.a.x + PIER.d.x * t0 - PIER.n.x * off, z = PIER.a.z + PIER.d.z * t0 - PIER.n.z * off;
    return { x, z, hl, hw, t0, off, rotY: Math.atan2(PIER.d.x, PIER.d.z), seatA: 0.27, seatB: -0.3, seatYA: 0.24, seatYB: 0.16 }; // 앉는 높이: 갑판 윗면·바닥 윗면 (물에 0.03 잠긴 것 반영)
  })();
  const BUCKET = { x: PIER.a.x + PIER.d.x * (PIER.L - 0.55) + PIER.n.x * 0.38, z: PIER.a.z + PIER.d.z * (PIER.L - 0.55) + PIER.n.z * 0.38, r: 0.2 };
  put('@pondCourt', CPOND.x, CPOND.z);
  put('@fountain', CPOND.x, CPOND.z); // 연못 한가운데 분수대 (물줄기·물보라는 create 가 따로 그린다)
  // 물 속 돌: 남쪽 두 모서리 (북쪽 두 모서리는 갈대)
  for (const [sx, sz, k] of [[-1, -1, 0.6], [1, -1, 0.5]]) put(sx < 0 ? '@rock1' : '@rock2', CPOND.x + sx * (CPOND.rx - 0.7), CPOND.z + sz * (CPOND.rz - 0.65), sx + sz, 0, undefined, k);
  // 마당이 거의 연못이라 바깥 물체는 남쪽 띠(z 0.2~1.6)에만: 모서리 나무 둘 + 꽃
  put('@tree', 10.9, 0.85, 0.4, 0, undefined, 0.8);
  put('@pine', 21.1, 0.85, 1.1, 0, undefined, 0.8);
  put('@flowers', 12.35, 0.75, 0, 0, undefined, 1.0);
  put('@flowers', 19.65, 0.75, 1, 0, undefined, 1.0);
  // 낚시 자리: 데크 안쪽 가장자리(물에서 0.45m)에 앉아 연못 쪽을 본다. 서·동 한가운데 + 남 둘·북 하나 + 보트 널 둘 (낚시의 주 자리, 데모는 보트를 먼저 고른다). 앉으면 낚싯대가 나타나고 찌는 물 위(앞 약 1m)에 뜬다
  const FISH = [];
  {
    const pz0 = CPOND.z - CPOND.rz, pz1 = CPOND.z + CPOND.rz, px0 = CPOND.x - CPOND.rx, px1 = CPOND.x + CPOND.rx;
    for (const [id, x, z, tx, tz] of [['w', px0 - 0.45, CPOND.z, CPOND.x, CPOND.z], ['e', px1 + 0.45, CPOND.z, CPOND.x, CPOND.z], ['s1', 13.2, pz0 - 0.45, 13.2, CPOND.z], ['s2', 18.8, pz0 - 0.45, 18.8, CPOND.z], ['n1', 18.4, pz1 + 0.45, 18.4, CPOND.z]]) {
      const q = nearestC(x, z);
      FISH.push(via(spot(`fish-${id}`, 'fish', x, z, faceTo(x, z, tx, tz), 'sit', 0.1, 'idle'), [q.x, q.z]));
    }
    // 보트: 앞 널은 뱃머리 쪽(진행 방향)을, 뒤 널은 잔교 반대쪽 옆(서쪽)을 보고 앉는다. 잔교 위 통로 점(via)에서 보트로 건너 앉는다.
    for (const [id, k, face, sy] of [['b1', BOAT.seatA, 'bow', BOAT.seatYA], ['b2', BOAT.seatB, 'side', BOAT.seatYB]]) {
      const x = BOAT.x + PIER.d.x * k, z = BOAT.z + PIER.d.z * k;
      const t = BOAT.t0 + k, m = new V3(PIER.a.x + PIER.d.x * t - PIER.n.x * 0.45, 0, PIER.a.z + PIER.d.z * t - PIER.n.z * 0.45); // 잔교 서쪽 가장자리 가까이에서 건너간다
      const [tx, tz] = face === 'bow' ? [x + PIER.d.x, z + PIER.d.z] : [x - PIER.n.x, z - PIER.n.z];
      FISH.push(via(spot(`fish-${id}`, 'fish', x, z, faceTo(x, z, tx, tz), 'sit', sy, 'idle'), [PIER.a.x + PIER.d.x * 0.6, PIER.a.z + PIER.d.z * 0.6], [PIER.a.x + PIER.d.x * (t - 0.4), PIER.a.z + PIER.d.z * (t - 0.4)], [m.x, m.z]));
    }
  }
  // 스케이트: 연못이 얼었을 때만 쓴다 (낚시 대신). 고리는 분수대 둘레 타원 — 분수대 받침(r 1.15)에서 1m 넘게, 물가에서 0.9m 이상, 잔교 끝에서 0.5m 이상
  const SKATE = { x: CPOND.x, z: CPOND.z, rx: 3.2, rz: 2.5, n: 28 };
  const SKATE_LOOP = [];
  for (let i = 0; i < SKATE.n; i++) { const a = (i / SKATE.n) * PI * 2; SKATE_LOOP.push(new V3(SKATE.x + Math.cos(a) * SKATE.rx, 0, SKATE.z + Math.sin(a) * SKATE.rz)); }
  // 스케이트 자리: 서·동 데크 (낚시 자리와 같은 좌표·같은 접근 길). gate = 고리에 오르내리는 점 번호
  for (const [id, x, gate] of [['skate-w', CPOND.x - CPOND.rx - 0.45, 14], ['skate-e', CPOND.x + CPOND.rx + 0.45, 0]]) {
    const q = nearestC(x, CPOND.z);
    via(spot(id, 'skate', x, CPOND.z, faceTo(x, CPOND.z, CPOND.x, CPOND.z), 'stand', 0, 'idle'), [q.x, q.z]).gate = gate;
  }
  // 중정 벤치: 남쪽 띠에서 데크 산책로를 본다
  for (const bx of [14.1, 17.9]) {
    const bz = 0.7, q = nearestC(bx, DECK.z0 + DECK.w / 2);
    const r = faceTo(bx, bz, q.x, q.z);
    put('@bench', bx, bz, r);
    via(spot(`cbench-${bx}`, 'bench', bx, bz, r, 'sit', 0.45, 'idle'), [q.x, q.z]);
  }

  // ═══ 바깥 공원 ═══
  /**
   * 닫힌 Catmull-Rom 곡선으로 제어점들을 부드럽게 이어 점 목록을 만든다.
   * 각 제어점 구간마다 per 개의 점을 뽑으며 y 는 0 이다.
   * @param {number[][]} ctrl 제어점 [x, z] 들 (마지막과 처음이 이어진다)
   * @param {number} per 구간당 점 수
   * @returns {BABYLON.Vector3[]} 곡선 위 점들 (길이 ctrl.length * per)
   */
  function catmullClosed(ctrl, per) {
    const out = [];
    const n = ctrl.length;
    for (let i = 0; i < n; i++) {
      const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
      for (let k = 0; k < per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push(new V3(f(p0[0], p1[0], p2[0], p3[0]), 0, f(p0[1], p1[1], p2[1], p3[1])));
      }
    }
    return out;
  }
  const LOOP = catmullClosed([
    [16, -3], [24, -3.3], [31, -4.6], [34.5, -9], [31, -14.5], [22, -16], [12, -14.8], [2, -15.6], [-6, -14.5],
    [-12.5, -9], [-13, 0], [-12, 9], [-12.6, 18], [-10, 26], [-5, 29.5], [-2.5, 23], [-3.2, 14], [-3, 5], [-2.6, -1.5], [6, -3.1],
  ], 6);
  const nearestL = nearestOf(LOOP);
  const POND = { x: -7.2, z: -7.5, rx: 3.2, rz: 2.4 };
  const STATUE = { x: 20, z: -9.5 };
  const pondEnd = new V3(-6.7, 0, -4.3), statueEnd = new V3(STATUE.x, 0, -6.9);

  // 연결 길: [점, 점, ...] 꺾은선. 끝점들이 통로 선 끝점과 맞물린다.
  const CONNECT = [
    [new V3(13.5, 0, 17.0), nearestC(13.5, DECK.z1 - DECK.w / 2)], // 정문 → 데크 산책로
    [new V3(9.2, 0, 11.0), new V3(10.8, 0, 11.0), nearestC(DECK.x0 + DECK.w / 2, 11.0)], // 왼쪽 날개 옆문
    [new V3(25.6, 0, 7.0), new V3(21.2, 0, 7.0), nearestC(DECK.x1 - DECK.w / 2, 7.0)], // 오른쪽 날개 옆문
    [nearestC(16, DECK.z0 + DECK.w / 2), LOOP[0]], // 중정 → 공원
    [nearestL(-3.0, -2.6), pondEnd], // 공원 연못가
    [nearestL(STATUE.x, -3.3), statueEnd], // 조각상 앞
  ];

  for (const [tx, tz, ox, oz] of [[12, -3.2, 0, 1.5], [26, -3.4, 0, 1.5], [22, -16, 0, 1.6], [6, -15.2, 0, 1.6], [-12.3, 6, 1.6, 0], [33.4, -7.5, -2.0, 0]]) {
    const q = nearestL(tx, tz);
    const bx = q.x + ox, bz = q.z + oz;
    const r = faceTo(bx, bz, q.x, q.z);
    put('@bench', bx, bz, r);
    via(spot(`bench-${tx}`, 'bench', bx, bz, r, 'sit', 0.45, 'idle'), [q.x, q.z]);
  }
  for (const dx of [-0.55, 0.55]) {
    const x = pondEnd.x + dx, z = pondEnd.z;
    via(spot(`pond${dx}`, 'park', x, z, faceTo(x, z, POND.x, POND.z), 'stand', 0, 'idle'), [pondEnd.x, pondEnd.z]);
  }
  for (const dx of [-0.6, 0.6]) via(spot(`statue${dx}`, 'park', statueEnd.x + dx, statueEnd.z - 0.1, 0, 'stand', 0, 'idle'), [statueEnd.x, statueEnd.z]);
  put('@pondPark', POND.x, POND.z);
  put('@statue', STATUE.x, STATUE.z);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * PI * 2;
    if (Math.abs(a - PI / 2) < 0.4) continue; // 조각상 앞 구경 자리는 비움
    put('@flowers', STATUE.x + Math.cos(a) * 1.9, STATUE.z + Math.sin(a) * 1.9, a, 0, undefined, 0.9 + (i % 3) * 0.12);
  }
  [[0.2, 1.15, 1.0], [0.9, 1.12, 0.7], [2.15, 1.2, 1.0], [2.9, 1.1, 0.8], [3.4, 1.18, 1.1], [4.3, 1.12, 0.6], [5.2, 1.16, 0.9]].forEach(([a, k, sc], i) =>
    put(i % 2 ? '@rock2' : '@rock1', POND.x + Math.cos(a) * POND.rx * k, POND.z + Math.sin(a) * POND.rz * k, a * 2, 0, undefined, sc));
  [[29.5, -8.2, 1.2], [30.2, -8.8, 0.7], [-9.0, 15.5, 1.0], [-8.4, 16.2, 0.6], [6.5, -9.5, 1.1], [26, -11.5, 0.9]].forEach(([x, z, sc], i) =>
    put(i % 2 ? '@rock2' : '@rock1', x, z, i * 1.3, 0, undefined, sc));
  [[10.5, -9.5], [27, -9], [-8, 4], [-7.5, 10]].forEach(([x, z], i) => put('@flowers', x, z, i, 0, undefined, 1.4));
  // 뒷산: 건물 뒤 나무 언덕
  put('@mound', 16, 37);

  // 산책 경유지
  const WALK = [0.15, 0.35, 0.55, 0.8].map((f) => LOOP[Math.floor(LOOP.length * f)]);

  // ═══ 바깥 조명 (밤 불빛은 daylight.js 가 lights 목록으로 그린다) ═══
  // 자리 찾기: 목표점에서 가까운 곳부터 둥글게 훑어, 길 띠·건물·벽·다른 바깥 물체·자리 출입 길을 모두 피하는 첫 자리
  /**
   * 계절 바닥 목록. 여름 풀 [x, z, 회전, 크기] 와 가을 낙엽 [x, z, 회전] 을 담는다.
   * @type {{grass:number[][], leaves:number[][]}}
   */
  const GROUND = { grass: [], leaves: [] }; // 계절 바닥: 여름 풀 [x, z, 회전, 크기] · 가을 낙엽 [x, z, 회전]
  /**
   * 바깥 조명 목록. street 는 가로등, garden 은 정원등, up 은 바닥 투광등, tree 는 나무 밑 불빛,
   * fairy 는 나무 속 꼬마전구 [x, y, z], lines 는 길 따라 라인 조명 {pts, closed, half}.
   * @type {{street:LampLight[], garden:LampLight[], up:LampLight[], fairy:number[][], tree:LampLight[], lines:Object[]}}
   */
  const LIGHTS = { street: [], garden: [], up: [], fairy: [], tree: [], lines: [] }; // 등: { x, z, gx, gz(바닥 불빛 가운데) } · fairy: 나무 속 꼬마전구 [x, y, z]
  /**
   * 가로등 자리 계산에 쓰는 바깥 길 선분 목록 (outdoorPaths 와 같다).
   * @returns {BABYLON.Vector3[][]} [a, b] 선분 목록
   * @see outdoorPaths
   */
  const lampSegs = () => outdoorPaths();
  /**
   * 점 (x, z) 에서 선분 목록까지의 최소 거리.
   * @param {BABYLON.Vector3[][]} segs [a, b] 선분 목록
   * @param {number} x 점 x
   * @param {number} z 점 z
   * @returns {number} 최소 거리 (m)
   * @see project
   */
  const distSegs = (segs, x, z) => { const q = new V3(x, 0, z); let d = Infinity; for (const [a, b] of segs) d = Math.min(d, V3.Distance(project(q, { a, b }), q)); return d; };
  const COURT_IN = { x0: 10.25, x1: 21.75, z0: 0.3, z1: 17.75 };
  /**
   * 조명이 피해야 할 점들: 모든 자리 위치와 경유점.
   * @returns {BABYLON.Vector3[]} 점 목록
   */
  const avoidPts = () => {
    const pts = [];
    for (const sp of spots) { pts.push(sp.pos); if (sp.via) pts.push(...sp.via); }
    return pts;
  };
  /**
   * 조명(가로등·정원등·투광등)을 놓을 자리를 찾는다.
   * 목표점에서 가까운 곳부터 둥글게 훑어, 길 띠·건물·벽·연못·잔교·다른 바깥 물체·자리 출입 길·뒷산을 모두 피하는 첫 자리를 돌려준다 (규칙 e 와 맞춤).
   * @param {number} tx 목표 x
   * @param {number} tz 목표 z
   * @param {number} r 설치물 반지름
   * @param {{maxR?:number, pond?:{x:number, z:number, rx:number, rz:number}}} [opts={}] maxR: 훑는 최대 반경(기본 3), pond: 추가로 피할 연못 타원
   * @returns {({x:number, z:number}|null)} 자리, 못 찾으면 null
   * @see distSegs
   * @see avoidPts
   */
  function lightSpot(tx, tz, r, opts = {}) {
    const segs = lampSegs(), pts = avoidPts();
    const outR = items.map((it, n) => (layers[n] === 'outdoor' ? { x: it[1], z: it[2], r: RADIUS[it[0]] ? RADIUS[it[0]] * (it[6] || 1) : 0.95 } : null)).filter(Boolean);
    /**
     * (x, z) 에 반지름 r 짜리 설치물을 놓아도 되는지.
     * @param {number} x 후보 x
     * @param {number} z 후보 z
     * @returns {boolean} 모든 회피 조건을 통과하면 true
     */
    const ok = (x, z) => {
      const inCourt = x > COURT_IN.x0 + r && x < COURT_IN.x1 - r && z > COURT_IN.z0 + r && z < COURT_IN.z1 - r;
      if (!inCourt && x > -0.4 - r && x < 32.4 + r && z > -0.4 - r && z < 28.4 + r) return false; // 건물·벽
      if (distSegs(segs, x, z) < PATH_HALF + r + 0.05) return false; // 길 띠 밖 (규칙 e)
      if (opts.pond && ((x - opts.pond.x) / (opts.pond.rx + r + 0.1)) ** 2 + ((z - opts.pond.z) / (opts.pond.rz + r + 0.1)) ** 2 < 1) return false;
      if (inDeck(x, z, r + 0.1)) return false; // 데크·물 위
      if (((x - POND.x) / (POND.rx + r + 0.1)) ** 2 + ((z - POND.z) / (POND.rz + r + 0.1)) ** 2 < 1) return false;
      if (outR.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + r + 0.08)) return false; // 다른 바깥 물체 (규칙 a)
      if (pts.some((q) => Math.hypot(q.x - x, q.z - z) < r + 0.45)) return false; // 자리·출입 경유점
      if (z > 29 && x > -10 && x < 42) return false; // 뒷산
      return true;
    };
    for (let rr = 0; rr <= (opts.maxR ?? 3); rr += 0.2) {
      const n = rr === 0 ? 1 : Math.ceil((rr * PI * 2) / 0.3);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * PI * 2, x = tx + Math.cos(a) * rr, z = tz + Math.sin(a) * rr;
        if (ok(x, z)) return { x, z };
      }
    }
    return null;
  }
  /**
   * 가로등: 길 쪽을 보고 서고, 바닥 불빛은 등 머리 아래.
   * lightSpot 으로 자리를 찾고, 가장 가까운 길 선분 쪽으로 돌려 @streetLamp 를 놓은 뒤 LIGHTS.street 에 등록한다.
   * @param {number} tx 목표 x
   * @param {number} tz 목표 z
   * @param {string} why 설치 이유 (경고·디버그용)
   * @returns {(LampLight|null)} 등록한 조명, 자리가 없으면 null (콘솔 경고)
   * @see lightSpot
   * @see project
   */
  function streetLamp(tx, tz, why) {
    const p = lightSpot(tx, tz, RADIUS['@streetLamp']);
    if (!p) { console.warn('가로등 자리 없음', why, tx.toFixed(1), tz.toFixed(1)); return null; }
    const segs = lampSegs(), q0 = new V3(p.x, 0, p.z);
    let best = null, bd = Infinity;
    for (const [a, b] of segs) { const pr = project(q0, { a, b }), d = V3.Distance(pr, q0); if (d < bd) { bd = d; best = pr; } }
    const dx = best.x - p.x, dz = best.z - p.z, l = Math.hypot(dx, dz) || 1;
    put('@streetLamp', p.x, p.z, Math.atan2(-dx / l, -dz / l));
    const L = { x: p.x, z: p.z, gx: p.x + (dx / l) * 0.45, gz: p.z + (dz / l) * 0.45, why };
    LIGHTS.street.push(L);
    return L;
  }
  // (1) 벤치마다 옆에 가로등 (벤치 옆쪽 1.1m 를 목표로)
  for (const b of spots.filter((sp) => sp.kind === 'bench')) {
    const sx = Math.cos(b.rotY), sz = -Math.sin(b.rotY); // 벤치 옆(앉은 고양이의 오른쪽)
    streetLamp(b.pos.x + sx * 1.15, b.pos.z + sz * 1.15, 'bench ' + b.id);
  }
  // (3) 공원 길: 고르게 14곳 중 이미 가로등이 4m 안에 있는 곳은 건너뜀
  for (let k = 0; k < 14; k++) {
    const i = Math.floor((LOOP.length * k) / 14), q = LOOP[i], q2 = LOOP[(i + 1) % LOOP.length];
    let nx = -(q2.z - q.z), nz = q2.x - q.x;
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    if (nx * (q.x - 16) + nz * (q.z - 12) < 0) { nx = -nx; nz = -nz; }
    const tx = q.x + nx * 1.15, tz = q.z + nz * 1.15;
    if (LIGHTS.street.some((L) => Math.hypot(L.x - tx, L.z - tz) < 4)) continue;
    streetLamp(tx, tz, 'loop ' + k);
  }
  // (4) 낚시터 데크 둘레 간접등(마당이 거의 데크라 남는 곳만): 데크 바깥 0.5m 띠에 낮은 정원등 (자리·돌·길은 비켜서)
  {
    const gx0 = DECK.x0 - 0.5, gx1 = DECK.x1 + 0.5, gz0 = DECK.z0 - 0.5, gz1 = DECK.z1 + 0.5, per = 2 * (gx1 - gx0 + gz1 - gz0);
    for (let i = 0; i < 16; i++) {
      let d = ((i + 0.3) / 16) * per, tx, tz;
      if (d < gx1 - gx0) { tx = gx0 + d; tz = gz0; } else if ((d -= gx1 - gx0) < gz1 - gz0) { tx = gx1; tz = gz0 + d; } else if ((d -= gz1 - gz0) < gx1 - gx0) { tx = gx1 - d; tz = gz1; } else { d -= gx1 - gx0; tx = gx0; tz = gz1 - d; }
      const p = lightSpot(tx, tz, RADIUS['@gardenLight'], { maxR: 0.35 });
      if (!p) continue;
      put('@gardenLight', p.x, p.z);
      LIGHTS.garden.push({ x: p.x, z: p.z, gx: p.x, gz: p.z, why: 'pond' });
    }
  }
  // (4-2) 공원 연못 둘레 정원등 + 연못가 구경 자리 옆 가로등
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * PI * 2 + 0.2;
    const tx = POND.x + Math.cos(a) * (POND.rx + 0.45), tz = POND.z + Math.sin(a) * (POND.rz + 0.45);
    const p = lightSpot(tx, tz, RADIUS['@gardenLight'], { maxR: 0.45 });
    if (!p) continue;
    put('@gardenLight', p.x, p.z);
    LIGHTS.garden.push({ x: p.x, z: p.z, gx: p.x, gz: p.z, why: 'park pond' });
  }
  {
    const ps = spots.filter((sp) => sp.id.startsWith('pond'));
    if (ps.length) {
      const cx = ps.reduce((t, sp) => t + sp.pos.x, 0) / ps.length, cz = ps.reduce((t, sp) => t + sp.pos.z, 0) / ps.length;
      const ox = cx - POND.x, oz = cz - POND.z, l = Math.hypot(ox, oz) || 1;
      streetLamp(cx + (ox / l) * 1.3, cz + (oz / l) * 1.3, 'park pond');
    }
  }
  // (5) 길 따라 라인 조명: 길 바닥 양 가장자리를 따라 이어진 빛 띠 (daylight.js 가 그림). half = 길 바닥 반폭
  LIGHTS.lines = [{ pts: LOOP, closed: true, half: 0.65 }, ...CONNECT.map((pts) => ({ pts, closed: false, half: 0.5 }))];

  // ── 통로 선 ────────────────────────────────────────────────
  const LINES = [
    // 왼쪽 날개
    [0.8, 1.0, 8.1, 1.0], [0.8, 6.0, 9.2, 6.0], [0.8, 11.0, 8.1, 11.0], [0.8, 16.0, 9.2, 16.0],
    [4.45, 1.0, 4.45, 19.2], [8.1, 1.0, 8.1, 16.0],
    [9.2, 1.0, 9.2, 19.2], // 왼쪽 복도
    // 본관 복도 + 토의실
    [0.8, 19.2, 31.2, 19.2],
    [0.8, 21.6, 5.5, 21.6], [0.8, 25.6, 5.5, 25.6], [0.8, 19.2, 0.8, 25.6], // 회의실 A
    [6.7, 21.6, 11.6, 21.6], [6.7, 25.6, 11.6, 25.6], [11.6, 19.2, 11.6, 25.6], // 회의실 B
    // 로비·대표실
    [13.5, 17.0, 13.5, 19.2], [19.4, 19.2, 19.4, 25.4], [15.15, 24.4, 19.4, 24.4],
    // 로비 서쪽 길: 결재판을 내려놓은 고양이가 줄을 거슬러 가지 않고 맨 앞 자리(16, 24.4)에서 한 칸 물러나(z 23.55) 서쪽으로 빠져나간다 (줄은 동쪽 x 19.4 에서 들어와 동쪽으로 늘어선다).
    // 보고 자리(15.15, 24.4)는 서쪽 길에서 바로 올라간다(줄 맨 앞을 지나지 않음). 둘째 줄(z 23.55, x 17.7~)은 동쪽 제 길로 들어온다 — 서쪽 길과는 잇지 않는다
    [12.9, 19.2, 12.9, 23.55], [12.9, 23.55, 16.0, 23.55], [15.15, 23.55, 15.15, 24.4], [16.0, 23.55, 16.0, 24.4], [17.7, 23.55, 19.4, 23.55],
    // 라운지: 대화 자리 앞, 창가 자리 앞
    [21.15, 19.2, 21.15, 24.2], [21.15, 24.2, 27.0, 24.2], [30.0, 19.2, 30.0, 23.2],
    // 오른쪽 날개
    [25.6, 1.0, 25.6, 19.2], [24.95, 1.0, 30.8, 1.0], [24.95, 4.7, 30.8, 4.7], [24.0, 9.0, 31.0, 9.0], [25.6, 17.6, 30.4, 17.6],
    [22.85, 7.0, 22.85, 19.2], // 오른쪽 복도
  ].map(([ax, az, bx, bz]) => ({ a: new V3(ax, 0, az), b: new V3(bx, 0, bz) }));
  LOOP.forEach((p, i) => LINES.push({ a: p, b: LOOP[(i + 1) % LOOP.length] }));
  CLOOP.forEach((p, i) => LINES.push({ a: p, b: CLOOP[(i + 1) % CLOOP.length] }));
  CONNECT.forEach((pts) => { for (let i = 1; i < pts.length; i++) LINES.push({ a: pts[i - 1], b: pts[i] }); });

  /**
   * 점 p 를 선분 l 위로 내린 가장 가까운 점.
   * @param {BABYLON.Vector3} p 점
   * @param {Line} l 선분
   * @returns {BABYLON.Vector3} 선분 위 가장 가까운 점
   */
  function project(p, l) {
    const ab = l.b.subtract(l.a);
    const t = Math.max(0, Math.min(1, V3.Dot(p.subtract(l.a), ab) / ab.lengthSquared()));
    return l.a.add(ab.scale(t));
  }
  /**
   * 모든 통로 선(LINES) 가운데 점 p 에 가장 가까운 선 위의 점 (y 는 무시하고 xz 평면 기준).
   * @param {BABYLON.Vector3} p 점
   * @returns {BABYLON.Vector3} 가장 가까운 통로 선 위 점
   * @see project
   */
  function nearestOnLines(p) {
    let best = null, bd = Infinity;
    for (const l of LINES) {
      const q = project(p, l);
      const d = V3.DistanceSquared(new V3(p.x, 0, p.z), q);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
  /**
   * 점 p 가 선분 l 위에 있는지 (거리 제곱 1e-6 미만).
   * @param {BABYLON.Vector3} p 점
   * @param {Line} l 선분
   * @returns {boolean} 위에 있으면 true
   */
  function onLine(p, l) { return V3.DistanceSquared(project(p, l), p) < 1e-6; }

  // 선 교차점: 끝점 + (세로선 x 가로선) 교차. 곡선 길은 끝점으로만 이어진다.
  const JUNCTIONS = [];
  for (const l of LINES) JUNCTIONS.push(l.a, l.b);
  /**
   * isV: 선분이 세로(x 고정)인지, isH: 가로(z 고정)인지 (오차 1e-9).
   * @param {Line} l 선분
   * @returns {boolean} 해당 방향이면 true
   */
  const isV = (l) => Math.abs(l.a.x - l.b.x) < 1e-9, isH = (l) => Math.abs(l.a.z - l.b.z) < 1e-9;
  for (let i = 0; i < LINES.length; i++) for (let j = i + 1; j < LINES.length; j++) {
    const a = LINES[i], b = LINES[j];
    let v = null, h = null;
    if (isV(a) && isH(b)) { v = a; h = b; } else if (isH(a) && isV(b)) { v = b; h = a; } else continue;
    const q = new V3(v.a.x, 0, h.a.z);
    if (onLine(q, v) && onLine(q, h)) JUNCTIONS.push(q);
  }
  // 선마다 올라가 있는 교차점 목록 (미리 계산해 경로 찾기를 가볍게)
  const LINE_NODES = LINES.map((l) => JUNCTIONS.filter((n) => onLine(n, l)));

  /**
   * from → to 경로 (점 목록, to 포함).
   * 두 점을 가장 가까운 통로 선에 붙인 뒤, 교차점·끝점을 마디로 한 그래프에서 다익스트라로 최단 경로를 찾는다.
   * 이어지는 길이 없으면 [to] 만 돌려준다.
   * @param {BABYLON.Vector3} from 출발점
   * @param {BABYLON.Vector3} to 도착점
   * @returns {BABYLON.Vector3[]} 경로 점 목록 (첫 점은 출발점을 통로에 붙인 점, 끝은 to)
   * @see nearestOnLines
   * @see onLine
   */
  function route(from, to) {
    const s = nearestOnLines(from), e = nearestOnLines(to);
    const nodes = [...JUNCTIONS, s, e];
    const S = nodes.length - 2, E = nodes.length - 1;
    const index = new Map(JUNCTIONS.map((n, i) => [n, i]));
    const adj = nodes.map(() => []);
    LINES.forEach((l, li) => {
      const on = LINE_NODES[li].map((n) => index.get(n));
      if (onLine(s, l)) on.push(S);
      if (onLine(e, l)) on.push(E);
      const dir = l.b.subtract(l.a);
      on.sort((i, j) => V3.Dot(nodes[i].subtract(l.a), dir) - V3.Dot(nodes[j].subtract(l.a), dir));
      for (let k = 1; k < on.length; k++) {
        const i = on[k - 1], j = on[k], w = V3.Distance(nodes[i], nodes[j]);
        adj[i].push([j, w]); adj[j].push([i, w]);
      }
    });
    const dist = nodes.map(() => Infinity), prev = nodes.map(() => -1), done = nodes.map(() => false);
    dist[S] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity || u === E) break;
      done[u] = true;
      for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    if (dist[E] === Infinity) return [to.clone()];
    const pts = [];
    for (let u = E; u >= 0; u = prev[u]) pts.unshift(nodes[u]);
    const out = [s.clone()];
    for (const p of pts) if (V3.DistanceSquared(out[out.length - 1], p) > 1e-6) out.push(p.clone());
    out.push(new V3(to.x, 0, to.z));
    return out;
  }

  // ── 직접 만드는 소품 ──────────────────────────────────────────
  /**
   * 바닥이 y 인 상자 하나를 만든다 (중심은 y + h / 2).
   * @param {BABYLON.Scene} scene 씬
   * @param {string} name 메시 이름
   * @param {number} w 가로(x)
   * @param {number} h 높이
   * @param {number} d 깊이(z)
   * @param {number} x 중심 x
   * @param {number} y 바닥 높이
   * @param {number} z 중심 z
   * @param {string} mat 팔레트 재질 이름
   * @param {Object} [opts] 재질 옵션 (P.mat 에 그대로 전달)
   * @returns {BABYLON.Mesh} 상자 메시
   */
  function boxAt(scene, name, w, h, d, x, y, z, mat, opts) {
    const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    m.position.set(x, y + h / 2, z);
    m.material = P.mat(scene, mat, opts);
    return m;
  }
  /**
   * 부품들을 한 메시로 합쳐 숨은 견본(템플릿)으로 만든다.
   * 부품이 하나면 변환을 정점에 구워 넣고, 여럿이면 MergeMeshes 로 합친다. 견본은 isVisible=false 이며 인스턴스로 쓴다.
   * @param {string} name 견본 이름
   * @param {BABYLON.Mesh[]} parts 합칠 부품
   * @returns {BABYLON.Mesh} 합친 견본
   */
  function merge(name, parts) {
    const m = parts.length === 1 ? parts[0] : BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (parts.length === 1) { m.bakeCurrentTransformIntoVertices(); m.rotationQuaternion = null; }
    m.name = name;
    m.isVisible = false;
    return m;
  }
  /**
   * 납작 음영(flat) 아이코 구를 만든다 (잎·돌·꽃 덩어리용).
   * @param {BABYLON.Scene} scene 씬
   * @param {number} r 반지름
   * @param {number} x 중심 x
   * @param {number} y 중심 y
   * @param {number} z 중심 z
   * @param {string} mat 팔레트 재질 이름
   * @param {number} [sub=1] 분할 수
   * @param {Object} [matOpts] 재질 옵션
   * @returns {BABYLON.Mesh} 구 메시
   */
  function ico(scene, r, x, y, z, mat, sub = 1, matOpts) {
    const f = BABYLON.MeshBuilder.CreateIcoSphere('ico', { radius: r, subdivisions: sub, flat: true }, scene);
    f.position.set(x, y, z);
    f.material = P.mat(scene, mat, matOpts);
    return f;
  }
  /**
   * 눌러 찌그러뜨린 돌 견본을 만든다.
   * @param {BABYLON.Scene} scene 씬
   * @param {string} name 견본 이름
   * @param {number[]} size 배율 [sx, sy, sz]
   * @param {string} mat 재질 이름
   * @returns {BABYLON.Mesh} 돌 견본
   * @see ico
   * @see merge
   */
  function rock(scene, name, [sx, sy, sz], mat) {
    const r = ico(scene, 0.5, 0, sy * 0.32, 0, mat);
    r.scaling.set(sx, sy, sz);
    return merge(name, [r]);
  }
  /**
   * 꽃밭 견본: 흙 원판(지름 0.9 m) 위에 꽃을 나선으로 흩는다.
   * 꽃은 공개 모델(Kenney Nature Kit flower_*, CC0 — assets/licenses/kenney-nature-kit): 보라·빨강·노랑 × 봉오리(A)·옆으로 핀(B)·활짝 핀(C).
   * 원본 줄기 밑동 0.05 단위는 흙 속에 묻히게 내린다.
   * @param {BABYLON.Scene} scene 씬
   * @param {string} name 견본 이름
   * @param {Array<?string>} kinds 나선 자리 순서대로 꽃 종류(예 'redA'), null 이면 그 자리는 비운다
   * @param {Object} [override] Kenney 재질 바꿔치기 표 (가을의 시든 색)
   * @returns {Promise<BABYLON.Mesh>} 꽃밭 견본
   * @see Kenney.get
   * @see merge
   */
  async function flowerBed(scene, name, kinds, override) {
    const soil = BABYLON.MeshBuilder.CreateCylinder('soil', { diameter: 0.9, height: 0.08, tessellation: 10 }, scene);
    soil.position.y = 0.04;
    soil.material = P.mat(scene, 'soil');
    const parts = [soil];
    const K = 0.6; // Kenney 배율(2) × 0.6 = 1.2: 꽃 폭 0.19~0.25 m, 높이 0.16~0.35 m
    for (let i = 0; i < kinds.length; i++) {
      if (!kinds[i]) continue;
      const a = i * 2.4, r = 0.08 + (i % 3) * 0.11;
      const f = (await Kenney.get(scene, 'flower_' + kinds[i], override)).clone(name + ':' + kinds[i]);
      f.isVisible = true;
      f.scaling.setAll(K);
      f.position.set(Math.cos(a) * r, 0.08 - 0.05 * Kenney.SCALE * K, Math.sin(a) * r);
      f.rotation.y = i * 1.7;
      f.computeWorldMatrix(true);
      // glb 메쉬와 면 방향 규칙(sideOrientation)이 다르면 합치기가 거부된다: 흙판의 감김 순서를 뒤집고 규칙을 맞춰 보이는 모습은 그대로 둔다
      if (soil.sideOrientation !== f.sideOrientation) { soil.flipFaces(false); soil.sideOrientation = f.sideOrientation; }
      // 정점 속성도 같아야 합쳐진다: 꽃 glb 에는 UV 가 없다(단색). 흙판도 단색이라 UV 를 지운다
      for (const k of soil.getVerticesDataKinds()) if (!f.isVerticesDataPresent(k)) soil.removeVerticesData(k);
      parts.push(f);
    }
    return merge(name, parts);
  }
  /**
   * 잎 나무 부품 (줄기 + 잎 덩어리 넷).
   * park = true: 공원 잎 나무 (잎 재질을 따로 둬서 계절마다 색을 바꾼다, weatherfx.js).
   * @param {BABYLON.Scene} scene 씬
   * @param {number} [s=1] 배율
   * @param {boolean} [park=false] 계절 잎 재질을 쓸지
   * @returns {BABYLON.Mesh[]} 부품 목록
   * @see ico
   */
  function treeParts(scene, s = 1, park = false) {
    const trunk = BABYLON.MeshBuilder.CreateCylinder('trunk', { diameterTop: 0.18 * s, diameterBottom: 0.26 * s, height: 1.6 * s, tessellation: 7 }, scene);
    trunk.position.y = 0.8 * s;
    trunk.material = P.mat(scene, 'trunk');
    const parts = [trunk];
    [[0, 2.1, 0, 1.9, 'leaf'], [0.45, 2.7, 0.1, 1.4, 'leafDark'], [-0.35, 2.9, -0.2, 1.3, 'leaf'], [0.05, 3.4, 0.05, 1.0, 'leafLight']]
      .forEach(([x, y, z, dia, mat]) => parts.push(ico(scene, (dia / 2) * s, x * s, y * s, z * s, mat, 1, park ? { tree: 1 } : undefined)));
    return parts;
  }
  /**
   * 겨울 나무: 줄기 + 가지 (잎 나무와 같은 키·자리, 계절에 따라 바꿔 켠다).
   * 큰 가지 5개를 위로 벌려 꽂고 가지마다 잔가지 둘을 붙인다.
   * @param {BABYLON.Scene} scene 씬
   * @returns {BABYLON.Mesh[]} 부품 목록
   */
  function bareTreeParts(scene) {
    const wood = P.mat(scene, 'trunk');
    /**
     * 한쪽 끝을 축으로 기울인 가지(원기둥) 하나를 만든다.
     * @param {number} len 길이
     * @param {number} d0 아래 지름
     * @param {number} d1 위 지름
     * @param {number} x 아래 끝 x
     * @param {number} y 아래 끝 y
     * @param {number} z 아래 끝 z
     * @param {number} rx x 축 기울기
     * @param {number} rz z 축 기울기
     * @returns {BABYLON.Mesh} 가지 메시
     */
    const cyl = (len, d0, d1, x, y, z, rx, rz) => {
      const c = BABYLON.MeshBuilder.CreateCylinder('br', { height: len, diameterTop: d1, diameterBottom: d0, tessellation: 6 }, scene);
      c.setPivotPoint(new BABYLON.Vector3(0, -len / 2, 0));
      c.position.set(x, y + len / 2, z);
      c.rotation.set(rx, 0, rz);
      c.bakeCurrentTransformIntoVertices();
      c.material = wood;
      return c;
    };
    const parts = [cyl(2.3, 0.26, 0.12, 0, 0, 0, 0, 0)];
    // 큰 가지 5개(위로 벌어짐) + 잔가지
    [[0.0, 0.55], [1.25, 0.6], [2.5, 0.5], [3.8, 0.62], [5.1, 0.52]].forEach(([a, tilt], i) => {
      const y0 = 1.35 + (i % 3) * 0.28, len = 1.25 - (i % 2) * 0.2;
      const rx = Math.sin(a) * tilt, rz = -Math.cos(a) * tilt;
      parts.push(cyl(len, 0.1, 0.035, 0, y0, 0, rx, rz));
      const ex = Math.sin(rz * -1) * len * 0.7, ez = Math.sin(rx) * len * 0.7; // 큰 가지 중간쯤에서 잔가지
      parts.push(cyl(0.6, 0.04, 0.015, ex * 0.8, y0 + len * 0.6, ez * 0.8, rx * 1.6, rz * 0.4));
      parts.push(cyl(0.5, 0.035, 0.012, ex * 0.8, y0 + len * 0.65, ez * 0.8, rx * 0.4, rz * 1.6));
    });
    parts.push(cyl(0.9, 0.08, 0.02, 0, 2.2, 0, 0.12, -0.08)); // 꼭대기
    return parts;
  }
  /**
   * 소나무 부품 (줄기 + 원뿔 넷).
   * @param {BABYLON.Scene} scene 씬
   * @param {number} [s=1] 배율
   * @returns {BABYLON.Mesh[]} 부품 목록
   */
  function pineParts(scene, s = 1) {
    const trunk = BABYLON.MeshBuilder.CreateCylinder('t', { diameterTop: 0.14 * s, diameterBottom: 0.22 * s, height: 1.0 * s, tessellation: 6 }, scene);
    trunk.position.y = 0.5 * s;
    trunk.material = P.mat(scene, 'trunk');
    const parts = [trunk];
    [[1.0, 1.9, 1.8], [1.7, 1.5, 1.4], [2.35, 1.1, 1.1], [2.9, 0.6, 0.8]].forEach(([y, d, h]) => {
      const c = BABYLON.MeshBuilder.CreateCylinder('c', { diameterTop: 0, diameterBottom: d * s, height: h * s, tessellation: 7 }, scene);
      c.position.y = (y + h / 2 - 0.3) * s;
      c.material = P.mat(scene, 'pine');
      parts.push(c);
    });
    return parts;
  }
  /**
   * 연못 견본: 모래 둘레 + 물 + 연잎 + 갈대.
   * opts.reeds: 갈대 수(남서쪽 물가부터), opts.lilies: 연잎 수 — 낚시터 잔교 자리를 비울 때 줄인다.
   * @param {BABYLON.Scene} scene 씬
   * @param {string} name 견본 이름
   * @param {number} rx x 반지름
   * @param {number} rz z 반지름
   * @param {{reeds?:number, lilies?:number}} [opts] reeds 기본 9, lilies 기본 4
   * @returns {BABYLON.Mesh} 연못 견본
   * @see merge
   */
  function pondTemplate(scene, name, rx, rz, { reeds = 9, lilies = 4, rect = false } = {}) {
    const parts = [];
    /**
     * 납작한 타원 원판을 만들어 부품 목록에 넣는다.
     * @param {string} n 이름
     * @param {number} sx x 배율
     * @param {number} sz z 배율
     * @param {number} y 높이
     * @param {string} mat 재질 이름
     * @param {Object} [opts] 재질 옵션
     * @returns {void}
     */
    const disc = (n, sx, sz, y, mat, opts) => {
      let d;
      if (rect) { // 사각 연못: 얇은 상자 (물 높이는 윗면 기준으로 맞춘다)
        d = BABYLON.MeshBuilder.CreateBox(n, { width: sx * 2, height: 0.004, depth: sz * 2 }, scene);
        d.position.y = y - 0.002;
      } else {
        d = BABYLON.MeshBuilder.CreateDisc(n, { radius: 1, tessellation: 40 }, scene);
        d.rotation.x = PI / 2;
        d.scaling.set(sx, sz, 1);
        d.position.y = y;
      }
      d.material = P.mat(scene, mat, opts);
      parts.push(d);
    };
    if (!rect) disc('shore', rx * 1.12, rz * 1.12, 0.006, 'sand'); // 사각 연못은 데크가 둘러서 모래톱 없음
    disc('water', rx, rz, 0.014, 'water', { emissive: 0.15 });
    [[-0.38, 0.25, 0.35], [0.28, -0.3, 0.28], [0.5, 0.17, 0.22], [-0.1, -0.45, 0.25]].slice(0, lilies).forEach(([x, z, r]) => {
      const lp = BABYLON.MeshBuilder.CreateDisc('lily', { radius: r, tessellation: 9, arc: 0.88 }, scene);
      lp.rotation.x = PI / 2;
      lp.position.set(x * rx, 0.022, z * rz);
      lp.material = P.mat(scene, 'leaf', { lily: 1 }); // 연못이 얼면 숨긴다 (weatherfx.js)
      parts.push(lp);
    });
    for (let i = 0; i < reeds; i++) {
      let a = 3.6 + i * 0.13, x = Math.cos(a) * rx * 0.97, z = Math.sin(a) * rz * 0.97;
      if (rect) { const sd = i % 2 ? 1 : -1, k = i >> 1; x = sd * (rx - 0.3 - k * 0.15); z = rz - 0.3 - (k % 2) * 0.14; } // 북쪽 두 모서리 무리
      const h = 0.6 + (i % 3) * 0.2;
      const reed = BABYLON.MeshBuilder.CreateCylinder('reed', { diameterTop: 0.02, diameterBottom: 0.05, height: h, tessellation: 4 }, scene);
      reed.position.set(x + (i % 2) * 0.12, h / 2, z);
      reed.material = P.mat(scene, 'leafDark');
      parts.push(reed);
    }
    return merge(name, parts);
  }
  /**
   * 직접 만드는 소품 견본 공장: 모델 이름('@...') → async (scene) => 견본 메시.
   * create 가 items 에서 쓰인 이름마다 한 번씩 호출해 견본을 만들고, 가구는 이 견본의 인스턴스로 놓는다.
   * 책상·대표 책상 소품·벽걸이·나무·돌·조명·잔교 주변 소품 등이 들어 있다.
   * @type {Object<string, function(BABYLON.Scene):Promise<BABYLON.Mesh>>}
   * @see create
   * @see merge
   * @see boxAt
   */
  const CUSTOM = {
    /**
     * 책상 + 꺼진 모니터 + 키보드 + 마우스 (Kenney 모델 합성).
     * 꺼진 화면색은 office.js 가 켜질 때 화면판으로 덮는다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 책상 견본 (Kenney.compose 결과)
     */
    async '@bossDesk'(scene) {
      // 책상판만 가로(x)로 1.6배 — 화면·키보드·마우스는 원래 크기 그대로 가운데에 둔다 (합칠 때 면 방향이 안 뒤집히게 복제본의 배율을 정점에 굽는다)
      const top = (await Kenney.get(scene, 'desk')).clone('tpl:bossDesk:top');
      top.isVisible = true; top.scaling.x = 1.6;
      const part = async (model, at, override) => { const m = (await Kenney.get(scene, model, override)).clone('tpl:bossDesk:' + model); m.isVisible = true; m.position = new V3(at[0], at[1], at[2]); return m; };
      const parts = [top, await part('computerScreen', [0, 0.77, 0.16], { metal: ['screenOff'] }), await part('computerKeyboard', [-0.05, 0.77, -0.14]), await part('computerMouse', [0.32, 0.77, -0.14])];
      parts.forEach((m) => m.computeWorldMatrix(true));
      const merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
      merged.name = 'tpl:bossDesk';
      merged.isVisible = false;
      return merged;
    },
    /**
     * 일반 업무 책상: 책상판 + 꺼진 모니터 + 키보드 + 마우스.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 책상 견본
     */
    async '@desk'(scene) {
      return Kenney.compose(scene, 'tpl:desk', [
        { model: 'desk' },
        // 꺼진 화면색 (켜지면 office.js 가 화면판을 덮음)
        { model: 'computerScreen', at: [0, 0.77, 0.16], override: { metal: ['screenOff'] } },
        { model: 'computerKeyboard', at: [-0.05, 0.77, -0.14] },
        { model: 'computerMouse', at: [0.32, 0.77, -0.14] },
      ]);
    },
    /**
     * 사무용 관절 스탠드: 받침 · 두 마디 팔 · 고개 숙인 원뿔 갓(앞 = -Z, 앉는 사람 쪽을 비춤).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 스탠드 견본
     * @see merge
     */
    async '@deskLamp'(scene) {
      const parts = [];
      const up = new V3(0, 1, 0);
      /**
       * 원기둥(세로 +Y)을 방향 dir 로 눕히는 회전을 준다.
       * @param {BABYLON.Mesh} m 돌릴 메시
       * @param {BABYLON.Vector3} dir 향할 방향
       * @returns {void}
       */
      const orient = (m, dir) => {
        const d = dir.normalize(), axis = V3.Cross(up, d), ang = Math.acos(Math.max(-1, Math.min(1, V3.Dot(up, d))));
        if (axis.lengthSquared() > 1e-8) m.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis.normalize(), ang);
      };
      /**
       * 두 점 a, b 를 잇는 가는 막대를 만들어 부품에 넣는다.
       * @param {BABYLON.Vector3} a 시작점
       * @param {BABYLON.Vector3} b 끝점
       * @param {number} d 지름
       * @param {string} mat 재질 이름
       * @returns {void}
       */
      const rod = (a, b, d, mat) => {
        const len = V3.Distance(a, b);
        const c = BABYLON.MeshBuilder.CreateCylinder('lampRod', { height: len, diameter: d, tessellation: 8 }, scene);
        c.position = V3.Lerp(a, b, 0.5); orient(c, b.subtract(a)); c.material = P.mat(scene, mat);
        parts.push(c);
      };
      /**
       * 관절 구를 p 에 만들어 부품에 넣는다.
       * @param {BABYLON.Vector3} p 위치
       * @param {number} d 지름
       * @returns {void}
       */
      const ball = (p, d) => { const s = BABYLON.MeshBuilder.CreateSphere('lampJoint', { diameter: d, segments: 6 }, scene); s.position = p; s.material = P.mat(scene, 'lampBody'); parts.push(s); };
      const b0 = BABYLON.MeshBuilder.CreateCylinder('lampBase', { height: 0.022, diameter: 0.13, tessellation: 16 }, scene);
      b0.position.y = 0.011; b0.material = P.mat(scene, 'lampBody'); parts.push(b0);
      const p0 = new V3(0, 0.02, 0.02), A = new V3(0, 0.31, 0.07), B = new V3(0, 0.37, -0.2);
      rod(p0, A, 0.016, 'lampBody'); ball(A, 0.032); rod(A, B, 0.014, 'lampBody'); ball(B, 0.028);
      // 갓: 아래·앞쪽을 향함
      const dir = new V3(0, -1, -0.45).normalize();
      const shade = BABYLON.MeshBuilder.CreateCylinder('lampShade', { height: 0.11, diameterTop: 0.04, diameterBottom: 0.12, tessellation: 16 }, scene);
      shade.position = B.add(dir.scale(0.06)); orient(shade, dir.scale(-1)); shade.material = P.mat(scene, 'lampBody'); parts.push(shade);
      const bulb = BABYLON.MeshBuilder.CreateCylinder('lampBulb', { height: 0.006, diameter: 0.1, tessellation: 16 }, scene);
      bulb.position = B.add(dir.scale(0.116)); orient(bulb, dir.scale(-1)); bulb.material = P.mat(scene, 'lampBulb', { emissive: 0.9 }); parts.push(bulb);
      return merge('tpl:deskLamp', parts);
    },
    /**
     * 대표 책상 위 소품: 명패 · 도장판 · 도장 · 서류함 (Kenney 모델과 면 방향 설정이 달라 따로 합친다).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 소품 견본
     */
    async '@bossProps'(scene) {
      const extra = [
        boxAt(scene, 'plate', 0.42, 0.11, 0.05, -0.25, 0.77, 0.33, 'nameplate'),
        boxAt(scene, 'plateTxt', 0.3, 0.05, 0.01, -0.25, 0.8, 0.36, 'gold'),
        boxAt(scene, 'pad', 0.16, 0.025, 0.12, -0.45, 0.77, -0.1, 'stampPad'),
        boxAt(scene, 'stampBase', 0.07, 0.04, 0.07, -0.25, 0.77, -0.12, 'stampRed'),
        boxAt(scene, 'stampGrip', 0.04, 0.09, 0.04, -0.25, 0.81, -0.12, 'woodDark'),
        boxAt(scene, 'tray', 0.36, 0.05, 0.28, -0.5, 0.77, 0.12, 'metal'),
      ];
      return merge('tpl:bossProps', extra);
    },
    /**
     * 벽걸이 액자 (하늘 · 언덕 · 해).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 액자 견본
     */
    async '@wallArt'(scene) {
      return merge('tpl:wallArt', [
        boxAt(scene, 'frame', 1.6, 0.95, 0.04, 0, 0, 0, 'white'),
        boxAt(scene, 'sky', 1.46, 0.5, 0.01, 0, 0.4, -0.025, 'art'),
        boxAt(scene, 'hill', 1.46, 0.36, 0.01, 0, 0.07, -0.026, 'leafLight'),
        boxAt(scene, 'sun', 0.16, 0.16, 0.01, 0.45, 0.62, -0.027, 'flowerYellow'),
      ]);
    },
    /**
     * 고양이 발판: 화이트보드 쪽(+Z)이 높은 2단 나무 계단, 폭 1.5.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 발판 견본
     */
    async '@catStep'(scene) {
      // 고양이 발판: 화이트보드 쪽(+Z)이 높은 2단 나무 계단, 폭 1.5
      return merge('tpl:catStep', [
        boxAt(scene, 'lo', 1.5, 0.17, 0.62, 0, 0, 0, 'wood'),
        boxAt(scene, 'hi', 1.5, 0.17, 0.32, 0, 0.17, 0.15, 'wood'),
        boxAt(scene, 'edge1', 1.5, 0.012, 0.03, 0, 0.17, -0.3, 'woodDark'),
        boxAt(scene, 'edge2', 1.5, 0.012, 0.03, 0, 0.34, 0.0, 'woodDark'),
      ]);
    },
    /**
     * 화이트보드 (판 + 틀 + 포스트잇 + 다리).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 화이트보드 견본
     */
    async '@whiteboard'(scene) {
      return merge('tpl:whiteboard', [
        boxAt(scene, 'board', 2.2, 1.1, 0.05, 0, 0.9, 0, 'white'),
        boxAt(scene, 'frame', 2.3, 0.06, 0.08, 0, 0.87, 0, 'metal'),
        boxAt(scene, 'note1', 0.3, 0.3, 0.01, -0.6, 1.5, -0.03, 'book3'),
        boxAt(scene, 'note2', 0.3, 0.3, 0.01, -0.2, 1.3, -0.03, 'book1'),
        boxAt(scene, 'note3', 0.3, 0.3, 0.01, 0.5, 1.45, -0.03, 'book4'),
        boxAt(scene, 'line', 0.9, 0.02, 0.01, 0.4, 1.15, -0.03, 'fabricBlue'),
        boxAt(scene, 'legL', 0.05, 0.9, 0.05, -1.0, 0, 0, 'metal'),
        boxAt(scene, 'legR', 0.05, 0.9, 0.05, 1.0, 0, 0, 'metal'),
      ]);
    },
    /**
     * 라운지 큰 화분 나무 (화분 + 흙 + 0.8배 잎 나무).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 화분 나무 견본
     * @see treeParts
     */
    async '@bigTree'(scene) {
      const planter = BABYLON.MeshBuilder.CreateCylinder('planter', { diameter: 1.7, height: 0.45, tessellation: 24 }, scene);
      planter.position.y = 0.225;
      planter.material = P.mat(scene, 'wood');
      const soil = BABYLON.MeshBuilder.CreateCylinder('soil', { diameter: 1.5, height: 0.02, tessellation: 24 }, scene);
      soil.position.y = 0.45;
      soil.material = P.mat(scene, 'woodDark');
      const tree = treeParts(scene, 0.8);
      tree.forEach((m) => { m.position.y += 0.45; });
      return merge('tpl:bigTree', [planter, soil, ...tree]);
    },
    /**
     * 공원 잎 나무 (계절 잎 재질).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 나무 견본
     * @see treeParts
     */
    async '@tree'(scene) { return merge('tpl:tree', treeParts(scene, 1, true)); },
    /**
     * 겨울 나무 (줄기 + 가지).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 나무 견본
     * @see bareTreeParts
     */
    async '@treeBare'(scene) { return merge('tpl:treeBare', bareTreeParts(scene)); },
    /**
     * 소나무.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 소나무 견본
     * @see pineParts
     */
    async '@pine'(scene) { return merge('tpl:pine', pineParts(scene)); },
    /**
     * 덤불 (잎 덩어리 셋).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 덤불 견본
     * @see ico
     */
    async '@bush'(scene) {
      return merge('tpl:bush', [[0, 0.35, 0, 0.8, 'leaf'], [0.35, 0.3, 0.1, 0.6, 'leafDark'], [-0.3, 0.28, -0.05, 0.55, 'leafLight']]
        .map(([x, y, z, d, mat]) => ico(scene, d / 2, x, y, z, mat)));
    },
    /**
     * 공원·중정 벤치 (앉는 판 + 등받이 + 다리 넷).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 벤치 견본
     */
    async '@bench'(scene) {
      return merge('tpl:bench', [
        boxAt(scene, 'seat', 1.4, 0.06, 0.45, 0, 0.42, 0, 'wood'),
        boxAt(scene, 'back', 1.4, 0.32, 0.05, 0, 0.55, 0.22, 'wood'),
        boxAt(scene, 'l1', 0.06, 0.42, 0.4, -0.6, 0, 0, 'dark'),
        boxAt(scene, 'l2', 0.06, 0.42, 0.4, 0.6, 0, 0, 'dark'),
        boxAt(scene, 'l3', 0.06, 0.5, 0.06, -0.6, 0.42, 0.22, 'dark'),
        boxAt(scene, 'l4', 0.06, 0.5, 0.06, 0.6, 0.42, 0.22, 'dark'),
      ]);
    },
    /**
     * 큰 돌 (밝은 색).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 돌 견본
     * @see rock
     */
    async '@rock1'(scene) { return rock(scene, 'tpl:rock1', [1.0, 0.55, 0.8], 'stone'); },
    /**
     * 작은 돌 (어두운 색).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 돌 견본
     * @see rock
     */
    async '@rock2'(scene) { return rock(scene, 'tpl:rock2', [0.7, 0.45, 0.9], 'stoneDark'); },
    /**
     * 꽃밭(봄): 튤립이 봉오리·옆으로 핀·활짝 핀 것이 섞여 핀다. 계절마다 다른 견본이 같은 자리에 겹쳐 놓이고 weatherfx.js 가 하나만 켠다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 꽃밭 견본
     * @see flowerBed
     */
    async '@flowers'(scene) { return flowerBed(scene, 'tpl:flowers', ['redA', 'yellowC', 'purpleB', 'yellowA', 'purpleC', 'redB', 'purpleA', 'redC', 'yellowB']); },
    /**
     * 꽃밭(여름): 활짝 핀 꽃(C)·옆으로 핀 꽃(B)만.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 꽃밭 견본
     * @see flowerBed
     */
    async '@flowersSummer'(scene) { return flowerBed(scene, 'tpl:flowersSummer', ['redC', 'yellowC', 'purpleC', 'yellowB', 'redB', 'purpleC', 'redC', 'yellowC', 'purpleB']); },
    /**
     * 꽃밭(가을): 꽃잎이 바래고 잎이 누렇게 시든 꽃 다섯 송이만 남는다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 꽃밭 견본
     * @see flowerBed
     */
    async '@flowersAutumn'(scene) {
      return flowerBed(scene, 'tpl:flowersAutumn', ['redB', null, 'yellowA', null, 'purpleB', null, 'redA', null, 'yellowB'],
        { grass: ['leafWilt'], colorPurple: ['flowerWilt'], colorRed: ['flowerWilt'], colorYellow: ['flowerWiltLight'], colorWhite: ['flowerWiltLight'] });
    },
    /**
     * 꽃밭(겨울): 꽃이 지고 흙만 남는다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 꽃밭 견본
     * @see flowerBed
     */
    async '@flowersWinter'(scene) { return flowerBed(scene, 'tpl:flowersWinter', []); },
    /**
     * 공원 연못 견본 (POND 크기).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 연못 견본
     * @see pondTemplate
     */
    async '@pondPark'(scene) { return pondTemplate(scene, 'tpl:pondPark', POND.rx, POND.rz); },
    /**
     * 중정 연못 견본 (CPOND 크기, 남쪽 잔교 자리를 위해 갈대·연잎을 줄임).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 연못 견본
     * @see pondTemplate
     */
    async '@pondCourt'(scene) { return pondTemplate(scene, 'tpl:pondCourt', CPOND.rx, CPOND.rz, { reeds: 8, lilies: 3, rect: true }); }, // 사각 연못 (모래톱 없음, 갈대는 북쪽 모서리)
    /**
     * 분수대 견본 (받침 돌 · 물 담긴 아래 못 · 기둥 · 윗 그릇 · 꼭대기 분출구). 물줄기·물보라는 create 가 따로 움직인다.
     * 물은 연못과 같은 재질이라 얼면 같이 얼음색이 된다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 분수대 견본
     * @see FOUNT
     */
    async '@fountain'(scene) {
      const parts = [];
      const add = (m, y, mat, opts) => { m.position.y = y; m.material = P.mat(scene, mat, opts); parts.push(m); return m; };
      const cyl = (o) => BABYLON.MeshBuilder.CreateCylinder('f', o, scene);
      add(cyl({ diameter: 2.0, height: 0.26, tessellation: 14 }), 0.13, 'stoneDark');
      add(cyl({ diameter: 1.86, height: 0.02, tessellation: 14 }), 0.27, 'water', { emissive: 0.15 });
      add(BABYLON.MeshBuilder.CreateTorus('f', { diameter: 2.0, thickness: 0.2, tessellation: 14 }, scene), 0.27, 'stone');
      add(cyl({ diameter: 0.4, height: 0.75, tessellation: 8 }), 0.65, 'stone');
      add(cyl({ diameterTop: 1.1, diameterBottom: 0.35, height: 0.22, tessellation: 10 }), 1.1, 'stone');
      add(cyl({ diameter: 0.96, height: 0.02, tessellation: 10 }), 1.2, 'water', { emissive: 0.15 });
      add(cyl({ diameter: 0.12, height: 0.3, tessellation: 6 }), 1.36, 'stoneDark');
      return merge('tpl:fountain', parts);
    },
    /**
     * 공원 가로등 (받침 · 기둥 · 길 쪽 팔 · 등 머리).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 가로등 견본
     */
    async '@streetLamp'(scene) {
      // 공원 가로등: 받침 · 가는 기둥 · 길 쪽(-Z)으로 뻗은 팔 · 아래를 비추는 등 머리 (밤 불빛은 daylight.js)
      const pole = BABYLON.MeshBuilder.CreateCylinder('pole', { height: 3.0, diameter: 0.09, tessellation: 10 }, scene);
      pole.position.y = 1.6; pole.material = P.mat(scene, 'lampBody');
      const base = BABYLON.MeshBuilder.CreateCylinder('base', { height: 0.2, diameterTop: 0.2, diameterBottom: 0.3, tessellation: 10 }, scene);
      base.position.y = 0.1; base.material = P.mat(scene, 'lampBody');
      const arm = boxAt(scene, 'arm', 0.06, 0.06, 0.5, 0, 3.02, -0.22, 'lampBody');
      const head = boxAt(scene, 'head', 0.3, 0.1, 0.36, 0, 2.94, -0.45, 'lampBody');
      const bulb = boxAt(scene, 'bulb', 0.24, 0.03, 0.3, 0, 2.915, -0.45, 'lampBulb', { emissive: 0.9 });
      return merge('tpl:streetLamp', [pole, base, arm, head, bulb]);
    },
    /**
     * 낮은 정원등 (기둥 + 빛나는 머리 + 갓).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 정원등 견본
     */
    async '@gardenLight'(scene) {
      // 낮은 정원등(볼라드): 가는 기둥 + 빛나는 머리 + 갓
      const post = BABYLON.MeshBuilder.CreateCylinder('gpost', { height: 0.42, diameter: 0.1, tessellation: 10 }, scene);
      post.position.y = 0.21; post.material = P.mat(scene, 'lampBody');
      const glow = BABYLON.MeshBuilder.CreateCylinder('gglow', { height: 0.1, diameter: 0.12, tessellation: 10 }, scene);
      glow.position.y = 0.47; glow.material = P.mat(scene, 'lampBulb', { emissive: 0.9 });
      const cap = BABYLON.MeshBuilder.CreateCylinder('gcap', { height: 0.04, diameter: 0.18, tessellation: 10 }, scene);
      cap.position.y = 0.54; cap.material = P.mat(scene, 'lampBody');
      return merge('tpl:gardenLight', [post, glow, cap]);
    },
    /**
     * 바닥 투광등 (작은 통 + 빛나는 면).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 투광등 견본
     */
    async '@upLight'(scene) {
      // 바닥 투광등: 땅에 박힌 작은 통, 빛나는 면이 비추는 쪽(-Z)으로 비스듬히
      const body = boxAt(scene, 'ubody', 0.16, 0.1, 0.16, 0, 0, 0, 'lampBody');
      const face = boxAt(scene, 'uface', 0.12, 0.02, 0.12, 0, 0.1, 0, 'lampBulb', { emissive: 0.9 });
      return merge('tpl:upLight', [body, face]);
    },
    /**
     * 정원 장식 돌 등.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 석등 견본
     */
    async '@lantern'(scene) {
      // 돌 등 (정원 장식)
      return merge('tpl:lantern', [
        boxAt(scene, 'b', 0.5, 0.15, 0.5, 0, 0, 0, 'stoneDark'),
        boxAt(scene, 'p', 0.18, 0.7, 0.18, 0, 0.15, 0, 'stone'),
        boxAt(scene, 'l', 0.38, 0.3, 0.38, 0, 0.85, 0, 'lampShade', { emissive: 0.5 }),
        boxAt(scene, 'r', 0.6, 0.1, 0.6, 0, 1.15, 0, 'stoneDark'),
        boxAt(scene, 't', 0.2, 0.15, 0.2, 0, 1.25, 0, 'stone'),
      ]);
    },
    /**
     * 뒷산: 낮은 언덕 + 침엽수·잎 나무 숲 (26그루를 결정적으로 흩는다).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 뒷산 견본
     * @see pineParts
     * @see treeParts
     */
    async '@mound'(scene) {
      // 뒷산: 낮은 언덕 + 침엽수 숲
      const hill = BABYLON.MeshBuilder.CreateSphere('hill', { diameter: 1, segments: 16 }, scene);
      hill.scaling.set(52, 7, 16);
      hill.position.y = -1.6;
      hill.material = P.mat(scene, 'hill');
      const parts = [hill];
      for (let i = 0; i < 26; i++) {
        const x = -22 + (i * 37) % 44 + ((i * 13) % 5) * 0.4, z = -4 + ((i * 7) % 9);
        const h = 1.85 - ((x / 26) ** 2 + ((z - 0.5) / 8) ** 2) * 1.6;
        if (h < 0.2) continue;
        const sz = 0.9 + (i % 4) * 0.15;
        const tp = i % 3 ? pineParts(scene, sz) : treeParts(scene, sz, true); // 잎 나무는 계절 잎 재질(가을 단풍)
        if (!(i % 3)) {
          // 잎 나무에는 겨울 가지도 같이 심어 둔다: 전용 재질(trunk + bare)이라 겨울에만 보이고, 잎 재질은 겨울에 투명해진다 (weatherfx 가 계절마다 맞춘다).
          // 뒷산은 통짜 메시라 공원 나무처럼 나무째 켜고 끌 수 없어서 재질로 바꾼다
          const wood = P.mat(scene, 'trunk', { bare: 1 });
          for (const b of bareTreeParts(scene)) { b.scaling.setAll(sz); b.bakeCurrentTransformIntoVertices(); b.material = wood; tp.push(b); }
        }
        tp.forEach((m) => { m.position.x += x; m.position.z += z; m.position.y += h; });
        parts.push(...tp);
      }
      return merge('tpl:mound', parts);
    },
    /**
     * 캣타워 (기둥 셋 + 판 넷 + 침대). 간식 점수로 해금되기 전엔 숨긴다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 캣타워 견본
     */
    async '@catTower'(scene) {
      const parts = [];
      /**
       * 기둥 하나를 부품에 넣는다.
       * @param {number} x 중심 x
       * @param {number} z 중심 z
       * @param {number} h 높이
       * @returns {void}
       */
      const post = (x, z, h) => { const c = BABYLON.MeshBuilder.CreateCylinder('post', { diameter: 0.14, height: h, tessellation: 10 }, scene); c.position.set(x, h / 2, z); c.material = P.mat(scene, 'rope'); parts.push(c); };
      /**
       * 판 하나를 부품에 넣는다.
       * @param {number} x 중심 x
       * @param {number} y 바닥 높이
       * @param {number} z 중심 z
       * @param {number} w 한 변 길이
       * @returns {void}
       */
      const deck = (x, y, z, w) => parts.push(boxAt(scene, 'deck', w, 0.06, w, x, y, z, 'fabricCream'));
      post(-0.25, 0, 1.0); post(0.25, 0.1, 1.6); post(0, -0.2, 0.6);
      deck(0, 0, 0, 0.9); deck(-0.25, 1.0, 0, 0.55); deck(0.25, 1.6, 0.1, 0.5); deck(0, 0.6, -0.2, 0.45);
      const bed = BABYLON.MeshBuilder.CreateTorus('bed', { diameter: 0.4, thickness: 0.12, tessellation: 16 }, scene);
      bed.position.set(0.25, 1.68, 0.1);
      bed.material = P.mat(scene, 'flowerPink');
      parts.push(bed);
      return merge('tpl:catTower', parts);
    },
    /**
     * 공원 고양이 조각상 (받침 + 몸 + 머리 + 귀 + 발 + 꼬리).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 조각상 견본
     */
    async '@statue'(scene) {
      const parts = [];
      /**
       * 메시에 재질을 입혀 부품에 넣고 돌려준다.
       * @param {BABYLON.Mesh} m 메시
       * @param {string} [mat='statue'] 재질 이름
       * @returns {BABYLON.Mesh} 같은 메시 m
       */
      const add = (m, mat = 'statue') => { m.material = P.mat(scene, mat); parts.push(m); return m; };
      add(BABYLON.MeshBuilder.CreateCylinder('base', { diameter: 1.5, height: 0.25, tessellation: 24 }, scene), 'stoneDark').position.y = 0.125;
      add(BABYLON.MeshBuilder.CreateCylinder('plinth', { diameter: 1.0, height: 0.8, tessellation: 8 }, scene), 'stone').position.y = 0.65;
      const body = add(BABYLON.MeshBuilder.CreateSphere('body', { diameter: 1, segments: 10 }, scene));
      body.scaling.set(0.62, 0.8, 0.55);
      body.position.y = 1.43;
      const head = add(BABYLON.MeshBuilder.CreateSphere('head', { diameter: 1, segments: 10 }, scene));
      head.scaling.set(0.62, 0.52, 0.5);
      head.position.set(0, 2.05, -0.05);
      for (const s2 of [-1, 1]) {
        const ear = add(BABYLON.MeshBuilder.CreateCylinder('ear', { diameterTop: 0, diameterBottom: 0.24, height: 0.26, tessellation: 4 }, scene));
        ear.position.set(s2 * 0.19, 2.33, -0.04);
        ear.rotation.z = -s2 * 0.3;
        const paw = add(BABYLON.MeshBuilder.CreateSphere('paw', { diameter: 1, segments: 6 }, scene));
        paw.scaling.set(0.16, 0.12, 0.2);
        paw.position.set(s2 * 0.14, 1.1, -0.26);
      }
      const tail = add(BABYLON.MeshBuilder.CreateTorus('tail', { diameter: 0.7, thickness: 0.1, tessellation: 16 }, scene));
      tail.position.set(0.18, 1.12, 0.12);
      tail.scaling.set(1, 1, 0.8);
      return merge('tpl:statue', parts);
    },
    /**
     * 배달 상자 (골판지 + 테이프).
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 상자 견본
     */
    async '@box'(scene) {
      return merge('tpl:box', [boxAt(scene, 'b', 0.2, 0.17, 0.16, 0, 0, 0, 'cardboard'), boxAt(scene, 't', 0.205, 0.02, 0.04, 0, 0.16, 0, 'tape')]);
    },
    /**
     * 책상 위에 눕혀 쌓는 결재판 (나무판 + 서류 + 위쪽 집게, 두께 0.018). 집게는 대표 반대쪽(-Z)이라 대표가 서류 윗부분을 거꾸로 보지 않는다.
     * @param {BABYLON.Scene} scene 씬
     * @returns {Promise<BABYLON.Mesh>} 결재판 견본
     */
    async '@board'(scene) {
      return merge('tpl:board', [
        boxAt(scene, 'bb', 0.2, 0.012, 0.26, 0, 0, 0, 'woodDark'),
        boxAt(scene, 'bp', 0.17, 0.006, 0.21, 0, 0.012, 0.005, 'white'),
        boxAt(scene, 'bc', 0.08, 0.018, 0.03, 0, 0.0, -0.115, 'metal'),
      ]);
    },
  };

  /**
   * 바닥에 까는 띠 (길). pts 를 따라 폭 width.
   * 각 점에서 진행 방향의 수직으로 좌우 정점을 만들고 이웃 점끼리 삼각형 둘로 잇는다. closed 면 끝과 처음을 잇는다.
   * @param {BABYLON.Scene} scene 씬
   * @param {string} name 메시 이름
   * @param {BABYLON.Vector3[]} pts 중심선 점들
   * @param {number} width 띠 폭
   * @param {boolean} closed 닫힌 고리인지
   * @param {string} mat 재질 이름
   * @param {number} y 높이
   * @returns {BABYLON.Mesh} 띠 메시 (양면)
   */
  function ribbon(scene, name, pts, width, closed, mat, y) {
    const pos = [], idx = [], nrm = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const p = pts[i], h = width / 2;
      pos.push(p.x - tz * h, y, p.z + tx * h, p.x + tz * h, y, p.z - tx * h);
      nrm.push(0, 1, 0, 0, 1, 0);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const a0 = i * 2, a1 = i * 2 + 1, b0 = j * 2, b1 = j * 2 + 1;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
    const m = new BABYLON.Mesh(name, scene);
    const vd = new BABYLON.VertexData();
    vd.positions = pos; vd.indices = idx; vd.normals = nrm;
    vd.applyToMesh(m);
    m.material = P.mat(scene, mat, { twoSided: true });
    return m;
  }

  // ── 건물 골격 ────────────────────────────────────────────────
  /**
   * 건물 골격을 만든다: 지면 · 바닥판 · 구역 바닥 · 외벽(창문 줄) · 유리벽 · 유리 가벽 · 자동문 · 낚시터 잔교와 낚싯대 · 정문 차양 · 공원 길.
   * 만든 메시는 root 의 자식이 되고, 그림자를 던질 것은 casters 에 모은다. 문짝은 DOOR_LEAVES, 낚싯대는 RODS 에 등록한다.
   * @param {BABYLON.Scene} scene 씬
   * @param {BABYLON.TransformNode} root 부모 노드
   * @param {BABYLON.Mesh[]} casters 그림자를 던질 메시 목록 (여기에 추가됨)
   * @returns {void}
   * @see boxAt
   * @see ribbon
   * @see placeRod
   */
  function shell(scene, root, casters) {
    /**
     * 메시를 root 에 붙이고 그림자 받기·고정 행렬을 켠 뒤 cast 면 casters 에 넣는다.
     * @param {BABYLON.Mesh} m 메시
     * @param {boolean} [cast=true] 그림자를 던지는지
     * @returns {BABYLON.Mesh} 같은 메시 m
     */
    const add = (m, cast = true) => { m.parent = root; m.receiveShadows = true; m.freezeWorldMatrix(); if (cast) casters.push(m); return m; };
    const { x1, zb, z1, lw, rw, wallH, wallT, lowH } = B;
    const T = wallT;
    // 지면
    const g = BABYLON.MeshBuilder.CreateGround('ground', { width: 220, height: 220 }, scene);
    g.position.set(16, -0.03, 10);
    g.material = P.mat(scene, 'lawn');
    add(g, false);
    // 건물 바닥판 (ㄷ자 세 덩어리)
    add(boxAt(scene, 'slabL', lw, 0.25, zb, lw / 2, -0.25, zb / 2, 'corridor'), false);
    add(boxAt(scene, 'slabR', x1 - rw, 0.25, zb, (rw + x1) / 2, -0.25, zb / 2, 'corridor'), false);
    add(boxAt(scene, 'slabB', x1, 0.25, z1 - zb, x1 / 2, -0.25, (zb + z1) / 2, 'corridor'), false);
    // 구역 바닥
    /**
     * 구역 바닥(얇은 상자)을 xa,za ~ xb,zb2 범위로 깐다.
     * @param {string} n 이름
     * @param {number} xa 시작 x
     * @param {number} za 시작 z
     * @param {number} xb 끝 x
     * @param {number} zb2 끝 z
     * @param {string} mat 재질 이름
     * @returns {BABYLON.Mesh} 바닥 메시
     */
    const zone = (n, xa, za, xb, zb2, mat) => add(boxAt(scene, n, xb - xa, 0.012, zb2 - za, (xa + xb) / 2, 0, (za + zb2) / 2, mat), false);
    zone('fWork', 0.2, 0.2, 8.5, 17.9, 'floor');
    zone('fMeet', 0.2, 20.1, 12, 27.8, 'floorMeet');
    zone('fLobby', 12, 20.1, 20.7, 27.8, 'floorCeo');
    zone('fLounge', 20.7, 20.1, 31.8, 27.8, 'floorLounge');
    // 본관 복도: 데코타일 (회의실·로비·라운지 앞을 잇는 띠)
    {
      const xa = 0.2, xb = 31.8, za = 18.1, zb2 = 20.1;
      const m = boxAt(scene, 'fHall', xb - xa, 0.014, zb2 - za, (xa + xb) / 2, 0, (za + zb2) / 2, 'tile');
      m.material = P.tiles(scene, 'hall', xb - xa, zb2 - za, { tile: 0.6 });
      add(m, false);
      // 양쪽 날개의 중정 쪽 복도 (ㄷ자)
      for (const [n, a, b] of [['hallL', 8.7, 9.8], ['hallR', 22.2, 23.5]]) {
        const w = boxAt(scene, n, b - a, 0.014, 17.9, (a + b) / 2, 0, 0.2 + 17.9 / 2, 'tile');
        w.material = P.tiles(scene, n, b - a, 17.9, { tile: 0.6, seed: n.length * 3 });
        add(w, false);
      }
    }
    zone('fCafe', 23.7, 8.4, 31.8, 17.9, 'tile');
    zone('fLib', 23.7, 0.2, 31.8, 8.2, 'floor');
    // 중정 바닥: 잔디 위 디딤 마당
    zone('fCourt', 10.1, 13.6, 21.9, 17.9, 'courtPave');

    // 높은 외벽(창문 줄): 북쪽 z=28, 동쪽 x=32
    /**
     * 높은 외벽의 창문 줄을 만든다: 아래 띠 · 윗띠 · 창 사이 기둥 · 유리.
     * along(종류, 길이, 높이, 바닥 높이, 가운데) 콜백이 벽 방향에 맞는 상자를 실제로 만든다.
     * @param {number} len 벽 길이
     * @param {function(string, number, number, number, number):void} along 상자 생성 콜백 (종류 'band'|'top'|'pier'|'glass', 길이, 높이, 바닥 y, 벽을 따른 가운데)
     * @returns {void}
     */
    const win = (len, along) => {
      const n = Math.floor(len / 4);
      const sill = 0.85, head = 2.35, ww = 2.6;
      along('band', len, sill, 0, len / 2);
      along('top', len, wallH - head, head, len / 2);
      for (let i = 0; i <= n; i++) {
        const c0 = i === 0 ? 0 : i * 4 - (4 - ww) / 2;
        const c1 = i === n ? len : i * 4 + (4 - ww) / 2;
        if (c1 > c0) along('pier', c1 - c0, head - sill, sill, (c0 + c1) / 2);
      }
      for (let i = 0; i < n; i++) along('glass', ww, head - sill, sill, i * 4 + 2);
    };
    const glassOpt = { alpha: 0.35 };
    win(x1, (k, l, h, y, c) => add(boxAt(scene, 'wn' + k, l, h, k === 'glass' ? 0.04 : T, c, y, z1 - T / 2, k === 'glass' ? 'glass' : 'wall', k === 'glass' ? glassOpt : undefined), k !== 'glass'));
    win(z1, (k, l, h, y, c) => add(boxAt(scene, 'we' + k, k === 'glass' ? 0.04 : T, h, l, x1 - T / 2, y, c, k === 'glass' ? 'glass' : 'wall', k === 'glass' ? glassOpt : undefined), k !== 'glass'));
    add(boxAt(scene, 'capN', x1, 0.03, T + 0.02, x1 / 2, wallH, z1 - T / 2, 'wallTop'), false);
    add(boxAt(scene, 'capE', T + 0.02, 0.03, z1, x1 - T / 2, wallH, z1 / 2, 'wallTop'), false);
    // 낮은 외벽: 서쪽 x=0, 날개 남쪽 끝
    add(boxAt(scene, 'lowW', T, lowH, z1, T / 2, 0, z1 / 2, 'wallBase'));
    add(boxAt(scene, 'lowSL', lw, lowH, T, lw / 2, 0, T / 2, 'wallBase'));
    add(boxAt(scene, 'lowSR', x1 - rw, lowH, T, (rw + x1) / 2, 0, T / 2, 'wallBase'));
    // 중정 쪽 유리벽 (낮은 턱 + 유리 + 세로틀), 문 자리는 비움
    /**
     * 중정 쪽 유리벽(낮은 턱 + 유리 + 윗틀 + 세로틀)을 만든다. 문 자리(gaps)는 비운다.
     * @param {('x'|'z')} axis 'x' = x 고정 벽, 'z' = z 고정 벽
     * @param {number} fixed 고정 좌표
     * @param {number} from 벽 시작
     * @param {number} to 벽 끝
     * @param {number[][]} gaps 문틈 [g0, g1] 목록
     * @returns {void}
     */
    const curtain = (axis, fixed, from, to, gaps) => {
      const segs = [];
      let cur = from;
      for (const [g0, g1] of gaps) { segs.push([cur, g0]); cur = g1; }
      segs.push([cur, to]);
      for (const [a, b] of segs) {
        const L = b - a, c = (a + b) / 2;
        if (L <= 0.01) continue;
        const sx = axis === 'x' ? T : L, sz = axis === 'x' ? L : T;
        const px = axis === 'x' ? fixed : c, pz = axis === 'x' ? c : fixed;
        add(boxAt(scene, 'cl', sx, 0.35, sz, px, 0, pz, 'wallBase'));
        add(boxAt(scene, 'cg', axis === 'x' ? 0.03 : L, wallH - 0.35, axis === 'x' ? L : 0.03, px, 0.35, pz, 'glass', { alpha: 0.12 }), false);
        add(boxAt(scene, 'ct', axis === 'x' ? 0.08 : L, 0.06, axis === 'x' ? L : 0.08, px, wallH - 0.06, pz, 'frame'), false);
        const n = Math.max(1, Math.round(L / 1.5));
        for (let i = 0; i <= n; i++) {
          const t = a + (L * i) / n;
          add(boxAt(scene, 'cm', 0.06, wallH, 0.06, axis === 'x' ? fixed : t, 0, axis === 'x' ? t : fixed, 'frame'), false);
        }
      }
    };
    curtain('x', lw - T / 2, 0, zb, [[10.3, 11.7]]); // 왼쪽 날개 동쪽 (옆문 z=11)
    curtain('x', rw + T / 2, 0, zb, [[6.3, 7.7]]); // 오른쪽 날개 서쪽 (옆문 z=7)
    curtain('z', zb + T / 2, lw, rw, [[12.8, 14.2]]); // 본관 남쪽 (정문 x=13.5)
    // 실내 유리 가벽: 바닥 틀 + 유리 + 윗 틀 + 세로틀
    for (const w of PARTS) {
      for (const [a, b] of pieces(w.from, w.to, w.gaps)) {
        const L = b - a, c = (a + b) / 2;
        const px = w.axis === 'x' ? w.at : c, pz = w.axis === 'x' ? c : w.at;
        /**
         * 유리 가벽 조각에 맞는 상자 (벽 방향에 따라 두께 th 와 길이 L 의 축이 바뀐다).
         * @param {string} n 이름
         * @param {number} th 두께
         * @param {number} h 높이
         * @param {number} y 바닥 높이
         * @param {string} mat 재질 이름
         * @param {Object} [opt] 재질 옵션
         * @returns {BABYLON.Mesh} 상자 메시
         */
        const box = (n, th, h, y, mat, opt) => boxAt(scene, n, w.axis === 'x' ? th : L, h, w.axis === 'x' ? L : th, px, y, pz, mat, opt);
        add(box('pb', 0.08, 0.06, 0, 'frame'), false);
        add(box('pg', 0.03, wallH - 0.12, 0.06, 'glass', { alpha: 0.14 }), false);
        add(box('pt', 0.08, 0.06, wallH - 0.06, 'frame'), false);
        const n = Math.max(1, Math.round(L / 1.6));
        for (let i = 0; i <= n; i++) {
          const t = a + (L * i) / n;
          add(boxAt(scene, 'pm', 0.06, wallH, 0.06, w.axis === 'x' ? w.at : t, 0, w.axis === 'x' ? t : w.at, 'frame'), false);
        }
      }
    }
    // 자동 미닫이 유리문: 고양이가 다가오면 열린다. 양쪽에 벽이 있으면 가운데서 갈라지고, 한쪽만 있으면 그쪽으로 겹쳐 들어간다
    for (const d of DOORS) {
      const L = d.g1 - d.g0, lw = L / 2 + 0.04, h = wallH - 0.1;
      const low = d.g0 - d.from > 0.5, high = d.to - d.g1 > 0.5;
      const leaves = [0, 1].map(() => {
        const g = boxAt(scene, 'dg', d.axis === 'x' ? 0.03 : lw, h - 0.08, d.axis === 'x' ? lw : 0.03, 0, 0.04, 0, 'glass', { alpha: 0.22 });
        const f = boxAt(scene, 'df', d.axis === 'x' ? 0.05 : lw, 0.06, d.axis === 'x' ? lw : 0.05, 0, 0, 0, 'frame');
        const f2 = boxAt(scene, 'df', d.axis === 'x' ? 0.05 : lw, 0.06, d.axis === 'x' ? lw : 0.05, 0, h - 0.06, 0, 'frame');
        const node = new BABYLON.TransformNode('doorLeaf', scene);
        node.parent = root;
        for (const m of [g, f, f2]) { m.parent = node; m.isPickable = false; m.receiveShadows = true; }
        return node;
      });
      // 닫힌 자리(문틈 안 좌·우 절반)와 열린 자리
      const closed = [d.g0 + L / 4, d.g1 - L / 4];
      const lo = d.g0 - L / 4 + 0.05, hi = d.g1 + L / 4 - 0.05;
      const open = low && high ? [lo, hi] : high ? [hi - L / 2 + 0.1, hi] : [lo, lo + L / 2 - 0.1];
      const off = low && high ? [0.07, 0.07] : [0.07, 0.12]; // 한쪽으로 겹칠 땐 두 짝이 앞뒤로 비켜 선다
      DOOR_LEAVES.push({ d, leaves, closed, open, off, k: 0 });
    }

    // 낚시터 데크: 연못(사각)을 두른 나무 판 (폭 1.2m, 윗면 0.05m) + 물가 돌 테두리 + 판 이음선
    {
      const px0 = CPOND.x - CPOND.rx, px1 = CPOND.x + CPOND.rx, pz0 = CPOND.z - CPOND.rz, pz1 = CPOND.z + CPOND.rz;
      const seams = [];
      const slab = (x0, z0, x1, z1, alongX) => {
        add(boxAt(scene, 'pier', x1 - x0, 0.05, z1 - z0, (x0 + x1) / 2, 0, (z0 + z1) / 2, 'wood'));
        const len = alongX ? x1 - x0 : z1 - z0;
        for (let i = 1; i < Math.floor(len / 0.4); i++) {
          const t = i * 0.4;
          seams.push(alongX ? boxAt(scene, 'plank', 0.025, 0.004, z1 - z0, x0 + t, 0.05, (z0 + z1) / 2, 'woodDark') : boxAt(scene, 'plank', x1 - x0, 0.004, 0.025, (x0 + x1) / 2, 0.05, z0 + t, 'woodDark'));
        }
      };
      slab(DECK.x0, DECK.z0, DECK.x1, pz0, true); // 남
      slab(DECK.x0, pz1, DECK.x1, DECK.z1, true); // 북
      slab(DECK.x0, pz0, px0, pz1, false); // 서
      slab(px1, pz0, DECK.x1, pz1, false); // 동
      const seam = BABYLON.Mesh.MergeMeshes(seams, true, true);
      seam.name = 'plank'; add(seam, false);
      // 잔교: 북쪽 데크에서 연못 쪽으로 내민 한 줄 (판 + 가로 이음선)
      {
        const th = Math.atan2(PIER.d.x, PIER.d.z), cx = (PIER.a.x + PIER.b.x) / 2, cz = (PIER.a.z + PIER.b.z) / 2;
        const pm = boxAt(scene, 'pier', PIER.w, 0.05, PIER.L, cx, 0, cz, 'wood');
        pm.rotation.y = th; add(pm);
        const ps = [];
        for (let i = 1; i < Math.floor(PIER.L / 0.4); i++) {
          const t = -PIER.L / 2 + i * 0.4, q = boxAt(scene, 'plank', PIER.w, 0.004, 0.025, 0, 0.05, 0, 'woodDark');
          q.position.set(cx + PIER.d.x * t, 0.052, cz + PIER.d.z * t); q.rotation.y = th; ps.push(q);
        }
        const pseam = BABYLON.Mesh.MergeMeshes(ps, true, true);
        pseam.name = 'plank'; add(pseam, false);
      }
      // 낚시 보트·통·물고기: 공개 모델(Kenney Watercraft Kit·Survival Kit, CC0 — assets/licenses/kenney-*)을 불러와 놓는다. 물결에 맞춰 살짝 흔들린다 (BOATFX)
      {
        /**
         * 소품 모델(models/props/<file>.glb)을 불러와 parent 아래에 놓는다 (비동기 — 늦게 와도 자리는 이미 정해져 있다).
         * @param {string} file 파일 이름(확장자 제외)
         * @param {BABYLON.TransformNode} parent 붙일 노드
         * @param {number} k 크기 배율
         * @param {{x?:number, y?:number, z?:number, ry?:number, rz?:number, hide?:RegExp}} [o] 놓을 자리·돌림(rad)·숨길 노드 이름
         * @returns {void}
         */
        const loadProp = (file, parent, k, o = {}) => {
          BABYLON.LoadAssetContainerAsync('models/props/' + file + '.glb', scene).then((c) => {
            if (scene.isDisposed) { c.dispose(); return; } // 창이 닫힌 뒤에 왔다
            c.addAllToScene();
            const hold = new BABYLON.TransformNode(file, scene);
            hold.parent = parent; hold.position.set(o.x || 0, o.y || 0, o.z || 0); hold.rotation.set(0, o.ry || 0, o.rz || 0); hold.scaling.setAll(k);
            c.meshes[0].parent = hold;
            for (const m of c.meshes) {
              m.isPickable = false;
              if (o.hide && o.hide.test(m.name)) { m.setEnabled(false); continue; }
              if (m.getTotalVertices && m.getTotalVertices() > 0) { m.receiveShadows = true; if (LATE.shadows) LATE.shadows.addShadowCaster(m); else casters.push(m); } // 그림자: 사무실이 다 만들어진 뒤에 왔으면 바로, 아니면 목록에 넣어 둔다
            }
          }, (e) => console.warn('소품 모델을 불러오지 못했습니다: ' + file, e && e.message));
        };
        const bn = new BABYLON.TransformNode('boat', scene);
        bn.parent = root; bn.position.set(BOAT.x, 0, BOAT.z); bn.rotation.y = BOAT.rotY;
        // 노 젓는 작은 배 (원본 선체 길이 2.38m → 1.58m, 노까지 모양 그대로). 물에 살짝 잠기게 내린다
        loadProp('boat_row', bn, (BOAT.hl * 2) / 2.38, { y: -0.03 });
        BOATFX.node = bn;
        // 통: 잔교 끝 가까이 놓은 양동이 (물이 담기고 잡은 물고기 두 마리가 꼬리를 내밀고 있다)
        const bk = new BABYLON.TransformNode('bucket', scene);
        bk.parent = root; bk.position.set(BUCKET.x, 0.05, BUCKET.z);
        loadProp('bucket', bk, 2.1);
        const bw = BABYLON.MeshBuilder.CreateCylinder('bucketWater', { diameter: 0.25, height: 0.01, tessellation: 10 }, scene);
        bw.material = P.mat(scene, 'water', { alpha: 0.85, emissive: 0.3 }); bw.parent = bk; bw.position.y = 0.3; bw.isPickable = false;
        loadProp('fish', bk, 1.05, { x: -0.04, y: 0.2, z: 0.02, ry: 0.5, rz: -1.15 });
        loadProp('fish', bk, 0.9, { x: 0.05, y: 0.21, z: -0.03, ry: -2.2, rz: -1.3 });
      }
      // 테두리 돌 (물과 데크 사이, 윗면 0.1m)
      for (const [w, d, x, z] of [[px1 - px0 + 0.2, 0.1, CPOND.x, pz0 - 0.05], [px1 - px0 + 0.2, 0.1, CPOND.x, pz1 + 0.05], [0.1, pz1 - pz0, px0 - 0.05, CPOND.z], [0.1, pz1 - pz0, px1 + 0.05, CPOND.z]]) add(boxAt(scene, 'pier', w, 0.05, d, x, 0.05, z, 'stone'));
    }
    // 분수 물줄기: 꼭대기 분출구에서 솟는 물기둥 + 튀는 물방울. 움직임은 FOUNT 효과가 맡는다
    // 연못이 얼면 분수도 언다: 방울은 숨기고, 물기둥은 얼음 기둥으로 굳고, 그릇 가장자리에 고드름이 달린다
    {
      const wm = P.mat(scene, 'water', { alpha: 0.6, emissive: 0.4 });
      const col = BABYLON.MeshBuilder.CreateCylinder('fountainJet', { diameterTop: 0.03, diameterBottom: 0.08, height: 0.6, tessellation: 5 }, scene);
      col.material = wm; col.parent = root; col.isPickable = false;
      col.position.set(CPOND.x, 1.8, CPOND.z);
      FOUNT.col = col;
      FOUNT.water = wm;
      const im = wm.clone('fountainIce'); // 얼음: 물보다 희고 덜 비친다
      im.diffuseColor = new BABYLON.Color3(0.88, 0.94, 0.99); im.emissiveColor = new BABYLON.Color3(0.3, 0.34, 0.38); im.alpha = 0.92;
      FOUNT.iceMat = im;
      // 고드름: 그릇 가장자리(반지름 0.55, 높이 1.2)에 길이가 제각각인 뿔 14개, 꼭대기 분출구 둘레에 짧은 것 5개
      for (let i = 0; i < 19; i++) {
        const top = i >= 14, k = top ? i - 14 : i, n = top ? 5 : 14;
        const len = top ? 0.14 + (k % 2) * 0.06 : 0.22 + ((k * 7) % 5) * 0.07, r = top ? 0.07 : 0.55, y = top ? 1.52 : 1.2;
        const ic = BABYLON.MeshBuilder.CreateCylinder('fountainIce', { diameterTop: top ? 0.035 : 0.06, diameterBottom: 0.004, height: len, tessellation: 5 }, scene);
        const a = (k / n) * Math.PI * 2 + (top ? 0.4 : 0.15 * (k % 3));
        ic.material = im; ic.parent = root; ic.isPickable = false;
        ic.position.set(CPOND.x + Math.cos(a) * r, y - len / 2, CPOND.z + Math.sin(a) * r);
        ic.setEnabled(false);
        FOUNT.ice.push(ic);
      }
      // 언 못: 아래 못·윗 그릇의 물 위를 덮는 얼음판
      for (const [d, y] of [[1.84, 0.283], [0.95, 1.213]]) {
        const ic = BABYLON.MeshBuilder.CreateCylinder('fountainIce', { diameter: d, height: 0.012, tessellation: 14 }, scene);
        ic.material = im; ic.parent = root; ic.isPickable = false;
        ic.position.set(CPOND.x, y, CPOND.z);
        ic.setEnabled(false);
        FOUNT.ice.push(ic);
      }
      // 방울 종류: 위 못에 떨어지는 안쪽 방울 · 그릇 가장자리에서 아래 못으로 흘러내리는 바깥 방울
      for (let i = 0; i < 26; i++) {
        const inner = i < 10, n = inner ? 10 : 16, k = inner ? i : i - 10;
        const m = BABYLON.MeshBuilder.CreateIcoSphere('fountainJet', { radius: inner ? 0.045 : 0.05, subdivisions: 1, flat: true }, scene);
        m.material = wm; m.parent = root; m.isPickable = false;
        FOUNT.drops.push(m);
        FOUNT.meta.push(inner ? { y0: 1.5, r0: 0, vr: 0.25 + (k % 3) * 0.1, vy: 0.9, ph: k / n, ang: k * 2.4 } : { y0: 1.2, r0: 0.55, vr: 0.35, vy: 0.3, ph: k / n, ang: k * 2.4 + 1 });
      }
    }
    // 낚싯대: 자리에 고양이가 앉아 있을 때만 보인다 (대 + 줄 + 찌)
    for (const s of FISH) {
      const node = new BABYLON.TransformNode('rod', scene);
      node.parent = root;
      node.position.copyFrom(s.pos);
      node.rotation.y = s.rotY;
      const rod = BABYLON.MeshBuilder.CreateCylinder('rodPole', { height: 1.3, diameterTop: 0.012, diameterBottom: 0.03, tessellation: 6 }, scene);
      rod.material = P.mat(scene, 'woodDark');
      rod.parent = node;
      // 대·줄·찌의 자리는 낚시하는 고양이의 두 앞발(cat.fishRod, catmodel)을 따라 매 프레임 놓는다 — 처음엔 기본 자리
      const V = BABYLON.Vector3;
      const line = BABYLON.MeshBuilder.CreateCylinder('rodLine', { height: 1, diameter: 0.006, tessellation: 4 }, scene);
      line.material = P.mat(scene, 'frame');
      line.parent = node;
      const bob = BABYLON.MeshBuilder.CreateSphere('bobber', { diameter: 0.07, segments: 6 }, scene);
      bob.material = P.mat(scene, 'stampRed');
      bob.parent = node;
      for (const m of [rod, line, bob]) m.isPickable = false;
      node.setEnabled(false);
      const entry = { s, node, rod, line, bob, t: Math.random() * 6 };
      placeRod(entry, new V(-0.03, 0.28, -0.2), new V(0.18, Math.sin(0.6), -Math.cos(0.6)).normalize());
      RODS.push(entry);
    }

    // 정문 표시: 차양 + 발판
    add(boxAt(scene, 'canopy', 1.9, 0.06, 0.9, 13.5, 2.6, 17.55, 'frame'), false);
    add(boxAt(scene, 'mat', 1.6, 0.012, 1.0, 13.5, 0.005, 17.3, 'rugBoss'), false);

    // 공원 길 (테두리 + 흙길), 중정 길, 연결 길
    add(ribbon(scene, 'loopEdge', LOOP, 1.6, true, 'pathEdge', -0.024), false);
    add(ribbon(scene, 'loop', LOOP, 1.3, true, 'path', -0.018), false);
    CONNECT.forEach((pts, i) => {
      add(ribbon(scene, 'conE' + i, pts, 1.3, false, 'pathEdge', -0.021), false);
      add(ribbon(scene, 'con' + i, pts, 1.0, false, 'path', -0.015), false);
    });
  }

  // ── 자리 오가기: 경로 + 앉기·일어서기 연출 ─────────────────────
  const instances = [];
  const obstacles = [];
  const foot = []; // 발자국: { n, name, layer, cx, cz, 사각형(ox, oz, hx, hz, cs, sn, corners) 또는 원(r) }

  /**
   * fromSpot(지금 앉아 있는 자리, 없으면 null)에서 pos 를 거쳐 to 자리 앞까지의 경로.
   * fromSpot 이 있으면 그 via 를 거꾸로 걸어 나와 통로로 나오고, 통로 위에서 route 로 목표의 첫 경유점까지 가며, 나머지 경유점을 이어 붙인다.
   * @param {(Spot|null)} fromSpot 지금 있는 자리 (없으면 null)
   * @param {BABYLON.Vector3} pos fromSpot 이 없을 때의 출발점
   * @param {{pos:BABYLON.Vector3, via?:BABYLON.Vector3[]}} to 목표 자리 (Spot 또는 {pos})
   * @returns {BABYLON.Vector3[]} 경로 점 목록
   * @see route
   */
  function pathTo(fromSpot, pos, to) {
    const pts = [];
    let start = pos;
    if (fromSpot && fromSpot.via) {
      const rev = fromSpot.via.slice().reverse();
      pts.push(...rev.map((p) => p.clone()));
      start = rev[rev.length - 1];
    }
    const target = to.via ? to.via[0] : to.pos;
    pts.push(...route(start, target));
    if (to.via) pts.push(...to.via.slice(1).map((p) => p.clone()));
    return pts;
  }

  // 짧은 보간 애니메이션
  const tweens = [];
  /**
   * 짧은 보간 애니메이션을 등록한다. update 가 dur 초 동안 step(0~1 완화된 값)을 부르고 끝나면 done 을 부른다.
   * @param {number} dur 길이(초)
   * @param {function(number):void} step 진행 콜백 (smoothstep 으로 완화된 0~1)
   * @param {function():void} [done] 끝난 뒤 콜백
   * @returns {void}
   * @see update
   */
  function tween(dur, step, done) { tweens.push({ t: 0, dur, step, done }); }
  /**
   * 매 프레임 갱신 효과 목록. 각 항목은 (dt, movers) 를 받는다 (낚싯대·자동문·연기).
   * @type {Array<function(number, Cat[]=):void>}
   */
  const effects = []; // 연기 등 매 프레임 갱신 효과 (dt, movers)
  /**
   * 문짝 상태 목록 (shell 이 채우고 자동문 효과가 갱신한다).
   * @type {DoorLeafEntry[]}
   */
  const DOOR_LEAVES = []; // { d, leaves, closed, open, off, k }
  /**
   * 낚싯대 목록 (shell 이 채우고 낚싯대 효과가 갱신한다).
   * @type {RodEntry[]}
   */
  const RODS = []; // 낚싯대 { s, node, rod, line, bob, t }
  const LATE = { shadows: null }; // 늦게 불러온 소품 모델(보트·통)이 쓸 그림자 생성기 (create 끝에서 채움)
  const BOATFX = { node: null, t: 0 }; // 낚시 보트 흔들림: 보트 노드 · 시간
  const FOUNT = { col: null, drops: [], meta: [], t: 0, ice: [], water: null, iceMat: null, frozen: null }; // 분수 물줄기: 기둥 · 방울들 · 방울 궤적 값 · 얼었을 때 고드름·재질
  /**
   * 대 놓기: 자리 기준 좌표의 뒤끝 b·방향 d → 대(길이 1.3)·끝에서 내려오는 줄·물 위 찌.
   * @param {RodEntry} r 낚싯대 묶음
   * @param {BABYLON.Vector3} b 대 뒤끝 (자리 기준 좌표)
   * @param {BABYLON.Vector3} d 대 방향 단위 벡터
   * @returns {void}
   */
  function placeRod(r, b, d) {
    const V = BABYLON.Vector3;
    const cr = V.Cross(V.Up(), d);
    r.rod.rotationQuaternion = new BABYLON.Quaternion(cr.x, cr.y, cr.z, 1 + V.Dot(V.Up(), d)).normalize(); // 위(+Y) → 대 방향
    r.rod.position.copyFrom(b.add(d.scale(0.65)));
    const tip = b.add(d.scale(1.3));
    r.line.scaling.y = Math.max(0.01, tip.y);
    r.line.position.set(tip.x, tip.y / 2, tip.z);
    r.bob.position.x = tip.x; r.bob.position.z = tip.z;
  }
  /**
   * 낚싯대 효과: 연못이 얼지 않았고 자리에 앉은 고양이가 있을 때만 낚싯대를 보이고 두 앞발 따라 대를 옮기며 찌를 출렁인다.
   * 자리 taken 의 고양이가 그 자리 0.8m 안에 sit 자세로 있을 때만 켠다. 떠난 고양이는 fishing 을 해제한다.
   * @param {number} dt 지난 시간(초)
   * @param {Cat[]} [movers] 움직이는 고양이들
   * @see placeRod
   */
  // 분수: 방울마다 포물선(올라갔다 떨어짐)을 돌고, 기둥은 출렁이며 솟는다. 얼면 방울을 숨기고 기둥은 얼음 기둥으로 굳히며 고드름을 단다
  effects.push((dt) => {
    if (!FOUNT.col) return;
    FOUNT.t += dt;
    const on = !pondFrozen;
    if (FOUNT.frozen !== pondFrozen) {
      FOUNT.frozen = pondFrozen;
      FOUNT.drops.forEach((m) => m.setEnabled(on));
      FOUNT.ice.forEach((m) => m.setEnabled(!on));
      FOUNT.col.material = on ? FOUNT.water : FOUNT.iceMat;
      FOUNT.col.scaling.set(on ? 1 : 1.5, on ? 1 : 0.8, on ? 1 : 1.5); // 얼음 기둥은 굵고 조금 낮다
      FOUNT.col.position.y = on ? 1.8 : 1.74;
    }
    if (!on) return;
    FOUNT.col.scaling.y = 0.85 + Math.sin(FOUNT.t * 5) * 0.15;
    FOUNT.drops.forEach((m, i) => {
      const d = FOUNT.meta[i], g = 6, T = (d.vy + Math.sqrt(d.vy * d.vy + 4 * (g / 2) * (d.y0 - (d.y0 > 1.3 ? 1.22 : 0.28)))) / g; // 수면에 닿는 시간
      const u = (FOUNT.t * 0.9 / T + d.ph) % 1, tau = u * T;
      const r = d.r0 + d.vr * tau;
      m.position.set(CPOND.x + Math.cos(d.ang) * r, d.y0 + d.vy * tau - (g / 2) * tau * tau, CPOND.z + Math.sin(d.ang) * r);
    });
  });
  // 보트 흔들림: 연못이 얼지 않았을 때만 물결에 맞춰 아주 살짝 (앉은 고양이는 따라 움직이지 않을 만큼만). 얼면 제자리에서 멈춘다
  effects.push((dt) => {
    const b = BOATFX.node;
    if (!b) return;
    if (pondFrozen) { b.rotation.x = b.rotation.z = 0; b.position.y = 0; return; }
    BOATFX.t += dt;
    b.rotation.z = Math.sin(BOATFX.t * 1.1) * 0.012; b.rotation.x = Math.sin(BOATFX.t * 0.8 + 1) * 0.008; b.position.y = Math.sin(BOATFX.t * 1.6) * 0.006;
  });
  effects.push((dt, movers) => {
    for (const r of RODS) {
      // 자리에는 고양이 id 가 들어 있다(demo reserve). 그 고양이가 이 자리에 실제로 앉아 있을 때만 낚싯대를 든다
      const c = r.s.taken && movers ? movers.find((m) => m.id === r.s.taken) : null;
      const on = !pondFrozen && !!c && c.pose === 'sit' && Math.hypot(c.root.position.x - r.s.pos.x, c.root.position.z - r.s.pos.z) < 0.8;
      if (r.node.isEnabled() !== on) r.node.setEnabled(on);
      if (r.cat && r.cat !== c) r.cat.fishing = false; // 떠난 고양이는 낚시 자세 해제
      r.cat = c;
      if (c) c.fishing = on; // 팔 자세(catmodel)가 읽는다
      if (on && c.fishRod) { // 두 앞발 가운데로 대를 옮긴다 (월드 → 자리 기준)
        const inv = BABYLON.Matrix.Invert(r.node.computeWorldMatrix(true));
        placeRod(r, BABYLON.Vector3.TransformCoordinates(c.fishRod.bottom, inv), BABYLON.Vector3.TransformNormal(c.fishRod.dir, inv).normalize());
      }
      if (on) { r.t += dt; r.bob.position.y = 0.03 + Math.sin(r.t * 2.2) * 0.012 - (Math.sin(r.t * 0.37) > 0.97 ? 0.04 : 0); }
    }
  });
  /**
   * 자동문 효과: 고양이가 문 가운데 1.5m 안에 있으면 열리고 없으면 닫힌다 (열림 정도 k 를 smoothstep 으로 문짝 위치에 반영).
   * @param {number} dt 지난 시간(초)
   * @param {Cat[]} [movers] 움직이는 고양이들
   */
  effects.push((dt, movers) => {
    for (const D of DOOR_LEAVES) {
      const { d } = D;
      const cx = d.axis === 'x' ? d.at : (d.g0 + d.g1) / 2, cz = d.axis === 'x' ? (d.g0 + d.g1) / 2 : d.at;
      let near = false;
      if (movers) for (const m of movers) { const p = m.root.position; if (Math.hypot(p.x - cx, p.z - cz) < 1.5) { near = true; break; } }
      D.k = near ? Math.min(1, D.k + dt * 3.5) : Math.max(0, D.k - dt * 2);
      const e = D.k * D.k * (3 - 2 * D.k);
      D.leaves.forEach((n, i) => {
        const t = D.closed[i] + (D.open[i] - D.closed[i]) * e;
        if (d.axis === 'x') n.position.set(d.at + D.off[i], 0, t); else n.position.set(t, 0, d.at + D.off[i]);
      });
    }
  });
  /**
   * 매 프레임 호출: 진행 중인 tween 을 한 걸음 진행해 끝난 것은 제거(done 호출)하고, 모든 효과를 갱신한다.
   * @param {number} dt 지난 시간(초)
   * @param {Cat[]} [movers] 움직이는 고양이들
   * @returns {void}
   * @see tween
   */
  function update(dt, movers) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const w = tweens[i];
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      w.step(k * k * (3 - 2 * k));
      if (k >= 1) { tweens.splice(i, 1); if (w.done) w.done(); }
    }
    for (const f of effects) f(dt, movers);
  }
  /**
   * obj.position 을 dur 초 동안 현재 위치에서 to 로 부드럽게 옮긴다. release 가 찾을 수 있게 tween 에 obj 를 표시한다.
   * @param {{position:BABYLON.Vector3}} obj 움직일 대상
   * @param {BABYLON.Vector3} to 목표 위치
   * @param {number} dur 길이(초)
   * @param {function():void} [done] 끝난 뒤 콜백
   * @returns {void}
   * @see tween
   */
  function lerpTo(obj, to, dur, done) {
    const from = obj.position.clone();
    tween(dur, (e) => obj.position.copyFrom(V3.Lerp(from, to, e)), done);
    tweens[tweens.length - 1].obj = obj;
  }
  // ── 스케이트: 언 중정 연못 위 (낚시 대신) ───────────────────────
  /**
   * 중정 연못이 얼었는가 (office.js 가 매 프레임 setFrozen 으로 알림).
   * @type {boolean}
   */
  let pondFrozen = false;
  /**
   * 얼음 위 고양이: cat → { s: 스케이트 자리, i: 마지막으로 경로에 넣은 고리 점 번호, off: 나가는 중 }
   * @type {Map<Cat, {s: Spot, i: number, off: boolean}>}
   */
  const SKATERS = new Map();
  /**
   * 얼음 위(연못 타원 안쪽, 가장자리 0.1m 안쪽)인가.
   * @param {{x:number, z:number}} p 위치
   * @returns {boolean} 얼음 위면 true
   */
  const onIce = (p) => inPond(p.x, p.z, -0.1) && !onPier(p.x, p.z, 0.1);
  /**
   * 스케이트 기록을 지우고 얼음 위 표시를 끈다.
   * @param {Cat} cat 고양이
   * @returns {void}
   */
  function endSkate(cat) { SKATERS.delete(cat); cat.skating = false; }
  /**
   * sit 의 skate 갈래: 물가 자리 → 고리 문 → 고리 돌기. 경로는 효과가 계속 이어 붙인다. 걷기는 끝나지 않으므로 done 은 바로 부른다.
   * @param {Cat} cat 고양이
   * @param {Spot} s 스케이트 자리
   * @param {function():void} [done] 끝난 뒤 콜백
   * @returns {void}
   * @see SKATERS
   */
  function skateOn(cat, s, done) {
    SKATERS.set(cat, { s, i: s.gate, off: false });
    OfficeCat.walk(cat, [s.pos, SKATE_LOOP[s.gate]], null, null);
    if (done) done();
  }
  /**
   * stand 의 skate 갈래: 고리를 따라 자기 문까지 → 물가 자리 → 접근 길 끝점. 진행 방향으로 계속 돌아 나가 마주 치지 않는다(반대편 문 사용 금지).
   * 얼음 위가 아니면 보통 자리처럼 내려선다. 나가는 중 다시 불리면 끝 콜백만 바꾼다.
   * @param {Cat} cat 고양이
   * @param {Spot} s 스케이트 자리
   * @param {function():void} [done] 접근 길 끝점에 닿은 뒤 콜백
   * @returns {void}
   * @see skateOn
   */
  function skateOff(cat, s, done) {
    const st = SKATERS.get(cat), back = s.via[s.via.length - 1];
    if (!st || !cat.path) {
      endSkate(cat); OfficeCat.setPose(cat, 'stand'); cat.root.position.y = 0;
      lerpTo(cat.root, new V3(back.x, 0, back.z), 0.3 * CHAIR_T, done); return;
    }
    if (!st.off) {
      st.off = true;
      const pts = [], p = cat.root.position;
      if (onIce(p)) {
        let near = 0;
        SKATE_LOOP.forEach((q, i) => { if (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(SKATE_LOOP[near].x - p.x, SKATE_LOOP[near].z - p.z)) near = i; });
        for (let i = (near + 1) % SKATE.n; ; i = (i + 1) % SKATE.n) { pts.push(SKATE_LOOP[i]); if (i === s.gate) break; }
      }
      pts.push(s.pos, back);
      OfficeCat.walk(cat, pts, null, null);
    }
    cat.onArrive = () => { endSkate(cat); if (done) done(); };
  }
  /**
   * 스케이트 효과: 고리 경로를 이어 붙이고(남은 점 6개 미만이면 보충), 얼음 위 여부를 cat.skating 에 기록한다.
   * 걷기가 끊기면(집어 들림 등) 기록을 지운다.
   * @returns {void}
   */
  effects.push(() => {
    for (const [cat, st] of SKATERS) {
      if (!cat.path || cat.root.isDisposed()) { endSkate(cat); continue; }
      if (!st.off) while (cat.path.length < 6) { st.i = (st.i + 1) % SKATE.n; cat.path.push(SKATE_LOOP[st.i].clone()); }
      cat.skating = onIce(cat.root.position);
    }
  });

  /**
   * 끌어 올린 고양이: 진행 중인 앉기·일어나기 움직임을 끊고(완료 콜백 없이), 의자는 제자리로.
   * @param {Cat} cat 고양이
   * @param {(Spot|null)} s 관련 자리 (의자가 있으면 되돌린다)
   * @returns {void}
   */
  function release(cat, s) {
    if (SKATERS.has(cat)) endSkate(cat);
    const chair = s && s.chair;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const o = tweens[i].obj;
      if (o && (o === cat.root || (chair && o === chair.mesh))) tweens.splice(i, 1);
    }
    if (chair) chair.mesh.position.copyFrom(chair.home);
  }

  /**
   * 자리 앞(경유점 끝)에 선 고양이를 앉힌다.
   * 의자가 있으면: 의자를 뺀다 → 옆으로 한 걸음 들어가 앉는다 → 의자째 당긴다. 의자가 없으면 자리로 걸어가 자세를 바꾼다.
   * @param {Cat} cat 고양이
   * @param {Spot} s 앉을 자리
   * @param {function():void} [done] 다 앉은 뒤 콜백
   * @returns {void}
   * @see lerpTo
   */
  function sit(cat, s, done) {
    if (s.kind === 'skate') { skateOn(cat, s, done); return; }
    cat.heading = s.rotY;
    const root = cat.root;
    if (s.chair) {
      // 의자 옆에 선 상태 → 의자를 뺀다 → 옆으로 한 걸음 들어가 앉는다 → 의자째 당긴다
      const { mesh, home, out } = s.chair;
      const pulled = home.add(out.scale(CHAIR_PULL));
      lerpTo(mesh, pulled, 0.35 * CHAIR_T, () => {
        lerpTo(root, new V3(pulled.x, 0, pulled.z), 0.3 * CHAIR_T, () => {
          OfficeCat.setPose(cat, s.pose, s.seatY);
          lerpTo(mesh, home, 0.45 * CHAIR_T);
          lerpTo(root, new V3(home.x, 0, home.z), 0.45 * CHAIR_T, done);
        });
      });
      return;
    }
    if (s.kind === 'sofa') { sofaHop(cat, s, true, done); return; }
    /**
     * 자리에 들어서기(짧게 미끄러지며 자세 바꾸기).
     * @returns {void}
     */
    const settle = () => lerpTo(root, new V3(s.pos.x, s.pos.y || 0, s.pos.z), 0.35 * CHAIR_T, () => {
      OfficeCat.setPose(cat, s.pose, s.seatY);
      if (done) done();
    });
    // 경유점 끝이 자리에서 멀면(예: 커피 머신 3.3m) 자리 쪽을 본 채 옆으로 미끄러지지 않게 먼저 걸어가서 돌아선다
    if (!s.pos.y && Math.hypot(root.position.x - s.pos.x, root.position.z - s.pos.z) > 0.4) {
      OfficeCat.walk(cat, [new V3(s.pos.x, 0, s.pos.z)], null, () => { cat.heading = s.rotY; settle(); });
      return;
    }
    settle();
  }

  /**
   * 소파·안락의자에 뛰어 오르거나 뛰어 내린다 (포물선).
   * 오를 때: 선 자세로 소파 앞에서 쿠션 윗면까지 뛰어 올라 착지하며 앉는(또는 웅크린) 자세로 바꾼다.
   * 앉는 자세는 뿌리 높이를 0 으로 두고 몸 높이를 seatY 가 정하므로, 점프 중에는 같은 높이가 되는 만큼(OfficeCat.seatRise) 뿌리를 들어 두었다가 착지 때 0 으로 되돌린다.
   * 웅크리는 자리는 뿌리 높이(pos.y)가 곧 쿠션 윗면이다.
   * 내릴 때: 같은 높이에서 선 자세로 바꾼 뒤 경유점 끝(소파 앞 바닥)으로 뛰어 내린다.
   * @param {Cat} cat 고양이
   * @param {Spot} s 소파 자리
   * @param {boolean} up true 면 오르기, false 면 내리기
   * @param {function():void} [done] 끝난 뒤 콜백
   * @returns {void}
   * @see OfficeCat.seatRise
   * @see tween
   */
  function sofaHop(cat, s, up, done) {
    const root = cat.root, sit = s.pose === 'sit';
    const top = sit ? OfficeCat.seatRise(cat, s.seatY) : (s.pos.y || 0); // 선 자세 기준 뿌리 높이
    const back = s.via ? s.via[s.via.length - 1] : s.pos;
    const hopT = 0.5 * CHAIR_T;
    let from, to, y0, y1;
    if (up) {
      from = root.position.clone(); to = new V3(s.pos.x, 0, s.pos.z); y0 = from.y; y1 = top;
      OfficeCat.setPose(cat, 'stand');
    } else {
      OfficeCat.setPose(cat, 'stand');
      root.position.y = top; // 앉은 자세와 같은 높이에서 시작
      from = root.position.clone(); to = new V3(back.x, 0, back.z); y0 = top; y1 = 0;
    }
    tween(hopT, (e) => {
      const p = V3.Lerp(from, to, e);
      p.y = y0 + (y1 - y0) * e + SOFA_JUMP * 4 * e * (1 - e);
      root.position.copyFrom(p);
    }, () => {
      if (up) {
        if (sit) root.position.y = 0;
        OfficeCat.setPose(cat, s.pose, s.seatY);
      } else root.position.y = 0;
      if (done) done();
    });
    tweens[tweens.length - 1].obj = root;
  }

  /**
   * 앉아 있던 자리에서 일어나 경유점 끝(의자 옆)으로 내려선다.
   * 의자가 있으면: 의자째 뒤로 뺀다 → 일어나 옆으로 내려선다 → 의자를 밀어 넣는다. 발판 위 자리면 높이까지 같이 내려선다.
   * @param {Cat} cat 고양이
   * @param {Spot} s 일어날 자리
   * @param {function():void} [done] 다 내려선 뒤 콜백
   * @returns {void}
   * @see lerpTo
   */
  function stand(cat, s, done) {
    if (s.kind === 'skate') { skateOff(cat, s, done); return; }
    const root = cat.root;
    if (s.chair) {
      // 의자째 뒤로 뺀다 → 일어나 옆으로 내려선다 → 의자를 밀어 넣는다
      const { mesh, home, out } = s.chair;
      const pulled = home.add(out.scale(CHAIR_PULL));
      lerpTo(mesh, pulled, 0.4 * CHAIR_T);
      lerpTo(root, new V3(pulled.x, 0, pulled.z), 0.4 * CHAIR_T, () => {
        OfficeCat.setPose(cat, 'stand');
        const b = s.besidePulled;
        lerpTo(root, new V3(b.x, 0, b.z), 0.3 * CHAIR_T, () => {
          lerpTo(mesh, home, 0.35 * CHAIR_T);
          if (done) done();
        });
      });
      return;
    }
    if (s.kind === 'sofa' && s.via) { sofaHop(cat, s, false, done); return; }
    OfficeCat.setPose(cat, 'stand');
    if (s.via) {
      // 발판 위 자리면 높이까지 같이 부드럽게 내려선다
      const back = s.via[s.via.length - 1];
      if (!s.pos.y) root.position.y = 0;
      // 경유점 끝이 멀면(커피 머신 3.3m, 낚시 보트 1m 등) 미끄러지지 않고 걸어 나온다 (들어설 때 sit 과 같은 기준 0.4m)
      if (!s.pos.y && Math.hypot(root.position.x - back.x, root.position.z - back.z) > 0.4) { OfficeCat.walk(cat, [new V3(back.x, 0, back.z)], null, () => { if (done) done(); }); return; }
      lerpTo(root, new V3(back.x, 0, back.z), (s.pos.y ? 0.45 : 0.3) * CHAIR_T, done);
    } else { root.position.y = 0; if (done) done(); }
  }

  // ── 효과: 책상 모니터 연기 (오류) ─────────────────────────────
  /**
   * create 가 받은 씬 (연기 메시를 만들 때 쓴다).
   * @type {(BABYLON.Scene|null)}
   */
  let sceneRef = null;
  /**
   * 책상 모니터 연기 상태: 자리 id → {puffs, base}.
   * @type {Map<string, {puffs:BABYLON.Mesh[], base:BABYLON.Vector3}>}
   */
  const smokes = new Map(); // spot.id → { puffs, t }
  /**
   * 책상 모니터 위 연기를 켜거나 끈다.
   * 켤 때는 책상 앞 모니터 높이에 연기 덩어리 5개를 만들고(위치는 아래 효과가 움직임), 끌 때는 모두 지운다. 이미 켜져 있으면 아무것도 하지 않는다.
   * @param {Spot} s 책상 자리
   * @param {boolean} on 켤지 끌지
   * @returns {void}
   */
  function smoke(s, on) {
    const cur = smokes.get(s.id);
    if (!on) { if (cur) { cur.puffs.forEach((p) => p.dispose()); smokes.delete(s.id); } return; }
    if (cur) return;
    const fwd = outDir(s.rotY).scale(-0.85);
    const base = s.pos.add(fwd).add(new V3(0, 1.15, 0));
    const puffs = [0, 1, 2, 3, 4].map((i) => {
      const m = BABYLON.MeshBuilder.CreateIcoSphere('smoke', { radius: 0.12, subdivisions: 1 }, sceneRef);
      m.material = P.mat(sceneRef, 'smoke', { alpha: 0.7 });
      m.isPickable = false;
      m.phase = i / 5;
      return m;
    });
    smokes.set(s.id, { puffs, base });
  }
  /**
   * 연기 효과: 연기 덩어리를 위로 올리며 커지고 투명해지게 한다 (phase 0~1 순환).
   * @param {number} dt 지난 시간(초)
   */
  effects.push((dt) => {
    for (const { puffs, base } of smokes.values()) {
      for (const m of puffs) {
        m.phase = (m.phase + dt * 0.45) % 1;
        const k = m.phase;
        m.position.set(base.x + Math.sin(k * 6 + m.uniqueId) * 0.08, base.y + k * 1.1, base.z);
        m.scaling.setAll(0.6 + k * 1.6);
        m.visibility = 1 - k;
      }
    }
  });

  /**
   * 개발용: 모든 자리 출입 경로가 가구를 뚫는지 검사. 반환: 충돌 목록.
   * 정문에서 자리까지(in)와 자리에서 정문까지(out) 경로, 결재판 줄 자리까지의 길을 장애물 상자로 훑고, 검사기 자체 확인(selftest)도 한다.
   * @param {number} [radius=0.12] 고양이 반지름
   * @returns {string[]} 충돌 설명 목록 (비어 있어야 정상. 검사기 고장이면 SELFTEST-FAILED 포함)
   * @see pathTo
   */
  function checkPaths(radius = 0.12) {
    const hits = [];
    const door = new V3(13.5, 0, 17.0);
    /**
     * 자기 자리 의자나 0.95m 안의 가구는 충돌에서 뺀다.
     * @param {Spot} s 자리
     * @returns {function(Obstacle):boolean} 장애물이 자기 것이면 true
     */
    const own = (s) => (o) => (s.chairItem === o.n) || V3.Distance(o.c, s.pos) < 0.95;
    /**
     * 꺾은선을 0.1m 간격으로 훑어 장애물 상자와 겹치면 hits 에 한 건 기록한다.
     * @param {BABYLON.Vector3[]} pts 경로 점들
     * @param {function(Obstacle, number, number):boolean} ignore 무시할 장애물 판정 (장애물, 구간 번호, 점 수)
     * @param {string} label 보고할 이름
     * @returns {void}
     */
    const test = (pts, ignore, label) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const n = Math.max(1, Math.ceil(V3.Distance(a, b) / 0.1));
        for (let k = 0; k <= n; k++) {
          const p = V3.Lerp(a, b, k / n);
          for (const o of obstacles) {
            if (o.max.y < 0.05 || ignore(o, i, pts.length)) continue;
            if (p.x > o.min.x - radius && p.x < o.max.x + radius && p.z > o.min.z - radius && p.z < o.max.z + radius) {
              hits.push(`${label}: ${o.name}#${o.n} @${p.x.toFixed(2)},${p.z.toFixed(2)}`);
              return;
            }
          }
        }
      }
    };
    for (const s of spots) {
      if (s.kind === 'boss') continue;
      const inPts = [...pathTo(null, door, s), s.pos];
      test(inPts, (o, i, len) => i >= len - 2 && own(s)(o), 'in ' + s.id);
      const outPts = [s.pos, ...pathTo(s, s.pos, { pos: door })];
      test(outPts, (o, i) => i <= 1 && own(s)(o), 'out ' + s.id);
    }
    // 결재판 줄 자리: 정문에서 각 자리까지(in)·자리에서 정문까지(out) + 줄 자리를 잇는 선
    DROP.slots.forEach((sl, k) => {
      const s = { pos: sl.pos };
      test([...pathTo(null, door, s), s.pos], () => false, 'in drop-' + k);
      test([s.pos, ...pathTo(null, s.pos, { pos: door })], () => false, 'out drop-' + k);
    });
    test(DROP.pts, () => false, 'drop');
    // 검사기 자체 확인: 책상 묶음을 가로지르는 직선은 반드시 걸려야 한다
    const save = hits.length;
    test([new V3(0.8, 0, 3.5), new V3(9.2, 0, 3.5)], () => false, 'selftest');
    if (hits.length === save) hits.push('SELFTEST-FAILED obstacles=' + obstacles.length);
    else hits.pop();
    return hits;
  }

  // ── 배치 규칙 검사 (파일 머리말의 규칙 a~e) ───────────────────
  /**
   * 점에서 발자국까지 거리 (안이면 0 이하). 원은 r, 사각형은 회전한 상자.
   * @param {number} px 점 x
   * @param {number} pz 점 z
   * @param {Footprint} f 발자국
   * @returns {number} 거리 (m)
   */
  function clear(px, pz, f) {
    if (f.r) return Math.hypot(px - f.cx, pz - f.cz) - f.r;
    const dx = px - f.ox, dz = pz - f.oz;
    const lx = dx * f.cs - dz * f.sn, lz = dx * f.sn + dz * f.cs;
    return Math.hypot(Math.max(Math.abs(lx) - f.hx, 0), Math.max(Math.abs(lz) - f.hz, 0));
  }
  /**
   * 두 발자국 사이 틈 (m). 음수면 그만큼 겹친다.
   * 원-원, 원-사각형은 거리로 계산하고, 회전한 사각형끼리는 분리축 네 개 가운데 가장 크게 벌어진 값을 쓴다.
   * @param {Footprint} a 발자국 a
   * @param {Footprint} b 발자국 b
   * @returns {number} 틈 (m)
   * @see clear
   */
  function gap(a, b) {
    if (a.r && b.r) return Math.hypot(a.cx - b.cx, a.cz - b.cz) - a.r - b.r;
    if (a.r) return clear(a.cx, a.cz, b) - a.r;
    if (b.r) return clear(b.cx, b.cz, a) - b.r;
    // 회전한 사각형끼리: 분리축 네 개 가운데 가장 크게 벌어진 값
    let best = -Infinity;
    const dx = b.ox - a.ox, dz = b.oz - a.oz;
    for (const f of [a, b]) for (const [nx, nz] of [[f.cs, -f.sn], [f.sn, f.cs]]) {
      /**
       * 사각형 g 를 분리축 (nx, nz) 에 투영한 반길이.
       * @param {Footprint} g 사각형 발자국
       * @returns {number} 반길이
       */
      const rad = (g) => g.hx * Math.abs(nx * g.cs - nz * g.sn) + g.hz * Math.abs(nx * g.sn + nz * g.cs);
      best = Math.max(best, Math.abs(nx * dx + nz * dz) - rad(a) - rad(b));
    }
    return best;
  }
  /**
   * 위반 메시지에 쓰는 발자국 이름표 "이름#순번(x,z)".
   * @param {FootprintItem} f 발자국
   * @returns {string} 이름표
   */
  const tag = (f) => `${f.name}#${f.n}(${f.cx.toFixed(2)},${f.cz.toFixed(2)})`;
  /**
   * 꺾은선을 0.1m 간격으로 훑어 반지름 r 안에 들어오는 발자국을 찾는다.
   * @param {BABYLON.Vector3[]} pts 꺾은선 점들
   * @param {Footprint[]} list 검사할 발자국들
   * @param {number} r 허용 반지름
   * @param {function(Footprint):boolean} [skip] true 를 돌려주면 그 발자국은 건너뜀
   * @returns {Footprint[]} 걸린 발자국들 (중복 없음)
   * @see clear
   */
  function sweep(pts, list, r, skip) {
    const out = new Set();
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(V3.Distance(a, b) / 0.1));
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
        for (const f of list) if (!out.has(f) && !(skip && skip(f)) && clear(x, z, f) < r - 1e-6) out.add(f);
      }
    }
    return [...out];
  }

  // ── 물체 간격 띠: 걷는 고양이는 물체 발자국에서 KEEP 안으로 들어가지 않는다 ──
  const KEEP = 0.3; // 물체 발자국과 고양이 중심 사이 최소 거리 (m) — 몸 반폭 + 눈에 보이는 틈
  const KEEP_END = 1.2; // 출발·도착 이 거리 안에서 닿는 물체(자기 의자·책상·소파)는 간격 규칙에서 뺀다 (m)
  /**
   * 걷는 고양이 위치 (x, z) 를 물체 간격 띠 밖으로 밀어낸 점.
   * 길을 막는 물체(발자국 block)마다 발자국에서 KEEP 안이면 가장 가까운 바깥쪽으로 민다. 두 번 훑어 옆 물체로 밀려 들어간 것도 한 번 더 뺀다.
   * 양쪽 물체 사이가 2·KEEP 보다 좁으면 뒤에 검사한 쪽이 이긴다 (떨지 않고 한쪽으로 붙는다).
   * @param {number} x 월드 x (m)
   * @param {number} z 월드 z (m)
   * @param {Set<Footprint>} [ex] 건너뛸 발자국 (keepOutExempt 결과)
   * @returns {{x:number, z:number}} 밀어낸 점
   * @see keepOutExempt
   */
  function keepOut(x, z, ex) {
    let ox = x, oz = z;
    for (let it = 0; it < 2; it++) {
      for (const f of foot) {
        if (!f.block || (ex && ex.has(f))) continue;
        if (f.r) {
          const dx = ox - f.cx, dz = oz - f.cz, d = Math.hypot(dx, dz), need = f.r + KEEP;
          if (d >= need) continue;
          if (d < 1e-4) { ox = f.cx + need; continue; }
          ox = f.cx + (dx / d) * need; oz = f.cz + (dz / d) * need;
          continue;
        }
        const dx = ox - f.ox, dz = oz - f.oz;
        if (Math.abs(dx) + Math.abs(dz) > (f.hx + f.hz + KEEP) * 2) continue; // 멀리 있는 것은 바로 넘김
        let lx = dx * f.cs - dz * f.sn, lz = dx * f.sn + dz * f.cs;
        const ex2 = Math.abs(lx) - f.hx, ez2 = Math.abs(lz) - f.hz;
        if (ex2 >= KEEP || ez2 >= KEEP) continue;
        if (ex2 > 0 && ez2 > 0) {
          // 모서리 바깥: 모서리에서 반지름 KEEP 인 둥근 띠
          const d = Math.hypot(ex2, ez2);
          if (d >= KEEP) continue;
          const k = KEEP / d;
          lx = Math.sign(lx) * (f.hx + ex2 * k); lz = Math.sign(lz) * (f.hz + ez2 * k);
        } else if (ex2 > ez2) lx = (lx < 0 ? -1 : 1) * (f.hx + KEEP); // 가까운 면 쪽으로 빼낸다
        else lz = (lz < 0 ? -1 : 1) * (f.hz + KEEP);
        ox = f.ox + lx * f.cs + lz * f.sn; oz = f.oz - lx * f.sn + lz * f.cs;
      }
    }
    return { x: ox, z: oz };
  }
  /**
   * 경로의 출발·도착 KEEP_END 구간에서 간격 띠에 닿는 물체들 (그 경로를 걷는 동안 keepOut 에서 뺀다).
   * 자리에 앉으러 들어가거나 일어나 나올 때는 자기 의자·책상에 붙어야 하기 때문이다.
   * @param {Array<{x:number, z:number}>} pts 경로 점들 (첫 점은 지금 위치)
   * @returns {Set<Footprint>} 뺄 발자국들
   * @see keepOut
   */
  function keepOutExempt(pts) {
    const out = new Set();
    /**
     * 꺾은선 q 를 앞에서부터 KEEP_END 만큼 0.1m 간격으로 훑어 띠에 닿는 발자국을 out 에 담는다.
     * @param {Array<{x:number, z:number}>} q 꺾은선 점들
     * @returns {void}
     */
    const scan = (q) => {
      let left = KEEP_END;
      for (let i = 1; i < q.length && left > 0; i++) {
        const a = q[i - 1], b = q[i], l = Math.hypot(b.x - a.x, b.z - a.z), use = Math.min(l, left);
        const n = Math.max(1, Math.ceil(use / 0.1));
        for (let k = 0; k <= n; k++) {
          const t = l > 1e-6 ? ((use * k) / n) / l : 0;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          for (const f of foot) if (f.block && !out.has(f) && clear(x, z, f) < KEEP) out.add(f);
        }
        left -= l;
      }
    };
    scan(pts);
    scan(pts.slice().reverse());
    return out;
  }

  /**
   * 배치 규칙 a~e(+f) 를 어긴 곳 목록 (문자열). 비어 있어야 정상.
   * (a) 벽·가구 겹침, (b) 올려놓는 물건·벽걸이, (c) 통로 선·자리 접근 길, (d) 결재판 줄 자리·문 자리, (e) 바깥 물체와 건물·길 띠, (f) 통로·결재판 줄 길이 벽을 뚫는지를 차례로 검사한다.
   * @returns {string[]} 위반 설명 목록
   * @see gap
   * @see sweep
   */
  function checkLayout() {
    const V = [];
    const solid = foot.filter((f) => f.layer === 'furniture' || f.layer === 'outdoor');
    const furn = foot.filter((f) => f.layer === 'furniture');
    const chairSpot = new Map(spots.filter((s) => s.chairItem != null).map((s) => [s.chairItem, s]));
    // (a) 벽·유리벽: 모든 층. 가구·바깥 물체는 틈 TOL 이상, 벽걸이는 벽에 붙되 파고들지 않는다
    for (const f of foot) {
      const need = f.layer === 'furniture' || f.layer === 'outdoor' ? TOL : 0;
      for (const w of WALLS) if (gap(f, w) < need - 1e-6) V.push(`a-wall: ${tag(f)} ↔ ${w.name} (틈 ${gap(f, w).toFixed(2)})`);
      if (f.layer === 'wallMounted' && !WALLS.some((w) => w.tall && gap(f, w) <= 0.12)) V.push(`b-wallMounted: ${tag(f)} 벽에서 떨어짐`);
    }
    // (a) 가구·바깥 물체끼리. (b) 예외: withChair 의자는 자기 앞의 책상·탁자 밑으로만 들어간다
    /**
     * 의자 c 가 자기 앞(바라보는 쪽)의 책상·탁자 t 밑으로 들어간 허용 예외인지.
     * @param {FootprintItem} c 의자 발자국
     * @param {FootprintItem} t 책상·탁자 발자국
     * @returns {boolean} 예외면 true
     */
    const tucked = (c, t) => {
      const s = chairSpot.get(c.n);
      if (!s || !/^@desk$|^@bossDesk$|^desk|^table/.test(t.name)) return false;
      const out = outDir(s.rotY);
      return (t.cx - c.cx) * -out.x + (t.cz - c.cz) * -out.z > 0;
    };
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (gap(a, b) >= -TOL || tucked(a, b) || tucked(b, a)) continue;
      V.push(`a-overlap: ${tag(a)} ↔ ${tag(b)} (겹침 ${(-gap(a, b)).toFixed(2)})`);
    }
    // (b) 올려놓는 물건: 네 귀퉁이가 모두 받침 가구 발자국 안
    for (const f of foot) {
      if (f.layer !== 'onTop') continue;
      const ok = f.corners.every(([x, z]) => furn.some((s) => clear(x, z, s) <= TOL));
      if (!ok) V.push(`b-onTop: ${tag(f)} 받침 가구 밖으로 나감`);
    }
    // (c) 통로 선 (고양이 반지름) + 자리마다 드나드는 길
    const hitL = new Set();
    for (const l of LINES) for (const f of sweep([l.a, l.b], solid, CAT_R)) hitL.add(f);
    for (const f of hitL) V.push(`c-line: ${tag(f)} 통로 선을 막음`);
    for (const s of spots) {
      if (s.kind === 'boss') continue;
      const pts = s.via ? s.via.slice() : [];
      if (!pts.length || (s.pose === 'stand' && s.chairItem == null)) pts.push(s.pos);
      pts.unshift(nearestOnLines(pts[0]));
      for (const f of sweep(pts, solid, CAT_R, (o) => o.n === s.chairItem)) V.push(`c-spot: ${s.id} 접근 길 ↔ ${tag(f)}`);
    }
    // (g) 스케이트 길: 물가 자리 → 고리 문, 고리 한 바퀴 (언 연못 위 — 돌·정원등·가로등과 겹치지 않아야 함)
    for (const s of spots.filter((x) => x.kind === 'skate')) for (const f of sweep([s.pos, SKATE_LOOP[s.gate]], solid, CAT_R)) V.push(`g-skate: ${s.id} 얼음 길 ↔ ${tag(f)}`);
    for (const f of sweep(SKATE_LOOP.concat([SKATE_LOOP[0]]), solid, CAT_R)) V.push(`g-skate: 고리 ↔ ${tag(f)}`);
    // (d) 결재판 줄 자리(줄 점들을 잇는 선 + 통로 선에서 각 자리까지 가는 길) + 문 자리
    for (const f of sweep(DROP.pts, solid, CAT_R)) V.push(`d-drop: ${tag(f)} 결재판 줄 자리를 막음`);
    for (const sl of DROP.slots) for (const f of sweep([nearestOnLines(sl.pos), sl.pos], solid, CAT_R)) V.push(`d-drop: 접근 길 ↔ ${tag(f)}`);
    for (const f of foot) {
      if (f.layer === 'floor') continue;
      for (const d of DOORS) if (gap(f, d) < 0) V.push(`d-door: ${tag(f)} ↔ ${d.name}`);
    }
    // (e) 바깥 물체: 건물 바닥과 겹치지 않고, 길 띠(반폭 PATH_HALF) 밖에 있다
    const out = foot.filter((f) => f.layer === 'outdoor');
    for (const f of out) for (const b of BUILDING) if (gap(f, b) < -1e-6) V.push(`e-building: ${tag(f)} 건물 안으로 들어옴`);
    const hitP = new Set();
    for (const [a, b] of outdoorPaths()) for (const f of sweep([a, b], out, PATH_HALF)) hitP.add(f);
    for (const f of hitP) V.push(`e-path: ${tag(f)} 길 위에 걸침`);
    // (f) 통로 선·자리 출입 길·결재판 줄이 벽(유리 가벽 포함)을 뚫지 않는다 (문틈으로만 지난다)
    const wallFoot = WALLS.map((w) => ({ ...w, cx: w.ox, cz: w.oz, n: 'w' }));
    for (const l of LINES) for (const w of sweep([l.a, l.b], wallFoot, CAT_R)) V.push(`f-line: (${l.a.x.toFixed(1)},${l.a.z.toFixed(1)})-(${l.b.x.toFixed(1)},${l.b.z.toFixed(1)}) ↔ ${w.name}`);
    for (const s of spots) {
      if (s.kind === 'boss') continue;
      const pts = s.via ? s.via.slice() : [s.pos];
      pts.unshift(nearestOnLines(pts[0]));
      for (const w of sweep(pts, wallFoot, CAT_R)) V.push(`f-spot: ${s.id} ↔ ${w.name}`);
    }
    for (const w of sweep(DROP.pts, wallFoot, CAT_R)) V.push(`f-drop: ↔ ${w.name}`);
    return V;
  }
  /**
   * 바깥 길 조각 목록 (공원 길 · 중정 길 · 연결 길).
   * @returns {BABYLON.Vector3[][]} [a, b] 선분 목록
   */
  function outdoorPaths() {
    const segs = [];
    LOOP.forEach((p, i) => segs.push([p, LOOP[(i + 1) % LOOP.length]]));
    CLOOP.forEach((p, i) => segs.push([p, CLOOP[(i + 1) % CLOOP.length]]));
    CONNECT.forEach((pts) => { for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); });
    return segs;
  }
  /**
   * 벽·유리벽을 뚫은 물체만 (checkLayout 결과 중 a-wall).
   * @returns {string[]} 위반 설명 목록
   * @see checkLayout
   */
  function checkWalls() { return checkLayout().filter((v) => v.startsWith('a-wall')); }

  // ── 생성 ────────────────────────────────────────────────────
  /**
   * 씬에 사무실을 만든다.
   * 순서: 건물 골격(shell) → 공원 나무·덤불·계절 바닥·조명을 items 에 추가 → 견본 만들기(CUSTOM 또는 Kenney) → 인스턴스 배치 → 의자·발자국·장애물 계산 →
   * 배치 규칙 검사(위반은 콘솔 경고) → 배달 상자 더미 함수 준비.
   * @param {BABYLON.Scene} scene Babylon 씬
   * @param {{shadows?:BABYLON.ShadowGenerator}} [opts] shadows: 그림자 생성기
   * @returns {Promise<OpenOfficeApi>} 공개 API 객체
   * @see shell
   * @see checkLayout
   * @see checkPaths
   */
  async function create(scene, { shadows } = {}) {
    sceneRef = scene;
    const root = new BABYLON.TransformNode('openoffice', scene);
    const casters = [];
    shell(scene, root, casters);

    // 공원 나무·덤불: 길·연못·조각상·건물에서 떨어진 곳에만
    const segs = [...LOOP.map((p, i) => [p, LOOP[(i + 1) % LOOP.length]])];
    CONNECT.forEach((pts) => { for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); });
    /**
     * 점 (x, z) 에서 공원 길·연결 길까지의 최소 거리.
     * @param {number} x 점 x
     * @param {number} z 점 z
     * @returns {number} 거리 (m)
     */
    const distPath = (x, z) => {
      const q = new V3(x, 0, z);
      let d = Infinity;
      for (const [a, b] of segs) d = Math.min(d, V3.Distance(project(q, { a, b }), q));
      return d;
    };
    /**
     * (x, z) 로 0~1 사이 결정적 의사 난수를 만든다 (나무 흩뿌림용).
     * @param {number} x 입력 x
     * @param {number} z 입력 z
     * @returns {number} [0, 1) 값
     */
    const hash = (x, z) => { const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return h - Math.floor(h); };
    /**
     * 공원 나무·덤불을 심어도 되는 자리인지: 건물·중정, 연못, 조각상, 뒷산, 자리, 길에서 gap 이상 떨어진 곳만.
     * @param {number} x 후보 x
     * @param {number} z 후보 z
     * @param {number} gap 길에서 떨어져야 하는 거리
     * @returns {boolean} 심어도 되면 true
     */
    const okSpot = (x, z, gap) => {
      if (x > -2 && x < 34 && z > -2 && z < 30) return false; // 건물·중정
      if (((x - POND.x) / (POND.rx + 1.6)) ** 2 + ((z - POND.z) / (POND.rz + 1.6)) ** 2 < 1) return false;
      if (Math.hypot(x - STATUE.x, z - STATUE.z) < 3.4) return false;
      if (z > 29 && x > -10 && x < 42) return false; // 뒷산 자리
      if (spots.some((s) => Math.hypot(s.pos.x - x, s.pos.z - z) < 2)) return false;
      return distPath(x, z) > gap;
    };
    // 이미 놓인 바깥 물체(원 발자국)와 겹치는 자리는 건너뛴다 (규칙 a)
    const placed = items.map((it, n) => (layers[n] === 'outdoor' && RADIUS[it[0]] ? { x: it[1], z: it[2], r: RADIUS[it[0]] * (it[6] || 1) } : null)).filter(Boolean);
    /**
     * 바깥 물체(나무·덤불)를 놓는다. 이미 놓인 원 발자국과 겹치면 건너뛴다 (규칙 a).
     * @param {string} m 모델 이름 ('@tree'|'@pine'|'@bush')
     * @param {number} x 중심 x
     * @param {number} z 중심 z
     * @param {number} sc 배율
     * @returns {void}
     */
    const plant = (m, x, z, sc) => {
      const r = RADIUS[m] * sc;
      if (placed.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + r)) return;
      placed.push({ x, z, r });
      put(m, x, z, x * 1.7 + z, 0, undefined, sc);
    };
    for (let x = -20; x <= 40; x += 3.2) for (let z = -22; z <= 34; z += 3.2) {
      const jx = x + (hash(x, z) - 0.5) * 2.2, jz = z + (hash(z, x) - 0.5) * 2.2;
      if (hash(jx, jz) < 0.42 || !okSpot(jx, jz, 2.5)) continue;
      plant(hash(jz, jx) < 0.4 ? '@pine' : '@tree', jx, jz, 0.75 + hash(jx + 1, jz) * 0.5);
    }
    for (let x = 0.8; x < 10; x += 3.0) plant('@bush', x, -0.75, 1);
    for (let x = 23; x < 32; x += 3.0) plant('@bush', x, -0.75, 1);
    for (let z = 2; z < 28; z += 3.1) plant('@bush', -0.8, z, 1);
    const pathPts = LOOP.slice();
    for (let i = 0; i < 46; i++) {
      const p = pathPts[(i * 7) % pathPts.length];
      const a = hash(i, 3) * PI * 2, x = p.x + Math.cos(a) * 1.7, z = p.z + Math.sin(a) * 1.7;
      const sc = 0.7 + hash(i, 9) * 0.5;
      if (okSpot(x, z, PATH_HALF + RADIUS['@bush'] * sc + 0.05)) plant('@bush', x, z, sc); // 길 띠 밖 (규칙 e)
    }

    // 계절: 잎 나무마다 같은 자리에 겨울 나무(가지) 짝 — 바닥 층으로 둬서 겹침 검사에서 빠짐, 계절에 따라 둘 중 하나만 켠다
    // 여름 풀·가을 낙엽 자리: 잔디 위(길·건물·물·다른 물체 밖)
    {
      const segs2 = outdoorPaths();
      const near2 = (x, z) => distSegs(segs2, x, z);
      /**
       * (a, b) 로 0~1 사이 결정적 의사 난수를 만든다 (풀·낙엽 흩뿌림용).
       * @param {number} a 입력 a
       * @param {number} b 입력 b
       * @returns {number} [0, 1) 값
       */
      const h = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
      /**
       * (x, z) 가 풀·낙엽을 깔 수 있는 잔디 위인지 (건물·길·연못·뒷산 밖, 정해진 범위 안).
       * @param {number} x 후보 x
       * @param {number} z 후보 z
       * @returns {boolean} 깔 수 있으면 true
       */
      const lawnOk = (x, z) => {
        if (BUILDING.some((b) => x > b.x0 - 0.3 && x < b.x1 + 0.3 && z > b.z0 - 0.3 && z < b.z1 + 0.3)) return false;
        if (near2(x, z) < PATH_HALF + 0.1) return false;
        if (((x - POND.x) / (POND.rx + 0.4)) ** 2 + ((z - POND.z) / (POND.rz + 0.4)) ** 2 < 1) return false;
        if (inDeck(x, z, 0.3)) return false;
        if (z > 29 && x > -10 && x < 42) return false;
        return x > -24 && x < 46 && z > -26 && z < 36;
      };
      // 계절 꽃밭: 꽃밭(봄) 자리마다 여름·가을·겨울 견본을 겹쳐 놓는다 (weatherfx.js 가 계절에 맞는 것 하나만 켠다. 발자국은 봄 꽃밭 하나로 센다)
      items.slice().forEach((it) => {
        if (it[0] !== '@flowers') return;
        for (const v of ['@flowersSummer', '@flowersAutumn', '@flowersWinter']) put(v, it[1], it[2], it[3] || 0, it[4] || 0, undefined, it[6], 'floor');
      });
      items.slice().forEach((it, n) => {
        if (it[0] !== '@tree' || layers[n] !== 'outdoor') return;
        put('@treeBare', it[1], it[2], it[3] || 0, 0, undefined, it[6], 'floor');
        const r = RADIUS['@tree'] * (it[6] || 1);
        for (let k = 0; k < 26; k++) {
          const a = h(n, k) * PI * 2, d = Math.sqrt(h(k, n)) * (r + 0.9);
          const x = it[1] + Math.cos(a) * d, z = it[2] + Math.sin(a) * d;
          if (lawnOk(x, z)) GROUND.leaves.push([+x.toFixed(2), +z.toFixed(2), +(h(x, z) * 6.28).toFixed(2)]);
        }
      });
      for (let i = 0; i < 1400; i++) {
        const x = -24 + h(i, 1) * 70, z = -26 + h(i, 2) * 62;
        if (lawnOk(x, z)) GROUND.grass.push([+x.toFixed(2), +z.toFixed(2), +(h(i, 3) * 6.28).toFixed(2), +(0.7 + h(i, 4) * 0.6).toFixed(2)]);
      }
    }
    // 나무 꼬마전구: 가지마다 감아 건 전구 줄이라고 보고, 잎 덩어리 겉면 바로 바깥에 점을 흩뿌린다 (모양은 treeParts·pineParts 와 같은 수치)
    const TREE_BLOBS = [[0, 2.1, 0, 0.95], [0.45, 2.7, 0.1, 0.7], [-0.35, 2.9, -0.2, 0.65], [0.05, 3.4, 0.05, 0.5]];
    const PINE_CONES = [[1.0, 1.9, 1.8], [1.7, 1.5, 1.4], [2.35, 1.1, 1.1], [2.9, 0.6, 0.8]];
    /**
     * 나무 한 그루의 꼬마전구 점들을 LIGHTS.fairy 에, 나무 밑 불빛을 LIGHTS.tree 에 등록한다.
     * 잎 나무는 잎 덩어리 겉면, 소나무는 원뿔을 나선으로 감은 줄 위에 점을 놓는다. 점은 나무 회전·배율을 적용한 세계 좌표다.
     * @param {string} m 모델 이름 ('@tree' 또는 '@pine')
     * @param {number} x 나무 x
     * @param {number} z 나무 z
     * @param {number} rotY 나무 회전
     * @param {number} sc 나무 배율
     * @returns {void}
     */
    function fairyTree(m, x, z, rotY, sc) {
      /**
       * 이 나무 전용 결정적 의사 난수 (0~1).
       * @param {number} k 순번
       * @returns {number} [0, 1) 값
       */
      const h = (k) => { const v = Math.sin(x * 91.7 + z * 47.3 + k * 12.97) * 43758.5; return v - Math.floor(v); };
      const cs = Math.cos(rotY), sn = Math.sin(rotY);
      /**
       * 나무 기준 좌표의 점을 회전·배율을 적용해 LIGHTS.fairy 에 넣는다.
       * @param {number} lx 나무 기준 x
       * @param {number} ly 나무 기준 y
       * @param {number} lz 나무 기준 z
       * @returns {void}
       */
      const add = (lx, ly, lz) => LIGHTS.fairy.push([x + (lx * cs + lz * sn) * sc, ly * sc, z + (-lx * sn + lz * cs) * sc]);
      let k = 0;
      if (m === '@tree') {
        for (const [bx, by, bz, r] of TREE_BLOBS) {
          const n = Math.round(9 * r * r + 3);
          for (let i = 0; i < n; i++, k++) {
            const a = h(k) * PI * 2, c = h(k + 0.5) * 1.6 - 0.75; // 아래쪽 끝은 비움
            const rr = r * 1.03, cy = Math.max(-1, Math.min(1, c));
            add(bx + Math.cos(a) * rr * Math.sqrt(1 - cy * cy), by + cy * rr, bz + Math.sin(a) * rr * Math.sqrt(1 - cy * cy));
          }
        }
      } else {
        // 소나무: 원뿔마다 나선으로 감은 전구 줄
        for (const [y, d, hh] of PINE_CONES) {
          const y0 = y - 0.3, n = Math.round(d * 7);
          for (let i = 0; i < n; i++, k++) {
            const t = (i + h(k) * 0.4) / n, yy = y0 + t * hh * 0.85, rr = (d / 2) * (1 - (yy - y0) / hh) * 1.04, a = t * PI * 4 + h(k + 3);
            add(Math.cos(a) * rr, yy, Math.sin(a) * rr);
          }
        }
      }
      LIGHTS.tree.push({ x, z, gx: x, gz: z, r: (m === '@tree' ? 0.95 : 0.8) * sc, why: 'tree' }); // 나무 밑 은은한 불빛
    }
    // 조경 조명: 조각상·꽃밭·석등을 비추는 바닥 투광등 (나무를 심은 뒤라 여기서)
    {
      const segs = outdoorPaths();
      const near = (x, z) => distSegs(segs, x, z);
      const targets = [];
      items.forEach((it, n) => {
        const [m, x, z, , , , sc] = it;
        if (layers[n] !== 'outdoor') return;
        if (m === '@statue' || m === '@flowers' || m === '@lantern') targets.push({ x, z, r: (RADIUS[m] || 0.6) * (sc || 1) });
        else if (m === '@tree' || m === '@pine') fairyTree(m, x, z, it[3] || 0, sc || 1);
      });
      for (const t of targets) {
        // 길 쪽 옆에서 비춘다
        let best = null, bd = Infinity;
        const q0 = new V3(t.x, 0, t.z);
        for (const [a, b] of segs) { const pr = project(q0, { a, b }), d = V3.Distance(pr, q0); if (d < bd) { bd = d; best = pr; } }
        const dx = best.x - t.x, dz = best.z - t.z, l = Math.hypot(dx, dz) || 1;
        const p = lightSpot(t.x + (dx / l) * (t.r + 0.3), t.z + (dz / l) * (t.r + 0.3), RADIUS['@upLight'], { maxR: 0.8 });
        if (!p) continue;
        put('@upLight', p.x, p.z, Math.atan2(dx / l, dz / l));
        LIGHTS.up.push({ x: p.x, z: p.z, gx: t.x, gz: t.z, r: t.r, why: 'up' });
      }
    }
    const names = [...new Set(items.map((i) => JSON.stringify([i[0], i[5] || null])))];
    const tpl = new Map();
    await Promise.all(names.concat([JSON.stringify(['@box', null]), JSON.stringify(['@board', null])]).map(async (k) => {
      const [m, ov] = JSON.parse(k);
      try {
        tpl.set(k, CUSTOM[m] ? await CUSTOM[m](scene) : await Kenney.get(scene, m, ov || undefined));
      } catch (e) { console.warn('모델 불러오기 실패', m, e && e.message); }
    }));
    const chairIdx = new Set(spots.filter((s) => s.chairItem != null).map((s) => s.chairItem));
    items.forEach(([m, x, z, rotY, y, ov, scale], n) => {
      const t = tpl.get(JSON.stringify([m, ov || null]));
      if (!t) return;
      t.receiveShadows = true;
      const inst = t.createInstance(`${m}:${n}`);
      inst.rotationQuaternion = null; // rotation.y 가 반드시 적용되게
      inst.parent = root;
      inst.position.set(x, y || 0, z);
      inst.rotation.y = rotY || 0;
      if (scale) inst.scaling.setAll(scale);
      if (!chairIdx.has(n)) inst.freezeWorldMatrix();
      if (!/^rug|^@pond|^@mound/.test(m)) casters.push(inst);
      inst.isPickable = n === bossDeskItem || m === '@bossProps';
      if (inst.isPickable) inst.metadata = { bossDesk: true };
      instances[n] = inst;
    });
    for (const s of spots) {
      if (s.chairItem == null || !instances[s.chairItem]) continue;
      const mesh = instances[s.chairItem];
      s.chair = { mesh, home: mesh.position.clone(), out: outDir(s.rotY) };
    }
    // 해금 전 숨김
    if (instances[towerItem]) instances[towerItem].setEnabled(false);
    // 발자국(배치 검사용) + 장애물 상자(길 검사용)
    instances.forEach((m, n) => {
      if (!m) return;
      // 경계 상자는 견본 상자를 회전·이동해 직접 계산 (고정 행렬 인스턴스는 갱신이 늦을 수 있음)
      const tb = m.sourceMesh.getBoundingInfo().boundingBox;
      const sc = m.scaling.x;
      const xs = [], zs = [], corners = [];
      // 실제 그리는 데 쓰는 세계 행렬로 꼭짓점을 옮긴다 (rotation 값과 화면이 어긋나는 경우도 잡아냄)
      const wm = m.computeWorldMatrix(true);
      // 실제 회전: 단위 x 축이 옮겨진 방향 (x' = cos, z' = -sin)
      const o0 = V3.TransformCoordinates(V3.Zero(), wm), ax = V3.TransformCoordinates(new V3(1, 0, 0), wm).subtract(o0);
      const al = Math.hypot(ax.x, ax.z) || 1, cs = ax.x / al, sn = -ax.z / al;
      for (const lx of [tb.minimum.x, tb.maximum.x]) for (const lz of [tb.minimum.z, tb.maximum.z]) {
        const q = V3.TransformCoordinates(new V3(lx, 0, lz), wm);
        xs.push(q.x); zs.push(q.z);
        corners.push([q.x, q.z]);
      }
      const b = {
        minimumWorld: new V3(Math.min(...xs), m.position.y + tb.minimum.y * sc, Math.min(...zs)),
        maximumWorld: new V3(Math.max(...xs), m.position.y + tb.maximum.y * sc, Math.max(...zs)),
      };
      b.centerWorld = V3.Center(b.minimumWorld, b.maximumWorld);
      const f = {
        n, name: items[n][0], layer: layers[n], cx: m.position.x, cz: m.position.z,
        ox: (corners[0][0] + corners[3][0]) / 2, oz: (corners[0][1] + corners[3][1]) / 2,
        hx: ((tb.maximum.x - tb.minimum.x) / 2) * sc, hz: ((tb.maximum.z - tb.minimum.z) / 2) * sc, cs, sn, corners,
      };
      if (RADIUS[f.name]) f.r = RADIUS[f.name] * sc;
      foot.push(f);
      if (/^rug|^@tree|^@pine|^@bush|^@pond|^@mound|^@catTower/.test(items[n][0])) return;
      if (b.maximumWorld.y >= 0.05 && (f.layer === 'furniture' || f.layer === 'outdoor')) f.block = true; // 걷는 고양이가 간격을 두는 물체 (keepOut)
      obstacles.push({ n, name: items[n][0], min: b.minimumWorld.clone(), max: b.maximumWorld.clone(), c: b.centerWorld.clone() });
    });
    // 낚시 보트·통: 모델이 아니라 직접 만든 메시라 발자국을 손으로 넣는다 (보트는 회전한 사각, 통은 원). 간격 띠(block)에 걸려도 출발·도착 1.2m 안은 자동 예외라 타는 데 문제없다
    {
      const cs = PIER.n.x, sn = -PIER.n.z, hw = BOAT.hw, hl = BOAT.hl;
      const axX = new V3(PIER.n.x, 0, PIER.n.z), axZ = new V3(PIER.d.x, 0, PIER.d.z);
      const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([a, b]) => [BOAT.x + axX.x * a * hw + axZ.x * b * hl, BOAT.z + axX.z * a * hw + axZ.z * b * hl]);
      foot.push({ n: items.length + 1, name: '@boat', layer: 'furniture', cx: BOAT.x, cz: BOAT.z, ox: BOAT.x, oz: BOAT.z, hx: hw, hz: hl, cs, sn, corners, block: true });
      foot.push({ n: items.length + 2, name: '@bucket', layer: 'furniture', cx: BUCKET.x, cz: BUCKET.z, ox: BUCKET.x, oz: BUCKET.z, hx: BUCKET.r, hz: BUCKET.r, cs: 1, sn: 0, corners: [], r: BUCKET.r, block: true });
    }
    if (shadows) casters.forEach((m) => shadows.addShadowCaster(m));
    LATE.shadows = shadows || null; // 이 뒤에 늦게 불러온 소품 모델은 바로 그림자에 넣는다
    // 크리스마스 트리 자리: 원 발자국(배치 검사)과 피해 갈 상자(고양이 길찾기)
    if (typeof OfficeXmas !== 'undefined' && OfficeXmas.active()) { // 트리가 서는 철에만 자리를 막는다 (철이 아니면 로비 한가운데를 그냥 지나다닌다)
      foot.push({ n: items.length, name: '@xmasTree', layer: 'furniture', cx: XMAS.x, cz: XMAS.z, ox: XMAS.x, oz: XMAS.z, hx: XMAS.r, hz: XMAS.r, cs: 1, sn: 0, corners: [], r: XMAS.r, block: true });
      obstacles.push({ n: items.length, name: '@xmasTree', min: new V3(XMAS.x - XMAS.r, 0, XMAS.z - XMAS.r), max: new V3(XMAS.x + XMAS.r, 4.4, XMAS.z + XMAS.r), c: new V3(XMAS.x, 2.2, XMAS.z) });
    }
    // 배치 규칙 검사: 어긴 곳이 있으면 시작할 때 바로 알린다
    const bad = checkLayout().concat(checkPaths());
    if (bad.length) console.warn(`배치 규칙 위반 ${bad.length}건\n` + bad.join('\n'));

    // 대표 책상 위 배달 상자 더미
    const boxTpl = tpl.get(JSON.stringify(['@box', null]));
    const pile = [];
    /**
     * 대표 책상 위에 배달 상자를 하나 쌓는다 (PILE 자리 순서대로, 최대 PILE.length 개).
     * @returns {boolean} 쌓았으면 true, 견본이 없거나 가득 차면 false
     */
    function pileAdd() {
      if (!boxTpl || pile.length >= PILE.length) return false;
      const b = boxTpl.createInstance('pile' + pile.length);
      b.parent = root;
      b.position.copyFrom(PILE[pile.length]);
      b.rotation.y = (pile.length * 0.7) % 0.5;
      b.isPickable = true;
      b.metadata = { bossDesk: true };
      pile.push(b);
      return true;
    }
    /**
     * 쌓인 배달 상자를 모두 지운다.
     * @returns {number} 지운 상자 수
     */
    function pileClear() { const n = pile.length; pile.splice(0).forEach((b) => b.dispose()); return n; }

    // 대표 책상 위 결재판 더미: 결재 요청 하나당 한 장. 쌓인 순서대로 올리고 맨 위부터 치운다 (최대 DROP.board.max 장까지 눈에 보임)
    const boardTpl = tpl.get(JSON.stringify(['@board', null]));
    const boards = [];
    /**
     * 대표 책상에 결재판 하나를 올린다 (더미 맨 위, 장마다 살짝 다른 각도·위치로 겹쳐 쌓는다).
     * @returns {boolean} 올렸으면 true, 견본이 없거나 더미가 가득(max)이면 false
     */
    function boardAdd() {
      const B = DROP.board, k = boards.length;
      if (!boardTpl || k >= B.max) return false;
      const b = boardTpl.createInstance('board' + k);
      b.parent = root;
      b.position.set(B.x + Math.sin(k * 2.3) * 0.025, B.y + k * B.dy, B.z + Math.cos(k * 1.7) * 0.02);
      b.rotation.y = Math.sin(k * 1.9) * 0.16;
      b.isPickable = true;
      b.metadata = { bossDesk: true };
      boards.push(b);
      return true;
    }
    /**
     * 책상 맨 위 결재판 하나를 치운다.
     * @returns {boolean} 치웠으면 true (더미가 비었으면 false)
     */
    function boardRemove() { const b = boards.pop(); if (b) b.dispose(); return !!b; }
    /**
     * 결재판을 모두 치운다.
     * @returns {number} 치운 장수
     */
    function boardClear() { const n = boards.length; boards.splice(0).forEach((b) => b.dispose()); return n; }

    /**
     * 공개 API 객체 ({@link OpenOfficeApi}).
     */
    return {
      root, spots, route, pathTo, sit, stand, release, update, xmas: XMAS,
      keepOut: { push: keepOut, exempt: keepOutExempt, gap: KEEP }, // 걷는 고양이의 물체 간격 띠 (OfficeCat.setKeepOut 에 넘긴다)
      setFrozen(v) { pondFrozen = !!v; }, frozen: () => pondFrozen, skating: (cat) => (SKATERS.get(cat) || {}).s || null,
      lights: LIGHTS, streetLamps: LIGHTS.street, ground: GROUND, checkPaths, checkLayout, checkWalls, smoke, walkPoints: WALK, bounds: B,
      // 유리벽 윗선 (라인 조명 자리): { x0, x1, z0, z1 }
      glassTops: WALLS.filter((w) => /유리벽/.test(w.name)).map((w) => ({ x0: w.x0, x1: w.x1, z0: w.z0, z1: w.z1 })), wallH: B.wallH,
      doors: DOORS.map((d) => ({ name: d.name, axis: d.axis, at: d.at, cx: d.axis === 'x' ? d.at : (d.g0 + d.g1) / 2, cz: d.axis === 'x' ? (d.g0 + d.g1) / 2 : d.at })),
      drop: DROP, boss: bossSpot, deliver: deliverSpot, pileAdd, pileClear, boxTemplate: boxTpl, boardAdd, boardRemove, boardCount: () => boards.length, boardClear,
      /**
       * 해금: 'catTower' 면 숨겨 둔 캣타워를 켠다.
       * @param {string} name 해금 이름
       * @returns {void}
       */
      unlock(name) { if (name === 'catTower' && instances[towerItem]) instances[towerItem].setEnabled(true); },
      /**
       * 종류별 자리 목록.
       * @param {string} kind 자리 종류
       * @returns {Spot[]} 해당 종류 자리들
       */
      byKind(kind) { return spots.filter((s) => s.kind === kind); },
      desks: spots.filter((s) => s.kind === 'desk'),
      center: new V3(16, 0, 12),
    };
  }

  /**
   * 모듈 공개 값: create(씬에 사무실 만들기)와 FACE(방향 이름 → rotY).
   */
  return { create, FACE };
})();
