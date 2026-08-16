import type { E1rmAnalytics, Exercise } from "../../lib/api";

export type HistoryVisibility = {
  showObservationDots: boolean;
  showTrendLine: boolean;
  showE1rmValues: boolean;
  showRecommendation: boolean;
};

/** 서버가 적용한 D-39 gate만 신뢰한다. observation/point 개수로 임계값을 다시 계산하지 않는다. */
export function historyVisibility(analytics: E1rmAnalytics): HistoryVisibility {
  if (analytics.gate_state === "ready") {
    return {
      showObservationDots: false,
      showTrendLine: true,
      showE1rmValues: true,
      showRecommendation: analytics.next_recommendation !== null,
    };
  }
  if (analytics.gate_state === "early") {
    return {
      showObservationDots: true,
      showTrendLine: false,
      showE1rmValues: false,
      showRecommendation: false,
    };
  }
  return {
    showObservationDots: false,
    showTrendLine: false,
    showE1rmValues: false,
    showRecommendation: false,
  };
}

export function similarExercises(selected: Exercise, catalog: Exercise[], limit = 3): Exercise[] {
  const substitutionRank = new Map(selected.substitutions.map((id, index) => [id, index]));
  return catalog
    .filter(
      (exercise) =>
        exercise.id !== selected.id &&
        (substitutionRank.has(exercise.id) ||
          exercise.movement_pattern === selected.movement_pattern),
    )
    .sort(
      (left, right) =>
        (substitutionRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (substitutionRank.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.name_ko.localeCompare(right.name_ko, "ko"),
    )
    .slice(0, limit);
}

export function hasChartGap(points: E1rmAnalytics["points"], thresholdDays = 14): boolean {
  return points.some((point, index) => {
    if (index === 0) return false;
    const previous = Date.parse(`${points[index - 1].date}T00:00:00.000Z`);
    const current = Date.parse(`${point.date}T00:00:00.000Z`);
    return current - previous > thresholdDays * 86_400_000;
  });
}
