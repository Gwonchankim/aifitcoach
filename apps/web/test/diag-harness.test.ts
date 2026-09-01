/**
 * 진단 harness 의 **집계·중단·종료 상태** 계약.
 *
 * 이 harness 는 간헐 실패를 쫓는 도구다. 그런데 집계가 틀리면 도구가 거짓말을 한다 —
 * 첫 실패에서 멈추는데도 `요청 - 실패` 로 통과를 세면 **돌지도 않은 회차가 통과로 잡힌다**.
 * 실제로 그랬다: 10회 요청 중 1회차에서 실패해도 "통과 9회" 라고 보고했다.
 *
 * 그래서 여기서는 **실제 Playwright·개발 DB·제품 서버를 전혀 쓰지 않는다.**
 * 결정적 fake executor 와 임시 디렉터리만으로 제어부를 검증한다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// 루트 진단 스크립트. import 만으로는 아무것도 실행되지 않는다(CLI 진입은 argv 로 가린다).
import { runDiagnostic } from "../../../scripts/diag-webkit-loss0.mjs";

type Report = {
  requested: number;
  executed: number;
  passed: number;
  failed: number;
  notExecuted: number;
  firstFailureAt: number | null;
  results: { attempt: number; failed: boolean; summary: string }[];
};

const temps: string[] = [];

function tempKeep(): string {
  const dir = mkdtempSync(join(tmpdir(), "afc-diag-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  // 임시 산출물은 남기지 않는다.
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** 지정한 회차에서만 실패하는 결정적 executor. 호출된 회차를 그대로 기록한다. */
function fakeExecutor(failAt: number | null) {
  const calls: number[] = [];
  const execute = (attempt: number) => {
    calls.push(attempt);
    return attempt === failAt
      ? { failed: true, output: "1 failed (12.3s)\nsome trace output" }
      : { failed: false, output: "75 passed (4.0m)" };
  };
  return { calls, execute };
}

describe("진단 harness 집계", () => {
  it("첫 회차 실패면 실행 1 · 통과 0 · 실패 1 · 미실행 9 다", () => {
    const keepDir = tempKeep();
    const { calls, execute } = fakeExecutor(1);

    const report = runDiagnostic({ requested: 10, execute, keepDir }) as Report;

    // **핵심**: 미실행 9회를 통과로 세지 않는다.
    expect(report).toMatchObject({
      requested: 10,
      executed: 1,
      passed: 0,
      failed: 1,
      notExecuted: 9,
      firstFailureAt: 1,
    });
    // 집계가 서로 모순되지 않는다.
    expect(report.passed + report.failed).toBe(report.executed);
    expect(report.executed + report.notExecuted).toBe(report.requested);
    expect(report.results).toHaveLength(1);
    // 첫 실패 뒤 executor 는 다시 불리지 않는다.
    expect(calls).toEqual([1]);
  });

  it("중간 회차 실패도 같은 규칙이다", () => {
    const keepDir = tempKeep();
    const { calls, execute } = fakeExecutor(3);

    const report = runDiagnostic({ requested: 5, execute, keepDir }) as Report;

    expect(report).toMatchObject({
      requested: 5,
      executed: 3,
      passed: 2,
      failed: 1,
      notExecuted: 2,
      firstFailureAt: 3,
    });
    expect(calls).toEqual([1, 2, 3]);
  });

  it("전부 성공하면 요청 횟수만큼 실행·통과하고 미실행 0 이다", () => {
    const keepDir = tempKeep();
    const { calls, execute } = fakeExecutor(null);

    const report = runDiagnostic({ requested: 4, execute, keepDir }) as Report;

    expect(report).toMatchObject({
      requested: 4,
      executed: 4,
      passed: 4,
      failed: 0,
      notExecuted: 0,
      firstFailureAt: null,
    });
    expect(calls).toEqual([1, 2, 3, 4]);
  });
});

