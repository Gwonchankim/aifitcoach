/* global process, console, URL */
/**
 * T6(스미스 인클라인 카탈로그) 뮤테이션 표.
 *
 * "테스트가 통과한다"는 방어를 증명하지 않는다 — 시드 행을 지워도, 값을 바꿔도 통과하는
 * fixture 는 세기 쉽다(CLAUDE.md 함정 5). 그래서 **canonical seed 행을 하나씩 고의로 망가뜨려**
 * 어떤 테스트가 잡는지 기록한다. 매번 원복하고 sha256 으로 대조한다.
 *
 *   node scripts/mutation-t6.mjs
 *
 * 오라클은 DB 를 쓰지 않는 `program-selection` 이 기본이고, 시드 shape/카운트는 DB 스펙이
 * 잡아야 하므로 그쪽도 함께 돌린다.
 *
 * `pnpm.cmd` 를 직접 spawn 하지 않는다 — Windows 에서 `.cmd` 를 `shell: false` 로 띄우면
 * Node 가 `EINVAL` 로 거절해(CVE-2024-27980 대응) 명령이 돌지도 않았는데 전부 거짓 RED 가 된다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(ROOT, "apps", "api");
const SEED = join(ROOT, "docs", "specs", "exercises_seed.json");
const JEST_ENTRY = join(
  dirname(createRequire(join(API_DIR, "package.json")).resolve("jest/package.json")),
  "bin",
  "jest.js",
);

const NEW_ROW_ID = "e_smith_incline_bench_press";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const NEW_ROW_ANCHOR = '      "id": "e_smith_incline_bench_press",\n';

/**
 * `pure` = DB 를 안 쓰는 선택 스펙만. `db` = 시드 적재 결과를 보는 스펙까지.
 * 시드 파일을 건드리면 globalSetup 이 test DB 를 다시 시드하므로 `db` 오라클도 유효하다.
 */
const MUTATIONS = [
  {
    id: 1,
    what: "equipment 를 machine → barbell (안정 장비가 아니게 된다)",
    edits: [
      [NEW_ROW_ANCHOR, NEW_ROW_ANCHOR],
      [
        '"equipment": "machine",\n      "difficulty": "beginner",\n      "metric": "reps",\n      "default_reps_low": 8,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
        '"equipment": "barbell",\n      "difficulty": "beginner",\n      "metric": "reps",\n      "default_reps_low": 8,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
      ],
    ],
    oracle: "pure",
  },
  {
    id: 2,
    what: "difficulty 를 beginner → intermediate",
    edits: [
      [
        '"difficulty": "beginner",\n      "metric": "reps",\n      "default_reps_low": 8,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
        '"difficulty": "intermediate",\n      "metric": "reps",\n      "default_reps_low": 8,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
      ],
    ],
    oracle: "db",
  },
  {
    id: 3,
    what: "primary_muscles 에서 front_delts 제거 (목 통증 대체의 근육 겹침이 사라진다)",
    edits: [
      [
        '"primary_muscles": [\n        "chest",\n        "front_delts"\n      ],\n      "secondary_muscles": [\n        "triceps"\n      ],\n      "equipment": "machine",\n      "difficulty": "beginner",',
        '"primary_muscles": [\n        "chest"\n      ],\n      "secondary_muscles": [\n        "triceps"\n      ],\n      "equipment": "machine",\n      "difficulty": "beginner",',
      ],
    ],
    oracle: "pure",
  },
  {
    id: 4,
    what: "substitutions 를 다른 기존 ID 로 교체",
    edits: [
      [
        '"substitutions": [\n        "e_incline_bench_press",\n        "e_incline_db_press"\n      ],\n      "cues": [\n        "벤치 30도",',
        '"substitutions": [\n        "e_bench_press",\n        "e_incline_db_press"\n      ],\n      "cues": [\n        "벤치 30도",',
      ],
    ],
    oracle: "pure",
  },
  {
    id: 5,
    what: "reps 범위를 8~12 → 6~12",
    edits: [
      [
        '"default_reps_low": 8,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
        '"default_reps_low": 6,\n      "default_reps_high": 12,\n      "default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
      ],
    ],
    oracle: "db",
  },
  {
    id: 6,
    what: "step_kg 를 2.5 → 5",
    edits: [
      [
        '"default_step_kg": 2.5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
        '"default_step_kg": 5,\n      "unilateral": false,\n      "substitutions": [\n        "e_incline_bench_press",',
      ],
    ],
    oracle: "db",
  },
  {
    id: 7,
    what: "movement_pattern 을 horizontal_push → vertical_push (어깨 통증 제외 대상이 아니게 된다)",
    edits: [
      [
        '"name_en": "Smith Machine Incline Bench Press",\n      "movement_pattern": "horizontal_push",',
        '"name_en": "Smith Machine Incline Bench Press",\n      "movement_pattern": "vertical_push",',
      ],
    ],
    oracle: "pure",
  },
  /**
   * **맨 마지막이어야 한다.** 이 뮤테이션만 test DB 를 건드리므로(행 삭제), 앞에 두면 뒤 항목들이
   * 남은 DB 상태를 물려받아 결과가 흔들린다 — 실제로 #8 이 배치에서만 뒤집혔다.
   */
  {
    id: 8,
    what: "신규 시드 행을 통째로 제거",
    edits: [[/\n {4}\{\n {6}"id": "e_smith_incline_bench_press",[\s\S]*?\n {4}\},/, ""]],
    oracle: "db",
    removesRow: true,
  },
];

