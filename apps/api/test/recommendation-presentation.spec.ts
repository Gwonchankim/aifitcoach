import { storedRecommendationPresentation } from "../src/recommendation/recommendation-presentation";

describe("ADR-70 canonical metadata for nullable stored loads", () => {
  const row = {
    reasonCode: "BASELINE",
    recommendedWeight: null,
    loadSemantics: "external_load" as const,
    targetTimeHighSec: null,
    rulesVersion: "2026.09.0",
  };
  it("V2 external null requires calibration", () => {
    expect(storedRecommendationPresentation(row, { metric: "reps", defaultStepKg: 2.5 })).toEqual({
      load_kind: "external",
      recommendation_state: "load_calibration_needed",
      recommended_weight: null,
    });
  });
  it("bodyweight null is ready", () => {
    expect(storedRecommendationPresentation(row, { metric: "reps", defaultStepKg: null })).toEqual({
      load_kind: "bodyweight",
      recommendation_state: "ready",
      recommended_weight: null,
    });
  });
  it("missing catalog fails closed while retaining the weight input axis", () => {
    expect(storedRecommendationPresentation(row)).toEqual({
      load_kind: "external",
      recommendation_state: "unavailable",
      recommended_weight: null,
    });
  });
  it("assistance uses its immutable snapshot before current catalog", () => {
    expect(
      storedRecommendationPresentation(
        { ...row, loadSemantics: "assistance", reasonCode: "ASSISTANCE_CALIBRATION_NEEDED" },
        { metric: "reps", defaultStepKg: null },
      ),
    ).toEqual({
      load_kind: "assistance",
      recommendation_state: "load_calibration_needed",
      recommended_weight: null,
    });
  });
});
