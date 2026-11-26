// Blender 에서 메시 정점을 옮긴 결과를 앱 모델(glb)에 옮겨 담는다(예: 폴드캣 오른팔을 왼팔 거울 모양으로).
//   node scripts/apply-mesh-edit.mjs <모델.glb> <pairs.json> [출력.glb]
// pairs.json = [[옛 자리 xyz, 새 자리 xyz], ...] (glTF 좌표). 옛 자리가 같은(1e-4) 정점을 모두 새 자리로 옮기고,
// 옮긴 정점이 닿은 곳의 법선을 다시 구한다(같은 자리 정점 묶음 단위, 면적 가중). UV·가중치·모양 키(상대값)는 그대로.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, pairsFile, out = inp] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), ia = prim.getIndices().getArray();
const n = P.getCount();
const k4 = (v) => v.map((x) => Math.round(x * 1e4)).join(",");
const map = new Map(JSON.parse(fs.readFileSync(pairsFile, "utf8")).map(([a, b]) => [k4(a), b]));
const pos = []; for (let i = 0; i < n; i++) pos.push(P.getElement(i, []));
const moved = new Uint8Array(n); let cnt = 0;
for (let i = 0; i < n; i++) { const b = map.get(k4(pos[i])); if (b) { pos[i] = b; moved[i] = 1; cnt++; } }
// 법선: 같은 자리 묶음 단위
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const key = new Map(), gid = new Int32Array(n); let ng = 0;
for (let i = 0; i < n; i++) { const k = pos[i].map((v) => Math.round(v * 1e5)).join(","); let g = key.get(k); if (g == null) { g = ng++; key.set(k, g); } gid[i] = g; }
const touched = new Uint8Array(ng);
for (let t = 0; t < ia.length; t += 3) if (moved[ia[t]] || moved[ia[t + 1]] || moved[ia[t + 2]]) for (let j = 0; j < 3; j++) touched[gid[ia[t + j]]] = 1;
const fn = Array.from({ length: ng }, () => [0, 0, 0]);
for (let t = 0; t < ia.length; t += 3) {
  const [a, b, c] = [ia[t], ia[t + 1], ia[t + 2]];
  if (!touched[gid[a]] && !touched[gid[b]] && !touched[gid[c]]) continue;
  const cr = cross(sub(pos[b], pos[a]), sub(pos[c], pos[a]));
  for (const i of [a, b, c]) { const f = fn[gid[i]]; f[0] += cr[0]; f[1] += cr[1]; f[2] += cr[2]; }
}
let nn = 0;
for (let i = 0; i < n; i++) {
  if (moved[i]) P.setElement(i, pos[i]);
  if (N && touched[gid[i]]) { const f = fn[gid[i]], l = Math.hypot(...f) || 1; N.setElement(i, f.map((x) => x / l)); nn++; }
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 정점 ${cnt}개 옮김(짝 ${map.size}), 법선 ${nn}개 다시 → ${out}`);
