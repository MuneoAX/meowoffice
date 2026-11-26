// AI 리깅 동작(사람 체형용 프리셋)은 팔을 몸통 옆에 바짝 붙여 흔든다 → 몸통이 둥글고 넓은 고양이(특히 먼치킨)는 팔이 몸에 파묻힌다.
// 서기·걷기 동작에서 위팔이 옆으로 벌어진 각(정면에서 본 아래 방향과의 각, 허리·어깨가 움직인 실제 자세 기준)이 최소 각보다 작으면,
// 앞뒤 흔들기는 그대로 두고 몸 앞뒤 축을 중심으로 바깥으로 돌려 최소 각까지 벌린다. 아래팔(손이 배 앞으로 꺾여 들어감)은 최소 각의 80%까지.
// 위로 든 팔(손들기)은 건드리지 않는다. 뼈대·다른 뼈·앉기 동작은 그대로. 이미 벌린 키는 다시 돌려도 그대로(여러 번 돌려도 같음).
//   node scripts/spread-ai-arms.mjs <입력.glb> <출력.glb> [최소 각(도)|auto=쉬는 자세(A자) 각] [동작,동작...] [hand=손목 높이]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const [inp, out, minArg, clipArg, handArg] = process.argv.slice(2);
const HAND_Y = handArg ? +handArg.replace(/^hand=/, "") : null; // 앞발 가운데 높이(모델 좌표) — 이보다 낮으면 팔을 더 벌려 올린다(품종끼리 서 있는 손 높이를 맞춤)
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
  // 앞발 가운데(손 뼈 가중치 > 0.5 정점의 중심)를 손 뼈 좌표로 — 손 높이는 손목 관절이 아니라 보이는 앞발로 잰다
  let pawOff = [0, 0, 0];
  if (hand) {
    const pr = doc.getRoot().listMeshes()[0].listPrimitives()[0], PP = pr.getAttribute("POSITION"), PJ = pr.getAttribute("JOINTS_0"), PW = pr.getAttribute("WEIGHTS_0");
    const hi = doc.getRoot().listSkins()[0].listJoints().indexOf(hand), jj = [], ww = []; const c = [0, 0, 0]; let k = 0;
    for (let i = 0; i < PP.getCount(); i++) { PJ.getElement(i, jj); PW.getElement(i, ww); let t = 0; for (let q = 0; q < 4; q++) if (jj[q] === hi) t += ww[q]; if (t > 0.5) { const v = PP.getElement(i, []); c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; k++; } }
    if (k) { const hw = worldRot(hand), hp = worldPos(hand); pawOff = rot(qinv(hw), [c[0] / k - hp[0], c[1] / k - hp[1], c[2] / k - hp[2]]); }
  }
  arms.push({ arm, fore, side, restAb, bone, sx, handNode: hand, pawOff, hand: norm(hand ? hand.getTranslation() : bone) });
}
// 최소 각 "auto": 체형마다 몸통 두께에서 구한다 — 곧게 편 팔(어깨→팔꿈치→손목)과 앞발이 몸통 옆면에 닿지 않는 가장 작은 벌림 각 + 4°,
// 좌우 중 큰 값을 양쪽에 같이 쓴다(대칭). 통통한 체형일수록 크게 벌어진다.
const CLEAR = minArg === "clear";
let MIN = minArg != null && minArg !== "auto" && !CLEAR ? (+minArg * Math.PI) / 180 : CLEAR ? -Math.PI : null; // clear: 각도 제한 없이 몸통 뚫기만 막음
// 몸통 단면(쉬는 자세, 1cm 높이마다 타원): 몸통 뼈(엉덩이·척추) 가중치 > 0.6 정점의 좌우·앞뒤 범위
const HIPS_NODE = byName(/(^|:)Hips$/), HIPS_REST = { p: worldPos(HIPS_NODE), q: worldRot(HIPS_NODE) };
const SLICES = new Map();
if (CLEAR) {
  const pr = doc.getRoot().listMeshes()[0].listPrimitives()[0], PP = pr.getAttribute("POSITION"), PJ = pr.getAttribute("JOINTS_0"), PW = pr.getAttribute("WEIGHTS_0");
  const sj = doc.getRoot().listSkins()[0].listJoints(), TORSO = new Set(sj.map((j, i) => (/(^|:)(Hips|Spine|Spine1|Spine2)$/.test(j.getName()) ? i : -1)).filter((i) => i >= 0));
  const jj = [], ww = [];
  for (let i = 0; i < PP.getCount(); i++) {
    PJ.getElement(i, jj); PW.getElement(i, ww); let t = 0; for (let k = 0; k < 4; k++) if (TORSO.has(jj[k])) t += ww[k];
    if (t < 0.6) continue;
    const v = PP.getElement(i, []), b = Math.round(v[1] / 0.01);
    const s = SLICES.get(b) || { x0: 9, x1: -9, z0: 9, z1: -9 };
    s.x0 = Math.min(s.x0, v[0]); s.x1 = Math.max(s.x1, v[0]); s.z0 = Math.min(s.z0, v[2]); s.z1 = Math.max(s.z1, v[2]);
    SLICES.set(b, s);
  }
}
// 점이 몸통 안이면 양수(얼마나 깊은지), 밖이면 0 — 팔 굵기만큼(2.2cm) 여유
function insideTorso(p) {
  const s = SLICES.get(Math.round(p[1] / 0.01));
  if (!s) return 0;
  const R = 0.022, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2, rx = (s.x1 - s.x0) / 2 + R, rz = (s.z1 - s.z0) / 2 + R;
  const e = ((p[0] - cx) / rx) ** 2 + ((p[2] - cz) / rz) ** 2;
  return e < 1 ? 1 - e : 0;
}
if (minArg === "auto") {
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const P = prim.getAttribute("POSITION"), JA = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0");
  const skinJ = doc.getRoot().listSkins()[0].listJoints();
  const TORSO = new Set(skinJ.map((j, i) => (/(^|:)(Hips|Spine|Spine1|Spine2)$/.test(j.getName()) ? i : -1)).filter((i) => i >= 0));
  const torso = [], jj = [], ww = [];
  for (let i = 0; i < P.getCount(); i++) { JA.getElement(i, jj); WA.getElement(i, ww); let t = 0; for (let k = 0; k < 4; k++) if (TORSO.has(jj[k])) t += ww[k]; if (t > 0.6) torso.push(P.getElement(i, [])); }
  const mid = [0, 1, 2].map((k) => (worldPos(arms[0].arm)[k] + worldPos(arms[1].arm)[k]) / 2);
  let need = 0;
  for (const a of arms) {
    const S = worldPos(a.arm), E = worldPos(a.fore), Hd = worldPos(byName(new RegExp(`(^|:)${a.side}Hand$`)));
    const L1 = Math.hypot(...[0, 1, 2].map((k) => E[k] - S[k])), L2 = Math.hypot(...[0, 1, 2].map((k) => Hd[k] - E[k]));
    const R = 0.035; // 팔·앞발 굵기 절반
    // 높이 y 에서 몸통이 이 쪽으로 나온 거리(중심선 기준)
    const halfW = (y, z) => { let m = 0; for (const p of torso) if (Math.abs(p[1] - y) < 0.015 && Math.abs(p[2] - z) < 0.06) m = Math.max(m, (p[0] - mid[0]) * a.sx); return m; };
    let th = 10;
    for (; th < 85; th += 1) {
      const r = (th * Math.PI) / 180, d = [Math.sin(r), -Math.cos(r)];
      const pts = [0.5, 1, 1.5, 2].map((u) => { const l = u <= 1 ? L1 * u : L1 + L2 * (u - 1); return [S[0] + a.sx * d[0] * l, S[1] + d[1] * l, S[2]]; });
      if (pts.every((p) => (p[0] - mid[0]) * a.sx >= halfW(p[1], p[2]) + R)) break;
    }
    need = Math.max(need, th + 4);
    console.log(`  ${a.side}: 몸통에 닿지 않는 벌림 ${th}°`);
  }
  MIN = (need * Math.PI) / 180;
}
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
  const rch = new Map(), tch = new Map();
  for (const c of anim.listChannels()) if (c.getTargetPath() === "translation") { const T = c.getSampler().getInput().getArray(), V = c.getSampler().getOutput().getArray(); tch.set(c.getTargetNode(), (t) => { let k = 0; while (k < T.length - 1 && T[k + 1] <= t + 1e-6) k++; return Array.from(V.slice(k * 3, k * 3 + 3)); }); }
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
    // 몸통 뚫기 막기(minArg "clear"): 팔꿈치·아래팔·손목·앞발이 몸통 단면 안이면 위팔을 바깥으로 돌려 밀어낸다(사용자 "손이 뱃속으로 사라진다")
    if (CLEAR && rch.get(a.arm) && a.handNode) {
      const c = rch.get(a.arm);
      const posAt2 = (node, t) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const tc = tch.get(x); const tr = tc ? tc(t) : x.getTranslation(); const r = rot(q, tr); p = [p[0] + r[0], p[1] + r[1], p[2] + r[2]]; q = qmul(q, at(x, t)); } return { p, q }; };
      for (let i = 0; i < c.v.length; i += 4) {
        const t = c.t[i / 4];
        const pa = posAt2(a.arm.getParentNode(), t), A = [0, 1, 2].map((k) => pa.p[k] + rot(pa.q, a.arm.getTranslation())[k]);
        // 몸통 자세(엉덩이 회전·위치)를 따라 단면을 옮겨 잰다: 몸통 좌표로 바꿔 쉬는 자세 단면과 비교
        const hp = posAt2(HIPS_NODE, t), hq = hp.q, hqi = qinv(hq), hr = HIPS_REST;
        const toRest = (p) => { const l = rot(hqi, [p[0] - hp.p[0], p[1] - hp.p[1], p[2] - hp.p[2]]); const w = rot(hr.q, l); return [w[0] + hr.p[0], w[1] + hr.p[1], w[2] + hr.p[2]]; };
        const qf = at(a.fore, t), qh = at(a.handNode, t), fT = a.fore.getTranslation(), hT = a.handNode.getTranslation();
        const pts = (qa) => { const qw = qmul(pa.q, qa), qwf = qmul(qw, qf); const E = [0, 1, 2].map((k) => A[k] + rot(qw, fT)[k]), Wr = [0, 1, 2].map((k) => E[k] + rot(qwf, hT)[k]), Pw = [0, 1, 2].map((k) => Wr[k] + rot(qmul(qwf, qh), a.pawOff)[k]); return [E, E.map((v, k) => (v + Wr[k]) / 2), Wr, Pw]; };
        const inside = (qa) => pts(qa).reduce((m, p) => Math.max(m, insideTorso(toRest(p))), 0);
        const q0 = c.v.slice(i, i + 4);
        if (inside(q0) <= 0) continue;
        // 두 방향 중 덜 돌려도 빠져나오는 쪽: 옆(바깥, 몸 앞뒤 축으로) 또는 앞(팔을 앞으로 들기, 몸 좌우 축으로)
        const F = rot(qinv(pa.q), [0, 0, 1]), Lx = rot(qinv(pa.q), [1, 0, 0]);
        const options = [];
        for (const [ax, test] of [[F, (e0, e1) => (e1[0] - e0[0]) * a.sx], [Lx, (e0, e1) => e1[2] - e0[2]]]) {
          const e0 = pts(q0)[2], e1 = pts(qmul(axisAngle(ax, 0.05), q0))[2];
          const sg = test(e0, e1) > 0 ? 1 : -1; // 바깥(옆) / 앞으로 가는 쪽
          const turn = (d) => qmul(axisAngle(ax, sg * d), q0);
          if (inside(turn(1.2)) > 0) { options.push([1.3, turn(1.2)]); continue; }
          let lo = 0, hi = 1.2;
          for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (inside(turn(mid)) > 0) lo = mid; else hi = mid; }
          options.push([hi, turn(hi)]);
        }
        options.sort((x, y) => x[0] - y[0]);
        c.v.set(norm(options[0][1]), i); fixed++;
      }
      c.acc.setArray(c.v);
    }
    // 앞발 높이 맞추기: 위팔을 바깥·안쪽으로 돌려 앞발 가운데가 HAND_Y 에 오게
    if (HAND_Y != null && rch.get(a.arm) && a.handNode) {
      const c = rch.get(a.arm);
      const posAt = (node, t) => { const ch = []; for (let x = node; x; x = x.getParentNode()) ch.unshift(x); let q = [0, 0, 0, 1], p = [0, 0, 0]; for (const x of ch) { const tc = tch.get(x); const tr = tc ? tc(t) : x.getTranslation(); const r = rot(q, tr); p = [p[0] + r[0], p[1] + r[1], p[2] + r[2]]; q = qmul(q, at(x, t)); } return { p, q }; };
      for (let i = 0; i < c.v.length; i += 4) {
        const t = c.t[i / 4];
        const pa = posAt(a.arm.getParentNode(), t), A = [pa.p[0] + rot(pa.q, a.arm.getTranslation())[0], pa.p[1] + rot(pa.q, a.arm.getTranslation())[1], pa.p[2] + rot(pa.q, a.arm.getTranslation())[2]];
        const qf = at(a.fore, t), fT = a.fore.getTranslation(), hT = a.handNode.getTranslation();
        const qh = at(a.handNode, t);
        const handY = (qa) => { const qw = qmul(pa.q, qa), qwf = qmul(qw, qf); const e = rot(qw, fT), h = rot(qwf, hT), pw = rot(qmul(qwf, qh), a.pawOff); return A[1] + e[1] + h[1] + pw[1]; }; // 앞발 가운데 높이
        const q0 = c.v.slice(i, i + 4);
        if (Math.abs(handY(q0) - HAND_Y) < 0.002) continue;
        const F = rot(qinv(pa.q), [0, 0, 1]);
        const sgn = handY(qmul(axisAngle(F, 0.05), q0)) > handY(qmul(axisAngle(F, -0.05), q0)) ? 1 : -1; // 바깥으로 돌리는 쪽(손이 올라감)
        const turn = (d) => qmul(axisAngle(F, sgn * d), q0);
        // 높으면 안쪽으로 조금(최대 9°, 몸통에 닿지 않게) 내리고, 낮으면 바깥으로 올린다 — 좌우·품종끼리 앞발 높이를 같게
        let lo = -0.16, hi = 1.2;
        if (handY(turn(lo)) > HAND_Y) { c.v.set(norm(turn(lo)), i); fixed++; continue; }
        for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (handY(turn(mid)) < HAND_Y) lo = mid; else hi = mid; }
        c.v.set(norm(turn(hi)), i); fixed++;
      }
      c.acc.setArray(c.v);
    }
  }
}
await io.write(out, doc);
console.log(`${path.basename(inp)}: 팔 채널 ${n}개, 고친 키 ${fixed}개 (쉬는 자세 각 ${arms.map((a) => a.side + " " + Math.round((a.restAb * 180) / Math.PI) + "°").join(", ")}, 최소 ${MIN != null ? Math.round((MIN * 180) / Math.PI) + "°" + (minArg === "auto" ? "(체형)" : "") : "쉬는 자세 각"}) → ${out}`);
