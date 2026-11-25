// AI 고양이 텍스처의 사실적인 눈을 카툰 눈으로 다시 칠한다(사용자 2026-11-25 "2D 카툰처럼, 텍스처로 처리").
// 카툰 눈(사용자 참고 그림): 흰자 동그라미 + 코 쪽 위로 치우친 검은 남색 눈동자 + 바깥 위 눈꺼풀 선 + 아래 반사 + 반짝임 하나.
//   node scripts/paint-ai-eyes.mjs <입력.glb> <출력.glb> [텍스처 크기=2048]
// 원본 텍스처(1024)에서는 눈이 30화소쯤이라 반짝임이 뭉개지므로 텍스처를 키운 뒤 칠한다. 이미 칠한 모델에 다시 돌리지 말 것(원본 눈에서).
// 눈 자리는 scripts/ai-face-marks.mjs 가 적은 extras.meowFace.eyes(가운데·반지름·방향)를 쓴다.
// 텍스처는 조각(UV 섬)으로 나뉘어 눈이 이음새에 걸치므로, 눈 근처 삼각형의 텍스처 화소마다 3D 위치를 구해
// 눈 앞에서 본 평면 좌표로 모양을 계산해 칠한다(이음새 양쪽이 이어짐).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const sharp = require("sharp");

