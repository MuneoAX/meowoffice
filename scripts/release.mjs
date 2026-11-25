// 릴리스: (버전 올림) → 서명 빌드 → (커밋·태그) → latest.json 생성 → muneo.co.kr 업로드(scp) → (git push).
//   npm run release -- --bump patch --notes "변경 내용"   버전 올림(patch|minor|major|x.y.z) + 빌드 + 커밋·태그 + 업로드 + push
//   npm run release -- --notes "변경 내용"                현재 버전 그대로 빌드 + 업로드
//   npm run release -- --bump patch --notes-file notes.md   여러 줄 노트(## 제목 + - 항목)는 파일로 — --notes 는 셸에서 첫 줄만 남을 수 있다
//   npm run release -- --skip-build                       이미 빌드된 결과물로 업로드만
//   npm run release -- --no-upload / --no-push            업로드 / git push 생략
// --bump 은 작업 트리가 깨끗해야 함(.idea 제외) — 버전 커밋에 다른 변경이 섞이지 않도록.
// 설정: scripts/release.config.json (base_url = 공개 주소, scp_target = 업로드 위치).
// 서명 키: TAURI_SIGNING_PRIVATE_KEY(경로 또는 내용) 없으면 ~/.tauri/muneo-claude-usage-tray.key.
// 업로드 순서: 설치 파일 먼저, latest.json 마지막 — 받는 쪽이 없는 파일을 가리키는 순간이 없도록.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 유지보수자 전용 설정 — 공개 저장소에는 없다(예시: scripts/release.config.example.json). 공개 저장소의 릴리스는 GitHub Actions(.github/workflows/release.yml)가 만든다.
const cfgPath = path.join(root, "scripts/release.config.json");
if (!fs.existsSync(cfgPath)) {
  console.error("scripts/release.config.json 이 없습니다 — 자체 서버 배포용 유지보수자 설정입니다. scripts/release.config.example.json 을 복사해 채우거나, 태그를 올려 GitHub Actions 릴리스를 쓰세요.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const baseUrl = cfg.base_url.replace(/\/?$/, "/");

const run = (cmd, argv, env) =>
  execFileSync(cmd, argv, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();

// 버전 파일: [경로, 바꿀 횟수(앞에서부터), 패턴]. Cargo.lock 은 빌드가 갱신.
const VERSION_FILES = [
  ["package.json", 1, (v) => `"version": "${v}"`],
  ["package-lock.json", 2, (v) => `"version": "${v}"`],
  ["src-tauri/tauri.conf.json", 1, (v) => `"version": "${v}"`],
  ["src-tauri/Cargo.toml", 1, (v) => `version = "${v}"`],
];
const COMMIT_FILES = [...VERSION_FILES.map(([f]) => f), "src-tauri/Cargo.lock"];

function nextVersion(cur, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [a, b, c] = cur.split(".").map(Number);
  if (how === "major") return `${a + 1}.0.0`;
  if (how === "minor") return `${a}.${b + 1}.0`;
  if (how === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error(`--bump 값은 patch|minor|major|x.y.z: ${how}`);
}

function bumpFiles(from, to) {
  for (const [file, times, pat] of VERSION_FILES) {
    const p = path.join(root, file);
    let s = fs.readFileSync(p, "utf8");
    for (let i = 0; i < times; i++) {
      if (!s.includes(pat(from))) throw new Error(`${file} 에서 ${pat(from)} 을 찾지 못함`);
      s = s.replace(pat(from), pat(to));
    }
    fs.writeFileSync(p, s);
  }
}

const bump = opt("--bump");
let version = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
if (bump) {
  const dirty = git("status", "--porcelain").split("\n").filter((l) => l && !l.includes(".idea/"));
  if (dirty.length) throw new Error(`커밋되지 않은 변경이 있습니다:\n${dirty.join("\n")}`);
  const next = nextVersion(version, bump);
  if (git("tag", "--list", `v${next}`)) throw new Error(`태그 v${next} 가 이미 있습니다`);
  bumpFiles(version, next);
  console.log(`버전 ${version} → ${next}`);
  version = next;
}

if (!flag("--skip-build")) {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY || path.join(os.homedir(), ".tauri", "muneo-claude-usage-tray.key");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(key)) throw new Error(`서명 키 없음: ${key}`);
  run("npx", ["tauri", "build"], {
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  });
}

// NSIS 설치 파일 + 서명(.sig). 이름에 한글·공백이 있어 업로드 시 영문 이름으로 바꿈.
const nsisDir = path.join(root, "src-tauri/target/release/bundle/nsis");
const setup = fs.readdirSync(nsisDir).find((f) => f.endsWith(`_${version}_x64-setup.exe`));
if (!setup || !fs.existsSync(path.join(nsisDir, setup + ".sig"))) {
  throw new Error(`${version} 설치 파일/서명이 없습니다 (${nsisDir}) — 서명 키로 빌드했는지 확인`);
}

if (bump) {
  git("add", ...COMMIT_FILES);
  git("commit", "-m", `버전 ${version}`);
  git("tag", `v${version}`);
  console.log(`커밋·태그: v${version}`);
}

const outDir = path.join(root, "dist/release");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const fileName = `muneo-claude-usage-tray_${version}_x64-setup.exe`;
fs.copyFileSync(path.join(nsisDir, setup), path.join(outDir, fileName));

const latest = {
  version,
  // 여러 줄 노트는 --notes-file 로(셸·npm 을 거치면 --notes 의 줄바꿈이 잘린다). --notes 안의 \\n 글자도 줄바꿈으로 바꾼다.
  notes: opt("--notes-file") ? fs.readFileSync(path.resolve(opt("--notes-file")), "utf8").trim() : (opt("--notes") || "").replace(/\\n/g, "\n"),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(path.join(nsisDir, setup + ".sig"), "utf8").trim(),
      url: baseUrl + fileName,
    },
  },
};
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`\n만듦: ${outDir}\n  ${fileName}\n  latest.json → ${baseUrl}latest.json`);

if (!flag("--no-upload")) {
  if (!cfg.scp_target) throw new Error("scripts/release.config.json 의 scp_target 이 비어 있습니다");
  const target = cfg.scp_target.replace(/\/?$/, "/");
  // Windows: SSH 키가 Windows OpenSSH(ssh-agent)에 연동돼 있음 — Git Bash 의 scp 가 PATH 앞에 오면 키를 못 찾으므로 고정.
  const winScp = "C:\\Windows\\System32\\OpenSSH\\scp.exe";
  const scp = process.platform === "win32" && fs.existsSync(winScp) ? winScp : "scp";
  run(scp, [path.join(outDir, fileName), target]);
  run(scp, [path.join(outDir, "latest.json"), target]);
  console.log(`\n업로드 완료: ${baseUrl}latest.json`);
}

if (bump && !flag("--no-push")) {
  run("git", ["push", "origin", "HEAD", `v${version}`]);
}
