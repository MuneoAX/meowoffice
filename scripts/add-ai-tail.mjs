// AI 고양이 모델에 꼬리 뼈 4마디(tail_01~04)를 넣는다. 사람형 자동 리깅엔 꼬리 뼈가 없어 꼬리가 엉덩이에 붙은 막대처럼 굳어 있었다
// (사용자 2026-11-25 "꼬리가 좀 이상한데", 앞서 "꼬리는 기분에 따라 멈추거나 살랑살랑, 짜증 나면 빠르게").
// 앱(catmodel.js)은 옛 고양이와 같이 tail_01~04 를 코드로 움직인다(자세별 방향각 TAIL_POSE + 기분·신호별 좌우 흔들기). 그 규칙에 맞춰
//   - 엉덩이 뼈 아래에 모델 좌표(위 +Y, 앞 +Z)와 같은 방향의 기준 뼈 tail_root 를 두고(엉덩이를 따라 움직임),
//   - 그 아래 tail_01~04 를 꼬리 살 중심선을 따라 놓는다(각 마디의 +Y 가 꼬리 방향, 다음 마디는 +Y 로 마디 길이만큼).
// 꼬리 정점: 몸 뒤쪽(z < BACK)·머리 아래에서 꼬리 끝과 이어진 덩어리(scripts/fix-ai-tail.mjs 와 같은 고르기). 뿌리에서 끝까지의 거리(면을 따라)로 4등분해 가중치.
//   node scripts/add-ai-tail.mjs <입력.glb> <출력.glb> [BACK=-0.09]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, backArg = "-0.09"] = process.argv.slice(2);
const BACK = +backArg;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R = doc.getRoot();
const skin = R.listSkins()[0];
let joints = skin.listJoints();
if (joints.some((j) => /^tail_0\d$/.test(j.getName()))) { console.error("이미 꼬리 뼈가 있음"); process.exit(1); }
const J = joints.map((j) => j.getName().replace(/^mixamorig:/, ""));
const HIPS = J.indexOf("Hips"), HEAD = J.indexOf("Head"), NECK = J.indexOf("Neck");
const hips = joints[HIPS];
const prim = R.listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION"), JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0"), ia = prim.getIndices().getArray();
const n = P.getCount();
const pos = []; let ymax = -Infinity;
for (let i = 0; i < n; i++) { const q = P.getElement(i, []); pos.push(q); ymax = Math.max(ymax, q[1]); }

// --- 사원수·벡터 ---
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fromMat = (x, y, z) => { // 열 벡터 x,y,z → 사원수
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
  const l = Math.hypot(...q); return q.map((v) => v / l);
};
const world = (node) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const t = rot(q, x.getTranslation()); p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; q = qmul(q, x.getRotation()); } return { p, q }; };

// --- 꼬리 정점 고르기 (fix-ai-tail 과 같은 기준) ---
const j = [], w = [];
const headW = (i) => { JA.getElement(i, j); WA.getElement(i, w); let s = 0; for (let k = 0; k < 4; k++) if (j[k] === HEAD || j[k] === NECK) s += w[k]; return s; };
const cand = new Uint8Array(n);
for (let i = 0; i < n; i++) if (pos[i][1] < ymax * 0.55 && pos[i][2] < BACK + 0.03 && headW(i) < 0.3) cand[i] = 1;
const nb = Array.from({ length: n }, () => []);
for (let t = 0; t < ia.length; t += 3) { const a = ia[t], b = ia[t + 1], c = ia[t + 2]; nb[a].push(b, c); nb[b].push(a, c); nb[c].push(a, b); }
const same = new Map();
for (let i = 0; i < n; i++) { const k = pos[i].map((v) => Math.round(v * 1e4)).join(","); if (!same.has(k)) same.set(k, []); same.get(k).push(i); }
for (const g of same.values()) if (g.length > 1) for (const a of g) for (const b of g) if (a !== b) nb[a].push(b);
let tip = -1;
for (let i = 0; i < n; i++) if (cand[i] && (tip < 0 || pos[i][2] < pos[tip][2])) tip = i;
const tail = new Uint8Array(n), st = [tip];
while (st.length) { const v = st.pop(); if (tail[v]) continue; tail[v] = 1; for (const u of nb[v]) if (cand[u] && !tail[u]) st.push(u); }
// 뿌리 고리: 꼬리 정점 중 몸(꼬리 아닌 정점)과 이웃한 것. 그곳에서 면을 따라 잰 거리 = 꼬리 길이 방향 좌표
const dist = new Float64Array(n).fill(Infinity), queue = [];
for (let i = 0; i < n; i++) if (tail[i] && nb[i].some((u) => !tail[u])) { dist[i] = 0; queue.push(i); }
// 다익스트라(작은 그래프라 단순 구현)
const done = new Uint8Array(n);
for (;;) {
  let u = -1, bd = Infinity;
  for (const v of queue) if (!done[v] && dist[v] < bd) { bd = dist[v]; u = v; }
  if (u < 0) break;
  done[u] = 1;
  for (const v of nb[u]) {
    if (!tail[v]) continue;
    const d = dist[u] + Math.hypot(...sub(pos[u], pos[v]));
    if (d < dist[v]) { if (dist[v] === Infinity) queue.push(v); dist[v] = d; }
  }
}
let dmax = 0; for (let i = 0; i < n; i++) if (tail[i] && isFinite(dist[i])) dmax = Math.max(dmax, dist[i]);
const s = (i) => (isFinite(dist[i]) ? dist[i] / dmax : 1);
// 마디 자리: 꼬리 길이 좌표 0, .25, .5, .75, 1(끝) 근처 정점의 가운데(살 중심선)
const centerAt = (t0) => { const acc = [0, 0, 0]; let k = 0; for (let i = 0; i < n; i++) if (tail[i] && Math.abs(s(i) - t0) < 0.05) { acc[0] += pos[i][0]; acc[1] += pos[i][1]; acc[2] += pos[i][2]; k++; } return k ? acc.map((v) => v / k) : null; };
const C = [0, 0.25, 0.5, 0.75, 1].map(centerAt);
if (C.some((c) => !c)) { console.error("꼬리 중심선을 못 찾음"); process.exit(1); }
// 꼬리 뿌리는 엉덩이 살 안쪽에서 꺾이게 첫 마디를 뿌리 고리보다 조금 몸 안쪽(앞)으로
C[0] = [C[0][0], C[0][1], C[0][2] + 0.01];

