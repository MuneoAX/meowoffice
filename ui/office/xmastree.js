/**
 * @file 크리스마스 트리 (OfficeXmas): 매년 11월 24일 ~ 12월 31일에만 로비 한가운데에 큰 트리와 선물 상자를 둔다.
 * 자리는 openoffice.js 의 XMAS(office.xmas)가 정하고, 배치 검사·고양이 피해 가기에 같은 원(반지름 1.3m)으로 들어가 있다.
 * 나무는 실제 잎이 달린 전나무 모델(models/props/xmas_fir.glb, Poly Haven CC0 — assets/licenses/polyhaven). 아래 가지 반지름 약 1.0m(가장 긴 가지 1.4m), 높이 약 4.6m — 벽(2.8m)보다 높아 천장 없는 사무실 위로 솟는다. 선물 상자는 가지 밑(높이 0.45m 아래)에 둔다.
 * 전구는 세 묶음(재질 셋)으로 나눠 박자를 엇갈려 반짝인다(밤에 잘 보이게 자체 발광). 같은 재질 메시는 합쳐 그리기 호출을 줄인다.
 * 공개 API: OfficeXmas.start({ scene, shadows, x, z, now? }) → { update(dt) } | null (시기가 아니면 null).
 * 개발용: 주소에 ?xmas=1 이면 시기와 상관없이 세운다, ?xmas=0 이면 세우지 않는다.
 * 전역 의존: BABYLON.
 */
'use strict';

