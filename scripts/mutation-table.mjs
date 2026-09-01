/**
 * fixup-snapshot-engine-retry-proof-01 의 mutation 표를 **한 번에** 돌린다.
 * 각 행마다: 원본 snapshot → 변형 주입 → 지정한 spec 실행(반드시 red) → 원복 → sha256 대조.
 * 손으로 돌리면 원복을 빠뜨리거나 표와 실제 실행이 어긋난다(교훈 10).
 *
 * 사용: node scripts/mutation-table.mjs [행번호...]
 */
/* global process, console */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const REC = "apps/api/src/recommendation/recommendation.service.ts";
const SYNC = "apps/api/src/sync/sync.service.ts";
const SESSIONS = "apps/api/src/sessions/sessions.service.ts";

const ENGINE = "test/assistance-factory-recompute.spec.ts";
const RETRY = "test/sync-retry-state.spec.ts";
const BATCH = "test/assistance-callsite-batch.spec.ts";
const AUDIT = "test/assistance-pain-audit.spec.ts";

/** @type {{n:number,label:string,file:string,from:string,to:string,specs:string[]}[]} */
const TABLE = [
  {
    n: 1,
    label: "snapshot step 대신 catalog defaultStep 사용",
    file: REC,
    from: "      assisted && snapshot !== undefined ? snapshot.stepKg : exercise.defaultStepKg;",
    to: "      exercise.defaultStepKg;",
    specs: [ENGINE],
  },
  {
    n: 2,
    label: "snapshot rulesVersion 대신 active pointer 사용",
    file: REC,
    from:
      "        assisted && snapshot !== undefined\n" +
      "          ? rulesVersionForLoadSemantics(exercise.loadSemantics, snapshot.rulesVersion)\n" +
      "          : rulesVersionForLoadSemantics(exercise.loadSemantics, RULES_VERSION),",
    to: "        rulesVersionForLoadSemantics(exercise.loadSemantics, RULES_VERSION),",
    specs: [ENGINE],
  },
  {
    n: 3,
    label: "total attempt 상한 5→6",
    file: SYNC,
    from: "const SERIALIZATION_ATTEMPTS = 5;",
    to: "const SERIALIZATION_ATTEMPTS = 6;",
    specs: [RETRY],
  },
  {
    n: 4,
    label: "P2034 retry 분류 제거",
    file: SYNC,
    from: '          (error.code === "P2034" || error.code === "P2002");',
    to: '          error.code === "P2002";',
    specs: [RETRY],
  },
  {
    n: 5,
    label: "P2002 retry 분류 제거",
    file: SYNC,
    from: '          (error.code === "P2034" || error.code === "P2002");',
    to: '          error.code === "P2034";',
    specs: [RETRY],
  },
  {
    n: 6,
    label: "sync batch 뒤 single-spec prefetch 추가",
    file: SYNC,
    from:
      "    const prefetched = await this.recommendation.prefetchHistories(\n" +
      "      userId,\n" +
      "      [...newCatalog.values()].map((row) => ({\n" +
      "        exerciseId: row.id,\n" +
      "        loadSemantics: row.loadSemantics,\n" +
      "      })),\n" +
      "      tx,\n" +
      "    );",
    to:
      "    const prefetched = new Map();\n" +
      "    for (const row of newCatalog.values()) {\n" +
      "      const one = await this.recommendation.prefetchHistories(\n" +
      "        userId,\n" +
      "        [{ exerciseId: row.id, loadSemantics: row.loadSemantics }],\n" +
      "        tx,\n" +
      "      );\n" +
      "      prefetched.set(row.id, one.get(row.id));\n" +
      "    }",
    specs: [RETRY, BATCH],
  },
  {
    n: 7,
    label: "PlannedSet semantics predicate 제거(카탈로그 semantics 사용)",
    file: SESSIONS,
    from: "        exercise: { ...exercise, loadSemantics: semanticsOf(targetSets) },",
    to: "        exercise,",
    specs: [ENGINE],
  },
  {
    n: 8,
    label: "performedAt fallback 제거",
    file: REC,
    // **양쪽 피연산자를 함께** 바꾼다. 한쪽만 바꾸면 비교기가 비일관해져
    // 결과가 DB 반환 순서(무작위 UUID)에 좌우된다 — red/green 이 흔들린다.
    from:
      "      (b.plannedSet.session.completedAt ?? b.performedAt).getTime() -\n" +
      "      (a.plannedSet.session.completedAt ?? a.performedAt).getTime();",
    to:
      "      (b.plannedSet.session.completedAt?.getTime() ?? 0) -\n" +
      "      (a.plannedSet.session.completedAt?.getTime() ?? 0);",
    specs: [AUDIT],
  },
  {
    n: 9,
    label: "setNo comparator 제거",
    file: REC,
    from: "  return a.plannedSet.setNo - b.plannedSet.setNo;",
    to: "  return 0;",
    specs: [AUDIT, ENGINE],
  },
  {
    // 표 밖 추가분: setNo 비교기는 **둘**이다(earliest 와 latest 내부 정렬).
    // 하나만 죽여 보면 다른 하나는 검증된 적이 없는 채로 남는다.
    n: 10,
    label: "latest 세션 내부 setNo 정렬 제거",
    file: REC,
    from: "    .sort((a, b) => a.plannedSet.setNo - b.plannedSet.setNo);",
    to: "    .sort(() => 0);",
    specs: [AUDIT],
  },
];

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });

const wanted = process.argv.slice(2).map(Number);
const rows = wanted.length ? TABLE.filter((row) => wanted.includes(row.n)) : TABLE;

for (const row of rows) {
  const before = sha(row.file);
  run("node", ["scripts/mutate.mjs", "snapshot", row.file]);
  const source = readFileSync(row.file, "utf8");
  if (!source.includes(row.from)) {
    console.log(`#${row.n} ✗ 앵커 미일치 — ${row.label}`);
    continue;
  }
  writeFileSync(row.file, source.replace(row.from, row.to));

  let output = "";
  try {
    output = run("pnpm", ["--filter", "api", "exec", "jest", ...row.specs]);
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const summary = /Tests:.*/.exec(output)?.[0] ?? "(요약 없음)";
  const failed = /(\d+) failed/.exec(summary);
  const names = [...output.matchAll(/● (?!Console)(.+)/g)]
    .map((match) => match[1].trim())
    .filter((name, index, all) => all.indexOf(name) === index);

  run("node", ["scripts/mutate.mjs", "restore", row.file]);
  const after = sha(row.file);
  console.log(
    [
      `#${row.n} ${failed ? "RED" : "GREEN(!)"} ${row.label}`,
      `    ${summary}`,
      ...names.slice(0, 3).map((name) => `    ↳ ${name}`),
      `    sha ${before.slice(0, 12)} → ${after.slice(0, 12)} ${before === after ? "일치" : "불일치(!)"}`,
    ].join("\n"),
  );
}
run("node", ["scripts/mutate.mjs", "verify"]);
