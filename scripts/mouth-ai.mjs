// AI 고양이 모델에 벌릴 수 있는 입을 만든다(사용자 2026-11-25 "입 벌리고 하품하려면 모델링에 입이 들어가야").
//   node scripts/mouth-ai.mjs <입력.glb> <출력.glb>
// 1) 텍스처의 ω 입 선(코 아래 어두운 선)을 찾아 입 가운데·너비를 정한다.
// 2) 입 둘레 삼각형을 두 번 잘게 나눈다(빨강-초록 세분: 이웃 삼각형도 맞춰 나눠 틈이 없음). 원래는 입 너비에 삼각형 서너 개뿐.
// 3) 입 선을 따라 정점을 둘로 갈라 위·아래 입술을 만든다(닫힌 모양은 그대로).
// 4) 모양 변형(morph target) "mouthOpen": 아래 입술·턱이 내려가고(가운데일수록 크게, 입꼬리는 그대로) 윗입술이 조금 올라간다.
// 머리 안쪽 입속(어두운 빨강)·혀는 앱(catmodel.js)이 extras.meowFace.mouth 자리에 붙인다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const sharp = require("sharp");

const [inp, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R0 = doc.getRoot();
const mesh = R0.listMeshes()[0], prim = mesh.listPrimitives()[0];
if (prim.listTargets().length) { console.error("이미 모양 변형이 있음(입을 두 번 만들지 말 것)"); process.exit(1); }
const J = R0.listSkins()[0].listJoints().map((j) => j.getName().replace(/^mixamorig:/, ""));
const HEAD = J.indexOf("Head");
const SEM = prim.listSemantics();
const acc = Object.fromEntries(SEM.map((s) => [s, prim.getAttribute(s)]));
// 정점 속성을 일반 배열로
const V = { };
for (const s of SEM) { V[s] = []; const a = acc[s]; for (let i = 0; i < a.getCount(); i++) V[s].push(a.getElement(i, [])); }
let idx = Array.from(prim.getIndices().getArray());
const nv = () => V.POSITION.length;
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const headW = (i) => { const j = V.JOINTS_0[i], w = V.WEIGHTS_0[i]; let s = 0; for (let k = 0; k < 4; k++) if (j[k] === HEAD) s += w[k]; return s; };

// --- 1) 입 자리 ---
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
for (let i = 0; i < nv(); i++) if (headW(i) > 0.5) { const [x, y] = V.POSITION[i]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const HH = y1 - y0;
// 크기 기준: 두 눈 사이 거리(머리 폭은 장모종 털·수염 때문에 부풀어 믿기 어렵다). 눈 자리가 없으면 머리 폭으로
const eyes = (((mesh.getExtras() || {}).meowFace || {}).eyes || []).filter(Boolean);
const ew = eyes.length === 2 ? Math.abs(eyes[0].c[0] - eyes[1].c[0]) * 0.38 : (x1 - x0) * 0.16;
// 얼굴 가운데 줄: 두 눈의 가운데(장모종은 얼굴이 모델 가운데에서 비켜 있고, 가운데 줄 맨 앞이 털 끝일 수 있다)
const cx0 = eyes.length === 2 ? (eyes[0].c[0] + eyes[1].c[0]) / 2 : 0;
let nose = null;
for (let i = 0; i < nv(); i++) { const [x, y, z] = V.POSITION[i]; if (headW(i) > 0.5 && Math.abs(x - cx0) < 0.015 && y > y0 + HH * 0.1 && y < y0 + HH * 0.35 && (!nose || z > nose[2])) nose = V.POSITION[i]; }
const tex = prim.getMaterial().getBaseColorTexture();
const { data: px, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const TW = info.width, TH = info.height;
const texel = (u, v) => { const x = Math.min(TW - 1, Math.max(0, Math.floor(u * TW))), y = Math.min(TH - 1, Math.max(0, Math.floor(v * TH))), i = (y * TW + x) * 4; return 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]; };
const dark = [];
for (let f = 0; f < idx.length; f += 3) {
  const t = [idx[f], idx[f + 1], idx[f + 2]];
  if (t.some((i) => headW(i) < 0.5)) continue; // 장모종은 얼굴 털이 목 뼈와 섞여 머리 가중치가 낮다
  for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6 - a; b++) {
    const w = [a / 6, b / 6, 1 - a / 6 - b / 6];
    const p = [0, 1, 2].map((k) => t.reduce((s, i, m) => s + V.POSITION[i][k] * w[m], 0));
    const nz = t.reduce((s, i, m) => s + V.NORMAL[i][2] * w[m], 0);
    if (nz < 0.2 || Math.abs(p[0] - nose[0]) > ew * 0.6 || p[1] > nose[1] - 0.006 || p[1] < nose[1] - ew * 1.1 || p[2] < nose[2] - ew * 0.8) continue; // 코 바로 아래~턱 앞면
    const uv = [0, 1].map((k) => t.reduce((s, i, m) => s + V.TEXCOORD_0[i][k] * w[m], 0));
    if (texel(uv[0], uv[1]) < 110) dark.push(p);
  }
}
if (dark.length < 10) { console.error("입 선을 못 찾음"); process.exit(1); }
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * q)]; };
let my = pct(dark.map((p) => p[1]), 0.5);
const mx = nose[0];
// 입 너비: 입 선 높이 근처(털 그늘·수염 뿌리 제외)의 어두운 점이 코 줄에서 벌어진 거리
const row = dark.filter((p) => Math.abs(p[1] - my) < ew * 0.18);
// 어두운 점이 코 줄 한쪽에만 있으면(장모종: 수염 뿌리·털 그늘) 입 선을 잘못 잡은 것 → 다른 품종의 평균 자리(코 아래 눈 사이 거리의 10%)
const oneSide = Math.min(row.filter((p) => p[0] < mx).length, row.filter((p) => p[0] > mx).length) < row.length * 0.2;
const sep0 = eyes.length === 2 ? Math.abs(eyes[0].c[0] - eyes[1].c[0]) : ew / 0.38;
if (oneSide) my = nose[1] - sep0 * 0.1;
const sep = eyes.length === 2 ? Math.abs(eyes[0].c[0] - eyes[1].c[0]) : ew / 0.38;
// 입 반너비(ω 끝보다 조금 안쪽). 장모종은 털 그늘·수염 뿌리가 섞여 한쪽만 잡히기도 하므로 두 눈 사이 거리의 8~12% 로 묶는다
const hw = Math.min(sep * 0.12, Math.max(sep * 0.08, pct(row.map((p) => Math.abs(p[0] - mx)), 0.8) * 0.95));
let mz = Math.max(...row.map((p) => p[2]));
if (oneSide) { mz = -Infinity; for (let i = 0; i < nv(); i++) { const [x, y, z] = V.POSITION[i]; if (headW(i) > 0.3 && Math.abs(x - mx) < 0.01 && Math.abs(y - my) < 0.01) mz = Math.max(mz, z); } }
const C = [mx, my, mz];
const D = hw * 1.35; // 다 벌렸을 때(하품) 아래 입술이 내려가는 거리

