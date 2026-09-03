/**
 * E2E 가 **개발 DB 를 절대 쓰지 않는다**는 것을 고정한다.
 *
 * 이 가드가 없으면 조용히 깨진다: E2E 가 개발 DB 를 쓰던 동안 programs 818행 / sessions 4,897행이
 * 쌓였고(실측), 실기기 워크스루 중에 돌리면 서로의 "오늘 세션"을 갈아치웠다.
 * 화면은 멀쩡해 보이고 테스트도 통과하므로 사람이 알아채기 어렵다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e2eDatabaseEnv, e2eDatabaseUrl } from "../e2e/db-url";

const KEYS = ["E2E_DATABASE_URL", "DATABASE_URL", "DIRECT_URL"] as const;

describe("e2eDatabaseUrl", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("개발 DB 이름에 _e2e 를 붙인 별도 DB 를 쓴다", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc";
    const url = e2eDatabaseUrl();
    expect(url).toContain("/afc_e2e");
    expect(url).not.toBe(process.env.DATABASE_URL);
  });

  it("개발 DB 를 그대로 돌려주지 않는다", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc";
    expect(new URL(e2eDatabaseUrl()).pathname).not.toBe("/afc");
  });

  it("이미 _e2e 면 두 번 붙이지 않는다(여러 번 호출해도 같은 값)", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc_e2e";
    expect(new URL(e2eDatabaseUrl()).pathname).toBe("/afc_e2e");
  });

  it("api 통합 테스트의 _test DB 와도 겹치지 않는다", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc";
    expect(new URL(e2eDatabaseUrl()).pathname).not.toBe("/afc_test");
  });

  it("E2E_DATABASE_URL 을 주면 그대로 쓴다", () => {
    process.env.E2E_DATABASE_URL = "postgresql://u:p@db:5432/custom_e2e";
    expect(e2eDatabaseUrl()).toBe("postgresql://u:p@db:5432/custom_e2e");
  });
});

/**
 * **migration 과 runtime 이 같은 DB 를 봐야 한다.**
 *
 * `DATABASE_URL` 만 덮으면 부족하다 — `scripts/prisma-migrate.mjs` 는 `DIRECT_URL` 이 있으면
 * **그쪽을 먼저 쓴다.** 루트 `.env` 에 둘 다 있는 정상 개발 환경에서는 migration 이 개발 DB 로 가고
 * seed·runtime 만 전용 DB 로 간다. 화면도 테스트도 그럴듯하게 도는데 개발 DB schema 가 바뀐다.
 */
describe("e2eDatabaseEnv — 한 원천에서 두 변수를 함께 준다", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("**부모에 개발 DB DIRECT_URL 이 있어도** 둘 다 전용 DB 로 덮인다", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc";
    process.env.DIRECT_URL = "postgresql://postgres:postgres@localhost:5432/afc";

    const env = e2eDatabaseEnv();

    expect(new URL(env.DATABASE_URL).pathname).toBe("/afc_e2e");
    expect(new URL(env.DIRECT_URL).pathname).toBe("/afc_e2e");
    expect(env.DIRECT_URL).toBe(env.DATABASE_URL);
  });

  it("E2E_DATABASE_URL 을 주면 두 변수 모두 그 값이다", () => {
    process.env.E2E_DATABASE_URL = "postgresql://u:p@db:5432/custom_e2e";
    process.env.DIRECT_URL = "postgresql://u:p@db:5432/afc";

    const env = e2eDatabaseEnv();

    expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/custom_e2e");
    expect(env.DIRECT_URL).toBe("postgresql://u:p@db:5432/custom_e2e");
  });

  it("개발 DB 이름 그대로면 **서버를 띄우기 전에** 거절한다(fail closed)", () => {
    process.env.E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc";
    expect(() => e2eDatabaseEnv()).toThrow(/전용 DB/);
  });

  it("api 통합 테스트의 `_test` DB 도 거절한다 — 서로의 리셋이 겹친다", () => {
    process.env.E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/afc_test";
    expect(() => e2eDatabaseEnv()).toThrow(/전용 DB/);
  });

  it("민감정보 없이 host·dbname 만 기록할 수 있다", () => {
    process.env.E2E_DATABASE_URL = "postgresql://user:secret@localhost:5432/afc_x_e2e";

    const label = e2eDatabaseEnv().label;

    expect(label).toBe("localhost:5432/afc_x_e2e");
    expect(label).not.toContain("secret");
    expect(label).not.toContain("user");
  });
});
