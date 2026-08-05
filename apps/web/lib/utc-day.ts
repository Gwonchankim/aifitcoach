/**
 * "오늘"의 판정 기준 (FEATURES_UX F6-1).
 *
 * 서버가 **UTC** 로 오늘을 판정한다(apps/api common/date/utc-day.ts): 종료된 세션의 편집은
 * `scheduled_date` 가 UTC 기준 오늘일 때만 허용되고, 아니면 409 다.
 * 클라이언트가 로컬 시간대(KST 등)로 판정하면 자정 근처에 **"화면은 편집 가능한데 서버는 409"** 가
 * 난다(KST 09:00 = UTC 00:00 → 하루 중 9시간이 어긋난다). 그래서 여기서도 UTC 로만 판정한다.
 */

/** `Date` → `YYYY-MM-DD`(UTC). */
export function utcDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** `Session.scheduled_date`(`YYYY-MM-DD`)가 UTC 기준 오늘인지. */
export function isUtcToday(scheduledDate: string, now: Date = new Date()): boolean {
  return scheduledDate === utcDateString(now);
}
