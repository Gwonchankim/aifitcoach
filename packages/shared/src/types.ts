/**
 * 추천 엔진 입출력 타입 — docs/RECOMMENDATION_ENGINE.md "함수 시그니처" 절이 원천.
 * 로직은 STEP 3에서 구현한다(계약: docs/specs/golden_tests.json).
 */

export type Goal = "diet" | "hypertrophy" | "strength";
export type ExerciseType = "compound" | "isolation";
export type Region = "upper" | "lower" | "core";

export const REASON_CODES = [
  "WEIGHT_UP_REP_TARGET_MET",
  "ADD_ONE_REP",
  "HOLD_RIR_LOW",
  "TOO_HARD",
  "SIMILAR_INIT",
  "BASELINE",
  "INVALID_INPUT",
  "SUBSTITUTE_PAIN",
  "VOLUME_SPIKE_CAP",
  "DELOAD_SUGGESTED",
  "RIR_TOO_EASY_INCREASE",
  "RIR_ON_TARGET_HOLD",
  "RIR_TOO_HARD_REDUCE",
  "CALIBRATION_NEEDED",
  "CALIBRATION_GRADUATED",
  "CALIBRATION_STALE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface PerformedSet {
  w: number;
  reps: number;
  rir?: number;
}

export interface RecommendationInput {
  goal: Goal;
  exercise: {
    type: ExerciseType;
    region: Region;
    step_kg: number;
  };
  target: {
    reps_low: number;
    reps_high: number;
    rir: number;
  };
  last_sets: PerformedSet[];
  calibration?: { rir_bias: number };
  safety?: { pain_score: number };
  rules_version: string;
}

export interface Recommendation {
  weight: number;
  reps_low: number;
  reps_high?: number;
  sets?: number;
  reason_code: ReasonCode;
  confidence: number;
  rules_version: string;
  /** 표시·추세용 (Epley). golden_tests.json은 tolerance 내 비교. */
  e1rm?: number;
  /** 안전 가드레일(통증) 시 대체 운동 제안 여부. */
  suggest_substitution?: boolean;
}
