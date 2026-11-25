// AI 자동 리깅(사람형 뼈대)은 꼬리 뼈가 없어 꼬리 정점이 엉뚱한 뼈(왼손·왼허벅지·머리)에 묶인다 → 손들기·걷기 때 꼬리가 말려 올라감.
// 꼬리 정점을 골라 엉덩이 뼈(Hips) 하나에만 묶는다(엉덩이와 함께 움직이고 따로 꺾이지 않음). 뼈대·다른 정점은 그대로.
//   node scripts/fix-ai-tail.mjs <입력.glb> <출력.glb>
// 꼬리 고르기: 머리 아래(높이 < 55%)에서 몸 뒤쪽 경계(z < BACK)보다 뒤에 있고, 머리·목 가중치가 작은 정점 중
// 가장 뒤의 정점(꼬리 끝)과 삼각형으로 이어진 덩어리. 경계 근처는 엉덩이 쪽으로 서서히 넘어가게 섞는다.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, backArg = "-0.09"] = process.argv.slice(2);
const BACK = +backArg, BLEND = 0.03; // 몸 뒤쪽 경계(m, 앞 = +Z)와 섞는 폭
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R = doc.getRoot();
const skin = R.listSkins()[0];
const J = skin.listJoints().map((j) => j.getName().replace(/^mixamorig:/, ""));
const HIPS = J.indexOf("Hips"), HEAD = J.indexOf("Head"), NECK = J.indexOf("Neck");
const prim = R.listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION"), JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0"), IDX = prim.getIndices();
const n = P.getCount(), q = [], j = [], w = [];
const pos = [];
let ymax = -Infinity;
for (let i = 0; i < n; i++) { P.getElement(i, q); pos.push([...q]); ymax = Math.max(ymax, q[1]); }
const headW = (i) => { JA.getElement(i, j); WA.getElement(i, w); let s = 0; for (let k = 0; k < 4; k++) if (j[k] === HEAD || j[k] === NECK) s += w[k]; return s; };
const cand = new Uint8Array(n);
for (let i = 0; i < n; i++) if (pos[i][1] < ymax * 0.55 && pos[i][2] < BACK + BLEND && headW(i) < 0.3) cand[i] = 1;
// 이웃(삼각형) 그래프로 꼬리 끝에서 이어진 덩어리
// 무늬 이음새에서 정점이 갈라져 있으므로(같은 자리 다른 번호) 같은 자리 정점끼리도 이웃으로 본다
const nb = Array.from({ length: n }, () => []);
const ia = IDX.getArray();
for (let t = 0; t < ia.length; t += 3) { const a = ia[t], b = ia[t + 1], c = ia[t + 2]; nb[a].push(b, c); nb[b].push(a, c); nb[c].push(a, b); }
const same = new Map();
for (let i = 0; i < n; i++) { const k = pos[i].map((v) => Math.round(v * 1e4)).join(","); if (!same.has(k)) same.set(k, []); same.get(k).push(i); }
for (const g of same.values()) if (g.length > 1) for (const a of g) for (const b of g) if (a !== b) nb[a].push(b);
let tip = -1;
for (let i = 0; i < n; i++) if (cand[i] && (tip < 0 || pos[i][2] < pos[tip][2])) tip = i;
const tail = new Uint8Array(n);
const stack = tip >= 0 ? [tip] : [];
while (stack.length) { const v = stack.pop(); if (tail[v]) continue; tail[v] = 1; for (const u of nb[v]) if (cand[u] && !tail[u]) stack.push(u); }
let cnt = 0;
for (let i = 0; i < n; i++) {
  if (!tail[i]) continue;
  // 경계(BACK) 뒤로 BLEND 만큼 들어간 곳부터 완전히 엉덩이, 경계 앞쪽은 원래 가중치와 섞음
  const t = Math.max(0, Math.min(1, (BACK + BLEND - pos[i][2]) / (2 * BLEND)));
  JA.getElement(i, j); WA.getElement(i, w);
  const map = new Map();
  for (let k = 0; k < 4; k++) if (w[k] > 0) map.set(j[k], (map.get(j[k]) || 0) + w[k] * (1 - t));
  map.set(HIPS, (map.get(HIPS) || 0) + t);
  const top = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const s = top.reduce((a, [, v]) => a + v, 0) || 1;
  const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
  top.forEach(([k, v], x) => { jj[x] = k; ww[x] = v / s; });
  JA.setElement(i, jj); WA.setElement(i, ww); cnt++;
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 꼬리 정점 ${cnt}개를 엉덩이 뼈로 (꼬리 끝 z ${tip >= 0 ? pos[tip][2].toFixed(3) : "-"}) → ${out}`);
