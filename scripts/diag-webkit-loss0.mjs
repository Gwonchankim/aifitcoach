/* global process, console, URL */
/**
 * 간헐 E2E 실패 재현·증거 보존 harness.
 *
 * **재시도해서 green 만 보고하기 위한 도구가 아니다.** 반대다 — 실패를 **잡는 순간 멈추고**
 * 그 실행의 산출물을 고유 경로로 즉시 복사한다. Playwright 는 실행 시작 때 `.artifacts` 를
 * 비우므로, 계속 돌리면 다음 실행이 증거를 지운다(실제로 그렇게 한 번 잃었다).
 *
 * ## 사용
 *
 * ```
 * node scripts/diag-webkit-loss0.mjs <반복횟수> [full]
 * ```
 *
 * - 인자 없음/`single`: `09-offline-sync` loss-0 만 webkit-ios 로 반복(빠르지만 **약한 조건**).
 * - `full`: **전체 스위트 직렬 반복** — chromium 이 먼저 돌고 DB 가 누적되는, 실제로 실패했던 조건.
 *   간헐 실패를 쫓을 때는 이쪽을 쓴다.
 *
 * ## 산출물
 *
 * - 실패 시: `%TEMP%/afc-e2e-diag/run-N/` 에 `stdout.txt` 와 `artifacts/`(trace·screenshot·
 *   `idb-dump.json` 포함) 를 통째로 보존한다. **워크트리 밖**이라 repo 를 더럽히지 않는다.
 * - 항상: `%TEMP%/afc-e2e-diag/summary.json` 에 실행별 결과와 집계.
 *
 * `idb-dump.json` 은 `e2e/09-offline-sync.spec.ts` 의 **실패 전용** `afterEach` 가 만든다
 * (통과 경로 비용 0). drafts/outbox/sessions/syncMeta 와 화면 input 값이 들어 있어
 * draft 소실·ID 불일치·hydration timing 을 가를 수 있다.
 *
 * ## 종료 상태
 *
 * 실패가 하나라도 있으면 **artifact 와 summary 를 남긴 뒤** exit 1 이다.
 * 진단 프로세스가 성공으로 끝나면 CI 나 사람이 "괜찮았다"로 읽는다 — 실패는 실패로 끝나야 한다.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 반복 실행의 **순수 제어부**. 실제 Playwright 를 모른다 — `execute` 가 주입된다.
 * 그래서 결정적 fake executor 로 집계·중단·종료 상태를 검증할 수 있다.
 *
 * 집계는 전부 **실제 `results` 에서** 계산한다. `requested - failed` 같은 산술로 통과를 세면
 * **돌지도 않은 회차가 통과로 잡힌다** — 첫 실패에서 중단하는 harness 에서는 그게 곧 거짓 보고다.
 *
 * @param {object} options
 * @param {number} options.requested 요청한 반복 횟수
 * @param {(attempt: number) => { failed: boolean, output: string }} options.execute 한 회차 실행
 * @param {string} options.keepDir 산출물 보존 루트
 * @param {string} [options.artifactsDir] 실패 시 통째로 복사할 Playwright 산출물 경로
 * @param {(line: string) => void} [options.log]
 */
