/**
 * BUG-10 D — the session screen's write rights come from the shared fact-write window (the same
 * function the API guards with) on the browser's UTC today; routine rights keep their own rule;
 * the notice is the approved copy for the date class and never claims more than the rights.
 */
import { describe, expect, it } from "vitest";
import { EDIT_WINDOW_COPY, sessionEditRights } from "../components/session/session-edit-rights";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-08-14T10:00:00.000Z");
const session = (scheduled_date: string, status = "scheduled") => ({ scheduled_date, status });

describe("sessionEditRights — facts follow the shared window, routine keeps its rule", () => {
  it.each([
    // date, status, record → facts, routine, notice
    ["2026-08-14", "scheduled", false, true, true, null],
    ["2026-08-14", "completed", true, true, true, null],
    ["2026-08-13", "scheduled", false, true, true, null],
    ["2026-08-13", "completed", true, true, false, EDIT_WINDOW_COPY.previousCompleted],
    ["2026-08-12", "completed", true, false, false, EDIT_WINDOW_COPY.expired],
    ["2026-08-12", "scheduled", true, false, true, EDIT_WINDOW_COPY.expired],
    ["2026-08-12", "in_progress", true, false, true, EDIT_WINDOW_COPY.expired],
    ["2026-08-12", "scheduled", false, false, true, EDIT_WINDOW_COPY.pastUnlogged],
    ["2026-08-15", "scheduled", false, false, true, EDIT_WINDOW_COPY.upcoming],
    ["2026-08-15", "completed", true, false, false, null],
  ] as const)(
    "%s %s (record: %s) → facts %s, routine %s",
    (date, status, record, facts, routine, notice) => {
      expect(sessionEditRights(session(date, status), record, NOW)).toEqual({
        facts,
        routine,
        notice,
      });
    },
  );

  it("the previous-day copy (values can be fixed) never reaches a session that cannot be edited", () => {
    for (const date of ["2026-08-12", "2026-08-01", "2026-08-15", "2026-09-01"])
      for (const status of ["scheduled", "in_progress", "completed"])
        for (const record of [true, false]) {
          const rights = sessionEditRights(session(date, status), record, NOW);
          expect(rights.facts).toBe(false);
          expect(rights.notice).not.toBe(EDIT_WINDOW_COPY.previousCompleted);
        }
  });

  it("a future session is never described as past", () => {
    for (const status of ["scheduled", "in_progress", "completed"]) {
      const { notice } = sessionEditRights(session("2026-08-15", status), true, NOW);
      expect(notice).not.toBe(EDIT_WINDOW_COPY.expired);
      expect(notice).not.toBe(EDIT_WINDOW_COPY.pastUnlogged);
    }
  });
});

describe("sessionEditRights — UTC midnight (KST 09:00) and calendar boundaries", () => {
  it("KST 08:30 → 09:30: the workout stays writable across UTC midnight, then closes", () => {
    const workout = session("2026-09-17");
    // KST 08:30 = UTC 23:30 on the 17th; KST 09:30 = UTC 00:30 on the 18th.
    expect(sessionEditRights(workout, true, at("2026-09-17T23:30:00.000Z")).facts).toBe(true);
    expect(sessionEditRights(workout, true, at("2026-09-18T00:30:00.000Z")).facts).toBe(true);
    const done = session("2026-09-17", "completed");
    const nextMorning = sessionEditRights(done, true, at("2026-09-18T00:45:00.000Z"));
    expect(nextMorning).toEqual({
      facts: true,
      routine: false,
      notice: EDIT_WINDOW_COPY.previousCompleted,
    });
    // One more UTC midnight: two days old.
    expect(sessionEditRights(done, true, at("2026-09-19T00:10:00.000Z"))).toEqual({
      facts: false,
      routine: false,
      notice: EDIT_WINDOW_COPY.expired,
    });
  });

  it.each([
    ["2026-09-30", "2026-10-01T05:00:00.000Z", true],
    ["2026-09-29", "2026-10-01T05:00:00.000Z", false],
    ["2025-12-31", "2026-01-01T05:00:00.000Z", true],
    ["2024-02-28", "2024-03-01T05:00:00.000Z", false],
    ["2024-02-29", "2024-03-01T05:00:00.000Z", true],
  ] as const)("%s at %s → facts %s", (date, now, facts) => {
    expect(sessionEditRights(session(date, "completed"), true, at(now)).facts).toBe(facts);
  });
});
