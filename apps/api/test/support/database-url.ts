import path from "node:path";
import { config as loadDotenv } from "dotenv";

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * 테스트의 고정 "오늘" — **금요일**(ADR-50). api·E2E 가 같은 값을 쓴다.
 *
 * 금요일인 이유(실측으로 좁혔다):
 *  - 스위트가 쓰는 `days_per_week` 는 3·4·6 세 가지고, **셋 다 운동일인 요일은 MON 과 FRI 뿐**이다
 *    (3=MON/WED/FRI, 4=MON/TUE/THU/FRI, 6=MON~SAT).
 *  - "내일은 휴식" 을 기대하는 스펙이 있어 **다음 날이 휴식**이어야 한다 → FRI 의 다음 날 SAT 는
 *    3·4 에서 휴식이다. MON 의 다음 날 TUE 는 4 에서 운동일이라 못 쓴다.
 *  - 휴식일 자체는 스펙들이 오늘 세션을 지워서 만든다(`restDayProgram`) → 요일에 의존하지 않는다.
 *
 * 바꿀 때 주의: 일요일은 어떤 값에서도 운동일이 못 되고, 월요일은 어떤 값에서도 휴식일이 못 된다.
 */
export const DEFAULT_TEST_TODAY = "2026-08-14";

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