const OfficeXmas = (() => {
  /**
   * 트리를 세울 시기인가 (매년 11월 24일 ~ 12월 31일, 로컬 날짜).
   * @param {Date} d 날짜
   * @returns {boolean}
   */
  function season(d) {
    const m = d.getMonth() + 1, day = d.getDate();
    return (m === 11 && day >= 24) || m === 12;
  }
  /**
   * 단색 재질.
   * @param {BABYLON.Scene} scene 장면
   * @param {string} name 이름
   * @param {string} hex 색
   * @param {number} [glow=0] 자체 발광 세기(0~1, 같은 색으로)
   * @returns {BABYLON.StandardMaterial}
   */
  function mat(scene, name, hex, glow = 0) {
    const m = new BABYLON.StandardMaterial(name, scene);
    const c = BABYLON.Color3.FromHexString(hex);
    m.diffuseColor = c;
    m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    if (glow) m.emissiveColor = c.scale(glow);
    return m;
  }
  /**
   * 트리를 세운다. 시기가 아니면 아무것도 만들지 않고 null.
   * @param {{scene: BABYLON.Scene, shadows?: BABYLON.ShadowGenerator, leafShadow?: boolean, x: number, z: number, now?: Date}} o 장면·그림자·자리 (leafShadow false 면 잎은 그림자를 드리우지 않는다)
   * @returns {?{update: function(number): void}}
   */
  function start(o) {
    if (!active(o.now)) return null;
    const { scene } = o;
    const root = new BABYLON.TransformNode('xmasTree', scene);
    root.position.set(o.x, 0, o.z);
    const meshes = [];
    /**
     * 메시를 트리에 붙이고 고르기(클릭)에서 뺀다.
     * @param {BABYLON.Mesh} m 메시
     * @returns {BABYLON.Mesh}
     */
    const add = (m) => { m.parent = root; m.isPickable = false; meshes.push(m); return m; };
    // 트리 받침 천(빨강 원) + 화분 받침
    const skirt = add(BABYLON.MeshBuilder.CreateCylinder('xmasSkirt', { diameter: 2.5, height: 0.02, tessellation: 28 }, scene));
    skirt.position.y = 0.012;
    skirt.material = mat(scene, 'xmasSkirtM', '#b8322e');
    const stand = add(BABYLON.MeshBuilder.CreateCylinder('xmasStand', { diameterTop: 0.42, diameterBottom: 0.5, height: 0.3, tessellation: 14 }, scene));
    stand.position.y = 0.17;
    stand.material = mat(scene, 'xmasStandM', '#c9a15a');
    /**
     * 다섯 꼭지 별 메시 (앞뒤로 볼록한 입체 별). 바깥 반지름 R, 안쪽 반지름 R·0.42, 가운데 두께 R·0.36.
     * @param {string} name 메시 이름
     * @param {number} R 바깥 반지름(m)
     * @returns {BABYLON.Mesh}
     */
    const starMesh = (name, R) => {
      const pos = [0, 0, R * 0.18, 0, 0, -R * 0.18], idx = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, r = i % 2 ? R * 0.42 : R;
        pos.push(Math.sin(a) * r, Math.cos(a) * r, 0);
      }
      for (let i = 0; i < 10; i++) { const p = 2 + i, q = 2 + ((i + 1) % 10); idx.push(0, p, q, 1, q, p); }
      const m = new BABYLON.Mesh(name, scene), vd = new BABYLON.VertexData();
      vd.positions = pos; vd.indices = idx; vd.normals = [];
      BABYLON.VertexData.ComputeNormals(pos, idx, vd.normals);
      vd.applyToMesh(m);
      m.convertToFlatShadedMesh();
      return m;
    };
    // 나무: 실제 잎이 달린 전나무 (Poly Haven 'Fir Sapling Medium', CC0 — scripts/build-xmas-fir.py 가 잎 카드를 솎아 가볍게 만든 것). 밑동을 화분 받침에 꽂는다
    const LIFT = 0.3, H = 4.3, top = LIFT + H;
    const wood = mat(scene, 'xmasWood', '#5d432c');
    const leaf = new BABYLON.StandardMaterial('xmasLeaf', scene);
    leaf.diffuseTexture = new BABYLON.Texture('models/props/xmas_fir_needles.webp', scene, { invertY: false, samplingMode: BABYLON.Texture.TRILINEAR_SAMPLINGMODE });
    leaf.diffuseTexture.hasAlpha = true;
    leaf.transparencyMode = BABYLON.Material.MATERIAL_ALPHATEST; leaf.alphaCutOff = 0.25; // 잎 사이는 뚫려 보이게 (알파 자르기 — 깊이 정렬 문제 없음)
    leaf.backFaceCulling = false; leaf.twoSidedLighting = true;
    leaf.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);
    leaf.emissiveColor = new BABYLON.Color3(0.07, 0.13, 0.07); // 그늘진 안쪽이 새까맣게 죽지 않게
    const parts = []; // 장식·받침·선물 (합친 메시들): 나무가 올 때까지 숨겨 둔다 — 잎 없이 장식만 허공에 뜨지 않게
    BABYLON.LoadAssetContainerAsync('models/props/xmas_fir.glb', scene).then((c) => {
      if (scene.isDisposed) { c.dispose(); return; }
      c.addAllToScene();
      parts.forEach((m) => m.setEnabled(true));
      const fir = c.meshes[0]; // __root__
      fir.parent = root; fir.position.y = LIFT;
      for (const m of c.meshes) {
        if (!m.getTotalVertices || !m.getTotalVertices()) continue;
        m.isPickable = false;
        m.material = /Needles/.test(m.name) ? leaf : wood;
        m.receiveShadows = true;
        if (o.shadows && (o.leafShadow !== false || !/Needles/.test(m.name))) o.shadows.addShadowCaster(m); // 낮은 화질에서는 잎(21만 삼각형)을 그림자에서 뺀다
      }
    }, (e) => console.warn('크리스마스 트리 모델을 불러오지 못했습니다', e && e.message));
    // 나무 겉모양: 높이 0.25m 부터 0.25m 칸마다 잎의 바깥 반지름 (build-xmas-fir.py 가 출력한 값). 장식은 이 겉면에 단다
    const FIR_PROFILE = [0.86, 0.95, 1.0, 0.88, 0.83, 0.87, 0.83, 0.84, 0.74, 0.6, 0.5, 0.47, 0.4, 0.35, 0.34, 0.32, 0.35];
    /**
     * 높이 y(트리 기준, m)에서 나무 겉면 반지름 (칸 사이는 선형 보간, 꼭대기로 갈수록 0).
     * @param {number} y 높이(m)
     * @returns {number} 반지름(m)
     */
    const radiusAt = (y) => {
      const f = Math.max(0, (y - LIFT - 0.375) / 0.25), i = Math.floor(f), n = FIR_PROFILE.length;
      if (i >= n - 1) return FIR_PROFILE[n - 1] * Math.max(0, 1 - (f - (n - 1)) / 1.5);
      return FIR_PROFILE[i] + (FIR_PROFILE[i + 1] - FIR_PROFILE[i]) * (f - i);
    };
    /**
     * 나무 겉면 위의 점 (높이 y, 방위각 a, 바깥으로 out m 띄움).
     * @param {number} y 높이(m)
     * @param {number} a 방위각(rad)
     * @param {number} out 겉면에서 띄울 거리(m)
     * @returns {BABYLON.Vector3}
     */
    const onTree = (y, a, out) => { const rr = radiusAt(y) * 0.94 + out; return new BABYLON.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr); };
    // 꼭대기 별: 다섯 꼭지 큰 별 (자체 발광, 천천히 돈다) + 받침 꼭지
    const starMat = mat(scene, 'xmasStarM', '#ffc93a', 0.85);
    starMat.backFaceCulling = false;
    const starBase0 = BABYLON.Color3.FromHexString('#ffc93a'); // 발광 기준 색 (update 가 세기를 주기적으로 바꾼다)
    const star = add(starMesh('xmasStar', 0.45));
    star.position.y = top + 0.3;
    star.material = starMat;
    star.setEnabled(false); parts.push(star);
    const starBase = add(BABYLON.MeshBuilder.CreateCylinder('xmasStarBase', { diameterTop: 0.05, diameterBottom: 0.1, height: 0.2, tessellation: 8 }, scene));
    starBase.position.y = top - 0.06;
    starBase.material = mat(scene, 'xmasStarBaseM', '#e0b03c', 0.35);
    // 장식 구성: 크고 반짝이는 공(빨강·연두·주황)을 골고루, 빨간 리본이 감아 오르고, 따뜻한 흰 전구가 온 나무에 반짝인다
    // 공: 높이 0.45m 간격 여덟 줄, 줄마다 둘레 0.62m 에 하나씩 (줄마다 엇갈리고 높이를 조금씩 흩는다)
    const BALL = ['#d92b2b', '#8fd61f', '#f29a1f'].map((c, i) => {
      const m = mat(scene, 'xmasBall' + i, c, 0.32);
      m.specularColor = new BABYLON.Color3(1, 1, 1); m.specularPower = 40; // 유리 공처럼 반짝
      return m;
    });
    let n = 0;
    for (let row = 0; row < 8; row++) {
      const y = LIFT + 0.6 + row * 0.45;
      const cnt = Math.max(3, Math.round((2 * Math.PI * radiusAt(y)) / 0.62));
      for (let k = 0; k < cnt; k++) {
        const b = add(BABYLON.MeshBuilder.CreateSphere('xmasBall', { diameter: 0.21 - row * 0.008, segments: 10 }, scene));
        b.position.copyFrom(onTree(y + ((k * 7 + row) % 3 - 1) * 0.09, (k / cnt) * Math.PI * 2 + row * 1.1, 0.06));
        b.material = BALL[(n + row) % BALL.length];
        n++;
      }
    }
    // 빨간 리본: 꼭대기에서 밑동까지 네 바퀴 감아 내려오는 띠 (가지 사이에서 살짝 처진다)
    {
      const up = [], dn = [], TURNS = 4, SEG = 220;
      for (let i = 0; i <= SEG; i++) {
        const f = i / SEG, a = f * TURNS * Math.PI * 2 + 0.6;
        const y = LIFT + 0.55 + (H - 0.95) * f + Math.sin(a * 5) * 0.035;
        const p = onTree(y, a, 0.07);
        up.push(new BABYLON.Vector3(p.x, p.y + 0.055, p.z)); dn.push(new BABYLON.Vector3(p.x, p.y - 0.055, p.z));
      }
      const rb = add(BABYLON.MeshBuilder.CreateRibbon('xmasRibbonBand', { pathArray: [dn, up], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene));
      rb.material = mat(scene, 'xmasRibbonBandM', '#e60012', 0.45);
    }
    // 전구 ①: 따뜻한 흰빛 알전구를 나무 겉에 고루 흩어 단다. 세 묶음이 엇갈려 은은하게 반짝인다
    const BULB = ['#fff6d0', '#ffe9a8', '#fffbe8'].map((c, i) => mat(scene, 'xmasBulb' + i, c, 1));
    const bulbBase = BULB.map((m) => m.emissiveColor.clone());
    for (let i = 0; i < 120; i++) {
      const f = (i + 0.5) / 120, y = LIFT + 0.4 + (H - 0.6) * Math.sqrt(f) ** 1.15; // 넓은 아래쪽에 더 많이
      const b = add(BABYLON.MeshBuilder.CreateSphere('xmasBulb', { diameter: 0.07, segments: 4 }, scene));
      b.position.copyFrom(onTree(Math.min(top - 0.15, y), i * 2.39996, 0.02 + (i % 3) * 0.02)); // 황금각으로 돌려 고르게
      b.material = BULB[i % BULB.length];
    }
    // 전구 ②: 발광 릴레이 — 나무를 감아 오르는 전구 줄(리본과 반대로 감는다). 열두 묶음(여섯 색 × 2)이 제각각 무작위 박자로 켜졌다 꺼진다
    // (순서대로 달리는 불빛은 기계적이라, 묶음마다 0.35~1.6초 사이 아무 때나 바뀌고 부드럽게 밝아졌다 어두워지게 했다)
    const RELAY = ['#ffd24a', '#ff5a4a', '#5ad1ff', '#7dff6a', '#ff8ad8', '#ffffff', '#ffd24a', '#ff5a4a', '#5ad1ff', '#7dff6a', '#ff8ad8', '#ffffff'].map((c, i) => mat(scene, 'xmasRelay' + i, c, 1));
    const relayState = RELAY.map((_, i) => ({ k: i % 2, on: i % 2 === 0, next: Math.random() * 1.2 })); // 묶음별 밝기 k(0~1)·켜짐 여부·다음에 바뀔 때까지 남은 시간
    const relayBase = RELAY.map((m) => m.emissiveColor.clone()), relayDiff = RELAY.map((m) => m.diffuseColor.clone());
    for (let i = 0; i < 132; i++) {
      const f = i / 131, y = LIFT + 0.45 + (H - 0.7) * f;
      const b = add(BABYLON.MeshBuilder.CreateSphere('xmasRelay', { diameter: 0.085, segments: 5 }, scene));
      b.position.copyFrom(onTree(y, -f * 5.5 * Math.PI * 2, 0.06));
      b.material = RELAY[(i * 5) % RELAY.length]; // 이웃 전구가 같은 묶음·같은 색 순서로 늘어서지 않게 섞는다
    }
    // 선물 상자: 가지 밑(0.45m 아래) 받침 천 위에 [각도, 거리, 가로, 높이, 세로, 상자 색, 리본 색]
    const GIFTS = [
      [0.3, 1.02, 0.34, 0.26, 0.3, '#c8323a', '#f2d15c'],
      [1.2, 1.06, 0.26, 0.2, 0.26, '#2f7d4f', '#f4efe4'],
      [2.0, 1.00, 0.3, 0.34, 0.28, '#3c64c8', '#f2d15c'],
      [2.8, 1.10, 0.22, 0.18, 0.22, '#f2d15c', '#c8323a'],
      [3.6, 1.02, 0.36, 0.24, 0.32, '#f4efe4', '#c8323a'],
      [4.5, 1.07, 0.24, 0.3, 0.24, '#8a4fc0', '#f4efe4'],
      [5.4, 1.00, 0.3, 0.22, 0.3, '#c8323a', '#2f7d4f'],
    ];
    const giftMats = new Map();
    const gm = (hex) => { if (!giftMats.has(hex)) giftMats.set(hex, mat(scene, 'xmasGift' + hex, hex)); return giftMats.get(hex); };
    for (const [a, d, w, h, dz, col, rib] of GIFTS) {
      const g = new BABYLON.TransformNode('xmasGift', scene); g.parent = root;
      g.position.set(Math.cos(a) * d, 0.02, Math.sin(a) * d);
      g.rotation.y = a * 1.7;
      const body = BABYLON.MeshBuilder.CreateBox('xmasGiftBox', { width: w, height: h, depth: dz }, scene);
      body.parent = g; body.position.y = h / 2; body.material = gm(col); body.isPickable = false; meshes.push(body);
      // 리본: 상자를 감는 띠 둘(+자) + 매듭
      for (const [rw, rd] of [[w + 0.012, 0.04], [0.04, dz + 0.012]]) {
        const r = BABYLON.MeshBuilder.CreateBox('xmasRibbon', { width: rw, height: h + 0.012, depth: rd }, scene);
        r.parent = g; r.position.y = h / 2; r.material = gm(rib); r.isPickable = false; meshes.push(r);
      }
      const bow = BABYLON.MeshBuilder.CreateSphere('xmasBow', { diameter: 0.08, segments: 4 }, scene);
      bow.parent = g; bow.position.y = h + 0.02; bow.scaling.set(1.4, 0.6, 1); bow.material = gm(rib); bow.isPickable = false; meshes.push(bow);
    }
    // 같은 재질끼리 합쳐 그리기 호출을 줄인다. 반짝임은 재질 단위라 그대로 동작한다
    const byMat = new Map();
    for (const m of meshes) if (m !== star) { if (!byMat.has(m.material)) byMat.set(m.material, []); byMat.get(m.material).push(m); }
    for (const [mt, list] of byMat) {
      const merged = list.length > 1 ? BABYLON.Mesh.MergeMeshes(list, true, true) : list[0];
      if (!merged) continue;
      merged.isPickable = false;
      merged.setEnabled(false); parts.push(merged);
      merged.receiveShadows = mt === skirt.material;
      if (o.shadows && [...giftMats.values()].includes(mt)) o.shadows.addShadowCaster(merged);
    }
    let t = 0;
    const tmp = new BABYLON.Color3();
    return {
      /**
       * 전구 반짝임·발광 릴레이, 별 돌기·주기적 발광.
       * @param {number} dt 지난 시간(초)
       * @returns {void}
       */
      update(dt) {
        t += dt;
        for (let i = 0; i < BULB.length; i++) {
          bulbBase[i].scaleToRef(0.55 + 0.45 * Math.max(0, Math.sin(t * 2.2 + i * 2.1)), tmp);
          BULB[i].emissiveColor.copyFrom(tmp);
        }
        // 발광 릴레이: 묶음마다 무작위 시간 뒤에 켜짐/꺼짐이 바뀌고, 밝기는 부드럽게 따라간다 (꺼진 전구는 어둡게)
        for (let i = 0; i < RELAY.length; i++) {
          const st = relayState[i];
          st.next -= dt;
          if (st.next <= 0) { st.on = !st.on; st.next = 0.35 + Math.random() * 1.25; }
          st.k += ((st.on ? 1 : 0) - st.k) * Math.min(1, dt * 7);
          relayBase[i].scaleToRef(0.08 + 0.92 * st.k, RELAY[i].emissiveColor);
          relayDiff[i].scaleToRef(0.35 + 0.65 * st.k, RELAY[i].diffuseColor);
        }
        star.rotation.y = t * 0.6;
        // 별 발광: 2.6초마다 한 번 천천히 밝아졌다 어두워진다 (밝은 구간 약 1.2초, 사이에는 은은하게)
        const ph = (t % 2.6) / 2.6, pulse = ph < 0.46 ? Math.sin((ph / 0.46) * Math.PI) ** 2 : 0;
        starBase0.scaleToRef(0.3 + 0.9 * pulse, starMat.emissiveColor);
      },
    };
  }
  /**
   * 지금 트리를 세우는가 (주소의 ?xmas=1/0 이 시기보다 먼저). openoffice.js 가 트리 자리를 막을지 정할 때도 쓴다.
   * @param {Date} [now] 기준 시각
   * @returns {boolean}
   */
  function active(now) {
    const q = new URLSearchParams(location.search).get('xmas');
    return q === '1' || (q !== '0' && season(now || new Date()));
  }
  return { start, season, active };
})();
