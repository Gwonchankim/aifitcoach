/**
 * "오늘"의 판정 기준은 **UTC** 한 곳뿐이다.
 * 프로그램 생성이 UTC 월요일부터 세션을 펼치고(ProgramsService.mondayOfWeek) 대시보드도 UTC 로
 * 오늘을 판정한다 — 종료 후 당일 수정(F6-1)이나 즉석 세션(F8-1)이 다른 기준을 쓰면 자정 근처에
 * "대시보드는 오늘이라는데 편집은 409" 같은 모순이 난다.
 */
import { testOverridesAllowed } from "../../auth/dev-user";

/** 테스트에서 "오늘"을 고정하는 환경변수(ADR-50). 형식 `YYYY-MM-DD`(UTC). */
export const TEST_TODAY_ENV = "AFC_TEST_TODAY";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 고정된 "오늘". 설정이 없거나 허용되지 않으면 null.
 *
 * 왜 필요한가: 프로그램 요일 배정에 **구조적 공백**이 있다 — 일요일은 어떤 `days_per_week` 에서도
 * 운동일이 될 수 없고(SUN 전부 휴식), 월요일은 어떤 값에서도 휴식일이 될 수 없다(MON 전부 운동).
 * 그래서 "요일에 맞는 분할 고르기"로는 테스트가 7일 중 2일을 덮지 못한다. 날짜를 고정하면 해결된다.
 */
export function testTodayOverride(): Date | null {
  if (!testOverridesAllowed()) return null;
  const raw = process.env[TEST_TODAY_ENV];
  if (!raw) return null;
  if (!DATE_PATTERN.test(raw)) {
    throw new Error(`${TEST_TODAY_ENV} 는 YYYY-MM-DD 여야 한다. 현재 값: ${raw}`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${TEST_TODAY_ENV} 가 유효한 날짜가 아니다: ${raw}`);
  }
  return parsed;
}

export function utcToday(): Date {
  const now = testTodayOverride() ?? new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** scheduled_date(@db.Date, UTC 자정)가 오늘인지. */
export function isUtcToday(date: Date): boolean {
  return isoDate(date) === isoDate(utcToday());
}
