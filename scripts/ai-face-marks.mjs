// AI 고양이 모델의 눈 자리(가운데·반지름·바라보는 방향)를 찾아 메시·메시 노드 extras(meowFace)에 적는다.
// 앱(catmodel.js)은 이 자리에 카툰 눈(검은 동그란 눈 + 흰 반짝임 두 개 + 테두리)을 얼굴 표면에 붙인다(사실적인 그림 눈을 덮음).
//   node scripts/ai-face-marks.mjs <입력.glb> <출력.glb>
// 찾는 법: 머리 뼈 가중치가 큰 앞쪽 삼각형 안을 고루 찍어 텍스처 색을 읽고, 코보다 위·얼굴 가운데 쪽의 어두운 점을 좌우로 모은다.
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
const R = doc.getRoot();
const skin = R.listSkins()[0];
const J = skin.listJoints().map((j) => j.getName().replace(/^mixamorig:/, ""));
const HEAD = J.indexOf("Head");
const mesh = R.listMeshes()[0], prim = mesh.listPrimitives()[0];
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), UV = prim.getAttribute("TEXCOORD_0");
const JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0"), ia = prim.getIndices().getArray();
const tex = prim.getMaterial().getBaseColorTexture();
const { data: px, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const texel = (u, v) => { const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(H - 1, Math.max(0, Math.floor(v * H))), i = (y * W + x) * 4; return [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]; };

const n = P.getCount(), pos = [], nor = [], uv = [], hw = new Float32Array(n);
const j = [], w = [], t = [];
for (let i = 0; i < n; i++) {
  pos.push(P.getElement(i, [])); nor.push(N.getElement(i, [])); uv.push(UV.getElement(i, []));
  JA.getElement(i, j); WA.getElement(i, w);
  for (let k = 0; k < 4; k++) if (j[k] === HEAD) hw[i] += w[k];
}
// 머리 크기·코(가운데 줄에서 가장 앞)
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
for (let i = 0; i < n; i++) if (hw[i] > 0.5) { const [x, y] = pos[i]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const HW = x1 - x0, HH = y1 - y0;
let nose = null;
for (let i = 0; i < n; i++) { const [x, y, z] = pos[i]; if (hw[i] > 0.5 && Math.abs(x) < 0.015 && y > y0 + HH * 0.1 && y < y0 + HH * 0.35 && (!nose || z > nose[2])) nose = pos[i]; }
// 앞쪽 머리 삼각형을 고루 찍어 어두운 점 모으기
const dark = [[], []];
const S = 6;
for (let f = 0; f < ia.length; f += 3) {
  const a = ia[f], b = ia[f + 1], c = ia[f + 2];
  if (hw[a] + hw[b] + hw[c] < 2.4) continue;
  for (let s = 0; s <= S; s++) for (let r = 0; r <= S - s; r++) {
    const wa = s / S, wb = r / S, wc = 1 - wa - wb;
    const p = [0, 1, 2].map((k) => pos[a][k] * wa + pos[b][k] * wb + pos[c][k] * wc);
    const nn = [0, 1, 2].map((k) => nor[a][k] * wa + nor[b][k] * wb + nor[c][k] * wc);
    if (nn[2] < 0.25) continue; // 앞을 보는 면만
    if (p[1] < nose[1] || p[1] > nose[1] + HH * 0.35 || Math.abs(p[0] - nose[0]) > HW * 0.32 || Math.abs(p[0] - nose[0]) < HW * 0.05) continue; // 코 위, 얼굴 가운데 쪽(수염·귀 제외)
    const col = texel(uv[a][0] * wa + uv[b][0] * wb + uv[c][0] * wc, uv[a][1] * wa + uv[b][1] * wb + uv[c][1] * wc);
    const lum = 0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2];
    if (lum < 0.3) dark[p[0] > nose[0] ? 1 : 0].push({ p, nn, col });
  }
}
const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * q)]; };
const eyes = dark.map((d) => {
  if (d.length < 20) return null;
  // 시작점: 어두운 점이 가장 빽빽한 곳(눈동자). 그다음 평균 이동으로 덩어리 가운데로 — 털 무늬의 흩어진 어두운 점에 끌려가지 않게
  const sub = d.filter((_, i) => i % Math.max(1, Math.floor(d.length / 600)) === 0), rr = HW * 0.04;
  let best = sub[0], bc = -1;
  for (const a of sub) { let k = 0; for (const b of d) if (Math.abs(a.p[0] - b.p[0]) < rr && Math.abs(a.p[1] - b.p[1]) < rr) k++; if (k > bc) { bc = k; best = a; } }
  let cx = best.p[0], cy = best.p[1];
  let near = d;
  for (const rad of [HW * 0.08, HW * 0.08, HW * 0.08, HW * 0.08]) {
    near = d.filter((e) => Math.hypot(e.p[0] - cx, e.p[1] - cy) < rad);
    if (!near.length) return null;
    cx = near.reduce((s, e) => s + e.p[0], 0) / near.length; cy = near.reduce((s, e) => s + e.p[1], 0) / near.length;
  }
  const dist = near.map((e) => Math.hypot(e.p[0] - cx, e.p[1] - cy));
  const r = pct(dist, 0.92);
  near = near.filter((e, i) => dist[i] <= r);
  const avg = (k, f) => near.reduce((s, e) => s + f(e)[k], 0) / near.length;
  const c = [0, 1, 2].map((k) => avg(k, (e) => e.p));
  const nn = [0, 1, 2].map((k) => avg(k, (e) => e.nn)); const nl = Math.hypot(...nn);
  const col = [0, 1, 2].map((k) => avg(k, (e) => e.col));
  return { c, n: nn.map((v) => v / nl), r, col, samples: near.length };
});
const meowFace = { eyes, nose, headW: HW, headH: HH };
mesh.setExtras({ ...(mesh.getExtras() || {}), meowFace });
for (const nd of R.listNodes()) if (nd.getMesh() === mesh) nd.setExtras({ ...(nd.getExtras() || {}), meowFace }); // Babylon 은 노드 extras 를 metadata.gltf.extras 로 읽음
await io.write(out, doc);
const f3 = (v) => v.map((x) => x.toFixed(3)).join(",");
console.log(`${path.basename(inp)}: 코 (${f3(nose)}) 머리 폭 ${HW.toFixed(3)}`);
for (const e of eyes) console.log(e ? `  눈 (${f3(e.c)}) 반지름 ${e.r.toFixed(3)} 방향 (${f3(e.n)}) 색 ${f3(e.col)} 점 ${e.samples}` : "  눈 못 찾음");
