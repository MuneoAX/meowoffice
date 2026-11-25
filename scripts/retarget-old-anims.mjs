// 옛 고양이 모델의 동작(사람 손으로 만든 고양이용: 마시기·자기·그루밍·상자 나르기 등)을 새 AI 고양이 뼈대(Mixamo 이름)로 옮긴다.
// 사용자 2026-11-25: "프리셋 없을 거야, 기존 동작 좌표계를 활용해서 적용해야 돼".
//   node scripts/retarget-old-anims.mjs <새 모델.glb> <옛 모델.glb> <출력.glb> [동작,동작...=전부] [--replace]
// 방법(두 모델 모두 앞 +Z, 위 +Y, 왼쪽 +X):
//   - 몸통·머리·손·발: 옛 뼈의 '쉬는 자세 대비 월드 회전 변화량'을 새 뼈의 쉬는 자세에 곱한다(비틀림·기울기 그대로).
//   - 팔·다리·허리·목: 위 결과에서 뼈가 가리키는 방향만 옛 뼈의 방향(관절→다음 관절)에 맞춘다 → 손이 입·상자에 닿는 자리가 같다.
//   - 엉덩이 이동: 쉬는 자리에서 움직인 만큼을 엉덩이 높이 비율로 줄이거나 늘린다.
// 옛 모델에만 있는 뼈(꼬리·귀)는 건너뛰고, 새 모델에만 있는 뼈(Spine·어깨·발가락)는 쉬는 자세 그대로.
// 같은 이름의 동작이 이미 있으면 --replace 일 때만 바꾸고, 아니면 건너뛴다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { MeshoptDecoder } = require("meshoptimizer");

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const [tgtFile, srcFile, outFile, clipArg] = args.filter((a) => !a.startsWith("--"));
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const tdoc = await io.read(tgtFile), sdoc = await io.read(srcFile);

// --- 사원수·벡터 [x,y,z,w] ---
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => a.map((v) => v * s), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fromTo = (a, b) => {
  const d = dot(a, b);
  if (d < -0.999999) { let ax = cross([1, 0, 0], a); if (Math.hypot(...ax) < 1e-6) ax = cross([0, 1, 0], a); ax = norm(ax); return [ax[0], ax[1], ax[2], 0]; }
  const c = cross(a, b); return qnorm([c[0], c[1], c[2], 1 + d]);
};
const slerp = (a, b, t) => {
  let d = dot(a, b) + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b; d = Math.abs(d);
  if (d > 0.9995) return qnorm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
};

// --- 뼈 이름 ---
const SRC2TGT = { hips: "Hips", spine: "Spine1", chest: "Spine2", neck: "Neck", head: "Head" };
for (const [s, t] of [["L", "Left"], ["R", "Right"]]) Object.assign(SRC2TGT, { [`upper_arm.${s}`]: `${t}Arm`, [`forearm.${s}`]: `${t}ForeArm`, [`hand.${s}`]: `${t}Hand`, [`thigh.${s}`]: `${t}UpLeg`, [`shin.${s}`]: `${t}Leg`, [`foot.${s}`]: `${t}Foot` });
const AIM = { Spine1: "Spine2", Spine2: "Neck", Neck: "Head", LeftArm: "LeftForeArm", LeftForeArm: "LeftHand", RightArm: "RightForeArm", RightForeArm: "RightHand", LeftUpLeg: "LeftLeg", LeftLeg: "LeftFoot", RightUpLeg: "RightLeg", RightLeg: "RightFoot" };
const bare = (n) => n.getName().replace(/^mixamorig:/, "");
const tNodes = new Map(tdoc.getRoot().listNodes().map((n) => [bare(n), n]));
const sNodes = new Map(sdoc.getRoot().listNodes().map((n) => [n.getName(), n]));

// --- 순운동학: 노드의 월드 위치·회전 (local(n) 이 [t, r] 를 줌, 배율은 1 로 봄) ---
function fk(node, local, memo) {
  if (memo.has(node)) return memo.get(node);
  const p = node.getParentNode();
  const [t, r] = local(node);
  let res;
  if (!p) res = { p: t, q: r };
  else { const pw = fk(p, local, memo); res = { p: add(pw.p, rot(pw.q, t)), q: qnorm(qmul(pw.q, r)) }; }
  memo.set(node, res);
  return res;
}
const restLocal = (n) => [n.getTranslation(), n.getRotation()];
const sRest = new Map(), tRest = new Map();
const sw = (name, memo, local) => fk(sNodes.get(name), local, memo);

// 좌우 확인: 옛 upper_arm.L 과 새 LeftArm 이 같은 쪽(월드 x 부호)인지
{
  const a = sw("upper_arm.L", sRest, restLocal).p[0], b = fk(tNodes.get("LeftArm"), restLocal, tRest).p[0];
  if (Math.sign(a) !== Math.sign(b)) for (const k of Object.keys(SRC2TGT)) if (/\.(L|R)$/.test(k)) SRC2TGT[k] = SRC2TGT[k].startsWith("Left") ? SRC2TGT[k].replace("Left", "Right") : SRC2TGT[k].replace("Right", "Left");
}
const TGT2SRC = Object.fromEntries(Object.entries(SRC2TGT).map(([s, t]) => [t, s]));
const sHipsY = sw("hips", sRest, restLocal).p[1], tHipsY = fk(tNodes.get("Hips"), restLocal, tRest).p[1];
const S = tHipsY / sHipsY;

