/**
 * BUG-10 D — the session screen's write rights come from the shared fact-write window (the same
 * function the API guards with) on the browser's UTC today; routine rights keep their own rule;
 * the notice is the approved copy for the date class and never claims more than the rights.
 */
import { describe, expect, it } from "vitest";
import {
  EDIT_WINDOW_COPY,
  reflectsOnCopy,
  sessionEditRights,
  unsavedCopy,
} from "../components/session/session-edit-rights";

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

describe("reflectsOnCopy — a previous-day edit names its own day, never a relative one", () => {
  it.each([
    ["2026-10-05", "이 기록은 10월 5일 운동에 반영돼요."],
    ["2026-08-13", "이 기록은 8월 13일 운동에 반영돼요."],
    ["2025-12-31", "이 기록은 12월 31일 운동에 반영돼요."],
  ] as const)("%s → %s", (date, copy) => {
    expect(reflectsOnCopy(date)).toBe(copy);
  });
});

/**
 * P1·C4 (approved form, option 1): only what was refused, set by set — never "this exercise".
 * Names and numbers are the card's (the screen passes them in card order). Two exercises by name;
 * the rest and rows the screen does not show fold into "다른 세트 n개".
 */
describe("unsavedCopy — what a date-window refusal did not save", () => {
  const row = (exerciseId: string, exerciseName: string, setNo: number) => ({
    exerciseId,
    exerciseName,
    setNo,
  });
  const bench = (setNo: number) => row("bench", "벤치프레스", setNo);
  const curl = (setNo: number) => row("curl", "레그 컬", setNo);
  const squat = (setNo: number) => row("squat", "스쿼트", setNo);
  it.each([
    [[bench(2), bench(1)], 0, false, "벤치프레스 1·2세트 기록은 저장되지 않았어요."],
    [
      [bench(1), bench(2), curl(2)],
      0,
      false,
      "벤치프레스 1·2세트, 레그 컬 2세트 기록은 저장되지 않았어요.",
    ],
    // The cap: a third exercise is counted, not named.
    [
      [bench(1), bench(2), curl(2), squat(1), squat(2), squat(3)],
      0,
      false,
      "벤치프레스 1·2세트, 레그 컬 2세트, 다른 세트 3개 기록은 저장되지 않았어요.",
    ],
    // The approved example: the overflow and rows the screen cannot name share one tail.
    [
      [bench(1), bench(2), curl(2), squat(1), squat(2), squat(3)],
      6,
      false,
      "벤치프레스 1·2세트, 레그 컬 2세트, 다른 세트 9개 기록은 저장되지 않았어요.",
    ],
    [[bench(1)], 1, false, "벤치프레스 1세트, 다른 세트 1개 기록은 저장되지 않았어요."],
    [[], 2, false, "세트 2개 기록은 저장되지 않았어요."],
    [[], 0, true, "운동 종료는 저장되지 않았어요."],
    [
      [bench(1)],
      0,
      true,
      "벤치프레스 1세트 기록은 저장되지 않았어요. 운동 종료도 저장되지 않았어요.",
    ],
  ] as const)("%j + %i unknown, finish %s → %s", (rows, unknown, finish, copy) => {
    expect(unsavedCopy(rows, unknown, finish)).toBe(copy);
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
