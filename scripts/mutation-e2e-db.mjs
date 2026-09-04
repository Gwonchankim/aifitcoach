/* global process, console, URL */
/**
 * E2E 전용 DB 하네스(`apps/web/e2e/db-url.ts`)의 뮤테이션 표.
 *
 * 이 파일은 **서버가 뜨기 전에** 잘못된 접속 URL 을 막는 것이 일이다. 그런데 그 종류의 가드는
 * "테스트가 통과한다"로는 증명되지 않는다 — 실제로 protocol 을 보지 않아 이름이 `_e2e` 로 끝나는
 * `https://…` 가 설정 import 를 exit 0 으로 통과했고(독립 리뷰 실측), 그때도 표는 전부 초록이었다.
 * 그래서 가드를 하나씩 무력화해 **어떤 테스트가 잡는지** 기록한다(CLAUDE.md 함정 5).
 *
 *   node scripts/mutation-e2e-db.mjs
 *
 * 오라클은 `test/e2e-db-url.test.ts` 하나다. 그 안에 단위 검사뿐 아니라 **실제 Playwright 설정
 * import**(`playwright test --list`)가 들어 있어, 가드가 죽으면 config 가 exit 0 으로 통과하는 것까지
 * 같은 실행에서 잡힌다. 서버는 띄우지 않으므로 DB 도 포트도 쓰지 않는다.
 *
 * 변형은 **동작만** 바꾼다(`&& false`, 값 치환). 문장이나 import 모양을 함께 바꾸면 빌드가 먼저
 * 죽었을 때와 테스트가 잡았을 때를 구분할 수 없다 — T1 #20 에서 실제로 겪었다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "apps", "web");
const TARGET = join(WEB_DIR, "e2e", "db-url.ts");
const SPEC = "test/e2e-db-url.test.ts";
const VITEST = join(
  dirname(createRequire(join(WEB_DIR, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitStatus = () =>
  execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", shell: false });

/** 실패 표식과 무효 표식을 나눠 본다 — 종료 코드만 보면 변환 실패가 제품 RED 로 둔갑한다. */
const RED = /Tests\s+\d+ failed|Test Files\s+\d+ failed/;
const INVALID = /Transform failed|SyntaxError|Failed to load|Cannot find module/i;

