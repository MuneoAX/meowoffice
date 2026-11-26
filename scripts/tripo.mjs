// Tripo API(v3) 로 모델 리깅·동작 붙이기. 키는 환경 변수 TRIPO_API_KEY(저장소에 넣지 않음).
//   node scripts/tripo.mjs upload <파일.glb>                         → file_token
//   node scripts/tripo.mjs rigcheck <file_token|task_id>              → riggable, rig_type
//   node scripts/tripo.mjs rig <file_token|task_id> [rig_type=biped] [model=v1.0-20240301] [spec=mixamo]
//   node scripts/tripo.mjs retarget <rig task_id> <preset,...(최대 5)> [inplace]
//   node scripts/tripo.mjs wait <task_id> [출력.glb]                  → 끝날 때까지 기다리고 결과를 내려받음
//   node scripts/tripo.mjs task <task_id>                             → 상태 보기
// 문서: https://developers.tripo3d.com/en/docs/animations-rig (글로벌 계정은 openapi.tripo3d.ai)

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TRIPO_BASE || "https://openapi.tripo3d.ai/v3";
const KEY = process.env.TRIPO_API_KEY;
if (!KEY) { console.error("TRIPO_API_KEY 환경 변수가 없습니다"); process.exit(1); }
const H = { Authorization: `Bearer ${KEY}` };