// --- 2) 입 둘레 세분 ---
const lerpAttr = (s, a, b) => {
  if (s === "JOINTS_0") return null; // 가중치와 같이 처리
  if (s === "WEIGHTS_0") return null;
  return V[s][a].map((v, k) => (v + V[s][b][k]) / 2);
};
function mid(a, b, cache) {
  const key = a < b ? a + "_" + b : b + "_" + a;
  if (cache.has(key)) return cache.get(key);
  const id = nv();
  for (const s of SEM) { const v = lerpAttr(s, a, b); if (v) V[s].push(v); }
  // 뼈 가중치: 두 정점의 가중치를 반씩 합쳐 큰 4개
  const m = new Map();
  for (const i of [a, b]) for (let k = 0; k < 4; k++) { const w = V.WEIGHTS_0[i][k]; if (w > 0) m.set(V.JOINTS_0[i][k], (m.get(V.JOINTS_0[i][k]) || 0) + w / 2); }
  const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4), sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0]; top.forEach(([j, w], k) => { jj[k] = j; ww[k] = w / sum; });
  V.JOINTS_0.push(jj); V.WEIGHTS_0.push(ww);
  const n = V.NORMAL[id]; const l = Math.hypot(...n) || 1; V.NORMAL[id] = n.map((x) => x / l);
  cache.set(key, id);
  return id;
}
function refine(radius) {
  const T = idx.length / 3, ek = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  const pk = (i) => V.POSITION[i].map((v) => Math.round(v * 1e5)).join(","); // 이음새로 갈린 같은 자리 정점의 같은 변도 함께 나누도록 위치로 변 표시
  const ekp = (a, b) => { const x = pk(a), y = pk(b); return x < y ? x + "|" + y : y + "|" + x; };
  const mark = new Set();
  for (let t = 0; t < T; t++) {
    const tr = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const c = [0, 1, 2].map((k) => tr.reduce((s, i) => s + V.POSITION[i][k], 0) / 3);
    if (Math.hypot(c[0] - C[0], (c[1] - C[1]) * 1.3, c[2] - C[2]) < radius) for (let e = 0; e < 3; e++) mark.add(ekp(tr[e], tr[(e + 1) % 3]));
  }
  // 두 변 이상 표시된 삼각형은 세 변 모두(초록 삼각형은 한 변만 나눔)
  for (let changed = true; changed;) {
    changed = false;
    for (let t = 0; t < T; t++) {
      const tr = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const ks = [0, 1, 2].map((e) => ekp(tr[e], tr[(e + 1) % 3]));
      const c = ks.filter((k) => mark.has(k)).length;
      if (c === 2) { ks.forEach((k) => mark.add(k)); changed = true; }
    }
  }
  const cache = new Map(), ni = [];
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const m = [mark.has(ekp(a, b)), mark.has(ekp(b, c)), mark.has(ekp(c, a))];
    const cnt = m.filter(Boolean).length;
    if (cnt === 0) { ni.push(a, b, c); continue; }
    if (cnt === 3) {
      const ab = mid(a, b, cache), bc = mid(b, c, cache), ca = mid(c, a, cache);
      ni.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); continue;
    }
    // 한 변만: 둘로
    const e = m.indexOf(true), v = [a, b, c], p = v[e], q = v[(e + 1) % 3], r = v[(e + 2) % 3];
    const pq = mid(p, q, cache);
    ni.push(p, pq, r, pq, q, r);
  }
  idx = ni;
  return ek;
}
refine(hw * 2.6);
refine(hw * 1.9);