/**
 * 문법 오류·실행 실패로 죽은 RED 는 테스트가 잡은 것이 아니다.
 *
 * `시드에 없는 잔여 행` 이 여기 있는 이유: 행을 지우는 뮤테이션은 **테스트가 돌기도 전에**
 * globalSetup 의 `db:seed` 가 자기 무결성 가드로 죽인다(테이블 106 / 시드 105). 그것도 진짜
 * 방어지만 **내 fixture 가 잡았다는 증거는 아니다.** 실제로 첫 판이 그렇게 착각했다.
 */
const INVALID_RED =
  /SyntaxError|Unexpected token|Cannot find module|EINVAL|시드에 없는 잔여 행|Got error running globalSetup/i;

/**
 * **test DB 는 repo 규칙으로만 찾는다.** 컨테이너 이름이나 DB 이름을 적어 두면 구성이 다른 환경에서
 * 조용히 엉뚱한 DB 를 만지거나 뮤테이션이 잘못 skip 된다(독립 리뷰 P2-1). 그래서 테스트가 쓰는
 * `testDatabaseUrl()` 을 그대로 불러 쓴다 — 파생 규칙의 원천이 하나다.
 */
const TSX_ENTRY = join(
  dirname(createRequire(join(API_DIR, "package.json")).resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);

function tsxEval(code) {
  return execFileSync(process.execPath, [TSX_ENTRY, "--eval", code], {
    cwd: API_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).trim();
}

const TEST_DB_URL = tsxEval(
  "import { testDatabaseUrl } from './test/support/database-url'; console.log(testDatabaseUrl());",
);

/**
 * test DB 에 대고 한 문장 실행. 개발 DB 는 이 경로로도 닿지 않는다.
 * `tsx --eval` 은 cjs 로 내보내 top-level await 를 못 쓰므로 async IIFE 로 감싼다.
 */
function onTestDb(statement) {
  return tsxEval(
    `import { PrismaClient } from "@prisma/client";` +
      `void (async () => {` +
      `  const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(TEST_DB_URL)} } } });` +
      `  try { ${statement} } finally { await p.$disconnect(); }` +
      `})();`,
  );
}

/** 종료 시 확인용 — 총 행 수와 신규 ID 행 수. */
function testDbStats() {
  const raw = onTestDb(
    `const total = await p.exercise.count();` +
      `const mine = await p.exercise.count({ where: { id: ${JSON.stringify(NEW_ROW_ID)} } });` +
      `console.log(JSON.stringify({ total, mine }));`,
  );
  return JSON.parse(raw.split("\n").filter(Boolean).at(-1));
}

/** 시드를 test DB 에 다시 적재한다(멱등). `db:seed` 와 같은 진입점이다. */
function reseedTestDb() {
  execFileSync(process.execPath, [TSX_ENTRY, join(ROOT, "scripts", "seed-exercises.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      // `prisma-migrate.mjs` 가 DIRECT_URL 을 우선하므로 둘 다 test DB 로 못박는다.
      DIRECT_URL: TEST_DB_URL,
      NO_COLOR: "1",
    },
  });
}

function run(args) {
  try {
    execFileSync(process.execPath, args, {
      cwd: API_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (!output.trim()) throw new Error(`오라클을 실행하지 못했다: ${error.message}`);
    return { failed: true, output };
  }
}

const SPECS = {
  pure: ["test/program-selection.spec.ts"],
  db: ["test/program-selection.spec.ts", "test/exercises-seed.spec.ts"],
};

function summarize(output) {
  const clean = stripAnsi(output);
  const counts = /Tests:\s+([^\n]*failed[^\n]*)/.exec(clean)?.[1]?.trim();
  const first = /●\s+([^\n]+?)\s*$/m.exec(clean.replace(/●\s+Console[\s\S]*?\n\n/g, ""))?.[1];
  return [counts, first].filter(Boolean).join(" · ") || "(요약 추출 실패)";
}

/** 시작 시점의 원본. 무슨 일이 나도 여기로 되돌린다. */
const PRISTINE = readFileSync(SEED, "utf8");
const PRISTINE_SHA = sha256(PRISTINE);
let touchedTestDb = false;

console.log(`test DB: ${TEST_DB_URL.replace(/\/\/[^@]*@/, "//***@")}`);
console.log("| # | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
console.log("| --- | --- | --- | --- | --- |");

let survivors = 0;
let invalid = 0;
try {
  for (const mutation of MUTATIONS) {
    let mutated = PRISTINE;
    let anchored = true;
    for (const [from, to] of mutation.edits) {
      const next = mutated.replace(from, to);
      if (next === mutated && String(from) !== String(to)) anchored = false;
      mutated = next;
    }
    if (!anchored || mutated === PRISTINE) {
      console.log(`| ${mutation.id} | ${mutation.what} | — | **앵커 없음** | 스크립트 갱신 필요 |`);
      survivors += 1;
      continue;
    }

    writeFileSync(SEED, mutated);
    if (mutation.removesRow) {
      // 시드에서 지운 행은 test DB 에서도 지운다 — 아니면 시드 무결성 가드가 먼저 죽어
      // **내 fixture 가 오라클이 되지 못한다.**
      touchedTestDb = true;
      onTestDb(`await p.exercise.deleteMany({ where: { id: ${JSON.stringify(NEW_ROW_ID)} } });`);
    }
    /**
     * **복구 경로 전용 fault probe.** `finally` 가 정말 돈다는 것은 실패를 실제로 일으켜 봐야 안다 —
     * "복구 코드를 넣었다"는 복구된다는 증거가 아니다. 시드를 망가뜨리고(#8 은 DB 행까지 지우고)
     * **바로 그 상태에서** 던져, 밖에서 시드 sha256 과 test DB 를 확인할 수 있게 한다.
     *
     * `AFC_MUT_FAULT=<번호>`. 이 harness 안에만 있고 제품 코드가 아니다.
     */
    if (process.env.AFC_MUT_FAULT === String(mutation.id)) {
      throw new Error(`fault probe: 뮤테이션 #${mutation.id} 적용 직후 의도적으로 중단한다`);
    }

    const result = run([JEST_ENTRY, "--runInBand", ...SPECS[mutation.oracle]]);
    writeFileSync(SEED, PRISTINE);

    if (result.failed && INVALID_RED.test(stripAnsi(result.output))) {
      invalid += 1;
      console.log(
        `| ${mutation.id} | ${mutation.what} | ${mutation.oracle} | **무효** | 실행 오류로 죽었다 |`,
      );
      continue;
    }
    if (!result.failed) survivors += 1;

    console.log(
      `| ${mutation.id} | ${mutation.what} | ${mutation.oracle} | ` +
        `${result.failed ? "**RED**" : "**생존**"} | ${result.failed ? summarize(result.output) : "—"} |`,
    );
  }
} finally {
  // **어떤 실패·중단에서도** 시드 파일과 test DB 를 원래대로 돌린다.
  writeFileSync(SEED, PRISTINE);
  if (touchedTestDb) reseedTestDb();
}

// 여기서부터는 "정리했다"가 아니라 **정리됐음을 확인한다.** 뒤에 root test 가 없어도 정상이어야 한다.
const finalSha = sha256(readFileSync(SEED, "utf8"));
if (finalSha !== PRISTINE_SHA) {
  throw new Error(`시드 파일이 원본과 다르다: ${finalSha} ≠ ${PRISTINE_SHA}`);
}
const stats = testDbStats();
if (stats.total !== 106 || stats.mine !== 1) {
  throw new Error(
    `test DB 잔여물: total=${stats.total} (기대 106), 신규 ID=${stats.mine} (기대 1)`,
  );
}
console.log(
  `\n정리 확인 — 시드 sha256 ${finalSha.slice(0, 12)} 원본 일치 · ` +
    `test DB ${stats.total}행 · 신규 ID ${stats.mine}행.`,
);

console.log(
  `${MUTATIONS.length}건 중 RED ${MUTATIONS.length - survivors - invalid}건 · ` +
    `무효 ${invalid}건 · **생존 ${survivors}건**.`,
);
if (survivors > 0 || invalid > 0) process.exitCode = 1;
