import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import type { RecommendationInput } from "../src/types";

function minimum(id?: string, override: Partial<RecommendationInput> = {}) {
  return recommendNextSet({
    goal: "hypertrophy",
    exercise: {
      id,
      type: "compound",
      region: "upper",
      step_kg: 2.5,
      load_semantics: "assistance",
    },
    target: { reps_low: 8, reps_high: 12, rir: 2 },
    last_sets: [{ w: 2.5, reps: 12 }],
    assistance: { has_valid_positive_assistance: true },
    rules_version: "2026.08.2",
    ...override,
  } as RecommendationInput);
}

describe("assistance transition metadata does not change the numeric recommendation", () => {
  it.each([
    ["e_assisted_pullup", "e_pullup"],
    ["e_assisted_dips", "e_dips"],
  ])("%s suggests only its canonical unassisted counterpart", (id, target) => {
    expect(minimum(id)).toMatchObject({
      weight: 2.5,
      reps_low: 8,
      reason_code: "ASSISTANCE_MINIMUM_REACHED",
      load_kind: "assistance",
      recommendation_state: "ready",
      recommended_action: { kind: "suggest_exercise_swap", exercise_id: target },
    });
  });

  it.each([undefined, "", "unknown", "e_dips", "e_pullup", "e_bench_press"])(
    "missing/unknown/external metadata %s keeps minimum assistance but suggests nothing",
    (id) => {
      expect(minimum(id)).toMatchObject({
        weight: 2.5,
        reason_code: "ASSISTANCE_MINIMUM_REACHED",
        recommendation_state: "ready",
        recommended_action: null,
      });
    },
  );

  it.each(["e_assisted_pullup", "e_assisted_dips", undefined, "unknown"])(
    "%s preserves progression, hard-session relief, safety and nonminimum actions",
    (id) => {
      const progression = minimum(id, { last_sets: [{ w: 20, reps: 12 }] });
      expect(progression).toMatchObject({
        weight: 17.5,
        reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
        load_kind: "assistance",
      });
      expect(progression.recommended_action ?? null).toBeNull();
      const hard = minimum(id, { last_sets: [{ w: 20, reps: 6 }] });
      expect(hard).toMatchObject({ weight: 22.5, reason_code: "ASSISTANCE_UP_TOO_HARD" });
      expect(hard.recommended_action ?? null).toBeNull();
      expect(minimum(id, { safety: { pain_score: 4 } })).toMatchObject({
        weight: null,
        reason_code: "SUBSTITUTE_PAIN",
        recommendation_state: "substitution_required",
        recommended_action: null,
      });
      expect(minimum(id, { last_sets: [{ w: Number.NaN, reps: 12 }] })).toMatchObject({
        weight: null,
        reason_code: "INVALID_INPUT",
        recommendation_state: "unavailable",
        recommended_action: null,
      });
    },
  );

  it("known assisted ID cannot turn an external snapshot into assistance", () => {
    const output = minimum("e_assisted_dips", {
      exercise: {
        id: "e_assisted_dips",
        type: "compound",
        region: "upper",
        step_kg: 2.5,
        load_semantics: "external_load",
      } as RecommendationInput["exercise"],
      last_sets: [{ w: 20, reps: 12 }],
    });
    expect(output).toMatchObject({
      weight: 22.5,
      reason_code: "WEIGHT_UP_REP_TARGET_MET",
      load_kind: "external",
    });
    expect(output.recommended_action ?? null).toBeNull();
  });
});
