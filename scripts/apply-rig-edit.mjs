// Blender 에서 옮긴 관절 자리(JSON)를 AI 고양이 모델에 넣는다(사용자 2026-11-26 "조절 가능하게 해 줘").
//   node scripts/apply-rig-edit.mjs <모델.glb> <관절.json> [출력.glb=모델] [가중치.json]
// 가중치.json(있으면) = [[x, y, z, [[관절 이름, 무게], ...]], ...] — Blender '자동 가중치로 다시 심기' 결과. 같은 자리(0.1mm) 정점에 그대로 넣고 팔 가중치 다시 나누기는 건너뜀.
// 관절.json = { "<관절 이름>": [x, y, z] } — glTF 월드 좌표(앞 +Z, 위 +Y). design/blender-rig.py 가 Blender 편집 모드의 뼈 머리 자리를 적는다.
// 바뀐 관절(0.5mm 넘게)만 옮기고(회전은 그대로), 팔 관절이 바뀌면 팔 가중치를 새 어깨→팔꿈치→손목 선을 따라 다시 나누고, 역바인드 행렬을 다시 구한다.
// 이 뒤에 scripts/ai-cat-anims.mjs 로 동작을 다시 옮길 것.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, jsonFile, outArg, weightFile] = process.argv.slice(2);
const out = outArg && outArg !== "-" ? outArg : inp;
const want = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
const PAW = 0.055, B = 0.015;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R = doc.getRoot(), skin = R.listSkins()[0], joints = skin.listJoints();
const bare = (n) => n.getName().replace(/^mixamorig:/, "");
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = (a) => Math.hypot(...a);
const world = (node) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const t = rot(q, x.getTranslation()); p = add(p, t); q = qmul(q, x.getRotation()); } return { p, q }; };

// 바뀐 관절만(부모 먼저)
const byName = new Map(joints.map((j) => [j.getName(), j]));
const order = []; const visit = (n) => { order.push(n); n.listChildren().forEach(visit); };
R.listScenes()[0].listChildren().forEach(visit);
const changed = new Set();
const before = new Map(joints.map((j) => [j, world(j).p]));
for (const n of order) {
  const w = want[n.getName()];
  if (!w || !byName.has(n.getName())) continue;
  if (len(sub(w, world(n).p)) < 0.0005) continue;
  const p = n.getParentNode(), pw = world(p);
  n.setTranslation(rot(qinv(pw.q), sub(w, pw.p)));
  changed.add(bare(n));
}
// 자식 관절은 부모를 따라 움직였으므로, JSON 에 적힌 자리로 다시 맞춘다(위에서 부모 먼저 했으므로 한 번 더 돌면 정확)
for (const n of order) { const w = want[n.getName()]; if (!w || !byName.has(n.getName())) continue; const p = n.getParentNode(), pw = world(p); n.setTranslation(rot(qinv(pw.q), sub(w, pw.p))); }

