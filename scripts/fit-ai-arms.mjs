// AI 자동 리깅의 팔 관절(어깨·팔꿈치·손목)을 팔 메시에서 다시 잡고 팔 가중치를 다시 나눈다
// (사용자 2026-11-26 "리깅 잘못된 거 맞는 것 같다": 손목 높이를 맞춰도 앞발 중심이 좌우 1.7~3.4cm 다르고, 팔이 엉뚱한 자리에서 꺾임).
//   node scripts/fit-ai-arms.mjs <입력.glb> <출력.glb>
// 1) 팔 정점(위팔·아래팔·손 가중치 합 > 0.6)의 주축(PCA)을 어깨→앞발 끝 방향으로 잡고, 축을 따라 자른 단면의 중심 = 팔 중심선.
// 2) 어깨 = 팔 뿌리에서 팔 굵기(반지름)만큼 안, 손목 = 앞발 끝에서 앞발 길이만큼 안, 팔꿈치 = 둘 사이 가운데 — 모두 중심선 위.
// 3) 좌우는 팔 메시끼리의 대칭면(두 팔 관절 x 의 가운데)으로 거울 대칭.
// 4) 팔 정점 가중치: 어깨 앞쪽은 원래 가중치(몸통·쇄골), 어깨~팔꿈치 위팔, 팔꿈치~손목 아래팔, 손목 뒤 손. 경계 ±1.5cm 는 섞음.
// 관절 회전은 그대로, 위치만 바꾸고 역바인드 행렬을 다시 구한다(쉬는 자세 메시는 그대로). 이 뒤에 동작 옮기기를 다시 돌릴 것.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out] = process.argv.slice(2);
const PAW = 0.055, B = 0.015; // 앞발 길이, 가중치 섞는 폭(m, 키 1.0 기준)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R = doc.getRoot(), skin = R.listSkins()[0], joints = skin.listJoints();
const names = joints.map((j) => j.getName().replace(/^mixamorig:/, ""));
const J = (n) => names.indexOf(n);
const prim = R.listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION"), JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0");
const n = P.getCount();
const pos = []; for (let i = 0; i < n; i++) pos.push(P.getElement(i, []));
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const world = (node) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const t = rot(q, x.getTranslation()); p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; q = qmul(q, x.getRotation()); } return { p, q }; };
const wOf = (i, set) => { const j = JA.getElement(i, []), w = WA.getElement(i, []); let s = 0; for (let k = 0; k < 4; k++) if (set.has(j[k])) s += w[k]; return s; };

