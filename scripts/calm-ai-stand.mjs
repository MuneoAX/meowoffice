// AI 리깅 서기·손들기 동작(사람형 프리셋)은 한쪽 발을 들거나 체중을 옮겨 짝다리를 짚는다(사용자 2026-11-25 "얌전히 서 있어도 되는데").
// 서기 동작에서 다리 뼈(허벅지·무릎·발·발가락)를 쉬는 자세로 고정해 두 발을 바닥에 붙이고, 엉덩이의 좌우·앞뒤 이동·기울기도 줄인다.
// 상체(허리·목·머리·팔)의 숨쉬기·흔들림은 그대로.
//   node scripts/calm-ai-stand.mjs <입력.glb> <출력.glb> [동작,동작...]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, clipArg] = process.argv.slice(2);
const only = clipArg ? new Set(clipArg.split(",")) : null; // 고른 동작만
const CLIPS = new Set(["idle", "hold", "wait", "raise_hand"]); // 서기·손들기(손 흔들기 프리셋은 몸을 뒤로 젖히고 다리를 차서 다리·엉덩이를 고정)
const PLACE = new Set(["walk"]); // 걷기: 다리는 그대로, 엉덩이의 앞뒤·좌우 위치만 제자리로(제자리 걷기인데 몸이 앞으로 밀려 있음)
const LEGS = /(^|:)(Left|Right)(UpLeg|Leg|Foot|ToeBase)$/;
const HIPS = /(^|:)Hips$/;
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
  const name = anim.getName();
  if (only && !only.has(name)) continue;
  if (PLACE.has(name)) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (!node || ch.getTargetPath() !== "translation" || !HIPS.test(node.getName())) continue;
      const acc = ch.getSampler().getOutput(), arr = acc.getArray().slice(), t0 = node.getTranslation();
      // 앞뒤·좌우 흔들림은 남기되 평균 자리를 쉬는 자리로
      let mx = 0, mz = 0; const k = arr.length / 3;
      for (let i = 0; i < arr.length; i += 3) { mx += arr[i] / k; mz += arr[i + 2] / k; }
      for (let i = 0; i < arr.length; i += 3) { arr[i] += t0[0] - mx; arr[i + 2] += t0[2] - mz; }
      acc.setArray(arr); n++;
    }
    continue;
  }
  if (!CLIPS.has(name)) continue;
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode(), p = ch.getTargetPath();
    if (!node) continue;
    const acc = ch.getSampler().getOutput(), arr = acc.getArray().slice();
    if (p === "rotation" && LEGS.test(node.getName())) {
      const r = node.getRotation(); for (let i = 0; i < arr.length; i += 4) arr.set(r, i); // 다리: 쉬는 자세 그대로
    } else if (p === "rotation" && HIPS.test(node.getName())) {
      const r = node.getRotation(); for (let i = 0; i < arr.length; i += 4) arr.set(slerp(r, [arr[i], arr[i + 1], arr[i + 2], arr[i + 3]], 0.2), i); // 엉덩이 기울기 20%만
    } else if (p === "translation" && HIPS.test(node.getName())) {
      // 엉덩이 이동: 좌우·앞뒤는 쉬는 자리로(발이 미끄러지지 않게), 위아래 숨쉬기는 20%만(발이 바닥에서 뜨거나 묻히지 않게)
      const t0 = node.getTranslation();
      for (let i = 0; i < arr.length; i += 3) { arr[i] = t0[0]; arr[i + 1] = t0[1] + (arr[i + 1] - t0[1]) * 0.2; arr[i + 2] = t0[2]; }
    } else continue;
    acc.setArray(arr); n++;
  }
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 서기 동작 채널 ${n}개 정리(다리 고정, 엉덩이 흔들림 줄임) → ${out}`);
