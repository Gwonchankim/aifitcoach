/**
 * jest globalSetup: DB 통합 테스트 부트스트랩을 한 곳에서 1회만 실행한다.
 * (spec 마다 beforeAll 에서 migrate/seed 를 돌리면 DB spec 이 늘어날수록 worker 끼리 경합한다 — STEP 1 I-2.)
 *
 * 여기서 정한 process.env 는 fork 되는 jest worker 들이 그대로 물려받는다.
 */
import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { TEST_TODAY_ENV } from "../src/common/date/utc-day";
import { DEFAULT_TEST_TODAY, REPO_ROOT, testDatabaseUrl } from "./support/database-url";
import { RUN_ID_ENV, testUserId } from "./support/users";

function run(script: string, env: NodeJS.ProcessEnv): void {
  try {
    execSync(`pnpm --filter api ${script}`, { cwd: REPO_ROOT, env, stdio: "pipe" });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `${script} 실패\n--- stdout ---\n${stdout?.toString() ?? ""}\n--- stderr ---\n${stderr?.toString() ?? ""}`,
    );
  }
}

/**
 * migrate/seed child 프로세스가 물려받을 DB 환경. **둘을 같은 test DB 로 강제한다.**
 *
 * `prisma-migrate.mjs` 는 DIRECT_URL 을 우선한다. DATABASE_URL 만 test 로 바꾸면
 * **migration 은 개발 DB 로, seed 는 test DB 로** 가서 스키마가 갈라진다(F-3 에서 실제로 그랬다).
 * 루트 .env 의 dev DIRECT_URL 이 child env 에 남지 않게 여기서 덮어쓴다.
 */
export function applyTestDatabaseEnv(env: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  env.DATABASE_URL = url;
  env.DIRECT_URL = url;
  return env;
}

export default function globalSetup(): void {
  // testDatabaseUrl() 이 루트 .env 를 로드하므로 **그 뒤에** 둘 다 덮어써야 한다.
  applyTestDatabaseEnv(process.env, testDatabaseUrl());
  // 테스트용 키는 실행할 때마다 새로 만든다(리포에 시크릿을 두지 않는다 — SECURITY_PIPA.md).
  process.env.FIELD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  // 실행 단위 신원. **`??=` 로 두면 안 된다** — 바로 위 testDatabaseUrl() 이 루트 .env 를 로드해
  // DEV_USER_ID(고정값)가 이미 채워져 있다. 그 값을 쓰면 동시 실행이 서로를 지운다.
  process.env[RUN_ID_ENV] ??= randomUUID();
  process.env.DEV_USER_ID = testUserId("dev");
  // "오늘"을 고정한다(ADR-50). 안 하면 스위트가 요일에 따라 통과/실패한다 —
  // 요일 배정에 구조적 공백이 있어(SUN 운동일 불가 / MON 휴식일 불가) 분할을 바꿔서는 못 덮는다.
  // 기본값이 수요일인 이유: 수요일만 운동일(days 3·5·6)과 휴식일(days 2·4)을 한 날짜로 둘 다 만든다.
  process.env[TEST_TODAY_ENV] ??= DEFAULT_TEST_TODAY;

  run("db:migrate", process.env);
  run("db:seed", process.env);
}
