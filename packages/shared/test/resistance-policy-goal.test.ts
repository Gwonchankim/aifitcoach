import { describe, expect, it } from "vitest";
import {
  resistancePolicyGoal,
  routineRepsFor,
  routineTargetRirFor,
  routineRestSecFor,
  buildProvisionalRoutineSets,
  ROUTINE_RULES_VERSION,
} from "../src/routine-plan";

describe("D6(a) resistance policy mapping", () => {
  it.each(["general_fitness", "endurance"] as const)(
    "maps %s exactly to the diet table",
    (goal) => {
      expect(resistancePolicyGoal(goal)).toBe("diet");
      for (const mechanic of ["compound", "isolation"] as const) {
        expect(routineRepsFor(goal, mechanic)).toEqual({ low: 6, high: 12 });
      }
      expect(routineTargetRirFor(goal)).toBe(3);
      expect(routineRestSecFor(goal)).toBe(90);
      const sets = buildProvisionalRoutineSets(
        goal,
        {
          id: "e_plank",
          mechanic: "isolation",
          region: "core",
          step_kg: null,
          metric: "time",
          default_time_low_sec: 30,
          default_time_high_sec: 60,
        },
        ["p1"],
      );
      expect(sets[0]).toMatchObject({
        target_reps_low: null,
        target_reps_high: null,
        target_rir: null,
        target_time_low_sec: 30,
        target_time_high_sec: 60,
        rest_sec: 90,
      });
    },
  );
  it("keeps original goals and active pointer", () => {
    for (const goal of ["diet", "hypertrophy", "strength"] as const) {
      expect(resistancePolicyGoal(goal)).toBe(goal);
    }
    expect(ROUTINE_RULES_VERSION).toBe("2026.08.1");
  });
});
