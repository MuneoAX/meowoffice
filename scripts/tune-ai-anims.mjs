// AI 리깅 동작(사람 체형용 프리셋)을 큰 머리 고양이에 맞게 다듬는다 — 서기·걷기 동작에서 허리·목·머리가 앞으로 숙는 정도를 줄인다.
//   node scripts/tune-ai-anims.mjs <입력.glb> <출력.glb> [허리·목 남길 비율=0.3]
// 뼈대·다른 뼈·앉기 동작은 그대로. 대상 뼈의 회전 키를 쉬는 자세(바인드 회전) 쪽으로 slerp 해 굽힘을 비율만큼만 남긴다.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, keepArg = "0.3"] = process.argv.slice(2);
const KEEP = +keepArg;
const CLIPS = new Set(["idle", "hold", "wait", "walk", "raise_hand"]); // 서기·걷기 (앉기 sit·sit_type 은 굽힘이 자세의 일부라 그대로)
const BONES = /(^|:)(Spine|Spine1|Spine2|Neck|Head)$/;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b; d = Math.abs(d);
  if (d > 0.9995) { const r = a.map((v, i) => v + (bb[i] - v) * t); const n = Math.hypot(...r); return r.map((v) => v / n); }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
};
let n = 0;
for (const anim of doc.getRoot().listAnimations()) {
  if (!CLIPS.has(anim.getName())) continue;
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    if (!node || ch.getTargetPath() !== "rotation" || !BONES.test(node.getName())) continue;
    const rest = node.getRotation();
    const acc = ch.getSampler().getOutput();
    const arr = acc.getArray().slice();
    for (let i = 0; i < arr.length; i += 4) {
      const q = slerp(rest, [arr[i], arr[i + 1], arr[i + 2], arr[i + 3]], KEEP);
      arr.set(q, i);
    }
    acc.setArray(arr); n++;
  }
}
await io.write(out, doc);
console.log(`다듬은 채널 ${n}개 (허리·목·머리 굽힘 ${Math.round(KEEP * 100)}% 남김) → ${out}`);
