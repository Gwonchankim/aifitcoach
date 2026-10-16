/**
 * 원천 fixture 무결성 검사 — docs/specs 원천 8개를 기준선(7825c93)의 원문 hash·구조 규칙에 대조한다.
 *
 *   node scripts/rebuild-fixtures.mjs
 *
 * - 원문 hash 기대값은 regression/ledger.json 의 F행에서 읽는다. 그 전에 ledger 전체를 BASELINE 의
 *   행 수·content digest·type digest 로 검증한다 — 승인 기준선에 연결된 행만 믿는다.
 * - 구조 기대값(FIXTURES)은 기준선 원천 blob 에서 한 번 산출해 고정한 작은 메타데이터다(개수·정렬 줄 집합
 *   digest·버전·필수 키). 검사할 후보 파일에서 기대값을 다시 만들지 않는다.
 * - 추천 수학(golden 실행)은 검사하지 않는다 — M1-01 범위. CLI 는 인자를 받지 않는다(검사 해제·기대값 교체 없음).
 * import 만으로는 아무것도 실행하지 않는다.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BASELINE, LEDGER_PATH, inventoryDigest } from "./rebuild-bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const TYPE_LINE = (row) => `${row.path}\t${row.type}\n`;

/** 줄 집합 digest: 바이트순으로 정렬한 각 줄에 `\n` 을 붙여 이은 UTF-8 의 SHA-256. 고정 기대값의 비교 형식. */
export function linesDigest(lines) {
  const text = [...lines]
    .sort(byteOrder)
    .map((line) => `${line}\n`)
    .join("");
  return sha256(Buffer.from(text, "utf8"));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** golden 케이스가 기준선에서 선언한 이 계열(weight·reps_low·reason_code(_in)·e1rm)의 expect 키는 남아 있어야 한다. */
export const REQUIRED_EXPECT_KEYS = Object.freeze([
  "weight",
  "reps_low",
  "reason_code",
  "reason_code_in",
  "e1rm",
  "e1rm_tolerance",
]);

/**
 * 기준선 7825c93 의 원천 blob 에서 산출해 고정한 기대값. digest 의 줄 형식(linesDigest):
 *   ids: ID 한 줄씩 · expectKeys: `id\t<REQUIRED_EXPECT_KEYS 중 선언한 키, 정렬·쉼표>`
 *   overrides: rules_version 을 가진 케이스의 `id\trules_version` · witnesses: `id\tapproved`
 */
export const FIXTURES = deepFreeze({
  "docs/specs/golden_tests.json": {
    kind: "golden",
    ids: { count: 63, digest: "f3d3967013d03f052785518d7a334823dac778a08752d87a3059fe1ac1d448c2" },
    expectKeys: "6b8496a708fb8478555b0563f0a9a4a8f1ce3fec67d35214a282722690fe90da",
    rulesVersion: "2026.08.1",
    overrides: {
      count: 24,
      digest: "a4e54e3e50b40019ecf58f0b599d7e0db65deb043190821428cfa07b0f652204",
    },
  },
  "docs/specs/cardio_baseline_golden.json": {
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
  },
  "docs/specs/exercises_seed.json": {
    kind: "exercises",
    ids: { count: 111, digest: "298bb083f9f8e19c0285493762229af7f636514824667c09ae991cd984ad8d60" },
  },
  "docs/specs/feature_improvements_contract.json": { kind: "contract" },
  "docs/specs/tutorial_program_rir.json": {
    kind: "keys",
    keys: [
      "schema_version",
      "id",
      "type",
      "title",
      "purpose",
      "adaptive",
      "graduation",
      "skip_policy",
      "safety",
      "sessions",
      "output",
    ],
  },
  "docs/specs/m4_aggregation_fixture.json": {
    kind: "keys",
    keys: ["description", "sessions", "expected"],
  },
  "docs/specs/openapi.yaml": { kind: "bytes" },
  "docs/specs/feature-improvements.openapi.yaml": { kind: "bytes" },
});

/** ID 목록: 문자열·중복 0·개수·정렬 집합 digest 를 고정값과 대조한다. */
function checkIds(label, ids, expected, fail) {
  if (!ids.every((id) => typeof id === "string" && id !== "")) {
    fail("ids", `${label} 에 비었거나 문자열이 아닌 값이 있다`);
    return;
  }
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) (seen.has(id) ? duplicates : seen).add(id);
  if (duplicates.size > 0) {
    fail("ids", `${label} 중복 ${duplicates.size}개: ${[...duplicates].slice(0, 10).join(", ")}`);
  }
  if (ids.length !== expected.count) {
    fail("ids", `${label} ${ids.length}개 — 승인 ${expected.count}개와 다르다`);
  } else if (duplicates.size === 0 && linesDigest(ids) !== expected.digest) {
    fail("ids", `${label} 집합이 승인 집합과 다르다(개수는 ${ids.length}개로 같다)`);
  }
}

