/**
 * BUG-10 (A, provisional until the KST follow-up): which UTC calendar day may still receive
 * actual/completion writes. This is the single definition shared by the server writers
 * (sync performed/session, REST complete), the client lock and the copy choice — none of them
 * computes "yesterday" on its own.
 *
 * Inputs are UTC calendar dates (`YYYY-MM-DD`) produced by the existing UTC adapters. There is no
 * clock, no KST conversion and no state here. Anything else fails closed with a RangeError.
 */
export type SessionFactWriteDate = "today" | "previous" | "older" | "future";

const DAY_MS = 86_400_000;
const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDayNumber(value: string): number {
  const match = UTC_DATE.exec(value);
  if (!match) throw new RangeError(`UTC 날짜(YYYY-MM-DD)가 아니다: ${value}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new RangeError(`존재하지 않는 UTC 날짜다: ${value}`);
  return time / DAY_MS;
}

/** today = 0일 전, previous = 정확히 1일 전, older = 2일 이상 전, future = 오늘보다 뒤. */
export function classifySessionFactWriteDate(
  scheduledDateUtc: string,
  todayUtc: string,
): SessionFactWriteDate {
  const age = utcDayNumber(todayUtc) - utcDayNumber(scheduledDateUtc);
  if (age === 0) return "today";
  if (age === 1) return "previous";
  return age > 1 ? "older" : "future";
}

/** actual/완료 쓰기는 today·previous 에서만 열린다. routine 편집 권한과는 별개다. */
export function isSessionFactWriteAllowed(scheduledDateUtc: string, todayUtc: string): boolean {
  const date = classifySessionFactWriteDate(scheduledDateUtc, todayUtc);
  return date === "today" || date === "previous";
}
