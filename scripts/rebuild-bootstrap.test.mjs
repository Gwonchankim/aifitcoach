/**
 * rebuild-bootstrap 검사의 RED/GREEN 반례. 전부 os.tmpdir() 아래 합성 git 저장소에서만 돈다 —
 * 이 저장소의 작업 트리·실제 ledger·git object 는 읽지도 쓰지도 않는다.
 *
 *   node --test scripts/rebuild-bootstrap.test.mjs
 *
 * 각 RED 는 같은 저장소를 원상으로 되돌린 GREEN 과 짝을 이룬다. 기대 상태·digest 는 검사 본체의
 * 함수를 빌리지 않고 이 파일에서 따로 계산한다(본체가 틀려도 시험이 같이 틀리지 않게).
 */
/* global structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import {
  BASELINE,
  LEDGER_PATH,
  formatReport,
  STAGES,
  lockImporters,
  parseArgs,
  runChecks,
} from "./rebuild-bootstrap.mjs";

const CLI = fileURLToPath(new URL("./rebuild-bootstrap.mjs", import.meta.url));
const TEMP_PREFIX = "afc-rebuild-bootstrap-";
/** 티켓의 초기 상태 규칙: N=pending-replacement, T=preserved-unported, 그 외 active. */
const INITIAL = { N: "pending-replacement", T: "preserved-unported" };

const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "  excludeLinksFromLockfile: false",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      prettier:",
  "        specifier: 3.9.6",
  "        version: 3.9.6",
  "",
  "  apps/api:",
  "    dependencies:",
  "      shared:",
  "        specifier: workspace:*",
  "        version: link:../../packages/shared",
  "",
  "  apps/web:",
  "    dependencies:",
  "      shared:",
  "        specifier: workspace:*",
  "        version: link:../../packages/shared",
  "",
  "  packages/shared:",
  "    devDependencies:",
  "      typescript:",
  "        specifier: 5.9.3",
  "        version: 5.9.3",
  "",
  "packages:",
  "",
  "  prettier@3.9.6:",
  "    resolution: {integrity: sha512-mini}",
  "",
].join("\n");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const ROOT_MANIFEST = {
  name: "mini",
  private: true,
  scripts: { test: "node --test" },
  devDependencies: { prettier: "3.9.6" },
};

/**
 * 합성 기준선: m0-01 규칙이 읽는 경로(manifest 4·lock·lifecycle 입력)와 유형별 대표 파일.
 * m0-02a 가 바이트 변경을 승인하는 정확한 3경로와, 그 예외 밖에 있어야 할 같은 디렉터리의 형제 1개를 둔다.
 * m0-04 의 같은 경로 교체 6경로·seed 1경로와, 그 예외 밖 형제(보안 이음새 app.setup·utc-day 옆
 * request-today·seed 옆 resistance ids)를 둔다.
 * m0-05 의 FE 셸 7경로·verify 2경로와, 그 예외 밖 형제(cn.ts 옆 Button.tsx·verify 옆 font-payload)를 둔다.
 */
