/**
 * E2E 전용 DB — 개발 DB(`afc`)를 **건드리지 않기 위해** 이름 뒤에 `_e2e` 를 붙인 별도 DB를 쓴다.
 *
 * 왜: E2E 가 개발 DB 를 쓰던 동안 programs 818행 / workout_sessions 4,897행이 쌓였고(실측),
 * 실기기 워크스루 중에 E2E 를 돌리면 서로의 "오늘 세션"을 갈아치웠다.
 * api 통합 테스트의 `<db>_test`(ADR-14)와도 분리한다 — 둘이 같은 DB 를 쓰면 한쪽의 리셋이 다른 쪽을 지운다.
 */
import fs from "node:fs";
import path from "node:path";

// Playwright 는 설정을 CJS 로 변환해 로드한다 → `import.meta` 를 쓸 수 없다(실측: SyntaxError).
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

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
