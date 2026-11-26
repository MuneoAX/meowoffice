// AI 고양이 눈 자리의 뒤집힌 작은 면(흠집) 펴기: 눈 돌출을 깎을 때(flatten-ai-eyes.mjs) 원래 눈알의 접힌 면이 곡면 위로 눌려
// 평면에서 서로 겹친(뒤집힌) 것. 깎은 곳은 2차 곡면 위에 있으므로, 그 곡면을 따라 옆으로만 고르게 펼치고(평면 좌표 이웃 평균)
// 높이는 곡면에 맞춘다 — 오그라들지 않아 얇은 곳이 새로 뒤집히지 않는다.
//   node scripts/fix-ai-face-flips.mjs <입력.glb> [출력.glb]   (MEOW_DEBUG=1 이면 남은 면 자리 출력)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out = inp] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const mesh = doc.getRoot().listMeshes()[0], prim = mesh.listPrimitives()[0];
const mf = (mesh.getExtras() || {}).meowFace;
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), ia = prim.getIndices().getArray();
const n = P.getCount();
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const solve = (A, b) => { const m = b.length, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; } } return M.map((r, i) => r[m] / (r[i] || 1e-12)); };
// 같은 자리 정점 묶음
const key = new Map(), gid = new Int32Array(n), gp = [];
for (let i = 0; i < n; i++) { const p = P.getElement(i, []); const k = p.map((v) => Math.round(v * 1e5)).join(","); let g = key.get(k); if (g == null) { g = gp.length; key.set(k, g); gp.push(p); } gid[i] = g; }
const G = gp.length, F = ia.length / 3;
const fg = (f) => [gid[ia[f * 3]], gid[ia[f * 3 + 1]], gid[ia[f * 3 + 2]]];
const nb = Array.from({ length: G }, () => new Set());
for (let f = 0; f < F; f++) { const [a, b, c] = fg(f); if (a === b || b === c || a === c) continue; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
const fn = (f) => { const [a, b, c] = fg(f); return cross(sub(gp[b], gp[a]), sub(gp[c], gp[a])); };
const eyes = ((mf && mf.eyes) || []).filter(Boolean);
const touched = new Set();
const report = [];
for (const eye of eyes) {
  // flatten-ai-eyes.mjs 와 같은 틀
  const R = eye.r * 1.35, c = [eye.c[0], eye.c[1] - eye.r * 0.15, eye.c[2]];
  const nn = norm(eye.n), right = norm(cross([0, 1, 0], nn)), up = norm(cross(nn, right));
  const stOf = (p) => { const d = sub(p, c); return [dot(d, right) / R, dot(d, up) / R, dot(d, nn)]; };
  // 2차 곡면 다시 맞추기(바깥 고리 1.35~1.9R 은 깎기 전 그대로)
  const ring = [];
  for (let g = 0; g < G; g++) { const [s, t, h] = stOf(gp[g]); const e = Math.hypot(s, t); if (e > 1.35 && e < 1.9 && Math.abs(h) < R * 1.2) ring.push([s, t, h]); }
  const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0)), Atb = new Array(6).fill(0);
  for (const [s, t, h] of ring) { const r = [1, s, t, s * s, s * t, t * t]; for (let i = 0; i < 6; i++) { Atb[i] += r[i] * h; for (let j = 0; j < 6; j++) AtA[i][j] += r[i] * r[j]; } }
  const k = solve(AtA, Atb);
  const H = (s, t) => k[0] + k[1] * s + k[2] * t + k[3] * s * s + k[4] * s * t + k[5] * t * t;
  // 깎은 곳 = 곡면 위(높이 차 작음)·가운데 1.15 안. 이 안의 면이 눈 방향 반대를 보면 뒤집힌 것
  const onSurf = new Set();
  for (let g = 0; g < G; g++) { const [s, t, h] = stOf(gp[g]); if (Math.hypot(s, t) < 1.15 && Math.abs(h - H(s, t)) < R * 0.04) onSurf.add(g); }
  const flips = () => { const bad = []; for (let f = 0; f < F; f++) { const gs = fg(f); if (gs[0] === gs[1] || gs[1] === gs[2] || gs[0] === gs[2] || !gs.every((g) => onSurf.has(g))) continue; if (dot(norm(fn(f)), nn) < -0.1) bad.push(f); } return bad; };
  const before = flips().length;
  if (!before) { report.push("0"); continue; }
  // 움직일 정점: 곡면 위 1.1 안(가장자리 1.1~1.15 는 고정)
  const mov = [...onSurf].filter((g) => { const [s, t] = stOf(gp[g]); return Math.hypot(s, t) < 1.1; });
  const st = new Map(mov.map((g) => [g, stOf(gp[g]).slice(0, 2)]));
  const at = (g) => st.get(g) || stOf(gp[g]).slice(0, 2);
  let left = before, it = 0;
  for (; it < 300 && left; it++) {
    const nx = new Map();
    for (const g of mov) { const ns = [...nb[g]]; if (!ns.length) continue; let a = 0, b = 0; for (const q of ns) { const v = at(q); a += v[0]; b += v[1]; } nx.set(g, [a / ns.length, b / ns.length]); }
    for (const [g, v] of nx) st.set(g, v);
    for (const g of mov) { const [s, t] = st.get(g); gp[g] = [0, 1, 2].map((i) => c[i] + right[i] * s * R + up[i] * t * R + nn[i] * H(s, t)); touched.add(g); }
    if (it % 5 === 4) left = flips().length;
  }
  left = flips().length;
  report.push(`${before}→${left}(${it}회)`);
  if (process.env.MEOW_DEBUG) for (const f of flips()) { const [a, b, cc] = fg(f); console.log("  남은 면", [0, 1, 2].map((i) => ((gp[a][i] + gp[b][i] + gp[cc][i]) / 3).toFixed(3)).join(",")); }
}
// 쓰기 + 법선(옮긴 곳과 닿은 면만)
const acc = new Map();
for (let f = 0; f < F; f++) { const gs = fg(f); if (!gs.some((g) => touched.has(g))) continue; const v = fn(f); for (const g of gs) { const a = acc.get(g) || [0, 0, 0]; a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; acc.set(g, a); } }
let w = 0;
for (let i = 0; i < n; i++) { const g = gid[i]; if (!acc.has(g)) continue; if (touched.has(g)) P.setElement(i, gp[g]); N.setElement(i, norm(acc.get(g))); w++; }
await io.write(out, doc);
console.log(`${path.basename(inp)}: 눈마다 뒤집힌 면 ${report.join(", ")}, 옮긴·법선 다시 정점 ${w} → ${out}`);