const fit = {};
for (const side of ["Left", "Right"]) {
  const A = J(side + "Arm"), F = J(side + "ForeArm"), H = J(side + "Hand");
  const set = new Set([A, F, H]);
  const idx = []; for (let i = 0; i < n; i++) if (wOf(i, set) > 0.6) idx.push(i);
  // 주축: 공분산의 가장 큰 고유벡터(거듭제곱법)
  const m = [0, 0, 0]; for (const i of idx) for (let k = 0; k < 3; k++) m[k] += pos[i][k] / idx.length;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of idx) { const d = sub(pos[i], m); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; }
  let ax = [1, 0, 0]; for (let it = 0; it < 50; it++) { const v = [0, 1, 2].map((a) => C[a][0] * ax[0] + C[a][1] * ax[1] + C[a][2] * ax[2]); const l = Math.hypot(...v); ax = v.map((x) => x / l); }
  // 어깨→손 방향으로
  const hp = world(joints[H]).p, ap = world(joints[A]).p;
  if (dot(sub(hp, ap), ax) < 0) ax = ax.map((x) => -x);
  const t = new Map(idx.map((i) => [i, dot(sub(pos[i], m), ax)]));
  const ts = [...t.values()].sort((a, b) => a - b), tmin = ts[Math.floor(ts.length * 0.01)], tmax = ts[Math.floor(ts.length * 0.995)];
  const slice = (tc, w = 0.008) => { const c = [0, 0, 0]; let k = 0; for (const i of idx) if (Math.abs(t.get(i) - tc) < w) { for (let a = 0; a < 3; a++) c[a] += pos[i][a]; k++; } return k ? c.map((v) => v / k) : null; };
  // 팔 굵기(반지름): 팔 가운데 단면에서 중심까지 거리의 중앙값
  const tm = (tmin + tmax) / 2, cm = slice(tm);
  const rs = idx.filter((i) => Math.abs(t.get(i) - tm) < 0.008).map((i) => { const d = sub(pos[i], cm); const along = dot(d, ax); return Math.hypot(d[0] - ax[0] * along, d[1] - ax[1] * along, d[2] - ax[2] * along); }).sort((a, b) => a - b);
  const r = rs[Math.floor(rs.length / 2)] || 0.03;
  const tS = tmin + r, tW = tmax - PAW, tE = (tS + tW) / 2;
  fit[side] = { A, F, H, idx, t, ax, m, tS, tE, tW, pS: slice(tS, 0.012), pE: slice(tE), pW: slice(tW), r };
}
// 좌우 대칭: 팔 관절 x 의 가운데를 대칭면으로
const L = fit.Left, Rt = fit.Right;
const x0 = ([L.pS, L.pE, L.pW].reduce((s, p) => s + p[0], 0) + [Rt.pS, Rt.pE, Rt.pW].reduce((s, p) => s + p[0], 0)) / 6;
const mir = (p) => [2 * x0 - p[0], p[1], p[2]];
for (const k of ["pS", "pE", "pW"]) { const a = L[k], b = mir(Rt[k]); const avg = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; L[k] = avg; Rt[k] = mir(avg); }
// 관절 자리 바꾸기(부모 먼저: 어깨 → 팔꿈치 → 손목)
const setWorld = (node, wp) => { const p = node.getParentNode(), pw = world(p); node.setTranslation(rot(qinv(pw.q), sub(wp, pw.p))); };
const moved = [];
for (const s of ["Left", "Right"]) {
  const f = fit[s];
  for (const [ji, k] of [[f.A, "pS"], [f.F, "pE"], [f.H, "pW"]]) { const before = world(joints[ji]).p; setWorld(joints[ji], f[k]); moved.push(Math.hypot(...sub(before, f[k]))); }
}
// 팔 가중치 다시
const ss = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
let rew = 0;
for (const s of ["Left", "Right"]) {
  const f = fit[s];
  for (const i of f.idx) {
    // 재 축 좌표는 새 관절 기준으로: 어깨→손목 선에 투영
    const tt = f.t.get(i);
    const wA = ss(f.tS - B, f.tS + B, tt) * (1 - ss(f.tE - B, f.tE + B, tt));
    const wF = ss(f.tE - B, f.tE + B, tt) * (1 - ss(f.tW - B, f.tW + B, tt));
    const wH = ss(f.tW - B, f.tW + B, tt);
    const keep = 1 - ss(f.tS - B, f.tS + B, tt); // 어깨 앞쪽: 원래 가중치(몸통·쇄골)
    const j = JA.getElement(i, []), w = WA.getElement(i, []);
    const mp = new Map();
    for (let k = 0; k < 4; k++) if (w[k] > 0 && ![f.A, f.F, f.H].includes(j[k])) mp.set(j[k], (mp.get(j[k]) || 0) + w[k]);
    const other = [...mp.values()].reduce((a, b) => a + b, 0);
    // 어깨 앞쪽인데 원래 팔 가중치만 있던 정점은 위팔로
    const out = new Map();
    if (keep > 0) { if (other > 0) for (const [jj, ww] of mp) out.set(jj, (ww / other) * keep); else out.set(f.A, keep); }
    const armW = 1 - keep;
    if (armW > 0) { const sum = wA + wF + wH || 1; out.set(f.A, (out.get(f.A) || 0) + (armW * wA) / sum); out.set(f.F, (out.get(f.F) || 0) + (armW * wF) / sum); out.set(f.H, (out.get(f.H) || 0) + (armW * wH) / sum); }
    const top = [...out.entries()].filter(([, v]) => v > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top.reduce((a, [, v]) => a + v, 0) || 1;
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([k, v], x) => { jj[x] = k; ww[x] = v / tot; });
    JA.setElement(i, jj); WA.setElement(i, ww); rew++;
  }
}
// 역바인드 행렬 다시
const ibm = [];
for (const jn of joints) {
  const { p, q } = world(jn), iq = qinv(q), ip = rot(iq, p).map((v) => -v);
  const x = rot(iq, [1, 0, 0]), y = rot(iq, [0, 1, 0]), z = rot(iq, [0, 0, 1]);
  ibm.push(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, ip[0], ip[1], ip[2], 1);
}
skin.getInverseBindMatrices().setArray(new Float32Array(ibm));
await io.write(out, doc);
const f3 = (v) => v.map((x) => x.toFixed(3)).join(",");
console.log(`${path.basename(inp)}: 팔 대칭면 x ${x0.toFixed(3)}, 반지름 ${L.r.toFixed(3)}/${Rt.r.toFixed(3)}, 관절 옮김 최대 ${(Math.max(...moved) * 100).toFixed(1)}cm, 가중치 다시 ${rew}정점 | 왼쪽 어깨(${f3(L.pS)}) 팔꿈치(${f3(L.pE)}) 손목(${f3(L.pW)})`);