function checkGolden(json, expected, fail) {
  const { cases } = json;
  if (!Array.isArray(cases) || !cases.every((item) => isObject(item) && isObject(item.expect))) {
    fail("shape", "cases 배열과 케이스별 expect 객체가 필요하다");
    return;
  }
  checkIds(
    "case ID",
    cases.map((item) => item.id),
    expected.ids,
    fail,
  );
  const declared = (item) =>
    Object.keys(item.expect)
      .filter((key) => REQUIRED_EXPECT_KEYS.includes(key))
      .sort();
  if (
    linesDigest(cases.map((item) => `${item.id}\t${declared(item).join(",")}`)) !==
    expected.expectKeys
  ) {
    const counts = REQUIRED_EXPECT_KEYS.map(
      (key) => `${key} ${cases.filter((item) => Object.hasOwn(item.expect, key)).length}`,
    );
    fail("expect-keys", `케이스별 필수 expect 키가 승인 기준과 다르다(후보 ${counts.join(" · ")})`);
  }
  if (json.rules_version !== expected.rulesVersion) {
    fail(
      "rules-version",
      `root rules_version ${json.rules_version} — 승인 ${expected.rulesVersion}`,
    );
  }
  const overrides = cases.filter((item) => Object.hasOwn(item, "rules_version"));
  const overrideLines = overrides.map((item) => `${item.id}\t${item.rules_version}`);
  if (
    overrides.length !== expected.overrides.count ||
    linesDigest(overrideLines) !== expected.overrides.digest
  ) {
    const byVersion = {};
    for (const item of overrides)
      byVersion[item.rules_version] = (byVersion[item.rules_version] ?? 0) + 1;
    const found = Object.entries(byVersion).map(([version, count]) => `${version} ${count}`);
    fail(
      "rules-version",
      `케이스 rules_version override 가 승인 기준(${expected.overrides.count}개)과 다르다 — 후보 ${found.join(" · ") || "없음"}`,
    );
  }
  if (typeof json.defaults?.e1rm_tolerance !== "number") {
    fail("defaults", "defaults.e1rm_tolerance 가 없다");
  }
}

function checkCardio(json, expected, fail) {
  const { cases, explicit_witness_infeasible: witnesses, policy_inputs: inputs } = json;
  if (![cases, witnesses].every((list) => Array.isArray(list) && list.every(isObject))) {
    fail("shape", "cases·explicit_witness_infeasible 객체 배열이 필요하다");
    return;
  }
  checkIds(
    "case ID",
    cases.map((item) => item.id),
    expected.ids,
    fail,
  );
  const want = expected.witnesses;
  const approved = witnesses.filter((item) => item.approved === true).length;
  const deferred = witnesses.filter((item) => item.approved === false).length;
  if (witnesses.length !== want.count || approved !== want.approved || deferred !== want.deferred) {
    fail(
      "witnesses",
      `infeasible witness ${witnesses.length}개(approved ${approved} / deferred ${deferred}) — 승인 ${want.count}개(${want.approved} / ${want.deferred})`,
    );
  } else if (linesDigest(witnesses.map((item) => `${item.id}\t${item.approved}`)) !== want.digest) {
    fail("witnesses", "witness 별 승인 분류가 승인 기준과 다르다(분류 수는 같다)");
  }
  const caseIds = new Set(cases.map((item) => item.id));
  const dangling = witnesses.map((item) => item.id).filter((id) => !caseIds.has(id));
  if (dangling.length > 0) {
    fail(
      "witnesses",
      `cases 에 없는 witness ${dangling.length}개: ${dangling.slice(0, 10).join(", ")}`,
    );
  }
  const missing = expected.policyInputs.filter(
    (key) => !isObject(inputs) || !Object.hasOwn(inputs, key),
  );
  if (missing.length > 0)
    fail("policy-inputs", `policy_inputs 필수 키 없음: ${missing.join(", ")}`);
}

function checkExercises(json, expected, fail) {
  const { exercises } = json;
  if (!Array.isArray(exercises) || !exercises.every(isObject)) {
    fail("shape", "exercises 객체 배열이 필요하다");
    return;
  }
  const ids = exercises.map((item) => item.id);
  checkIds("exercise ID", ids, expected.ids, fail);
  const known = new Set(ids);
  const dangling = [];
  for (const item of exercises) {
    if (!Array.isArray(item.substitutions)) dangling.push(`${item.id}(substitutions 배열 없음)`);
    else
      for (const ref of item.substitutions) if (!known.has(ref)) dangling.push(`${item.id}→${ref}`);
  }
  if (dangling.length > 0) {
    fail(
      "dangling",
      `없는 운동을 가리키는 대체 참조 ${dangling.length}개: ${dangling.slice(0, 10).join(", ")}`,
    );
  }
}

