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
 * 4. **"복원했다"를 대상 파일 하나로만 주장했을 때.** E2E 오라클은 추적 산출물
 *    `axe-results.jsonl` 을 지운다. 대상 SHA 만 맞추고 끝내니 성공 종료 후에도 `D` 가 남았다.
 *    이제 오라클의 부수효과까지 바이트로 되돌리고, 끝에 `git status` 전후 동일까지 단언한다.
 *
 * 복원은 예외를 붙잡아 두었다가 되돌린 뒤 다시 던지는 방식이다 — `finally` 에서 던지면
 * 오라클이 낸 진짜 실패가 가려진다. 매번 원본 sha256 과 대조하고, `--self-test` 가 그 보장을
 * 실제로 증명한다: 오라클이 중간에 던지면서 추적 산출물까지 지우게 해 놓고 전부 돌아오는지 본다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "apps", "web");
const FEEDBACK = join(WEB_DIR, "lib", "rest-feedback.ts");
const GATE = join(WEB_DIR, "lib", "rest-completion.ts");
const SHEET = join(WEB_DIR, "components", "session", "RestTimerSheet.tsx");
const SCREEN = join(WEB_DIR, "components", "session", "SessionScreen.tsx");

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** 표 한 칸에 넣는다 — 줄바꿈과 `|` 를 지워야 마크다운 표가 안 깨진다. */
const cell = (text) => text.replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 110);

/** 출력의 마지막 의미 있는 줄. 오라클이 테스트까지 못 간 이유는 대개 여기 있다. */
const lastLine = (output) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "출력 없음";

/* ------------------------------------------------------------------ *
 * 오라클의 부수효과 — 뮤테이션 대상만 되돌리면 부족하다
 * ------------------------------------------------------------------ */

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", shell: false });
}

/** 워킹트리 전체 상태. 실행 전후가 **문자 단위로 같아야** residue 0 이다. */
const gitStatus = () => git(["status", "--porcelain"]);

/**
 * E2E 오라클이 덮어쓰거나 지우는 **추적 산출물**.
 *
 * `e2e/global-setup.ts` 는 실행을 시작할 때마다 `axe-results.jsonl` 을 지우는데 그걸 다시 만드는 건
 * `05-a11y` 뿐이다. 우리는 spec 하나만 오라클로 돌리므로 **성공해도 삭제된 채로 남는다**
 * (실측: 오라클 4 passed 직후 `D apps/web/e2e/axe-results.jsonl`). 스크린샷도 같은 부류다.
 *
 * 그래서 대상 소스뿐 아니라 이 산출물들도 **바이트 그대로** 되돌린다.
 */
