/* global process, console, URL */
/**
 * T1(휴식 종료 피드백) 뮤테이션 표.
 *
 * "전부 통과"는 방어를 증명하지 않는다 — 분기를 지워도 통과하는 테스트가 실제로 있었다
 * (CLAUDE.md 함정 5). 그래서 핵심 분기를 하나씩 **고의로 망가뜨려** 어떤 테스트가 잡는지 기록한다.
 *
 *   node scripts/mutation-t1.mjs             전체 표
 *   node scripts/mutation-t1.mjs --unit      단위·lint 오라클만(빠름)
 *   node scripts/mutation-t1.mjs --self-test 복원 보장 자체 검증(fault injection)
 *
 * ## 이 러너가 스스로를 못 믿는 지점 셋
 *
 * 1. **오라클이 실행조차 안 됐을 때.** Windows 에서 `pnpm.cmd` 를 `shell:false` 로 spawn 하면
 *    `EINVAL` 이라 명령이 돌지도 않았는데 예외가 난다 — 첫 판이 그렇게 16건 전부 거짓 RED 였다.
 *    그래서 JS 진입점을 resolve 해 `node` 로 직접 띄우고, 출력이 비면 **RED 가 아니라 오류**로 다룬다.
 * 2. **문법·빌드 오류로 죽었을 때.** 파서가 잡은 걸 테스트가 잡았다고 세면 방어력이 부풀려진다 —
 *    두 번째 판이 `try` 만 남기고 `catch` 를 지워 3건을 그렇게 틀렸다. 이제 무효로 분류한다.
 * 3. **주입 전 트리가 이미 빨갰을 때.** 그러면 무엇을 주입해도 RED 라 표 전체가 의미를 잃는다.
 *    그래서 쓰는 오라클마다 **clean baseline 을 먼저 green 으로 확인**하고 시작한다.
 *
 * 복원은 `try/finally` 로 보장하고 매번 원본 sha256 과 대조한다. `--self-test` 가 그 보장을
 * 실제로 증명한다 — 오라클이 중간에 던지도록 만들어 놓고 파일이 원본으로 돌아오는지 본다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "apps", "web");
const FEEDBACK = join(WEB_DIR, "lib", "rest-feedback.ts");
const SHEET = join(WEB_DIR, "components", "session", "RestTimerSheet.tsx");
const SCREEN = join(WEB_DIR, "components", "session", "SessionScreen.tsx");

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/* ------------------------------------------------------------------ *
 * 오라클
 * ------------------------------------------------------------------ */

const requireFrom = (pkgJson) => createRequire(join(pkgJson, "package.json"));
const VITEST = join(dirname(requireFrom(WEB_DIR).resolve("vitest/package.json")), "vitest.mjs");
const ESLINT = join(dirname(requireFrom(ROOT).resolve("eslint/package.json")), "bin", "eslint.js");
const PLAYWRIGHT = join(
  dirname(requireFrom(WEB_DIR).resolve("@playwright/test/package.json")),
  "cli.js",
);

class OracleLaunchError extends Error {}

function spawn(args, cwd) {
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
    const output = stripAnsi(`${error.stdout ?? ""}${error.stderr ?? ""}`);
    // 출력이 한 글자도 없으면 명령이 돌지 않은 것이다. "테스트가 잡았다"로 세지 않는다.
    if (!output.trim()) throw new OracleLaunchError(`오라클 실행 실패: ${error.message}`);
    return { failed: true, output };
  }
}

/**
 * 오라클마다 **실패를 알아보는 표식**을 따로 둔다. 종료 코드만 보면 빌드 실패·설정 오류가
 * 제품 RED 로 둔갑한다. `invalid` 에 걸리면 그 회차는 무효다.
 */