function runOracle() {
  try {
    execFileSync(process.execPath, [VITEST, "run", SPEC], {
      cwd: WEB_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.replace(ANSI, "");
    // 출력이 한 글자도 없으면 명령이 돌지 않은 것이다. "테스트가 잡았다"로 세지 않는다.
    if (!output.trim()) throw new Error(`오라클 실행 실패: ${error.message}`);
    return { failed: true, output };
  }
}

/** @type {{id:number,what:string,edits:[string,string][]}[]} */
const MUTATIONS = [
  {
    id: 1,
    what: "**protocol 허용목록 무력화** — `https://…/x_e2e` 가 서버 기동 명령까지 간다",
    edits: [
      [
        "  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {",
        "  if (!ALLOWED_PROTOCOLS.has(url.protocol) && false) {",
      ],
    ],
  },
  {
    id: 2,
    what: "전용 DB 판정 무력화 — 개발 `afc`·api `_test` 가 통과한다",
    edits: [['  if (!name.endsWith("_e2e")) {', '  if (!name.endsWith("_e2e") && false) {']],
  },
  {
    id: 3,
    what: "파싱 실패를 감싸지 않고 원본 예외를 그대로 던짐 — `input` 으로 원문이 샌다",
    edits: [
      [
        "  } catch {\n    throw new Error(\n" +
          '      "AFC_E2E_DB_URL_INVALID: 접속 URL 을 해석하지 못했다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",\n' +
          "    );\n  }",
        "  } catch (error) {\n    throw error;\n  }",
      ],
    ],
  },
  {
    id: 4,
    what: "원본 예외를 `cause` 로 부착 — 메시지는 깨끗한데 직렬화에서 원문이 샌다",
    edits: [
      [
        "  } catch {\n    throw new Error(\n" +
          '      "AFC_E2E_DB_URL_INVALID: 접속 URL 을 해석하지 못했다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",\n' +
          "    );",
        "  } catch (error) {\n    throw new Error(\n" +
          '      "AFC_E2E_DB_URL_INVALID: 접속 URL 을 해석하지 못했다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",\n' +
          "      { cause: error },\n    );",
      ],
    ],
  },
  {
    id: 5,
    what: "DB 이름 없음 메시지에 원문 보간 복원 — 접속 URL 전체가 로그에 남는다",
    edits: [
      [
        "    throw new Error(\n" +
          '      "AFC_E2E_DB_URL_NO_NAME: 접속 URL 에 데이터베이스 이름이 없다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",\n' +
          "    );",
        "    throw new Error(`AFC_E2E_DB_URL_NO_NAME: ${raw}`);",
      ],
    ],
  },
  {
    id: 6,
    what: "`DIRECT_URL` 을 부모 값에 양보 — migration 만 개발 DB 로 갈린다",
    edits: [
      [
        "return { DATABASE_URL: url, DIRECT_URL: url, label:",
        "return { DATABASE_URL: url, DIRECT_URL: process.env.DIRECT_URL ?? url, label:",
      ],
    ],
  },
];

function applyEdits(source, edits) {
  let next = source;
  for (const [from, to] of edits) {
    if (!next.includes(from)) return null;
    next = next.replace(from, to);
  }
  return next;
}

/**
 * 한 회차. 오라클이 던지든 통과하든 **원본으로 되돌리고 sha256 까지 대조한 뒤** 넘어간다.
 * 복원을 `finally` 에 넣지 않는다 — 거기서 던지면 오라클이 낸 진짜 실패가 가려진다.
 */
function runOnce(mutated) {
  const original = readFileSync(TARGET, "utf8");
  const originalSha = sha256(original);
  let result;
  let failure = null;
  try {
    writeFileSync(TARGET, mutated);
    result = runOracle();
  } catch (error) {
    failure = error;
  }

  writeFileSync(TARGET, original);
  const restoredSha = sha256(readFileSync(TARGET, "utf8"));
  if (restoredSha !== originalSha) {
    throw new Error(`복원 실패: ${relative(ROOT, TARGET)} sha ${restoredSha} != ${originalSha}`);
  }
  if (failure) throw failure;
  return result;
}

function main() {
  const statusBefore = gitStatus();

  process.stdout.write("baseline … ");
  const baseline = runOracle();
  if (baseline.failed) {
    console.log("실패");
    console.log(baseline.output.split("\n").slice(-25).join("\n"));
    throw new Error("clean baseline 이 green 이 아니다. 표를 만들 수 없다.");
  }
  console.log("green");

  console.log("\n| # | 주입한 결함 | 결과 | 잡아낸 근거 |");
  console.log("| --- | --- | --- | --- |");

  let red = 0;
  let survivors = 0;
  let invalid = 0;

  for (const mutation of MUTATIONS) {
    const mutated = applyEdits(readFileSync(TARGET, "utf8"), mutation.edits);
    if (mutated === null) {
      invalid += 1;
      console.log(`| ${mutation.id} | ${mutation.what} | **앵커 없음** | 스크립트 갱신 필요 |`);
      continue;
    }

    const result = runOnce(mutated);
    let verdict;
    let evidence;
    if (!result.failed) {
      verdict = "**생존**";
      evidence = "—";
      survivors += 1;
    } else if (INVALID.test(result.output) || !RED.test(result.output)) {
      verdict = "**무효**";
      evidence = `문법·변환 실패 — 테스트가 잡은 게 아니다(${
        INVALID.exec(result.output)?.[0] ?? "실패 표식 없음"
      })`;
      invalid += 1;
    } else {
      verdict = "**RED**";
      evidence =
        [
          /Tests\s+(\d+ failed[^\n|]*)/.exec(result.output)?.[1]?.trim(),
          /FAIL[^\n]*?>[^\n]*?>\s*([^\n]+)/.exec(result.output)?.[1]?.trim(),
        ]
          .filter(Boolean)
          .join(" · ") || "실패";
      red += 1;
    }
    console.log(`| ${mutation.id} | ${mutation.what} | ${verdict} | ${evidence} |`);
  }

  console.log(
    `\n${MUTATIONS.length}건 중 RED ${red} · 무효 ${invalid} · **미방어 생존 ${survivors}**.`,
  );

  const statusAfter = gitStatus();
  const clean = statusAfter === statusBefore;
  console.log(
    clean
      ? "residue 0 — `git status --porcelain` 이 실행 전과 동일하다."
      : "**residue 발견** — 실행 전후 `git status` 가 다르다.",
  );
  if (!clean) console.log(`--- before ---\n${statusBefore}--- after ---\n${statusAfter}`);
  if (survivors > 0 || invalid > 0 || !clean) process.exitCode = 1;
}

main();
