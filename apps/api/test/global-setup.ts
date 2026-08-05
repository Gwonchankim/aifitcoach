/**
 * jest globalSetup: DB 통합 테스트 부트스트랩을 한 곳에서 1회만 실행한다.
 * (spec 마다 beforeAll 에서 migrate/seed 를 돌리면 DB spec 이 늘어날수록 worker 끼리 경합한다 — STEP 1 I-2.)
 *
 * 여기서 정한 process.env 는 fork 되는 jest worker 들이 그대로 물려받는다.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DEFAULT_DEV_USER_ID } from "../src/auth/dev-user";
import { REPO_ROOT, testDatabaseUrl } from "./support/database-url";

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

export default function globalSetup(): void {
  process.env.DATABASE_URL = testDatabaseUrl();
  // 테스트용 키는 실행할 때마다 새로 만든다(리포에 시크릿을 두지 않는다 — SECURITY_PIPA.md).
  process.env.FIELD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.DEV_USER_ID ??= DEFAULT_DEV_USER_ID;

  run("db:migrate", process.env);
  run("db:seed", process.env);
}
