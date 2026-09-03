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

export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const raw = process.env.DATABASE_URL ?? fromRootEnv("DATABASE_URL");
  if (!raw) {
    throw new Error(
      "DATABASE_URL 이 필요하다. `pnpm db:up` 후 루트 .env(.env.example 복사)를 만들거나 E2E_DATABASE_URL 로 넘겨라.",
    );
  }
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error(`DATABASE_URL 에 데이터베이스 이름이 없다: ${raw}`);
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
  const parsed = new URL(url);
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
