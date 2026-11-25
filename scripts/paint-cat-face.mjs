// 고양이 얼굴 다듬기: 품종 털 무늬(assets/src3d/models/cats/skins/<품종>.png)에 눈 그림과 볼 홍조를 그려 넣는다.
//   node scripts/paint-cat-face.mjs            모든 품종
//   node scripts/paint-cat-face.mjs persian    한 품종만
// 그 다음 npm run optimize-assets 로 ui/office/models/cats/skins/*.webp 를 다시 만든다.
//
// 눈: 모델의 눈은 따로 떨어진 타원 조각이고 UV 가 오른쪽 색 띠의 한 점(눈 색)을 가리켜 단색이었다(어두운 얼굴에서 안 보임).
//     색 띠 위쪽의 쓰지 않는 검은 칸(EYE_RECT)에 홍채·동공·반짝임을 그린 눈 그림을 넣고,
//     ui/office/catmodel.js 의 remapEyeUV 가 불러올 때 눈 조각의 UV 를 이 칸으로 펴 준다(모델 파일은 그대로). 두 값은 같아야 한다.
// 볼: 체형 모델에서 눈 바깥 아래 볼 자리의 얼굴 정점 UV 를 찾아, 그 자리에 옅은 분홍을 흐리게 칠한다.
// 원본은 assets/src3d-orig/cat-skins/ 에 처음 한 번 복사해 두고 언제나 원본에서 다시 그린다(여러 번 돌려도 겹쳐 칠해지지 않음).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const sharp = require("sharp");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");

const SRC = path.join(root, "assets/src3d/models/cats");
const SKINS = path.join(SRC, "skins");
const ORIG = path.join(root, "assets/src3d-orig/cat-skins"); // 원본 백업 — optimize-assets 가 훑는 src3d 밖(이 PC 전용, .git/info/exclude)
const SIZE = 1024;

/** 눈 그림 칸(px, 1024 텍스처 기준) — catmodel.js EYE_RECT 와 같아야 한다. 색 띠(x ≥ 972) 위쪽의 쓰지 않는 칸 */
export const EYE_RECT = { x: 980, y: 24, w: 36, h: 54 }; // 눈 조각 가로:세로 ≈ 1:1.5

/** 품종 → 홍채 색. 없으면 호박색 */
const IRIS = {
  siamese: "#4f93e6", ragdoll: "#4f93e6", turkish_angora: "#6fb6ec",
  russian_blue: "#4fb865", sphynx: "#8cc063", american_shorthair: "#9db347",
  bengal: "#b9b23c", maine_coon: "#bdae45", norwegian_forest: "#a9b54a",
  persian: "#dc8b3c",
};
const AMBER = "#e3a63b";

