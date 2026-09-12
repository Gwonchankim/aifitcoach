import { describe, expect, it } from "vitest";
import { REASON_CODES } from "../src/types";
import { normalizeRecommendationState } from "../src/recommendation-state";
import { recommendationStateFixtures } from "./fixtures/recommendation-state";

describe("ADR-70 recommendation state OR normalization", () => {
  it("SIMILAR_INIT is a runtime benign reason", () => {
    expect(REASON_CODES).toContain("SIMILAR_INIT");
    expect(
      normalizeRecommendationState({ reason: "SIMILAR_INIT", weight: 45, load_kind: "external" }),
    ).toBe("ready");
  });
  it.each(recommendationStateFixtures)("$name", ({ input, expected }) => {
    expect(normalizeRecommendationState(input)).toBe(expected);
  });

  it.each([
    [{ state: "unavailable", reason: "SUBSTITUTE_PAIN" }, "substitution_required"],
    [{ state: "substitution_required", reason: "INVALID_INPUT" }, "substitution_required"],
    [{ state: "load_calibration_needed", reason: "INVALID_INPUT" }, "unavailable"],
    [{ state: "ready", reason: "LOAD_CALIBRATION_NEEDED" }, "load_calibration_needed"],
    [{ state: "unknown", reason: "BASELINE", load_kind: "bodyweight" }, "ready"],
    [{ state: "unknown", reason: "BASELINE" }, "unavailable"],
    [{ reason: "BASELINE", weight: null, load_kind: "external" }, "load_calibration_needed"],
    [
      { reason: "ASSISTANCE_CALIBRATION_NEEDED", load_kind: "assistance" },
      "load_calibration_needed",
    ],
  ] as const)("resolves conflicting and legacy signals %j", (input, expected) => {
    expect(normalizeRecommendationState(input)).toBe(expected);
  });
});
