// 발라당(roll) 동작 고치기: 누운 뒤 좌우로 뒹굴 때 몸이 세로축(위)을 중심으로 돌아 호를 그리던 것을, 몸통 긴 축(등뼈 방향)을 중심으로 통째로 좌우로 구르게 바꾼다.
//   node scripts/fix-roll-anim.mjs            assets/src3d/models/cats/anims_*.glb 네 개를 고쳐 쓴다 (이어서 npm run optimize-assets -- --only anims_)
// Blender 없이 glb 안의 root 뼈 키만 고친다: 키마다 (기본 자세 대비) 회전을 X(뒤로 눕기)·Z(옆 돌림)로 풀어, Z 를 Y(긴 축 구르기)로 옮기고 GAIN 배 키운다.
// 구르는 만큼 몸이 옆으로 가도록 root 위치도 옮긴다(미끄러지지 않고 구르는 모양). assets/cats/hi3d/extra_actions.py 의 build_roll 도 같은 뜻으로 고쳐 두었다.
// 이미 고친 파일에 다시 돌리면 Z 성분이 0 이라 아무것도 바뀌지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'assets', 'src3d', 'models', 'cats');
const GAIN = 3.0; // 옆 돌림 0.35rad → 구르기 1.05rad(60°)
const RADIUS = 0.16; // 구를 때 몸이 옆으로 가는 양 = RADIUS × 각 (몸통 반지름쯤, m)
const SIDE = 1; // 구르는 쪽으로 몸이 가게 하는 부호 (화면으로 확인해 정함)
const ARM_UP = 0.45; // 앞발을 하늘로 더 뻗는 각(rad, 위팔 앞뒤 스윙 축 Z — 왼팔 -, 오른팔 +)
const ARM_STRAIGHT = 0.5; // 아래팔을 펴는 각(rad, 굽힘 0.9 → 0.4)
const LEG_LIFT = 1.0; // 발라당 때 허벅지를 앞으로 든 각(rad, extra_actions.py paws_up)
const LEG_AXIS = [0, 0, 1]; // 허벅지를 옆으로 벌리는 축 (화면으로 확인해 정함)
const LEG_SPREAD = 0.5; // 뒷다리를 벌리는 각(rad, 한쪽)

