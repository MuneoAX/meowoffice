// AI 고양이 모델의 눈 둘레 메시를 매끄럽게 편다(사용자 2026-11-25 "눈 주변에 주름 잡힌 거 수정").
// 원래 모델은 눈알이 볼록하고 둘레에 홈이 파여 있어, 카툰 눈을 평평하게 칠하면(scripts/paint-ai-eyes.mjs) 그 굴곡이 그늘 주름으로 보인다.
// 눈 자리(extras.meowFace, scripts/ai-face-marks.mjs) 둘레의 정점만 Taubin 평활화(줄어듦 보정)로 펴고 법선을 다시 구한다. 뼈 가중치·UV 는 그대로.
//   node scripts/smooth-ai-eyes.mjs <입력.glb> <출력.glb> [반복=30]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, itArg = "30"] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const mesh = doc.getRoot().listMeshes()[0], prim = mesh.listPrimitives()[0];
const mf = (mesh.getExtras() || {}).meowFace;
if (!mf || !mf.eyes) { console.error("눈 자리 없음: 먼저 scripts/ai-face-marks.mjs"); process.exit(1); }
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), ia = prim.getIndices().getArray();
const n = P.getCount();
const pos = []; for (let i = 0; i < n; i++) pos.push(P.getElement(i, []));
// 무늬 이음새에서 갈라진 같은 자리 정점을 하나로 묶는다
const gid = new Int32Array(n), groups = [], key = new Map();
for (let i = 0; i < n; i++) { const k = pos[i].map((v) => Math.round(v * 1e5)).join(","); let g = key.get(k); if (g == null) { g = groups.length; key.set(k, g); groups.push([]); } gid[i] = g; groups[g].push(i); }
const G = groups.length, gp = groups.map((m) => [...pos[m[0]]]);
const nb = Array.from({ length: G }, () => new Set());
for (let t = 0; t < ia.length; t += 3) { const a = gid[ia[t]], b = gid[ia[t + 1]], c = gid[ia[t + 2]]; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
for (let g = 0; g < G; g++) nb[g].delete(g);
// 정점마다 펼 세기: 눈 가운데~1.25R 은 1, 1.25~1.9R 에서 0 으로 (R = 카툰 눈 반지름과 같은 비율)
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const wt = new Float32Array(G);
for (const e of mf.eyes.filter(Boolean)) {
  const R = e.r * 1.35, c = [e.c[0], e.c[1] - e.r * 0.15, e.c[2]];
  for (let g = 0; g < G; g++) {
    const d = Math.hypot(gp[g][0] - c[0], gp[g][1] - c[1], gp[g][2] - c[2]) / R;
    wt[g] = Math.max(wt[g], 1 - ss(1.25, 1.9, d));
  }
}
const step = (lam) => {
  const nx = gp.map((p) => [...p]);
  for (let g = 0; g < G; g++) {
    if (wt[g] <= 0 || !nb[g].size) continue;
    const avg = [0, 0, 0]; for (const h of nb[g]) for (let k = 0; k < 3; k++) avg[k] += gp[h][k] / nb[g].size;
    for (let k = 0; k < 3; k++) nx[g][k] = gp[g][k] + lam * wt[g] * (avg[k] - gp[g][k]);
  }
  for (let g = 0; g < G; g++) gp[g] = nx[g];
};
for (let it = 0; it < +itArg; it++) { step(0.5); step(-0.53); }
// 위치 쓰기 + 법선 다시(펼친 곳만, 묶음 단위 면적 가중 평균 → 이음새에서도 매끄럽게)
const fn = Array.from({ length: G }, () => [0, 0, 0]);
for (let t = 0; t < ia.length; t += 3) {
  const a = gp[gid[ia[t]]], b = gp[gid[ia[t + 1]]], c = gp[gid[ia[t + 2]]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  for (const i of [ia[t], ia[t + 1], ia[t + 2]]) for (let k = 0; k < 3; k++) fn[gid[i]][k] += cr[k];
}
let moved = 0;
for (let i = 0; i < n; i++) {
  const g = gid[i];
  if (wt[g] <= 0) continue;
  P.setElement(i, gp[g]);
  const l = Math.hypot(...fn[g]) || 1, old = N.getElement(i, []);
  const nn = fn[g].map((x) => x / l);
  const w = wt[g]; // 가장자리는 원래 법선과 섞어 이어지게
  const m = [0, 1, 2].map((k) => old[k] * (1 - w) + nn[k] * w), ml = Math.hypot(...m) || 1;
  N.setElement(i, m.map((x) => x / ml));
  moved++;
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 눈 둘레 정점 ${moved}개 폄 (반복 ${itArg}) → ${out}`);
