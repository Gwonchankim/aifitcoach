/* global process, console, URL */
/**
 * T2(휴식 타이머 지속·복구) 뮤테이션 표.
 *
 * "54개 통과"는 방어를 증명하지 않는다 — 분기를 지워도 통과하는 테스트가 실제로 있었다
 * (CLAUDE.md 함정 5). 핵심 분기를 하나씩 고의로 망가뜨려 어떤 테스트가 잡는지 기록하고,
 * 매번 원복해 sha256 으로 대조한다.
 *
 *   node scripts/mutation-t2.mjs
 *
 * ## 앞선 티켓에서 이 스크립트가 틀렸던 두 방식 — 둘 다 여기서 막는다
 *
 * 1. **`pnpm.cmd` 직접 spawn.** Windows 에서 `.cmd` 를 `shell: false` 로 띄우면 `EINVAL` 이라
 *    명령이 돌지도 않았는데 예외가 나서 전부 거짓 RED 가 됐다. → JS 진입점을 resolve 해 `node` 로 띄운다.
 * 2. **문법 오류로 죽은 RED.** `catch` 만 지우면 `try` 가 짝을 잃는다. 그건 파서가 잡은 것이지
 *    테스트가 잡은 게 아니다. → 블록을 통째로 바꾸고, 그래도 새면 `INVALID_RED` 가 무효로 표시한다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "apps", "web");
const STORE = join(WEB_DIR, "components", "session", "rest-timer-store.ts");
const NOTIFY = join(WEB_DIR, "lib", "rest-notification.ts");
const SHEET = join(WEB_DIR, "components", "session", "RestTimerSheet.tsx");

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);

const MUTATIONS = [
  {
    id: 1,
    file: STORE,
    what: "레코드 버전 확인 제거 — 모르는 모양을 읽는다",
    from: "if (record.v !== REST_TIMER_RECORD_VERSION) return null;",
    to: "if (false) return null;",
    oracle: "test",
  },
  {
    id: 2,
    file: STORE,
    what: "session_id 대조 제거 — 남의 세션 타이머를 올린다",
    from: "if (!isNonEmptyString(record.session_id) || record.session_id !== sessionId) return null;",
    to: "if (!isNonEmptyString(record.session_id)) return null;",
    oracle: "test",
  },
  {
    id: 3,
    file: STORE,
    what: "ends_at 검증 제거 — 문자열·0 도 통과",
    from: "if (!isPositiveInt(record.ends_at)) return null;",
    to: "if (false) return null;",
    oracle: "test",
  },
  {
    id: 4,
    file: STORE,
    what: "total_sec 상한 검사 제거",
    from: "    record.total_sec > REST_MAX_SEC\n",
    to: "    false\n",
    oracle: "test",
  },
  {
    id: 5,
    file: STORE,
    what: "planned_set_id 검증 제거",
    from: "if (!isNonEmptyString(record.planned_set_id)) return null;",
    to: "if (false) return null;",
    oracle: "test",
  },
  {
    id: 6,
    file: STORE,
    what: "stale 판정 부호 뒤집기 — 오래된 것을 살리고 새것을 버린다",
    from: "return now >= record.ends_at + REST_TIMER_STALE_AFTER_MS;",
    to: "return now < record.ends_at + REST_TIMER_STALE_AFTER_MS;",
    oracle: "test",
  },
  {
    id: 7,
    file: STORE,
    what: "stale 경계를 하루로 늘림",
    from: "export const REST_TIMER_STALE_AFTER_MS = REST_MAX_SEC * 1000;",
    to: "export const REST_TIMER_STALE_AFTER_MS = 86_400_000;",
    oracle: "test",
  },
  {
    id: 8,
    file: STORE,
    what: "거절한 기록을 지우지 않음 — 다음 마운트에서 또 만난다",
    from: "    await clearRestTimer(userId, sessionId);\n    return null;",
    to: "    return null;",
    oracle: "test",
  },
  {
    id: 9,
    file: STORE,
    what: "stale 검사를 복구 경로에서 빼기",
    from: "if (!record || isStaleRestTimer(record, now)) {",
    to: "if (!record) {",
    oracle: "test",
  },
  {
    id: 10,
    file: STORE,
    what: "JSON 파싱 실패 격리 제거 — 손상된 값이 위로 샌다",
    edits: [
      [
        "  try {\n    parsed = JSON.parse(raw);\n  } catch {\n    return null;\n  }",
        "  parsed = JSON.parse(raw);",
      ],
    ],
    oracle: "test",
  },
  {
    id: 11,
    file: STORE,
    what: "저장 실패 격리 제거 — 세트 기록이 막힌다",
    edits: [
      [
        "    try {\n      await sessionDb.syncMeta.put({",
        "    {\n      await sessionDb.syncMeta.put({",
      ],
      [
        "      return true;\n    } catch {\n      return false;\n    }",
        "      return true;\n    }\n    return false;",
      ],
    ],
    oracle: "test",
  },
  {
    id: 12,
    file: STORE,
    what: "읽기 실패 격리 제거",
    edits: [
      [
        "  try {\n    raw = (await sessionDb.syncMeta.get([userId, restTimerKeyFor(sessionId)]))?.value;\n  } catch {\n    return null;\n  }",
        "  raw = (await sessionDb.syncMeta.get([userId, restTimerKeyFor(sessionId)]))?.value;",
      ],
    ],
    oracle: "test",
  },
  {
    id: 13,
    file: STORE,
    what: "타이머 키를 F-4b marker 접두사로 바꾸기 — 네임스페이스 충돌",
    from: 'export const REST_TIMER_PREFIX = "rest-timer:";',
    to: 'export const REST_TIMER_PREFIX = "assistance-remediation:";',
    oracle: "test",
  },
  {
    id: 14,
    file: NOTIFY,
    what: "hidden 판정 제거 — 보고 있는데도 알린다",
    from: "if (!isHidden() || !permissionGranted()) return false;",
    to: "if (!permissionGranted()) return false;",
    oracle: "test",
  },
  {
    id: 15,
    file: NOTIFY,
    what: "권한 확인 제거 — denied/default 에서도 시도",
    from: "if (!isHidden() || !permissionGranted()) return false;",
    to: "if (!isHidden()) return false;",
    oracle: "test",
  },
  {
    id: 16,
    file: NOTIFY,
    what: "granted 비교를 느슨하게 — default 도 통과",
    from: 'return globalThis.Notification?.permission === "granted";',
    to: 'return globalThis.Notification?.permission !== "denied";',
    oracle: "test",
  },
  {
    id: 17,
    file: NOTIFY,
    what: "showNotification 존재 확인 제거",
    from: 'if (typeof registration?.showNotification !== "function") return false;',
    to: "if (!registration) return false;",
    oracle: "test",
  },
  {
    id: 18,
    file: NOTIFY,
    what: "알림 실패 격리 제거 — 예외가 화면으로 샌다",
    edits: [
      ["  try {\n    const container", "  {\n    const container"],
      [
        "    return true;\n  } catch {\n    // 미지원·거부·SW 미등록 전부 여기로 온다. 알림이 없을 뿐 기록과 화면은 그대로 간다.\n    return false;\n  }",
        "    return true;\n  }",
      ],
    ],
    oracle: "test",
  },
  {
    id: 19,
    file: NOTIFY,
    what: "잠금화면 문구에 운동명·중량을 넣기",
    from: "      body: REST_NOTIFICATION.body,",
    to: '      body: "벤치프레스 60kg 3세트 휴식이 끝났어요",',
    oracle: "test",
  },
  {
    id: 20,
    file: SHEET,
    what: "알림 중복 방지 제거 — 틱·focus·pageshow 마다 알린다",
    from: "    if (notifiedRef.current === timer.endsAt) return;",
    to: "    if (false) return;",
    oracle: "lint",
  },
  {
    id: 21,
    file: SHEET,
    what: "알림 이펙트 의존성에서 finished·endsAt 제거",
    from: "  }, [open, finished, timer.endsAt]);",
    to: "  }, [open]);",
    oracle: "lint",
  },

  /* ---- fixup P1-1: 세션별 쓰기 직렬화 ---- */
  {
    id: 22,
    file: STORE,
    what: "save 를 큐 밖으로 — 늦은 save 가 clear 를 앞지른다",
    edits: [
      [
        "  return enqueue(restTimerKeyFor(sessionId), async () => {\n    try {",
        "  return (async () => {\n    try {",
      ],
      ["      return false;\n    }\n  });\n}", "      return false;\n    }\n  })();\n}"],
    ],
    oracle: "test",
  },
  {
    id: 23,
    file: STORE,
    what: "clear 를 큐 밖으로",
    edits: [
      [
        "  await enqueue(restTimerKeyFor(sessionId), async () => {\n    try {",
        "  await (async () => {\n    try {",
      ],
      [
        "      // 다음 복구 시도에서 stale 로 걸린다.\n    }\n  });\n}",
        "      // 다음 복구 시도에서 stale 로 걸린다.\n    }\n  })();\n}",
      ],
    ],
    oracle: "test",
  },
  {
    id: 24,
    file: STORE,
    what: "큐를 전역 하나로 — 다른 세션이 서로를 막는다",
    from: "const previous = writeQueues.get(key) ?? Promise.resolve();",
    to: 'const previous = writeQueues.get("all") ?? Promise.resolve();',
    oracle: "test",
  },
  {
    id: 25,
    file: STORE,
    what: "실패 격리 제거 — 실패한 작업이 큐를 영영 막는다",
    from: "  const settled: Promise<void> = run.then(forget, forget);",
    to: "  const settled: Promise<void> = run.then(forget);",
    oracle: "test",
  },
  {
    id: 26,
    file: STORE,
    what: "큐 찌꺼기 정리 제거 — 세션마다 항목이 쌓인다",
    from: "    if (writeQueues.get(key) === settled) writeQueues.delete(key);",
    to: "    /* 정리하지 않는다 */",
    oracle: "test",
  },

  /* ---- fixup P1-2: 복구 정체성 ---- */
  {
    id: 27,
    file: STORE,
    what: "begin 을 세션 무관 1회 플래그로 — 다음 세션을 영구 skip",
    from: "      if (attemptedFor === sessionId) return false;",
    to: "      if (attemptedFor !== null) return false;",
    oracle: "test",
  },
  {
    id: 28,
    file: STORE,
    what: "늦게 온 결과의 세션 확인 제거 — B 화면에 A 타이머를 얹는다",
    from: "  if (!coordinator.isCurrent(sessionId) || !stored) return;",
    to: "  if (!stored) return;",
    oracle: "test",
  },
  {
    id: 29,
    file: STORE,
    what: "복구 시 계획 세트 대조 제거",
    from: "  if (!plannedSetIds.includes(stored.plannedSetId)) {",
    to: "  if (false) {",
    oracle: "test",
  },
];

