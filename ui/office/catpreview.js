/**
 * @file 고양이 미리보기 (OfficeCatPreview): 새 대화 창에서 고른 고양이(품종)를 작은 화면에 앉혀 놓고 천천히 360도 돌려 보여 준다.
 * 사무실 장면 안, 땅 밑 먼 곳에 미리보기용 고양이와 방석을 두고 전용 카메라로 렌더 타깃(RenderTargetTexture)에 그린 뒤,
 * 그 픽셀을 읽어 2D 캔버스에 옮긴다 (엔진이 하나라 다른 캔버스에 직접 그릴 수 없어서). 창을 닫으면 모두 치운다.
 * 조명은 미리보기 전용 반구 조명 + 카메라 쪽 주 조명만 받는다(낮밤과 상관없이 같은 밝기) — 장면의 다른 조명에서는 뺀다.
 * 공개 API: OfficeCatPreview.create(scene) → { show(canvas, breed), set(breed), hide(), turn(dx, dy) }.
 * 전역 의존: BABYLON, OfficeCat, CatModel.
 */
'use strict';

const OfficeCatPreview = (() => {
  const SIZE = 512; // 렌더 타깃 한 변(px) — 화면에는 줄여서 보여 가장자리가 매끈하다
  const BG = [0.925, 0.914, 0.988]; // 미리보기 바탕색 (#ece9fc, chat.css .chat-catpv 와 같은 색) — 투명 바탕은 가장자리에 검은 테가 생겨 불투명으로 칠한다
  const GAMMA = new Uint8ClampedArray(256).map((_, i) => Math.round(255 * Math.pow(i / 255, 1 / 2.2))); // 선형 → 화면 밝기 표
  const SPOT = new BABYLON.Vector3(0, -60, -200); // 미리보기 무대 자리: 땅 밑 먼 곳 (사무실 화면에 안 보임)
  /**
   * 미리보기 만들기.
   * @param {BABYLON.Scene} scene 사무실 장면
   * @returns {{show: function(HTMLCanvasElement, string): void, set: function(string): void, hide: function(): void, turn: function(number, number): void}}
   */
  function create(scene) {
    let cat = null, canvas = null, ctx = null, rtt = null, cam = null, light = null, key = null, stool = null, obs = null, busy = false, last = 0, angle = 0, img = null, pitch = 0.16, hold = 0; // pitch: 카메라 올려다보는 각(rad), hold: 손으로 돌린 뒤 저절로 돌기를 쉬는 남은 시간(초)
    const excluded = []; // [조명, 메시] — 닫을 때 되돌린다
    const swapped = []; // [메시, 원래 재질, 미리보기용 사본] — 고양이를 치울 때 되돌린다
    /**
     * 미리보기 메시를 장면의 다른 조명에서 빼고 전용 조명에만 넣는다.
     * @param {BABYLON.AbstractMesh[]} meshes 미리보기 메시들
     * @returns {void}
     */
    const isolate = (meshes) => {
      for (const l of scene.lights) {
        if (l === light || l === key) continue;
        for (const m of meshes) if (!l.excludedMeshes.includes(m)) { l.excludedMeshes.push(m); excluded.push([l, m]); }
      }
      light.includedOnlyMeshes = meshes.slice();
      key.includedOnlyMeshes = meshes.slice();
    };
    /**
     * 지금 미리보기 고양이를 치운다 (조명 제외 목록도 되돌림).
     * @returns {void}
     */
    const dropCat = () => {
      for (const [l, m] of excluded.splice(0)) { const i = l.excludedMeshes.indexOf(m); if (i >= 0) l.excludedMeshes.splice(i, 1); }
      for (const [m, orig, copy] of swapped.splice(0)) { m.material = orig; copy.dispose(false, false); } // 사본만 지운다 (털 무늬 텍스처는 품종 공용이라 남긴다)
      if (cat) { OfficeCat.remove(cat); cat = null; }
    };
    /**
     * 고양이를 바꾼다. 품종이 빈 문자열이면('아무나') 어느 고양이인지 모르는 회색 실루엣을 보인다.
     * @param {string} breed 품종 키 (또는 '')
     * @returns {void}
     */
    function set(breed) {
      if (!rtt) return;
      dropCat();
      const any = !breed; // '아무나': 어느 고양이인지 모르는 회색 실루엣(물음표 밑에 깔린다)
      if (typeof CatModel !== 'undefined' && CatModel.ready()) {
        cat = OfficeCat.create(scene, { id: '__preview', breed: breed || 'korean_cheese' });
        cat.root.position.copyFrom(SPOT);
        OfficeCat.setPose(cat, 'sit', 0.5);
        OfficeCat.setAct(cat, 'idle');
        cat.heading = angle; cat.root.rotation.y = angle;
        // 품종 재질은 얼려 둔 공용 재질이라(사무실 조명 구성에 맞춰 굳어 있음) 미리보기 조명을 받지 못해 까맣게 나온다 → 얼리지 않은 사본으로 바꿔 입힌다
        for (const m of cat.root.getChildMeshes(false)) {
          m.isPickable = false;
          if (!m.material) continue;
          // clone() 은 텍스처까지 새로 만들어 무늬가 어긋나므로, 같은 텍스처 객체를 그대로 물린 새 재질을 만든다
          const copy = new BABYLON.StandardMaterial('previewMat:' + m.material.name, scene);
          if (any) { // 무늬·명암 없이 한 가지 회색으로만 칠한다
            copy.disableLighting = true; copy.diffuseColor = BABYLON.Color3.Black(); copy.specularColor = BABYLON.Color3.Black();
            copy.emissiveColor = BABYLON.Color3.FromHexString('#c4c4cc').toLinearSpace();
          } else {
            copy.diffuseTexture = m.material.diffuseTexture || null;
            if (m.material.diffuseColor) copy.diffuseColor = m.material.diffuseColor.clone();
            if (m.material.emissiveColor) copy.emissiveColor = m.material.emissiveColor.clone();
            copy.specularColor = m.material.specularColor ? m.material.specularColor.clone() : new BABYLON.Color3(0.05, 0.05, 0.05);
          }
          copy.backFaceCulling = m.material.backFaceCulling; copy.alpha = m.material.alpha;
          copy.metadata = { shared: true }; // OfficeCat.remove 가 지우지 않게 (여기서 따로 지운다)
          swapped.push([m, m.material, copy]);
          m.material = copy;
        }
      }
      const meshes = (cat ? cat.root.getChildMeshes(false) : []).concat([stool]);
      rtt.renderList = meshes;
      isolate(meshes);
    }
    /**
     * 미리보기를 켠다: 무대·카메라·조명·렌더 타깃을 만들고 매 프레임 고양이를 돌리며 캔버스에 옮긴다.
     * @param {HTMLCanvasElement} cv 그릴 2D 캔버스
     * @param {string} breed 처음 보일 품종 ('' 면 회색 실루엣)
     * @returns {void}
     */
    function show(cv, breed) {
      hide();
      canvas = cv; canvas.width = canvas.height = SIZE; ctx = canvas.getContext('2d');
      img = ctx.createImageData(SIZE, SIZE);
      stool = BABYLON.MeshBuilder.CreateCylinder('previewStool', { diameterTop: 0.62, diameterBottom: 0.54, height: 0.5, tessellation: 24 }, scene);
      stool.position.set(SPOT.x, SPOT.y + 0.25, SPOT.z); stool.isPickable = false;
      const sm = new BABYLON.StandardMaterial('previewStoolM', scene);
      sm.diffuseColor = BABYLON.Color3.FromHexString('#b8a8ff').toLinearSpace(); sm.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
      stool.material = sm;
      light = new BABYLON.HemisphericLight('previewLight', new BABYLON.Vector3(0.3, 1, -0.6), scene);
      light.intensity = 0.9; light.groundColor = new BABYLON.Color3(0.4, 0.4, 0.45); // 어두운 털(러시안 블루·턱시도)도 색이 보이게 넉넉히
      key = new BABYLON.DirectionalLight('previewKey', new BABYLON.Vector3(0.35, -0.55, 1), scene); // 카메라 쪽에서 비추는 주 조명
      key.intensity = 0.3; key.specular = new BABYLON.Color3(0.1, 0.1, 0.1);
      cam = new BABYLON.FreeCamera('previewCam', new BABYLON.Vector3(SPOT.x, SPOT.y + 1.12, SPOT.z - 1.7), scene);
      aim();
      cam.fov = 0.62; cam.minZ = 0.1; cam.maxZ = 20;
      cam.freezeProjectionMatrix(BABYLON.Matrix.PerspectiveFovLH(cam.fov, 1, cam.minZ, cam.maxZ)); // 정사각 화면 비율로 고정 — 안 하면 사무실 창 비율(가로로 긴)로 계산돼 고양이가 가로로 눌려 보인다
      rtt = new BABYLON.RenderTargetTexture('previewRtt', SIZE, scene, false);
      rtt.activeCamera = cam;
      rtt.samples = 4; // 가장자리 계단 줄이기 (MSAA)
      rtt.clearColor = new BABYLON.Color4(Math.pow(BG[0], 2.2), Math.pow(BG[1], 2.2), Math.pow(BG[2], 2.2), 1); // 옮길 때 감마를 되돌리므로 바탕색은 미리 선형 값으로
      scene.customRenderTargets.push(rtt);
      set(breed);
      obs = scene.onBeforeRenderObservable.add(() => {
        const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
        if (hold > 0) hold -= dt; else angle += dt * 0.9; // 약 7초에 한 바퀴 (손으로 돌린 직후에는 잠깐 멈춘다)
        if (cat) { cat.heading = angle; cat.root.rotation.y = angle; cat.root.position.x = SPOT.x; cat.root.position.z = SPOT.z; OfficeCat.update(cat, dt); cat.root.rotation.y = angle; }
        stool.rotation.y = angle;
      });
      rtt.onAfterRenderObservable.add(() => {
        const now = performance.now();
        if (busy || now - last < 45 || !ctx) return; // 초당 20번쯤만 옮긴다
        const p = rtt.readPixels();
        if (!p) return;
        busy = true; last = now;
        p.then((buf) => {
          busy = false;
          if (!ctx || !buf) return;
          const row = SIZE * 4, d = img.data;
          // 위아래를 뒤집고, 렌더 타깃에 선형 밝기로 그려진 값을 화면용(감마 2.2)으로 되돌린다 — 안 하면 어두운 털(러시안 블루 등)이 새까맣게 나온다
          for (let y = 0; y < SIZE; y++) {
            const src = (SIZE - 1 - y) * row, dst = y * row;
            for (let x = 0; x < row; x += 4) { d[dst + x] = GAMMA[buf[src + x]]; d[dst + x + 1] = GAMMA[buf[src + x + 1]]; d[dst + x + 2] = GAMMA[buf[src + x + 2]]; d[dst + x + 3] = 255; }
          }
          ctx.putImageData(img, 0, 0);
        }, () => { busy = false; });
      });
    }
    /**
     * 카메라를 지금 pitch 에 맞춰 고양이 둘레(거리 1.72m)에 놓고 고양이 가슴께를 보게 한다.
     * @returns {void}
     */
    function aim() {
      const D = 1.72, ty = SPOT.y + 0.84;
      cam.position.set(SPOT.x, ty + Math.sin(pitch) * D, SPOT.z - Math.cos(pitch) * D);
      cam.setTarget(new BABYLON.Vector3(SPOT.x, ty, SPOT.z));
    }
    /**
     * 손으로 돌리기 (미리보기를 끌 때): 좌우로 끌면 고양이가 돌고, 위아래로 끌면 카메라가 오르내린다. 놓으면 2.5초 뒤 다시 저절로 돈다.
     * @param {number} dx 가로로 끈 거리(px)
     * @param {number} dy 세로로 끈 거리(px)
     * @returns {void}
     */
    function turn(dx, dy) {
      if (!rtt) return;
      angle += dx * 0.012; // 끄는 쪽으로 고양이 앞면이 따라온다
      pitch = Math.max(-0.15, Math.min(0.9, pitch + dy * 0.006));
      hold = 2.5;
      aim();
    }
    /**
     * 미리보기를 끄고 만든 것을 모두 치운다.
     * @returns {void}
     */
    function hide() {
      if (!rtt) return;
      if (obs) { scene.onBeforeRenderObservable.remove(obs); obs = null; }
      dropCat();
      const i = scene.customRenderTargets.indexOf(rtt);
      if (i >= 0) scene.customRenderTargets.splice(i, 1);
      rtt.dispose(); rtt = null;
      cam.dispose(); cam = null;
      light.dispose(); light = null;
      key.dispose(); key = null;
      if (stool.material) stool.material.dispose();
      stool.dispose(); stool = null;
      canvas = null; ctx = null; img = null; busy = false;
    }
    return { show, set, hide, turn };
  }
  return { create };
})();
