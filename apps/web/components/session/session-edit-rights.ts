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
export function unsavedCopy(
  rows: readonly RefusedRow[],
  unknown: number,
  finish: boolean,
  pain = false,
): string {
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
  if (finish)
    return sets ? `${sets} 운동 종료도 저장되지 않았어요.` : "운동 종료는 저장되지 않았어요.";
  // BUG-10 R5 (i, 총괄 승인): a refused finish's pain report, the session finished on the server.
  if (pain)
    return sets ? `${sets} 통증 기록도 저장되지 않았어요.` : "통증 기록은 저장되지 않았어요.";
  return sets;
}

/**
 * BUG-10 R5 (i): not an entity the server knows — the judge's record for a refused finish whose
 * finish is true now (the session is finished on the server) but whose pain report is not saved.
 */
export const PAIN_UNSAVED = "session_pain";

/** One refused mutation, as WE sent it (the coordinator's record — never a guess at the server). */
export type RefusalRecord = { entity: string; entityId: string; reason: string };
export type RefusalContext = {
  /** The session's own date from the screen's copy; null when the screen does not know it. */
  scheduledDate: string | null;
  /** Whether this session has records (a refused set counts) — older: expired vs unlogged. */
  recorded: boolean;
  /** The card's rows by planned set id: names and numbers exactly as the card shows them. */
  cardRows: ReadonlyMap<string, RefusedRow>;
  now?: Date;
};
/** The server's envelope reason for a fact write outside the window (its only `conflict` for facts). */
const FACT_WINDOW_REFUSAL = "conflict";

/**
 * BUG-10 — the one judge for what the server refused (C1 · P1 · C4 · re-entry). Two questions,
 * kept apart:
 * 1. "Was my finish applied?" — any refused `session` row, whatever its reason (one no list knows
 *    included), withdraws the finish. The reason is never consulted for this.
 * 2. "What do we say?" — a date refusal (`conflict` on a set or the finish) gives the date reason
 *    for the class the browser can see — older → expired/unlogged, future → upcoming — then only
 *    what was not saved. today·previous·unknown: the clocks disagree and the server's refusal is
 *    the truth, so the clause is said without a reason the screen cannot know. A non-date refusal
 *    of the finish says only that the finish was not saved: we withdraw the summary, so we explain
 *    it. A non-date refusal of a set stays silent (BUG-03): nothing on screen changes.
 */
export function describeRefusals(
  records: readonly RefusalRecord[],
  context: RefusalContext,
): { text: string | null; finishRefused: boolean } {
  const finishes = records.filter((record) => record.entity === "session");
  const dateSets = [
    ...new Set(
      records
        .filter(
          (record) => record.entity === "performed_set" && record.reason === FACT_WINDOW_REFUSAL,
        )
        .map((record) => record.entityId),
    ),
  ];
  const finishRefused = finishes.length > 0;
  // R5 (i): a pain report not saved is said whatever the reason, like the finish — a lost safety
  // input is lost whatever the server's reason. It is not a refused finish: the summary stays.
  // A refused finish says the whole finish was not saved, its pain with it.
  const pains = records.filter((record) => record.entity === PAIN_UNSAVED);
  const painUnsaved = pains.length > 0 && !finishRefused;
  const dateRefusal =
    dateSets.length > 0 ||
    [...finishes, ...pains].some((record) => record.reason === FACT_WINDOW_REFUSAL);
  if (!dateRefusal)
    return {
      text: finishRefused || painUnsaved ? unsavedCopy([], 0, finishRefused, painUnsaved) : null,
      finishRefused,
    };
  const rows = dateSets.flatMap((id) => {
    const row = context.cardRows.get(id);
    return row ? [row] : [];
  });
  const clause = unsavedCopy(rows, dateSets.length - rows.length, finishRefused, painUnsaved);
  const reason = dateReason(context, context.recorded || dateSets.length > 0);
  return { text: reason ? `${reason} ${clause}` : clause, finishRefused };
}

function dateReason(context: RefusalContext, recorded: boolean): string | null {
  if (!context.scheduledDate) return null;
  const today = utcDateString(context.now ?? new Date());
  switch (classifySessionFactWriteDate(context.scheduledDate, today)) {
    case "older":
      return recorded ? EDIT_WINDOW_COPY.expired : EDIT_WINDOW_COPY.pastUnlogged;
    case "future":
      return EDIT_WINDOW_COPY.upcoming;
    default:
      return null; // today · previous: the browser believes the day is open
  }
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