const BASELINE_FILES = {
  ".github/workflows/ci.yml": ["R", "name: ci\non: [push]\n"],
  ".github/workflows/nightly.yml": ["R", "name: nightly\non: [schedule]\n"],
  "scripts/ci-e2e.mjs": ["R", "// e2e runner 원문\n"],
  "scripts/ci-e2e.test.mjs": ["R", "// e2e runner 시험 원문\n"],
  ".gitignore": ["K", "node_modules/\n"],
  "package.json": ["R", json(ROOT_MANIFEST)],
  "pnpm-lock.yaml": ["R", LOCK],
  "apps/api/package.json": ["R", json({ name: "api", dependencies: { shared: "workspace:*" } })],
  "apps/web/package.json": ["R", json({ name: "web", dependencies: { shared: "workspace:*" } })],
  "packages/shared/package.json": [
    "R",
    json({ name: "shared", devDependencies: { typescript: "5.9.3" } }),
  ],
  "apps/api/prisma/schema.prisma": ["R", 'datasource db {\n  provider = "postgresql"\n}\n'],
  "apps/api/src/main.ts": ["N", "export const port = 3001;\n"],
  "apps/api/src/app.module.ts": ["N", "export class AppModule {}\n"],
  "apps/api/src/app.setup.ts": ["N", 'export const API_PREFIX = "v1";\n'],
  "apps/api/src/prisma/prisma.module.ts": ["N", "export class PrismaModule {}\n"],
  "apps/api/src/prisma/prisma.service.ts": ["N", "export class PrismaService {}\n"],
  "apps/api/src/common/date/utc-day.ts": ["N", 'export const TEST_TODAY_ENV = "AFC_TEST_TODAY";\n'],
  "apps/api/src/common/date/request-today.ts": ["N", "export const captureRequestToday = 1;\n"],
  "apps/api/src/common/http/error-envelope.filter.ts": [
    "N",
    "export class ErrorEnvelopeFilter {}\n",
  ],
  "apps/api/prisma/seed-exercises.ts": ["R", 'import { loadSemanticsFor } from "../src/x";\n'],
  "apps/api/prisma/resistance-exercise-ids.ts": [
    "R",
    "export const RESISTANCE_EXERCISE_IDS = [];\n",
  ],
  "apps/web/scripts/add-generated-banner.mjs": ["R", "// 생성물 배너 원문\n"],
  "apps/web/app/layout.tsx": ["N", "export default function RootLayout() {}\n"],
  "apps/web/app/page.tsx": ["N", "export default function Page() {}\n"],
  "apps/web/app/providers.tsx": ["N", "export function Providers() {}\n"],
  "apps/web/app/globals.css": ["N", ":root { color-scheme: light; }\n"],
  "apps/web/app/sw.ts": ["N", "export const serviceWorker = true;\n"],
  "apps/web/components/navigation/app-shell.tsx": ["N", "export function AppShell() {}\n"],
  "apps/web/components/ui/cn.ts": ["N", "export const cn = () => '';\n"],
  "apps/web/components/ui/Button.tsx": ["N", "export function Button() {}\n"],
  "apps/web/scripts/verify-no-test-seed.mjs": ["R", "// verify no test seed 원문\n"],
  "apps/web/scripts/verify-contrast.mjs": ["R", "// verify contrast 원문\n"],
  "apps/web/scripts/verify-font-payload.mjs": ["R", "// verify font payload 원문\n"],
  "apps/web/test/sample.test.ts": ["T", 'export const oracle = "baseline";\n'],
  "packages/shared/src/index.ts": ["N", "export const shared = true;\n"],
  "packages/shared/tsconfig.build.json": ["R", json({ compilerOptions: { outDir: "dist" } })],
  "docs/specs/fixture.json": ["F", json({ cases: [1, 2, 3] })],
  "docs/notes.md": ["D", "CRLF 원문\r\n둘째 줄\r\n"],
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const fileOf = (repo, rel) => path.join(repo.root, ...rel.split("/"));
const read = (repo, rel) => readFileSync(fileOf(repo, rel));
function write(repo, rel, content) {
  mkdirSync(path.dirname(fileOf(repo, rel)), { recursive: true });
  writeFileSync(fileOf(repo, rel), content);
}

const CONTENT_LINE = (row) => `${row.path}\t${row.blob}\t${row.sha256}\n`;
const TYPE_LINE = (row) => `${row.path}\t${row.type}\n`;

/** 시험 쪽 독립 digest: 경로 바이트순 line(row)(기본 `path\tblob\tsha256\n`) 의 SHA-256. */
function digestOf(rows, line = CONTENT_LINE) {
  const lines = [...rows]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(line)
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

/** 승인 분류 기대값 — 변조 전 fixture 정의의 path→type 에서 고정한다. 변조 뒤 다시 계산하지 않는다. */
const FIXTURE_TYPE_DIGEST = digestOf(
  Object.entries(BASELINE_FILES).map(([rel, [type]]) => ({ path: rel, type })),
  TYPE_LINE,
);

/** 지정한 임시 영역 안의 우리 디렉터리일 때만 지운다. */
function removeTemp(root) {
  const relative = path.relative(realpathSync(os.tmpdir()), root);
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside || !path.basename(root).startsWith(TEMP_PREFIX)) {
    throw new Error(`임시 영역 밖 경로는 지우지 않는다: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * 기준선 commit + 미니 ledger + m0-01 의 허용 변경(ci:bootstrap 추가)을 갖춘 합성 후보.
 * extra 는 m0-06 반례만 쓰는 추가 기준선 파일이다 — 기존 반례는 빈 값이라 기준선·분류 digest 가 그대로다.
 */
function makeRepo(t, extra = {}) {
  const files = { ...BASELINE_FILES, ...extra };
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  t.after(() => removeTemp(root));
  const repo = { root };
  git(root, ["init", "-q"]);
  git(root, ["config", "core.autocrlf", "false"]);
  for (const [rel, [, text]] of Object.entries(files)) write(repo, rel, text);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=rebuild-bootstrap-test",
    "-c",
    "user.email=rebuild-bootstrap-test@example.invalid",
    "commit",
    "-q",
    "-m",
    "baseline",
  ]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  const rows = Object.entries(files).map(([rel, [type]]) => ({
    path: rel,
    blob: git(root, ["rev-parse", `HEAD:${rel}`]),
    sha256: sha256(read(repo, rel)),
    type,
    owner: "BE",
    stage: "M0-01",
    status: INITIAL[type] ?? "active",
    candidate_ref: null,
    evidence: null,
    decision_ref: null,
  }));
  repo.expected = {
    sha,
    rows: rows.length,
    digest: digestOf(rows),
    // 추가 기준선도 같은 원칙(변조 전 정의의 path→type)으로 고정한다.
    typeDigest:
      Object.keys(extra).length === 0
        ? FIXTURE_TYPE_DIGEST
        : digestOf(
            Object.entries(files).map(([rel, [type]]) => ({ path: rel, type })),
            TYPE_LINE,
          ),
  };
  repo.ledger = { schema: 1, baseline_sha: sha, inventory_digest: repo.expected.digest, rows };
  write(repo, LEDGER_PATH, json(repo.ledger));
  const manifest = structuredClone(ROOT_MANIFEST);
  manifest.scripts["ci:bootstrap"] = "node scripts/rebuild-bootstrap.mjs";
  write(repo, "package.json", json(manifest));
  return repo;
}

// 기존 반례는 단계를 명시해 m0-01 당시 범위를 그대로 검증한다(CLI 기본 단계 상향에 묻어가지 않는다).
const check = (repo, stage = "m0-01") =>
  runChecks({ root: repo.root, expected: repo.expected, stage });

/** 최신 단계(= CLI·runChecks 기본). m0-06 위에 root 명령 2 script 등록을 더 요구한다. */
const FINAL = "m0-final-commands";
const FINAL_SCRIPTS = {
  "ci:m0": "node scripts/ci-m0.mjs",
  "ci:product": "node scripts/ci-m0.mjs --stage product",
};

/**
 * 같은 대상에 root 명령 2 script 만 더해 검사한 뒤 manifest 바이트를 원상으로 돌린다(stage 생략 = 기본 단계).
 * 그 두 script 는 최신 단계가 요구하는 등록이다 — 명시 과거 단계는 원래 manifest 로 그대로 검사한다.
 */
function checkWithRootScripts(repo, stage) {
  const original = read(repo, "package.json");
  const manifest = JSON.parse(original.toString("utf8"));
  Object.assign(manifest.scripts, FINAL_SCRIPTS);
  write(repo, "package.json", json(manifest));
  try {
    return runChecks({ root: repo.root, expected: repo.expected, ...(stage ? { stage } : {}) });
  } finally {
    write(repo, "package.json", original);
  }
}
const runDefault = (repo) => checkWithRootScripts(repo);

/**
 * 기본 결과는 명시 m0-final-commands 와 같고, 단계 이름 말고는 주어진 명시 m0-06 결과와 같다 —
 * 새 단계는 root 명령 등록을 더 요구할 뿐 m0-06 의 허용·보호를 그대로 물려받는다.
 */
function assertDefaultLike(repo, latest) {
  const byDefault = runDefault(repo);
  assert.deepEqual(byDefault, checkWithRootScripts(repo, FINAL));
  assert.equal(byDefault.summary.stage, FINAL);
  assert.equal(latest.summary.stage, "m0-06");
  assert.deepEqual(
    { ...byDefault, summary: { ...byDefault.summary, stage: latest.summary.stage } },
    latest,
  );
  return byDefault;
}
const failedChecks = (result) => [...new Set(result.failures.map((f) => f.check))].sort();
const messagesOf = (result, number) =>
  result.failures
    .filter((failure) => failure.check === number)
    .map((failure) => failure.message)
    .join("\n");

function assertGreen(repo, stage = "m0-01") {
  const result = check(repo, stage);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  return result;
}

/** 실행하지 않은 검사는 '미실행'으로 적히고, 어떤 검사도 '통과'로 적히지 않는다. */
function assertNotRun(report, numbers) {
  for (const number of numbers) {
    assert.match(report, new RegExp(`^검사 ${number} .+: 미실행$`, "m"));
  }
  assert.doesNotMatch(report, /^검사 \d .+: 통과$/m);
}

/**
 * ledger 의 type·status 만 바꿔 검사 1 분류 RED 를 확인하고 원상 GREEN 으로 되돌린다.
 * 원문 파일 바이트와 내용 digest 가 그대로임을 함께 단언한다 — 실패가 분류 검증에서 왔다는 증거.
 */
function reclassifyRedThenGreen(repo, changes) {
  const files = Object.keys(changes).map((rel) => [rel, read(repo, rel)]);
  const edited = structuredClone(repo.ledger);
  for (const [rel, change] of Object.entries(changes)) {
    Object.assign(
      edited.rows.find((row) => row.path === rel),
      change,
    );
  }
  write(repo, LEDGER_PATH, json(edited));
  assert.equal(digestOf(edited.rows), repo.expected.digest);
  const red = check(repo);
  assert.equal(red.ok, false);
  assert.deepEqual(failedChecks(red), [1]);
  assert.match(
    messagesOf(red, 1),
    /path→type 분류 digest [0-9a-f]{64} 가 승인 분류 digest 와 다르다/,
  );
  for (const [rel, bytes] of files) assert.deepEqual(read(repo, rel), bytes);
  write(repo, LEDGER_PATH, json(repo.ledger));
  assertGreen(repo);
  return { red, edited };
}

/** 파일 하나를 바꿔 RED 를 확인하고, 원래 바이트로 되돌려 GREEN 을 확인한다. */
function redThenGreen(repo, rel, mutate, expectedChecks, pattern, stage = "m0-01") {
  const original = read(repo, rel);
  mutate();
  const red = check(repo, stage);
  assert.equal(red.ok, false);
  assert.deepEqual(failedChecks(red), expectedChecks);
  assert.match(red.failures.map((failure) => failure.message).join("\n"), pattern);
  write(repo, rel, original);
  assertGreen(repo, stage);
}

/** 변조 전 BASELINE_FILES 정의에서 센 초기 상태별 수(R·K·F·D 20 active, N 17, T 1). */
const GREEN_STATUS_COUNTS = {
  active: 20,
  "pending-replacement": 17,
  "preserved-unported": 1,
  ported: 0,
  "contract-replaced": 0,
  retired: 0,
};

test("원상 합성 후보는 6개 검사를 모두 통과한다(GREEN 기준)", (t) => {
  const repo = makeRepo(t);
  const result = assertGreen(repo);
  const { summary } = result;
  assert.deepEqual(summary.newFiles, [LEDGER_PATH]);
  assert.equal(summary.lockDeclarations, 4);
  assert.deepEqual(summary.statusCounts, GREEN_STATUS_COUNTS);
  // 실제로 실행한 6검사의 결과가 그대로 출력된다(미실행 없음).
  assert.deepEqual(summary.ran, [0, 1, 2, 3, 4, 5, 6]);
  const report = formatReport(result);
  for (const number of [1, 2, 3, 4, 5, 6]) {
    assert.match(report, new RegExp(`^검사 ${number} .+: 통과$`, "m"));
  }
  assert.doesNotMatch(report, /미실행/);
  assert.match(report, /^결과: 통과$/m);
});

test("F fixture 1바이트 변조는 검사 3 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "docs/specs/fixture.json";
  redThenGreen(
    repo,
    rel,
    () => {
      const bytes = read(repo, rel);
      bytes[0] ^= 0x01;
      write(repo, rel, bytes);
    },
    [3, 4],
    /docs\/specs\/fixture\.json: 바이트가 기준선과 다르다/,
  );
});

test("CRLF 원문을 LF 로 정규화해도 검사 3 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "docs/notes.md";
  redThenGreen(
    repo,
    rel,
    () => write(repo, rel, read(repo, rel).toString("utf8").replaceAll("\r\n", "\n")),
    [3, 4],
    /docs\/notes\.md: 바이트가 기준선과 다르다/,
  );
});

test("lock 1바이트 변조는 검사 4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "pnpm-lock.yaml";
  redThenGreen(
    repo,
    rel,
    () => {
      const bytes = read(repo, rel);
      bytes[bytes.indexOf("sha512-mini") + "sha512-".length] ^= 0x01;
      write(repo, rel, bytes);
    },
    [3, 4],
    /pnpm-lock\.yaml 바이트가 기준선과 다르다/,
  );
});

test("추적 시험 삭제 + ledger 상태 유지는 검사 3 RED(부재 미설명), 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "apps/web/test/sample.test.ts";
  redThenGreen(
    repo,
    rel,
    () => unlinkSync(fileOf(repo, rel)),
    [3, 4],
    /apps\/web\/test\/sample\.test\.ts: 기준선 경로가 없다 — status 'preserved-unported' 가 부재를 설명하지 못한다/,
  );
});

test("ledger 행 중복은 검사 1 RED, 누락은 검사 1·2 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const target = "apps/api/src/main.ts";
  const duplicated = structuredClone(repo.ledger);
  duplicated.rows.push({ ...duplicated.rows.find((row) => row.path === target) });
  write(repo, LEDGER_PATH, json(duplicated));
  const duplicateRed = check(repo);
  assert.deepEqual(failedChecks(duplicateRed), [1]);
  assert.match(messagesOf(duplicateRed, 1), /apps\/api\/src\/main\.ts: 경로 중복/);

  const missing = structuredClone(repo.ledger);
  missing.rows = missing.rows.filter((row) => row.path !== target);
  write(repo, LEDGER_PATH, json(missing));
  const missingRed = check(repo);
  assert.deepEqual(failedChecks(missingRed), [1, 2]);
  assert.match(
    messagesOf(missingRed, 2),
    /apps\/api\/src\/main\.ts: 기준선 tree 에 있으나 ledger 에 없다/,
  );

  write(repo, LEDGER_PATH, json(repo.ledger));
  assertGreen(repo);
});

test("ledger 해시만 고치면 git object 재계산이 검사 2 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const forged = structuredClone(repo.ledger);
  forged.rows.find((row) => row.path === ".gitignore").sha256 = "0".repeat(64);
  write(repo, LEDGER_PATH, json(forged));
  const red = check(repo);
  assert.deepEqual(failedChecks(red), [1, 2, 3]);
  assert.match(messagesOf(red, 2), /\.gitignore: ledger sha256 이 git object 바이트와 다르다/);
  write(repo, LEDGER_PATH, json(repo.ledger));
  assertGreen(repo);
});

test("증거 없는 ported 표시는 검사 3·4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const ported = structuredClone(repo.ledger);
  ported.rows.find((row) => row.path === "apps/web/test/sample.test.ts").status = "ported";
  write(repo, LEDGER_PATH, json(ported));
  const red = check(repo);
  assert.deepEqual(failedChecks(red), [3, 4]);
  assert.match(messagesOf(red, 3), /ported 에는 candidate_ref 와 evidence 가 필요하다/);
  write(repo, LEDGER_PATH, json(repo.ledger));
  assertGreen(repo);
});

test("T행을 R+active 로 재분류하면 검사 1 분류 RED(원문·내용 digest 동일), 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const { red } = reclassifyRedThenGreen(repo, {
    "apps/web/test/sample.test.ts": { type: "R", status: "active" },
  });
  // 분류를 고정하지 않으면 이 시험이 미이관 요약에서 조용히 사라진다(검수 재현: 1→0).
  assert.equal(red.summary.statusCounts["preserved-unported"], 0);
});

test("T행을 N+pending-replacement 로 재분류하면 검사 1 분류 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  reclassifyRedThenGreen(repo, {
    "apps/web/test/sample.test.ts": { type: "N", status: "pending-replacement" },
  });
});

test("유형·상태 총수가 같은 R↔T 교환도 경로별 분류 digest 가 검사 1 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const { red, edited } = reclassifyRedThenGreen(repo, {
    "apps/api/prisma/schema.prisma": { type: "T", status: "preserved-unported" },
    "apps/web/test/sample.test.ts": { type: "R", status: "active" },
  });
  const typeCounts = (rows) => {
    const counts = {};
    for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
    return counts;
  };
  // 총수 비교로는 잡히지 않는 변조다 — 유형별 수와 상태별 수가 원상과 같다.
  assert.deepEqual(typeCounts(edited.rows), typeCounts(repo.ledger.rows));
  assert.deepEqual(red.summary.statusCounts, GREEN_STATUS_COUNTS);
});

test("기대 분류 digest(typeDigest)가 없으면 검사 1 RED(fail closed), 있으면 GREEN", (t) => {
  const repo = makeRepo(t);
  const expected = { ...repo.expected };
  delete expected.typeDigest;
  const red = runChecks({ root: repo.root, expected, stage: "m0-01" });
  assert.equal(red.ok, false);
  assert.deepEqual(failedChecks(red), [1]);
  assert.match(messagesOf(red, 1), /기대 분류 digest\(typeDigest\)가 없다/);
  assertGreen(repo);
});

test("ledger 를 읽거나 해석하지 못하면 검사 1 실패·2–6 미실행(CLI exit 1), 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const original = read(repo, LEDGER_PATH);
  const breakers = {
    없음: () => unlinkSync(fileOf(repo, LEDGER_PATH)),
    "JSON 아님": () => write(repo, LEDGER_PATH, "{ not json"),
  };
  for (const [label, breakLedger] of Object.entries(breakers)) {
    breakLedger();
    const red = check(repo);
    assert.equal(red.ok, false, label);
    assert.deepEqual(failedChecks(red), [1], label);
    assert.deepEqual(red.summary.ran, [0, 1], label);
    assertNotRun(formatReport(red), [2, 3, 4, 5, 6]);

    const cli = spawnSync(process.execPath, [CLI], { cwd: repo.root, encoding: "utf8" });
    assert.equal(cli.status, 1, label);
    assert.match(cli.stdout, /^검사 1 ledger 정합: 실패 1건$/m);
    assertNotRun(cli.stdout, [2, 3, 4, 5, 6]);
    assert.match(cli.stdout, /^결과: 실패 1건$/m);

    write(repo, LEDGER_PATH, original);
    assertGreen(repo);
  }
});

test("allowlist 밖 신규 파일은 검사 5 RED, ignore 대상은 통과, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  write(repo, "node_modules/left-pad/index.js", "module.exports = 1;\n");
  assertGreen(repo);
  const rel = "apps/web/test/extra.test.ts";
  write(repo, rel, "export const extra = 1;\n");
  const red = check(repo);
  assert.deepEqual(failedChecks(red), [5]);
  assert.match(
    messagesOf(red, 5),
    /apps\/web\/test\/extra\.test\.ts: 기준선 밖 파일이 이 단계 allowlist 에 없다/,
  );
  unlinkSync(fileOf(repo, rel));
  assertGreen(repo);
});

test("manifest 비-script 필드 변경은 검사 4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  redThenGreen(
    repo,
    "package.json",
    () => {
      const manifest = JSON.parse(read(repo, "package.json").toString("utf8"));
      manifest.devDependencies.prettier = "3.9.7";
      write(repo, "package.json", json(manifest));
    },
    [4, 6],
    /package\.json 'devDependencies' 가 기준선과 다르다/,
  );
});

test("ci:bootstrap 추가가 빠진 manifest 는 검사 4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  redThenGreen(
    repo,
    "package.json",
    () => write(repo, "package.json", json(ROOT_MANIFEST)),
    [4],
    /scripts\.ci:bootstrap = "node scripts\/rebuild-bootstrap\.mjs" 가 없다/,
  );
});

test("코드젠 배너 원문 변조는 검사 3·4·6 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "apps/web/scripts/add-generated-banner.mjs";
  redThenGreen(
    repo,
    rel,
    () => write(repo, rel, "// 바뀐 배너\n"),
    [3, 4, 6],
    /add-generated-banner\.mjs: lifecycle 입력이 기준선 원문과 다르다/,
  );
});

test("알 수 없는 단계·인자는 실패하고, 실제 CLI 기준선 값은 고정이다", (t) => {
  const repo = makeRepo(t);
  const unknown = check(repo, "m0-99");
  assert.equal(unknown.ok, false);
  assert.deepEqual(failedChecks(unknown), [0]);
  assert.deepEqual(unknown.summary.ran, [0]);
  assertNotRun(formatReport(unknown), [1, 2, 3, 4, 5, 6]);
  assert.throws(() => parseArgs(["--rows", "3"]), /알 수 없는 인자/);
  assert.deepEqual(parseArgs(["--stage", "m0-01"]), { stage: "m0-01" });

  const stageRun = spawnSync(process.execPath, [CLI, "--stage", "m0-99"], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(stageRun.status, 1);
  assert.match(stageRun.stdout, /알 수 없는 단계 'm0-99'/);
  assert.match(stageRun.stdout, /^검사 0 단계: 실패 1건$/m);
  assertNotRun(stageRun.stdout, [1, 2, 3, 4, 5, 6]);
  assert.match(stageRun.stdout, /^결과: 실패 1건$/m);
  const argRun = spawnSync(process.execPath, [CLI, "--baseline", repo.expected.sha], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(argRun.status, 2);

  assert.ok(Object.isFrozen(BASELINE));
  assert.deepEqual(
    { ...BASELINE },
    {
      sha: "7825c93ac9b1cc3ae8ae494b07ad7e693f6352cd",
      rows: 837,
      digest: "d71228fb86896ac9de620e77324aecbc16ea1ec2da62555a09fc870dfff1a97e",
      typeDigest: "098259acf3816cda51a43077a71eb3a759943399b21c9d71d2abe4a38fa3af61",
    },
  );
});

const M0_03_FILES = [
  "scripts/rebuild-fixtures.mjs",
  "scripts/rebuild-fixtures.test.mjs",
  "scripts/rebuild-api-types.check.ts",
  "scripts/tsconfig.rebuild-api-types.json",
];

test("m0-03 합성 후보는 명시 m0-03·m0-02a·m0-04·m0-05·m0-06·기본 단계(m0-final-commands) GREEN, 같은 대상의 명시 m0-01 은 검사 5 RED", (t) => {
  const repo = makeRepo(t);
  for (const rel of M0_03_FILES) write(repo, rel, "// m0-03 모의 파일\n");
  const explicit = check(repo, "m0-03");
  const byDefault = runDefault(repo);
  for (const [result, stage] of [
    [explicit, "m0-03"],
    [check(repo, "m0-02a"), "m0-02a"],
    [check(repo, "m0-04"), "m0-04"],
    [check(repo, "m0-05"), "m0-05"],
    [check(repo, "m0-06"), "m0-06"],
    [byDefault, FINAL],
  ]) {
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(result.summary.stage, stage);
    assert.deepEqual(result.summary.newFiles, [LEDGER_PATH, ...M0_03_FILES].sort());
    assert.deepEqual(result.summary.ran, [0, 1, 2, 3, 4, 5, 6]);
  }
  // m0-01 의 엄격 범위는 그대로다 — 같은 대상에서 M0-03 파일 4개가 allowlist 밖으로 잡힌다.
  const strict = check(repo, "m0-01");
  assert.equal(strict.ok, false);
  assert.deepEqual(failedChecks(strict), [5]);
  for (const rel of M0_03_FILES) {
    assert.ok(messagesOf(strict, 5).includes(`${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`));
  }
  for (const rel of M0_03_FILES) unlinkSync(fileOf(repo, rel));
  assertGreen(repo);
});

test("기본 단계는 m0-final-commands 이다 — parseArgs·runChecks·인자 없는 CLI 가 같은 단계를 쓴다", (t) => {
  assert.deepEqual(parseArgs([]), { stage: FINAL });
  assert.deepEqual(parseArgs([`--stage=${FINAL}`]), { stage: FINAL });
  assert.deepEqual(parseArgs(["--stage", FINAL]), { stage: FINAL });
  assert.deepEqual(parseArgs(["--stage=m0-06"]), { stage: "m0-06" });
  assert.deepEqual(parseArgs(["--stage", "m0-06"]), { stage: "m0-06" });
  assert.deepEqual(parseArgs(["--stage=m0-05"]), { stage: "m0-05" });
  assert.deepEqual(parseArgs(["--stage", "m0-05"]), { stage: "m0-05" });
  assert.deepEqual(parseArgs(["--stage=m0-04"]), { stage: "m0-04" });
  assert.deepEqual(parseArgs(["--stage=m0-02a"]), { stage: "m0-02a" });
  assert.deepEqual(parseArgs(["--stage=m0-03"]), { stage: "m0-03" });
  assert.deepEqual(parseArgs(["--stage", "m0-01"]), { stage: "m0-01" });
  assert.deepEqual(Object.keys(STAGES), [
    "m0-01",
    "m0-03",
    "m0-02a",
    "m0-04",
    "m0-05",
    "m0-06",
    FINAL,
  ]);
  // m0-03 은 신규 파일만 누적한다 — 그 밖 보호 규칙은 m0-01 과 같은 값이다.
  const { newFiles: strictFiles, ...strictRules } = STAGES["m0-01"];
  const { newFiles, ...rules } = STAGES["m0-03"];
  assert.deepEqual(rules, strictRules);
  assert.deepEqual(newFiles, [...strictFiles, ...M0_03_FILES]);
  assert.ok(
    Object.isFrozen(STAGES) && Object.isFrozen(STAGES["m0-03"]) && Object.isFrozen(newFiles),
  );

  // 인자 없는 CLI 도 m0-final-commands 를 검사한다(합성 cwd 는 고정 기준선과 달라 실패하지만 단계 표기로 확인).
  const repo = makeRepo(t);
  assert.equal(runChecks({ root: repo.root, expected: repo.expected }).summary.stage, FINAL);
  assert.deepEqual(runChecks({ root: repo.root, expected: repo.expected }), check(repo, FINAL));
  const run = spawnSync(process.execPath, [CLI], { cwd: repo.root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^rebuild-bootstrap · stage m0-final-commands · /m);
});

const M0_02A_FILES = [
  "scripts/ci-e2e.manifest.mjs",
  "scripts/ci-e2e.manifest.test.mjs",
  "apps/web/e2e/ci-manifest.json",
];
const APPROVED_CHANGES = [
  ".github/workflows/ci.yml",
  "scripts/ci-e2e.mjs",
  "scripts/ci-e2e.test.mjs",
];
const linesOf = (text) => text.split("\n");

test("m0-02a 는 m0-03 에 신규 3개를 누적(10)하고 정확한 3경로만 바이트 변경을 승인한다", () => {
  const { newFiles: priorFiles, ...priorRules } = STAGES["m0-03"];
  const { newFiles, approvedChanges, ...rules } = STAGES["m0-02a"];
  assert.deepEqual(rules, priorRules);
  assert.deepEqual(newFiles, [...priorFiles, ...M0_02A_FILES]);
  assert.equal(newFiles.length, 10);
  assert.deepEqual(approvedChanges, APPROVED_CHANGES);
  assert.ok([STAGES["m0-02a"], newFiles, approvedChanges].every((value) => Object.isFrozen(value)));
  // 과거 단계에는 바이트 변경 예외가 없다.
  assert.equal(STAGES["m0-01"].approvedChanges, undefined);
  assert.equal(STAGES["m0-03"].approvedChanges, undefined);
});

for (const rel of APPROVED_CHANGES) {
  test(`승인 경로 ${rel} 변경은 m0-02a·m0-04·m0-05·m0-06(명시)·기본 GREEN·예외 보고, 명시 m0-03·m0-01 은 검사 3 RED, 원상은 GREEN`, (t) => {
    const repo = makeRepo(t);
    const original = read(repo, rel);
    write(repo, rel, Buffer.concat([original, Buffer.from("# m0-02a 변경\n", "utf8")]));
    assertDefaultLike(repo, check(repo, "m0-06"));
    for (const stage of ["m0-02a", "m0-04", "m0-05", "m0-06"]) {
      const explicit = check(repo, stage);
      assert.deepEqual(explicit.failures, []);
      assert.equal(explicit.ok, true);
      assert.deepEqual(explicit.summary.approvedChanged, [rel]);
      assert.ok(linesOf(formatReport(explicit)).includes(`승인된 단계 예외(바이트 상이): ${rel}`));
    }
    for (const stage of ["m0-03", "m0-01"]) {
      const red = check(repo, stage);
      assert.equal(red.ok, false);
      assert.deepEqual(failedChecks(red), [3]);
      assert.deepEqual(linesOf(messagesOf(red, 3)), [
        `${rel}: 바이트가 기준선과 다르다(status active)`,
      ]);
      assert.deepEqual(red.summary.approvedChanged, []);
    }
    write(repo, rel, original);
    const green = assertGreen(repo, "m0-02a");
    assert.deepEqual(green.summary.approvedChanged, []);
    assert.ok(linesOf(formatReport(green)).includes("승인된 단계 예외(바이트 상이): 없음"));
  });
}

test("승인 경로라도 삭제는 m0-02a·m0-05(명시)·기본(m0-final-commands)에서 검사 3 RED(부재 미설명), 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "scripts/ci-e2e.mjs";
  const original = read(repo, rel);
  unlinkSync(fileOf(repo, rel));
  for (const result of [check(repo, "m0-02a"), check(repo, "m0-05"), runDefault(repo)]) {
    assert.equal(result.ok, false);
    assert.deepEqual(failedChecks(result), [3]);
    assert.deepEqual(linesOf(messagesOf(result, 3)), [
      `${rel}: 기준선 경로가 없다 — status 'active' 가 부재를 설명하지 못한다`,
    ]);
    assert.deepEqual(result.summary.approvedChanged, []);
  }
  write(repo, rel, original);
  assertGreen(repo, "m0-02a");
});

test("비승인 기준선 경로 변경은 m0-02a 에서도 RED — 예외는 정확한 경로에만 적용된다, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  // 승인 경로와 같은 디렉터리의 형제: prefix·glob 처럼 번지지 않는다.
  const sibling = ".github/workflows/nightly.yml";
  redThenGreen(
    repo,
    sibling,
    () => write(repo, sibling, "name: nightly\non: [push]\n"),
    [3],
    /^\.github\/workflows\/nightly\.yml: 바이트가 기준선과 다르다\(status active\)$/m,
    "m0-02a",
  );
  // apps·packages·docs 아래 경로는 검사 4 의 동결도 그대로 걸린다.
  redThenGreen(
    repo,
    "docs/specs/fixture.json",
    () => write(repo, "docs/specs/fixture.json", json({ cases: [1, 2] })),
    [3, 4],
    /docs\/specs\/fixture\.json: 바이트가 기준선과 다르다/,
    "m0-02a",
  );
});

test("CI manifest 신규 3개는 m0-02a GREEN·명시 m0-03 검사 5 RED, 10개 밖 신규 파일은 m0-02a 검사 5 RED", (t) => {
  const repo = makeRepo(t);
  for (const rel of M0_02A_FILES) write(repo, rel, "// m0-02a 모의 파일\n");
  const green = assertGreen(repo, "m0-02a");
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...M0_02A_FILES].sort());
  const strict = check(repo, "m0-03");
  assert.deepEqual(failedChecks(strict), [5]);
  assert.deepEqual(
    linesOf(messagesOf(strict, 5)),
    [...M0_02A_FILES].sort().map((rel) => `${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`),
  );
  // 이름이 비슷해도 10개 allowlist 밖이면 m0-02a 에서도 거부한다.
  const outside = "scripts/ci-e2e.manifest.extra.mjs";
  write(repo, outside, "// 승인 밖\n");
  const red = check(repo, "m0-02a");
  assert.deepEqual(failedChecks(red), [5]);
  assert.deepEqual(linesOf(messagesOf(red, 5)), [
    `${outside}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
  ]);
  unlinkSync(fileOf(repo, outside));
  for (const rel of M0_02A_FILES) unlinkSync(fileOf(repo, rel));
  assertGreen(repo, "m0-02a");
});

const M0_04_FILES = [
  "apps/api/prisma/seed-load-semantics.ts",
  "apps/api/test/rebuild-foundation.spec.ts",
];
const SEED = "apps/api/prisma/seed-exercises.ts";
const CONTRACT_REPLACED = [
  "apps/api/src/main.ts",
  "apps/api/src/app.module.ts",
  "apps/api/src/prisma/prisma.module.ts",
  "apps/api/src/prisma/prisma.service.ts",
  "apps/api/src/common/date/utc-day.ts",
  "apps/api/src/common/http/error-envelope.filter.ts",
];
const REFS = { candidate_ref: "합성 후보", evidence: "합성 증거" };
const REPLACED = { status: "contract-replaced", ...REFS };
const FROZEN_DIFF = (count) =>
  `apps/·packages/·docs/ 아래 ${count}개 경로가 기준선과 다르다(검사 3 참조)`;

/** ledger 의 지정 행 상태 필드만 바꾼 사본을 쓴다(path·blob·sha256·type 은 그대로 → 두 digest 불변). */
function writeLedgerWith(repo, changes) {
  const edited = structuredClone(repo.ledger);
  for (const [rel, change] of Object.entries(changes)) {
    Object.assign(
      edited.rows.find((row) => row.path === rel),
      change,
    );
  }
  write(repo, LEDGER_PATH, json(edited));
  return edited;
}

/** 같은 경로 재작성 모의: 원문 뒤에 한 줄을 붙여 바이트만 바꾼다. */
const rewrite = (repo, rel) =>
  write(repo, rel, Buffer.concat([read(repo, rel), Buffer.from("// m0-04 재작성\n", "utf8")]));

function restore(repo, files, stage = "m0-04") {
  for (const [rel, bytes] of files) write(repo, rel, bytes);
  write(repo, LEDGER_PATH, json(repo.ledger));
  return assertGreen(repo, stage);
}

test("m0-04 는 m0-02a 에 신규 2개(누적 12)·seed 1경로 예외·정확한 6경로 전환만 더한다", () => {
  const { newFiles: priorFiles, approvedChanges: priorChanges, ...priorRules } = STAGES["m0-02a"];
  const { newFiles, approvedChanges, contractReplaced, ...rules } = STAGES["m0-04"];
  assert.deepEqual(rules, priorRules);
  assert.deepEqual(newFiles, [...priorFiles, ...M0_04_FILES]);
  assert.equal(newFiles.length, 12);
  assert.deepEqual(approvedChanges, [...priorChanges, SEED]);
  assert.deepEqual(contractReplaced, CONTRACT_REPLACED);
  assert.ok(
    [STAGES["m0-04"], newFiles, approvedChanges, contractReplaced].every((value) =>
      Object.isFrozen(value),
    ),
  );
  // 과거 단계에는 상태 전환 예외가 없다.
  for (const stage of ["m0-01", "m0-03", "m0-02a"]) {
    assert.equal(STAGES[stage].contractReplaced, undefined);
  }
});

for (const rel of CONTRACT_REPLACED) {
  test(`같은 경로 교체 ${rel}: 바이트 변경+contract-replaced+refs 는 m0-04·m0-05·m0-06(명시)·기본 GREEN, 전환 없는 변경과 명시 과거 단계는 RED, 원상은 GREEN`, (t) => {
    const repo = makeRepo(t);
    const original = read(repo, rel);
    rewrite(repo, rel);
    // 상태를 바꾸지 않은 바이트 변경은 m0-04 에서도 RED — 바이트 차이는 전환된 행에만 허용한다.
    const unrecorded = check(repo, "m0-04");
    assert.deepEqual(failedChecks(unrecorded), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(unrecorded, 3)), [
      `${rel}: 바이트가 기준선과 다르다(status pending-replacement)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(unrecorded, 4)), [FROZEN_DIFF(1)]);

    writeLedgerWith(repo, { [rel]: REPLACED });
    const explicit = check(repo, "m0-04");
    const latest = check(repo, "m0-06");
    assertDefaultLike(repo, latest);
    assert.deepEqual(latest.failures, []);
    assert.deepEqual(check(repo, "m0-05").failures, []);
    assert.deepEqual(explicit.failures, []);
    assert.equal(explicit.ok, true);
    assert.deepEqual(explicit.summary.contractReplaced, [rel]);
    assert.deepEqual(explicit.summary.approvedChanged, []);
    assert.equal(explicit.summary.statusCounts["contract-replaced"], 1);
    assert.ok(linesOf(formatReport(explicit)).includes(`같은 경로 계약 교체 전환: ${rel}`));
    for (const stage of ["m0-02a", "m0-03", "m0-01"]) {
      const red = check(repo, stage);
      assert.equal(red.ok, false);
      assert.deepEqual(failedChecks(red), [4]);
      assert.deepEqual(linesOf(messagesOf(red, 4)), [
        `${rel}: 이 단계에서는 초기 상태 'pending-replacement' 만 허용한다('contract-replaced')`,
        FROZEN_DIFF(1),
      ]);
      assert.deepEqual(red.summary.contractReplaced, []);
    }
    const green = restore(repo, [[rel, original]]);
    assert.deepEqual(green.summary.contractReplaced, []);
    assert.ok(linesOf(formatReport(green)).includes("같은 경로 계약 교체 전환: 없음"));
  });
}

test("refs 가 있어도 같은 경로 교체 6경로의 삭제는 m0-04 검사 3·4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  for (const rel of CONTRACT_REPLACED) {
    const original = read(repo, rel);
    unlinkSync(fileOf(repo, rel));
    writeLedgerWith(repo, { [rel]: REPLACED });
    for (const result of [check(repo, "m0-04"), check(repo, "m0-05"), runDefault(repo)]) {
      assert.equal(result.ok, false);
      assert.deepEqual(failedChecks(result), [3, 4]);
      assert.deepEqual(linesOf(messagesOf(result, 3)), [
        `${rel}: 같은 경로 교체 대상인데 파일이 없다 — refs 가 있어도 부재를 허용하지 않는다`,
      ]);
      assert.deepEqual(linesOf(messagesOf(result, 4)), [FROZEN_DIFF(1)]);
    }
    restore(repo, [[rel, original]]);
  }
});

test("refs 가 빠진 전환은 m0-04 검사 3 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const rel = "apps/api/src/app.module.ts";
  const original = read(repo, rel);
  rewrite(repo, rel);
  for (const missing of ["candidate_ref", "evidence"]) {
    writeLedgerWith(repo, { [rel]: { ...REPLACED, [missing]: null } });
    const red = check(repo, "m0-04");
    assert.equal(red.ok, false, missing);
    assert.deepEqual(failedChecks(red), [3], missing);
    assert.deepEqual(linesOf(messagesOf(red, 3)), [
      `${rel}: contract-replaced 에는 candidate_ref 와 evidence 가 필요하다`,
    ]);
  }
  restore(repo, [[rel, original]]);
});

test("목록 밖 N행(보안 이음새·형제 경로) 전환과 목록 경로의 다른 상태는 m0-04 검사 4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  for (const rel of ["apps/api/src/app.setup.ts", "apps/api/src/common/date/request-today.ts"]) {
    const original = read(repo, rel);
    rewrite(repo, rel);
    writeLedgerWith(repo, { [rel]: REPLACED });
    const red = check(repo, "m0-04");
    assert.equal(red.ok, false, rel);
    assert.deepEqual(failedChecks(red), [4], rel);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [
      `${rel}: 이 단계에서는 초기 상태 'pending-replacement' 만 허용한다('contract-replaced')`,
      FROZEN_DIFF(1),
    ]);
    restore(repo, [[rel, original]]);
  }
  // 목록 경로라도 contract-replaced 밖 상태는 허용하지 않는다(바이트 예외도 생기지 않는다).
  const rel = "apps/api/src/prisma/prisma.service.ts";
  const original = read(repo, rel);
  rewrite(repo, rel);
  writeLedgerWith(repo, { [rel]: { status: "ported", ...REFS } });
  const ported = check(repo, "m0-04");
  assert.deepEqual(failedChecks(ported), [4]);
  assert.deepEqual(linesOf(messagesOf(ported, 4)), [
    `${rel}: 이 단계에서는 'pending-replacement' 또는 'contract-replaced' 만 허용한다('ported')`,
    FROZEN_DIFF(1),
  ]);
  restore(repo, [[rel, original]]);
});

test("m0-04 에서도 비승인 기준선 바이트 변경은 RED — 보안 이음새·형제 경로·원천·스키마, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  for (const [rel, pattern] of [
    ["apps/api/src/app.setup.ts", /^apps\/api\/src\/app\.setup\.ts: 바이트가 기준선과 다르다/m],
    [
      "apps/api/src/common/date/request-today.ts",
      /^apps\/api\/src\/common\/date\/request-today\.ts: 바이트가 기준선과 다르다/m,
    ],
    [
      "apps/api/prisma/resistance-exercise-ids.ts",
      /^apps\/api\/prisma\/resistance-exercise-ids\.ts: 바이트가 기준선과 다르다/m,
    ],
    ["docs/specs/fixture.json", /^docs\/specs\/fixture\.json: 바이트가 기준선과 다르다/m],
  ]) {
    redThenGreen(repo, rel, () => rewrite(repo, rel), [3, 4], pattern, "m0-04");
  }
  redThenGreen(
    repo,
    "apps/api/prisma/schema.prisma",
    () => rewrite(repo, "apps/api/prisma/schema.prisma"),
    [3, 4, 6],
    /schema\.prisma: lifecycle 입력이 기준선 원문과 다르다/,
    "m0-04",
  );
});

test("seed 1경로 변경은 m0-04·m0-05·m0-06(명시)·기본 GREEN·예외 보고, 명시 과거 단계·삭제·상태 전환은 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const original = read(repo, SEED);
  write(repo, SEED, 'import { loadSemanticsFor } from "./seed-load-semantics";\n');
  const explicit = check(repo, "m0-04");
  const prior = check(repo, "m0-05");
  const latest = check(repo, "m0-06");
  assertDefaultLike(repo, latest);
  assert.deepEqual(latest.failures, []);
  assert.deepEqual(latest.summary.approvedChanged, [SEED]);
  assert.deepEqual(prior.failures, []);
  assert.deepEqual(prior.summary.approvedChanged, [SEED]);
  assert.deepEqual(explicit.failures, []);
  assert.deepEqual(explicit.summary.approvedChanged, [SEED]);
  // seed 는 상태를 바꾸지 않는다 — R·active·기준선 해시 그대로다.
  assert.deepEqual(explicit.summary.contractReplaced, []);
  assert.deepEqual(explicit.summary.statusCounts, GREEN_STATUS_COUNTS);
  assert.ok(linesOf(formatReport(explicit)).includes(`승인된 단계 예외(바이트 상이): ${SEED}`));
  for (const stage of ["m0-02a", "m0-03", "m0-01"]) {
    const red = check(repo, stage);
    assert.deepEqual(failedChecks(red), [3, 4], stage);
    assert.deepEqual(linesOf(messagesOf(red, 3)), [
      `${SEED}: 바이트가 기준선과 다르다(status active)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [FROZEN_DIFF(1)]);
  }
  writeLedgerWith(repo, { [SEED]: REPLACED });
  const transitioned = check(repo, "m0-04");
  assert.deepEqual(failedChecks(transitioned), [4]);
  assert.deepEqual(linesOf(messagesOf(transitioned, 4)), [
    `${SEED}: 이 단계에서는 초기 상태 'active' 만 허용한다('contract-replaced')`,
  ]);
  write(repo, LEDGER_PATH, json(repo.ledger));
  unlinkSync(fileOf(repo, SEED));
  const deleted = check(repo, "m0-04");
  assert.deepEqual(failedChecks(deleted), [3, 4]);
  assert.deepEqual(linesOf(messagesOf(deleted, 3)), [
    `${SEED}: 기준선 경로가 없다 — status 'active' 가 부재를 설명하지 못한다`,
  ]);
  assert.deepEqual(linesOf(messagesOf(deleted, 4)), [FROZEN_DIFF(1)]);
  const green = restore(repo, [[SEED, original]]);
  assert.deepEqual(green.summary.approvedChanged, []);
});

test("m0-04 신규 2개는 m0-04 GREEN·명시 m0-02a 검사 5 RED, 12개 밖 신규 파일은 m0-04 검사 5 RED", (t) => {
  const repo = makeRepo(t);
  for (const rel of M0_04_FILES) write(repo, rel, "// m0-04 모의 파일\n");
  const green = assertGreen(repo, "m0-04");
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...M0_04_FILES].sort());
  const strict = check(repo, "m0-02a");
  assert.deepEqual(failedChecks(strict), [5]);
  assert.deepEqual(
    linesOf(messagesOf(strict, 5)),
    [...M0_04_FILES].sort().map((rel) => `${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`),
  );
  const outside = "apps/api/prisma/seed-load-semantics.extra.ts";
  write(repo, outside, "// 승인 밖\n");
  const red = check(repo, "m0-04");
  assert.deepEqual(failedChecks(red), [5]);
  assert.deepEqual(linesOf(messagesOf(red, 5)), [
    `${outside}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
  ]);
  unlinkSync(fileOf(repo, outside));
  for (const rel of M0_04_FILES) unlinkSync(fileOf(repo, rel));
  assertGreen(repo, "m0-04");
});

test("6경로 전환+seed+신규 2개 전체 후보는 m0-04 GREEN·행 수·두 digest 유지, 과거 단계와 해시 갱신은 RED", (t) => {
  const repo = makeRepo(t);
  const originals = [...CONTRACT_REPLACED, SEED].map((rel) => [rel, read(repo, rel)]);
  for (const rel of CONTRACT_REPLACED) rewrite(repo, rel);
  write(repo, SEED, 'import { loadSemanticsFor } from "./seed-load-semantics";\n');
  for (const rel of M0_04_FILES) write(repo, rel, "// m0-04 모의 파일\n");
  const edited = writeLedgerWith(
    repo,
    Object.fromEntries(CONTRACT_REPLACED.map((rel) => [rel, REPLACED])),
  );
  // 전환은 상태 필드만 바꾼다 — 행 수·내용 digest·분류 digest 는 기준선 그대로다.
  assert.equal(edited.rows.length, repo.expected.rows);
  assert.equal(digestOf(edited.rows), repo.expected.digest);
  assert.equal(digestOf(edited.rows, TYPE_LINE), repo.expected.typeDigest);
  const green = assertGreen(repo, "m0-04");
  assertGreen(repo, "m0-05");
  const latest = assertGreen(repo, "m0-06");
  assertDefaultLike(repo, latest);
  assert.deepEqual([...green.summary.contractReplaced].sort(), [...CONTRACT_REPLACED].sort());
  assert.deepEqual(green.summary.approvedChanged, [SEED]);
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...M0_04_FILES].sort());
  assert.deepEqual(green.summary.statusCounts, {
    ...GREEN_STATUS_COUNTS,
    "pending-replacement": GREEN_STATUS_COUNTS["pending-replacement"] - 6,
    "contract-replaced": 6,
  });
  // 과거 단계는 계속 엄격하다(이 후보에서 실패가 정상이다).
  for (const stage of ["m0-02a", "m0-03", "m0-01"]) {
    assert.deepEqual(failedChecks(check(repo, stage)), [3, 4, 5], stage);
  }
  // 전환 행의 sha256 을 후보 바이트로 '갱신'하면 기준선 digest·git object 대조가 깨진다.
  const forged = structuredClone(edited);
  const target = forged.rows.find((row) => row.path === "apps/api/src/main.ts");
  target.sha256 = sha256(read(repo, target.path));
  write(repo, LEDGER_PATH, json(forged));
  const red = check(repo, "m0-04");
  assert.deepEqual(failedChecks(red), [1, 2]);
  assert.match(
    messagesOf(red, 2),
    /apps\/api\/src\/main\.ts: ledger sha256 이 git object 바이트와 다르다/,
  );
  for (const rel of M0_04_FILES) unlinkSync(fileOf(repo, rel));
  restore(repo, originals);
});

const M0_05_FILES = ["apps/web/test/rebuild-foundation.test.tsx"];
const VERIFY = ["apps/web/scripts/verify-no-test-seed.mjs", "apps/web/scripts/verify-contrast.mjs"];
const SHELL = [
  "apps/web/app/layout.tsx",
  "apps/web/app/page.tsx",
  "apps/web/app/providers.tsx",
  "apps/web/app/globals.css",
  "apps/web/app/sw.ts",
  "apps/web/components/navigation/app-shell.tsx",
  "apps/web/components/ui/cn.ts",
];
const M0_05_ONLY = [...M0_05_FILES, ...VERIFY, ...SHELL];
const baselineText = (rel) => Buffer.from(BASELINE_FILES[rel][1], "utf8");

test("m0-05 는 m0-04 에 FE 신규 1(누적 13)·verify 2(승인 6)·셸 7(전환 13)만 더하고 과거 단계로 새지 않는다", () => {
  const {
    newFiles: priorFiles,
    approvedChanges: priorChanges,
    contractReplaced: priorReplaced,
    ...priorRules
  } = STAGES["m0-04"];
  const { newFiles, approvedChanges, contractReplaced, ...rules } = STAGES["m0-05"];
  assert.deepEqual(rules, priorRules);
  assert.deepEqual(newFiles, [...priorFiles, ...M0_05_FILES]);
  assert.equal(newFiles.length, 13);
  assert.deepEqual(approvedChanges, [...priorChanges, ...VERIFY]);
  assert.equal(approvedChanges.length, 6);
  assert.deepEqual(contractReplaced, [...CONTRACT_REPLACED, ...SHELL]);
  assert.equal(contractReplaced.length, 13);
  assert.ok(
    [STAGES["m0-05"], newFiles, approvedChanges, contractReplaced].every((value) =>
      Object.isFrozen(value),
    ),
  );
  // m0-04 의 목록은 그대로다(12·4·6) — m0-05 경로가 과거 단계에 하나도 없다.
  assert.deepEqual(
    [priorFiles.length, priorChanges.length, priorReplaced.length],
    [12, 4, CONTRACT_REPLACED.length],
  );
  for (const stage of ["m0-01", "m0-03", "m0-02a", "m0-04"]) {
    const {
      newFiles: files,
      approvedChanges: changes = [],
      contractReplaced: replaced = [],
    } = STAGES[stage];
    for (const rel of M0_05_ONLY) {
      assert.ok(![...files, ...changes, ...replaced].includes(rel), `${stage}: ${rel}`);
    }
  }
});

for (const rel of VERIFY) {
  test(`verify ${rel}: 변경은 m0-05·m0-06(명시)·기본 GREEN·예외 보고, 명시 m0-04 는 검사 3·4 RED, 삭제는 m0-05·기본에서도 RED`, (t) => {
    const repo = makeRepo(t);
    const original = read(repo, rel);
    write(repo, rel, Buffer.concat([original, Buffer.from("// m0-05 변경\n", "utf8")]));
    const explicit = check(repo, "m0-05");
    const latest = check(repo, "m0-06");
    assertDefaultLike(repo, latest);
    assert.deepEqual(latest.failures, []);
    assert.deepEqual(latest.summary.approvedChanged, [rel]);
    assert.deepEqual(explicit.failures, []);
    assert.deepEqual(explicit.summary.approvedChanged, [rel]);
    assert.deepEqual(explicit.summary.statusCounts, GREEN_STATUS_COUNTS);
    assert.ok(linesOf(formatReport(explicit)).includes(`승인된 단계 예외(바이트 상이): ${rel}`));
    // 정확 예외는 m0-05 에만 있다 — m0-04 에서는 검사 3(바이트)·4(동결)가 함께 잡는다.
    const strict = check(repo, "m0-04");
    assert.deepEqual(failedChecks(strict), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(strict, 3)), [
      `${rel}: 바이트가 기준선과 다르다(status active)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(strict, 4)), [FROZEN_DIFF(1)]);
    assert.deepEqual(strict.summary.approvedChanged, []);
    // 승인 경로라도 부재는 허용하지 않는다.
    unlinkSync(fileOf(repo, rel));
    for (const deleted of [check(repo, "m0-05"), runDefault(repo)]) {
      assert.deepEqual(failedChecks(deleted), [3, 4]);
      assert.deepEqual(linesOf(messagesOf(deleted, 3)), [
        `${rel}: 기준선 경로가 없다 — status 'active' 가 부재를 설명하지 못한다`,
      ]);
      assert.deepEqual(linesOf(messagesOf(deleted, 4)), [FROZEN_DIFF(1)]);
    }
    const green = restore(repo, [[rel, original]], "m0-05");
    assert.deepEqual(green.summary.approvedChanged, []);
  });
}

