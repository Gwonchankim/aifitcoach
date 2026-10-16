/**
 * rebuild-fixtures 검사의 RED/GREEN 반례. 전부 os.tmpdir() 아래 합성 원천·합성 ledger 에서만 돈다 —
 * 이 저장소의 docs/specs 원천·ledger 는 읽지도 쓰지도 않는다.
 *
 *   node --test scripts/rebuild-fixtures.test.mjs
 *
 * 기대값(ID 집합·필수 키·버전·원문 hash)은 변조 전 합성 정의에서 이 파일이 따로 계산한다(검사 본체의
 * 함수를 빌리지 않는다). 구조 반례는 hash 기대값을 변조 뒤 바이트로 맞춰 **그 구조 규칙으로** RED 인지
 * 단언하고, 원문 hash 반례는 구조를 유지한 변경으로 따로 단언한다. 각 RED 는 원상 GREEN 과 짝을 이룬다.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import {
  FIXTURES,
  REQUIRED_EXPECT_KEYS,
  formatReport,
  trustedHashes,
  validateFixtures,
} from "./rebuild-fixtures.mjs";

const CLI = fileURLToPath(new URL("./rebuild-fixtures.mjs", import.meta.url));
const TEMP_PREFIX = "afc-rebuild-fixtures-";
/** 티켓의 필수 expect 키 계열: weight·reps_low·reason_code(_in)·e1rm. */
const REQUIRED = ["weight", "reps_low", "reason_code", "reason_code_in", "e1rm", "e1rm_tolerance"];

const GOLDEN = "docs/specs/golden_tests.json";
const CARDIO = "docs/specs/cardio_baseline_golden.json";
const SEED = "docs/specs/exercises_seed.json";
const CONTRACT = "docs/specs/feature_improvements_contract.json";
const TUTORIAL = "docs/specs/tutorial_program_rir.json";
const M4 = "docs/specs/m4_aggregation_fixture.json";
const OPENAPI = "docs/specs/openapi.yaml";
const FEATURE_OPENAPI = "docs/specs/feature-improvements.openapi.yaml";