export function runDiagnostic({ requested, execute, keepDir, artifactsDir, log = () => {} }) {
  mkdirSync(keepDir, { recursive: true });
  const results = [];
  let firstFailureAt = null;

  for (let attempt = 1; attempt <= requested; attempt += 1) {
    const { failed, output } = execute(attempt);
    const summary = /\d+ (?:passed|failed).*/.exec(output)?.[0]?.trim() ?? "(요약 없음)";
    results.push({ attempt, failed, summary });
    log(`#${attempt} ${failed ? "FAIL" : "pass"}  ${summary}`);

    if (failed) {
      // **증거를 먼저 남기고 멈춘다.** 다음 실행이 `.artifacts` 를 비우기 전에 복사해야 한다.
      const target = join(keepDir, `run-${attempt}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "stdout.txt"), output);
      if (artifactsDir && existsSync(artifactsDir))
        cpSync(artifactsDir, join(target, "artifacts"), { recursive: true });
      log(`   ↳ 보존: ${target}`);
      firstFailureAt = attempt;
      log("   ↳ 첫 실패에서 중단한다(증거 보존 우선).");
      break;
    }
  }

  // **집계는 results 가 진실이다.** 실행되지 않은 회차는 통과도 실패도 아니다.
  const executed = results.length;
  const failed = results.filter((row) => row.failed).length;
  const passed = executed - failed;
  const notExecuted = requested - executed;
  const report = { requested, executed, passed, failed, notExecuted, firstFailureAt, results };

  log(
    `\n요청 ${requested}회 · 실행 ${executed}회 · 통과 ${passed}회 · 실패 ${failed}회 · 미실행 ${notExecuted}회` +
      (firstFailureAt === null ? " — 재현되지 않았다" : ` — 첫 실패 #${firstFailureAt}`),
  );
  // summary 를 남긴 **뒤에** 호출자가 종료 상태를 정한다(증거 없이 죽지 않는다).
  writeFileSync(join(keepDir, "summary.json"), JSON.stringify(report, null, 2));
  return report;
}

/** 이 파일을 CLI 로 직접 실행했을 때만 Playwright 를 돈다(import 는 아무것도 실행하지 않는다). */
function main() {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const WEB_DIR = join(ROOT, "apps", "web");
  const ARTIFACTS = join(WEB_DIR, "e2e", ".artifacts");
  const KEEP = join(process.env.TEMP ?? "/tmp", "afc-e2e-diag");
  const PW_PKG = createRequire(join(WEB_DIR, "package.json")).resolve(
    "@playwright/test/package.json",
  );
  const PW_ENTRY = join(dirname(PW_PKG), "cli.js");

  const requested = Number(process.argv[2] ?? 10);
  /**
   * `full` 모드는 **실제로 실패했던 조건**이다 — 전체 스위트를 직렬로 돌려 chromium 이 먼저 돌고
   * webkit 이 뒤따르며 DB 가 누적된 상태. 단일 spec 반복은 그보다 약한 조건이라
   * 통과했다고 해서 "재현 안 됨"으로 닫으면 안 된다.
   */
  const mode = process.argv[3] === "full" ? "full" : "single";
  const args =
    mode === "full"
      ? [PW_ENTRY, "test", "--workers=1"]
      : [
          PW_ENTRY,
          "test",
          "e2e/09-offline-sync.spec.ts",
          "--project=webkit-ios",
          "-g",
          "loss 0",
          "--workers=1",
        ];

  /**
   * **진단 도구 전용 fake.** 종료 상태 계약(실패 → exit 1, 전부 성공 → exit 0)을 실제 프로세스로
   * 검증하려면 Playwright 를 돌리지 않고도 실패를 만들 수 있어야 한다.
   * `AFC_DIAG_FAKE=pass` 또는 `fail:<회차>`. 제품 코드가 아니라 이 harness 안에만 있다.
   */
  const fake = process.env.AFC_DIAG_FAKE;
  const execute = fake
    ? (attempt) => {
        const failAt = fake.startsWith("fail:") ? Number(fake.slice(5)) : null;
        return attempt === failAt
          ? { failed: true, output: "1 failed (0.1s)" }
          : { failed: false, output: "75 passed (0.1s)" };
      }
    : () => {
        try {
          return {
            failed: false,
            output: execFileSync(process.execPath, args, {
              cwd: WEB_DIR,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              shell: false,
              env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
            }),
          };
        } catch (error) {
          return { failed: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
        }
      };

  const report = runDiagnostic({
    requested,
    keepDir: KEEP,
    artifactsDir: ARTIFACTS,
    log: (line) => console.log(line),
    execute,
  });

  // **집계·보존이 끝난 뒤** 종료 상태를 정한다. 진단이 성공으로 끝나면 사람이 "괜찮았다"로 읽는다.
  if (report.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