// --- 3) 입 선 따라 가르기 ---
// 같은 자리 정점 묶음
const groupOf = () => { const key = new Map(), g = new Int32Array(nv()); const list = []; for (let i = 0; i < nv(); i++) { const k = V.POSITION[i].map((v) => Math.round(v * 1e5)).join(","); let id = key.get(k); if (id == null) { id = list.length; key.set(k, id); list.push([]); } g[i] = id; list[id].push(i); } return [g, list]; };
const [gid, glist] = groupOf();
const G = glist.length, gp = glist.map((l) => V.POSITION[l[0]]);
const nb = Array.from({ length: G }, () => new Set());
for (let t = 0; t < idx.length; t += 3) { const a = gid[idx[t]], b = gid[idx[t + 1]], c = gid[idx[t + 2]]; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
const front = (g) => glist[g].some((i) => V.NORMAL[i][2] > 0.2) && glist[g].some((i) => headW(i) > 0.4); // 장모종 얼굴 털은 머리 가중치가 낮다
const nearest = (p) => { let best = -1, bd = Infinity; for (let g = 0; g < G; g++) { if (!front(g)) continue; const d = Math.hypot(gp[g][0] - p[0], gp[g][1] - p[1]) - gp[g][2] * 0.01; if (Math.abs(gp[g][2] - p[2]) < ew && d < bd) { bd = d; best = g; } } return best; };
const gL = nearest([mx - hw, my, mz]), gR = nearest([mx + hw, my, mz]);
// 다익스트라: 변 길이 + 입 선 높이에서 벗어난 만큼 벌점
const dist = new Float64Array(G).fill(Infinity), prev = new Int32Array(G).fill(-1), done = new Uint8Array(G);
dist[gL] = 0;
for (;;) {
  let u = -1, bd = Infinity;
  for (let g = 0; g < G; g++) if (!done[g] && dist[g] < bd) { bd = dist[g]; u = g; }
  if (u < 0 || u === gR) break;
  done[u] = 1;
  for (const v of nb[u]) {
    if (done[v] || !front(v) || Math.abs(gp[v][0] - mx) > hw * 1.3 || Math.abs(gp[v][1] - my) > hw * 0.6) continue;
    const L = Math.hypot(gp[v][0] - gp[u][0], gp[v][1] - gp[u][1], gp[v][2] - gp[u][2]);
    const c = dist[u] + L * (1 + 40 * Math.abs((gp[u][1] + gp[v][1]) / 2 - my) / hw);
    if (c < dist[v]) { dist[v] = c; prev[v] = u; }
  }
}
if (!isFinite(dist[gR])) { console.error("입 선 길을 못 찾음"); process.exit(1); }
const pathG = []; for (let g = gR; g >= 0; g = prev[g]) pathG.unshift(g);
const inner = new Set(pathG.slice(1, -1)); // 입꼬리 두 점은 가르지 않음
// 선 위 높이(x 로 보간) — 삼각형이 위/아래 어느 쪽인지
const px_ = pathG.map((g) => gp[g]);
const lineY = (x) => { for (let k = 0; k < px_.length - 1; k++) { const a = px_[k], b = px_[k + 1]; if ((x - a[0]) * (x - b[0]) <= 0 && a[0] !== b[0]) return a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]); } return my; };
const dup = new Map(); // 원래 정점 → 아래 입술용 복제
const dupOf = (i) => { if (dup.has(i)) return dup.get(i); const id = nv(); for (const s of SEM) V[s].push([...V[s][i]]); dup.set(i, id); return id; };
// 아래 입술 쪽 삼각형: 입 가운데 아래 한 점에서 시작해, 입 선(두 끝이 모두 입 선 위인 변)을 넘지 않고 이어진 면을 채운다
const onPath = new Set(pathG), pathEdge = new Set();
for (let k = 0; k < pathG.length - 1; k++) { const a = pathG[k], b = pathG[k + 1]; pathEdge.add(a < b ? a + "_" + b : b + "_" + a); }
const T = idx.length / 3, edgeTris = new Map();
for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) { const a = gid[idx[t * 3 + e]], b = gid[idx[t * 3 + (e + 1) % 3]]; const k = a < b ? a + "_" + b : b + "_" + a; if (!edgeTris.has(k)) edgeTris.set(k, []); edgeTris.get(k).push(t); }
const cen = (t) => [0, 1, 2].map((k) => (V.POSITION[idx[t * 3]][k] + V.POSITION[idx[t * 3 + 1]][k] + V.POSITION[idx[t * 3 + 2]][k]) / 3);
let seed = -1, sd = Infinity;
for (let t = 0; t < T; t++) { if (!idx.slice(t * 3, t * 3 + 3).some((i) => inner.has(gid[i]))) continue; const c = cen(t); if (c[1] >= lineY(c[0])) continue; const d = Math.abs(c[0] - mx); if (d < sd) { sd = d; seed = t; } }
const lowT = new Uint8Array(T), stack = [seed];
while (stack.length) {
  const t = stack.pop(); if (t < 0 || lowT[t]) continue;
  const c = cen(t); if (Math.hypot(c[0] - mx, c[1] - my) > hw * 1.6 || Math.abs(c[0] - mx) > hw * 1.05 || c[1] > lineY(c[0])) continue; // 입 둘레·입꼬리 안쪽·입 선 아래만(입꼬리를 돌아 윗입술로 넘어가지 않게)
  lowT[t] = 1;
  for (let e = 0; e < 3; e++) { const a = gid[idx[t * 3 + e]], b = gid[idx[t * 3 + (e + 1) % 3]]; const k = a < b ? a + "_" + b : b + "_" + a; if (pathEdge.has(k)) continue; for (const u of edgeTris.get(k)) if (!lowT[u]) stack.push(u); }
}
let split = 0;
const lowTri = [];
for (let t = 0; t < T; t++) {
  // 이어진 면 채우기에 들었거나, 입 선 정점에 닿고 가운데가 입 선보다 아래면 아래 입술(둘 중 하나만으로는 빠지는 면이 있음)
  const tr = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
  if (!tr.some((i) => inner.has(gid[i]))) continue;
  const c = cen(t);
  const below = lowT[t] || (c[1] < lineY(c[0]) && Math.abs(c[0] - mx) < hw * 1.05);
  if (!below) continue;
  lowTri.push(t);
  for (let k = 0; k < 3; k++) { const i = idx[t * 3 + k]; if (inner.has(gid[i])) { idx[t * 3 + k] = dupOf(i); split++; } }
}
const lower = new Set(dup.values());
// 내려갈 정점 = 아래 입술 면(채우기 영역 + 입 선에 닿은 아래 면)에 속한 정점. 높이로 고르면 지그재그 입 선 바로 위 정점까지 내려가 윗입술이 늘어난다
const lowerV = new Set();
for (let t = 0; t < T; t++) if (lowT[t]) for (let k = 0; k < 3; k++) lowerV.add(idx[t * 3 + k]);
for (const t of lowTri) for (let k = 0; k < 3; k++) lowerV.add(idx[t * 3 + k]);
for (const i of lowerV) if (inner.has(gid[i]) && !lower.has(i)) lowerV.delete(i); // 입 선의 윗입술 쪽 원본은 제외

