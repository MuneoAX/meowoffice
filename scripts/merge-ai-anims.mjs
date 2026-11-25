// 자동 리깅(힉스필드·Meshy) 결과 여러 개의 동작을 하나의 glb 로 모은다 — 같은 모델을 동작마다 따로 리깅하므로 뼈 이름이 같다.
//   node scripts/merge-ai-anims.mjs <출력.glb> <기준.glb>=<동작이름> [<파일.glb>=<동작이름> ...]
// 기준 파일의 메시·뼈대를 그대로 쓰고, 나머지 파일에서는 동작만 가져와 이름을 바꿔 붙인다(뼈는 이름으로 맞춘다).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { prune, dedup } = require("@gltf-transform/functions");

const [out, ...pairs] = process.argv.slice(2);
if (!out || !pairs.length) { console.error("쓰는 법: node scripts/merge-ai-anims.mjs <출력.glb> <기준.glb>=<이름> [<파일.glb>=<이름> ...]"); process.exit(1); }
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const split = (p) => { const i = p.lastIndexOf("="); return [p.slice(0, i), p.slice(i + 1)]; };

const [baseFile, baseName] = split(pairs[0]);
const doc = await io.read(baseFile);
const R = doc.getRoot();
const byName = new Map(R.listNodes().map((n) => [n.getName(), n]));
const buffer = R.listBuffers()[0];
const anims = R.listAnimations();
if (anims[0]) anims[0].setName(baseName);
for (const a of anims.slice(1)) a.dispose();

const copyAcc = (src) => doc.createAccessor().setType(src.getType()).setArray(src.getArray().slice()).setNormalized(src.getNormalized()).setBuffer(buffer);
for (const p of pairs.slice(1)) {
  const [file, name] = split(p);
  const src = await io.read(file);
  const a = src.getRoot().listAnimations()[0];
  if (!a) { console.warn(`${file}: 동작 없음`); continue; }
  const na = doc.createAnimation(name);
  let miss = 0;
  for (const ch of a.listChannels()) {
    const tn = ch.getTargetNode();
    const target = tn && byName.get(tn.getName());
    if (!target) { miss++; continue; }
    const s = ch.getSampler();
    const ns = doc.createAnimationSampler().setInput(copyAcc(s.getInput())).setOutput(copyAcc(s.getOutput())).setInterpolation(s.getInterpolation());
    na.addSampler(ns).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(ns));
  }
  console.log(`${name.padEnd(12)} ← ${path.basename(file)} 채널 ${a.listChannels().length - miss}${miss ? ` (맞는 뼈 없음 ${miss})` : ""}`);
}
await doc.transform(dedup(), prune());
await io.write(out, doc);
console.log("동작", R.listAnimations().map((x) => x.getName()).join(", "), "→", out);
