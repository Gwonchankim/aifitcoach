import { describe, expect, it } from "vitest";
import type { PlannedSet } from "../lib/api";
import { recommendationNote } from "../components/session/set-rules";

describe("ADR-70 copy axis", () => {
  const set = { load_kind: "external", reason_code: "BASELINE", recommended_weight: null };
  it.each([
    [
      "load_calibration_needed",
      "추천 무게가 아직 없어요. 가볍게 워밍업하며 목표 반복을 수행할 무게를 정해 주세요.",
    ],
    ["substitution_required", "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요."],
    ["unavailable", "입력값을 확인한 뒤 다시 시도하세요."],
  ] as const)("%s is independent of analysis maturity", (state, text) => {
    for (const recommendation_gate of ["no_history", "early", "ready"] as const) {
      expect(
        recommendationNote({
          ...set,
          recommendation_state: state,
          recommendation_gate,
        } as PlannedSet),
      ).toBe(text);
    }
  });
  it("ready has no extra state line", () => {
    expect(
      recommendationNote({
        ...set,
        recommended_weight: 60,
        recommendation_state: "ready",
      } as PlannedSet),
    ).toBeNull();
  });
  it("ready external zero keeps the neutral fallback", () => {
    expect(
      recommendationNote({
        ...set,
        reason_code: "TOO_HARD",
        recommended_weight: 0,
        recommendation_state: "ready",
      } as PlannedSet),
    ).toBe("추천 무게를 정하지 못했어요. 오늘의 무게를 직접 정해 주세요.");
  });
  it("assistance calibration uses the help axis", () => {
    expect(
      recommendationNote({
        ...set,
        load_kind: "assistance",
        reason_code: "ASSISTANCE_CALIBRATION_NEEDED",
        recommendation_state: "load_calibration_needed",
      } as PlannedSet),
    ).toBe("기계에서 편한 도움 무게를 직접 정해요");
  });
  it("provisional has no prescription state and no new copy", () => {
    expect(
      recommendationNote({ reason_code: "BASELINE", recommended_weight: 0 } as PlannedSet),
    ).toBeNull();
  });
});
