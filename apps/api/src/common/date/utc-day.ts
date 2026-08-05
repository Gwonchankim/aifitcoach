/**
 * "오늘"의 판정 기준은 **UTC** 한 곳뿐이다.
 * 프로그램 생성이 UTC 월요일부터 세션을 펼치고(ProgramsService.mondayOfWeek) 대시보드도 UTC 로
 * 오늘을 판정한다 — 종료 후 당일 수정(F6-1)이나 즉석 세션(F8-1)이 다른 기준을 쓰면 자정 근처에
 * "대시보드는 오늘이라는데 편집은 409" 같은 모순이 난다.
 */
export function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** scheduled_date(@db.Date, UTC 자정)가 오늘인지. */
export function isUtcToday(date: Date): boolean {
  return isoDate(date) === isoDate(utcToday());
}