// 팔 가중치: 팔 관절이 바뀐 쪽만, 어깨→팔꿈치→손목→앞발 끝 선을 따라 다시 나눔
const prim = R.listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION"), JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0");
const names = joints.map(bare), J = (s) => names.indexOf(s);
const ss = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
let rew = 0;
// Blender 에서 지운 뼈(JSON 에 없는 관절): 그 뼈가 잡던 살을 남아 있는 가장 가까운 부모 뼈로 넘긴다(관절은 모델에 남지만 살을 잡지 않음)
const removed = joints.filter((jn) => !(jn.getName() in want));
if (removed.length) {
  const idxOf = new Map(joints.map((jn, i) => [jn, i]));
  const to = new Map();
  for (const jn of removed) { let p = jn.getParentNode(); while (p && !(p.getName() in want)) p = p.getParentNode(); if (p && idxOf.has(p)) to.set(idxOf.get(jn), idxOf.get(p)); }
  const j = [], w = []; let moved = 0;
  for (let i = 0; i < P.getCount(); i++) {
    JA.getElement(i, j); WA.getElement(i, w);
    if (!j.some((x, k) => w[k] > 0 && to.has(x))) continue;
    const mp = new Map(); for (let k = 0; k < 4; k++) if (w[k] > 0) { const x = to.get(j[k]) ?? j[k]; mp.set(x, (mp.get(x) || 0) + w[k]); }
    const top = [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top.reduce((a, [, v]) => a + v, 0) || 1;
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([k, v], x) => { jj[x] = k; ww[x] = v / tot; });
    JA.setElement(i, jj); WA.setElement(i, ww); moved++;
  }
  console.log(`  지운 뼈 ${removed.map(bare).join(", ")} → 살 ${moved}정점을 부모 뼈로`);
}
if (weightFile) {
  // Blender 자동 가중치: 자리로 정점을 짝지어 넣는다
  const list = JSON.parse(fs.readFileSync(weightFile, "utf8"));
  const key = (p) => p.map((v) => Math.round(v * 1e4)).join(",");
  const map = new Map(list.map(([x, y, z, ws]) => [key([x, y, z]), ws]));
  const ji = new Map(joints.map((jn, i) => [jn.getName(), i]));
  let miss = 0;
  for (let i = 0; i < P.getCount(); i++) {
    const ws = map.get(key(P.getElement(i, [])));
    if (!ws) { miss++; continue; }
    const top = ws.filter(([nm, v]) => ji.has(nm) && v > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top.reduce((a, [, v]) => a + v, 0);
    if (!tot) { miss++; continue; }
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([nm, v], x) => { jj[x] = ji.get(nm); ww[x] = v / tot; });
    JA.setElement(i, jj); WA.setElement(i, ww); rew++;
  }
  console.log(`  Blender 가중치 넣음 ${rew}정점, 짝 못 찾음 ${miss}정점(원래 가중치 유지)`);
}
// 팔(위팔→아래팔→손)과 다리(허벅지→무릎→발): 관절이 바뀐 쪽만 살 가중치를 새 관절 선을 따라 다시 나눈다(발가락 뼈를 지웠으면 그 살도 발로)
const LIMBS = [["Arm", "ForeArm", "Hand", PAW], ["UpLeg", "Leg", "Foot", 0.04]];
for (const [side, limb] of weightFile ? [] : ["Left", "Right"].flatMap((sd) => LIMBS.map((lb) => [sd, lb]))) {
  const [n1, n2, n3, tipLen] = limb;
  if (![side + n1, side + n2, side + n3].some((k) => changed.has(k)) && !(n3 === "Foot" && removed.some((jn) => bare(jn) === side + "ToeBase"))) continue;
  const A = J(side + n1), F = J(side + n2), H = J(side + n3);
  if (A < 0 || F < 0 || H < 0) continue;
  const S = world(joints[A]).p, E = world(joints[F]).p, W = world(joints[H]).p, T = add(W, mul(sub(W, E), tipLen / (len(sub(W, E)) || 1)));
  const segs = [[S, E], [E, W], [W, T]], L = segs.map(([a, b]) => len(sub(b, a))), cum = [0, L[0], L[0] + L[1]];
  const tS = 0, tE = L[0], tW = L[0] + L[1];
  const param = (p) => { let best = Infinity, tb = 0; segs.forEach(([a, b], k) => { const d = sub(b, a), u = Math.min(1, Math.max(0, dot(sub(p, a), d) / (dot(d, d) || 1))), q = add(a, mul(d, u)), dd = len(sub(p, q)); if (dd < best) { best = dd; tb = cum[k] + u * L[k]; } }); return tb; };
  const toe = J(side + "ToeBase");
  const set = new Set([A, F, H, ...(n3 === "Foot" && toe >= 0 ? [toe] : [])]), j = [], w = [];
  for (let i = 0; i < P.getCount(); i++) {
    JA.getElement(i, j); WA.getElement(i, w);
    let s = 0; for (let k = 0; k < 4; k++) if (set.has(j[k])) s += w[k];
    if (s < 0.6) continue;
    const p = P.getElement(i, []);
    const tt = param(p) - (dot(sub(p, S), sub(E, S)) < 0 ? len(sub(p, S)) : 0); // 어깨보다 안쪽(몸 쪽)은 음수
    const wA = 1 - ss(tE - B, tE + B, tt), wF = ss(tE - B, tE + B, tt) * (1 - ss(tW - B, tW + B, tt)), wH = ss(tW - B, tW + B, tt);
    const keep = 1 - ss(tS - B, tS + B, tt);
    const other = new Map(); for (let k = 0; k < 4; k++) if (w[k] > 0 && !set.has(j[k])) other.set(j[k], (other.get(j[k]) || 0) + w[k]);
    const ot = [...other.values()].reduce((a, b) => a + b, 0);
    const o = new Map();
    if (keep > 0) { if (ot > 0) for (const [k, v] of other) o.set(k, (v / ot) * keep); else o.set(A, keep); }
    const aw = 1 - keep, sm = wA + wF + wH || 1;
    o.set(A, (o.get(A) || 0) + (aw * wA) / sm); o.set(F, (o.get(F) || 0) + (aw * wF) / sm); o.set(H, (o.get(H) || 0) + (aw * wH) / sm);
    const top = [...o.entries()].filter(([, v]) => v > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top.reduce((a, [, v]) => a + v, 0) || 1;
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([k, v], x) => { jj[x] = k; ww[x] = v / tot; });
    JA.setElement(i, jj); WA.setElement(i, ww); rew++;
  }
}
const ibm = [];
for (const jn of joints) { const { p, q } = world(jn), iq = qinv(q), ip = rot(iq, p).map((v) => -v); const x = rot(iq, [1, 0, 0]), y = rot(iq, [0, 1, 0]), z = rot(iq, [0, 0, 1]); ibm.push(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, ip[0], ip[1], ip[2], 1); }
skin.getInverseBindMatrices().setArray(new Float32Array(ibm));
await io.write(out, doc);
const moved = joints.filter((j) => len(sub(world(j).p, before.get(j))) > 0.0005).map(bare);
console.log(`${path.basename(inp)}: 옮긴 관절 ${moved.length}개(${moved.join(", ") || "없음"}), 팔 가중치 다시 ${rew}정점 → ${out}`);
