/**
 * @file 사무실 공용 재질 묶음 (OfficePalette).
 * 공용 재질 묶음. 같은 색은 재질 하나를 같이 써서 그리기 호출을 줄인다.
 * 색 이름 표(COLORS)와, 이름으로 StandardMaterial 을 만들어 캐시하는 mat(), 타일 바닥 재질을 만드는 tiles() 를 제공한다.
 * @see OfficePalette.COLORS
 * @see OfficePalette.mat
 * @see OfficePalette.tiles
 *
 * @typedef {Object} MatOpts mat() 재질 옵션 (모두 선택)
 * @property {number} [alpha] 투명도 0~1 (주면 backFaceCulling 도 끈다)
 * @property {number} [emissive] 자체 발광 세기 0~1 (색 × 이 값을 emissiveColor 로)
 * @property {boolean} [twoSided] true 면 뒷면도 그린다
 *
 * @typedef {Object} TileOpts tiles() 옵션 (모두 선택)
 * @property {number} [tile=0.6] 타일 한 변 길이(m)
 * @property {string} [base='#ece5d9'] 타일 바탕 색(#rrggbb)
 * @property {string} [grout='#cdc3b3'] 줄눈 색(#rrggbb)
 * @property {number} [seed=7] 타일 밝기 무작위 씨앗 (같은 값이면 같은 무늬)
 */
'use strict';