for (const rel of SHELL) {
  test(`FE 셸 ${rel}: pending 변조는 m0-05 에서도 RED, 정확 전환+refs 는 m0-05·m0-06(명시)·기본 GREEN·명시 m0-04 RED, refs 가 있어도 삭제는 RED`, (t) => {
    const repo = makeRepo(t);
    const original = read(repo, rel);
    rewrite(repo, rel);
    // 목록에 있어도 전환 전 pending 행의 바이트 변경은 RED 다(목록 등록 ≠ 개별 승인).
    const unrecorded = check(repo, "m0-05");
    assert.deepEqual(failedChecks(unrecorded), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(unrecorded, 3)), [
      `${rel}: 바이트가 기준선과 다르다(status pending-replacement)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(unrecorded, 4)), [FROZEN_DIFF(1)]);

    writeLedgerWith(repo, { [rel]: REPLACED });
    const explicit = check(repo, "m0-05");
    const latest = check(repo, "m0-06");
    assertDefaultLike(repo, latest);
    assert.deepEqual(latest.failures, []);
    assert.deepEqual(latest.summary.contractReplaced, [rel]);
    assert.deepEqual(explicit.failures, []);
    assert.deepEqual(explicit.summary.contractReplaced, [rel]);
    assert.equal(explicit.summary.statusCounts["contract-replaced"], 1);
    assert.ok(linesOf(formatReport(explicit)).includes(`같은 경로 계약 교체 전환: ${rel}`));
    const strict = check(repo, "m0-04");
    assert.deepEqual(failedChecks(strict), [4]);
    assert.deepEqual(linesOf(messagesOf(strict, 4)), [
      `${rel}: 이 단계에서는 초기 상태 'pending-replacement' 만 허용한다('contract-replaced')`,
      FROZEN_DIFF(1),
    ]);

    unlinkSync(fileOf(repo, rel));
    const deleted = check(repo, "m0-05");
    assert.deepEqual(failedChecks(deleted), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(deleted, 3)), [
      `${rel}: 같은 경로 교체 대상인데 파일이 없다 — refs 가 있어도 부재를 허용하지 않는다`,
    ]);
    assert.deepEqual(linesOf(messagesOf(deleted, 4)), [FROZEN_DIFF(1)]);
    const green = restore(repo, [[rel, original]], "m0-05");
    assert.deepEqual(green.summary.contractReplaced, []);
  });
}

test("m0-05 목록 밖 web N행(cn.ts 옆 Button.tsx) 전환·셸 경로의 ported·verify 형제 변경은 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  const sibling = "apps/web/components/ui/Button.tsx";
  const siblingOriginal = read(repo, sibling);
  rewrite(repo, sibling);
  writeLedgerWith(repo, { [sibling]: REPLACED });
  const outside = check(repo, "m0-05");
  assert.deepEqual(failedChecks(outside), [4]);
  assert.deepEqual(linesOf(messagesOf(outside, 4)), [
    `${sibling}: 이 단계에서는 초기 상태 'pending-replacement' 만 허용한다('contract-replaced')`,
    FROZEN_DIFF(1),
  ]);
  restore(repo, [[sibling, siblingOriginal]], "m0-05");

  const shell = "apps/web/app/page.tsx";
  const shellOriginal = read(repo, shell);
  rewrite(repo, shell);
  writeLedgerWith(repo, { [shell]: { status: "ported", ...REFS } });
  const ported = check(repo, "m0-05");
  assert.deepEqual(failedChecks(ported), [4]);
  assert.deepEqual(linesOf(messagesOf(ported, 4)), [
    `${shell}: 이 단계에서는 'pending-replacement' 또는 'contract-replaced' 만 허용한다('ported')`,
    FROZEN_DIFF(1),
  ]);
  restore(repo, [[shell, shellOriginal]], "m0-05");

  // verify 정확 예외가 같은 디렉터리 형제로 번지지 않는다.
  const fontPayload = "apps/web/scripts/verify-font-payload.mjs";
  redThenGreen(
    repo,
    fontPayload,
    () => rewrite(repo, fontPayload),
    [3, 4],
    /^apps\/web\/scripts\/verify-font-payload\.mjs: 바이트가 기준선과 다르다\(status active\)$/m,
    "m0-05",
  );
});

test("셸 일부만 전환하고 나머지는 원문·pending 으로 두어도 m0-05 GREEN — 전부 전환을 강제하지 않는다", (t) => {
  const repo = makeRepo(t);
  const partial = SHELL.slice(0, 3);
  const originals = partial.map((rel) => [rel, read(repo, rel)]);
  for (const rel of partial) rewrite(repo, rel);
  writeLedgerWith(repo, Object.fromEntries(partial.map((rel) => [rel, REPLACED])));
  const green = assertGreen(repo, "m0-05");
  assert.deepEqual([...green.summary.contractReplaced].sort(), [...partial].sort());
  assert.deepEqual(green.summary.statusCounts, {
    ...GREEN_STATUS_COUNTS,
    "pending-replacement": GREEN_STATUS_COUNTS["pending-replacement"] - partial.length,
    "contract-replaced": partial.length,
  });
  // 나머지 셸은 원문 바이트·pending 그대로다.
  for (const rel of SHELL.slice(partial.length))
    assert.deepEqual(read(repo, rel), baselineText(rel));
  restore(repo, originals, "m0-05");
});

test("FE 신규 spec 은 m0-05 GREEN·명시 m0-04 검사 5 RED, 13 밖 유사 이름 신규 파일은 m0-05 검사 5 RED", (t) => {
  const repo = makeRepo(t);
  for (const rel of M0_05_FILES) write(repo, rel, "// m0-05 모의 spec\n");
  const green = assertGreen(repo, "m0-05");
  assertDefaultLike(repo, assertGreen(repo, "m0-06"));
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...M0_05_FILES].sort());
  const strict = check(repo, "m0-04");
  assert.deepEqual(failedChecks(strict), [5]);
  assert.deepEqual(
    linesOf(messagesOf(strict, 5)),
    M0_05_FILES.map((rel) => `${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`),
  );
  const outside = "apps/web/test/rebuild-foundation.extra.test.tsx";
  write(repo, outside, "// 승인 밖\n");
  const red = check(repo, "m0-05");
  assert.deepEqual(failedChecks(red), [5]);
  assert.deepEqual(linesOf(messagesOf(red, 5)), [
    `${outside}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
  ]);
  unlinkSync(fileOf(repo, outside));
  for (const rel of M0_05_FILES) unlinkSync(fileOf(repo, rel));
  assertGreen(repo, "m0-05");
});

test("m0-05 전용 변경(셸 전환·verify 변경·신규 spec)은 명시 m0-04·m0-02a·m0-03·m0-01 에서 해당 검사 RED", (t) => {
  const repo = makeRepo(t);
  const [shell] = SHELL;
  const [verify] = VERIFY;
  const originals = [shell, verify].map((rel) => [rel, read(repo, rel)]);
  rewrite(repo, shell);
  writeLedgerWith(repo, { [shell]: REPLACED });
  write(repo, verify, Buffer.concat([read(repo, verify), Buffer.from("// m0-05 변경\n", "utf8")]));
  for (const rel of M0_05_FILES) write(repo, rel, "// m0-05 모의 spec\n");
  assertGreen(repo, "m0-05");
  for (const stage of ["m0-04", "m0-02a", "m0-03", "m0-01"]) {
    const red = check(repo, stage);
    assert.equal(red.ok, false, stage);
    assert.deepEqual(failedChecks(red), [3, 4, 5], stage);
    assert.ok(
      linesOf(messagesOf(red, 3)).includes(`${verify}: 바이트가 기준선과 다르다(status active)`),
    );
    assert.ok(
      linesOf(messagesOf(red, 4)).includes(
        `${shell}: 이 단계에서는 초기 상태 'pending-replacement' 만 허용한다('contract-replaced')`,
      ),
    );
    assert.ok(
      linesOf(messagesOf(red, 5)).includes(
        `${M0_05_FILES[0]}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
      ),
    );
  }
  for (const rel of M0_05_FILES) unlinkSync(fileOf(repo, rel));
  restore(repo, originals, "m0-05");
});

test("API 6 + 셸 7 전환·seed·verify 2 변경·신규 3 전체 후보는 m0-05 GREEN·행 수·두 digest 유지, 과거 단계는 RED", (t) => {
  const repo = makeRepo(t);
  const replaced = [...CONTRACT_REPLACED, ...SHELL];
  const changed = [SEED, ...VERIFY];
  const added = [...M0_04_FILES, ...M0_05_FILES];
  const originals = [...replaced, ...changed].map((rel) => [rel, read(repo, rel)]);
  for (const rel of replaced) rewrite(repo, rel);
  for (const rel of changed) {
    write(repo, rel, Buffer.concat([read(repo, rel), Buffer.from("// m0-05 변경\n", "utf8")]));
  }
  for (const rel of added) write(repo, rel, "// 모의 신규 파일\n");
  const edited = writeLedgerWith(repo, Object.fromEntries(replaced.map((rel) => [rel, REPLACED])));
  // 전환은 상태 필드만 바꾼다 — 행 수·내용 digest·분류 digest 는 기준선 그대로다.
  assert.equal(edited.rows.length, repo.expected.rows);
  assert.equal(digestOf(edited.rows), repo.expected.digest);
  assert.equal(digestOf(edited.rows, TYPE_LINE), repo.expected.typeDigest);
  const green = assertGreen(repo, "m0-05");
  assertDefaultLike(repo, assertGreen(repo, "m0-06"));
  assert.deepEqual([...green.summary.contractReplaced].sort(), [...replaced].sort());
  assert.deepEqual([...green.summary.approvedChanged].sort(), [...changed].sort());
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...added].sort());
  assert.deepEqual(green.summary.statusCounts, {
    ...GREEN_STATUS_COUNTS,
    "pending-replacement": GREEN_STATUS_COUNTS["pending-replacement"] - replaced.length,
    "contract-replaced": replaced.length,
  });
  for (const stage of ["m0-04", "m0-02a", "m0-03", "m0-01"]) {
    assert.deepEqual(failedChecks(check(repo, stage)), [3, 4, 5], stage);
  }
  for (const rel of added) unlinkSync(fileOf(repo, rel));
  restore(repo, originals, "m0-05");
});

const M0_06_FILES = ["apps/web/e2e/m0-06-shell-api.spec.ts"];
const BASE_CONFIG = "apps/web/playwright.config.ts";
const DERIVED_CONFIGS = [
  "apps/web/playwright.v2-split.config.ts",
  "apps/web/playwright.fact-window.config.ts",
];
/** 종료 정리 누락만 고친 격리 결함 예외 T 시험 1과, 예외 밖인 같은 디렉터리의 형제 T 시험. */
const ISOLATED_TEST = "apps/api/test/cardio-program.spec.ts";
const SIBLING_TEST = "apps/api/test/cors.spec.ts";
/** m0-06 반례 전용 추가 기준선: 승인 base config(R)와 같은 디렉터리의 derived config 2(T). */
const M0_06_BASELINE = {
  [BASE_CONFIG]: ["R", 'export default { testDir: "./e2e" };\n'],
  "apps/web/playwright.v2-split.config.ts": ["T", "export default { testMatch: /22-split/ };\n"],
  "apps/web/playwright.fact-window.config.ts": ["T", "export default { testMatch: /24-fact/ };\n"],
};
/** 추가 기준선 3경로(R 1·T 2)를 더한 초기 상태별 수. */
const M0_06_STATUS_COUNTS = {
  ...GREEN_STATUS_COUNTS,
  active: GREEN_STATUS_COUNTS.active + 1,
  "preserved-unported": GREEN_STATUS_COUNTS["preserved-unported"] + 2,
};
const appendLine = (repo, rel, line) =>
  write(repo, rel, Buffer.concat([read(repo, rel), Buffer.from(line, "utf8")]));

test("m0-06 은 m0-05 에 신규 spec 1(누적 14)·base config 1·격리 수정 시험 1(승인 8)만 더하고 전환 13·그 밖 규칙은 같으며 과거 단계로 새지 않는다", () => {
  const { newFiles: priorFiles, approvedChanges: priorChanges, ...priorRules } = STAGES["m0-05"];
  const { newFiles, approvedChanges, ...rules } = STAGES["m0-06"];
  // contractReplaced·frozen·manifest·lock·lifecycle·importers 는 m0-05 와 같은 값이다.
  assert.deepEqual(rules, priorRules);
  assert.deepEqual(rules.contractReplaced, [...CONTRACT_REPLACED, ...SHELL]);
  assert.equal(rules.contractReplaced.length, 13);
  assert.deepEqual(newFiles, [...priorFiles, ...M0_06_FILES]);
  assert.equal(new Set(newFiles).size, 14);
  assert.deepEqual(approvedChanges, [...priorChanges, BASE_CONFIG, ISOLATED_TEST]);
  assert.equal(new Set(approvedChanges).size, 8);
  assert.ok(
    [STAGES["m0-06"], newFiles, approvedChanges, rules.contractReplaced].every((value) =>
      Object.isFrozen(value),
    ),
  );
  // m0-05 의 목록은 그대로다(13·6·13).
  assert.deepEqual(
    [priorFiles.length, priorChanges.length, priorRules.contractReplaced.length],
    [13, 6, 13],
  );
  // 새 경로·격리 시험은 과거 단계 어디에도 없고(m0-final-commands 는 m0-06 을 그대로 잇는다),
  // derived config·형제 시험은 m0-06 이후 단계에도 없다.
  for (const stage of Object.keys(STAGES)) {
    const {
      newFiles: files,
      approvedChanges: changes = [],
      contractReplaced: replaced = [],
    } = STAGES[stage];
    const listed = [...files, ...changes, ...replaced];
    for (const rel of [...DERIVED_CONFIGS, SIBLING_TEST]) {
      assert.ok(!listed.includes(rel), `${stage}: ${rel}`);
    }
    if (stage === "m0-06" || stage === FINAL) continue;
    for (const rel of [...M0_06_FILES, BASE_CONFIG, ISOLATED_TEST]) {
      assert.ok(!listed.includes(rel), `${stage}: ${rel}`);
    }
  }
});

test("base config 변경은 m0-06(명시)·기본 GREEN·예외 보고, 명시 m0-05 는 검사 3·4 RED, 삭제는 m0-06(명시)·기본에서도 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  // spec 이 아직 없어도 된다 — 허용 경로일 뿐 존재를 강제하지 않는다.
  assertGreen(repo, "m0-06");
  const original = read(repo, BASE_CONFIG);
  appendLine(repo, BASE_CONFIG, "// m0-06 변경\n");
  const explicit = check(repo, "m0-06");
  assertDefaultLike(repo, explicit);
  assert.deepEqual(explicit.failures, []);
  assert.deepEqual(explicit.summary.approvedChanged, [BASE_CONFIG]);
  assert.deepEqual(explicit.summary.statusCounts, M0_06_STATUS_COUNTS);
  assert.ok(
    linesOf(formatReport(explicit)).includes(`승인된 단계 예외(바이트 상이): ${BASE_CONFIG}`),
  );
  // 정확 예외는 m0-06 에만 있다 — 명시 m0-05 에서는 검사 3(바이트)·4(동결)가 함께 잡는다.
  const strict = check(repo, "m0-05");
  assert.deepEqual(failedChecks(strict), [3, 4]);
  assert.deepEqual(linesOf(messagesOf(strict, 3)), [
    `${BASE_CONFIG}: 바이트가 기준선과 다르다(status active)`,
  ]);
  assert.deepEqual(linesOf(messagesOf(strict, 4)), [FROZEN_DIFF(1)]);
  assert.deepEqual(strict.summary.approvedChanged, []);
  // 승인 config 라도 부재는 허용하지 않는다.
  unlinkSync(fileOf(repo, BASE_CONFIG));
  for (const deleted of [check(repo, "m0-06"), runDefault(repo)]) {
    assert.deepEqual(failedChecks(deleted), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(deleted, 3)), [
      `${BASE_CONFIG}: 기준선 경로가 없다 — status 'active' 가 부재를 설명하지 못한다`,
    ]);
    assert.deepEqual(linesOf(messagesOf(deleted, 4)), [FROZEN_DIFF(1)]);
    assert.deepEqual(deleted.summary.approvedChanged, []);
  }
  const green = restore(repo, [[BASE_CONFIG, original]], "m0-06");
  assert.deepEqual(green.summary.approvedChanged, []);
  assertGreen(repo, "m0-05");
});

test("base config 예외는 같은 디렉터리 derived config 로 번지지 않는다 — 변경은 m0-06(명시)·기본에서도 검사 3·4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  for (const rel of DERIVED_CONFIGS) {
    const original = read(repo, rel);
    appendLine(repo, rel, "// m0-06 변경\n");
    for (const red of [check(repo, "m0-06"), runDefault(repo)]) {
      assert.deepEqual(failedChecks(red), [3, 4], rel);
      assert.deepEqual(linesOf(messagesOf(red, 3)), [
        `${rel}: 바이트가 기준선과 다르다(status preserved-unported)`,
      ]);
      assert.deepEqual(linesOf(messagesOf(red, 4)), [FROZEN_DIFF(1)]);
      assert.deepEqual(red.summary.approvedChanged, []);
    }
    write(repo, rel, original);
    assertGreen(repo, "m0-06");
  }
});

test("E2E 신규 spec 은 m0-06(명시)·기본 GREEN·명시 m0-05 검사 5 RED, 유사 이름·14 밖 신규 파일은 m0-06 검사 5 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  for (const rel of M0_06_FILES) write(repo, rel, "// m0-06 모의 spec\n");
  const green = assertGreen(repo, "m0-06");
  assertDefaultLike(repo, green);
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...M0_06_FILES].sort());
  const strict = check(repo, "m0-05");
  assert.deepEqual(failedChecks(strict), [5]);
  assert.deepEqual(
    linesOf(messagesOf(strict, 5)),
    M0_06_FILES.map((rel) => `${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`),
  );
  // 이름이 비슷하거나 위치·확장자만 다른 파일도 14개 allowlist 밖이면 m0-06 에서 거부한다.
  for (const outside of [
    "apps/web/e2e/m0-06-shell-api.extra.spec.ts",
    "apps/web/e2e/m0-06-shell-api.spec.tsx",
    "apps/web/e2e/support/m0-06-shell-api.spec.ts",
    "apps/web/playwright.config.local.ts",
  ]) {
    write(repo, outside, "// 승인 밖\n");
    const red = check(repo, "m0-06");
    assert.deepEqual(failedChecks(red), [5], outside);
    assert.deepEqual(linesOf(messagesOf(red, 5)), [
      `${outside}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
    ]);
    unlinkSync(fileOf(repo, outside));
  }
  for (const rel of M0_06_FILES) unlinkSync(fileOf(repo, rel));
  assertGreen(repo, "m0-06");
});

test("인자 없는 CLI·--stage m0-final-commands·--stage=m0-final-commands 는 같은 단계·같은 출력이고, 명시 m0-06·m0-05 는 그 단계로 표기된다", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  const cli = (args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: repo.root, encoding: "utf8" });
  const [byDefault, ...explicit] = [[], ["--stage", FINAL], [`--stage=${FINAL}`]].map(cli);
  // 합성 cwd 는 고정 기준선과 달라 실패하지만, 세 형태의 단계·출력·종료 코드는 같아야 한다.
  assert.equal(byDefault.status, 1);
  assert.match(byDefault.stdout, /^rebuild-bootstrap · stage m0-final-commands · /m);
  for (const run of explicit) {
    assert.equal(run.status, byDefault.status);
    assert.equal(run.stdout, byDefault.stdout);
    assert.equal(run.stderr, byDefault.stderr);
  }
  for (const stage of ["m0-06", "m0-05"]) {
    const prior = cli([`--stage=${stage}`]);
    assert.match(prior.stdout, new RegExp(`^rebuild-bootstrap · stage ${stage} · `, "m"));
    assert.doesNotMatch(prior.stdout, /stage m0-final-commands/);
  }
});

