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

for (const sub of SCAN_DIRS) {
  const dir = path.join(root, sub);
  if (fs.existsSync(dir)) walk(dir);
}

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
  const dir = path.join(webRoot, sub);
  if (fs.existsSync(dir)) walkSource(dir);
}

if (hits.length) {
  console.error(`테스트 시드가 배포 경로에 남아 있다 (${hits.length}건):`);
  for (const { file, token } of hits) console.error(`  ${token}  ←  ${file}`);
  console.error(
    "\n테스트에서 '오늘'을 옮겨야 하면 앱 코드가 아니라 브라우저 시계를 옮겨라(e2e/fixtures.ts).",
  );
  process.exit(1);
}

console.log(
  `테스트 시드 없음 — ${scanned}개 파일 검사(.next/${SCAN_DIRS.join(", .next/")} + 소스 ${SOURCE_DIRS.join(", ")})`,
);
