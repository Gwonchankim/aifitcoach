/* global process, console, URL */
/**
 * T1(휴식 종료 피드백) 뮤테이션 표.
 *
 * "26개 통과"는 방어를 증명하지 않는다 — 분기를 지워도 통과하는 테스트가 실제로 있었다
 * (CLAUDE.md 함정 5). 그래서 핵심 분기를 하나씩 **고의로 망가뜨려** 정확히 어떤 테스트가
 * 잡아내는지 기록하고, 매번 원복해 sha256 으로 대조한다.
 *
 *   node scripts/mutation-t1.mjs
 *
 * 오라클은 두 가지다: 대부분은 targeted vitest, deps 배열은 `react-hooks/exhaustive-deps`(error)
 * 라서 lint 가 잡는다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FEEDBACK = join(ROOT, "apps", "web", "lib", "rest-feedback.ts");
const SHEET = join(ROOT, "apps", "web", "components", "session", "RestTimerSheet.tsx");

/** @type {{id: number, file: string, what: string, from: string, to: string, oracle: 'test'|'lint'}[]} */
const MUTATIONS = [
  {
    id: 1,
    file: FEEDBACK,
    what: "같은 endsAt 재신호를 막는 정체성 가드 제거",
    from: "if (!finished || signaledEndsAt === endsAt) return;",
    to: "if (!finished) return;",
    oracle: "test",
  },
  {
    id: 2,
    file: FEEDBACK,
    what: "종료 여부 확인 제거 — 진행 중에도 울린다",
    from: "if (!finished || signaledEndsAt === endsAt) return;",
    to: "if (signaledEndsAt === endsAt) return;",
    oracle: "test",
  },
  {
    id: 3,
    file: FEEDBACK,
    what: "정체성 기록을 빠뜨림 — 게이트가 영원히 열린다",
    from: "    signaledEndsAt = endsAt;\n    emit();",
    to: "    emit();",
    oracle: "test",
  },
  {
    id: 4,
    file: FEEDBACK,
    what: "unlock 의 단일 컨텍스트 보장 제거(??= → =)",
    from: "context ??= new Ctor();",
    to: "context = new Ctor();",
    oracle: "test",
  },
  {
    id: 5,
    file: FEEDBACK,
    what: "suspended 판정 제거 — running 에서도 resume 을 부른다",
    from: 'if (context.state === "suspended") context.resume().catch(() => {});',
    to: "context.resume().catch(() => {});",
    oracle: "test",
  },
  {
    id: 6,
    file: FEEDBACK,
    what: "unlock 하지 않은 컨텍스트 가드 제거 — null 접근",
    from: "  if (!context) return;\n  try {\n    const oscillator",
    to: "  try {\n    const oscillator",
    oracle: "test",
  },
  {
    id: 7,
    file: FEEDBACK,
    what: "비프 길이 상수 변경(120 → 200ms)",
    from: "durationMs: 120",
    to: "durationMs: 200",
    oracle: "test",
  },
  {
    id: 8,
    file: FEEDBACK,
    what: "진동 패턴 상수 변경([120] → [400])",
    from: "export const REST_VIBRATE_PATTERN_MS: readonly number[] = [120];",
    to: "export const REST_VIBRATE_PATTERN_MS: readonly number[] = [400];",
    oracle: "test",
  },
  {
    id: 9,
    file: FEEDBACK,
    what: "진동 패턴 복사 제거 — 상수를 그대로 넘긴다",
    from: "navigator.vibrate([...REST_VIBRATE_PATTERN_MS]);",
    to: "navigator.vibrate(REST_VIBRATE_PATTERN_MS as number[]);",
    oracle: "test",
  },
  {
    id: 10,
    file: FEEDBACK,
    what: "비프 실패 격리 제거 — 예외가 위로 샌다",
    // `catch` 만 지우면 `try` 가 짝을 잃어 **문법 오류**가 난다. 그건 테스트가 잡은 게 아니라
    // 파서가 잡은 것이라 아무것도 증명하지 못한다. 그래서 블록을 통째로 평범한 블록으로 바꾼다.
    edits: [
      ["  try {\n    const oscillator", "  {\n    const oscillator"],
      ["  } catch {\n    // 무음으로 떨어진다.\n  }", "  }"],
    ],
    oracle: "test",
  },
  {
    id: 11,
    file: FEEDBACK,
    what: "진동 실패 격리 제거 — 권한 거부가 위로 샌다",
    edits: [
      ["  try {\n    // 복사본을", "  {\n    // 복사본을"],
      ["  } catch {\n    // 진동 없이 지나간다.\n  }", "  }"],
    ],
    oracle: "test",
  },
  {
    id: 12,
    file: FEEDBACK,
    what: "vibrate 지원 여부 확인 제거",
    from: 'if (typeof navigator?.vibrate !== "function") return;',
    to: "if (navigator === undefined) return;",
    oracle: "test",
  },
  {
    id: 13,
    file: FEEDBACK,
    what: "AudioContext 지원 여부 확인 제거 — 미지원 브라우저에서 던진다",
    from: 'return typeof globalThis.AudioContext === "function" ? globalThis.AudioContext : null;',
    to: "return globalThis.AudioContext;",
    oracle: "test",
  },
  {
    id: 14,
    file: FEEDBACK,
    what: "unlock 생성 실패 격리 제거",
    edits: [
      ["  try {\n    // 조회까지", "  {\n    // 조회까지"],
      ["  } catch {\n    context = null;\n  }", "  }"],
    ],
    oracle: "test",
  },
  {
    id: 15,
    file: SHEET,
    what: "이펙트 의존성에서 finished·endsAt 제거 — 종료를 관측하지 못한다",
    from: "  }, [open, finished, timer.endsAt]);",
    to: "  }, [open]);",
    oracle: "lint",
  },
  {
    id: 16,
    file: FEEDBACK,
    what: "AudioContext 조회를 try 밖으로 되돌림 — 접근 예외가 새어 나간다",
    from:
      "  try {\n" +
      "    // 조회까지 try 안이다 — `globalThis.AudioContext` 는 접근만으로 던질 수 있다(정책·확장 프로그램).\n" +
      "    const Ctor = audioContextCtor();\n" +
      "    if (!Ctor) return;\n" +
      "    context ??= new Ctor();",
    to: "  const Ctor = audioContextCtor();\n  if (!Ctor) return;\n  try {\n    context ??= new Ctor();",
    oracle: "test",
  },
];

