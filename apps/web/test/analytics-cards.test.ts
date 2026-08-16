import { expect, it } from "vitest";
import type { E1rmAnalytics } from "../lib/api";
import { e1rmDelta } from "../components/analytics/AnalyticsCards";

function analytics(gate_state: E1rmAnalytics["gate_state"]): E1rmAnalytics {
  return {
    exercise_id: "bench",
    sample_session_count: gate_state === "ready" ? 3 : 2,
    gate_state,
    observations: [],
    points: [
      { session_id: "s1", date: "2026-08-01", e1rm: 75.3, method: "corrected", is_pr: false },
      { session_id: "s2", date: "2026-08-08", e1rm: 78.5, method: "corrected", is_pr: true },
    ],
    next_recommendation: null,
  };
}

it("ready 서버 points의 첫 값과 마지막 값으로 4주 delta를 계산한다", () => {
  expect(e1rmDelta(analytics("ready"))).toBe(3.2);
});

it("early payload에 값이 잘못 남아 있어도 delta를 복구하지 않는다", () => {
  expect(e1rmDelta(analytics("early"))).toBeNull();
});

it("ready여도 비교점이 하나면 변화량을 추측하지 않는다", () => {
  const value = analytics("ready");
  value.points = value.points.slice(0, 1);
  expect(e1rmDelta(value)).toBeNull();
});
