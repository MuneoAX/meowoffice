// AI 로 만든 3D 모델(Tripo 등, 수십만~수백만 삼각형)을 앱에 쓸 크기로 줄인다 — 손 조형 없이 자동 단순화만.
//   node scripts/slim-ai-model.mjs <입력.glb> <출력.glb> [삼각형 수=24000] [텍스처 px=1024]
// 순서: 정점 합치기(weld) → meshoptimizer 단순화(UV 이음새·테두리 보존) → 안 쓰는 데이터 정리 → 텍스처 줄여 WebP.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { weld, simplify, prune, dedup, textureCompress } = require("@gltf-transform/functions");
const { MeshoptSimplifier } = require("meshoptimizer");
const sharp = require("sharp");

const [inp, out, tris = "24000", px = "1024"] = process.argv.slice(2);
if (!inp || !out) { console.error("쓰는 법: node scripts/slim-ai-model.mjs <입력.glb> <출력.glb> [삼각형 수] [텍스처 px]"); process.exit(1); }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const count = () => doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute("POSITION").getCount()) / 3, 0), 0);
const before = count();
await MeshoptSimplifier.ready;
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, +tris / before), error: 0.01, lockBorder: false }),
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [+px, +px], quality: 88 }),
);
// 앞 방향을 glTF 기준(+Z)으로: 자동 리깅이 +Z 를 앞으로 보고 뼈대를 세우므로, 옆을 보고 있으면 걷기가 좌우로 꼬인다.
// 머리 높이에서 더 넓은 축 = 좌우(수염), 다른 축이 앞뒤. 엉덩이 높이에서 그 축으로 더 멀리 나온 쪽 = 꼬리(뒤).
const { transformMesh } = require("@gltf-transform/functions");
const mesh = doc.getRoot().listMeshes()[0];
const P = mesh.listPrimitives()[0].getAttribute("POSITION");
const pts = []; const q = [];
for (let i = 0; i < P.getCount(); i++) { P.getElement(i, q); pts.push([...q]); }
const ys = pts.map((p) => p[1]), y0 = Math.min(...ys), H = Math.max(...ys) - y0;
const band = (lo, hi) => pts.filter((p) => p[1] > y0 + H * lo && p[1] < y0 + H * hi);
const span = (ps, a) => Math.max(...ps.map((p) => p[a])) - Math.min(...ps.map((p) => p[a]));
const head = band(0.55, 0.8), hip = band(0.15, 0.4);
const fwdAxis = span(head, 0) > span(head, 2) ? 2 : 0; // 좌우가 x 면 앞뒤는 z
const cen = (head.reduce((s, p) => s + p[fwdAxis], 0) / head.length);
const tailSign = Math.max(...hip.map((p) => p[fwdAxis] - cen)) > -Math.min(...hip.map((p) => p[fwdAxis] - cen)) ? 1 : -1; // 꼬리 쪽 부호
const front = fwdAxis === 0 ? (tailSign > 0 ? "-x" : "+x") : (tailSign > 0 ? "-z" : "+z");
const turn = { "+z": 0, "+x": -Math.PI / 2, "-z": Math.PI, "-x": Math.PI / 2 }[front]; // Y 축 회전: 앞 → +Z
if (turn) {
  const c = Math.cos(turn), s = Math.sin(turn);
  // 열 우선 4x4: x' = x c + z s, z' = -x s + z c
  transformMesh(mesh, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
console.log(`앞 방향 ${front}${turn ? " → +Z 로 돌림" : " (그대로)"}`);
await io.write(out, doc);
console.log(`삼각형 ${Math.round(before)} → ${Math.round(count())}, 출력 ${out}`);