/** 품종 → 체형 (catmodel.js BREEDS 와 같음) */
const BODY = {
  siamese: "standard", russian_blue: "standard", persian: "longhair", scottish_fold: "foldear", munchkin: "shortleg",
  maine_coon: "longhair", bengal: "standard", sphynx: "standard", ragdoll: "longhair", norwegian_forest: "longhair",
  turkish_angora: "longhair", korean_cheese: "standard", korean_tabby: "standard", korean_calico: "standard",
  korean_tuxedo: "standard", american_shorthair: "standard", boss: "standard",
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");

/** 눈 그림 SVG (칸 크기의 4배로 그려 줄여서 매끈하게) */
function eyeSvg(iris) {
  const c = hex(iris), W = EYE_RECT.w * 4, H = EYE_RECT.h * 4;
  const light = mix(c, [255, 255, 255], 0.45), dark = mix(c, [0, 0, 0], 0.35), rim = "#1c1510";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="none">
  <defs><radialGradient id="g" cx="50%" cy="70%" r="65%"><stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${iris}"/><stop offset="1" stop-color="${dark}"/></radialGradient></defs>
  <rect width="100" height="100" fill="${rim}"/>
  <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#g)"/>
  <ellipse cx="50" cy="48" rx="21" ry="38" fill="#120d0a"/><!-- 고양이 동공: 세로로 긴 타원(너무 가늘면 날카로워 보임) -->
  <ellipse cx="50" cy="50" rx="46" ry="46" fill="none" stroke="${rim}" stroke-width="5"/>
  <ellipse cx="36" cy="31" rx="13" ry="11" fill="#ffffff"/>
  <ellipse cx="64" cy="67" rx="6" ry="5" fill="#ffffff" fill-opacity="0.9"/>
</svg>`);
}

/** 체형 모델에서 눈 조각 범위와 볼 자리(UV px·반지름 px)를 구한다 */
async function faceInfo(body) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(path.join(SRC, `cat_${body}.glb`));
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const P = prim.getAttribute("POSITION"), T = prim.getAttribute("TEXCOORD_0");
  const pos = [], uv = [], p = [], t = [];
  for (let i = 0; i < P.getCount(); i++) { P.getElement(i, p); T.getElement(i, t); pos.push([...p]); uv.push([...t]); }
  const isEye = (i) => uv[i][0] > 0.94 && uv[i][1] > 0.58 && uv[i][1] < 0.72;
  const eyes = [-1, 1].map((s) => {
    const ids = pos.map((_, i) => i).filter((i) => isEye(i) && Math.sign(pos[i][0]) === s);
    const mn = [0, 1, 2].map((a) => Math.min(...ids.map((i) => pos[i][a]))), mx = [0, 1, 2].map((a) => Math.max(...ids.map((i) => pos[i][a])));
    return { mn, mx };
  });
  // 볼: 얼굴 무늬에서 눈 구멍 자리(눈 가운데에 가장 가까운 얼굴 정점의 UV)를 찾고, 두 눈 사이 간격 기준으로 바깥·아래로 옮긴다
  const holes = eyes.map(({ mn, mx }) => {
    const c = [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
    let best = -1, bd = Infinity;
    for (let i = 0; i < pos.length; i++) {
      if (uv[i][0] > 0.94) continue;
      const d = Math.hypot(pos[i][0] - c[0], pos[i][1] - c[1], pos[i][2] - c[2]);
      if (d < bd) { bd = d; best = i; }
    }
    return { u: uv[best][0] * SIZE, v: uv[best][1] * SIZE, dist: bd };
  });
  const sep = Math.hypot(holes[1].u - holes[0].u, holes[1].v - holes[0].v), mid = (holes[0].u + holes[1].u) / 2;
  const cheeks = holes.map((h) => ({ u: h.u + Math.sign(h.u - mid) * sep * 0.22, v: h.v + sep * 0.30, r: sep * 0.2, dist: h.dist }));
  // 코: 색 띠 어두운 칸을 쓰는 가운데 정점(코 테두리) 중 가장 앞 → 그 자리에 가장 가까운 얼굴 정점 UV 에 분홍(테두리 안을 채움)
  let tip = -1;
  for (let i = 0; i < pos.length; i++) if (uv[i][0] > 0.94 && uv[i][1] > 0.88 && Math.abs(pos[i][0]) < 0.04 && (tip < 0 || pos[i][2] > pos[tip][2])) tip = i;
  let nose = null;
  if (tip >= 0) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < pos.length; i++) {
      if (uv[i][0] > 0.94) continue;
      const d = Math.hypot(pos[i][0] - pos[tip][0], pos[i][1] - pos[tip][1], pos[i][2] - pos[tip][2]);
      if (d < bd) { bd = d; best = i; }
    }
    nose = { u: uv[best][0] * SIZE, v: uv[best][1] * SIZE, r: sep * 0.075, dist: bd };
  }
  return { eyes, cheeks, nose };
}

function blushSvg(cheeks, nose) {
  const blobs = cheeks.map((c, i) => `<radialGradient id="b${i}"><stop offset="0" stop-color="#ff8f9c" stop-opacity="0.55"/><stop offset="0.6" stop-color="#ff8f9c" stop-opacity="0.22"/><stop offset="1" stop-color="#ff8f9c" stop-opacity="0"/></radialGradient>
  <ellipse cx="${c.u.toFixed(1)}" cy="${c.v.toFixed(1)}" rx="${(c.r * 1.25).toFixed(1)}" ry="${c.r.toFixed(1)}" fill="url(#b${i})"/>`).join("\n");
  const n = nose ? `<ellipse cx="${nose.u.toFixed(1)}" cy="${nose.v.toFixed(1)}" rx="${nose.r.toFixed(1)}" ry="${(nose.r * 0.8).toFixed(1)}" fill="#f29aa8"/>` : "";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><defs></defs>${blobs}${n}</svg>`);
}

const only = process.argv[2];
fs.mkdirSync(ORIG, { recursive: true });
const infos = {};
for (const breed of Object.keys(BODY)) {
  if (only && breed !== only) continue;
  const file = path.join(SKINS, `${breed}.png`), orig = path.join(ORIG, `${breed}.png`);
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
  const body = BODY[breed];
  infos[body] ||= await faceInfo(body);
  const { cheeks, nose } = infos[body];
  const eye = await sharp(eyeSvg(IRIS[breed] || AMBER)).resize(EYE_RECT.w, EYE_RECT.h).png().toBuffer();
  await sharp(orig)
    .composite([{ input: blushSvg(cheeks, nose), left: 0, top: 0 }, { input: eye, left: EYE_RECT.x, top: EYE_RECT.y }])
    .png().toFile(file + ".tmp");
  fs.renameSync(file + ".tmp", file);
  console.log(breed.padEnd(20), body.padEnd(9), "볼", cheeks.map((c) => `(${c.u.toFixed(0)},${c.v.toFixed(0)}) r${c.r.toFixed(0)} d${c.dist.toFixed(3)}`).join(" "));
}
for (const [b, { eyes }] of Object.entries(infos)) console.log("눈", b, eyes.map((e) => `x ${e.mn[0].toFixed(3)}..${e.mx[0].toFixed(3)} y ${e.mn[1].toFixed(3)}..${e.mx[1].toFixed(3)}`).join(" | "));
