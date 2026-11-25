/**
 * @file Kenney Furniture Kit·Nature Kit 꽃(CC0) glb 를 인스턴스용 견본 메쉬로 바꾸는 로더 (Kenney).
 * Kenney Furniture Kit·Nature Kit 꽃(flower_*)(CC0) glb → 인스턴스용 견본 메쉬.
 * 모델 하나를 한 번만 불러 메쉬 하나로 합치고, 재질은 이름으로 우리 팔레트에 다시 묶는다.
 * 원점: 바닥 중앙으로 다시 맞춤, 정면 -Z. 크기: Kenney 1단위 = 2m.
 * 공개 API: SCALE, get(견본 하나 불러오기), compose(여러 모델 묶기), size(크기 재기).
 * @see OfficePalette.mat
 *
 * @typedef {Object<string, Array>} MatOverride 재질 바꿔치기 표. 키 = Kenney 재질 이름, 값 = [팔레트 색 이름, 재질 옵션(MatOpts, 선택)]
 *
 * @typedef {Object} ComposeItem compose() 의 부품 하나
 * @property {string} model glb 모델 이름 (models/kenney/<이름>.glb)
 * @property {number[]} [at=[0,0,0]] 위치 [x,y,z] (m)
 * @property {number} [rotY=0] Y축 회전 (라디안)
 * @property {number} [scale] 균등 배율 (없으면 그대로)
 * @property {MatOverride} [override] 이 부품만 쓸 재질 바꿔치기 표
 */
'use strict';

