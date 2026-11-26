// 옛 고양이 품종 무늬(skins/<품종>.webp, 옛 체형 UV)를 새 AI 기본 모델(체형별 4종)의 텍스처로 옮겨 품종 모델을 만든다(사용자 2026-11-26 "4체형에 무늬 조합").
//   node scripts/ai-skin-transfer.mjs <새 기본.glb> <옛 체형.glb> <옛 무늬.webp> <출력.glb>
// 몸을 부위(머리·목·몸통·위팔·아래팔·손·허벅지·정강이·발·꼬리)로 나누고, 부위마다 축(팔다리는 관절→다음 관절, 머리·목·몸통은 세로, 꼬리는 주성분)을 기준으로
// 원기둥 좌표(축 방향 비율 t, 축 둘레 각 θ — 앞을 0)를 잡아 옛 모델의 같은 부위·같은 (t, θ) 자리 무늬를 가져온다. 새 모델의 털결 명암(밝기 / 주변 평균)은 남기고,
// 새 모델의 코·입·볼(분홍)·입 선·수염(어두운 갈색, 머리)은 그대로 둔다. 눈 자리는 털로 채우고, 이 다음에 MEOW_NO_ERASE=1 node scripts/paint-ai-eyes.mjs 로 눈만 덧그린다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { MeshoptDecoder } = require("meshoptimizer");
const sharp = require("sharp");

const [newGlb, oldGlb, oldSkin, out] = process.argv.slice(2);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

// 부위: [이름, 새 뼈들, 옛 뼈들, 축 종류(joint = 첫 뼈 관절→자식 관절 | up = 세로 | pca), 자식 관절(새, 옛)]
const REG = [
  ["head", ["mixamorig:Head"], ["head", "ear.L", "ear.R"], "up"],
  ["neck", ["mixamorig:Neck"], ["neck"], "up"],
  ["body", ["Root", "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:LeftShoulder", "mixamorig:RightShoulder"], ["root", "hips", "spine", "chest"], "up"],
  ...["Left", "Right"].flatMap((S) => {
    const s = S === "Left" ? "L" : "R";
    return [
      ["uarm" + s, [`mixamorig:${S}Arm`], [`upper_arm.${s}`], "joint", [`mixamorig:${S}ForeArm`, `forearm.${s}`]],
      ["farm" + s, [`mixamorig:${S}ForeArm`], [`forearm.${s}`], "joint", [`mixamorig:${S}Hand`, `hand.${s}`]],
      ["hand" + s, [`mixamorig:${S}Hand`], [`hand.${s}`], "pca"],
      ["thigh" + s, [`mixamorig:${S}UpLeg`], [`thigh.${s}`], "joint", [`mixamorig:${S}Leg`, `shin.${s}`]],
      ["shin" + s, [`mixamorig:${S}Leg`], [`shin.${s}`], "joint", [`mixamorig:${S}Foot`, `foot.${s}`]],
      ["foot" + s, [`mixamorig:${S}Foot`, `mixamorig:${S}ToeBase`], [`foot.${s}`], "pca"],
    ];
  }),
  ["tail", ["tail_root", "tail_01", "tail_02", "tail_03", "tail_04"], ["tail_01", "tail_02", "tail_03", "tail_04"], "pca"],
];

/** 모델 읽기: 정점·UV·삼각형·정점마다 부위·관절 자리 */
async function loadModel(file) {
  const doc = await io.read(file);
  const R = doc.getRoot(), mesh = R.listMeshes().find((m) => m.listPrimitives()[0].getAttribute("JOINTS_0")) || R.listMeshes()[0];
  const prim = mesh.listPrimitives()[0];
  const P = prim.getAttribute("POSITION"), UV = prim.getAttribute("TEXCOORD_0"), J = prim.getAttribute("JOINTS_0"), WA = prim.getAttribute("WEIGHTS_0");
  const joints = R.listSkins()[0].listJoints();
  const jpos = {}; for (const j of joints) { const m = j.getWorldMatrix(); jpos[j.getName()] = [m[12], m[13], m[14]]; }
  const n = P.getCount(), pos = [], uv = [], reg = new Int16Array(n).fill(-1);
  const isNew = joints.some((j) => j.getName().startsWith("mixamorig:"));
  const jreg = joints.map((j) => REG.findIndex((r) => (isNew ? r[1] : r[2]).includes(j.getName())));
  for (let i = 0; i < n; i++) {
    pos.push(P.getElement(i, [])); uv.push(UV.getElement(i, []));
    const jj = J.getElement(i, []), ww = WA.getElement(i, []);
    const acc = new Map(); for (let k = 0; k < 4; k++) if (ww[k] > 0 && jreg[jj[k]] >= 0) acc.set(jreg[jj[k]], (acc.get(jreg[jj[k]]) || 0) + ww[k]);
    let best = -1, bw = 0; for (const [r, w] of acc) if (w > bw) { bw = w; best = r; }
    reg[i] = best;
  }
  return { doc, prim, pos, uv, reg, ia: prim.getIndices().getArray(), jpos, isNew };
}
const NEW = await loadModel(newGlb), OLD = await loadModel(oldGlb);

