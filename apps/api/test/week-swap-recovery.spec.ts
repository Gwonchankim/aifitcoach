import {
  checkWeekSwapRecovery,
  type WeekSwapRecoverySession,
} from "../src/programs/week-swap-recovery";

const session = (
  key: string,
  date: string,
  ...regions: WeekSwapRecoverySession["regions"]
): WeekSwapRecoverySession => ({ key, date, regions });
const pass = { ok: true, reason: null, violations: [] };
const unverifiable = { ok: false, reason: "recovery_unverifiable", violations: [] };

describe("checkWeekSwapRecovery", () => {
  it("rejects both new 24-hour overlaps when Monday upper and Friday lower swap", () => {
    const result = checkWeekSwapRecovery(
      [
        session("mon", "2026-08-10", "upper"),
        session("tue", "2026-08-11", "lower"),
        session("thu", "2026-08-13", "upper"),
        session("fri", "2026-08-14", "lower"),
      ],
      ["mon", "fri"],
    );
    expect(result).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [
        { keys: ["fri", "tue"], gapDays: 1, overlap: ["lower"] },
        { keys: ["thu", "mon"], gapDays: 1, overlap: ["upper"] },
      ],
    });
  });

  it("allows a within-week swap with no overlapping regions", () => {
    expect(
      checkWeekSwapRecovery(
        [session("a", "2026-08-10", "upper"), session("b", "2026-08-11", "lower")],
        ["a", "b"],
      ),
    ).toEqual(pass);
  });

  it("allows exactly 48 hours even across a UTC month boundary", () => {
    expect(
      checkWeekSwapRecovery(
        [session("a", "2026-08-31", "upper"), session("b", "2026-09-02", "upper")],
        ["a", "b"],
      ),
    ).toEqual(pass);
  });

  it("rejects exactly 24 hours and reports a swapped-pair violation only once", () => {
    expect(
      checkWeekSwapRecovery(
        [session("a", "2026-08-31", "upper"), session("b", "2026-09-01", "upper")],
        ["a", "b"],
      ),
    ).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [{ keys: ["b", "a"], gapDays: 1, overlap: ["upper"] }],
    });
  });

  it("checks the preceding week's neighbor of a swapped session", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("previous-sunday", "2026-08-09", "upper"),
          session("mon", "2026-08-10", "lower"),
          session("thu", "2026-08-13", "upper"),
        ],
        ["mon", "thu"],
      ),
    ).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [{ keys: ["previous-sunday", "thu"], gapDays: 1, overlap: ["upper"] }],
    });
  });

  it("checks the next week's neighbor of a swapped session", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("thu", "2026-08-13", "upper"),
          session("sun", "2026-08-16", "lower"),
          session("next-monday", "2026-08-17", "upper"),
        ],
        ["thu", "sun"],
      ),
    ).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [{ keys: ["thu", "next-monday"], gapDays: 1, overlap: ["upper"] }],
    });
  });

  it("keeps core-only neighbors in the timeline but excludes core from overlap", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("sun", "2026-08-09", "core"),
          session("mon", "2026-08-10", "upper", "core"),
          session("tue", "2026-08-11", "core"),
          session("thu", "2026-08-13", "lower", "core"),
          session("fri", "2026-08-14", "core"),
        ],
        ["mon", "thu"],
      ),
    ).toEqual(pass);
  });

  it("deduplicates and orders the upper/lower intersection, never including core", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("a", "2026-08-10", "core", "lower", "upper", "upper"),
          session("b", "2026-08-11", "lower", "core", "upper"),
        ],
        ["a", "b"],
      ),
    ).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [{ keys: ["b", "a"], gapDays: 1, overlap: ["upper", "lower"] }],
    });
  });

  it("ignores pre-existing violations between two uninvolved sessions", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("unrelated-a", "2026-08-07", "upper"),
          session("unrelated-b", "2026-08-08", "upper"),
          session("a", "2026-08-10", "lower"),
          session("b", "2026-08-13", "upper"),
        ],
        ["a", "b"],
      ),
    ).toEqual(pass);
  });

  it("sorts independently of input and pair order without mutating caller data", () => {
    const sessions = Object.freeze([
      Object.freeze(session("b", "2026-08-11", "upper")),
      Object.freeze(session("a", "2026-08-10", "upper")),
    ]);
    const before = JSON.stringify(sessions);
    const pair = Object.freeze(["b", "a"] as const);
    expect(checkWeekSwapRecovery(sessions, pair)).toEqual({
      ok: false,
      reason: "recovery_gap_violation",
      violations: [{ keys: ["b", "a"], gapDays: 1, overlap: ["upper"] }],
    });
    expect(JSON.stringify(sessions)).toBe(before);
    expect(pair).toEqual(["b", "a"]);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-08-32", "2026-8-10", "2026-08-10T12:00:00Z", ""])(
    "fails closed on a noncanonical or invalid UTC date: %s",
    (date) => {
      expect(
        checkWeekSwapRecovery(
          [session("a", date, "upper"), session("b", "2026-08-13", "lower")],
          ["a", "b"],
        ),
      ).toEqual(unverifiable);
    },
  );

  it("accepts a real leap date", () => {
    expect(
      checkWeekSwapRecovery(
        [session("a", "2028-02-29", "upper"), session("b", "2028-03-02", "upper")],
        ["a", "b"],
      ),
    ).toEqual(pass);
  });

  it.each([
    [session("a", "2026-08-10", "upper"), session("b", "2026-08-10", "lower")],
    [session("a", "2026-08-10", "upper"), session("a", "2026-08-13", "lower")],
    [session("", "2026-08-10", "upper"), session("b", "2026-08-13", "lower")],
    [session("a", "2026-08-10"), session("b", "2026-08-13", "lower")],
    [],
  ])("fails closed on ambiguous or incomplete sessions: %j", (...sessions) => {
    expect(checkWeekSwapRecovery(sessions, ["a", "b"])).toEqual(unverifiable);
  });

  it.each([
    ["a", "a"],
    ["a", "missing"],
    ["", "b"],
  ] as const)("fails closed on invalid pair %s / %s", (first, second) => {
    expect(
      checkWeekSwapRecovery(
        [session("a", "2026-08-10", "upper"), session("b", "2026-08-13", "lower")],
        [first, second],
      ),
    ).toEqual(unverifiable);
  });

  it("fails closed on an unsupported runtime region", () => {
    expect(
      checkWeekSwapRecovery(
        [
          session("a", "2026-08-10", "cardio" as "upper"),
          session("b", "2026-08-13", "lower"),
        ],
        ["a", "b"],
      ),
    ).toEqual(unverifiable);
  });
});