async function call(method, p, body) {
  const opt = { method, headers: { ...H } };
  if (body instanceof FormData) opt.body = body;
  else if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 400) }; }
  if (!r.ok || (j.code != null && j.code !== 0)) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j.data ?? j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === "upload") {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(a)]), path.basename(a));
  console.log(JSON.stringify(await call("POST", "/files", fd)));
} else if (cmd === "rigcheck") {
  console.log(JSON.stringify(await call("POST", "/animations/rig-check", { input: a })));
} else if (cmd === "rig") {
  const body = { input: a, rig_type: b || "biped", model: c || "v1.0-20240301", out_format: "glb" };
  if ((b || "biped") === "biped") body.spec = d || "mixamo";
  console.log(JSON.stringify(await call("POST", "/animations/rig", body)));
} else if (cmd === "retarget") {
  const list = b.split(",").map((s) => s.trim()).filter(Boolean);
  const body = { input: a, out_format: "glb", animate_in_place: c === "inplace" };
  if (list.length === 1) body.animation = list[0]; else body.animations = list;
  console.log(JSON.stringify(await call("POST", "/animations/retarget", body)));
} else if (cmd === "task") {
  console.log(JSON.stringify(await call("GET", `/tasks/${a}`), null, 1));
} else if (cmd === "wait") {
  for (let i = 0; i < 180; i++) {
    const t = await call("GET", `/tasks/${a}`);
    if (["success", "failed", "cancelled", "banned", "expired"].includes(t.status)) {
      console.log(JSON.stringify({ status: t.status, type: t.type, credits: t.credits_consumed, error: t.error_message, output: t.output }));
      if (t.status === "success" && b && t.output && t.output.model_url) {
        const r = await fetch(t.output.model_url);
        fs.writeFileSync(b, Buffer.from(await r.arrayBuffer()));
        console.log("내려받음", b, fs.statSync(b).size);
      }
      process.exit(t.status === "success" ? 0 : 1);
    }
    await sleep(5000);
  }
  console.error("시간 초과"); process.exit(1);
} else if (cmd === "cat") {
  // 한 번에: 업로드 → 리깅(v1.0 biped, mixamo 이름) → 기다리기 동작 1개(제자리) + 옛 고양이 동작 15개 옮기기 → 합치기 → 앱 동작 이름으로 → 출력
  //   node scripts/tripo.mjs cat <줄인.glb> <출력.glb> [옛 체형=standard|foldear|longhair|shortleg — 동작을 옮겨 올 옛 모델]
  const { execFileSync } = await import("node:child_process");
  const oldBody = c || "standard";
  const tmp = path.join((await import("node:os")).tmpdir(), "meow_tripo_" + path.basename(b, ".glb")); // 앱 폴더 밖(중간 파일)
  fs.mkdirSync(tmp, { recursive: true });
  const until = async (id) => {
    for (let i = 0; i < 240; i++) {
      const t = await call("GET", `/tasks/${id}`);
      if (t.status === "success") return t;
      if (["failed", "cancelled", "banned", "expired"].includes(t.status)) throw new Error(`${t.type} ${t.status} ${t.error_message || ""}`);
      await sleep(5000);
    }
    throw new Error("시간 초과 " + id);
  };
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(a)]), path.basename(a));
  const tok = (await call("POST", "/files", fd)).file_token;
  const rig = (await call("POST", "/animations/rig", { input: tok, rig_type: "biped", model: "v1.0-20240301", spec: "mixamo", out_format: "glb" })).task_id;
  await until(rig);
  console.log("리깅 완료", rig);
  const SETS = [["wait"]]; // 나머지 동작은 옛 고양이 동작을 옮겨 쓴다(아래 retarget-old-anims) — 옛 동작에 없는 기다리기만 Tripo 에서
  const files = [];
  for (const [i, set] of SETS.entries()) {
    const id = (await call("POST", "/animations/retarget", { input: rig, animations: set.map((s) => "preset:biped:" + s), out_format: "glb", animate_in_place: true })).task_id;
    const t = await until(id);
    const f = path.join(tmp, `anims${i}.glb`);
    fs.writeFileSync(f, Buffer.from(await (await fetch(t.output.model_url)).arrayBuffer()));
    files.push(f);
    console.log("동작", set.join(","), "크레딧", t.credits_consumed);
  }
  const merged = path.join(tmp, "all.glb");
  execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "merge-ai-anims.mjs"), merged, files[0] + "=*", ...files.slice(1).map((f) => f + "=*")], { stdio: "inherit" });
  // 앱 동작 이름으로(catmodel.js 의 ai 체형 매핑과 같음)
  const { createRequire } = await import("node:module");
  const req = createRequire(path.resolve("package.json"));
  const { NodeIO } = req("@gltf-transform/core"); const { ALL_EXTENSIONS } = req("@gltf-transform/extensions"); const { prune } = req("@gltf-transform/functions");
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(merged);
  const REN = { idle: "idle", walk: "walk", sit: "sit", play_video_game: "sit_type", wave_goodbye_01: "raise_hand", standing_relax: "hold", wait: "wait" };
  for (const an of doc.getRoot().listAnimations()) { const n = REN[an.getName()]; if (n) an.setName(n); else an.dispose(); }
  await doc.transform(prune());
  await io.write(b, doc);
  // 사람형 리깅 보정: 꼬리를 엉덩이 뼈로(손들 때 말려 올라감 방지), 서기·걷기 굽힘 줄이기(큰 머리가 앞으로 숙음 방지), 팔 벌리기
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
  execFileSync(process.execPath, [path.join(here, "fix-ai-tail.mjs"), b, b], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "tune-ai-anims.mjs"), b, b, "0.3"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "spread-ai-arms.mjs"), b, b, "45"], { stdio: "inherit" }); // 팔이 둥근 몸통에 파묻히지 않게 45° 이상 벌림
  // 카툰 눈: 눈 자리 찾기 → 눈 둘레 메시 펴기(볼록한 눈알·홈 주름 없애기) → 펴진 자리로 다시 찾기 → 텍스처에 카툰 눈 칠하기(2048)
  for (const s of ["ai-face-marks.mjs", "smooth-ai-eyes.mjs", "ai-face-marks.mjs", "paint-ai-eyes.mjs"]) execFileSync(process.execPath, [path.join(here, s), b, b], { stdio: "inherit" });
  // 입: ω 입 선을 따라 갈라 위·아래 입술 + 아래턱이 내려가는 모양 변형(하품·말하기·먹기)
  execFileSync(process.execPath, [path.join(here, "mouth-ai.mjs"), b, b], { stdio: "inherit" });
  // 꼬리 뼈 4마디(앱이 기분·신호별로 흔듦) + 옛 고양이 동작 15개를 옮겨 씀(Tripo 프리셋엔 마시기·자기·그루밍·상자 나르기가 없음) → 보정
  execFileSync(process.execPath, [path.join(here, "add-ai-tail.mjs"), b, b], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "sym-ai-rig.mjs"), b, b], { stdio: "inherit" }); // 자동 리깅의 좌우 관절 자리를 거울 대칭으로
  execFileSync(process.execPath, [path.join(here, "fit-ai-arms.mjs"), b, b], { stdio: "inherit" }); // 팔 관절(어깨·팔꿈치·손목)을 팔 메시 중심선에서 다시 잡고 팔 가중치 다시
  const OLD = path.join(here, "..", "ui", "office", "models", "cats");
  execFileSync(process.execPath, [path.join(here, "retarget-old-anims.mjs"), b, path.join(OLD, `cat_${oldBody}.glb`), b, "--replace"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "retarget-old-anims.mjs"), b, path.join(OLD, `anims_${oldBody}.glb`), b, "skate,roll", "--replace"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "tune-ai-anims.mjs"), b, b, "0.3", "idle,walk,carry,hold,raise_hand"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "spread-ai-arms.mjs"), b, b, "auto", "idle,walk,raise_hand"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "spread-ai-arms.mjs"), b, b, "auto", "idle,wait", "hand=0.27"], { stdio: "inherit" }); // 서 있는 앞발 높이를 좌우·품종끼리 같게(키 1.0 기준)
  execFileSync(process.execPath, [path.join(here, "calm-ai-stand.mjs"), b, b, "idle,hold,raise_hand,walk"], { stdio: "inherit" });
  console.log("완료", b, doc.getRoot().listAnimations().map((x) => x.getName()).join(","));
} else {
  console.error("명령: upload | rigcheck | rig | retarget | wait | task | cat"); process.exit(1);
}
