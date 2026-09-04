/**
 * E2E 가 **개발 DB 를 절대 쓰지 않는다**는 것을 고정한다.
 *
 * 이 가드가 없으면 조용히 깨진다: E2E 가 개발 DB 를 쓰던 동안 programs 818행 / sessions 4,897행이
 * 쌓였고(실측), 실기기 워크스루 중에 돌리면 서로의 "오늘 세션"을 갈아치웠다.
 * 화면은 멀쩡해 보이고 테스트도 통과하므로 사람이 알아채기 어렵다.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
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

/* ------------------------------------------------------------------ *
 * 실패 경로가 접속 URL 을 다시 내보내지 않는다
 * ------------------------------------------------------------------ */

/**
 * **진짜 비밀이 아니다.** 아래 표식은 테스트에서만 만드는 합성 문자열이고, 실제 자격증명은
 * 픽스처에 쓰지 않는다. 출력 어디에서든 이 표식이 한 번이라도 보이면 같은 자리로 진짜
 * 비밀번호도 나간다는 뜻이므로, 표식 0회를 그대로 계약으로 삼는다.
 */
const SENTINEL = "AFC_SYNTHETIC_NOT_A_REAL_SECRET";
const USER = `user_${SENTINEL}`;
const PASSWORD = `password_${SENTINEL}`;
const QUERY = `sslpassword=query_${SENTINEL}`;
const FRAGMENT = `fragment_${SENTINEL}`;
const AUTHORITY = `${USER}:${PASSWORD}@localhost:5432`;

/** 파싱은 되는데 DB 이름이 없다. authority·query·fragment 에 표식이 다 들어 있다. */
const NO_DB_NAME = `postgresql://${AUTHORITY}?${QUERY}#${FRAGMENT}`;
/** 포트가 숫자가 아니라 `new URL` 자체가 던진다. Node 의 예외는 `input` 에 원문을 담는다. */
const UNPARSEABLE = `postgresql://${USER}:${PASSWORD}@localhost:port-x/afc_e2e?${QUERY}`;
/** 파싱은 되지만 전용 DB 가 아니다(개발 DB). */
const WRONG_DB_NAME = `postgresql://${AUTHORITY}/afc?${QUERY}#${FRAGMENT}`;

/**
 * 오류가 **어떤 방식으로 찍히든** 표식이 없어야 한다.
 * `message` 만 보면 부족하다 — Node 의 `ERR_INVALID_URL` 은 원문을 `input` 프로퍼티에 담아
 * `console.error(error)`·리포터의 직렬화로 새어 나간다(실측).
 */
function serialize(error: unknown): string {
  const parts = [String(error), inspect(error, { depth: 8 })];
  if (error instanceof Error) {
    parts.push(error.stack ?? "", JSON.stringify(error, Object.getOwnPropertyNames(error)));
  }
  return parts.join("\n");
}

describe("실패 경로가 자격증명을 내보내지 않는다", () => {
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

  const cases: [string, () => void][] = [
    [
      "DB 이름이 없는 DATABASE_URL",
      () => {
        process.env.DATABASE_URL = NO_DB_NAME;
        e2eDatabaseUrl();
      },
    ],
    [
      "해석되지 않는 DATABASE_URL",
      () => {
        process.env.DATABASE_URL = UNPARSEABLE;
        e2eDatabaseUrl();
      },
    ],
    [
      "해석되지 않는 E2E_DATABASE_URL(두 번째 파싱 지점)",
      () => {
        process.env.E2E_DATABASE_URL = UNPARSEABLE;
        e2eDatabaseEnv();
      },
    ],
    [
      "전용 DB 가 아닌 E2E_DATABASE_URL",
      () => {
        process.env.E2E_DATABASE_URL = WRONG_DB_NAME;
        e2eDatabaseEnv();
      },
    ],
  ];

  for (const [label, run] of cases) {
    it(`${label} — 오류 직렬화에 표식이 0회다`, () => {
      let thrown: unknown = null;
      try {
        run();
      } catch (error) {
        thrown = error;
      }

      expect(thrown, "fail closed — 실패 경로는 반드시 던진다").not.toBeNull();
      expect(serialize(thrown)).not.toContain(SENTINEL);
    });
  }

  it("전용 DB 거절은 자격증명 없는 host/dbname 만 남긴다", () => {
    process.env.E2E_DATABASE_URL = WRONG_DB_NAME;
    expect(() => e2eDatabaseEnv()).toThrow(/localhost:5432\/afc/);
  });
});

/* ------------------------------------------------------------------ *
 * Playwright 설정 import 까지 실제로 밟는다
 * ------------------------------------------------------------------ */

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLAYWRIGHT_CLI = join(
  dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")),
  "cli.js",
);

/**
 * 단위 테스트로는 부족하다 — 실제로 새는 자리는 **설정 import 가 터졌을 때 러너가 찍는 출력**이다.
 * `--list` 는 서버를 띄우지 않으므로 DB 도 포트도 필요 없다. 여기서 보는 것은 종료 코드와
 * stdout·stderr 두 스트림 전부에서 표식이 0회인가 하나뿐이다.
 */
function listWithDbEnv(overrides: Record<string, string>): {
  status: number | null;
  output: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
    ...overrides,
  };
  for (const key of KEYS) if (!(key in overrides)) delete env[key];

  const result = spawnSync(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", "--list", "--reporter=line"],
    { cwd: WEB_DIR, encoding: "utf8", env },
  );
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("Playwright 설정 import 실패가 자격증명을 찍지 않는다", () => {
  for (const [label, overrides] of [
    ["DB 이름 없음", { DATABASE_URL: NO_DB_NAME }],
    ["해석 불가", { DATABASE_URL: UNPARSEABLE }],
    ["전용 DB 아님", { E2E_DATABASE_URL: WRONG_DB_NAME }],
  ] as [string, Record<string, string>][]) {
    it(`${label} — 서버를 띄우기 전에 멈추고 표식이 0회다`, { timeout: 120_000 }, () => {
      const { status, output } = listWithDbEnv(overrides);

      expect(status, "fail closed — 설정 import 에서 멈춰야 한다").not.toBe(0);
      expect(output).not.toContain(SENTINEL);
    });
  }
});