function e2eOutputScope() {
  return git(["ls-files", "--", "apps/web/e2e/axe-results.jsonl", "apps/web/e2e/screenshots"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((relativePath) => join(ROOT, relativePath));
}

/**
 * 현재 바이트를 그대로 담는다. **`git checkout` 을 쓰지 않는다** — 그러면 다른 작업자의
 * 미커밋 변경을 커밋 버전으로 덮어쓴다. 지금 있는 그대로를 되돌리는 것이 목적이다.
 * 파일이 **없는 상태**도 값(`null`)으로 기록해 그대로 복원한다.
 */
function snapshotFiles(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

/** 스냅샷과 달라진 것만 되돌린다. 되돌린 경로를 반환한다(보고용). */
function restoreFiles(snapshot) {
  const restored = [];
  for (const [path, bytes] of snapshot) {
    const current = existsSync(path) ? readFileSync(path) : null;
    if (bytes === null) {
      if (current !== null) {
        rmSync(path);
        restored.push(path);
      }
      continue;
    }
    if (current === null || !current.equals(bytes)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      restored.push(path);
    }
  }
  return restored;
}

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
    run: () =>
      spawn(
        [VITEST, "run", "test/rest-feedback.test.ts", "test/rest-completion-gate.test.ts"],
        WEB_DIR,
      ),
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
  /**
   * **배선** 오라클. 실제로 렌더한 `SessionScreen` 으로 "게이트가 고른 싱크가 정말 불리는가"를 본다.
   * 단위 오라클은 규칙만 보므로 호출부를 통째로 지워도 통과한다.
   */
  wiring: {
    label: "wiring",
    run: () => spawn([VITEST, "run", "test/rest-completion-wiring.test.tsx"], WEB_DIR),
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
    // 이 오라클은 추적 산출물을 지우거나 덮어쓴다. 회차마다 바이트 그대로 되돌린다.
    sideEffects: e2eOutputScope(),
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
    file: GATE,
    what: "같은 정체성 재관측을 막는 가드 제거 — 틱마다 울린다",
    edits: [["if (consumed.has(identity)) return;", "if (false) return;"]],
    oracle: "unit",
  },
  {
    id: 2,
    file: GATE,
    what: "종료 여부 확인 제거 — 진행 중 관측도 그대로 fan-out 한다",
    edits: [
      [
        "    if (!observation.finished) {\n      armed.add(identity);\n      return;\n    }\n\n    consumed.add(identity);",
        "    armed.add(identity);\n\n    consumed.add(identity);",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 3,
    file: GATE,
    what: "정체성 기록을 빠뜨림 — 게이트가 영원히 열린다",
    edits: [["    consumed.add(identity);\n", ""]],
    oracle: "unit",
  },
  {
    id: 4,
    file: GATE,
    what: "**장전되지 않은 종료를 소비하지 않음** — 뒤늦은 진행 중 관측이 게이트를 다시 연다",
    edits: [
      [
        "    consumed.add(identity);\n\n    // 장전된 적 없는 종료 = 이미 끝난 채로 들어온 기록이다. 소비만 하고 아무 신호도 내지 않는다\n    // (남겨 두면 다음 관측에서 늦게 울린다).\n    if (!armed.has(identity)) return;",
        "    if (!armed.has(identity)) return;\n    consumed.add(identity);",
      ],
    ],
    oracle: "unit",
  },
  {
    id: 5,
    file: GATE,
    what: "전경 판정 제거 — 복귀 전에 끝난 휴식도 비프를 낸다",
    edits: [["    if (endsAt < visibleSince) return;\n", ""]],
    oracle: "unit",
  },
  {
    id: 6,
    file: GATE,
    what: "숨김 분기 제거 — 숨은 채 끝나도 알림 대신 비프가 간다",
    edits: [
      [
        "      void runSafely(() => sinks.notifyHidden());",
        "      void runSafely(() => sinks.emitForeground());",
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
    edits: [["  }, [open, finished, timer.endsAt, onCompletionObserved]);", "  }, [open]);"]],
    oracle: "lint",
  },
  /* --- call-site 배선. 단위 테스트로는 절대 잡히지 않는 축이다(리뷰 P2-1). --- */
  {
    id: 20,
    file: SCREEN,
    what: "**call-site** 세트 완료에서 unlock **호출만** 제거(심볼은 그대로)",
    /**
     * `void` 로 심볼만 남긴다. 문장을 통째로 지우고 import 까지 좁히면 **모양이 여러 개 바뀐다** —
     * 그러면 빌드·lint 가 먼저 걸려 죽었을 때 그게 제품 결함을 잡은 건지 구분할 수 없다
     * (실제로 그 형태의 #20 이 무효로 재현됐다). `void f;` 는 타입·import·lint 를 원본과 똑같이
     * 유지하면서 **호출 한 번만** 없앤다 — 브라우저에서 AudioContext 가 안 열리는 것만 달라진다.
     */
    edits: [["    unlockRestFeedback();\n", "    void unlockRestFeedback;\n"]],
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
    what: "**call-site** 타이머 시트의 종료 관측 보고 삭제",
    edits: [
      [
        "    onCompletionObserved({ finished, endsAt: timer.endsAt, visibleSince: visibleSinceRef.current });\n",
        "",
      ],
    ],
    oracle: "e2e",
  },
  {
    id: 23,
    file: SCREEN,
    /**
     * 게이트가 "전경이다"라고 골라도 **실제로 이 싱크가 불리는가**. 숨김 쪽 배선은 T2 러너가
     * 보고(29번), 이쪽은 T1 의 몫이다. 게이트 규칙(6번)과 달리 여기서 겨누는 것은 배선이다.
     */
    what: "**call-site** 전경 싱크 배선 제거 — 게이트가 골라도 비프가 울리지 않는다",
    edits: [["    emitForeground: emitRestCompleteFeedback,", "    emitForeground: () => {},"]],
    oracle: "wiring",
  },
  {
    id: 24,
    file: GATE,
    what: "**arm 가드 제거** — 이미 끝난 채 복구된 타이머가 지난 휴식의 알림을 만든다",
    edits: [["    if (!armed.has(identity)) return;\n", ""]],
    oracle: "unit",
  },
  {
    id: 25,
    file: GATE,
    what: "진행 중 관측이 **장전하지 않는다** — 정상 만료가 통째로 침묵한다",
    edits: [["      armed.add(identity);\n", ""]],
    oracle: "unit",
  },
  {
    id: 27,
    file: GATE,
    /**
     * 24번과 같은 결함을 **배선 오라클**로 겨눈다. 단위 오라클은 규칙만 보므로
     * "세션 화면을 떠났다 돌아오면 저장분이 다시 울린다"를 실제 React 경로로 증명하지 못한다.
     */
    what: "**arm 가드 제거(배선)** — 화면을 떠났다 돌아오면 복구된 저장분이 다시 울린다",
    edits: [["    if (!armed.has(identity)) return;\n", ""]],
    oracle: "wiring",
  },
  {
    id: 26,
    file: GATE,
    what: "종료 관측도 장전한다 — arm 가드가 자기 자신을 통과시켜 무력해진다",
    edits: [
      [
        "    if (!observation.finished) {\n      armed.add(identity);\n      return;\n    }",
        "    armed.add(identity);\n    if (!observation.finished) return;",
      ],
    ],
    oracle: "unit",
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
 * 되돌리는 대상은 **주입한 파일만이 아니다.** 오라클이 지우거나 덮어쓴 추적 산출물까지 함께
 * 복원한다 — 대상 SHA 만 맞춰 놓고 저장소에 `D` 를 남기면 "복원됐다"가 거짓말이 된다.
 *
 * 복원과 검증을 `finally` 에 같이 넣지 않는다 — 거기서 던지면 오라클이 낸 **진짜 실패가 가려진다**
 * (`no-unsafe-finally`). 그래서 예외를 일단 붙잡아 두고, 복원·검증을 마친 뒤 그대로 다시 던진다.
 */
function runOnce(file, mutated, oracle) {
  const original = readFileSync(file, "utf8");
  const originalSha = sha256(original);
  // 오라클이 실제로 건드리는 산출물만 스냅샷한다(E2E 가 아니면 빈 목록이라 비용 0).
  const sideEffects = snapshotFiles(oracle.sideEffects ?? []);
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
  const restoredSideEffects = restoreFiles(sideEffects);
  if (restoredSha !== originalSha) {
    throw new Error(`복원 실패: ${relative(ROOT, file)} sha ${restoredSha} != ${originalSha}`);
  }
  if (failure) throw failure;
  return { ...result, restoredSideEffects };
}

/**
 * 주입 전 트리가 green 인지 확인한다. 이미 빨간 트리에서는 표 전체가 의미가 없다.
 * baseline 실행도 오라클의 부수효과를 남기므로 회차와 **같은 방식으로** 되돌린다.
 */
function preflight(names) {
  for (const name of names) {
    const oracle = ORACLES[name];
    process.stdout.write(`baseline ${oracle.label} … `);
    const sideEffects = snapshotFiles(oracle.sideEffects ?? []);
    let result;
    let failure = null;
    try {
      result = oracle.run();
    } catch (error) {
      failure = error;
    }
    restoreFiles(sideEffects);
    if (failure) throw failure;
    if (result.failed) {
      console.log("실패");
      console.log(result.output.split("\n").slice(-25).join("\n"));
      throw new Error(`clean baseline 이 green 이 아니다(${oracle.label}). 표를 만들 수 없다.`);
    }
    console.log("green");
  }
}

/**
 * **복원 보장 자체 검증(fault injection).**
 *
 * 오라클이 실행 도중 던지도록 만들어 놓고 세 가지를 본다: 주입한 파일이 바이트로 돌아오는가,
 * **오라클이 지운 추적 산출물이 되살아나는가**, 그리고 `git status --porcelain` 이 실행 전과
 * 문자 단위로 같은가. 마지막 하나가 없으면 "복원됐다"를 대상 파일 하나로만 주장하게 된다 —
 * 실제로 그 착각 때문에 성공 종료 후 `D axe-results.jsonl` 이 남았다.
 */
function selfTest() {
  const statusBefore = gitStatus();
  const original = readFileSync(FEEDBACK, "utf8");
  const originalSha = sha256(original);
  const scope = e2eOutputScope();
  const victim = scope.find((path) => path.endsWith("axe-results.jsonl")) ?? scope[0];
  const victimBytes = existsSync(victim) ? readFileSync(victim) : null;
  const boom = new Error("주입된 오라클 실패");
  let caught = null;

  try {
    runOnce(FEEDBACK, original + "\n// fault injection\n", {
      sideEffects: scope,
      run: () => {
        if (readFileSync(FEEDBACK, "utf8") === original) throw new Error("변형이 적용되지 않았다");
        // 실제 E2E global-setup 이 하는 짓을 그대로 흉내 낸다: 추적 산출물을 지운다.
        if (existsSync(victim)) rmSync(victim);
        throw boom;
      },
    });
  } catch (error) {
    caught = error;
  }

  const after = readFileSync(FEEDBACK, "utf8");
  const victimAfter = existsSync(victim) ? readFileSync(victim) : null;
  const victimRestored =
    victimBytes === null ? victimAfter === null : (victimAfter?.equals(victimBytes) ?? false);
  const statusAfter = gitStatus();
  const checks = {
    "주입 예외를 그대로 전달": caught === boom,
    "대상 파일 바이트 복원": after === original && sha256(after) === originalSha,
    "오라클이 지운 추적 산출물 복원": victimRestored,
    "git status 실행 전과 동일": statusAfter === statusBefore,
  };

  for (const [label, ok] of Object.entries(checks)) console.log(`  ${ok ? "✔" : "✘"} ${label}`);
  const allOk = Object.values(checks).every(Boolean);
  console.log(allOk ? "self-test 통과" : "self-test 실패");
  if (!allOk) {
    console.log(`--- status before ---\n${statusBefore}--- after ---\n${statusAfter}`);
    process.exitCode = 1;
  }
}

function main() {
  const unitOnly = process.argv.includes("--unit");
  if (process.argv.includes("--self-test")) return selfTest();

  const selected = MUTATIONS.filter((m) => !unitOnly || m.oracle !== "e2e");
  // 실행 **전** 상태를 잡아 둔다. 끝나고 이것과 문자 단위로 같지 않으면 residue 0 이 아니다.
  const statusBefore = gitStatus();
  preflight([...new Set(selected.map((m) => m.oracle))]);

  console.log("\n| # | 파일 | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
  console.log("| --- | --- | --- | --- | --- | --- |");

  let red = 0;
  let survivors = 0;
  let invalid = 0;
  /** 무효 회차의 원문. 표의 한 줄로는 인프라 실패와 false-red 를 구분할 수 없다. */
  const invalidNotes = [];

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
      /**
       * **무효도 이유가 두 가지다.** 빌드가 먼저 죽은 것과, 오라클이 테스트까지 가지도 못한 것
       * (포트 점유·서버 기동 실패 같은 인프라 문제)은 다르게 다뤄야 한다 — 한 줄로 뭉뚱그렸더니
       * #20 의 무효를 두고 "제품이 안 잡힌다"와 "환경이 죽었다"를 구분할 수 없었다.
       */
      const matched = oracle.invalid.exec(result.output)?.[0];
      verdict = "**무효**";
      evidence = matched
        ? `빌드·설정 실패(\`${cell(matched)}\`) — 테스트가 잡은 게 아니다`
        : `실패 표식 없음(테스트까지 못 갔다) — ${cell(lastLine(result.output))}`;
      invalidNotes.push({ id: mutation.id, oracle: oracle.label, output: result.output });
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

  // 무효 회차의 원문 꼬리를 **실행 로그에** 남긴다. 파일로 쓰면 residue 0 이 깨진다(추적되지 않는 파일도 status 에 뜬다).
  for (const note of invalidNotes) {
    console.log(`\n무효 #${note.id}(${note.oracle}) 원문 꼬리 —`);
    console.log(note.output.split("\n").slice(-20).join("\n"));
  }

  // **residue 0 을 주장하려면 저장소 전체를 봐야 한다.** 대상 파일 SHA 만 맞추고 끝내면
  // 오라클이 지운 추적 산출물이 그대로 남는다(이 러너가 실제로 그랬다).
  const statusAfter = gitStatus();
  const clean = statusAfter === statusBefore;
  console.log(
    clean
      ? "residue 0 — `git status --porcelain` 이 실행 전과 동일하다."
      : "**residue 발견** — 실행 전후 `git status` 가 다르다.",
  );
  if (!clean) {
    console.log(`--- before ---\n${statusBefore}--- after ---\n${statusAfter}`);
  }
  if (survivors > 0 || invalid > 0 || !clean) process.exitCode = 1;
}

main();