test("m0-06 전용 변경(base config 변경·신규 spec)은 명시 m0-05·m0-04·m0-02a·m0-03·m0-01 에서 해당 검사 RED", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  const original = read(repo, BASE_CONFIG);
  appendLine(repo, BASE_CONFIG, "// m0-06 변경\n");
  for (const rel of M0_06_FILES) write(repo, rel, "// m0-06 모의 spec\n");
  assertGreen(repo, "m0-06");
  for (const stage of ["m0-05", "m0-04", "m0-02a", "m0-03", "m0-01"]) {
    const red = check(repo, stage);
    assert.equal(red.ok, false, stage);
    assert.deepEqual(failedChecks(red), [3, 4, 5], stage);
    assert.deepEqual(linesOf(messagesOf(red, 3)), [
      `${BASE_CONFIG}: 바이트가 기준선과 다르다(status active)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [FROZEN_DIFF(1)]);
    assert.deepEqual(linesOf(messagesOf(red, 5)), [
      `${M0_06_FILES[0]}: 기준선 밖 파일이 이 단계 allowlist 에 없다`,
    ]);
  }
  for (const rel of M0_06_FILES) unlinkSync(fileOf(repo, rel));
  restore(repo, [[BASE_CONFIG, original]], "m0-06");
});

test("API 6 + 셸 7 전환·seed·verify 2·base config 변경·신규 4 전체 후보는 m0-06(명시)·기본 GREEN·행 수·두 digest 유지, 과거 단계는 RED", (t) => {
  const repo = makeRepo(t, M0_06_BASELINE);
  const replaced = [...CONTRACT_REPLACED, ...SHELL];
  const changed = [SEED, ...VERIFY, BASE_CONFIG];
  const added = [...M0_04_FILES, ...M0_05_FILES, ...M0_06_FILES];
  const originals = [...replaced, ...changed].map((rel) => [rel, read(repo, rel)]);
  for (const rel of replaced) rewrite(repo, rel);
  for (const rel of changed) appendLine(repo, rel, "// m0-06 변경\n");
  for (const rel of added) write(repo, rel, "// 모의 신규 파일\n");
  const edited = writeLedgerWith(repo, Object.fromEntries(replaced.map((rel) => [rel, REPLACED])));
  // 전환은 상태 필드만 바꾼다 — 행 수·내용 digest·분류 digest 는 기준선 그대로다.
  assert.equal(edited.rows.length, repo.expected.rows);
  assert.equal(digestOf(edited.rows), repo.expected.digest);
  assert.equal(digestOf(edited.rows, TYPE_LINE), repo.expected.typeDigest);
  const green = assertGreen(repo, "m0-06");
  assertDefaultLike(repo, green);
  assert.deepEqual([...green.summary.contractReplaced].sort(), [...replaced].sort());
  assert.deepEqual([...green.summary.approvedChanged].sort(), [...changed].sort());
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...added].sort());
  assert.deepEqual(green.summary.statusCounts, {
    ...M0_06_STATUS_COUNTS,
    "pending-replacement": M0_06_STATUS_COUNTS["pending-replacement"] - replaced.length,
    "contract-replaced": replaced.length,
  });
  for (const stage of ["m0-05", "m0-04", "m0-02a", "m0-03", "m0-01"]) {
    assert.deepEqual(failedChecks(check(repo, stage)), [3, 4, 5], stage);
  }
  for (const rel of added) unlinkSync(fileOf(repo, rel));
  restore(repo, originals, "m0-06");
});

/** 격리 예외 반례 전용 추가 기준선: 정확 예외 T 시험 1과 같은 디렉터리의 형제 T 시험 1. */
const ISOLATION_BASELINE = {
  [ISOLATED_TEST]: ["T", 'describe("S2 actual cardio program persistence", () => {});\n'],
  [SIBLING_TEST]: ["T", 'describe("CORS", () => {});\n'],
};
const ISOLATION_STATUS_COUNTS = {
  ...GREEN_STATUS_COUNTS,
  "preserved-unported": GREEN_STATUS_COUNTS["preserved-unported"] + 2,
};

test("격리 수정 시험(cardio-program.spec) 바이트 변경은 m0-06(명시)·기본 GREEN·예외 보고, 과거 단계는 검사 3·4 RED, 삭제는 m0-06 에서도 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t, ISOLATION_BASELINE);
  assertGreen(repo, "m0-06");
  const original = read(repo, ISOLATED_TEST);
  appendLine(repo, ISOLATED_TEST, "// afterAll 종료 정리\n");
  const explicit = check(repo, "m0-06");
  assertDefaultLike(repo, explicit);
  assert.deepEqual(explicit.failures, []);
  assert.deepEqual(explicit.summary.approvedChanged, [ISOLATED_TEST]);
  // 상태는 그대로 preserved-unported 다 — 이관·ported 로 세지 않는다.
  assert.deepEqual(explicit.summary.statusCounts, ISOLATION_STATUS_COUNTS);
  assert.ok(
    linesOf(formatReport(explicit)).includes(`승인된 단계 예외(바이트 상이): ${ISOLATED_TEST}`),
  );
  // 정확 예외는 m0-06 에만 있다 — 과거 단계에서는 검사 3(바이트)·4(동결)가 함께 잡는다.
  for (const stage of ["m0-05", "m0-04", "m0-02a", "m0-03", "m0-01"]) {
    const strict = check(repo, stage);
    assert.deepEqual(failedChecks(strict), [3, 4], stage);
    assert.deepEqual(linesOf(messagesOf(strict, 3)), [
      `${ISOLATED_TEST}: 바이트가 기준선과 다르다(status preserved-unported)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(strict, 4)), [FROZEN_DIFF(1)]);
  }
  // 승인 경로라도 부재는 허용하지 않는다.
  unlinkSync(fileOf(repo, ISOLATED_TEST));
  for (const deleted of [check(repo, "m0-06"), runDefault(repo)]) {
    assert.deepEqual(failedChecks(deleted), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(deleted, 3)), [
      `${ISOLATED_TEST}: 기준선 경로가 없다 — status 'preserved-unported' 가 부재를 설명하지 못한다`,
    ]);
    assert.deepEqual(linesOf(messagesOf(deleted, 4)), [FROZEN_DIFF(1)]);
  }
  const green = restore(repo, [[ISOLATED_TEST, original]], "m0-06");
  assert.deepEqual(green.summary.approvedChanged, []);
  assertGreen(repo, "m0-05");
});

