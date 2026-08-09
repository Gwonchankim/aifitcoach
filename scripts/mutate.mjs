/**
 * 뮤테이션 테스트용 스냅샷/원복 도구.
 *
 * 이 프로젝트는 "테스트가 통과한다"를 믿지 않고 **고의 주입 → 실패 확인 → 원복**으로 실효성을 증명한다
 * (CLAUDE.md 함정 5). 그때 원본을 임시 폴더에 복사해 두는데, 2026-08-09 에 그 복사에서 사고가 났다:
 * 키를 `basename` 으로 잡는 바람에 `apps/api/src/common/date/utc-day.ts` 와 `apps/web/lib/utc-day.ts` 가
 * **같은 키로 겹쳐** api 파일에 web 버전이 덮여 씌워졌다. 그래서 키를 **전체 경로**로 만든다.
 *
 *   node scripts/mutate.mjs snapshot <file...>   원본 저장(전체 경로 기반 키)
 *   node scripts/mutate.mjs restore  [file...]   원복(생략하면 스냅샷 전체)
 *   node scripts/mutate.mjs verify   [file...]   원복됐는지 sha256 대조
 *
 * 스냅샷은 `.mutation-snapshot/`(gitignore)에 둔다.
 */
/* global process, console */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STORE = path.join(REPO_ROOT, ".mutation-snapshot");

/** 전체 경로를 파일명 하나로 — 디렉터리 구분자를 `__` 로 바꾼다. 겹칠 수 없다. */
function keyFor(file) {
  return path.relative(REPO_ROOT, path.resolve(file)).replace(/[\\/]/g, "__");
}

function sha(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const [command, ...files] = process.argv.slice(2);

if (command === "snapshot") {
  if (!files.length) throw new Error("snapshot 은 파일을 하나 이상 받아야 한다.");
  fs.mkdirSync(STORE, { recursive: true });
  for (const file of files) {
    const key = keyFor(file);
    fs.copyFileSync(file, path.join(STORE, key));
    console.log(`저장  ${sha(file).slice(0, 12)}  ${key}`);
  }
} else if (command === "restore" || command === "verify") {
  if (!fs.existsSync(STORE)) throw new Error(`스냅샷이 없다: ${STORE}`);
  const keys = files.length ? files.map(keyFor) : fs.readdirSync(STORE);
  let mismatched = 0;
  for (const key of keys) {
    const saved = path.join(STORE, key);
    const target = path.join(REPO_ROOT, key.replace(/__/g, path.sep));
    if (!fs.existsSync(saved)) throw new Error(`스냅샷에 없다: ${key}`);
    if (command === "restore") {
      fs.copyFileSync(saved, target);
      console.log(`원복  ${key}`);
    } else {
      const ok = sha(saved) === sha(target);
      if (!ok) mismatched += 1;
      console.log(`${ok ? "일치" : "불일치"}  ${key}`);
    }
  }
  if (command === "verify" && mismatched) {
    console.error(`\n원복되지 않은 파일이 ${mismatched}건 있다.`);
    process.exit(1);
  }
} else {
  console.error("사용법: node scripts/mutate.mjs <snapshot|restore|verify> [file...]");
  process.exit(1);
}