/**
 * **등가 뮤턴트.** 관측 동작이 원본과 같아 어떤 테스트로도 죽일 수 없는 것들. 숨기지 않고 표에 남긴다.
 *
 * 이유는 하나다 — fail-soft `try/catch` 가 그 분기를 이미 삼킨다. 존재 확인을 지워도 예외 경로로
 * 같은 결과(`false`, 예외 없음)에 도달한다. 가드는 **의도 표현**이지 동작 분기가 아니다.
 */
const KNOWN_EQUIVALENT = new Map([
  [17, "showNotification 이 없으면 호출이 TypeError → 바깥 catch 가 삼켜 false. 관측 결과 동일"],
  [
    25,
    "save·clear 둘 다 내부 try/catch 라 operation 이 reject 할 수 없다 → settled 도 reject 하지 않는다. " +
      "현 호출부로는 도달 불가. 미래 호출부를 위한 가드로 남긴다(제거하면 큐가 영구히 막힌다)",
  ],
]);

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
    // 실행 자체가 안 된 것은 "테스트가 잡았다"가 아니다.
    if (!output.trim()) throw new Error(`오라클을 실행하지 못했다: ${error.message}`);
    return { failed: true, output };
  }
}

const runTests = () =>
  run(
    [
      VITEST_ENTRY,
      "run",
      "test/rest-timer-persistence.test.ts",
      "test/rest-notification.test.ts",
      "test/rest-timer-ordering.test.ts",
    ],
    WEB_DIR,
  );
