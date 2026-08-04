import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import type { RecommendationInput } from "../src/types";

const input: RecommendationInput = {
  goal: "hypertrophy",
  exercise: { type: "compound", region: "upper", step_kg: 2.5 },
  target: { reps_low: 8, reps_high: 12, rir: 2 },
  last_sets: [{ w: 60, reps: 12, rir: 2 }],
  rules_version: "2026.07.1",
};

describe("recommendNextSet", () => {
  it("STEP 3 구현 전까지는 미구현으로 실패한다", () => {
    expect(() => recommendNextSet(input)).toThrow("not implemented");
  });
});
