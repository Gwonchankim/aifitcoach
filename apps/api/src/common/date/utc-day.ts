/**
 * "오늘"의 판정 기준은 **UTC 달력 날짜** 하나뿐이다(ADR-38). 프로그램 생성(UTC 월요일부터 펼침)·대시보드·
 * 기록 쓰기 창(ADR-86)이 모두 이 모듈의 날짜를 쓴다 — 기준이 둘이면 자정 근처에
 * "대시보드는 오늘이라는데 편집은 409" 같은 모순이 난다.
 *
 * 테스트 오버라이드(ADR-50)는 `AFC_TEST_TODAY` 하나뿐이고, 켤 수 있는지는 dev-user 이음새의
 * `testOverridesAllowed()` 가 정한다 — 프로덕션에서는 값이 있어도 항상 무시된다.
 */
import { testOverridesAllowed } from "../../auth/dev-user";

/** 테스트에서 "오늘"을 고정하는 환경변수(ADR-50). 형식 `YYYY-MM-DD`(UTC). */
export const TEST_TODAY_ENV = "AFC_TEST_TODAY";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD`(UTC). scheduled_date(@db.Date) 같은 UTC 자정 값을 날짜로 비교할 때 쓴다. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 고정된 "오늘"(UTC 자정). 허용되지 않거나 설정이 없으면 null.
 *
 * 형식이 틀렸거나 달력에 없는 날짜(예: 2026-02-30)면 조용히 넘기지 않고 던진다. `Date` 는 그런 값을
 * 다음 달로 넘겨 버리므로(2026-02-30 → 03-02) 파싱 결과를 원래 문자열로 되돌려 대조한다.
 *
 * 왜 필요한가: 프로그램 요일 배정에 **구조적 공백**이 있다 — 일요일은 어떤 `days_per_week` 에서도
 * 운동일이 될 수 없고, 월요일은 어떤 값에서도 휴식일이 될 수 없다. 날짜를 고정해야 시험이 요일과 무관해진다.
 */
export function testTodayOverride(): Date | null {
  if (!testOverridesAllowed()) return null;
  const raw = process.env[TEST_TODAY_ENV];
  if (!raw) return null;
  if (!ISO_DAY.test(raw)) {
    throw new Error(`${TEST_TODAY_ENV} 는 YYYY-MM-DD 여야 한다. 현재 값: ${raw}`);
  }
  const day = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || isoDate(day) !== raw) {
    throw new Error(`${TEST_TODAY_ENV} 가 유효한 날짜가 아니다: ${raw}`);
  }
  return day;
}

/** 오늘의 UTC 자정. 테스트 오버라이드가 허용·설정됐으면 그 날짜다. */
export function utcToday(): Date {
  const now = testTodayOverride() ?? new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * `date`(UTC 자정으로 저장된 @db.Date)가 `today` 와 같은 UTC 날짜인지.
 * `today` 는 요청 진입에서 **한 번** 잡은 값을 인자로만 받는다(ADR-86 "서버 수신 시점") — 잠금을 기다린 뒤
 * 시계를 다시 읽으면 같은 요청의 판정이 서버가 얼마나 바빴는지에 따라 달라진다.
 */
export function isUtcToday(date: Date, today: Date): boolean {
  return isoDate(date) === isoDate(today);
}