// --- 샘플러 값 (선형/계단) ---
function sampler(ch) {
  const s = ch.getSampler(), T = s.getInput().getArray(), V = s.getOutput().getArray(), n = ch.getTargetPath() === "rotation" ? 4 : 3, step = s.getInterpolation() === "STEP", cub = s.getInterpolation() === "CUBICSPLINE";
  const at = (k) => { const o = cub ? (k * 3 + 1) * n : k * n; return Array.from(V.slice(o, o + n)); };
  return (t) => {
    if (t <= T[0]) return at(0);
    if (t >= T[T.length - 1]) return at(T.length - 1);
    let k = 0; while (k < T.length - 2 && T[k + 1] <= t) k++;
    if (step) return at(k);
    const u = (t - T[k]) / (T[k + 1] - T[k]), a = at(k), b = at(k + 1);
    return n === 4 ? slerp(a, b, u) : a.map((v, i) => v + (b[i] - v) * u);
  };
}

// 새 모델 노드를 부모 먼저 순서로
const order = [];
const visit = (n) => { order.push(n); n.listChildren().forEach(visit); };
tdoc.getRoot().listScenes()[0].listChildren().forEach(visit);
const tBones = order.filter((n) => tdoc.getRoot().listSkins()[0].listJoints().includes(n));
const buf = tdoc.getRoot().listBuffers()[0];

const want = clipArg ? new Set(clipArg.split(",")) : null;
const made = [];
for (const sa of sdoc.getRoot().listAnimations()) {
  const name = sa.getName();
  if (want && !want.has(name)) continue;
  const old = tdoc.getRoot().listAnimations().find((a) => a.getName() === name);
  if (old && !replace) { console.log(`건너뜀(이미 있음): ${name}`); continue; }
  const rotS = new Map(), posS = new Map();
  let times = new Set();
  for (const ch of sa.listChannels()) {
    const n = ch.getTargetNode(); if (!n) continue;
    const f = sampler(ch);
    if (ch.getTargetPath() === "rotation") rotS.set(n.getName(), f); else if (ch.getTargetPath() === "translation") posS.set(n.getName(), f);
    for (const t of ch.getSampler().getInput().getArray()) times.add(+t.toFixed(5));
  }
  times = [...times].sort((a, b) => a - b);
  const sLocal = (t) => (n) => { const nm = n.getName(); return [posS.has(nm) ? posS.get(nm)(t) : n.getTranslation(), rotS.has(nm) ? rotS.get(nm)(t) : n.getRotation()]; };
  const outR = new Map(tBones.map((n) => [n, []])), outHipsT = [];
  for (const t of times) {
    const sm = new Map(), sl = sLocal(t);
    const tLocal = new Map(); // 이번 시각의 새 모델 국소 [t, r]
    const tm = new Map();
    const lf = (n) => tLocal.get(n) || [n.getTranslation(), n.getRotation()];
    for (const n of tBones) {
      const nm = bare(n), src = TGT2SRC[nm];
      const parent = n.getParentNode();
      const pw = parent ? fk(parent, lf, tm) : { p: [0, 0, 0], q: [0, 0, 0, 1] };
      let localT = n.getTranslation(), localR = n.getRotation();
      if (src && sNodes.has(src)) {
        const sNow = sw(src, sm, sl), sR = sw(src, sRest, restLocal), tR = fk(n, restLocal, tRest);
        let W = qnorm(qmul(qmul(sNow.q, qinv(sR.q)), tR.q)); // 회전 변화량을 새 쉬는 자세에
        const aim = AIM[nm], srcChild = aim && TGT2SRC[aim];
        if (aim && srcChild && sNodes.has(srcChild) && tNodes.has(aim)) {
          const want = norm(sub(sw(srcChild, sm, sl).p, sNow.p));
          const cur = norm(rot(W, tNodes.get(aim).getTranslation()));
          W = qnorm(qmul(fromTo(cur, want), W)); // 가리키는 방향을 옛 뼈와 같게
        }
        localR = qnorm(qmul(qinv(pw.q), W));
        if (nm === "Hips") {
          const d = mul(sub(sNow.p, sR.p), S);
          const wp = add(tR.p, d);
          localT = rot(qinv(pw.q), sub(wp, pw.p));
        }
      }
      tLocal.set(n, [localT, localR]);
      tm.delete(n); // 이 노드 다시 계산
      outR.get(n).push(...localR);
      if (nm === "Hips") outHipsT.push(...localT);
    }
  }
  if (old) old.dispose();
  const anim = tdoc.createAnimation(name);
  const input = tdoc.createAccessor(name + "_t").setType("SCALAR").setArray(new Float32Array(times)).setBuffer(buf);
  for (const n of tBones) {
    if (!TGT2SRC[bare(n)]) continue; // 옮길 동작이 없는 뼈는 쉬는 자세(채널 없음)
    const out = tdoc.createAccessor(name + "_" + bare(n) + "_r").setType("VEC4").setArray(new Float32Array(outR.get(n))).setBuffer(buf);
    const smp = tdoc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation("LINEAR");
    anim.addSampler(smp).addChannel(tdoc.createAnimationChannel().setTargetNode(n).setTargetPath("rotation").setSampler(smp));
  }
  const hips = tNodes.get("Hips");
  const outT = tdoc.createAccessor(name + "_Hips_t").setType("VEC3").setArray(new Float32Array(outHipsT)).setBuffer(buf);
  const smpT = tdoc.createAnimationSampler().setInput(input).setOutput(outT).setInterpolation("LINEAR");
  anim.addSampler(smpT).addChannel(tdoc.createAnimationChannel().setTargetNode(hips).setTargetPath("translation").setSampler(smpT));
  made.push(`${name}(${times.length})`);
}
await io.write(outFile, tdoc);
console.log(`${path.basename(srcFile)} → ${path.basename(tgtFile)}: 엉덩이 높이 비 ${S.toFixed(2)}, 옮긴 동작 ${made.join(", ")} → ${outFile}`);
