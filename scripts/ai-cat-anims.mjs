// AI 고양이 모델의 동작을 한 번에 다시 만든다(리깅을 고친 뒤 등): 옛 고양이 동작 15개 옮기기 → 허리 굽힘 줄이기 → 팔 벌리기(체형별)
// → 두 발 붙이기 → 서 있는 앞발 높이 맞추기 → 팔이 몸통을 뚫지 않게. Tripo 에서 받은 기다리기(wait)는 그대로 두고 팔·앞발만 다시 맞춘다.
//   node scripts/ai-cat-anims.mjs <모델.glb> <옛 체형=standard|foldear|longhair|shortleg>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const [b, oldBody = "standard"] = process.argv.slice(2);
const OLD = path.join(here, "..", "ui", "office", "models", "cats");
const run = (s, ...a) => execFileSync(process.execPath, [path.join(here, s), ...a], { stdio: "inherit" });
run("retarget-old-anims.mjs", b, path.join(OLD, `cat_${oldBody}.glb`), b, "--replace");
run("retarget-old-anims.mjs", b, path.join(OLD, `anims_${oldBody}.glb`), b, "skate,roll", "--replace");
run("tune-ai-anims.mjs", b, b, "0.3", "idle,walk,carry,hold,raise_hand");
run("spread-ai-arms.mjs", b, b, "auto", "idle,walk,raise_hand");
run("calm-ai-stand.mjs", b, b, "idle,hold,raise_hand,walk");
run("spread-ai-arms.mjs", b, b, "auto", "idle,wait", "hand=0.27"); // 서 있는 앞발 높이를 좌우·품종끼리 같게(키 1.0 기준)
run("spread-ai-arms.mjs", b, b, "clear", "idle,walk,carry,hold,raise_hand,sit,sit_type,sit_talk,wait,sit_up,skate"); // 팔·앞발이 몸통을 뚫으면 옆이나 앞으로(손이 뱃속으로 사라짐 방지). 마시기·그루밍은 손이 얼굴로 가는 동작이라 뺌