const OfficePalette = (() => {
  /**
   * 색 이름 → 색(sRGB 16진수 '#rrggbb') 표. mat(scene, 이름) 의 이름이 이 표의 키다.
   * 바닥·벽·가구·식물 같은 사무실 구성물과 소품 색을 한곳에 모았다.
   * @type {Object<string, string>}
   */
  const COLORS = {
    floor: '#d9b98f',
    floorEdge: '#d8bd96',
    wall: '#f6f3f0',
    wallTop: '#e9e4df',
    wallBase: '#ebe6e1',
    glass: '#e3f0fa',
    frame: '#c9ced8',
    wood: '#e2c49b',
    woodDark: '#b98f63',
    white: '#fbfaf8',
    dark: '#3b3f4a',
    lampBody: '#2b2f38', lampBulb: '#fff1cf', screenOff: '#16181d',
    metal: '#a7adb8',
    screen: '#5d8fd8',
    fabricBlue: '#7d9cc4',
    fabricCream: '#efe6da',
    rug: '#c9d6e6',
    corridor: '#efebe7',
    facade: '#f7f5f3',
    facadeGlass: '#a9bfdc',
    ground: '#b3d496',
    lawn: '#b3d496',
    trunk: '#a98462',
    leafLight: '#8cc47f',
    slabEdge: '#d9d6df',
    slotEmpty: '#e1dde6',
    floorRest: '#e4d9c8',
    floorLounge: '#e2c9a6',
    floorMeet: '#e3e0ea',
    tile: '#f1ede6',
    path: '#e9dfc9',
    pathEdge: '#d6c9ad',
    water: '#86bfe0',
    sand: '#e2d6b8',
    stone: '#c3bfb6',
    stoneDark: '#a7a299',
    statue: '#dcd8cf',
    soil: '#a88a6a',
    pine: '#5e9e6a',
    flowerPink: '#f2a7b8',
    flowerYellow: '#f5d76e',
    flowerWhite: '#fbf8f2',
    flowerPurple: '#b9a4ee',
    flowerRed: '#ec8b8b',
    flowerWilt: '#b48a72', // 가을 시든 꽃잎
    flowerWiltLight: '#cdb07c',
    leafWilt: '#a7a160', // 가을 시든 잎
    floorCeo: '#cfa77a',
    courtPave: '#e6e0d2',
    nameplate: '#3b3f4a',
    gold: '#e0b65a',
    stampPad: '#7a2d2a',
    stampRed: '#d4483b',
    rugBoss: '#b5463e',
    rugBossDark: '#8f3530',
    bossChair: '#7a3b33',
    hill: '#9cc785',
    rope: '#d8c09a',
    cardboard: '#d9b07c',
    tape: '#c99558',
    smoke: '#6f7480',
    rugDark: '#a9bad0',
    leaf: '#74b26d',
    leafDark: '#4f9150',
    pot: '#efe9e2',
    lampShade: '#fff4dc',
    book1: '#e7a3a0', book2: '#8fb3d9', book3: '#f2cf8a', book4: '#a8cfa4', book5: '#b9a7d6',
    art: '#b8d3e8',
  };

  /**
   * 재질 캐시: 키(이름 + 옵션 JSON) → BABYLON.StandardMaterial.
   * @type {Map<string, BABYLON.StandardMaterial>}
   */
  const cache = new Map();

  /**
   * '#rrggbb' 문자열을 Babylon 색으로 바꾼다.
   * @param {string} c 16진수 색 문자열
   * @returns {BABYLON.Color3} 변환된 색
   */
  function hex(c) { return BABYLON.Color3.FromHexString(c); }

  /**
   * 이름으로 공용 재질을 얻는다 (같은 이름·옵션이면 캐시된 재질을 그대로 돌려줌).
   * 없으면 StandardMaterial 을 만들어 diffuse 를 COLORS 색으로, specular 를 아주 약하게(0.06) 두고 투명·발광·양면 옵션을 적용한 뒤 freeze 해서 캐시한다.
   * @param {BABYLON.Scene} scene 재질을 만들 장면
   * @param {string} name COLORS 의 키
   * @param {MatOpts} [opts={}] alpha, emissive(0~1), twoSided
   * @returns {BABYLON.StandardMaterial} 얼려 둔 공용 재질
   * @see hex
   */
  function mat(scene, name, opts = {}) {
    const key = name + JSON.stringify(opts);
    if (cache.has(key)) return cache.get(key);
    const m = new BABYLON.StandardMaterial('m_' + key, scene);
    m.diffuseColor = hex(COLORS[name]);
    m.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
    if (opts.alpha != null) {
      m.alpha = opts.alpha;
      m.backFaceCulling = false;
    }
    if (opts.emissive) m.emissiveColor = hex(COLORS[name]).scale(opts.emissive);
    if (opts.twoSided) m.backFaceCulling = false;
    m.freeze();
    cache.set(key, m);
    return m;
  }

  /**
   * 타일 바닥 재질: w×d m 면에 한 변 tile m 짜리 데코타일 (색 조금씩 다르게 + 줄눈). 면마다 따로 만든다.
   * 512px 캔버스(8×8 칸)에 칸마다 밝기를 조금(0.94~1.02배) 달리 칠하고 줄눈 선을 그린 DynamicTexture 를 만든 뒤,
   * uScale/vScale 을 면 크기 ÷ (8 × tile) 로 두어 한 변이 tile m 가 되게 반복시킨다. 캐시하지 않으므로 면마다 호출한다.
   * @param {BABYLON.Scene} scene 재질을 만들 장면
   * @param {string} name 텍스처·재질 이름에 붙일 구분 이름
   * @param {number} w 면의 가로(m)
   * @param {number} d 면의 세로(m)
   * @param {TileOpts} [opts] tile, base, grout, seed
   * @returns {BABYLON.StandardMaterial} 얼려 둔 타일 재질
   * @see hex
   */
  function tiles(scene, name, w, d, { tile = 0.6, base = '#ece5d9', grout = '#cdc3b3', seed = 7 } = {}) {
    const N = 8, S = 512, px = S / N;
    const tex = new BABYLON.DynamicTexture('t_' + name, { width: S, height: S }, scene, true);
    const ctx = tex.getContext();
    const b = hex(base);
    let r = seed;
    /**
     * 선형 합동 생성기(seed 로 시작) 난수. 같은 seed 면 같은 타일 무늬가 나온다.
     * @returns {number} 0 이상 1 미만의 값
     */
    const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const k = 0.94 + rnd() * 0.08; // 타일마다 밝기 조금씩
      ctx.fillStyle = `rgb(${Math.round(b.r * 255 * k)},${Math.round(b.g * 255 * k)},${Math.round(b.b * 255 * k)})`;
      ctx.fillRect(i * px, j * px, px, px);
    }
    ctx.strokeStyle = grout;
    ctx.lineWidth = 3;
    for (let i = 0; i <= N; i++) {
      ctx.beginPath(); ctx.moveTo(i * px, 0); ctx.lineTo(i * px, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * px); ctx.lineTo(S, i * px); ctx.stroke();
    }
    tex.update();
    tex.wrapU = tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = w / (N * tile);
    tex.vScale = d / (N * tile);
    tex.anisotropicFilteringLevel = 8;
    const m = new BABYLON.StandardMaterial('m_tiles_' + name, scene);
    m.diffuseTexture = tex;
    m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    m.freeze();
    return m;
  }

  /**
   * 공개 API: COLORS(색 표), mat(공용 재질), hex(색 변환), tiles(타일 바닥 재질).
   */
  return { COLORS, mat, hex, tiles };
})();
