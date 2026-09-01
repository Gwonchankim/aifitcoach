import { applyTestDatabaseEnv } from "./global-setup";
import { testDatabaseUrl } from "./support/database-url";

/**
 * migrate/seed child 프로세스가 **같은 test DB** 를 보는지 잠근다.
 *
 * F-3 에서 실제로 갈라졌다: `prisma-migrate.mjs` 가 DIRECT_URL 을 우선하는데
 * globalSetup 이 DATABASE_URL 만 test 로 바꿔서 **migration 은 개발 DB, seed 는 test DB** 로 갔다.
 * 스키마가 갈라진 채 seed 가 새 컬럼을 찾다 실패했다.
 *
 * **실제 URL·자격증명을 단언·출력하지 않는다** — 관계(같은가)와 DB 이름 접미사만 본다.
 */

/** URL 에서 DB 이름만 뽑는다. 호스트·자격증명은 건드리지 않는다. */
function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

describe("test DB 환경 강제", () => {
  it("DATABASE_URL 과 DIRECT_URL 이 같은 값이 된다", () => {
    const env: NodeJS.ProcessEnv = {};
    applyTestDatabaseEnv(env, "postgresql://u:p@localhost:5432/afc_test");
    expect(env.DATABASE_URL).toBe(env.DIRECT_URL);
  });

  it("기존 dev DIRECT_URL 을 반드시 덮어쓴다", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://u:p@localhost:5432/afc",
      DIRECT_URL: "postgresql://u:p@localhost:5432/afc",
    };
    applyTestDatabaseEnv(env, "postgresql://u:p@localhost:5432/afc_test");
    // 개발 DB 이름이 child env 에 남으면 migration 이 그리로 간다.
    expect(databaseName(env.DIRECT_URL!)).not.toBe("afc");
    expect(databaseName(env.DIRECT_URL!)).toBe(databaseName(env.DATABASE_URL!));
  });

  it("실제 test URL 도 두 변수가 같고 DB 이름이 _test 로 끝난다", () => {
    const env: NodeJS.ProcessEnv = {};
    applyTestDatabaseEnv(env, testDatabaseUrl());
    expect(env.DATABASE_URL).toBe(env.DIRECT_URL);
    // 이름 접미사만 확인한다 — URL 전체를 단언하면 자격증명이 스냅샷에 남는다.
    expect(databaseName(env.DATABASE_URL!).endsWith("_test")).toBe(true);
  });

  it("반환값은 전달한 env 객체 그대로다(복사본이 아니다)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyTestDatabaseEnv(env, "postgresql://u:p@localhost:5432/afc_test")).toBe(env);
  });
});
