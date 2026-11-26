// AI 자동 리깅의 좌우 관절 자리를 몸 중심선 기준으로 거울 대칭으로 맞춘다(사용자 2026-11-26 "양팔 벌린 각도가 대칭이 아니야, 리깅 포인트를 잘못 잡은 듯").
// Tripo 자동 리깅은 왼쪽·오른쪽 관절을 따로 잡아(예: 치즈 허벅지 11.8cm / 9.1cm, 쉬는 팔 각도 55° / 45°) 같은 동작도 좌우가 다르게 보인다.
//   node scripts/sym-ai-rig.mjs <입력.glb> <출력.glb>
// 짝 관절(Left*/Right*)마다 월드 자리를 [왼쪽, 오른쪽의 거울]의 평균으로 바꾸고 오른쪽은 그 거울로 둔다. 중심선 x = 몸 가운데 관절(엉덩이~머리)의 평균.
// 관절 회전(축 방향)은 그대로, 위치만 바꾸고 역바인드 행렬을 다시 구한다 → 쉬는 자세의 메시는 그대로, 굽는 중심만 대칭이 된다.
// 이미 옮긴 동작은 국소 회전이라 새 관절 자리에서 그대로 쓰이지만, 옛 동작 옮기기(retarget-old-anims)는 이 뒤에 다시 돌리는 것이 정확하다.
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
const skin = doc.getRoot().listSkins()[0];
const joints = skin.listJoints();
const bare = (n) => n.getName().replace(/^mixamorig:/, "");
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const world = (node) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const t = rot(q, x.getTranslation()); p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; q = qmul(q, x.getRotation()); } return { p, q }; };

const W0 = new Map(joints.map((j) => [j, world(j)]));
const center = joints.filter((j) => /^(Hips|Spine|Spine1|Spine2|Neck|Head)$/.test(bare(j)));
const cx = center.reduce((s, j) => s + W0.get(j).p[0], 0) / center.length;
const mir = (p) => [2 * cx - p[0], p[1], p[2]];
const want = new Map(); // 관절 → 새 월드 자리
let pairs = 0, maxMove = 0;
for (const j of joints) {
  const nm = bare(j);
  if (!nm.startsWith("Left")) continue;
  const r = joints.find((x) => bare(x) === "Right" + nm.slice(4));
  if (!r) continue;
  const pl = W0.get(j).p, pr = W0.get(r).p, m = mir(pr);
  const nl = [(pl[0] + m[0]) / 2, (pl[1] + m[1]) / 2, (pl[2] + m[2]) / 2];
  want.set(j, nl); want.set(r, mir(nl));
  maxMove = Math.max(maxMove, Math.hypot(nl[0] - pl[0], nl[1] - pl[1], nl[2] - pl[2]));
  pairs++;
}
// 부모부터 차례로 국소 위치를 다시 정한다(회전은 그대로라 월드 회전도 그대로)
const order = [];
const visit = (n) => { order.push(n); n.listChildren().forEach(visit); };
doc.getRoot().listScenes()[0].listChildren().forEach(visit);
for (const n of order) {
  if (!want.has(n)) continue;
  const p = n.getParentNode(), pw = p ? world(p) : { p: [0, 0, 0], q: [0, 0, 0, 1] }, wp = want.get(n);
  n.setTranslation(rot(qinv(pw.q), [wp[0] - pw.p[0], wp[1] - pw.p[1], wp[2] - pw.p[2]]));
}
// 역바인드 행렬 = 관절 월드의 역 (열 우선)
const ibm = [];
for (const j of joints) {
  const { p, q } = world(j), iq = qinv(q), ip = rot(iq, p).map((v) => -v);
  const x = rot(iq, [1, 0, 0]), y = rot(iq, [0, 1, 0]), z = rot(iq, [0, 0, 1]);
  ibm.push(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, ip[0], ip[1], ip[2], 1);
}
skin.getInverseBindMatrices().setArray(new Float32Array(ibm));
await io.write(out, doc);
console.log(`${path.basename(inp)}: 중심선 x ${cx.toFixed(3)}, 좌우 관절 ${pairs}쌍 대칭(최대 ${(maxMove * 100).toFixed(1)}cm 옮김) → ${out}`);