/** 부위마다 원기둥 좌표틀: 축 A→B(단위 d), 앞 기준 ref, t 범위 */
function frames(M) {
  const F = [];
  REG.forEach((r, ri) => {
    const vs = []; for (let i = 0; i < M.pos.length; i++) if (M.reg[i] === ri) vs.push(M.pos[i]);
    if (vs.length < 10) { F.push(null); return; }
    const c = [0, 1, 2].map((k) => vs.reduce((s, p) => s + p[k], 0) / vs.length);
    let d;
    if (r[3] === "up") d = [0, 1, 0];
    else if (r[3] === "joint") { const a = M.jpos[(M.isNew ? r[1] : r[2])[0]], b = M.jpos[M.isNew ? r[4][0] : r[4][1]]; d = norm(sub(b, a)); }
    else { // 주성분(멱법)
      let v = [1, 0.3, 0.2];
      for (let it = 0; it < 30; it++) { const nv = [0, 0, 0]; for (const p of vs) { const q = sub(p, c), s = dot(q, v); nv[0] += q[0] * s; nv[1] += q[1] * s; nv[2] += q[2] * s; } v = norm(nv); }
      d = v;
      // 몸에서 멀어지는 쪽을 + 로(팔다리 끝·꼬리 끝)
      const hip = M.jpos[M.isNew ? "mixamorig:Hips" : "hips"]; if (dot(sub(c, hip), d) < 0) d = mul(d, -1);
    }
    let ref = [0, 0, 1]; if (Math.abs(dot(ref, d)) > 0.9) ref = [0, 1, 0];
    ref = norm(sub(ref, mul(d, dot(ref, d)))); const side = cross(d, ref);
    let t0 = Infinity, t1 = -Infinity; for (const p of vs) { const t = dot(sub(p, c), d); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    F.push({ c, d, ref, side, t0, t1 });
  });
  return F;
}
const FN = frames(NEW), FO = frames(OLD);
const tc = (f, p) => { const q = sub(p, f.c), t = (dot(q, f.d) - f.t0) / Math.max(1e-6, f.t1 - f.t0); const r = sub(q, mul(f.d, dot(q, f.d))); return [t, Math.atan2(dot(r, f.side), dot(r, f.ref))]; };

// 옛 모델: 부위마다 (t, θ) 격자 → UV. 삼각형을 격자에 그림(θ 가 ±π 를 넘나드는 삼각형은 두 번)
const G = 160;
const grids = REG.map(() => ({ u: new Float32Array(G * G).fill(NaN), v: new Float32Array(G * G) }));
for (let f = 0; f < OLD.ia.length; f += 3) {
  const ids = [OLD.ia[f], OLD.ia[f + 1], OLD.ia[f + 2]];
  const rs = ids.map((i) => OLD.reg[i]); const r = rs[0] === rs[1] || rs[0] === rs[2] ? rs[0] : rs[1];
  if (r < 0 || !FO[r]) continue;
  if (ids.some((i) => OLD.uv[i][0] >= 0.945)) continue; // 옛 무늬 오른쪽 끝 색 띠·눈 그림 칸(EYE_RECT, 눈알·넥타이 등 따로 붙은 조각) — 털이 아님
  let pts = ids.map((i) => tc(FO[r], OLD.pos[i]));
  const th = pts.map((p) => p[1]);
  const shifts = Math.max(...th) - Math.min(...th) > Math.PI ? [pts.map(([t, a]) => [t, a < 0 ? a + 2 * Math.PI : a]), pts.map(([t, a]) => [t, a > 0 ? a - 2 * Math.PI : a])] : [pts];
  for (const sp of shifts) {
    const gx = sp.map(([t, a]) => [t * (G - 1), ((a + Math.PI) / (2 * Math.PI)) * (G - 1)]);
    const x0 = Math.max(0, Math.floor(Math.min(...gx.map((p) => p[0])))), x1 = Math.min(G - 1, Math.ceil(Math.max(...gx.map((p) => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...gx.map((p) => p[1])))), y1 = Math.min(G - 1, Math.ceil(Math.max(...gx.map((p) => p[1]))));
    const [A, B, C] = gx, den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(den) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const wa = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den, wb = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den, wc = 1 - wa - wb;
      if (wa < -0.02 || wb < -0.02 || wc < -0.02) continue;
      const k = y * G + x, U = ids.map((i) => OLD.uv[i]);
      grids[r].u[k] = U[0][0] * wa + U[1][0] * wb + U[2][0] * wc; grids[r].v[k] = U[0][1] * wa + U[1][1] * wb + U[2][1] * wc;
    }
  }
}
for (const g of grids) for (let it = 0; it < 40; it++) { // 빈 칸 메우기(θ 는 감아 돌기)
  let left = 0; const nu = g.u.slice(), nv = g.v.slice();
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const k = y * G + x; if (!isNaN(g.u[k])) continue;
    let su = 0, sv = 0, c = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = (y + dy + G) % G; if (xx < 0 || xx >= G) continue; const j = yy * G + xx; if (!isNaN(g.u[j])) { su += g.u[j]; sv += g.v[j]; c++; } }
    if (c) { nu[k] = su / c; nv[k] = sv / c; } else left++;
  }
  g.u = nu; g.v = nv; if (!left) break;
}

