// AI 리깅 동작(사람 체형용 프리셋)은 팔을 몸통 옆에 바짝 붙여 흔든다 → 몸통이 둥글고 넓은 고양이(특히 먼치킨)는 팔이 몸에 파묻힌다.
// 서기·걷기 동작에서 위팔이 옆으로 벌어진 각(정면에서 본 아래 방향과의 각, 허리·어깨가 움직인 실제 자세 기준)이 최소 각보다 작으면,
// 앞뒤 흔들기는 그대로 두고 몸 앞뒤 축을 중심으로 바깥으로 돌려 최소 각까지 벌린다. 아래팔(손이 배 앞으로 꺾여 들어감)은 최소 각의 80%까지.
// 위로 든 팔(손들기)은 건드리지 않는다. 뼈대·다른 뼈·앉기 동작은 그대로. 이미 벌린 키는 다시 돌려도 그대로(여러 번 돌려도 같음).
//   node scripts/spread-ai-arms.mjs <입력.glb> <출력.glb> [최소 각(도)=쉬는 자세(A자) 각] [동작,동작...]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, minArg, clipArg] = process.argv.slice(2);
const CLIPS = new Set(clipArg ? clipArg.split(",") : ["idle", "hold", "wait", "walk", "raise_hand"]); // 서기·걷기 (앉기 sit·sit_type 은 팔을 앞으로 뻗는 자세라 그대로)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);

// 사원수·벡터 도구 [x,y,z,w]
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const axisAngle = (ax, a) => { const s = Math.sin(a / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)]; };
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// 쉬는 자세 월드 회전(부모 사슬의 rotation 을 곱함; 배율은 회전에 영향 없음)
const worldRot = (node) => { let q = [0, 0, 0, 1]; for (let n = node; n; n = n.getParentNode()) q = qmul(n.getRotation(), q); return q; };
const worldPos = (node) => { const m = node.getWorldMatrix(); return [m[12], m[13], m[14]]; };

const nodes = doc.getRoot().listNodes();
const byName = (re) => nodes.find((n) => re.test(n.getName()));
const arms = [];
for (const side of ["Left", "Right"]) {
  const arm = byName(new RegExp(`(^|:)${side}Arm$`)), fore = byName(new RegExp(`(^|:)${side}ForeArm$`));
  if (!arm || !fore) continue;
  const par = arm.getParentNode();
  const pw = worldRot(par), pinv = qinv(pw);
  const sx = Math.sign(worldPos(fore)[0] - worldPos(arm)[0]) || (side === "Left" ? 1 : -1); // 팔이 뻗는 바깥 방향(모델 X)
  // 모델 축(앞 +Z, 위 +Y, 바깥 sx·X)을 부모 뼈 좌표로
  const L = rot(pinv, [sx, 0, 0]), D = rot(pinv, [0, -1, 0]), F = rot(pinv, [0, 0, 1]);
  const bone = norm(fore.getTranslation()); // 위팔 자체 좌표에서 팔꿈치 방향
  const ab = (q) => { const d = rot(q, bone); return Math.atan2(dot(d, L), dot(d, D)); }; // 정면에서 본 벌어진 각(아래 0, 옆 90°)
  const restAb = ab(arm.getRotation());
  const hand = byName(new RegExp(`(^|:)${side}Hand$`));
  arms.push({ arm, fore, side, restAb, bone, sx, hand: norm(hand ? hand.getTranslation() : bone) });
}
const MIN = minArg != null ? (+minArg * Math.PI) / 180 : null;
// 벌린 각을 최소 각까지: 회전 키 q 를 몸 앞뒤 축(부모 좌표 F)으로 바깥으로 돌린다
const spread = (ab, q, F, min) => {
  const cur = ab(q);
  if (cur >= min || cur < -Math.PI / 2) return null; // 이미 벌어졌거나, 위·안쪽으로 든 팔

  let r = q;
  for (let k = 0; k < 4; k++) {
    const e = min - ab(r);
    if (Math.abs(e) < 0.005) break;
    const t = ab(qmul(axisAngle(F, 0.05), r)) > ab(r) ? F : F.map((x) => -x);
    r = qmul(axisAngle(t, e), r);
  }
  return norm(r);
};
let n = 0, fixed = 0;
for (const anim of doc.getRoot().listAnimations()) {
  if (!CLIPS.has(anim.getName())) continue;
  const rch = new Map();
  for (const c of anim.listChannels()) if (c.getTargetPath() === "rotation") rch.set(c.getTargetNode(), { t: c.getSampler().getInput().getArray(), acc: c.getSampler().getOutput(), v: c.getSampler().getOutput().getArray().slice() });
  // 시각 t 의 국소 회전(가장 가까운 앞 키), 동작에 없는 뼈는 쉬는 자세
  const at = (node, t) => { const c = rch.get(node); if (!c) return node.getRotation(); let k = 0; while (k < c.t.length - 1 && c.t[k + 1] <= t + 1e-6) k++; return c.v.slice(k * 4, k * 4 + 4); };
  const worldAt = (node, t) => { let q = [0, 0, 0, 1]; for (let x = node; x; x = x.getParentNode()) q = qmul(at(x, t), q); return q; };
  for (const a of arms) {
    const min = MIN ?? a.restAb;
    for (const [node, dir, need] of [[a.arm, a.bone, min], [a.fore, a.hand, min * 0.8]]) {
      const c = rch.get(node);
      if (!c) continue;
      for (let i = 0; i < c.v.length; i += 4) {
        // 실제 동작(허리·어깨까지 움직인 뒤)의 부모 회전으로 모델 축을 옮겨 잰다
        const inv = qinv(worldAt(node.getParentNode(), c.t[i / 4]));
        const L = rot(inv, [a.sx, 0, 0]), D = rot(inv, [0, -1, 0]), F = rot(inv, [0, 0, 1]);
        const ab = (q) => { const d = rot(q, dir); return Math.atan2(dot(d, L), dot(d, D)); };
        const r = spread(ab, c.v.slice(i, i + 4), F, need);
        if (r) { c.v.set(r, i); fixed++; }
      }
      c.acc.setArray(c.v); n++;
    }
  }
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 팔 채널 ${n}개, 고친 키 ${fixed}개 (쉬는 자세 각 ${arms.map((a) => a.side + " " + Math.round((a.restAb * 180) / Math.PI) + "°").join(", ")}, 최소 ${MIN != null ? minArg + "°" : "쉬는 자세 각"}) → ${out}`);