const ORACLES = {
  unit: {
    label: "unit",
    run: () => spawn([VITEST, "run", "test/rest-feedback.test.ts"], WEB_DIR),
    red: /Tests\s+\d+ failed|Test Files\s+\d+ failed/,
    invalid: /Transform failed|SyntaxError|Failed to load|Cannot find module/i,
    summarize: (out) =>
      [
        /Tests\s+(\d+ failed[^\n|]*)/.exec(out)?.[1]?.trim(),
        /FAIL[^\n]*?>[^\n]*?>\s*([^\n]+)/.exec(out)?.[1]?.trim(),
      ]
        .filter(Boolean)
        .join(" · "),
  },
  lint: {
    label: "lint",
    run: () => spawn([ESLINT, relative(ROOT, SHEET)], ROOT),
    red: /\d+\s+error/,
    invalid: /Parsing error|Failed to load config/i,
    summarize: (out) =>
      /react-hooks\/exhaustive-deps/.test(out)
        ? "eslint react-hooks/exhaustive-deps"
        : (/error\s+(.+)/.exec(out)?.[1]?.trim() ?? "lint 실패"),
  },
  e2e: {
    label: "e2e",
    run: () =>
      spawn(
        [
          PLAYWRIGHT,
          "test",
          "e2e/12-rest-feedback.spec.ts",
          "--project=chromium-mobile",
          "--workers=1",
          "--reporter=line",
        ],
        WEB_DIR,
      ),
    red: /\d+ failed/,
    // 웹 서버는 매 실행마다 새로 빌드한다 → 타입·컴파일 오류는 제품 RED 가 아니라 무효다.
    invalid: /Failed to compile|error TS\d+|Type error|webServer.*did not start/i,
    summarize: (out) =>
      [
        /(\d+ failed)/.exec(out)?.[1],
        /›\s*([^\n›]+?)\s*$/m.exec(/✘[^\n]*\n?/.exec(out)?.[0] ?? "")?.[1] ??
          /expect\([^)]*\)\.(\w+)/.exec(out)?.[0],
      ]
        .filter(Boolean)
        .join(" · "),
  },
};

/* ------------------------------------------------------------------ *
 * 뮤테이션
 * ------------------------------------------------------------------ */