/**
 * **등가 뮤턴트.** 관측 가능한 동작이 원본과 같아서 어떤 테스트로도 죽일 수 없는 것들.
 * 셋 다 이유가 하나다 — fail-soft `try/catch` 가 그 분기를 이미 삼킨다. 가드를 지워도
 * 예외 경로로 같은 결과(무음·무진동·무예외)에 도달한다. 가드는 **의도 표현**이지 동작 분기가 아니다.
 * 숨기지 않고 표에 남긴다.
 */
const KNOWN_EQUIVALENT = new Map([
  [6, "context null 접근 → TypeError → beep 의 catch 가 삼킨다. 관측 결과 동일"],
  [12, "vibrate 미지원 → TypeError → vibrate 의 catch 가 삼킨다. 관측 결과 동일"],
  [13, "비함수 값이면 `new Ctor()` 가 던지고 unlock 의 catch 가 삼킨다. 관측 결과 동일"],
]);

/**
 * **`pnpm.cmd` 를 직접 spawn 하지 않는다.** Windows 에서 `.cmd` 를 `shell: false` 로 띄우면
 * Node 가 `EINVAL` 로 거절한다(CVE-2024-27980 대응). 그러면 명령이 돌지도 않았는데 예외가 나서
 * **뮤테이션이 전부 거짓 RED 로 잡힌다** — 실제로 이 스크립트의 첫 판이 그렇게 틀렸다.
 * 그래서 `diag-webkit-loss0.mjs` 처럼 JS 진입점을 resolve 해 `node` 로 직접 실행한다.
 */