const Kenney = (() => {
  /**
   * glb 폴더 (ui 기준 상대 경로).
   * @type {string}
   */
  const BASE = 'models/kenney/';
  /**
   * 크기 배율: Kenney 1단위 = 2 m.
   * @type {number}
   */
  const SCALE = 2;
  /**
   * Babylon 3차원 벡터 약칭.
   */
  const V3 = BABYLON.Vector3;

  /**
   * Kenney 재질 이름 → 팔레트 색 이름 [, 재질 옵션(MatOpts)] 표. 표에 없는 이름은 'white' 로 처리한다.
   * 예: glass 는 ['glass', { alpha: 0.4 }] = 투명도 0.4, lamp 는 발광 0.6.
   * @type {MatOverride}
   */
  const MAT = {
    wood: ['wood'],
    woodDark: ['woodDark'],
    metal: ['metal'],
    metalLight: ['white'],
    metalMedium: ['metal'],
    metalDark: ['dark'],
    carpet: ['fabricBlue'],
    carpetBlue: ['fabricBlue'],
    carpetWhite: ['white'],
    carpetDarker: ['rugDark'],
    plant: ['leaf'],
    glass: ['glass', { alpha: 0.4 }],
    lamp: ['lampShade', { emissive: 0.6 }],
    fur: ['woodDark'],
    // Nature Kit 꽃(flower_*): 줄기·잎 + 꽃잎 색 + 꽃 속(C형)
    grass: ['leaf'],
    colorPurple: ['flowerPurple'],
    colorRed: ['flowerRed'],
    colorYellow: ['flowerYellow'],
    colorWhite: ['flowerWhite'],
    _defaultMat: ['white'],
  };

  /**
   * 원본 법선이 안쪽을 향하는 모델 이름 집합 (필요할 때 추가). 여기 있으면 loadOne 이 면을 뒤집는다.
   * @type {Set<string>}
   */
  const FLIP_NORMALS = new Set([]);

  /**
   * 견본 캐시: 키(이름 + override JSON) → 숨긴 견본 메쉬를 담은 Promise.
   * @type {Map<string, Promise<BABYLON.Mesh>>}
   */
  const raw = new Map(); // name → Promise<Mesh> (숨긴 견본)

  /**
   * Kenney 재질 이름을 우리 팔레트 재질로 바꾼다.
   * override 에 이름이 있으면 그것을, 없으면 MAT 표를, 그것도 없으면 ['white'] 를 써서 OfficePalette.mat 으로 재질을 얻는다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} kenneyName 원본 재질 이름 (재질이 없으면 '_defaultMat')
   * @param {MatOverride} [override] 재질 바꿔치기 표
   * @returns {BABYLON.Material} 팔레트의 공용 재질
   * @see OfficePalette.mat
   */
  function remap(scene, kenneyName, override) {
    const spec = (override && override[kenneyName]) || MAT[kenneyName] || ['white'];
    return OfficePalette.mat(scene, spec[0], spec[1]);
  }

  /**
   * 모델 하나를 불러 합친 메쉬(숨김)로. override: { kenney재질이름: [팔레트이름, 옵션] }
   * glb 를 컨테이너로 읽어 장면에 넣고, 루트를 SCALE 배로 키우고, 정점 있는 부품의 재질을 팔레트로 바꾼다.
   * 부품이 하나면 변환만 정점에 굽고, 여럿이면 MergeMeshes 로 합친다. 이어서 정면을 +Z→-Z 로 반 바퀴 돌리고 바닥 중앙을 원점으로 맞춘다.
   * 원본 재질·텍스처는 지우고, 결과는 이름을 'kenney:<이름>' 으로 하고 숨긴다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name glb 모델 이름
   * @param {MatOverride} [override] 재질 바꿔치기 표
   * @returns {Promise<BABYLON.Mesh>} 숨긴 견본 메쉬 (원점 = 바닥 중앙, 정면 -Z)
   * @see remap
   */
  async function loadOne(scene, name, override) {
    const c = await BABYLON.LoadAssetContainerAsync(BASE + name + '.glb', scene);
    c.addAllToScene();
    const root = c.meshes.find((m) => m.name === '__root__');
    if (root) root.scaling.scaleInPlace(SCALE);
    const parts = c.meshes.filter((m) => m.getTotalVertices() > 0);
    for (const m of parts) {
      m.material = remap(scene, m.material ? m.material.name : '_defaultMat', override);
      m.computeWorldMatrix(true);
    }
    let merged;
    if (parts.length === 1) {
      // 부품 하나짜리는 합치기를 거치면 검게 나온다: 변환만 정점에 굽는다
      merged = parts[0];
      merged.setParent(null);
      merged.bakeCurrentTransformIntoVertices();
      // glTF 에서 온 사원수 회전이 남아 있으면 인스턴스의 rotation.y 가 무시된다
      merged.rotationQuaternion = null;
    } else {
      merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    }
    for (const m of c.meshes) if (m !== merged && !m.isDisposed()) m.dispose();
    c.materials.forEach((m) => m.dispose(true, true));
    c.textures.forEach((t) => t.dispose());
    // Kenney 정면은 +Z. 우리 규칙(정면 -Z)에 맞게 반 바퀴 돌린 뒤 바닥 중앙 원점
    merged.bakeTransformIntoVertices(BABYLON.Matrix.RotationY(Math.PI));
    merged.refreshBoundingInfo();
    const bb = merged.getBoundingInfo().boundingBox;
    merged.bakeTransformIntoVertices(BABYLON.Matrix.Translation(
      -(bb.minimum.x + bb.maximum.x) / 2, -bb.minimum.y, -(bb.minimum.z + bb.maximum.z) / 2));
    merged.refreshBoundingInfo();
    if (FLIP_NORMALS.has(name)) merged.flipFaces(true);
    merged.name = 'kenney:' + name;
    merged.isVisible = false;
    return merged;
  }

  /**
   * 견본 메쉬를 얻는다 (같은 이름·override 면 한 번만 불러 Promise 를 재사용).
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name glb 모델 이름
   * @param {MatOverride} [override] 재질 바꿔치기 표
   * @returns {Promise<BABYLON.Mesh>} 숨긴 견본 메쉬
   * @see loadOne
   */
  function get(scene, name, override) {
    const key = name + (override ? JSON.stringify(override) : '');
    if (!raw.has(key)) raw.set(key, loadOne(scene, name, override));
    return raw.get(key);
  }

  /**
   * 크기(m): {x, y, z}
   * 메쉬 경계 상자의 최대 - 최소를 구한다.
   * @param {BABYLON.Mesh} mesh 견본 메쉬
   * @returns {BABYLON.Vector3} 가로(x)·높이(y)·깊이(z) 크기(m)
   */
  function size(mesh) {
    const bb = mesh.getBoundingInfo().boundingBox;
    return bb.maximum.subtract(bb.minimum);
  }

  /**
   * 여러 모델을 한 견본으로 묶기.
   * items 순서대로 견본을 복제해 위치·회전·배율을 주고 MergeMeshes 로 하나로 합친다. 합친 결과는 이름을 name 으로 하고 숨긴다.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name 합친 견본 이름
   * @param {ComposeItem[]} items 부품 목록 [{ model, at:[x,y,z], rotY, scale, override }]
   * @returns {Promise<BABYLON.Mesh>} 숨긴 합친 견본 메쉬
   * @see get
   */
  async function compose(scene, name, items) {
    const parts = [];
    for (const it of items) {
      const src = await get(scene, it.model, it.override);
      const m = src.clone(name + ':' + it.model);
      m.isVisible = true;
      m.position = V3.FromArray(it.at || [0, 0, 0]);
      m.rotation.y = it.rotY || 0;
      if (it.scale) m.scaling.setAll(it.scale);
      m.computeWorldMatrix(true);
      parts.push(m);
    }
    const merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    merged.name = name;
    merged.isVisible = false;
    return merged;
  }

  /**
   * 공개 API: SCALE, get, compose, size.
   */
  return { SCALE, get, compose, size };
})();
