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

/** 합성 기준선: m0-01 규칙이 읽는 경로(manifest 4·lock·lifecycle 입력)와 유형별 대표 파일. */
const BASELINE_FILES = {
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
  "apps/web/scripts/add-generated-banner.mjs": ["R", "// 생성물 배너 원문\n"],
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

/** 기준선 commit + 미니 ledger + m0-01 의 허용 변경(ci:bootstrap 추가)을 갖춘 합성 후보. */
function makeRepo(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  t.after(() => removeTemp(root));
  const repo = { root };
  git(root, ["init", "-q"]);
  git(root, ["config", "core.autocrlf", "false"]);
  for (const [rel, [, text]] of Object.entries(BASELINE_FILES)) write(repo, rel, text);
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
  const rows = Object.entries(BASELINE_FILES).map(([rel, [type]]) => ({
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
    typeDigest: FIXTURE_TYPE_DIGEST,
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
const failedChecks = (result) => [...new Set(result.failures.map((f) => f.check))].sort();
const messagesOf = (result, number) =>
  result.failures
    .filter((failure) => failure.check === number)
    .map((failure) => failure.message)
    .join("\n");

function assertGreen(repo) {
  const result = check(repo);
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
function redThenGreen(repo, rel, mutate, expectedChecks, pattern) {
  const original = read(repo, rel);
  mutate();
  const red = check(repo);
  assert.equal(red.ok, false);
  assert.deepEqual(failedChecks(red), expectedChecks);
  assert.match(red.failures.map((failure) => failure.message).join("\n"), pattern);
  write(repo, rel, original);
  assertGreen(repo);
}

const GREEN_STATUS_COUNTS = {
  active: 11,
  "pending-replacement": 2,
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

test("m0-03 합성 후보는 명시 m0-03·기본 단계 GREEN, 같은 대상의 명시 m0-01 은 검사 5 RED", (t) => {
  const repo = makeRepo(t);
  for (const rel of M0_03_FILES) write(repo, rel, "// m0-03 모의 파일\n");
  const explicit = check(repo, "m0-03");
  const byDefault = runChecks({ root: repo.root, expected: repo.expected });
  for (const result of [explicit, byDefault]) {
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(result.summary.stage, "m0-03");
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

test("기본 단계는 m0-03 이다 — parseArgs·runChecks·인자 없는 CLI 가 같은 단계를 쓴다", (t) => {
  assert.deepEqual(parseArgs([]), { stage: "m0-03" });
  assert.deepEqual(parseArgs(["--stage=m0-03"]), { stage: "m0-03" });
  assert.deepEqual(parseArgs(["--stage", "m0-01"]), { stage: "m0-01" });
  assert.deepEqual(Object.keys(STAGES), ["m0-01", "m0-03"]);
  // m0-03 은 신규 파일만 누적한다 — 그 밖 보호 규칙은 m0-01 과 같은 값이다.
  const { newFiles: strictFiles, ...strictRules } = STAGES["m0-01"];
  const { newFiles, ...rules } = STAGES["m0-03"];
  assert.deepEqual(rules, strictRules);
  assert.deepEqual(newFiles, [...strictFiles, ...M0_03_FILES]);
  assert.ok(
    Object.isFrozen(STAGES) && Object.isFrozen(STAGES["m0-03"]) && Object.isFrozen(newFiles),
  );

  // 인자 없는 CLI 도 m0-03 을 검사한다(합성 cwd 는 고정 기준선과 달라 실패하지만 단계 표기로 확인).
  const repo = makeRepo(t);
  const run = spawnSync(process.execPath, [CLI], { cwd: repo.root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^rebuild-bootstrap · stage m0-03 · /m);
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
