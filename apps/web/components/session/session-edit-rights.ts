/**
 * BUG-10 D — what this screen may write for a session, decided once.
 *
 * - `facts`: set values/checks, set completion and session completion (finish/re-finish). Decided by
 *   the shared `isSessionFactWriteAllowed` — the very function the API guards these writes with —
 *   on the browser's UTC today (lib/utc-day, the server's day boundary): UTC today and the previous
 *   UTC day (provisional A until the KST review).
 * - `routine`: add/swap/remove/append. The unchanged rule: a completed session only on its UTC day;
 *   scheduled sessions keep their existing routine allowance on any date.
 * - `notice`: the approved copy for the situation, chosen from the same shared classification;
 *   null when nothing needs explaining. It never claims more than the rights above.
 */
import { classifySessionFactWriteDate, isSessionFactWriteAllowed } from "shared";
import { isUtcToday, utcDateString } from "../../lib/utc-day";

export const EDIT_WINDOW_COPY = {
  previousCompleted: "지난 날짜에는 운동을 빼거나 바꿀 수 없어요. 기록 값은 고칠 수 있어요.",
  expired: "이 기록은 편집할 수 있는 기간이 지났어요.",
  pastUnlogged: "지난 날짜의 운동은 기록할 수 없어요.",
  upcoming: "예정된 운동이에요. 그날이 되면 기록할 수 있어요.",
} as const;

export type SessionEditRights = {
  facts: boolean;
  routine: boolean;
  notice: string | null;
};

export function sessionEditRights(
  session: { status: string; scheduled_date: string },
  hasRecord: boolean,
  now: Date = new Date(),
): SessionEditRights {
  const today = utcDateString(now);
  const completed = session.status === "completed";
  return {
    facts: isSessionFactWriteAllowed(session.scheduled_date, today),
    routine: !completed || isUtcToday(session.scheduled_date, now),
    notice: noticeFor(classifySessionFactWriteDate(session.scheduled_date, today)),
  };

  function noticeFor(date: ReturnType<typeof classifySessionFactWriteDate>): string | null {
    switch (date) {
      case "previous":
        // Only where value edits really are open: a finished previous-day session.
        return completed ? EDIT_WINDOW_COPY.previousCompleted : null;
      case "older":
        return completed || hasRecord ? EDIT_WINDOW_COPY.expired : EDIT_WINDOW_COPY.pastUnlogged;
      case "future":
        // A finished future session is an abnormal state: read-only, nothing to explain.
        return completed ? null : EDIT_WINDOW_COPY.upcoming;
      case "today":
        return null;
    }
  }
}