// --- 뼈 만들기 ---
const hw = world(hips);
const tr = doc.createNode("tail_root").setRotation(qinv(hw.q)).setTranslation(rot(qinv(hw.q), sub(C[0], hw.p)).map((v) => v)); // 모델 좌표와 같은 방향
// tail_root 의 위치를 꼬리 뿌리로 두고, tail_01 은 그 자리(0)에서 시작
hips.addChild(tr);
let parentW = { p: C[0], q: [0, 0, 0, 1] };
const tj = [];
for (let k = 0; k < 4; k++) {
  const yv = norm(sub(C[k + 1], C[k])); // 마디 방향
  let xv = cross(yv, [0, 0, 1]); if (Math.hypot(...xv) < 1e-3) xv = [1, 0, 0]; xv = norm(xv); // 옆(좌우) 축은 수평
  if (dot(xv, [1, 0, 0]) < 0) xv = xv.map((v) => -v);
  const zv = cross(xv, yv);
  const q = fromMat(xv, yv, zv);
  const node = doc.createNode(`tail_0${k + 1}`).setRotation(qmul(qinv(parentW.q), q)).setTranslation(rot(qinv(parentW.q), sub(C[k], parentW.p)));
  (k === 0 ? tr : tj[k - 1]).addChild(node);
  tj.push(node);
  parentW = { p: C[k], q };
}
// 끝 마디 길이 표시용 자식은 두지 않는다(앱은 마디 회전만 씀)
// 스킨 관절에 붙이고 역바인드 행렬 추가(관절 월드의 역)
const ibmAcc = skin.getInverseBindMatrices();
const old = Array.from(ibmAcc.getArray());
const mat = (wq, wp) => { // 회전·위치 → 4x4(열 우선)의 역
  const iq = qinv(wq), ip = rot(iq, wp).map((v) => -v);
  const x = rot(iq, [1, 0, 0]), y = rot(iq, [0, 1, 0]), z = rot(iq, [0, 0, 1]);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, ip[0], ip[1], ip[2], 1];
};
const newJ = [tr, ...tj];
for (const nd of newJ) { const wv = world(nd); old.push(...mat(wv.q, wv.p)); skin.addJoint(nd); }
ibmAcc.setArray(new Float32Array(old));
joints = skin.listJoints();
const ROOTI = joints.indexOf(tr), TI = tj.map((t) => joints.indexOf(t));

// --- 가중치: 마디 구간마다 그 마디에, 경계 ±0.06 은 이웃 마디와 섞고, 뿌리(0~0.1)는 엉덩이와 섞음 ---
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
let cnt = 0;
for (let i = 0; i < n; i++) {
  if (!tail[i]) continue;
  const t = s(i), m = new Map();
  const add = (jix, v) => { if (v > 1e-4) m.set(jix, (m.get(jix) || 0) + v); };
  const seg = Math.min(3, Math.floor(t / 0.25)), u = t - seg * 0.25;
  let wSeg = 1, wPrev = 0, wNext = 0;
  if (seg > 0 && u < 0.06) { wPrev = 0.5 * (1 - u / 0.06); wSeg = 1 - wPrev; }
  if (seg < 3 && u > 0.25 - 0.06) { wNext = 0.5 * ((u - (0.25 - 0.06)) / 0.06); wSeg = 1 - wNext; }
  const body = seg === 0 ? 1 - ss(0, 0.1, t) : 0; // 뿌리: 엉덩이에 남기는 몫
  add(TI[seg], wSeg * (1 - body)); if (wPrev) add(TI[seg - 1], wPrev * (1 - body)); if (wNext) add(TI[seg + 1], wNext * (1 - body));
  add(HIPS, body);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), sum = top.reduce((a, [, v]) => a + v, 0) || 1;
  const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([k, v], x) => { jj[x] = k; ww[x] = v / sum; });
  JA.setElement(i, jj); WA.setElement(i, ww); cnt++;
}
await io.write(out, doc);
const L = [0, 1, 2, 3].map((k) => Math.hypot(...sub(C[k + 1], C[k])).toFixed(3));
console.log(`${path.basename(inp)}: 꼬리 뼈 tail_root + tail_01~04 (마디 ${L.join("/")} m), 꼬리 정점 ${cnt}개 → ${out}`);
