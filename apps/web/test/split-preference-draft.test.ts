import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_OPTIONS,
  INITIAL_DRAFT,
  STEP_COUNT,
  normalizeDraft,
  toGenerateRequest,
} from "../components/onboarding/draft";

describe("split preference request boundary", () => {
  it("sends explicit five-day preference only when the profile advertises support", () => {
    const draft = {
      ...INITIAL_DRAFT,
      days_per_week: 5 as const,
      split_preference: "lower_priority" as const,
    };
    expect(toGenerateRequest(draft, true).split_preference).toBe("lower_priority");
    expect(toGenerateRequest(draft, false)).not.toHaveProperty("split_preference");
  });
  it("never submits cleared preference as null or unsupported saved priority", () => {
    for (const days of [2, 3, 4, 6] as const) {
      expect(
        toGenerateRequest(
          { ...INITIAL_DRAFT, days_per_week: days, split_preference: "upper_priority" },
          true,
        ),
      ).not.toHaveProperty("split_preference");
    }
    expect(
      toGenerateRequest({ ...INITIAL_DRAFT, days_per_week: 5, split_preference: null }, true),
    ).not.toHaveProperty("split_preference");
    expect(
      toGenerateRequest({ ...INITIAL_DRAFT, days_per_week: 4, split_preference: "balanced" }, true)
        .split_preference,
    ).toBe("balanced");
  });
  it("restores an explicit choice or clear but never invents a selection from unknown local data", () => {
    for (const preference of ["balanced", "upper_priority", "lower_priority", null] as const) {
      expect(
        normalizeDraft({ draft: { ...INITIAL_DRAFT, split_preference: preference }, step: 2 })
          ?.draft.split_preference,
      ).toBe(preference);
    }
    expect(
      normalizeDraft({ draft: { ...INITIAL_DRAFT, split_preference: "unknown" } })?.draft,
    ).not.toHaveProperty("split_preference");
  });
  it("adds an opt-in bike after the original six equipment options without adding a step", () => {
    expect(STEP_COUNT).toBe(7);
    expect(EQUIPMENT_OPTIONS).toEqual([
      { value: "barbell", label: "바벨" },
      { value: "dumbbell", label: "덤벨" },
      { value: "machine", label: "머신" },
      { value: "cable", label: "케이블" },
      { value: "bodyweight", label: "맨몸" },
      { value: "ez_bar", label: "EZ바" },
      { value: "stationary_bike", label: "고정식 자전거" },
    ]);
    expect(INITIAL_DRAFT.equipment).toEqual([
      "barbell",
      "dumbbell",
      "machine",
      "cable",
      "bodyweight",
      "ez_bar",
    ]);
  });
});
