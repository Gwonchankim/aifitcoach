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

/**
 * Which day a previous-day edit lands on — the session's OWN scheduled_date, never a relative
 * "어제" (which flips between UTC and KST at exactly the boundary this window exists for).
 * Same "M월 D일" UTC format as the history list (HistoryScreen `dateLabel`).
 */
export function reflectsOnCopy(scheduledDate: string): string {
  const date = new Date(`${scheduledDate}T00:00:00.000Z`);
  return `이 기록은 ${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 운동에 반영돼요.`;
}

/** A refused record as its card shows it (the card's exercise name and set number). */
export type RefusedRow = { exerciseId: string; exerciseName: string; setNo: number };

/**
 * BUG-10 P1·C4: what a date-window refusal did NOT save — set by set, never "this exercise" (its
 * other sets may be saved). `rows` come in card order; at most two exercises are named, the rest
 * and refused rows the screen cannot show fold into one count. The caller puts it after the date
 * notice: the reason first, so the user does not resend what will be refused again.
 */
export function unsavedCopy(rows: readonly RefusedRow[], unknown: number, finish: boolean): string {
  const byExercise = new Map<string, { name: string; sets: number[] }>();
  for (const row of rows) {
    const entry = byExercise.get(row.exerciseId) ?? { name: row.exerciseName, sets: [] };
    entry.sets.push(row.setNo);
    byExercise.set(row.exerciseId, entry);
  }
  const exercises = [...byExercise.values()];
  const named = exercises
    .slice(0, 2)
    .map(({ name, sets }) => `${name} ${[...sets].sort((a, b) => a - b).join("·")}세트`);
  const rest = exercises.slice(2).reduce((count, { sets }) => count + sets.length, unknown);
  if (rest > 0) named.push(named.length > 0 ? `다른 세트 ${rest}개` : `세트 ${rest}개`);
  const sets = named.length > 0 ? `${named.join(", ")} 기록은 저장되지 않았어요.` : "";
  if (!finish) return sets;
  return sets ? `${sets} 운동 종료도 저장되지 않았어요.` : "운동 종료는 저장되지 않았어요.";
}

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
