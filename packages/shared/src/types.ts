/**
 * 추천 엔진 입출력 타입 — docs/RECOMMENDATION_ENGINE.md "함수 시그니처" 절이 원천.
 * 로직은 STEP 3에서 구현한다(계약: docs/specs/golden_tests.json).
 */

import type { PainFailureCode } from "./assistance";

export type Goal = "diet" | "hypertrophy" | "strength";
export type ExerciseType = "compound" | "isolation";
export type Region = "upper" | "lower" | "core";
/** 진행 축. reps = 무게·반복, time = 유지 시간(e_plank). 미지정이면 reps. */
export type Metric = "reps" | "time";

/**
 * 부하 유형. 입력이 아니라 `metric`·`step_kg` 에서 파생한다(docs/PROGRAM_V2_CONTRACT.md §4.1).
 * "추천값의 상태"는 여기 넣지 않는다 — 그건 `RecommendationState` 다.
 */
export type LoadKind = "external" | "bodyweight" | "assistance" | "not_applicable";

/**
 * 무게 숫자의 의미. 카탈로그 메타데이터이고 **입력 축이 아니다**.
 * `assistance` 는 "기계가 덜어주는 kg" 이라 **줄어야 어려워진다** — 방향이 반대다.
 */
export type LoadSemantics = "external_load" | "assistance";

/** 최소 경계에서 사용자에게 제안만 하는 행동. 자동 전환은 하지 않는다. */
export interface RecommendedAction {
  kind: "suggest_exercise_swap";
  exercise_id: string;
}

/**
 * 이 처방을 그대로 수행해도 되는가(PROGRAM_V2_CONTRACT.md §1.2).
 * `load_calibration_needed` 만 external 무게 축의 substate 이고,
 * `substitution_required`·`unavailable` 은 수행 자체를 막는 safety/error 상태다.
 */
export type RecommendationState =
  "ready" | "load_calibration_needed" | "substitution_required" | "unavailable";

export const REASON_CODES = [
  "WEIGHT_UP_REP_TARGET_MET",
  "ADD_ONE_REP",
  "HOLD_RIR_LOW",
  "TOO_HARD",
  "LOAD_CALIBRATION_NEEDED",
  "BASELINE",
  "INVALID_INPUT",
  "SUBSTITUTE_PAIN",
  "RIR_TOO_EASY_INCREASE",
  "RIR_TOO_HARD_REDUCE",
  "REPS_UP_BODYWEIGHT",
  "PROGRESSION_CAP_BODYWEIGHT",
  "SUBSTITUTE_TOO_HARD_BODYWEIGHT",
  "TIME_UP",
  "TIME_HOLD",
  "TIME_DOWN",
  // 어시스트 전용(2026.08.2+). generic sign flip 금지 — 방향이 반대라 문구를 재사용할 수 없다.
  "ASSISTANCE_CALIBRATION_NEEDED",
  "ASSISTANCE_DOWN_REP_TARGET_MET",
  "ASSISTANCE_DOWN_RIR_EASY",
  "ASSISTANCE_UP_RIR_HARD",
  "ASSISTANCE_UP_TOO_HARD",
  "ASSISTANCE_MINIMUM_REACHED",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * 실행 경로가 없어 **응답에 나올 수 없는** 코드. `REASON_CODES` 에 남겨 두면 모든 소비자가
 * 가능한 응답으로 처리해야 하므로 "예약"이 아니라 부채다.
 *
 * 되살릴 때는 **입력·emit 경로·테스트와 함께 원자적으로** union 으로 옮긴다. 여기 있는 동안은
 * 사용자 설명 map 과 실제 응답 어디에도 넣지 않는다(V2-REASON-01).
 *
 * - `SIMILAR_INIT` — 유사 운동 e1RM 초기값. 소유: 별도 기능 티켓
 * - `VOLUME_SPIKE_CAP` — 주간 볼륨 급증 캡. 집계 데이터(`muscle_weekly_load`)는 있으나
 *   엔진 입력 채널과 **오프라인 미러 대책이 없다**. 소유: `V2-PLAN-02`
 * - `DELOAD_SUGGESTED` — 디로드 제안. 다세션 추세·피로 입력 없음. 소유: P3 회복 주간
 * - `CALIBRATION_STALE` — 재측정 필요. **stale 정책이 사람 승인 전이다.** 소유: 승인 후 별도 티켓
 *
 * `CALIBRATION_NEEDED`/`CALIBRATION_GRADUATED` 는 여기 없다 — 추천 근거가 아니라
 * **튜토리얼 상태**이므로 `CalibrationStatus`(`not_started|in_progress|graduated|stale`)로 표현한다.
 * `RIR_ON_TARGET_HOLD` 도 없다 — on-target 은 별도 reason 을 만들지 않고 더블 프로그레션으로
 * 넘긴다는 것이 설계이므로 되살릴 계획 자체가 없다.
 */
export const RESERVED_REASON_CODES = [
  "SIMILAR_INIT",
  "VOLUME_SPIKE_CAP",
  "DELOAD_SUGGESTED",
  "CALIBRATION_STALE",
] as const;

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
    /** Canonical metadata for a transition suggestion; never changes load calculations. */
    id?: string;
    type: ExerciseType;
    region: Region;
    /** null = 맨몸(자체중량): 부하 대신 반복으로 진행한다. 0 은 잘못된 증량 단위(INVALID_INPUT). */
    step_kg: number | null;
    /** 기본값 reps. */
    metric?: Metric;
    /** 기본값 `external_load`. `assistance` 는 assistance-capable bundle 에서만 해석된다. */
    load_semantics?: LoadSemantics;
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
  /**
   * 최근 완료 세션의 안전 신호. `pain_failure_code` 는 **API encryption adapter** 가
   * 복호화에 실패했을 때만 채운다 — `shared` 는 암호문을 직접 다루지 않는다(F-1 경계).
   */
  safety?: { pain_score?: number; pain_failure_code?: PainFailureCode };
  /**
   * 어시스트 종목의 **lifetime graduation evidence**. `latest_sets` 와 출처가 다르다 —
   * 최신 세션이 통증·무효여도 과거 valid positive 가 있으면 캘리브레이션은 퇴행하지 않는다.
   */
  assistance?: { has_valid_positive_assistance: boolean };
  rules_version: string;
}

export interface Recommendation {
  /**
   * null = 자체중량(맨몸)·시간 종목, 또는 V2 external 무이력(캘리브레이션 필요).
   * 둘의 구분은 `load_kind` 가 한다 — null 하나로 판별하지 않는다.
   */
  weight: number | null;
  /** 모든 경로에서 채운다. `metric`·`step_kg` 파생값이라 입력에 없어도 항상 결정된다. */
  load_kind: LoadKind;
  /** 모든 경로에서 채운다. 안전·오류 경로가 `ready` 로 떨어지지 않는다. */
  recommendation_state: RecommendationState;
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
  /**
   * 최소 경계 제안. **safety state 에서는 항상 null** 이다 —
   * 멈추라고 해놓고 다른 운동으로 넘어가라고 동시에 말하지 않는다.
   */
  recommended_action?: RecommendedAction | null;
}
