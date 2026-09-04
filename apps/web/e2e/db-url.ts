/**
 * E2E 전용 DB — 개발 DB(`afc`)를 **건드리지 않기 위해** 이름 뒤에 `_e2e` 를 붙인 별도 DB를 쓴다.
 *
 * 왜: E2E 가 개발 DB 를 쓰던 동안 programs 818행 / workout_sessions 4,897행이 쌓였고(실측),
 * 실기기 워크스루 중에 E2E 를 돌리면 서로의 "오늘 세션"을 갈아치웠다.
 * api 통합 테스트의 `<db>_test`(ADR-14)와도 분리한다 — 둘이 같은 DB 를 쓰면 한쪽의 리셋이 다른 쪽을 지운다.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 레포 루트를 위로 올라가며 찾는다.
 * `__dirname`(Playwright 는 설정을 CJS 로 변환한다)도 `import.meta`(vitest 는 ESM)도 쓰지 않는다 —
 * 이 파일을 두 러너가 함께 읽기 때문이다. `import.meta` 는 CJS 변환 시 **파싱 단계에서** 터진다(실측).
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

/** 루트 `.env` 에서 키 하나만 읽는다(apps/web 에 dotenv 를 새로 넣지 않으려고 최소 구현). */
function fromRootEnv(key: string): string | undefined {
  const file = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/**
 * 이 하네스가 주입하는 세 URL 은 전부 **PostgreSQL 직결 DSN** 이다(prisma-migrate·seed·API 가 그것만 받는다).
 * `postgres:` 는 같은 계약의 짧은 표기라 함께 받는다.
 */
const ALLOWED_PROTOCOLS = new Set(["postgresql:", "postgres:"]);

/**
 * **실패 메시지에 접속 URL 원문을 넣지 않는다.**
 *
 * 여기서 던진 오류는 Playwright 설정 import 실패로 CI 로그·터미널 기록에 그대로 남는다.
 * PostgreSQL URL 은 user/password 를 authority 에, 때로는 query 에도 담으므로 원문을 실으면
 * 환경변수 한 번 잘못 준 대가로 자격증명이 로그에 영속된다.
 *
 * 원본 예외를 `cause` 로도 달지 않는다 — Node 의 `ERR_INVALID_URL` 은 원문을 `input` 프로퍼티에
 * 담아서, 메시지가 깨끗해도 `console.error(error)` 한 번이면 그대로 찍힌다(실측).
 *
 * **문법만 보면 부족하다.** 이름이 `_e2e` 로 끝나는 `https://…` 는 문법 검사와 전용 DB 검사를 모두
 * 통과해 서버 기동 명령까지 갔다(실측: config import exit 0). 잘못된 provider URL 을 Prisma 가
 * 거절하는 시점은 이미 migration·seed 명령이 시작된 뒤라, 그때부터는 그 도구가 접속 문자열을
 * 어떻게 찍는지에 안전이 달린다. 그래서 protocol 을 **여기서** 허용목록으로 막는다.
 */
function parseDbUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "AFC_E2E_DB_URL_INVALID: 접속 URL 을 해석하지 못했다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",
    );
  }
  // scheme 도 찍지 않는다 — 원문 조각을 로그에 남기지 않는다는 규칙은 여기에도 적용된다.
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      "AFC_E2E_DB_URL_PROTOCOL: 접속 URL 이 PostgreSQL(`postgresql:`·`postgres:`) 이 아니다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",
    );
  }
  return url;
}

export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const raw = process.env.DATABASE_URL ?? fromRootEnv("DATABASE_URL");
  if (!raw) {
    throw new Error(
      "DATABASE_URL 이 필요하다. `pnpm db:up` 후 루트 .env(.env.example 복사)를 만들거나 E2E_DATABASE_URL 로 넘겨라.",
    );
  }
  const url = parseDbUrl(raw);
  const name = url.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(
      "AFC_E2E_DB_URL_NO_NAME: 접속 URL 에 데이터베이스 이름이 없다. 값에 자격증명이 섞일 수 있어 출력하지 않는다.",
    );
  }
  url.pathname = `/${name.endsWith("_e2e") ? name : `${name}_e2e`}`;
  return url.toString();
}

/**
 * **migration·seed·runtime 이 보는 DB 를 한 곳에서 정한다.**
 *
 * `DATABASE_URL` 만 덮으면 부족하다 — `scripts/prisma-migrate.mjs` 는 `DIRECT_URL` 이 있으면
 * **그쪽을 먼저 쓴다**(운영에서 Neon pooler 를 우회하려는 정상 설계다). 루트 `.env` 에 둘 다 있는
 * 개발 환경에서 `DATABASE_URL` 만 주면 **migration 은 개발 DB 로, seed·runtime 은 전용 DB 로** 갈린다.
 * 화면도 테스트도 그럴듯하게 도는데 개발 DB 의 schema 가 바뀐다.
 *
 * 그래서 두 변수를 **같은 값 하나**로 함께 준다. migration 스크립트는 건드리지 않는다 —
 * 그건 배포 경로의 계약이고, 여기서 고칠 것은 E2E 하네스가 무엇을 주입하느냐다.
 */
export function e2eDatabaseEnv(): { DATABASE_URL: string; DIRECT_URL: string; label: string } {
  const url = e2eDatabaseUrl();
  // `E2E_DATABASE_URL` 은 그대로 통과하므로 여기가 그 값의 첫 파싱 지점이다 — 여기서도 원문을 흘리면 안 된다.
  const parsed = parseDbUrl(url);
  const name = parsed.pathname.replace(/^\//, "");

  /**
   * **띄우기 전에 거절한다.** 전용 DB 가 아니면 여기서 멈추는 편이, 서버가 떠서 개발 DB 에
   * migration 을 거는 것보다 낫다. `_test` 는 api 통합 테스트의 것이라 함께 막는다(ADR-14).
   */
  if (!name.endsWith("_e2e")) {
    throw new Error(
      `E2E 는 전용 DB 만 쓴다. 해석된 이름이 '_e2e' 로 끝나지 않는다: ${parsed.host}/${name}`,
    );
  }

  // 자격증명 없이 어디를 보는지만 남긴다 — 로그·보고에 그대로 실을 수 있어야 한다.
  return { DATABASE_URL: url, DIRECT_URL: url, label: `${parsed.host}/${name}` };
}