const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const axis = (x, y, z, ang) => { const s = Math.sin(ang / 2); return [x * s, y * s, z * s, Math.cos(ang / 2)]; };
const rot = (q, v) => { const p = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q)); return [p[0], p[1], p[2]]; };
// 회전 R = Rx(a)·Rz(s) 로 보고 a, s 를 뽑는다
const xz = (q) => {
  const [x, y, z, w] = q;
  const m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - z * w), m12 = 2 * (y * z - x * w), m22 = 1 - 2 * (x * x + y * y);
  return { s: Math.atan2(-m01, m00), a: Math.atan2(-m12, m22) };
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of fs.readdirSync(DIR).filter((n) => /^anims_.*\.glb$/.test(n))) {
  const p = path.join(DIR, f);
  const doc = await io.read(p);
  const anim = doc.getRoot().listAnimations().find((a) => /roll/i.test(a.getName()));
  if (!anim) { console.log(f, '— roll 동작 없음'); continue; }
  const ch = (pathName) => anim.listChannels().find((c) => c.getTargetNode() && c.getTargetNode().getName() === 'root' && c.getTargetPath() === pathName);
  const rc = ch('rotation'), tc = ch('translation');
  if (!rc) { console.log(f, '— root 회전 키 없음'); continue; }
  const rout = rc.getSampler().getOutput(), rin = rc.getSampler().getInput();
  const B = rout.getElement(0, []);
  const sides = [];
  let changed = 0, maxS = 0;
  for (let i = 0; i < rout.getCount(); i++) {
    const q = rout.getElement(i, []);
    const { a, s } = xz(mul(conj(B), q));
    sides.push([rin.getScalar(i), s]);
    maxS = Math.max(maxS, Math.abs(s));
    if (Math.abs(s) < 1e-4) continue;
    const q2 = mul(B, mul(axis(1, 0, 0, a), axis(0, 1, 0, s * GAIN)));
    const n = Math.hypot(...q2);
    rout.setElement(i, q2.map((v) => v / n));
    changed++;
  }
  if (tc && changed) {
    const tout = tc.getSampler().getOutput(), tin = tc.getSampler().getInput();
    const ax = rot(B, [1, 0, 0]);
    for (let i = 0; i < tout.getCount(); i++) {
      const t = tin.getScalar(i);
      // 같은 시각의 옆 돌림 각 (회전 키에서 선형 보간)
      let s = 0;
      for (let k = 1; k < sides.length; k++) if (t >= sides[k - 1][0] && t <= sides[k][0]) { const u = (t - sides[k - 1][0]) / Math.max(1e-6, sides[k][0] - sides[k - 1][0]); s = sides[k - 1][1] + (sides[k][1] - sides[k - 1][1]) * u; break; }
      if (!s) continue;
      const d = SIDE * RADIUS * s * GAIN, v = tout.getElement(i, []);
      tout.setElement(i, [v[0] + ax[0] * d, v[1] + ax[1] * d, v[2] + ax[2] * d]);
    }
  }
  // 둘째 손질(한 번만 — 동작의 extras.rollPose 로 표시): 누워 있는 동안 앞발을 하늘로 더 뻗고(위팔 더 들고 아래팔 펴기), 뒷다리를 조금 벌린다.
  // 누운 정도 w(0~1) = root 의 뒤로 눕기 각 / 1.75 를 키마다 곱해, 일어서는 구간에서는 자연스럽게 원래 자세로 돌아간다.
  let posed = 0;
  if (!(anim.getExtras() || {}).rollPose) {
    const lie = [];
    for (let i = 0; i < rout.getCount(); i++) lie.push(Math.max(0, Math.min(1, -xz(mul(conj(B), rout.getElement(i, []))).a / 1.75)));
    const POSE = { 'upper_arm.L': [[0, 0, 1, -ARM_UP]], 'upper_arm.R': [[0, 0, 1, ARM_UP]], 'forearm.L': [[1, 0, 0, -ARM_STRAIGHT]], 'forearm.R': [[1, 0, 0, -ARM_STRAIGHT]],
      // 허벅지는 이미 앞으로 1.0rad 들려 있다(X). 그 상태에서 돌리면 비틀림이 되므로, 들기 전 좌표로 되돌려(X -LIFT) 벌린 뒤(LEG_AXIS) 다시 든다(X +LIFT)
      'thigh.L': [[1, 0, 0, -LEG_LIFT], [...LEG_AXIS, -LEG_SPREAD], [1, 0, 0, LEG_LIFT]], 'thigh.R': [[1, 0, 0, -LEG_LIFT], [...LEG_AXIS, LEG_SPREAD], [1, 0, 0, LEG_LIFT]] };
    for (const c of anim.listChannels()) {
      const nd = c.getTargetNode(), add = nd && POSE[nd.getName()];
      if (!add || c.getTargetPath() !== 'rotation') continue;
      const out = c.getSampler().getOutput();
      if (out.getCount() !== lie.length) { console.log(f, nd.getName(), '키 수가 달라 건너뜀'); continue; }
      for (let i = 0; i < out.getCount(); i++) {
        if (lie[i] < 1e-3) continue;
        let q = out.getElement(i, []);
        for (const [x, y, z, ang] of add) q = mul(q, axis(x, y, z, ang * lie[i]));
        const n = Math.hypot(...q);
        out.setElement(i, q.map((v) => v / n));
      }
      posed++;
    }
    if (posed) anim.setExtras({ ...(anim.getExtras() || {}), rollPose: 1 });
  }
  if (changed || posed) await io.write(p, doc);
  if (posed) console.log(f, `— 누운 자세 손질: 관절 ${posed}개`);
  console.log(f, `— 회전 키 ${rout.getCount()}개 중 ${changed}개 고침 (옆 돌림 최대 ${maxS.toFixed(2)}rad → 구르기 ${(maxS * GAIN).toFixed(2)}rad)`, tc ? `위치 키 ${tc.getSampler().getOutput().getCount()}개` : '위치 키 없음');
}