/** 합성 원천(실제 원천과 같은 구조의 축소판). GC 번호 결번·override 버전 둘·witness 승인/보류를 포함한다. */
const SOURCES = {
  [GOLDEN]: {
    rules_version: "2026.08.1",
    defaults: { e1rm_tolerance: 0.5 },
    cases: [
      { id: "GC-01", input: {}, expect: { weight: 62.5, reps_low: 8, reason_code: "WEIGHT_UP" } },
      {
        id: "GC-03",
        rules_version: "2026.09.0",
        input: {},
        expect: { reason_code: "LOAD_CALIBRATION_NEEDED", note: "v2" },
      },
      { id: "GC-04", input: {}, expect: { e1rm: 120, e1rm_tolerance: 0.5 } },
      {
        id: "GC-07",
        rules_version: "2026.08.2",
        input: {},
        expect: { reason_code_in: ["A", "B"], note: "결번 다음 번호" },
      },
    ],
  },
  [CARDIO]: {
    policy_inputs: {
      minutes: [30],
      composition: {},
      doses: {},
      intervalRounds: [6],
      cap: [8],
      dayOffsets: {},
      focuses: {},
      witness: {},
    },
    cases: [{ id: "diet-2-30-a" }, { id: "diet-4-30-b" }, { id: "endurance-5-90-c" }],
    explicit_witness_infeasible: [
      { id: "diet-4-30-b", reasons: ["insufficient_time_for_mixed_focus"], approved: true },
      { id: "endurance-5-90-c", reasons: ["redesign"], approved: false, deferred_to: "PLAN-02" },
    ],
  },
  [SEED]: {
    exercises: [
      { id: "e_a", substitutions: ["e_b"] },
      { id: "e_b", substitutions: ["e_a"] },
      { id: "e_solo", substitutions: [] },
    ],
  },
  [CONTRACT]: {
    composition: [{ goal: "diet", days: 2, legacy: "HH", revised: "HH" }],
    preferences: [
      {
        days: 4,
        preference: "balanced",
        focus: ["upper", "lower", "upper", "lower"],
        day_offsets: [0, 1, 3, 4],
        expected_counts: [2, 2],
      },
    ],
    recovery_counterexample: {
      day_offsets: [0, 1, 3, 4],
      focus_before: ["upper", "lower", "upper", "lower"],
      swap_indices: [0, 3],
      focus_after: ["lower", "lower", "upper", "upper"],
    },
    invalid_preferences: [{ days: 2, preference: "upper_priority", status: 400 }],
  },
  [TUTORIAL]: { schema_version: "1.0", id: "tutorial", sessions: [] },
  [M4]: { description: "합성", sessions: [], expected: {} },
  [OPENAPI]: "openapi: 3.1.0\ninfo:\n  title: 합성\n",
  [FEATURE_OPENAPI]: "openapi: 3.1.0\ninfo:\n  title: 합성 기능\n",
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
/** 시험 쪽 독립 줄 집합 digest(본체 linesDigest 를 빌리지 않는다). */
const setDigest = (lines) =>
  sha256(
    Buffer.from(
      [...lines]
        .sort(byteOrder)
        .map((line) => `${line}\n`)
        .join(""),
      "utf8",
    ),
  );
const idsOf = (list) => ({ count: list.length, digest: setDigest(list) });

/** 변조 전 합성 정의에서 고정한 기대값 — 시험 도중 다시 계산하지 않는다. */
const EXPECTED = (() => {
  const golden = SOURCES[GOLDEN];
  const witnesses = SOURCES[CARDIO].explicit_witness_infeasible;
  return {
    [GOLDEN]: {
      kind: "golden",
      ids: idsOf(golden.cases.map((item) => item.id)),
      expectKeys: setDigest(
        golden.cases.map(
          (item) =>
            `${item.id}\t${Object.keys(item.expect)
              .filter((key) => REQUIRED.includes(key))
              .sort()
              .join(",")}`,
        ),
      ),
      rulesVersion: golden.rules_version,
      overrides: idsOf(
        golden.cases
          .filter((item) => item.rules_version)
          .map((item) => `${item.id}\t${item.rules_version}`),
      ),
    },
    [CARDIO]: {
      kind: "cardio",
      ids: idsOf(SOURCES[CARDIO].cases.map((item) => item.id)),
      witnesses: {
        count: witnesses.length,
        approved: witnesses.filter((item) => item.approved === true).length,
        deferred: witnesses.filter((item) => item.approved === false).length,
        digest: setDigest(witnesses.map((item) => `${item.id}\t${item.approved}`)),
      },
      policyInputs: Object.keys(SOURCES[CARDIO].policy_inputs),
    },
    [SEED]: { kind: "exercises", ids: idsOf(SOURCES[SEED].exercises.map((item) => item.id)) },
    [CONTRACT]: { kind: "contract" },
    [TUTORIAL]: { kind: "keys", keys: Object.keys(SOURCES[TUTORIAL]) },
    [M4]: { kind: "keys", keys: Object.keys(SOURCES[M4]) },
    [OPENAPI]: { kind: "bytes" },
    [FEATURE_OPENAPI]: { kind: "bytes" },
  };
})();

const fileOf = (fx, rel) => path.join(fx.root, ...rel.split("/"));
const read = (fx, rel) => readFileSync(fileOf(fx, rel));
function write(fx, rel, content) {
  mkdirSync(path.dirname(fileOf(fx, rel)), { recursive: true });
  writeFileSync(fileOf(fx, rel), content);
}

/** 지정한 임시 영역 안의 우리 디렉터리일 때만 지운다. */
function removeTemp(root) {
  const relative = path.relative(realpathSync(os.tmpdir()), root);
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside || !path.basename(root).startsWith(TEMP_PREFIX)) {
    throw new Error(`임시 영역 밖 경로는 지우지 않는다: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/** 합성 원천 8개를 쓰고, 변조 전 바이트의 sha256 을 원문 hash 기대값으로 고정한다. */
function makeFixtures(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  t.after(() => removeTemp(root));
  const fx = { root, hashes: {} };
  for (const [rel, value] of Object.entries(SOURCES)) {
    const bytes = Buffer.from(typeof value === "string" ? value : json(value), "utf8");
    write(fx, rel, bytes);
    fx.hashes[rel] = sha256(bytes);
  }
  return fx;
}

const validate = (fx, hashes = fx.hashes) =>
  validateFixtures({ root: fx.root, expected: EXPECTED, hashes });
const failedRules = (result) =>
  [
    ...new Set(result.results.flatMap((item) => item.failures.map((failure) => failure.rule))),
  ].sort();
const messagesOf = (result) =>
  result.results
    .flatMap((item) => item.failures.map((failure) => `[${failure.rule}] ${failure.message}`))
    .join("\n");

function assertGreen(fx) {
  const result = validate(fx);
  assert.deepEqual(
    result.results.flatMap((item) => item.failures),
    [],
  );
  assert.equal(result.ok, true);
  return result;
}

/**
 * 구조 반례: JSON 원천 하나를 바꾸고 hash 기대값을 바뀐 바이트로 맞춘다 — hash 로는 실패할 수 없으므로
 * 남은 실패는 구조 규칙의 판정이다. 원래 hash 기대값으로도 같은 구조 규칙이 hash 와 함께 실패한다.
 */
function structureRed(fx, rel, mutate, rules, pattern) {
  const original = read(fx, rel);
  const edited = JSON.parse(original.toString("utf8"));
  mutate(edited);
  const bytes = Buffer.from(json(edited), "utf8");
  write(fx, rel, bytes);
  const isolated = validate(fx, { ...fx.hashes, [rel]: sha256(bytes) });
  assert.equal(isolated.ok, false);
  assert.deepEqual(failedRules(isolated), rules);
  assert.match(messagesOf(isolated), pattern);
  assert.deepEqual(failedRules(validate(fx)), [...rules, "hash"].sort());
  write(fx, rel, original);
  assertGreen(fx);
}

test("원상 합성 원천 8개는 모든 규칙을 실제로 실행해 통과한다(GREEN 기준)", (t) => {
  const fx = makeFixtures(t);
  const result = assertGreen(fx);
  const ran = Object.fromEntries(result.results.map((item) => [item.file, item.ran]));
  assert.deepEqual(ran, {
    [GOLDEN]: ["hash", "parse", "ids", "expect-keys", "rules-version", "defaults"],
    [CARDIO]: ["hash", "parse", "ids", "witnesses", "policy-inputs"],
    [SEED]: ["hash", "parse", "ids", "dangling"],
    [CONTRACT]: ["hash", "parse", "refs"],
    [TUTORIAL]: ["hash", "parse", "keys"],
    [M4]: ["hash", "parse", "keys"],
    [OPENAPI]: ["hash"],
    [FEATURE_OPENAPI]: ["hash"],
  });
  const report = formatReport(result, { problems: [] });
  assert.match(
    report,
    /^docs\/specs\/golden_tests\.json: 통과\(hash·parse·ids·expect-keys·rules-version·defaults\)$/m,
  );
  assert.match(report, /^결과: 통과$/m);
});

test("golden ID 제거는 ids 규칙 RED(케이스별 키 digest 도 함께), 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      data.cases = data.cases.filter((item) => item.id !== "GC-04");
    },
    ["expect-keys", "ids"],
    /\[ids\] case ID 3개 — 승인 4개와 다르다/,
  );
});

test("seed ID 중복·변경은 ids 규칙만으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    SEED,
    (data) => data.exercises.push({ id: "e_solo", substitutions: [] }),
    ["ids"],
    /\[ids\] exercise ID 중복 1개: e_solo/,
  );
  // 아무도 참조하지 않는 ID 를 바꾸면 개수는 같지만 집합이 달라진다.
  structureRed(
    fx,
    SEED,
    (data) => {
      data.exercises.find((item) => item.id === "e_solo").id = "e_solo_v2";
    },
    ["ids"],
    /\[ids\] exercise ID 집합이 승인 집합과 다르다\(개수는 3개로 같다\)/,
  );
});

test("dangling substitution 주입은 dangling 규칙만으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    SEED,
    (data) => data.exercises.find((item) => item.id === "e_a").substitutions.push("e_missing"),
    ["dangling"],
    /\[dangling\] 없는 운동을 가리키는 대체 참조 1개: e_a→e_missing/,
  );
});

test("golden 필수 expect 키 제거는 expect-keys 규칙만으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      delete data.cases.find((item) => item.id === "GC-01").expect.weight;
    },
    ["expect-keys"],
    /\[expect-keys\] 케이스별 필수 expect 키가 승인 기준과 다르다\(후보 weight 0 · /,
  );
  // 다른 케이스로 키를 옮겨 키별 개수가 같아도 케이스별 digest 가 잡는다.
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      delete data.cases.find((item) => item.id === "GC-01").expect.reps_low;
      data.cases.find((item) => item.id === "GC-03").expect.reps_low = 8;
    },
    ["expect-keys"],
    /\[expect-keys\] .*reps_low 1 · /,
  );
});

test("rules_version 변조(root·케이스 override)는 rules-version 규칙만으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      data.rules_version = "2026.08.2";
    },
    ["rules-version"],
    /\[rules-version\] root rules_version 2026\.08\.2 — 승인 2026\.08\.1/,
  );
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      data.cases.find((item) => item.id === "GC-03").rules_version = "2026.08.1";
    },
    ["rules-version"],
    /\[rules-version\] 케이스 rules_version override 가 승인 기준\(2개\)과 다르다 — 후보 2026\.08\.1 1 · 2026\.08\.2 1/,
  );
  structureRed(
    fx,
    GOLDEN,
    (data) => {
      delete data.defaults.e1rm_tolerance;
    },
    ["defaults"],
    /\[defaults\] defaults\.e1rm_tolerance 가 없다/,
  );
});

test("cardio case ID·witness 분류·참조·policy_inputs 변조는 각 규칙으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    CARDIO,
    (data) => {
      data.cases = data.cases.filter((item) => item.id !== "diet-2-30-a");
    },
    ["ids"],
    /\[ids\] case ID 2개 — 승인 3개와 다르다/,
  );
  // witness 하나의 승인을 보류로 바꾸면 분류 수(approved / deferred)가 달라진다.
  structureRed(
    fx,
    CARDIO,
    (data) => {
      data.explicit_witness_infeasible[0].approved = false;
    },
    ["witnesses"],
    /\[witnesses\] infeasible witness 2개\(approved 0 \/ deferred 2\) — 승인 2개\(1 \/ 1\)/,
  );
  // 승인·보류를 맞바꾸면 분류 수(1/1)는 같아도 witness 별 분류 digest 가 잡는다.
  structureRed(
    fx,
    CARDIO,
    (data) => {
      for (const item of data.explicit_witness_infeasible) item.approved = !item.approved;
    },
    ["witnesses"],
    /\[witnesses\] witness 별 승인 분류가 승인 기준과 다르다\(분류 수는 같다\)/,
  );
  structureRed(
    fx,
    CARDIO,
    (data) => {
      data.explicit_witness_infeasible[0].id = "diet-9-99-x";
    },
    ["witnesses"],
    /\[witnesses\] cases 에 없는 witness 1개: diet-9-99-x/,
  );
  structureRed(
    fx,
    CARDIO,
    (data) => {
      delete data.policy_inputs.cap;
    },
    ["policy-inputs"],
    /\[policy-inputs\] policy_inputs 필수 키 없음: cap/,
  );
});

test("계약 내부 참조·필수 최상위 키·JSON 형식 위반은 각 규칙으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  structureRed(
    fx,
    CONTRACT,
    (data) => {
      data.recovery_counterexample.focus_after = ["upper", "lower", "upper", "lower"];
    },
    ["refs"],
    /\[refs\] recovery_counterexample\.focus_after 가 swap_indices 를 적용한 focus_before 와 다르다/,
  );
  structureRed(
    fx,
    CONTRACT,
    (data) => {
      data.preferences[0].expected_counts = [3, 1];
    },
    ["refs"],
    /\[refs\] preferences 4\/balanced: expected_counts 가 focus 의 upper·lower 수와 다르다/,
  );
  structureRed(
    fx,
    CONTRACT,
    (data) => {
      data.invalid_preferences.push({ days: 4, preference: "balanced", status: 400 });
    },
    ["refs"],
    /\[refs\] invalid_preferences 4\/balanced 가 preferences 에도 있다/,
  );
  structureRed(
    fx,
    TUTORIAL,
    (data) => {
      delete data.sessions;
    },
    ["keys"],
    /\[keys\] 필수 최상위 키 없음: sessions/,
  );
  // JSON 이 깨지면 parse 규칙으로 실패하고, 구조 규칙은 실행하지 않는다(ran 에 없다).
  const original = read(fx, M4);
  const broken = Buffer.from('{ "description": ', "utf8");
  write(fx, M4, broken);
  const red = validate(fx, { ...fx.hashes, [M4]: sha256(broken) });
  assert.deepEqual(failedRules(red), ["parse"]);
  assert.deepEqual(red.results.find((item) => item.file === M4).ran, ["hash", "parse"]);
  write(fx, M4, original);
  assertGreen(fx);
});

test("원문 hash 반례는 구조와 별도다 — 구조를 유지한 변경은 hash 규칙만으로 RED, 원상은 GREEN", (t) => {
  const fx = makeFixtures(t);
  // YAML 원천 1바이트 변경: hash 만 보는 원천.
  const yaml = read(fx, OPENAPI);
  const flipped = Buffer.from(yaml);
  flipped[0] ^= 0x01;
  write(fx, OPENAPI, flipped);
  let red = validate(fx);
  assert.deepEqual(failedRules(red), ["hash"]);
  assert.match(
    messagesOf(red),
    /\[hash\] 원문 sha256 [0-9a-f]{64} 가 기준선\(ledger F행\)과 다르다/,
  );
  write(fx, OPENAPI, yaml);
  assertGreen(fx);
  // JSON 원천의 공백만 바꾸면 구조 규칙은 모두 통과하고 hash 만 실패한다.
  const golden = read(fx, GOLDEN);
  write(fx, GOLDEN, `${JSON.stringify(SOURCES[GOLDEN], null, 4)}\n`);
  red = validate(fx);
  assert.deepEqual(failedRules(red), ["hash"]);
  write(fx, GOLDEN, golden);
  assertGreen(fx);
  // 기대 hash 가 없으면 건너뛰지 않고 실패한다(fail closed).
  const withoutOne = { ...fx.hashes };
  delete withoutOne[CONTRACT];
  red = validate(fx, withoutOne);
  assert.deepEqual(failedRules(red), ["hash"]);
  assert.match(messagesOf(red), /\[hash\] 기대 원문 hash 가 없다 — 검사를 건너뛰지 않는다/);
});

/** 시험 쪽 독립 ledger digest: 경로 바이트순 line(row) 의 SHA-256(본체 inventoryDigest 를 빌리지 않는다). */
function ledgerDigest(rows, line) {
  const sorted = [...rows].sort((a, b) => byteOrder(a.path, b.path));
  return sha256(Buffer.from(sorted.map(line).join(""), "utf8"));
}
const contentLine = (row) => `${row.path}\t${row.blob}\t${row.sha256}\n`;
const typeLine = (row) => `${row.path}\t${row.type}\n`;

/** 합성 ledger(원천 8개 F행 + 다른 유형 1행)와 그 기준선 기대값. 기대값은 변조 전 행에서 고정한다. */
function makeLedger(fx) {
  const rows = [
    ...Object.entries(fx.hashes).map(([rel, hash]) => ({
      path: rel,
      blob: "a".repeat(40),
      sha256: hash,
      type: "F",
    })),
    { path: "package.json", blob: "b".repeat(40), sha256: "c".repeat(64), type: "R" },
  ];
  write(fx, "regression/ledger.json", json({ schema: 1, rows }));
  return {
    rows,
    baseline: {
      rows: rows.length,
      digest: ledgerDigest(rows, contentLine),
      typeDigest: ledgerDigest(rows, typeLine),
    },
  };
}

test("원문 hash 기대값은 기준선 digest 로 검증한 ledger F행에서만 꺼낸다(신뢰 연결·fail closed)", (t) => {
  const fx = makeFixtures(t);
  const files = Object.keys(EXPECTED);
  const { rows, baseline } = makeLedger(fx);

  const trusted = trustedHashes(fx.root, files, baseline);
  assert.deepEqual(trusted.problems, []);
  assert.deepEqual(trusted.hashes, fx.hashes);
  assert.equal(validate(fx, trusted.hashes).ok, true);

  // ledger 의 해시만 고치면(원천도 같이 바꿔 맞추려는 우회) content digest 가 거부한다.
  const forged = rows.map((row) =>
    row.path === GOLDEN ? { ...row, sha256: "0".repeat(64) } : row,
  );
  write(fx, "regression/ledger.json", json({ schema: 1, rows: forged }));
  let untrusted = trustedHashes(fx.root, files, baseline);
  assert.deepEqual(untrusted.hashes, {});
  assert.match(untrusted.problems.join("\n"), /path·blob·sha256 digest 가 기준선과 다르다/);
  // 신뢰하지 못한 ledger 로는 원천 전부가 hash 규칙에서 실패한다 — 검사를 건너뛰지 않는다.
  const failClosed = validate(fx, untrusted.hashes);
  assert.equal(failClosed.ok, false);
  assert.ok(
    failClosed.results.every((item) => item.failures.some((failure) => failure.rule === "hash")),
  );
  assert.match(formatReport(failClosed, untrusted), /^ledger 신뢰 연결: 실패 1건/m);
  assert.match(formatReport(failClosed, untrusted), /^결과: 실패$/m);

  // F행을 다른 유형으로 재분류하면 type digest 가 거부한다.
  const retyped = rows.map((row) => (row.path === SEED ? { ...row, type: "R" } : row));
  write(fx, "regression/ledger.json", json({ schema: 1, rows: retyped }));
  untrusted = trustedHashes(fx.root, files, baseline);
  assert.deepEqual(untrusted.hashes, {});
  assert.match(untrusted.problems.join("\n"), /path→type digest 가 기준선과 다르다/);

  // 기준선 자체가 F 로 승인하지 않은 경로는 원문 hash 기대값으로 쓰지 않는다.
  write(fx, "regression/ledger.json", json({ schema: 1, rows }));
  untrusted = trustedHashes(fx.root, [...files, "package.json"], baseline);
  assert.deepEqual(untrusted.hashes, {});
  assert.deepEqual(untrusted.problems, ["package.json: 기준선 ledger 의 F행이 아니다"]);

  // 행 누락·ledger 부재도 거부한다.
  write(fx, "regression/ledger.json", json({ schema: 1, rows: rows.slice(1) }));
  untrusted = trustedHashes(fx.root, files, baseline);
  assert.match(untrusted.problems.join("\n"), /ledger 8행 — 기준선 9행과 다르다/);
  assert.match(
    trustedHashes(path.join(fx.root, "docs"), files, baseline).problems.join("\n"),
    /regression\/ledger\.json 를 읽지 못했다/,
  );
});

test("실제 CLI 기대값은 고정이고(동결) 검사를 끄거나 바꾸는 인자를 받지 않는다", () => {
  assert.deepEqual(REQUIRED_EXPECT_KEYS, REQUIRED);
  assert.ok(Object.isFrozen(FIXTURES));
  for (const rules of Object.values(FIXTURES)) assert.ok(Object.isFrozen(rules));
  assert.ok(
    Object.isFrozen(FIXTURES[GOLDEN].ids) && Object.isFrozen(FIXTURES[CARDIO].policyInputs),
  );
  assert.deepEqual(Object.keys(FIXTURES), [
    GOLDEN,
    CARDIO,
    SEED,
    CONTRACT,
    TUTORIAL,
    M4,
    OPENAPI,
    FEATURE_OPENAPI,
  ]);
  assert.deepEqual(FIXTURES[GOLDEN], {
    kind: "golden",
    ids: { count: 63, digest: "f3d3967013d03f052785518d7a334823dac778a08752d87a3059fe1ac1d448c2" },
    expectKeys: "6b8496a708fb8478555b0563f0a9a4a8f1ce3fec67d35214a282722690fe90da",
    rulesVersion: "2026.08.1",
    overrides: {
      count: 24,
      digest: "a4e54e3e50b40019ecf58f0b599d7e0db65deb043190821428cfa07b0f652204",
    },
  });
  assert.deepEqual(FIXTURES[CARDIO], {
    kind: "cardio",
    ids: { count: 250, digest: "0b39470343b9105b98cd6be8360f6e1f54cc86b4ce8ab898cbdbfa505fd3ae4a" },
    witnesses: {
      count: 38,
      approved: 16,
      deferred: 22,
      digest: "66130b937550b1c242808094cbdf100af8cb882638a234ab7d4310f55f13898d",
    },
    policyInputs: [
      "minutes",
      "composition",
      "doses",
      "intervalRounds",
      "cap",
      "dayOffsets",
      "focuses",
      "witness",
    ],
  });
  assert.deepEqual(FIXTURES[SEED], {
    kind: "exercises",
    ids: { count: 111, digest: "298bb083f9f8e19c0285493762229af7f636514824667c09ae991cd984ad8d60" },
  });

  const run = spawnSync(process.execPath, [CLI, "--skip-hash"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /인자를 받지 않는다: --skip-hash/);
  assert.equal(run.stdout, "");
});