const runLint = () => run([ESLINT_ENTRY, "apps/web/components/session/RestTimerSheet.tsx"], ROOT);

const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");

/**
 * 문법 오류로 죽은 RED 는 무효다 — 파서가 잡은 것을 테스트 방어력으로 세면 안 된다.
 *
 * **`SyntaxError` 를 넣으면 안 된다.** JSON 파싱 격리를 지우는 뮤테이션은 테스트가 런타임
 * `SyntaxError` 를 잡아서 RED 가 되는데, 그걸 "파일이 안 읽혔다"로 오인해 무효 처리했다(실측).
 * 파일을 못 읽은 경우에만 나오는 문구로 좁힌다.
 */
const INVALID_RED = /Transform failed|Failed to (?:load|parse)|error TS\d+/i;

function summarize(oracle, output) {
  const stripped = stripAnsi(output);
  if (oracle === "lint") {
    return /react-hooks\/exhaustive-deps/.test(stripped)
      ? "eslint react-hooks/exhaustive-deps"
      : (/error\s+(.*)/.exec(stripped)?.[1]?.trim() ?? "(lint 실패)");
  }
  const counts = /Tests\s+(\d+ failed[^\n|]*)/.exec(stripped)?.[1]?.trim();
  const first =
    /FAIL[^\n]*?>[^\n]*?>\s*([^\n]+)/.exec(stripped)?.[1]?.trim() ??
    /(?:AssertionError|Error):\s*([^\n]+)/.exec(stripped)?.[1]?.trim();
  return [counts, first].filter(Boolean).join(" · ") || "(요약 추출 실패)";
}

