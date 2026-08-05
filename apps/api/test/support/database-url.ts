import path from "node:path";
import { config as loadDotenv } from "dotenv";

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * 개발용 DB(DATABASE_URL)를 그대로 쓰지 않고 이름 뒤에 `_test` 를 붙인 별도 DB를 쓴다(ADR-14).
 * 이미 `_test` 로 끝나면(CI) 그대로 둔다 → 여러 번 호출해도 같은 값.
 */
export function testDatabaseUrl(): string {
  loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL 이 필요하다. `pnpm db:up` 후 루트 .env(.env.example 복사)를 만들거나 환경변수로 넘겨라.",
    );
  }
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName) throw new Error(`DATABASE_URL 에 데이터베이스 이름이 없다: ${raw}`);
  url.pathname = `/${dbName.endsWith("_test") ? dbName : `${dbName}_test`}`;
  return url.toString();
}