/** @type {{id:number,file:string,what:string,edits:[string,string][],oracle:keyof ORACLES}[]} */
const MUTATIONS = [
  {
    id: 1,
    file: FEEDBACK,
    what: "같은 endsAt 재신호를 막는 정체성 가드 제거",
    edits: [["if (!finished || signaledEndsAt === endsAt) return;", "if (!finished) return;"]],
    oracle: "unit",
  },
  {
    id: 2,
    file: FEEDBACK,
    what: "종료 여부 확인 제거 — 진행 중에도 울린다",
    edits: [
      [
        "if (!finished || signaledEndsAt === endsAt) return;",
        "if (signaledEndsAt === endsAt) return;",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 3,
    file: FEEDBACK,
    what: "정체성 기록을 빠뜨림 — 게이트가 영원히 열린다",
    edits: [["    signaledEndsAt = endsAt;\n", ""]],
    oracle: "unit",
  },
  {
    id: 4,
    file: FEEDBACK,
    what: "억제한 타이머의 정체성을 소비하지 않음 — 복귀 뒤 늦게 울린다",
    edits: [
      [
        "    signaledEndsAt = endsAt;\n    if (visibleSince === null || endsAt < visibleSince) return;",
        "    if (visibleSince === null || endsAt < visibleSince) return;\n    signaledEndsAt = endsAt;",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 5,
    file: FEEDBACK,
    what: "전경 판정 제거 — 백그라운드에서 끝나도 울린다",
    edits: [["    if (visibleSince === null || endsAt < visibleSince) return;\n", ""]],
    oracle: "unit",
  },
  {
    id: 6,
    file: FEEDBACK,
    what: "숨은 상태(null) 판정만 제거",
    edits: [
      [
        "if (visibleSince === null || endsAt < visibleSince) return;",
        "if (visibleSince !== null && endsAt < visibleSince) return;",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 7,
    file: FEEDBACK,
    what: "**P1** suspended 컨텍스트 판정 제거 — 늦게 재생될 음원을 예약한다",
    edits: [['if (!context || context.state !== "running") return;', "if (!context) return;"]],
    oracle: "unit",
  },
  {
    id: 8,
    file: FEEDBACK,
    what: "unlock 의 단일 컨텍스트 보장 제거(??= → =)",
    edits: [["context ??= new Ctor();", "context = new Ctor();"]],
    oracle: "unit",
  },
  {
    id: 9,
    file: FEEDBACK,
    what: "suspended 판정 제거 — running 에서도 resume 을 부른다",
    edits: [
      [
        'if (context.state === "suspended") context.resume().catch(() => {});',
        "context.resume().catch(() => {});",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 10,
    file: FEEDBACK,
    what: "비프 길이 상수 변경(120 → 200ms)",
    edits: [["durationMs: 120", "durationMs: 200"]],
    oracle: "unit",
  },
  {
    id: 11,
    file: FEEDBACK,
    what: "진동 패턴 상수 변경([120] → [400])",
    edits: [
      [
        "export const REST_VIBRATE_PATTERN_MS: readonly number[] = [120];",
        "export const REST_VIBRATE_PATTERN_MS: readonly number[] = [400];",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 12,
    file: FEEDBACK,
    what: "진동 패턴 복사 제거 — 상수를 그대로 넘긴다",
    edits: [
      [
        "navigator.vibrate([...REST_VIBRATE_PATTERN_MS]);",
        "navigator.vibrate(REST_VIBRATE_PATTERN_MS as number[]);",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 13,
    file: FEEDBACK,
    what: "비프 실패 격리 제거 — 예외가 위로 샌다",
    // `catch` 만 지우면 `try` 가 짝을 잃어 문법 오류다. 블록을 통째로 평범한 블록으로 바꾼다.
    edits: [
      ["  try {\n    const oscillator", "  {\n    const oscillator"],
      ["  } catch {\n    // 무음으로 떨어진다.\n  }", "  }"],
    ],
    oracle: "unit",
  },
  {
    id: 14,
    file: FEEDBACK,
    what: "진동 실패 격리 제거 — 권한 거부가 위로 샌다",
    edits: [
      ["  try {\n    // 복사본을", "  {\n    // 복사본을"],
      ["  } catch {\n    // 진동 없이 지나간다.\n  }", "  }"],
    ],
    oracle: "unit",
  },
  {
    id: 15,
    file: FEEDBACK,
    what: "unlock 실패 격리 제거",
    edits: [
      ["  try {\n    // 조회까지", "  {\n    // 조회까지"],
      ["  } catch {\n    context = null;\n  }", "  }"],
    ],
    oracle: "unit",
  },
  {
    id: 16,
    file: FEEDBACK,
    what: "AudioContext 조회를 try 밖으로 되돌림 — 접근 예외가 새어 나간다",
    edits: [
      [
        "  try {\n    // 조회까지 try 안이다 — `globalThis.AudioContext` 는 접근만으로 던질 수 있다(정책·확장 프로그램).\n    const Ctor = audioContextCtor();\n    if (!Ctor) return;\n    context ??= new Ctor();",
        "  const Ctor = audioContextCtor();\n  if (!Ctor) return;\n  try {\n    context ??= new Ctor();",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 17,
    file: FEEDBACK,
    what: "vibrate 지원 여부 확인 제거",
    edits: [
      [
        'if (typeof navigator?.vibrate !== "function") return;',
        "if (navigator === undefined) return;",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 18,
    file: FEEDBACK,
    what: "AudioContext 지원 여부 확인 제거",
    edits: [
      [
        'return typeof globalThis.AudioContext === "function" ? globalThis.AudioContext : null;',
        "return globalThis.AudioContext;",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 19,
    file: SHEET,
    what: "이펙트 의존성에서 finished·endsAt 제거 — 종료를 관측하지 못한다",
    edits: [["  }, [open, finished, timer.endsAt]);", "  }, [open]);"]],
    oracle: "lint",
  },
  /* --- call-site 배선. 단위 테스트로는 절대 잡히지 않는 축이다(리뷰 P2-1). --- */
  {
    id: 20,
    file: SCREEN,
    what: "**call-site** 세트 완료에서 unlock 호출 삭제",
    // 임포트도 같이 지운다 — 남기면 빌드가 죽어 "무효"가 되고 아무것도 증명하지 못한다.
    edits: [
      ['import { unlockRestFeedback } from "../../lib/rest-feedback";\n', ""],
      ["    unlockRestFeedback();\n", ""],
    ],
    oracle: "e2e",
  },
  {
    id: 21,
    file: SCREEN,
    what: "**call-site** unlock 을 첫 await 뒤로 이동 — 제스처 밖이 된다",
    edits: [
      [
        "    unlockRestFeedback();\n    try {\n      await completeSetInStore(set.id, values);",
        "    try {\n      await completeSetInStore(set.id, values);\n      unlockRestFeedback();",
      ],
    ],
    oracle: "e2e",
  },
  {
    id: 22,
    file: SHEET,
    what: "**call-site** 타이머 시트의 종료 신호 호출 삭제",
    edits: [
      [
        "    signalRef.current?.({\n      finished,\n      endsAt: timer.endsAt,\n      visibleSince: visibleSinceRef.current,\n    });\n",
        "",
      ],
    ],
    oracle: "e2e",
  },
];

/**
 * **등가 뮤턴트.** 관측 가능한 동작이 원본과 같아 어떤 테스트로도 죽일 수 없는 것들.
 * 이유는 하나다 — fail-soft `try/catch` 가 그 분기를 이미 삼켜, 가드를 지워도 예외 경로로
 * 같은 결과(무음·무진동·무예외)에 닿는다. 가드는 **의도 표현**이지 동작 분기가 아니다.
 */
const KNOWN_EQUIVALENT = new Map([
  [17, "vibrate 미지원 → TypeError → vibrate 의 catch 가 삼킨다. 관측 결과 동일"],
  [18, "비함수 값이면 `new Ctor()` 가 던지고 unlock 의 catch 가 삼킨다. 관측 결과 동일"],
]);

/* ------------------------------------------------------------------ *
 * 실행
 * ------------------------------------------------------------------ */

function applyEdits(source, edits) {
  let next = source;
  for (const [from, to] of edits) {
    if (!next.includes(from)) return null;
    next = next.replace(from, to);
  }
  return next;
}

/**
 * 한 회차. **오라클이 던지든 통과하든 원본으로 되돌리고**, 돌아온 내용이 sha256 까지 같은지
 * 확인한 뒤에야 다음으로 넘어간다.
 *
 * 복원과 검증을 `finally` 에 같이 넣지 않는다 — 거기서 던지면 오라클이 낸 **진짜 실패가 가려진다**
 * (`no-unsafe-finally`). 그래서 예외를 일단 붙잡아 두고, 복원·검증을 마친 뒤 그대로 다시 던진다.
 */
function runOnce(file, mutated, oracle) {
  const original = readFileSync(file, "utf8");
  const originalSha = sha256(original);
  let result;
  let failure = null;
  try {
    writeFileSync(file, mutated);
    result = oracle.run();
  } catch (error) {
    failure = error;
  }

  writeFileSync(file, original);
  const restoredSha = sha256(readFileSync(file, "utf8"));
  if (restoredSha !== originalSha) {
    throw new Error(`복원 실패: ${relative(ROOT, file)} sha ${restoredSha} != ${originalSha}`);
  }
  if (failure) throw failure;
  return result;
}

/** 주입 전 트리가 green 인지 확인한다. 이미 빨간 트리에서는 표 전체가 의미가 없다. */
function preflight(names) {
  for (const name of names) {
    const oracle = ORACLES[name];
    process.stdout.write(`baseline ${oracle.label} … `);
    const result = oracle.run();
    if (result.failed) {
      console.log("실패");
      console.log(result.output.split("\n").slice(-25).join("\n"));
      throw new Error(`clean baseline 이 green 이 아니다(${oracle.label}). 표를 만들 수 없다.`);
    }
    console.log("green");
  }
}

/**
 * **복원 보장 자체 검증.** 오라클이 실행 도중 던지도록 만들어 놓고, 파일이 원본으로 돌아오고
 * sha256 이 일치하는지 본다. 이 경로가 깨져 있으면 표가 아니라 워킹트리가 오염된다.
 */
function selfTest() {
  const original = readFileSync(FEEDBACK, "utf8");
  const originalSha = sha256(original);
  const boom = new Error("주입된 오라클 실패");
  let caught = null;
  try {
    runOnce(FEEDBACK, original + "\n// fault injection\n", {
      run: () => {
        // 오라클이 실행 중 파일이 확실히 변형돼 있는지 먼저 확인한다.
        if (readFileSync(FEEDBACK, "utf8") === original) throw new Error("변형이 적용되지 않았다");
        throw boom;
      },
    });
  } catch (error) {
    caught = error;
  }
  const after = readFileSync(FEEDBACK, "utf8");
  const ok = caught === boom && after === original && sha256(after) === originalSha;
  console.log(
    ok
      ? "self-test: 오라클이 던져도 원본이 복원됐고 sha256 이 일치한다 ✔"
      : `self-test 실패 — caught=${caught?.message} restored=${after === original}`,
  );
  if (!ok) process.exitCode = 1;
}

function main() {
  const unitOnly = process.argv.includes("--unit");
  if (process.argv.includes("--self-test")) return selfTest();

  const selected = MUTATIONS.filter((m) => !unitOnly || m.oracle !== "e2e");
  preflight([...new Set(selected.map((m) => m.oracle))]);

  console.log("\n| # | 파일 | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
  console.log("| --- | --- | --- | --- | --- | --- |");

  let red = 0;
  let survivors = 0;
  let invalid = 0;

  for (const mutation of selected) {
    const oracle = ORACLES[mutation.oracle];
    const name = relative(WEB_DIR, mutation.file).split(/[\\/]/).pop();
    const mutated = applyEdits(readFileSync(mutation.file, "utf8"), mutation.edits);
    if (mutated === null) {
      invalid += 1;
      console.log(
        `| ${mutation.id} | \`${name}\` | ${mutation.what} | — | **앵커 없음** | 스크립트 갱신 필요 |`,
      );
      continue;
    }

    const result = runOnce(mutation.file, mutated, oracle);
    const equivalent = KNOWN_EQUIVALENT.get(mutation.id);

    let verdict;
    let evidence;
    if (!result.failed) {
      verdict = equivalent ? "등가" : "**생존**";
      evidence = equivalent ?? "—";
      if (!equivalent) survivors += 1;
    } else if (oracle.invalid.test(result.output) || !oracle.red.test(result.output)) {
      verdict = "**무효**";
      evidence = "문법·빌드·설정 실패 — 테스트가 잡은 게 아니다";
      invalid += 1;
    } else {
      verdict = "**RED**";
      evidence = oracle.summarize(result.output) || "실패";
      red += 1;
    }
    console.log(
      `| ${mutation.id} | \`${name}\` | ${mutation.what} | ${oracle.label} | ${verdict} | ${evidence} |`,
    );
  }

  console.log(
    `\n${selected.length}건 중 RED ${red} · 등가 ${KNOWN_EQUIVALENT.size} · 무효 ${invalid} · **미방어 생존 ${survivors}**.`,
  );
  if (survivors > 0 || invalid > 0) process.exitCode = 1;
}

main();