// --- 4) 모양 변형: 아래 입술·턱 내려감, 윗입술 조금 올라감 ---
const delta = Array.from({ length: nv() }, () => [0, 0, 0]);
const Rj = hw * 1.6; // 턱이 따라 내려가는 범위(입 선 아래)
for (let i = 0; i < nv(); i++) {
  const [x, y, z] = V.POSITION[i];
  if (headW(i) < 0.3 || V.NORMAL[i][2] < -0.2 || Math.abs(z - mz) > hw * 1.2) continue;
  const dx = Math.abs(x - mx) / (hw * 1.15);
  if (dx >= 1) continue;
  const across = 1 - dx * dx; // 가운데일수록 크게, 입꼬리 0
  const ly = lineY(x);
  const below = lowerV.has(i);
  if (below) {
    const k = across * (1 - ss(0, Rj, ly - y)) * (lower.has(i) ? 1 : 0.92);
    delta[i] = [0, -D * k, -D * 0.25 * k];
  } else if (y - ly < hw * 0.5) {
    const k = across * (1 - ss(0, hw * 0.5, y - ly)) * 0.18;
    delta[i] = [0, D * k, -D * 0.05 * k];
  }
}

// --- 속성 쓰기 ---
const big = nv() > 65535;
for (const s of SEM) {
  const a = acc[s], n = V[s][0].length;
  const Arr = a.getArray().constructor;
  const arr = new Arr(nv() * n);
  V[s].forEach((v, i) => arr.set(v, i * n));
  a.setArray(arr);
}
prim.getIndices().setArray(big ? new Uint32Array(idx) : new Uint16Array(idx));
const buf = acc.POSITION.getBuffer();
const tgt = doc.createPrimitiveTarget("mouthOpen");
const dacc = doc.createAccessor("mouthOpen_POSITION").setType("VEC3").setArray(new Float32Array(delta.flat())).setBuffer(buf);
tgt.setAttribute("POSITION", dacc);
prim.addTarget(tgt);
mesh.setWeights([0]);
mesh.setExtras({ ...(mesh.getExtras() || {}), targetNames: ["mouthOpen"] });
const mouth = { c: C, hw, D, ew, nose };
const ex = (o) => ({ ...(o || {}), meowFace: { ...((o || {}).meowFace || {}), mouth } });
mesh.setExtras(ex(mesh.getExtras()));
for (const nd of R0.listNodes()) if (nd.getMesh() === mesh) nd.setExtras(ex(nd.getExtras()));
await io.write(out, doc);
const f3 = (v) => v.map((x) => x.toFixed(3)).join(",");
console.log(`${path.basename(inp)}: 입 (${f3(C)}) 반너비 ${hw.toFixed(3)} 벌림 ${D.toFixed(3)}, 입 선 ${pathG.length}점, 가른 자리 ${split}, 정점 ${nv()} → ${out}`);
