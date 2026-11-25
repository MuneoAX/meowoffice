// 3D 에셋 최적화: assets/src3d/ (원본) → ui/office/ (앱이 쓰는 최적화본).
//   npm run optimize-assets                전부 다시 만든다
//   npm run optimize-assets -- --only cats  경로에 'cats' 가 들어간 것만
//
// 하는 일
//   glb : dedup·prune·(주방 소품은 weld)·reorder·meshopt 압축(EXT_meshopt_compression).
//         고양이 몸·동작(models/cats/)은 모양을 바꾸지 않고 양자화도 하지 않는다(float 그대로 무손실 압축) — catmodel.js fixRumpWeights 가
//         정점 좌표를 m 단위로 읽어 꼬리 뿌리를 구하기 때문. 스케이트는 16비트 양자화. 안 쓰는 UV 는 지우지 않는다(prune keepAttributes).
//   png → WebP(손실, 품질 92). 품종 털 무늬 17장이 17MB → 2.3MB. KTX2(ETC1S)도 해 봤으나 같은 용량대에서 화질이 더 거칠고(평균 오차 2.0 vs 1.2),
//         트랜스코더(emscripten embind)가 new Function 을 써서 CSP 'unsafe-eval' 이 필요했다 → WebP 는 브라우저 내장 디코더라 CSP 완화·디코더 파일이 없다.
//         jpg(바닥 타일)는 예외로 그대로 복사.
// 필요: npm install 만 (sharp 는 devDependency).
// 원본을 바꾸는 방법: assets/src3d/ 의 파일을 교체하고 이 스크립트를 다시 돌린다. ui/office 쪽 결과물은 직접 고치지 않는다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, weld, reorder, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets', 'src3d');
const OUT = path.join(root, 'ui', 'office');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const WEBP = { quality: 92, effort: 6, smartSubsample: true };

function* walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});

async function optimizeGlb(src, dst) {
  const doc = await io.read(src);
  const rel = path.relative(SRC, src).replace(/\\/g, '/');
  const isKenney = rel.includes('models/kenney/');
  // 고양이·스케이트는 재질에 텍스처가 없어도 UV(TEXCOORD_0)를 남긴다: 품종 털 무늬를 런타임에 입히기 때문(prune 기본값은 안 쓰는 UV 를 지운다)
  const steps = [dedup(), prune({ keepAttributes: !isKenney })];
  if (isKenney) steps.push(weld()); // 같은 값의 정점만 합침(모양 그대로)
  steps.push(reorder({ encoder: MeshoptEncoder }));
  if (isKenney) {
    // 소품은 가중치·애니메이션이 없어 안전하게 양자화(16비트)
    steps.push(quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  }
  // meshopt() 는 안에서 quantize 도 한다(기본 위치 14·UV 12·가중치 8비트). 고양이·동작·스케이트는 최대(16비트)로 올려 원본과 시각적으로 같게 둔다.
  // 소품은 기본값보다 약간 거칠게(위 quantize 단계에서 이미 정해 둔 값은 meshopt 가 다시 줄이지 않는다).
  const hi = isKenney ? {} : { quantizePosition: 16, quantizeNormal: 16, quantizeTexcoord: 16, quantizeColor: 16, quantizeWeight: 16, quantizeGeneric: 16 };
  // 뼈대가 있는 고양이 몸(models/cats/)은 양자화하지 않는다: 양자화하면 정점 좌표가 정수 공간으로 바뀌고(보정은 역바인드 행렬에 들어감),
  // catmodel.js fixRumpWeights 가 정점 좌표를 m 단위 모델 공간으로 읽어 꼬리 뿌리 중심을 구하므로 꼬리가 엉뚱한 곳(바닥 아래)으로 간다.
  // → 좌표·가중치는 float 그대로 두고 meshopt 압축 확장만 붙인다(무손실).
  if (rel.includes('models/cats/')) {
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  } else {
    steps.push(meshopt({ encoder: MeshoptEncoder, level: 'high', ...hi }));
  }
  await doc.transform(...steps);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await io.write(dst, doc);
}

async function toWebp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await sharp(src).webp(WEBP).toFile(dst);
}

const rows = [];
for (const src of walk(SRC)) {
  const rel = path.relative(SRC, src).replace(/\\/g, '/');
  if (only && !rel.includes(only)) continue;
  const ext = path.extname(src).toLowerCase();
  let dst;
  if (ext === '.glb') {
    dst = path.join(OUT, rel);
    await optimizeGlb(src, dst);
  } else if (ext === '.png') {
    dst = path.join(OUT, rel.replace(/\.png$/i, '.webp'));
    await toWebp(src, dst);
  } else if (ext === '.jpg') {
    // 바닥 타일(jpg)은 이미 JPEG 라 다시 인코딩하면 이음매 무늬만 거칠어져 예외 — 그대로 복사
    dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } else continue;
  rows.push([rel, fs.statSync(src).size, fs.statSync(dst).size]);
}

let a = 0, b = 0;
for (const [r, x, y] of rows) { a += x; b += y; }
const fmt = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('파일 수', rows.length, '| 원본', fmt(a), '→ 결과', fmt(b), `(${((b / a) * 100).toFixed(0)}%)`);
if (args.includes('--list')) for (const [r, x, y] of rows) console.log(`${r}\t${x}\t${y}`);