test("격리 예외는 형제 T 시험(cors.spec)으로 번지지 않고, 그 행을 ported·contract-replaced 로 바꾸면 m0-06 에서도 검사 4 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t, ISOLATION_BASELINE);
  const siblingOriginal = read(repo, SIBLING_TEST);
  appendLine(repo, SIBLING_TEST, "// 형제 변경\n");
  for (const red of [check(repo, "m0-06"), runDefault(repo)]) {
    assert.deepEqual(failedChecks(red), [3, 4]);
    assert.deepEqual(linesOf(messagesOf(red, 3)), [
      `${SIBLING_TEST}: 바이트가 기준선과 다르다(status preserved-unported)`,
    ]);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [FROZEN_DIFF(1)]);
    assert.deepEqual(red.summary.approvedChanged, []);
  }
  write(repo, SIBLING_TEST, siblingOriginal);
  assertGreen(repo, "m0-06");
  // 정확 예외는 바이트 예외일 뿐이다 — 그 행의 상태 전환은 전환 목록 밖이라 허용하지 않는다.
  const original = read(repo, ISOLATED_TEST);
  appendLine(repo, ISOLATED_TEST, "// afterAll 종료 정리\n");
  for (const status of ["ported", "contract-replaced"]) {
    writeLedgerWith(repo, { [ISOLATED_TEST]: { status, ...REFS } });
    const red = check(repo, "m0-06");
    assert.deepEqual(failedChecks(red), [4], status);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [
      `${ISOLATED_TEST}: 이 단계에서는 초기 상태 'preserved-unported' 만 허용한다('${status}')`,
    ]);
  }
  restore(repo, [[ISOLATED_TEST, original]], "m0-06");
});