// 옛 무늬 그림
const { data: sk, info: si } = await sharp(oldSkin).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const skAt = (u, v) => { // 겹선형
  const x = Math.min(si.width - 1.001, Math.max(0, u * si.width - 0.5)), y = Math.min(si.height - 1.001, Math.max(0, v * si.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, o = [0, 0, 0];
  for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) { const i = ((y0 + dy) * si.width + x0 + dx) * 4; o[0] += sk[i] * w; o[1] += sk[i + 1] * w; o[2] += sk[i + 2] * w; }
  return o;
};
// 옛 머리 털의 보통 색(볼·코 분홍을 덮을 때)
const pink = (c) => c[0] - c[1] > 35 && c[0] > 140 && c[2] > c[1] - 5;

// 새 텍스처
const tex = NEW.prim.getMaterial().getBaseColorTexture();
const { data: px, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const lum = new Float32Array(W * H); for (let i = 0; i < W * H; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
// 주변 평균 밝기(상자 흐림 두 번, 반지름 10)
const blur = (src, r) => { const t = new Float32Array(W * H), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * W + Math.min(W - 1, Math.max(0, x))]; for (let x = 0; x < W; x++) { t[y * W + x] = s / (2 * r + 1); s += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + x]; for (let y = 0; y < H; y++) { o[y * W + x] = s / (2 * r + 1); s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
  return o; };
const mean = blur(blur(lum, 10), 10);
// 화소마다 주인 삼각형
const owner = new Int32Array(W * H).fill(-1);
const NU = NEW.uv, NP = NEW.pos, NI = NEW.ia;
for (let f = 0; f < NI.length; f += 3) {
  const A = NU[NI[f]], B = NU[NI[f + 1]], C = NU[NI[f + 2]];
  const ax = A[0] * W, ay = A[1] * H, bx = B[0] * W, by = B[1] * H, cx = C[0] * W, cy = C[1] * H;
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(den) < 1e-12) continue;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const qx = x + 0.5, qy = y + 0.5, wa = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / den, wb = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / den;
    if (wa >= -1e-6 && wb >= -1e-6 && 1 - wa - wb >= -1e-6) owner[y * W + x] = f;
  }
}
const EYES = ((NEW.prim.listParents ? null : null) || []).concat((((NEW.doc.getRoot().listMeshes()[0].getExtras() || {}).meowFace || {}).eyes || []).filter(Boolean));
const headR = REG.findIndex((r) => r[0] === "head");
const outPx = Buffer.from(px);
let done = 0, kept = 0;
for (let i = 0; i < W * H; i++) {
  const f = owner[i]; if (f < 0) continue;
  const ids = [NI[f], NI[f + 1], NI[f + 2]];
  const rs = ids.map((k) => NEW.reg[k]); const r = rs[0] === rs[1] || rs[0] === rs[2] ? rs[0] : rs[1];
  if (r < 0 || !FN[r]) continue;
  const base = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
  const A = NU[ids[0]], B = NU[ids[1]], C = NU[ids[2]], qx = (i % W) + 0.5, qy = Math.floor(i / W) + 0.5;
  const ax = A[0] * W, ay = A[1] * H, bx = B[0] * W, by = B[1] * H, cx = C[0] * W, cy = C[1] * H;
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const wa = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / den, wb = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / den, wc = 1 - wa - wb;
  const p = add(add(mul(NP[ids[0]], wa), mul(NP[ids[1]], wb)), mul(NP[ids[2]], wc));
  // 새 모델 얼굴 그림(코·입·볼 분홍, 입 선·수염 어두운 갈색)은 그대로 — 눈 자리는 털로 채우고 눈은 뒤에 다시 그린다
  const inEye = EYES.some((e) => Math.hypot(...sub(p, e.c)) < e.r * 1.35 * 2.2); // 눈구멍 안쪽 벽의 원래 눈알 조각까지
  if (r === headR && !inEye && (pink(base) || lum[i] < 70)) { kept++; continue; }
  const [t, a] = tc(FN[r], p);
  const gx = Math.min(G - 1, Math.max(0, Math.round(Math.min(1, Math.max(0, t)) * (G - 1)))), gy = Math.min(G - 1, Math.max(0, Math.round(((a + Math.PI) / (2 * Math.PI)) * (G - 1))));
  const g = grids[r]; if (!g || isNaN(g.u[gy * G + gx])) continue;
  let col = skAt(g.u[gy * G + gx], g.v[gy * G + gx]);
  if (r === headR && pink(col)) { // 옛 볼·코 분홍은 둘레 털색으로(새 얼굴엔 새 모델 볼·코가 따로 있음)
    const ring = []; for (const [dx, dy] of [[4, 0], [-4, 0], [0, 4], [0, -4], [8, 0], [-8, 0], [0, 8], [0, -8]]) { const x = Math.min(G - 1, Math.max(0, gx + dx)), y = (gy + dy + G) % G; const c2 = skAt(g.u[y * G + x], g.v[y * G + x]); if (!pink(c2)) ring.push(c2); }
    if (ring.length) col = [0, 1, 2].map((k) => ring.reduce((s, c2) => s + c2[k], 0) / ring.length);
  }
  const det = Math.min(1.35, Math.max(0.6, lum[i] / Math.max(1, mean[i])));
  for (let k = 0; k < 3; k++) outPx[i * 4 + k] = Math.max(0, Math.min(255, Math.round(col[k] * det)));
  done++;
}
// 조각 둘레 빈 칸(주인 없음)으로 번지게 — 빈 칸에 남은 기본 모델 색(치즈 주황 등)이 멀리서 볼 때(밉맵) 조각 가장자리로 새지 않게 끝까지
const filled = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) filled[i] = owner[i] >= 0 ? 1 : 0;
for (let it = 0; it < 64; it++) {
  const add2 = [];
  for (let i = 0; i < W * H; i++) { if (filled[i]) continue; const x = i % W, y = (i / W) | 0; let s = [0, 0, 0], c = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (filled[j]) { s[0] += outPx[j * 4]; s[1] += outPx[j * 4 + 1]; s[2] += outPx[j * 4 + 2]; c++; } }
    if (c) add2.push([i, s.map((v) => v / c)]); }
  for (const [i, s] of add2) { outPx[i * 4] = s[0]; outPx[i * 4 + 1] = s[1]; outPx[i * 4 + 2] = s[2]; filled[i] = 1; }
}
const img = sharp(outPx, { raw: { width: W, height: H, channels: 4 } });
tex.setImage(new Uint8Array(await img.webp({ quality: 92 }).toBuffer())); tex.setMimeType("image/webp");
await io.write(out, NEW.doc);
console.log(`${path.basename(oldSkin)} → ${path.basename(out)}: 옮긴 화소 ${done}, 얼굴 그림 그대로 ${kept}, 부위 ${FN.filter(Boolean).length}/${REG.length}(옛 ${FO.filter(Boolean).length})`);