describe("증거 보존과 종료 상태", () => {
  it("실패 회차의 stdout 과 summary 를 남긴다", () => {
    const keepDir = tempKeep();
    const { execute } = fakeExecutor(2);

    const report = runDiagnostic({ requested: 6, execute, keepDir }) as Report;

    // 실패한 회차 번호로 고유 경로에 보존한다 — 다음 실행이 덮어쓸 수 없다.
    expect(existsSync(join(keepDir, "run-2", "stdout.txt"))).toBe(true);
    expect(readFileSync(join(keepDir, "run-2", "stdout.txt"), "utf8")).toContain("1 failed");
    // 통과한 회차의 디렉터리는 만들지 않는다.
    expect(existsSync(join(keepDir, "run-1"))).toBe(false);

    // summary 는 **집계가 끝난 뒤** 기록된다 — 종료 상태를 정하기 전에 증거가 남아야 한다.
    const saved = JSON.parse(readFileSync(join(keepDir, "summary.json"), "utf8")) as Report;
    expect(saved).toMatchObject({
      requested: 6,
      executed: 2,
      passed: 1,
      failed: 1,
      notExecuted: 4,
    });
    expect(saved.results).toHaveLength(2);
    expect(report.failed).toBe(1);
  });

  it("전부 성공해도 summary 를 남긴다", () => {
    const keepDir = tempKeep();
    const { execute } = fakeExecutor(null);

    runDiagnostic({ requested: 2, execute, keepDir });

    const saved = JSON.parse(readFileSync(join(keepDir, "summary.json"), "utf8")) as Report;
    expect(saved).toMatchObject({ executed: 2, passed: 2, failed: 0, notExecuted: 0 });
  });

  it("실패가 있으면 호출자가 nonzero exit 을 정할 수 있다 — 성공으로 끝나지 않는다", () => {
    const keepDir = tempKeep();
    const failing = runDiagnostic({
      requested: 3,
      execute: fakeExecutor(1).execute,
      keepDir,
    }) as Report;
    const clean = runDiagnostic({
      requested: 3,
      execute: fakeExecutor(null).execute,
      keepDir: tempKeep(),
    }) as Report;

    // CLI 는 이 값으로 exit code 를 정한다(진단이 성공으로 끝나면 사람이 "괜찮았다"로 읽는다).
    expect(failing.failed > 0).toBe(true);
    expect(clean.failed > 0).toBe(false);
  });

  it("artifacts 디렉터리가 없으면 stdout 만 남기고 죽지 않는다", () => {
    const keepDir = tempKeep();

    const report = runDiagnostic({
      requested: 2,
      execute: fakeExecutor(1).execute,
      keepDir,
      artifactsDir: join(keepDir, "does-not-exist"),
    }) as Report;

    expect(existsSync(join(keepDir, "run-1", "stdout.txt"))).toBe(true);
    expect(existsSync(join(keepDir, "run-1", "artifacts"))).toBe(false);
    expect(report.executed).toBe(1);
  });
});

/**
 * **실제 프로세스 종료 상태.** 위 단위 검증은 `report.failed` 라는 술어까지만 본다.
 * CLI 가 그 술어로 정말 exit code 를 정하는지는 프로세스를 띄워야 안다 —
 * 진단이 성공으로 끝나면 CI 도 사람도 "괜찮았다"로 읽기 때문에 이 한 줄이 계약이다.
 *
 * Playwright·개발 DB·제품 서버는 쓰지 않는다(`AFC_DIAG_FAKE` 로 executor 를 대체한다).
 */
describe("CLI 종료 상태", () => {
  function runCli(fake: string, requested: number, keepDir: string) {
    const script = join(__dirname, "..", "..", "..", "scripts", "diag-webkit-loss0.mjs");
    const result = spawnSync(process.execPath, [script, String(requested)], {
      encoding: "utf8",
      env: { ...process.env, AFC_DIAG_FAKE: fake, TEMP: keepDir, TMP: keepDir },
    });
    return { status: result.status, stdout: result.stdout ?? "" };
  }

  it("첫 실패에서 증거를 남기고 **exit 1** 로 끝난다", () => {
    const keepDir = tempKeep();

    const { status, stdout } = runCli("fail:1", 10, keepDir);

    expect(status).toBe(1);
    // 종료 전에 집계와 증거가 남아 있어야 한다.
    const summaryPath = join(keepDir, "afc-e2e-diag", "summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const saved = JSON.parse(readFileSync(summaryPath, "utf8")) as Report;
    expect(saved).toMatchObject({
      requested: 10,
      executed: 1,
      passed: 0,
      failed: 1,
      notExecuted: 9,
    });
    expect(existsSync(join(keepDir, "afc-e2e-diag", "run-1", "stdout.txt"))).toBe(true);
    // 사람이 읽는 줄도 미실행을 통과로 말하지 않는다.
    expect(stdout).toContain("실행 1회");
    expect(stdout).toContain("미실행 9회");
  });

  it("전부 성공하면 요청 횟수만큼 실행하고 **exit 0** 이다", () => {
    const keepDir = tempKeep();

    const { status } = runCli("pass", 3, keepDir);

    expect(status).toBe(0);
    const saved = JSON.parse(
      readFileSync(join(keepDir, "afc-e2e-diag", "summary.json"), "utf8"),
    ) as Report;
    expect(saved).toMatchObject({
      requested: 3,
      executed: 3,
      passed: 3,
      failed: 0,
      notExecuted: 0,
    });
  });
});