const [inp, out, sizeArg = "2048"] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const R0 = doc.getRoot();
const mesh = R0.listMeshes()[0], prim = mesh.listPrimitives()[0];
const mf = (mesh.getExtras() || {}).meowFace;
if (!mf || !mf.eyes) { console.error("눈 자리 없음: 먼저 scripts/ai-face-marks.mjs"); process.exit(1); }
const P = prim.getAttribute("POSITION"), N = prim.getAttribute("NORMAL"), UV = prim.getAttribute("TEXCOORD_0"), ia = prim.getIndices().getArray();
const tex = prim.getMaterial().getBaseColorTexture();
const SIZE = +sizeArg;
const { data: px, info } = await sharp(Buffer.from(tex.getImage())).resize(SIZE, SIZE, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// 눈 앞에서 본 좌표 (s 오른쪽, t 위, 흰자 반지름 1), inner = 코 쪽 s 부호 → [색, 덮는 정도 0~1]
// 참고 그림(사용자 2026-11-25): 크림색 흰자 동그라미 안에 검은 남색 눈동자가 코 쪽 위로 치우쳐 바깥 아래로 흰자 초승달이 보이고,
// 위 바깥쪽에 두꺼운 눈꺼풀(속눈썹) 선이 끝이 살짝 삐치며, 눈동자 아래에 밝은 보라갈색 반사, 왼쪽 위에 흰 반짝임 하나.
const AA = 0.03;
const SCLERA = hex("#fbf5ec"), SCL_SH = hex("#d9d3d6"), EDGE = hex("#3a3344"), PUPIL = hex("#1d1a2b"), REFL = hex("#4c3f52"), LID = hex("#17141f");
const inside = (d, r) => 1 - ss(r - AA, r + AA, d);
function eyeAt(s, t, inner) {
  const d = Math.hypot(s, t);
  // 눈꺼풀: 바깥 위쪽 호(바깥 옆 → 꼭대기 조금 지나서), 가운데가 두껍고 양 끝이 가늘다. 바깥 끝은 살짝 위로 삐침
  const th = Math.atan2(t, s * -inner); // 0 = 바깥 옆, π/2 = 위
  let lid = 0;
  {
    const a0 = 0.08, a1 = Math.PI * 0.8; // 바깥 옆 조금 아래 ~ 꼭대기 지나 코 쪽
    if (th > a0 - 0.3 && th < a1) {
      const u = Math.min(1, Math.max(0, (th - a0) / (a1 - a0)));
      const w = 0.22 * Math.sin(Math.PI * Math.min(1, u * 1.08)) ** 0.6; // 두께(위쪽은 둥글게 꺾여 줄어 보이므로 그림보다 두껍게)
      const r0 = 0.93 + (u < 0.12 ? (0.12 - u) * 0.8 : 0); // 흰자 가장자리에 바짝, 바깥 끝은 바깥으로 삐침
      lid = inside(Math.abs(d - (r0 + w / 2)), w / 2) * (w > 0.01 ? 1 : 0);
    }
  }
  const cover = Math.max(inside(d, 1), lid);
  if (cover <= 0.001) return null;
  // 흰자(위쪽은 눈꺼풀 그늘로 살짝 회색) + 가는 테두리
  let col = mix(SCLERA, SCL_SH, ss(0.2, 0.95, t) * 0.6);
  col = mix(col, EDGE, ss(0.94, 1.0, d) * 0.3);
  // 눈동자: 코 쪽 위로 치우친 동그라미
  const pc = [inner * 0.12, 0.1], pr = 0.86;
  const ps = s - pc[0], pt = t - pc[1], pd = Math.hypot(ps, pt) / pr;
  const kp = inside(pd, 1);
  let pcol = PUPIL;
  // 눈동자 아래쪽 반사(밝은 보라갈색 타원)
  pcol = mix(pcol, REFL, (1 - ss(0.75, 1.05, Math.hypot(ps / (pr * 0.8), (pt + pr * 0.62) / (pr * 0.55)))) * 0.9);
  // 흰 반짝임(왼쪽 위)
  pcol = mix(pcol, WHITE, inside(Math.hypot(ps + pr * 0.34, pt - pr * 0.32), pr * 0.22));
  col = mix(col, pcol, kp);
  col = mix(col, LID, lid);
  return [col, cover];
}

const n = P.getCount(), pos = [], uv = [], nor = [];
for (let i = 0; i < n; i++) { pos.push(P.getElement(i, [])); uv.push(UV.getElement(i, [])); nor.push(N.getElement(i, [])); }
// 1) 화소마다 주인 삼각형(화소 가운데가 안에 드는 삼각형). 조각 사이 빈 칸(주인 없음)은 3) 에서 메운다
const owner = new Int32Array(W * H).fill(-1);
const tri = (f) => { const A = ia[f], B = ia[f + 1], C = ia[f + 2]; return [A, B, C, [uv[A][0] * W, uv[A][1] * H], [uv[B][0] * W, uv[B][1] * H], [uv[C][0] * W, uv[C][1] * H]]; };
const bary = (ua, ub, uc, qx, qy) => {
  const den = (ub[1] - uc[1]) * (ua[0] - uc[0]) + (uc[0] - ub[0]) * (ua[1] - uc[1]);
  if (Math.abs(den) < 1e-12) return null;
  const wa = ((ub[1] - uc[1]) * (qx - uc[0]) + (uc[0] - ub[0]) * (qy - uc[1])) / den;
  const wb = ((uc[1] - ua[1]) * (qx - uc[0]) + (ua[0] - uc[0]) * (qy - uc[1])) / den;
  return [wa, wb, 1 - wa - wb];
};
for (let f = 0; f < ia.length; f += 3) {
  const [, , , ua, ub, uc] = tri(f);
  const x0 = Math.max(0, Math.floor(Math.min(ua[0], ub[0], uc[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(ua[0], ub[0], uc[0])));
  const y0 = Math.max(0, Math.floor(Math.min(ua[1], ub[1], uc[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(ua[1], ub[1], uc[1])));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const w = bary(ua, ub, uc, x + 0.5, y + 0.5);
    if (w && w[0] >= -1e-6 && w[1] >= -1e-6 && w[2] >= -1e-6) owner[y * W + x] = f;
  }
}
// 2) 눈 근처 삼각형의 자기 화소를 칠한다
const painted = new Uint8Array(W * H);
let cnt = 0;
for (const eye of mf.eyes.filter(Boolean)) {
  // 그림 눈은 아래쪽 밝은 홍채까지 있어 어두운 부분(찾은 자리)보다 크고 아래로 내려와 있다 → 조금 아래·크게
  const R = eye.r * 1.35;
  const c = [eye.c[0], eye.c[1] - eye.r * 0.15, eye.c[2]];
  const nn = norm(eye.n);
  // 모양을 재는 평면: 두 눈이 같은 방향으로 보이게(반짝임 자리가 같게) 눈 방향과 정면(+Z)의 중간. s 오른쪽, t 위
  const nf = norm([nn[0], nn[1], nn[2] + 1.5]);
  const right = norm(cross([0, 1, 0], nf)), up = norm(cross(nf, right));
  const inner = Math.sign(dot(sub(mf.nose, c), right)) || 1; // 코 쪽이 s 의 어느 부호인지
  const near = new Uint8Array(ia.length / 3);
  for (let f = 0; f < ia.length; f += 3) {
    const A = ia[f], B = ia[f + 1], C = ia[f + 2];
    const d = sub([0, 1, 2].map((k) => (pos[A][k] + pos[B][k] + pos[C][k]) / 3), c);
    if (Math.hypot(dot(d, right), dot(d, up)) > R * 1.6 || Math.abs(dot(d, nn)) > R * 0.9) continue; // 눈 앞쪽 가까운 면만
    if (dot(nor[A], nn) + dot(nor[B], nn) + dot(nor[C], nn) < 0) continue; // 눈과 같은 쪽을 보는 면(눈 안의 작은 주름 면까지)
    near[f / 3] = 1;
  }
  // 화소마다 눈 평면 좌표
  const st = new Map();
  for (let i = 0; i < W * H; i++) {
    const f = owner[i];
    if (f < 0 || !near[f / 3]) continue;
    const [A, B, C, ua, ub, uc] = tri(f);
    const w = bary(ua, ub, uc, (i % W) + 0.5, Math.floor(i / W) + 0.5);
    const q = sub([0, 1, 2].map((k) => pos[A][k] * w[0] + pos[B][k] * w[1] + pos[C][k] * w[2]), c);
    st.set(i, [dot(q, right) / R, dot(q, up) / R]);
  }
  // 둘레 털색: 방향(30칸)마다 카툰 눈 바깥 1.35~1.6 고리의 평균색 — 원래 눈이 카툰 눈보다 큰 곳(1.0~1.32)을 같은 방향 털색으로 덮는다
  const NB = 30, acc = Array.from({ length: NB }, () => [0, 0, 0, 0]);
  const bin = (a, b) => ((Math.floor(((Math.atan2(b, a) + Math.PI) / (2 * Math.PI)) * NB) % NB) + NB) % NB;
  for (const [i, [a, b]] of st) { const e = Math.hypot(a, b); if (e > 1.35 && e < 1.6) { const k = acc[bin(a, b)]; k[0] += px[i * 4]; k[1] += px[i * 4 + 1]; k[2] += px[i * 4 + 2]; k[3]++; } }
  const furAt = (a, b) => { for (let o = 0; o < NB / 2; o++) for (const sg of [1, -1]) { const k = acc[(bin(a, b) + sg * o + NB) % NB]; if (k[3] > 3) return [k[0] / k[3], k[1] / k[3], k[2] / k[3]]; } return null; };
  for (const [i, [es, et]] of st) {
    const r = eyeAt(es, et, inner);
    if (!r) {
      // 카툰 눈보다 큰 원래 눈의 남은 테두리(어두운 갈색·호박색)를 같은 방향 털색으로 덮는다
      const e = Math.hypot(es, et), fur = e < 1.32 ? furAt(es, et) : null;
      if (fur) {
        const diff = Math.hypot(px[i * 4] - fur[0], px[i * 4 + 1] - fur[1], px[i * 4 + 2] - fur[2]);
        const t = (1 - ss(1.2, 1.32, e)) * ss(25, 60, diff);
        for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.round(px[i * 4 + k] * (1 - t) + fur[k] * t);
      }
      continue;
    }
    const [col, a] = r;
    for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.round(px[i * 4 + k] * (1 - a) + col[k] * a);
    painted[i] = 1; cnt++;
  }
}
// 3) 조각 둘레 빈 칸(주인 없음)을 옆 칠한 색으로 6화소 번지게 — 이음새·축소(밉맵) 때 원래 눈 색이 새어 나오지 않게
for (let it = 0; it < 6; it++) {
  const add = [];
  for (let i = 0; i < W * H; i++) {
    if (painted[i] || owner[i] >= 0) continue;
    const x = i % W, y = (i / W) | 0;
    let r = 0, g = 0, b = 0, k = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (!painted[j]) continue;
      r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; k++;
    }
    if (k) add.push([i, r / k, g / k, b / k]);
  }
  for (const [i, r, g, b] of add) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; painted[i] = 1; }
}
const mime = tex.getMimeType();
const img = sharp(px, { raw: { width: W, height: H, channels: 4 } });
const buf = mime === "image/webp" ? await img.webp({ quality: 92 }).toBuffer() : mime === "image/jpeg" ? await img.jpeg({ quality: 92 }).toBuffer() : await img.png().toBuffer();
tex.setImage(new Uint8Array(buf));
await io.write(out, doc);
console.log(`${path.basename(inp)}: 카툰 눈 ${mf.eyes.filter(Boolean).length}개, 칠한 화소 ${cnt} → ${out}`);
