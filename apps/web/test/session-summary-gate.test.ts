import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSummary } from "../components/session/SessionSummary";
import type { GatedRecommendation } from "../lib/api";

function render(nextRecommendations: GatedRecommendation[]): string {
  return renderToStaticMarkup(
    createElement(SessionSummary, {
      completedCount: 3,
      totalVolume: 1200,
      nextRecommendations,
      catalogById: new Map(),
    }),
  );
}

describe("D-39 서버 권위 recommendation gate", () => {
  it("서버가 early로 제거한 추천을 웹이 다시 계산하거나 노출하지 않는다", () => {
    const markup = render([
      {
        exercise_id: "e_bench_press",
        sample_session_count: 2,
        gate_state: "early",
        recommendation: null,
      },
    ]);

    expect(markup).toContain("다음 추천은 기록이 조금 더 쌓이면 보여드릴게요.");
    expect(markup).not.toContain("다음 추천</h2>");
  });

  it("서버가 ready로 내려준 추천만 그대로 표시한다", () => {
    const markup = render([
      {
        exercise_id: "e_bench_press",
        sample_session_count: 3,
        gate_state: "ready",
        recommendation: {
          exercise_id: "e_bench_press",
          weight: 65,
          reps_low: 8,
          reps_high: 10,
          sets: 3,
          reason_code: "WEIGHT_UP_REP_TARGET_MET",
          explanation: "목표 반복을 달성해 무게를 올렸어요.",
          confidence: 0.8,
          rules_version: "2026.08.1",
          load_kind: "external",
          recommendation_state: "ready",
          recommended_action: null,
        },
      },
    ]);

    expect(markup).toContain("다음 추천</h2>");
    expect(markup).toContain("65kg · 8~10회 · 3세트");
    expect(markup).toContain("목표 반복을 달성해 무게를 올렸어요.");
  });
});