const FINAL_FILES = ["scripts/ci-m0.mjs", "scripts/ci-m0.test.mjs"];
const NOT_ALLOWED_SCRIPT = (name) => `scripts.${name} 은 이 단계에서 허용한 추가가 아니다`;
const MISSING_SCRIPT = (name) => `scripts.${name} = "${FINAL_SCRIPTS[name]}" 가 없다`;
const OUTSIDE = (rel) => `${rel}: 기준선 밖 파일이 이 단계 allowlist 에 없다`;
/** 합성 manifest 에 script 를 더한다(기존 키 유지). */
function writeScripts(repo, base, scripts) {
  const manifest = JSON.parse(base.toString("utf8"));
  manifest.scripts = { ...manifest.scripts, ...scripts };
  write(repo, "package.json", json(manifest));
}

test("m0-final-commands 는 m0-06 에 root 명령 2파일(누적 16)·script 2키(3)만 더하고 승인 8·전환 13·그 밖 규칙은 같으며 과거 단계로 새지 않는다", () => {
  const { newFiles: priorFiles, scriptAdditions: priorScripts, ...priorRules } = STAGES["m0-06"];
  const { newFiles, scriptAdditions, ...rules } = STAGES[FINAL];
  // approvedChanges·contractReplaced·frozen·manifest·lock·lifecycle·importers 는 m0-06 과 같은 값이다.
  assert.deepEqual(rules, priorRules);
  assert.equal(new Set(rules.approvedChanges).size, 8);
  assert.equal(rules.contractReplaced.length, 13);
  assert.deepEqual(newFiles, [...priorFiles, ...FINAL_FILES]);
  assert.equal(new Set(newFiles).size, 16);
  assert.deepEqual(priorScripts, { "ci:bootstrap": "node scripts/rebuild-bootstrap.mjs" });
  assert.deepEqual(scriptAdditions, { ...priorScripts, ...FINAL_SCRIPTS });
  assert.deepEqual(Object.keys(scriptAdditions), ["ci:bootstrap", "ci:m0", "ci:product"]);
  assert.ok([STAGES[FINAL], newFiles, scriptAdditions].every((value) => Object.isFrozen(value)));
  // m0-06 의 목록은 그대로(14·8·13)이고, docs 경로 예외는 이 단계에도 없다.
  assert.deepEqual(
    [priorFiles.length, priorRules.approvedChanges.length, priorRules.contractReplaced.length],
    [14, 8, 13],
  );
  assert.ok(
    ![...newFiles, ...rules.approvedChanges, ...rules.contractReplaced].some((rel) =>
      rel.startsWith("docs/"),
    ),
  );
  // root 명령 파일·script 는 과거 단계 어디에도 없다.
  for (const stage of Object.keys(STAGES)) {
    if (stage === FINAL) continue;
    const {
      newFiles: files,
      approvedChanges: changes = [],
      contractReplaced: replaced = [],
      scriptAdditions: scripts,
    } = STAGES[stage];
    for (const rel of FINAL_FILES) {
      assert.ok(![...files, ...changes, ...replaced].includes(rel), `${stage}: ${rel}`);
    }
    assert.deepEqual(Object.keys(scripts), ["ci:bootstrap"], stage);
  }
});

