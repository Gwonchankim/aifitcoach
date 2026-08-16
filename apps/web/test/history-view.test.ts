import { describe, expect, it } from "vitest";
import type { E1rmAnalytics, Exercise } from "../lib/api";
import {
  hasChartGap,
  historyVisibility,
  similarExercises,
} from "../components/history/history-view";

function analytics(gate_state: E1rmAnalytics["gate_state"]): E1rmAnalytics {
  return {
    exercise_id: "bench",
    sample_session_count: gate_state === "ready" ? 3 : gate_state === "early" ? 2 : 0,
    gate_state,
    observations: [
      { session_id: "s1", date: "2026-08-01" },
      { session_id: "s2", date: "2026-08-08" },
    ],
    // 악성/오래된 캐시에 값이 있어도 gate_state가 early면 화면이 값·선을 만들면 안 된다.
    points: [
      {
        session_id: "s1",
        date: "2026-08-01",
        e1rm: 42.5,
        method: "corrected_rir_epley",
        is_pr: false,
      },
    ],
    next_recommendation: {
      exercise_id: "bench",
      weight: 42.5,
      reps_low: 8,
      reps_high: 10,
      sets: 3,
      reason_code: "UP",
      confidence: 0.8,
      explanation: "42.5kg 추천",
      rules_version: "v1",
    },
  };
}

describe("server-authoritative history display gate", () => {
  it("0회는 값·선·추천을 모두 숨긴다", () => {
    expect(historyVisibility(analytics("no_history"))).toEqual({
      showObservationDots: false,
      showTrendLine: false,
      showE1rmValues: false,
      showRecommendation: false,
    });
  });

  it("1~2회는 observation 점만 보이고 값·선·42.5kg 추천을 구조적으로 숨긴다", () => {
    expect(historyVisibility(analytics("early"))).toEqual({
      showObservationDots: true,
      showTrendLine: false,
      showE1rmValues: false,
      showRecommendation: false,
    });
  });

  it("3회 이상 ready에서만 추이와 서버 추천을 연다", () => {
    expect(historyVisibility(analytics("ready"))).toEqual({
      showObservationDots: false,
      showTrendLine: true,
      showE1rmValues: true,
      showRecommendation: true,
    });
  });
});

it("14일을 넘는 공백은 선을 끊는다", () => {
  const value = analytics("ready");
  value.points.push({
    session_id: "s2",
    date: "2026-08-20",
    e1rm: 45,
    method: "corrected_rir_epley",
    is_pr: true,
  });
  expect(hasChartGap(value.points)).toBe(true);
});

it("비슷한 종목은 substitution 우선, 같은 패턴 이름순으로 최대 3개다", () => {
  const exercise = (id: string, name_ko: string, substitutions: string[] = []): Exercise => ({
    id,
    name_ko,
    name_en: id,
    movement_pattern: "push",
    primary_muscles: ["chest"],
    equipment: "barbell",
    difficulty: "beginner",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: 2.5,
    rep_range_low: 8,
    rep_range_high: 10,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions,
    media_url: null,
  });
  const selected = exercise("a", "기준", ["d"]);
  expect(
    similarExercises(selected, [
      exercise("c", "다"),
      exercise("b", "나"),
      exercise("d", "라"),
      exercise("e", "마"),
    ]).map((item) => item.id),
  ).toEqual(["d", "b", "c"]);
});
