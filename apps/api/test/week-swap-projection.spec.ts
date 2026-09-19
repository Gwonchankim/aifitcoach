import { recoveryBundlePolicy, recoveryTemplate } from "../src/programs/week-swap-projection";

describe("weekly recovery adapter evidence", () => {
  it.each(["2026.08.1", "2026.08.2"])(
    "%s explicitly marks cardio/HIIT not applicable",
    (version) => {
      expect(recoveryBundlePolicy(version)).toBe("resistance_only_cardio_not_applicable");
    },
  );
  it.each(["2026.09.0", "unknown"])("%s cannot certify unknown cardio rules", (version) => {
    expect(recoveryBundlePolicy(version)).toBe("unverifiable");
  });
  it.each(
    [
      [{ day: "INVALID", exercises: [] }],
      [{ day: "MON", exercises: [] }],
      [{ day: "MON", exercises: [{ exercise_id: "e", sets: 0 }] }],
      [{ day: "MON", exercises: [{ exercise_id: "e", sets: 11 }] }],
      [
        {
          day: "MON",
          exercises: [
            { exercise_id: "e", sets: 1 },
            { exercise_id: "e", sets: 2 },
          ],
        },
      ],
      [
        { day: "MON", exercises: [] },
        { day: "MON", exercises: [] },
      ],
      "bad json",
    ].map((value) => [value]),
  )("rejects malformed or ambiguous template %j", (value) => {
    expect(recoveryTemplate(value)).toBeNull();
  });
});