const WEB_DIR = join(ROOT, "apps", "web");
const VITEST_ENTRY = join(
  dirname(createRequire(join(WEB_DIR, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);
const ESLINT_ENTRY = join(
  dirname(createRequire(join(ROOT, "package.json")).resolve("eslint/package.json")),
  "bin",
  "eslint.js",
);

function run(args, cwd) {
  try {
    execFileSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // 실행 자체가 안 된 것은 "테스트가 잡았다"가 아니다. 거짓 RED 를 막는다.
    if (!output.trim()) throw new Error(`오라클을 실행하지 못했다: ${error.message}`);
    return { failed: true, output };
  }
}

const runTests = () => run([VITEST_ENTRY, "run", "test/rest-feedback.test.ts"], WEB_DIR);
const runLint = () => run([ESLINT_ENTRY, "apps/web/components/session/RestTimerSheet.tsx"], ROOT);

/**
 * **색을 끄고 받아도** 셸에 따라 ANSI 가 섞여 나온다(실측: Git Bash). 요약 정규식이 그 사이에서
 * 미끄러지지 않도록 먼저 걷어낸다 — `mutation-f4b.mjs` 와 같은 이유다.
 *
 * 이스케이프 문자를 **소스에 직접 넣지 않고** 코드로 만든다. 리터럴로 두면 파일에 제어문자가
 * 박혀 `no-control-regex` 예외가 필요하고, 편집·복사 과정에서 조용히 사라지기도 한다.
 */
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");

/** 실패 요약에서 사람이 읽을 한 줄만 뽑는다. */
function summarize(oracle, output) {
  const stripped = stripAnsi(output);
  if (oracle === "lint") {
    return /react-hooks\/exhaustive-deps/.test(stripped)
      ? "eslint react-hooks/exhaustive-deps"
      : (/error\s+(.*)/.exec(stripped)?.[1]?.trim() ?? "(lint 실패)");
  }
  const counts = /Tests\s+(\d+ failed[^\n|]*)/.exec(stripped)?.[1]?.trim();
  // 스위트가 통째로 죽으면 `Tests` 줄이 없다 — 그때는 원인 줄을 그대로 쓴다.
  const first =
    /FAIL[^\n]*?>[^\n]*?>\s*([^\n]+)/.exec(stripped)?.[1]?.trim() ??
    /(?:AssertionError|Error):\s*([^\n]+)/.exec(stripped)?.[1]?.trim();
  const failedFiles = /Test Files\s+(\d+ failed[^\n|]*)/.exec(stripped)?.[1]?.trim();
  return [counts ?? failedFiles, first].filter(Boolean).join(" · ") || "(요약 추출 실패)";
}

console.log("| # | 파일 | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
console.log("| --- | --- | --- | --- | --- | --- |");

/**
 * **문법 오류로 죽은 RED 는 무효다.** 파서가 잡은 것을 테스트가 잡았다고 세면 방어력을 부풀린다
 * — 이 스크립트의 두 번째 판이 실제로 그렇게 틀렸다(`try` 만 남기고 `catch` 를 지웠다).
 */
const INVALID_RED = /Transform failed|SyntaxError|Parse failure|Expected .* but found/i;

let survivors = 0;
let invalid = 0;
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf8");
  const edits = mutation.edits ?? [[mutation.from, mutation.to]];
  let mutated = original;
  let anchored = true;
  for (const [from, to] of edits) {
    if (!mutated.includes(from)) anchored = false;
    else mutated = mutated.replace(from, to);
  }
  if (!anchored) {
    console.log(
      `| ${mutation.id} | — | ${mutation.what} | — | **앵커 없음** | 스크립트 갱신 필요 |`,
    );
    survivors += 1;
    continue;
  }
  writeFileSync(mutation.file, mutated);
  const result = mutation.oracle === "lint" ? runLint() : runTests();
  writeFileSync(mutation.file, original);

  if (result.failed && INVALID_RED.test(stripAnsi(result.output))) {
    invalid += 1;
    console.log(
      `| ${mutation.id} | — | ${mutation.what} | ${mutation.oracle} | **무효** | 문법 오류로 죽었다 — 테스트가 잡은 게 아니다 |`,
    );
    continue;
  }

  if (readFileSync(mutation.file, "utf8") !== original) throw new Error("원복 실패");

  const equivalent = KNOWN_EQUIVALENT.get(mutation.id);
  if (!result.failed && !equivalent) survivors += 1;

  const verdict = result.failed ? "**RED**" : equivalent ? "등가" : "**생존**";
  const evidence = result.failed ? summarize(mutation.oracle, result.output) : (equivalent ?? "—");
  const name = mutation.file === SHEET ? "RestTimerSheet.tsx" : "rest-feedback.ts";
  console.log(
    `| ${mutation.id} | \`${name}\` | ${mutation.what} | ${mutation.oracle} | ${verdict} | ${evidence} |`,
  );
}

const red = MUTATIONS.length - KNOWN_EQUIVALENT.size - survivors - invalid;
console.log(
  `\n${MUTATIONS.length}건 중 RED ${red}건 · 등가 ${KNOWN_EQUIVALENT.size}건 · ` +
    `무효 ${invalid}건 · **미방어 생존 ${survivors}건**.`,
);
if (survivors > 0 || invalid > 0) process.exitCode = 1;