test("root 명령 script 2키는 m0-final-commands(명시·기본) GREEN 이고, 하나라도 없거나 다르거나 그 밖 script 를 더하면 검사 4 RED, 명시 m0-06 은 두 키를 거부한다", (t) => {
  const repo = makeRepo(t);
  const original = read(repo, "package.json");
  // ci:bootstrap 만 있는 manifest: 새 단계(명시·기본)는 두 키가 없다고 검사 4 RED 다.
  for (const red of [check(repo, FINAL), runChecks({ root: repo.root, expected: repo.expected })]) {
    assert.deepEqual(failedChecks(red), [4]);
    assert.deepEqual(linesOf(messagesOf(red, 4)), [
      MISSING_SCRIPT("ci:m0"),
      MISSING_SCRIPT("ci:product"),
    ]);
  }
  writeScripts(repo, original, FINAL_SCRIPTS);
  const green = assertGreen(repo, FINAL);
  assert.deepEqual(runChecks({ root: repo.root, expected: repo.expected }), green);
  // 정확한 등록이라도 명시 m0-06 에서는 허용한 추가가 아니다.
  const strict = check(repo, "m0-06");
  assert.deepEqual(failedChecks(strict), [4]);
  assert.deepEqual(linesOf(messagesOf(strict, 4)), [
    NOT_ALLOWED_SCRIPT("ci:m0"),
    NOT_ALLOWED_SCRIPT("ci:product"),
  ]);
  for (const [label, scripts, messages] of [
    [
      "ci:m0 명령 변경(skip 옵션)",
      { ...FINAL_SCRIPTS, "ci:m0": "node scripts/ci-m0.mjs --skip-db" },
      [NOT_ALLOWED_SCRIPT("ci:m0"), MISSING_SCRIPT("ci:m0")],
    ],
    [
      "ci:product 를 ci:m0 와 같은 명령으로",
      { ...FINAL_SCRIPTS, "ci:product": "node scripts/ci-m0.mjs" },
      [NOT_ALLOWED_SCRIPT("ci:product"), MISSING_SCRIPT("ci:product")],
    ],
    ["ci:product 누락", { "ci:m0": FINAL_SCRIPTS["ci:m0"] }, [MISSING_SCRIPT("ci:product")]],
    [
      "미등록 script 추가(합성 manifest)",
      { ...FINAL_SCRIPTS, "ci:m0:partial": "node scripts/ci-m0.mjs --partial" },
      [NOT_ALLOWED_SCRIPT("ci:m0:partial")],
    ],
    [
      "유사 이름 script",
      { ...FINAL_SCRIPTS, "ci:m0-fast": "node scripts/ci-m0.mjs" },
      [NOT_ALLOWED_SCRIPT("ci:m0-fast")],
    ],
  ]) {
    writeScripts(repo, original, scripts);
    const red = check(repo, FINAL);
    assert.deepEqual(failedChecks(red), [4], label);
    assert.deepEqual(linesOf(messagesOf(red, 4)), messages, label);
  }
  write(repo, "package.json", original);
  assertGreen(repo, "m0-06");
});

