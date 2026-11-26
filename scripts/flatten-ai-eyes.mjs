// AI 고양이 눈 안의 돌출(원래 모델의 볼록한 눈알이 남은 것)을 깎아 매끈한 얼굴 곡면으로(사용자 2026-11-26 "눈 안에 돌출된 부분 다 깎아서 매끈하게").
//   node scripts/flatten-ai-eyes.mjs <입력.glb> <출력.glb>
// 눈마다(extras.meowFace.eyes): 카툰 눈 바깥 고리(1.35~1.9R)의 얼굴 겉면에 2차 곡면(눈 방향 깊이 = 평면 좌표의 2차식)을 맞추고,
// 눈 안(~1.15R)의 정점을 그 곡면 위로 옮긴다. 1.15~1.5R 은 서서히 섞어 이음매가 없게. 옮긴 곳은 법선을 다시 구한다. UV·가중치는 그대로.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const mesh = doc.getRoot().listMeshes()[0], prim = mesh.listPrimitives()[0];
const mf = (mesh.getExtras() || {}).meowFace;
if (!mf || !mf.eyes) { console.error("눈 자리 없음"); process.exit(1); }
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), ia = prim.getIndices().getArray();
const n = P.getCount();
const pos = []; for (let i = 0; i < n; i++) pos.push(P.getElement(i, []));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// 같은 자리 정점 묶음(무늬 이음새)
const key = new Map(), gid = new Int32Array(n), groups = [];
for (let i = 0; i < n; i++) { const k = pos[i].map((v) => Math.round(v * 1e5)).join(","); let g = key.get(k); if (g == null) { g = groups.length; key.set(k, g); groups.push([]); } gid[i] = g; groups[g].push(i); }
const gp = groups.map((m) => [...pos[m[0]]]);
const gn = groups.map((m) => { const v = [0, 0, 0]; for (const i of m) { const q = N.getElement(i, []); v[0] += q[0]; v[1] += q[1]; v[2] += q[2]; } return norm(v); });
// 3x3·6x6 최소제곱
const solve = (A, b) => { const m = b.length, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; } } return M.map((r, i) => r[m] / (r[i] || 1e-12)); };
const touched = new Uint8Array(groups.length);
let movedTotal = 0;
for (const eye of mf.eyes.filter(Boolean)) {
  const R = eye.r * 1.35, c = [eye.c[0], eye.c[1] - eye.r * 0.15, eye.c[2]];
  const nn = norm(eye.n), right = norm(cross([0, 1, 0], nn)), up = norm(cross(nn, right));
  const loc = (p) => { const d = sub(p, c); return [dot(d, right) / R, dot(d, up) / R, dot(d, nn)]; };
  // 앞을 보는 얼굴 겉면만(뒤통수·안쪽 면 제외)
  const front = (g) => dot(gn[g], nn) > 0.2;
  const ring = [], inner = [];
  for (let g = 0; g < groups.length; g++) {
    const [s, t, h] = loc(gp[g]), e = Math.hypot(s, t);
    if (Math.abs(h) > R * 1.2 || !front(g)) continue;
    if (e > 1.35 && e < 1.9) ring.push([s, t, h]);
    else if (e <= 1.5) inner.push(g);
  }
  if (ring.length < 12) continue;
  // 깊이 h = a + b s + c t + d s² + e st + f t²
  const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0)), Atb = new Array(6).fill(0);
  for (const [s, t, h] of ring) { const r = [1, s, t, s * s, s * t, t * t]; for (let i = 0; i < 6; i++) { Atb[i] += r[i] * h; for (let j = 0; j < 6; j++) AtA[i][j] += r[i] * r[j]; } }
  const k = solve(AtA, Atb);
  const H = (s, t) => k[0] + k[1] * s + k[2] * t + k[3] * s * s + k[4] * s * t + k[5] * t * t;
  for (const g of inner) {
    const [s, t, h] = loc(gp[g]), e = Math.hypot(s, t);
    const w = 1 - ss(1.15, 1.5, e);
    if (w <= 0) continue;
    const dh = (H(s, t) - h) * w;
    gp[g] = [gp[g][0] + nn[0] * dh, gp[g][1] + nn[1] * dh, gp[g][2] + nn[2] * dh];
    touched[g] = 1; movedTotal++;
  }
}
// 위치 쓰기 + 옮긴 곳 법선 다시(면적 가중, 묶음 단위)
const fn = groups.map(() => [0, 0, 0]);
for (let t = 0; t < ia.length; t += 3) {
  const a = gp[gid[ia[t]]], b = gp[gid[ia[t + 1]]], cc = gp[gid[ia[t + 2]]];
  const cr = cross(sub(b, a), sub(cc, a));
  for (const i of [ia[t], ia[t + 1], ia[t + 2]]) { const f = fn[gid[i]]; f[0] += cr[0]; f[1] += cr[1]; f[2] += cr[2]; }
}
for (let i = 0; i < n; i++) {
  const g = gid[i];
  if (!touched[g]) continue;
  P.setElement(i, gp[g]);
  N.setElement(i, norm(fn[g]));
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 눈 ${mf.eyes.filter(Boolean).length}개, 매끈하게 옮긴 자리 ${movedTotal}곳 → ${out}`);