const NAMES = new Map([
  [STORE, "rest-timer-store.ts"],
  [NOTIFY, "rest-notification.ts"],
  [SHEET, "RestTimerSheet.tsx"],
]);

console.log("| # | 파일 | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
console.log("| --- | --- | --- | --- | --- | --- |");

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
  if (readFileSync(mutation.file, "utf8") !== original) throw new Error("원복 실패");

  if (result.failed && INVALID_RED.test(stripAnsi(result.output))) {
    invalid += 1;
    console.log(
      `| ${mutation.id} | — | ${mutation.what} | ${mutation.oracle} | **무효** | 문법·타입 오류로 죽었다 |`,
    );
    continue;
  }

  const equivalent = KNOWN_EQUIVALENT.get(mutation.id);
  if (!result.failed && !equivalent) survivors += 1;

  const verdict = result.failed ? "**RED**" : equivalent ? "등가" : "**생존**";
  const evidence = result.failed ? summarize(mutation.oracle, result.output) : (equivalent ?? "—");
  console.log(
    `| ${mutation.id} | \`${NAMES.get(mutation.file)}\` | ${mutation.what} | ${mutation.oracle} | ${verdict} | ${evidence} |`,
  );
}

const red = MUTATIONS.length - KNOWN_EQUIVALENT.size - survivors - invalid;
console.log(
  `\n${MUTATIONS.length}건 중 RED ${red}건 · 등가 ${KNOWN_EQUIVALENT.size}건 · ` +
    `무효 ${invalid}건 · **미방어 생존 ${survivors}건**.`,
);
if (survivors > 0 || invalid > 0) process.exitCode = 1;
