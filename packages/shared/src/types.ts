/**
 * 추천 엔진 입출력 타입 — docs/RECOMMENDATION_ENGINE.md "함수 시그니처" 절이 원천.
 * 로직은 STEP 3에서 구현한다(계약: docs/specs/golden_tests.json).
 */

export type Goal = "diet" | "hypertrophy" | "strength";
export type ExerciseType = "compound" | "isolation";
export type Region = "upper" | "lower" | "core";
/** 진행 축. reps = 무게·반복, time = 유지 시간(e_plank). 미지정이면 reps. */
export type Metric = "reps" | "time";

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
  "REPS_UP_BODYWEIGHT",
  "PROGRESSION_CAP_BODYWEIGHT",
  "SUBSTITUTE_TOO_HARD_BODYWEIGHT",
  "TIME_UP",
  "TIME_HOLD",
  "TIME_DOWN",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** metric=reps 는 w/reps(맨몸이면 w 생략 가능), metric=time 은 time_sec 만 채운다. */
export interface PerformedSet {
  w?: number;
  reps?: number;
  rir?: number;
  /** metric=time 종목의 유지 시간(초). 시간 종목은 RIR 을 수집하지 않는다. */
  time_sec?: number;
}

export interface RecommendationInput {
  goal: Goal;
  exercise: {
    type: ExerciseType;
    region: Region;
    /** null = 맨몸(자체중량): 부하 대신 반복으로 진행한다. 0 은 잘못된 증량 단위(INVALID_INPUT). */
    step_kg: number | null;
    /** 기본값 reps. */
    metric?: Metric;
  };
  /** metric=reps 는 reps_low/reps_high/rir, metric=time 은 time_low_sec/time_high_sec 이 필요하다. */
  target: {
    reps_low?: number;
    reps_high?: number;
    rir?: number;
    time_low_sec?: number;
    time_high_sec?: number;
  };
  last_sets: PerformedSet[];
  calibration?: { rir_bias: number };
  safety?: { pain_score: number };
  rules_version: string;
}

export interface Recommendation {
  /** null = 자체중량(맨몸)·시간 종목 — 추가 부하를 처방하지 않는다. */
  weight: number | null;
  /** metric=reps 에서만 채운다. */
  reps_low?: number;
  reps_high?: number;
  sets?: number;
  /** metric=time 에서만 채운다. */
  time_low_sec?: number;
  time_high_sec?: number;
  reason_code: ReasonCode;
  confidence: number;
  rules_version: string;
  /** 표시·추세용 (Epley). golden_tests.json은 tolerance 내 비교. */
  e1rm?: number;
  /** 안전 가드레일(통증) 시 대체 운동 제안 여부. */
  suggest_substitution?: boolean;
}
