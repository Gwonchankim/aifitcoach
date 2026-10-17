/**
 * 프로덕션 빌드 산출물에 **테스트 시드가 없다**는 것을 실제로 확인한다(사람 지시 2026-08-09).
 *
 * 왜 필요한가: `apps/web/lib/utc-day.ts` 에 `NEXT_PUBLIC_AFC_TEST_TODAY` 를 넣었을 때
 * "값을 안 주면 분기가 안 남는다" 고 판단했는데 **틀렸다**. Next 가 인라인하지 않고
 * `t(7074).env.NEXT_PUBLIC_AFC_TEST_TODAY` 라는 런타임 조회로 남겼다(클라이언트 청크에서 실측).
 * 설계 주장을 사람이 믿는 대신 빌드 산출물을 보고 판정한다.
 *
 * 현재 방식: 테스트의 "오늘"은 브라우저 시계(`e2e/fixtures.ts`)로 옮기고 앱 코드에는 시드를 두지 않는다.
 * 이 스크립트는 그 규칙이 깨지는 순간 CI 를 멈춘다.
 *
 * **0건 스캔은 통과가 아니다.** 파일을 하나도 못 읽고 "시드 없음"이라고 하면 가드가 아니다. 그래서 영역마다
 * 따로 센다 — 필수 소스 `app`·`components`·`lib` 와 `.next/static`·`.next/server` 는 **각각** 있어야 하고
 * 검사 파일이 1개 이상이어야 한다. 한 영역의 파일 수로 다른 영역의 0건을 덮지 않는다. `hooks`·`store` 는
 * 지금 트리에 없는 선택 영역이라 없거나 비어 있어도 되지만, 있으면 반드시 훑는다. 어느 영역이든 읽기·순회
 * 오류는 "없음"으로 숨기지 않고 실패한다.
 *
 * 실행: `pnpm --filter web verify:no-test-seed` (반드시 `next build` 뒤에)
 */
/* global process, console */
import fs from "node:fs";
import path from "node:path";

/**
 * 배포 산출물에 절대 있으면 안 되는 토큰.
 *
 * 산출물만 봐서는 부족하다 — 누출 양상이 **두 가지**다(둘 다 실측했다):
 *  - 환경변수 **미설정**: Next 가 인라인하지 않고 `…env.NEXT_PUBLIC_AFC_TEST_TODAY` 런타임 조회를 남긴다 → 식별자가 보인다.
 *  - 환경변수 **설정**: 값이 인라인된다 → 식별자는 사라지고 **날짜만 박힌다**(산출물 grep 으로 못 잡는다).
 * 그래서 앱 **소스**도 함께 본다. 소스에 참조가 없으면 두 경우 다 성립하지 않는다.
 */
const FORBIDDEN = ["AFC_TEST_TODAY", "AFC_TEST_RUN", "__AFC_TEST"];

/** 앱 소스(테스트·E2E 제외). 여기에 시드 참조가 있으면 빌드 결과와 무관하게 실패다. */
const SOURCE_DIRS = ["app", "components", "lib", "hooks", "store"];

/** 그중 필수 영역. 나머지 `hooks`·`store` 는 선택 영역이다(위 머리말). */
const REQUIRED_SOURCE_DIRS = ["app", "components", "lib"];

/** 실제로 브라우저·서버로 나가는 것만 본다. `cache/` 는 webpack 중간 산출물이라 제외한다. */
const SCAN_DIRS = ["static", "server"];

const root = path.resolve(import.meta.dirname, "..", ".next");

if (!fs.existsSync(root)) {
  console.error(`.next 가 없다: ${root}\n먼저 \`pnpm --filter web build\` 를 실행해라.`);
  process.exit(1);
}

/** @type {{file: string, token: string}[]} */
const hits = [];
let scanned = 0;
/** @type {{name: string, required: boolean, state: "scanned" | "absent" | "error", files: number, error?: string}[]} */
const areas = [];

/**
 * 영역 하나를 훑고 그 영역에서 검사한 파일 수를 남긴다. "없음"은 경로 자체가 없을 때뿐이다 —
 * 예전 `existsSync` 분기는 권한·순회 오류도 "없음"으로 삼켜 0건 스캔을 통과시킬 수 있었다.
 */
function area(name, dir, required, scan) {
  const before = scanned;
  let state = "scanned";
  let error;
  try {
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (stat === undefined) state = "absent";
    else if (!stat.isDirectory()) throw new Error("디렉터리가 아니다");
    else scan(dir);
  } catch (caught) {
    state = "error";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  areas.push({ name, required, state, files: scanned - before, error });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|mjs|cjs|json|html|txt|map)$/.test(entry.name)) continue;
    scanned += 1;
    const text = fs.readFileSync(full, "utf8");
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push({ file: path.relative(root, full), token });
    }
  }
}

for (const sub of SCAN_DIRS) area(`.next/${sub}`, path.join(root, sub), true, walk);

/** 앱 소스 스캔 — 값이 인라인되어 식별자가 사라지는 경우를 산출물만으로는 못 잡는다. */
const webRoot = path.resolve(import.meta.dirname, "..");
function walkSource(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
    scanned += 1;
    const text = fs.readFileSync(full, "utf8");
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push({ file: path.relative(webRoot, full), token });
    }
  }
}
for (const sub of SOURCE_DIRS) {
  area(sub, path.join(webRoot, sub), REQUIRED_SOURCE_DIRS.includes(sub), walkSource);
}

/** 영역별 부재·0건·오류와 소스 합계 0건. 어느 것도 다른 영역의 파일 수로 상쇄되지 않는다. */
const problems = [];
for (const { name, required, state, files, error } of areas) {
  if (state === "error") problems.push(`${name}: 읽지 못했다 — ${error}`);
  else if (required && state === "absent") problems.push(`${name}: 없다`);
  else if (required && files === 0) problems.push(`${name}: 검사 대상 파일이 0개다`);
}
const sourceFiles = areas
  .filter(({ name }) => SOURCE_DIRS.includes(name))
  .reduce((sum, { files }) => sum + files, 0);
if (sourceFiles === 0) problems.push("앱 소스 합계: 검사 대상 파일이 0개다");

if (hits.length) {
  console.error(`테스트 시드가 배포 경로에 남아 있다 (${hits.length}건):`);
  for (const { file, token } of hits) console.error(`  ${token}  ←  ${file}`);
  console.error(
    "\n테스트에서 '오늘'을 옮겨야 하면 앱 코드가 아니라 브라우저 시계를 옮겨라(e2e/fixtures.ts).",
  );
  process.exit(1);
}

if (problems.length) {
  console.error(
    `검사 대상이 없거나 읽지 못했다 (${problems.length}건) — 0건 스캔은 "시드 없음"의 근거가 아니다:`,
  );
  for (const line of problems) console.error(`  ${line}`);
  console.error(
    "\n산출물이 없으면 `pnpm --filter web build` 부터 실행하고, 소스 위치가 바뀌었으면 SOURCE_DIRS 를 고쳐라.",
  );
  process.exit(1);
}

console.log(
  `테스트 시드 없음 — ${scanned}개 파일 검사(.next/${SCAN_DIRS.join(", .next/")} + 소스 ${SOURCE_DIRS.join(", ")})`,
);
console.log(
  `  영역별: ${areas.map(({ name, state, files }) => `${name} ${state === "absent" ? "없음(선택)" : files}`).join(" · ")}`,
);