const countOf = (list, value) => list.filter((item) => item === value).length;

/** 계약 내부 참조: 길이·인덱스·파생 수가 같은 파일 안의 다른 값과 맞는지만 본다(수학 검증 아님). */
function checkContract(json, _expected, fail) {
  const { composition, preferences, invalid_preferences: invalid } = json;
  const recovery = json.recovery_counterexample;
  const lists = [composition, preferences, invalid];
  if (!lists.every((list) => Array.isArray(list) && list.every(isObject)) || !isObject(recovery)) {
    fail(
      "shape",
      "composition·preferences·invalid_preferences 객체 배열과 recovery_counterexample 객체가 필요하다",
    );
    return;
  }
  for (const row of composition) {
    if (row.legacy?.length !== row.days || row.revised?.length !== row.days) {
      fail("refs", `composition ${row.goal}/${row.days}: legacy·revised 길이가 days 와 다르다`);
    }
  }
  for (const row of preferences) {
    const label = `preferences ${row.days}/${row.preference}`;
    if (
      !Array.isArray(row.focus) ||
      row.focus.length !== row.days ||
      row.day_offsets?.length !== row.days
    ) {
      fail("refs", `${label}: focus·day_offsets 길이가 days 와 다르다`);
    } else if (
      !isDeepStrictEqual(row.expected_counts, [
        countOf(row.focus, "upper"),
        countOf(row.focus, "lower"),
      ])
    ) {
      fail("refs", `${label}: expected_counts 가 focus 의 upper·lower 수와 다르다`);
    }
  }
  const valid = new Set(preferences.map((row) => `${row.days}/${row.preference}`));
  for (const row of invalid) {
    if (valid.has(`${row.days}/${row.preference}`)) {
      fail("refs", `invalid_preferences ${row.days}/${row.preference} 가 preferences 에도 있다`);
    }
  }
  const {
    day_offsets: offsets,
    focus_before: before,
    focus_after: after,
    swap_indices: swap,
  } = recovery;
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    offsets?.length !== before.length ||
    after.length !== before.length
  ) {
    fail("refs", "recovery_counterexample 의 day_offsets·focus_before·focus_after 길이가 다르다");
    return;
  }
  const [first, second] = Array.isArray(swap) && swap.length === 2 ? swap : [];
  const inRange = (index) => Number.isInteger(index) && index >= 0 && index < before.length;
  if (!inRange(first) || !inRange(second) || first === second) {
    fail(
      "refs",
      "recovery_counterexample.swap_indices 가 focus_before 의 서로 다른 두 위치가 아니다",
    );
    return;
  }
  const swapped = [...before];
  [swapped[first], swapped[second]] = [swapped[second], swapped[first]];
  if (!isDeepStrictEqual(swapped, after)) {
    fail(
      "refs",
      "recovery_counterexample.focus_after 가 swap_indices 를 적용한 focus_before 와 다르다",
    );
  }
}

function checkTopKeys(json, expected, fail) {
  const missing = expected.keys.filter((key) => !Object.hasOwn(json, key));
  if (missing.length > 0) fail("keys", `필수 최상위 키 없음: ${missing.join(", ")}`);
}

/** kind 별 구조 규칙(원문 hash·JSON parse 다음에 실행). bytes 는 원문 hash 만 본다 — YAML 파서를 두지 않는다. */
const RULES = Object.freeze({
  golden: [["ids", "expect-keys", "rules-version", "defaults"], checkGolden],
  cardio: [["ids", "witnesses", "policy-inputs"], checkCardio],
  exercises: [["ids", "dangling"], checkExercises],
  contract: [["refs"], checkContract],
  keys: [["keys"], checkTopKeys],
  bytes: [[], null],
});

