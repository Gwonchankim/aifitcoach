/**
 * "오늘"의 판정 기준 (FEATURES_UX F6-1).
 *
 * 서버가 **UTC** 로 오늘을 판정한다(apps/api common/date/utc-day.ts): 종료된 세션의 편집은
 * `scheduled_date` 가 UTC 기준 오늘일 때만 허용되고, 아니면 409 다.
 * 클라이언트가 로컬 시간대(KST 등)로 판정하면 자정 근처에 **"화면은 편집 가능한데 서버는 409"** 가
 * 난다(KST 09:00 = UTC 00:00 → 하루 중 9시간이 어긋난다). 그래서 여기서도 UTC 로만 판정한다.
 */

/**
 * 테스트에서 "오늘"을 고정한다 — 서버의 `AFC_TEST_TODAY`(ADR-50)와 **짝을 이뤄야 한다**.
 * 서버만 고정하면 `scheduled_date`(고정 날짜)와 브라우저의 오늘(실제 날짜)이 어긋나 F6-1 판정이 뒤집힌다.
 *
 * `NEXT_PUBLIC_*` 이라 **빌드 시점에 인라인**된다 — 값을 주지 않고 빌드한 산출물에는 남지 않는다.
 * 프로덕션 빌드에서는 설정하지 않는다.
 *
 * Playwright 의 가짜 시계(`clock.install`/`setFixedTime`)를 쓰지 않은 이유: 휴식 타이머가
 * `Date.now()` 델타로 남은 시간을 계산해서, 시간을 고정하면 **카운트다운이 멈춰** 실제 경과 시간을
 * 검증하는 스펙이 죽는다.
 */
const TEST_TODAY = process.env.NEXT_PUBLIC_AFC_TEST_TODAY;

if (TEST_TODAY && typeof console !== "undefined") {
  console.warn(`[AFC] "오늘"이 ${TEST_TODAY} 로 고정돼 있다. 테스트 전용 빌드다.`);
}

/** `Date` → `YYYY-MM-DD`(UTC). */
export function utcDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `Session.scheduled_date`(`YYYY-MM-DD`)가 UTC 기준 오늘인지.
 * `now` 를 명시하면 그 값을 그대로 쓴다(고정값보다 우선) — 단위 테스트가 경계 시각을 직접 지정한다.
 */
export function isUtcToday(scheduledDate: string, now?: Date): boolean {
  if (now) return scheduledDate === utcDateString(now);
  return scheduledDate === (TEST_TODAY ?? utcDateString());
}