test("root 명령 2파일은 m0-final-commands(명시·기본) GREEN·명시 m0-06 검사 5 RED, 유사 이름·16 밖 신규 파일은 검사 5 RED, 원상은 GREEN", (t) => {
  const repo = makeRepo(t);
  for (const rel of FINAL_FILES) write(repo, rel, "// root 명령 모의 파일\n");
  const green = checkWithRootScripts(repo, FINAL);
  assert.deepEqual(green.failures, []);
  assert.equal(green.ok, true);
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...FINAL_FILES].sort());
  assert.deepEqual(runDefault(repo), green);
  const strict = check(repo, "m0-06");
  assert.deepEqual(failedChecks(strict), [5]);
  assert.deepEqual(linesOf(messagesOf(strict, 5)), [...FINAL_FILES].sort().map(OUTSIDE));
  // 이름이 비슷하거나 위치·확장자만 다른 파일도 16개 allowlist 밖이면 새 단계에서 거부한다.
  for (const outside of [
    "scripts/ci-m0.extra.mjs",
    "scripts/ci-m0.test.extra.mjs",
    "scripts/ci-m0.mts",
    "scripts/ci-m1.mjs",
    "scripts/ci/ci-m0.mjs",
    "scripts/ci-product.mjs",
  ]) {
    write(repo, outside, "// 승인 밖\n");
    const red = checkWithRootScripts(repo, FINAL);
    assert.deepEqual(failedChecks(red), [5], outside);
    assert.deepEqual(linesOf(messagesOf(red, 5)), [OUTSIDE(outside)]);
    unlinkSync(fileOf(repo, outside));
  }
  for (const rel of FINAL_FILES) unlinkSync(fileOf(repo, rel));
  assert.deepEqual(checkWithRootScripts(repo, FINAL).failures, []);
  assertGreen(repo, "m0-06");
});

test("m0-final-commands 전용 변경(root 명령 2파일·script 2키)은 명시 m0-06·m0-05·m0-04·m0-02a·m0-03·m0-01 에서 검사 4·5 RED", (t) => {
  const repo = makeRepo(t);
  const original = read(repo, "package.json");
  writeScripts(repo, original, FINAL_SCRIPTS);
  for (const rel of FINAL_FILES) write(repo, rel, "// root 명령 모의 파일\n");
  assertGreen(repo, FINAL);
  for (const stage of ["m0-06", "m0-05", "m0-04", "m0-02a", "m0-03", "m0-01"]) {
    const red = check(repo, stage);
    assert.equal(red.ok, false, stage);
    assert.deepEqual(failedChecks(red), [4, 5], stage);
    assert.deepEqual(
      linesOf(messagesOf(red, 4)),
      [NOT_ALLOWED_SCRIPT("ci:m0"), NOT_ALLOWED_SCRIPT("ci:product")],
      stage,
    );
    assert.deepEqual(linesOf(messagesOf(red, 5)), [...FINAL_FILES].sort().map(OUTSIDE), stage);
  }
  for (const rel of FINAL_FILES) unlinkSync(fileOf(repo, rel));
  write(repo, "package.json", original);
  assertGreen(repo, "m0-06");
});

test("m0-06 전체 후보 + root 명령 2파일·script 2키는 m0-final-commands(명시·기본) GREEN·행 수·두 digest 유지, 과거 단계는 RED", (t) => {
  const repo = makeRepo(t, { ...M0_06_BASELINE, ...ISOLATION_BASELINE });
  const replaced = [...CONTRACT_REPLACED, ...SHELL];
  const changed = [SEED, ...VERIFY, BASE_CONFIG, ISOLATED_TEST];
  const added = [...M0_04_FILES, ...M0_05_FILES, ...M0_06_FILES, ...FINAL_FILES];
  const originals = [...replaced, ...changed, "package.json"].map((rel) => [rel, read(repo, rel)]);
  for (const rel of replaced) rewrite(repo, rel);
  for (const rel of changed) appendLine(repo, rel, "// m0-final-commands 변경\n");
  for (const rel of added) write(repo, rel, "// 모의 신규 파일\n");
  writeScripts(repo, read(repo, "package.json"), FINAL_SCRIPTS);
  const edited = writeLedgerWith(repo, Object.fromEntries(replaced.map((rel) => [rel, REPLACED])));
  // 전환은 상태 필드만 바꾼다 — 행 수·내용 digest·분류 digest 는 기준선 그대로다.
  assert.equal(edited.rows.length, repo.expected.rows);
  assert.equal(digestOf(edited.rows), repo.expected.digest);
  assert.equal(digestOf(edited.rows, TYPE_LINE), repo.expected.typeDigest);
  const green = assertGreen(repo, FINAL);
  assert.deepEqual(runChecks({ root: repo.root, expected: repo.expected }), green);
  assert.deepEqual([...green.summary.contractReplaced].sort(), [...replaced].sort());
  assert.deepEqual([...green.summary.approvedChanged].sort(), [...changed].sort());
  assert.deepEqual(green.summary.newFiles, [LEDGER_PATH, ...added].sort());
  assert.deepEqual(green.summary.statusCounts, {
    ...GREEN_STATUS_COUNTS,
    active: GREEN_STATUS_COUNTS.active + 1,
    "preserved-unported": GREEN_STATUS_COUNTS["preserved-unported"] + 4,
    "pending-replacement": GREEN_STATUS_COUNTS["pending-replacement"] - replaced.length,
    "contract-replaced": replaced.length,
  });
  // 명시 m0-06 은 root 명령(script 2·파일 2)만 거부하고, 그 이전 단계는 m0-06 변경까지 함께 거부한다.
  const strict = check(repo, "m0-06");
  assert.deepEqual(failedChecks(strict), [4, 5]);
  assert.deepEqual(linesOf(messagesOf(strict, 4)), [
    NOT_ALLOWED_SCRIPT("ci:m0"),
    NOT_ALLOWED_SCRIPT("ci:product"),
  ]);
  assert.deepEqual(linesOf(messagesOf(strict, 5)), [...FINAL_FILES].sort().map(OUTSIDE));
  for (const stage of ["m0-05", "m0-04", "m0-02a", "m0-03", "m0-01"]) {
    assert.deepEqual(failedChecks(check(repo, stage)), [3, 4, 5], stage);
  }
  for (const rel of added) unlinkSync(fileOf(repo, rel));
  restore(repo, originals, "m0-06");
});

test("lockImporters 는 v9 importers 의 specifier 만 읽고 다른 형식은 거부한다", () => {
  const importers = lockImporters(LOCK);
  assert.deepEqual([...importers.keys()], [".", "apps/api", "apps/web", "packages/shared"]);
  assert.equal(importers.get(".").get("devDependencies:prettier"), "3.9.6");
  assert.equal(importers.get("apps/api").get("dependencies:shared"), "workspace:*");
  assert.equal(importers.get("packages/shared").get("devDependencies:typescript"), "5.9.3");
  assert.throws(() => lockImporters(LOCK.replace("'9.0'", "'6.0'")), /9\.0/);
  assert.throws(() => lockImporters(LOCK.replace("importers:", "dependencies:")), /importers/);
});