/** 원천 하나: 원문 hash → (JSON 원천이면) parse → kind 별 구조 규칙. 실제로 실행한 규칙을 ran 에 남긴다. */
function checkSource(root, file, expected, hash) {
  const failures = [];
  const ran = [];
  const fail = (rule, message) => failures.push({ rule, message });
  let bytes;
  try {
    bytes = readFileSync(path.join(root, ...file.split("/")));
  } catch (error) {
    fail("read", `읽지 못했다: ${error.code ?? error.message}`);
    return { file, failures, ran };
  }
  ran.push("hash");
  if (!hash) fail("hash", "기대 원문 hash 가 없다 — 검사를 건너뛰지 않는다");
  else if (sha256(bytes) !== hash) {
    fail("hash", `원문 sha256 ${sha256(bytes)} 가 기준선(ledger F행)과 다르다`);
  }
  const [rules, check] = RULES[expected.kind];
  if (!check) return { file, failures, ran };
  ran.push("parse");
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("parse", `JSON 을 해석하지 못했다: ${error.message}`);
    return { file, failures, ran };
  }
  if (!isObject(json)) {
    fail("shape", "최상위가 JSON 객체가 아니다");
    return { file, failures, ran };
  }
  ran.push(...rules);
  check(json, expected, fail);
  return { file, failures, ran };
}

/**
 * 원천 전체 검사. expected 기본값은 고정 FIXTURES 다(합성 시험만 다른 값을 넣는다).
 * hashes: 원천 경로 → 기대 원문 sha256. CLI 는 trustedHashes() 가 검증한 ledger F행 값만 넘긴다.
 * 반환: { ok, results: [{ file, failures: [{ rule, message }], ran }] }
 */
export function validateFixtures({ root, expected = FIXTURES, hashes = {} }) {
  const results = Object.entries(expected).map(([file, rules]) =>
    checkSource(root, file, rules, hashes[file]),
  );
  return { ok: results.every((result) => result.failures.length === 0), results };
}

/**
 * ledger F행의 sha256 을 원문 hash 기대값으로 꺼낸다. 먼저 ledger 전체가 기준선(BASELINE 의 행 수·
 * content digest·type digest)과 같은지 확인한다 — 후보 ledger 가 스스로 주장하는 값을 그대로 믿지 않는다.
 * 하나라도 어긋나면 기대값을 하나도 내주지 않는다(fail closed).
 */
export function trustedHashes(root, files, baseline = BASELINE) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(path.join(root, ...LEDGER_PATH.split("/")), "utf8")).rows;
  } catch (error) {
    return { hashes: {}, problems: [`${LEDGER_PATH} 를 읽지 못했다: ${error.message}`] };
  }
  if (!Array.isArray(rows) || !rows.every((row) => isObject(row) && typeof row.path === "string")) {
    return { hashes: {}, problems: [`${LEDGER_PATH} 의 rows 형식이 아니다`] };
  }
  const problems = [];
  if (rows.length !== baseline.rows) {
    problems.push(`ledger ${rows.length}행 — 기준선 ${baseline.rows}행과 다르다`);
  }
  if (inventoryDigest(rows) !== baseline.digest) {
    problems.push("ledger 의 path·blob·sha256 digest 가 기준선과 다르다");
  }
  if (inventoryDigest(rows, TYPE_LINE) !== baseline.typeDigest) {
    problems.push("ledger 의 path→type digest 가 기준선과 다르다");
  }
  if (problems.length > 0) return { hashes: {}, problems };
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const hashes = {};
  for (const file of files) {
    const row = byPath.get(file);
    if (row?.type === "F") hashes[file] = row.sha256;
    else problems.push(`${file}: 기준선 ledger 의 F행이 아니다`);
  }
  return { hashes: problems.length > 0 ? {} : hashes, problems };
}

export function formatReport(result, trust) {
  const lines = [
    `rebuild-fixtures · 기준선 ${BASELINE.sha} · 원천 ${result.results.length}개`,
    trust.problems.length === 0
      ? "ledger 신뢰 연결: 통과(행 수·content digest·type digest·F행)"
      : `ledger 신뢰 연결: 실패 ${trust.problems.length}건 — 원문 hash 기대값을 쓰지 않는다`,
    ...trust.problems.map((problem) => `  - ${problem}`),
  ];
  for (const { file, failures, ran } of result.results) {
    lines.push(
      failures.length === 0
        ? `${file}: 통과(${ran.join("·")})`
        : `${file}: 실패 ${failures.length}건`,
    );
    for (const failure of failures) lines.push(`  - [${failure.rule}] ${failure.message}`);
  }
  lines.push(result.ok && trust.problems.length === 0 ? "결과: 통과" : "결과: 실패");
  return lines.join("\n");
}

function main(argv) {
  if (argv.length > 0) {
    console.error(`인자를 받지 않는다: ${argv.join(" ")}`);
    return 2;
  }
  const trust = trustedHashes(ROOT, Object.keys(FIXTURES));
  const result = validateFixtures({ root: ROOT, hashes: trust.hashes });
  console.log(formatReport(result, trust));
  return result.ok && trust.problems.length === 0 ? 0 : 1;
}

const invokedAsCli = () => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
};

if (invokedAsCli()) process.exitCode = main(process.argv.slice(2));
