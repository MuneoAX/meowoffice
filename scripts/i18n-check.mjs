// 다국어 검사: 화면 코드가 쓰는 키가 사전에 있는지, 영어 사전이 빠짐없는지, 아직 하드코딩된 한국어가 남았는지.
//   node scripts/i18n-check.mjs              전체 요약(+ 문제 목록)
//   node scripts/i18n-check.mjs ui/notify.js 그 파일들만 하드코딩 한국어 줄을 보여 줌
// 사전: ui/i18n/ko.js·en.js 와 ui/i18n/<언어>/<영역>.js (I18N.add 호출을 가짜 I18N 으로 실행해 모은다).
// 키 사용: t('키') · I18N.t('키') · data-i18n*="키". 키를 문자열 조합으로 만드는 곳은 잡지 못한다(검사 대상 아님).
// 하드코딩 한국어: 주석 줄·사전 파일·demo.js(브라우저 미리보기용 가짜 데이터)는 뺀다.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(root, "ui");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const dicts = {};
const I18N = { add: (l, d) => { dicts[l] = Object.assign(dicts[l] || {}, d); } };
// 언어 = ui/i18n/<코드>.js 가 있는 코드(ko 가 기준). 각 언어의 영역 사전은 ui/i18n/<코드>/*.js
const LANGS = fs.readdirSync(path.join(ui, "i18n")).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.js$/.test(f)).map((f) => f.slice(0, -3)).sort((a, b) => (a === "ko" ? -1 : b === "ko" ? 1 : a.localeCompare(b)));
const dictFiles = LANGS.map((l) => path.join(ui, "i18n", `${l}.js`));
for (const l of LANGS) {
  const dir = path.join(ui, "i18n", l);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) dictFiles.push(path.join(dir, f));
}
const seen = {}; // 같은 키를 두 파일이 정의하면 나중 것이 이긴다 — 중복으로 보고
for (const f of dictFiles) {
  const before = {};
  const box = { add: (l, d) => { for (const k of Object.keys(d)) { (seen[l + "\u0000" + k] ||= []).push(rel(f)); } I18N.add(l, d); } };
  vm.runInNewContext(fs.readFileSync(f, "utf8"), { I18N: box, Object });
  void before;
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return ["vendor", "i18n", "models", "textures", "sounds", "icons"].includes(e.name) ? [] : walk(p);
  return /\.(js|html)$/.test(e.name) ? [p] : [];
});
const codeFiles = walk(ui);

const used = new Map(); // 키 → 처음 쓴 위치
const keyRe = /(?:\bI18N\.t|(?<![\w.$])t)\(\s*['"`]([\w.-]+)['"`]|data-i18n(?:-[\w-]+)?=["']([\w.-]+)["']/g;
for (const f of codeFiles) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => { for (const m of l.matchAll(keyRe)) { const k = m[1] || m[2]; if (k.endsWith(".")) continue; if (!used.has(k)) used.set(k, `${rel(f)}:${i + 1}`); } });
}

const ko = dicts.ko || {};
const others = LANGS.filter((l) => l !== "ko");
const missingKo = [...used].filter(([k]) => !(k in ko));
const missing = Object.fromEntries(others.map((l) => [l, Object.keys(ko).filter((k) => !(k in (dicts[l] || {})))]));
const dup = Object.entries(seen).filter(([, fs_]) => fs_.length > 1).map(([k, fs_]) => `${k.replace("\u0000", ":")} (${fs_.join(", ")})`);
const ph = (s) => JSON.stringify((s.match(/\{\w+\}/g) || []).sort());
const placeholderMismatch = others.flatMap((l) => Object.keys(ko).filter((k) => k in (dicts[l] || {}) && ph(ko[k]) !== ph(dicts[l][k])).map((k) => `${l}: ${k}`));

// 하드코딩 한국어 줄(주석 제외)
const hangul = /[가-힣]/;
function hardcoded(f) {
  const out = [];
  let block = false;
  fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((l, i) => {
    let s = l;
    if (block) { const e = s.indexOf("*/"); if (e < 0) return; s = s.slice(e + 2); block = false; }
    s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    const b = s.indexOf("/*"); if (b >= 0) { s = s.slice(0, b); block = true; }
    s = s.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
    if (hangul.test(s)) out.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 140)}`);
  });
  return out;
}
const only = process.argv.slice(2).map((p) => path.resolve(root, p));
const targets = (only.length ? only : codeFiles).filter((f) => !/[\\/]demo\.js$/.test(f));
const hard = targets.flatMap(hardcoded);

if (only.length) { console.log(hard.join("\n") || "(하드코딩 한국어 없음)"); process.exit(0); }

const byFile = {};
for (const h of hard) { const f = h.split(":")[0]; byFile[f] = (byFile[f] || 0) + 1; }
console.log(`사전 키: ${LANGS.map((l) => `${l} ${Object.keys(dicts[l] || {}).length}`).join(" · ")} · 코드가 쓰는 키 ${used.size}`);
console.log(`코드가 쓰는데 ko 에 없는 키: ${missingKo.length}`); missingKo.slice(0, 50).forEach(([k, at]) => console.log(`  ${k}  ← ${at}`));
for (const l of others) { console.log(`ko 에 있는데 ${l} 에 없는 키: ${missing[l].length}`); missing[l].slice(0, 50).forEach((k) => console.log(`  ${k}`)); }
console.log(`자리표시({이름}) 불일치: ${placeholderMismatch.length}`); placeholderMismatch.forEach((k) => console.log(`  ${k}`));
console.log(`두 파일에 정의된 키: ${dup.length}`); dup.slice(0, 30).forEach((d) => console.log(`  ${d}`));
console.log(`하드코딩 한국어 줄: ${hard.length}`);
Object.entries(byFile).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${f} ${n}`));
process.exitCode = missingKo.length || others.some((l) => missing[l].length) || placeholderMismatch.length || dup.length ? 1 : 0;
