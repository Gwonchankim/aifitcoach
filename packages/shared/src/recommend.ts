import { isV2RulesBundle, supportsAssistance } from "./rules-version";
import { assistanceTransitionAction } from "./assistance-transition";
import { normalizePain, resolveSafetyOutcome } from "./safety";
import type {
  LoadKind,
  PerformedSet,
  Recommendation,
  RecommendationInput,
  RecommendationState,
} from "./types";

/**
 * 다음 세트 추천(핵심 IP). 백엔드(권위)와 프론트(오프라인 미러)가 이 함수를 공유한다.
 * 규칙: docs/RECOMMENDATION_ENGINE.md, 계약: docs/specs/golden_tests.json.
 * 순수·결정론적(부작용·랜덤·시간 의존 없음).
 */

/** 데이터 품질별 신뢰도. 규칙이 수치를 정하지 않아 골든의 confidence_max를 만족하는 최소 해석. */
const CONFIDENCE = {
  full: 0.85, // 모든 작업세트에 RIR 있음
  missingRir: 0.7, // RIR 결측 → 하향 (GC-16: <= 0.8)
  baseline: 0.5, // 기록 없음 (GC-15: <= 0.6)
} as const;

/** external 무이력의 신뢰도. 추정 자체가 없으므로 "낮은 값"이 아니라 명시적 0이다. */
const CONFIDENCE_NO_LOAD_ESTIMATE = 0;

/**
 * 부하 유형 파생 — 입력·DB 컬럼이 아니라 카탈로그 메타데이터에서 계산한다.
 * 순서가 계약이다: 시간 종목은 step_kg 와 무관하게 부하 축이 없다.
 * (현행 resistance/time 엔진 전용. V2 modality·prescription_kind 가 들어오면 그쪽이 상위 판별자다.)
 */
function loadKindOf(metric: RecommendationInput["exercise"]["metric"], stepKg: number | null) {
  if (metric === "time") return "not_applicable" as LoadKind;
  return (stepKg === null ? "bodyweight" : "external") as LoadKind;
}

/** 맨몸(step_kg=null) 진행 상한·바닥. 규칙: RECOMMENDATION_ENGINE.md "맨몸(체중 부하) 종목". */
const BODYWEIGHT_REPS_CAP = 20; // reps_high 가 여기 도달하면 반복 대신 가중·난이도 상향
const BODYWEIGHT_SUBSTITUTE_REPS = 2; // 이 이하만 나오면 하향 대신 보조 종목 제안

/** 시간 종목(metric=time) 진행 단위. 규칙: RECOMMENDATION_ENGINE.md "시간 종목". */
const TIME_STEP_THRESHOLD_SEC = 60; // 상단이 이 미만이면 작은 스텝
const TIME_STEP_SHORT_SEC = 5;
const TIME_STEP_LONG_SEC = 10;
const TIME_MIN_SEC = 10; // 하향 바닥
const TIME_DOWN_RATIO = 0.5; // 하단의 절반 미만이면 하향

/** 상단이 짧을수록 절대 증분을 작게(+5초), 60초 이상은 +10초. */
function timeStepSec(timeHighSec: number): number {
  return timeHighSec < TIME_STEP_THRESHOLD_SEC ? TIME_STEP_SHORT_SEC : TIME_STEP_LONG_SEC;
}

/** 그리드 눈금 비교용 부동소수 허용치(예: 62.5/2.5). */
const EPS = 1e-9;

function toKg(steps: number, step: number): number {
  return Math.round(steps * step * 100) / 100;
}

/**
 * step_kg 배수로 내림 정규화. 유지 경로에 쓴다 — 올림하면 "유지"가 증량이 되어버린다.
 * 근거: 안전 가드레일 3 "추천 증량 상한 캡"(docs/RECOMMENDATION_ENGINE.md) → 1스텝 상한 보장(ADR-18).
 */
function floorToStep(weight: number, step: number): number {
  return toKg(Math.floor(weight / step + EPS), step);
}

/** 현재 무게보다 높은 첫 그리드 = 최대 1스텝 증량. 오프스텝(62.5, step 5)이면 65. */
function stepUp(weight: number, step: number): number {
  return toKg(Math.floor(weight / step + EPS) + 1, step);
}

/** 현재 무게보다 낮은 첫 그리드 = 최대 1스텝 감량. 오프스텝(61, step 5)이면 60. */
function stepDown(weight: number, step: number): number {
  return Math.max(0, toKg(Math.ceil(weight / step - EPS) - 1, step));
}

/** 판정에 쓰는 작업세트(반복 축). 맨몸은 w 가 없으므로 0(자체중량)으로 채운다. */
export interface E1rmSet {
  w: number;
  reps: number;
  rir?: number;
}

/** reps<=0(미수행·오입력) 세트는 계산에서 제외한다(GC-17). */
function toWorkingSets(sets: PerformedSet[]): E1rmSet[] {
  return sets
    .filter(
      (s) =>
        (s.w === undefined || (Number.isFinite(s.w) && s.w >= 0)) &&
        s.reps !== undefined &&
        Number.isFinite(s.reps) &&
        s.reps > 0,
    )
    .map((s) => ({ w: s.w ?? 0, reps: s.reps as number, rir: s.rir }));
}

/** RIR 는 0~10 정수 범위를 벗어나면 못 믿는다(수집 UI 범위). nullable 은 정상이다. */
const RIR_MAX = 10;

/**
 * 어시스트 최신 세션은 **all-or-nothing** 으로 본다.
 *
 * generic 은 이상한 세트를 걸러내고 나머지로 계산해도 된다 — 부하 축이 절대값이라
 * 한 세트만 봐도 방향이 맞는다. 어시스트는 다르다: 못 믿을 세트를 버리고 나면
 * **남은 한 세트가 "모든 세트가 상단 도달"** 로 읽혀 도움이 줄어든다.
 * 실제로는 그 세션을 신뢰할 수 없는데 처방을 만들어내는 것이다.
 */
function isUsableAssistanceSession(sets: PerformedSet[]): boolean {
  if (sets.length === 0) return false;
  return sets.every((s) => {
    if (s.w === undefined || !Number.isFinite(s.w) || s.w <= 0) return false;
    if (s.reps === undefined || !Number.isInteger(s.reps) || s.reps <= 0) return false;
    if (s.rir === undefined) return true; // RIR 은 nullable 이다
    return Number.isInteger(s.rir) && s.rir >= 0 && s.rir <= RIR_MAX;
  });
}

/** time_sec<=0(미수행·오입력) 세트는 계산에서 제외한다. */
function validTimesSec(sets: PerformedSet[]): number[] {
  return sets
    .map((s) => s.time_sec)
    .filter((t): t is number => t !== undefined && Number.isFinite(t) && t > 0);
}

/** corrected_RIR = clamp(reported + rir_bias, 0, 6) */
export function correctedRir(rir: number, bias: number): number {
  return Math.min(6, Math.max(0, rir + bias));
}

/** Epley + RIR 보정: effective_reps = reps + corrected_RIR. 저반복(<=6) 세트 우선, 그 중 최대값. */
export function estimateE1rm(sets: E1rmSet[], bias: number): number | undefined {
  if (sets.length === 0) return undefined;
  const lowRep = sets.filter((s) => s.reps <= 6);
  const source = lowRep.length > 0 ? lowRep : sets;
  const values = source.map((s) => {
    const effectiveReps = s.reps + (s.rir === undefined ? 0 : correctedRir(s.rir, bias));
    return s.w * (1 + effectiveReps / 30);
  });
  return Math.round(Math.max(...values) * 100) / 100;
}

export function recommendNextSet(input: RecommendationInput): Recommendation {
  // goal은 target(reps/rir) 산출에 이미 반영되어 들어오므로 여기선 사용하지 않는다.
  const { exercise, target, last_sets, calibration, safety, rules_version } = input;
  // 지원하지 않는 bundle 이면 **아무것도 계산하기 전에** 막는다(fail closed).
  // 경로별로 갈라지면 시간 종목만 통과하는 구멍이 생기므로 진입점 한 곳에서 판정한다.
  const isV2 = isV2RulesBundle(rules_version);
  if (exercise.metric === "time") return recommendTime(input);
  // 어시스트는 **부호가 반대인 별도 축**이다. `2026.08.1` 은 이 의미를 모르므로
  // 그 버전의 저장된 행은 지금처럼 일반 가중 운동으로 해석해야 재현이 맞는다.
  if (exercise.load_semantics === "assistance" && supportsAssistance(rules_version)) {
    return recommendAssistance(input);
  }

  const bias = calibration?.rir_bias ?? 0;
  const step = exercise.step_kg; // null = 맨몸(자체중량)
  const sets = toWorkingSets(last_sets);
  const lastWeight = sets.length > 0 ? sets[sets.length - 1]!.w : 0;
  // 맨몸은 외부 부하가 없어 Epley e1RM 이 의미 없다(체중을 모르면 산출 불가).
  const e1rm = step === null ? undefined : estimateE1rm(sets, bias);
  const hasAllRir = sets.length > 0 && sets.every((s) => s.rir !== undefined);
  // 데이터 품질 기반 신뢰도. 모든 경로(안전 경로 포함)가 같은 값을 쓴다.
  const confidence =
    sets.length === 0 ? CONFIDENCE.baseline : hasAllRir ? CONFIDENCE.full : CONFIDENCE.missingRir;

  // 진행 경로는 전부 ready 다. 안전·오류·캘리브레이션 경로만 아래에서 덮어쓴다.
  const base = {
    reps_high: target.reps_high,
    rules_version,
    e1rm,
    load_kind: loadKindOf(exercise.metric, step),
    recommendation_state: "ready" as RecommendationState,
  };

  // 1) 안전 가드레일 — 진행규칙보다 항상 우선. 판정은 F-1 primitive 한 곳에서 한다.
  const safetyOutcome = resolveSafetyOutcome(normalizePain(safety));
  if (safetyOutcome === "substitution_required") {
    return {
      ...base,
      recommendation_state: "substitution_required",
      // 안전 경로는 입력 검증보다 먼저라 step_kg가 비정상일 수 있다(그 땐 그리드 없이 유지).
      // 맨몸은 내릴 부하가 없어 null(대체 종목 제안으로 대응).
      weight: step === null ? null : step > 0 ? stepDown(lastWeight, step) : lastWeight,
      reps_low: target.reps_low,
      reason_code: "SUBSTITUTE_PAIN",
      confidence,
      suggest_substitution: true,
    };
  }
  // 통증 값을 읽지 못했으면 "괜찮다"가 아니라 멈춘다(fail-closed).
  if (safetyOutcome === "unavailable") {
    return {
      ...base,
      recommendation_state: "unavailable",
      weight: step === null ? null : lastWeight,
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 2) 비정상 입력 — 진행 계산 불가. step_kg=null(맨몸)은 정상, 0·음수는 잘못된 증량 단위.
  const repsLow = target.reps_low ?? 0;
  const repsHigh = target.reps_high ?? 0;
  const targetRir = target.rir;
  if (
    (step !== null && !(step > 0)) ||
    !(repsLow > 0) ||
    repsHigh < repsLow ||
    targetRir === undefined
  ) {
    return {
      ...base,
      recommendation_state: "unavailable",
      weight: step === null ? null : lastWeight, // 그리드를 신뢰할 수 없으므로 정규화 없이 유지
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 3) 기록 없음 — 보수적 첫 세션(무게는 사용자 입력/워밍업으로 결정).
  if (sets.length === 0) {
    // 맨몸은 처방할 외부 부하가 없으므로 첫 세션부터 ready 다.
    if (step === null) {
      return { ...base, weight: null, reps_low: repsLow, reason_code: "BASELINE", confidence };
    }
    // external 무이력 = 부하만 미정. 목표 반복은 그대로 준다 — 모르면 캘리브레이션을 할 수 없다.
    return isV2
      ? {
          ...base,
          recommendation_state: "load_calibration_needed",
          weight: null,
          reps_low: repsLow,
          reason_code: "LOAD_CALIBRATION_NEEDED",
          confidence: CONFIDENCE_NO_LOAD_ESTIMATE,
        }
      : {
          // V1(2026.08.1) 의미 보존: 0 은 "0kg 을 들어라"가 아니라 "무게 미정" sentinel 이다.
          ...base,
          recommendation_state: "load_calibration_needed",
          weight: 0,
          reps_low: repsLow,
          reason_code: "BASELINE",
          confidence,
        };
  }

  // --- 판정 ---
  // 다세트 판정 기준은 가장 낮은 세트(보수적).
  const minReps = Math.min(...sets.map((s) => s.reps));
  const hitTop = sets.every((s) => s.reps >= repsHigh);
  const repsBelowLow = sets.some((s) => s.reps < repsLow);
  const rirBelowTarget = sets.some((s) => s.rir !== undefined && s.rir < targetRir - 1);
  const tooHard = repsBelowLow || rirBelowTarget;
  /** 1스텝 감량 조건: 하단 -2 이하 세트 또는 RIR 0에서 하단 미달. */
  const shouldDrop =
    sets.some((s) => s.reps <= repsLow - 2) || sets.some((s) => s.rir === 0 && s.reps < repsLow);

  // 4) 맨몸(step_kg=null) — 부하 대신 반복으로 진행한다. 부하 축(RIR 증량/감량)은 쓸 수 없다.
  if (step === null) {
    const bodyweight = { ...base, weight: null, confidence };
    // 하단에 크게 미달 → 무한 하향 대신 보조 종목(랫풀다운·체스트프레스 머신 등) 제안.
    if (minReps <= BODYWEIGHT_SUBSTITUTE_REPS && minReps < repsLow) {
      return {
        ...bodyweight,
        reps_low: repsLow,
        reason_code: "SUBSTITUTE_TOO_HARD_BODYWEIGHT",
        suggest_substitution: true,
      };
    }
    if (hitTop && !tooHard) {
      // 상한(20회)에서는 반복을 더 늘리지 않고 가중(웨이트 벨트)·난이도 상향을 제안한다.
      return repsHigh >= BODYWEIGHT_REPS_CAP
        ? { ...bodyweight, reps_low: repsLow, reason_code: "PROGRESSION_CAP_BODYWEIGHT" }
        : {
            ...bodyweight,
            reps_low: repsLow,
            reps_high: repsHigh + 1,
            reason_code: "REPS_UP_BODYWEIGHT",
          };
    }
    if (tooHard) {
      // 내릴 부하가 없으므로 범위를 유지한다.
      return {
        ...bodyweight,
        reps_low: repsLow,
        reason_code: repsBelowLow ? "TOO_HARD" : "HOLD_RIR_LOW",
      };
    }
    return {
      ...bodyweight,
      reps_low: Math.min(minReps + 1, repsHigh),
      reason_code: "ADD_ONE_REP",
    };
  }

  const weightUp: Recommendation = {
    ...base,
    weight: stepUp(lastWeight, step), // 증량은 어떤 경우에도 1스텝 이내
    reps_low: repsLow, // 증량 시 반복 하단 리셋
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence,
  };

  // 5) RIR 오토레귤레이션(1차 신호). rir_bias 미확보·RIR 결측이면 축 판정 보류.
  if (calibration !== undefined && hasAllRir) {
    const corrected = sets.map((s) => correctedRir(s.rir as number, bias));
    if (corrected.every((r) => r >= targetRir + 1)) {
      return { ...weightUp, reason_code: "RIR_TOO_EASY_INCREASE" };
    }
    if (corrected.some((r) => r <= targetRir - 1)) {
      return {
        ...base,
        weight: shouldDrop ? stepDown(lastWeight, step) : floorToStep(lastWeight, step),
        reps_low: repsLow,
        reason_code: "RIR_TOO_HARD_REDUCE",
        confidence,
      };
    }
    // on target → 더블 프로그레션으로 이어진다.
  }

  // 6) 더블 프로그레션.
  if (hitTop && !tooHard) return weightUp;

  if (tooHard) {
    return {
      ...base,
      weight: shouldDrop ? stepDown(lastWeight, step) : floorToStep(lastWeight, step),
      reps_low: repsLow,
      // 반복은 지켰고 RIR만 낮으면 유지 신호.
      reason_code: repsBelowLow ? "TOO_HARD" : "HOLD_RIR_LOW",
      confidence,
    };
  }

  // reps 목표 +1.
  // reps_high 상한은 스펙 표기를 따른 방어값 — 이 분기는 !hitTop이라 minReps < reps_high가 보장된다.
  return {
    ...base,
    weight: floorToStep(lastWeight, step), // 유지 — 반올림하면 무게가 올라간다
    reps_low: Math.min(minReps + 1, repsHigh),
    reason_code: "ADD_ONE_REP",
    confidence,
  };
}

/**
 * 어시스트 종목(`load_semantics=assistance`) — 숫자는 **기계가 덜어주는 kg** 이다.
 * 그래서 목표를 채우면 **줄이고**, 힘들면 **늘린다**. generic 과 부호가 정반대라
 * `WEIGHT_UP_*` / `RIR_TOO_*` 문구를 재사용하면 숫자와 설명이 서로 모순된다.
 *
 * e1RM 은 내지 않는다 — 도움 무게를 부하로 넣으면 추세가 거꾸로 쌓인다.
 */
function recommendAssistance(input: RecommendationInput): Recommendation {
  const { exercise, target, last_sets, calibration, safety, assistance, rules_version } = input;
  const bias = calibration?.rir_bias ?? 0;
  const step = exercise.step_kg;

  /**
   * 최신 세션을 쓸 수 있는가 — **helper 를 부르기 전에 한 번만** 판정한다.
   * 아래 신뢰도 계산과 진행 가드가 **같은 값을 재사용**해야 두 곳이 다른 말을 하지 않는다.
   */
  const rawUsable = isUsableAssistanceSession(last_sets);

  /**
   * 데이터 품질 신뢰도. **지연 계산이고 `rawUsable` 을 먼저 본다** —
   * 못 믿을 세션은 `toWorkingSets` 로 걸러내 보지도 않는다.
   * 걸러낸 뒤 매기면 "RIR 다 있음 = 0.85" 가 되어 **신뢰할 수 없는 세션이 오히려
   * 높은 신뢰도**를 받는다(통증 경로에서 그 값이 그대로 나간다).
   */
  const confidenceOf = (): number => {
    if (!rawUsable) return CONFIDENCE.baseline;
    const working = toWorkingSets(last_sets);
    return working.every((s) => s.rir !== undefined) ? CONFIDENCE.full : CONFIDENCE.missingRir;
  };

  const base = {
    reps_high: target.reps_high,
    rules_version,
    load_kind: "assistance" as LoadKind,
    recommendation_state: "ready" as RecommendationState,
  };

  // 1) safety matrix — 두 상태 모두 **weight null, recommended_action null** 이다.
  //    도움 kg 을 그대로 주면 "멈추라"면서 정상 처방처럼 보인다.
  const outcome = resolveSafetyOutcome(normalizePain(safety));
  if (outcome === "substitution_required") {
    return {
      ...base,
      recommendation_state: "substitution_required",
      weight: null,
      reps_low: target.reps_low,
      reason_code: "SUBSTITUTE_PAIN",
      confidence: confidenceOf(),
      suggest_substitution: true,
      recommended_action: null,
    };
  }
  if (outcome === "unavailable") {
    return {
      ...base,
      recommendation_state: "unavailable",
      weight: null,
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
      recommended_action: null,
    };
  }

  // 2) 비정상 입력. 어시스트는 맨몸 개념이 없어 step_kg=null 도 부적합하다.
  const repsLow = target.reps_low ?? 0;
  const repsHigh = target.reps_high ?? 0;
  const targetRir = target.rir;
  if (
    step === null ||
    !(step > 0) ||
    !(repsLow > 0) ||
    repsHigh < repsLow ||
    targetRir === undefined
  ) {
    return {
      ...base,
      recommendation_state: "unavailable",
      weight: null,
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
      recommended_action: null,
    };
  }

  // 3) 캘리브레이션 — **lifetime** 에 valid positive 가 하나도 없을 때만이다.
  //    기계별 시작 도움 kg 을 카탈로그에 발명하지 않고 사용자가 직접 넣는다.
  if (assistance?.has_valid_positive_assistance !== true) {
    return {
      ...base,
      recommendation_state: "load_calibration_needed",
      weight: null,
      reps_low: repsLow,
      reason_code: "ASSISTANCE_CALIBRATION_NEEDED",
      confidence: CONFIDENCE_NO_LOAD_ESTIMATE,
    };
  }

  // 4) 최신 세션을 쓸 수 있는가 — **raw 를 all-or-nothing 으로** 본다.
  //    이 검사는 `toWorkingSets` **호출 자체보다 앞에 있다.** 걸러낸 뒤에 판정하면
  //    `[].every(...)===true` 나 "살아남은 한 세트 = 상단 도달"로 읽혀 도움을 지어낸다.
  //    못 믿을 세션은 **걸러내 보지도 않고** 즉시 fail-closed 한다.
  //    **캘리브레이션으로 되돌리지는 않는다** — lifetime evidence 는 그대로 남아 있고,
  //    지금 못 쓰는 것은 최신 세션뿐이다. 판정은 진입부의 `rawUsable` 하나를 재사용한다.
  if (!rawUsable) {
    return {
      ...base,
      recommendation_state: "unavailable",
      weight: null,
      reps_low: repsLow,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
      recommended_action: null,
    };
  }

  // 여기부터는 raw 가 유효하다고 확정된 뒤다 — 그래서 이제야 필터링한다.
  const sets = toWorkingSets(last_sets);
  const hasAllRir = sets.every((s) => s.rir !== undefined);
  const confidence = hasAllRir ? CONFIDENCE.full : CONFIDENCE.missingRir;
  const current = sets[sets.length - 1]!.w;

  const minReps = Math.min(...sets.map((s) => s.reps));
  const hitTop = sets.every((s) => s.reps >= repsHigh);
  const repsBelowLow = sets.some((s) => s.reps < repsLow);
  // 보정 가능하면 **corrected 하나로** 판정한다. raw 로 tooHard 를 재판정하면
  // bias 로 on-target 이 된 세트가 다시 "힘들다"로 뒤집혀 두 축이 서로 다른 말을 한다.
  const calibrated = calibration !== undefined && hasAllRir;
  const rirBelowTarget = sets.some((s) => {
    if (s.rir === undefined) return false;
    const value = calibrated ? correctedRir(s.rir, bias) : s.rir;
    return value < targetRir - 1;
  });
  const tooHard = repsBelowLow || rirBelowTarget;

  /** 도움 증가 = 더 쉬워진다. 1스텝 이내. */
  const up = (reason: Recommendation["reason_code"]): Recommendation => ({
    ...base,
    weight: stepUp(current, step),
    reps_low: repsLow,
    reason_code: reason,
    confidence,
  });

  /**
   * 도움 감소 = 더 어려워진다. **0·음수는 만들지 않는다** —
   * generic reader 가 `0` 을 "무게 미정"으로 숨기므로 합법적인 0kg 추천이 성립하지 않는다.
   */
  const down = (reason: Recommendation["reason_code"]): Recommendation =>
    current - step <= 0
      ? {
          ...base,
          weight: current, // 유지
          reps_low: repsLow,
          reason_code: "ASSISTANCE_MINIMUM_REACHED",
          confidence,
          // 제안만 한다. 자동 전환은 하지 않는다.
          recommended_action: assistanceTransitionAction(exercise.id),
        }
      : {
          ...base,
          weight: stepDown(current, step),
          reps_low: repsLow,
          reason_code: reason,
          confidence,
        };

  // 5) RIR 오토레귤레이션(1차 신호). bias 미확보·RIR 결측이면 축 판정 보류.
  if (calibrated) {
    const corrected = sets.map((s) => correctedRir(s.rir as number, bias));
    // 반복 하단 미달은 RIR 보다 우선한다 — corrected 가 on-target 이어도 못 든 건 못 든 것이다.
    if (repsBelowLow) return up("ASSISTANCE_UP_TOO_HARD");
    if (corrected.every((r) => r >= targetRir + 1)) return down("ASSISTANCE_DOWN_RIR_EASY");
    if (corrected.some((r) => r <= targetRir - 1)) return up("ASSISTANCE_UP_RIR_HARD");
    // on target → 더블 프로그레션으로 이어진다(중립 코드 유지).
  }

  // 6) 더블 프로그레션.
  if (hitTop && !tooHard) return down("ASSISTANCE_DOWN_REP_TARGET_MET");
  if (tooHard) {
    // 반복은 지켰고 RIR 만 낮으면 중립 유지 — 도움을 늘릴 근거가 약하다.
    return repsBelowLow
      ? up("ASSISTANCE_UP_TOO_HARD")
      : {
          ...base,
          weight: floorToStep(current, step),
          reps_low: repsLow,
          reason_code: "HOLD_RIR_LOW",
          confidence,
        };
  }
  return {
    ...base,
    weight: floorToStep(current, step),
    reps_low: Math.min(minReps + 1, repsHigh),
    reason_code: "ADD_ONE_REP",
    confidence,
  };
}

/**
 * 시간 종목(metric=time) — 무게·반복 대신 목표 유지 시간을 처방한다.
 * RIR 은 시간 종목에 적용하지 않는다(수집도 생략) → 결측을 이유로 신뢰도를 깎지 않는다.
 */
function recommendTime(input: RecommendationInput): Recommendation {
  const { target, last_sets, safety, rules_version } = input;
  const low = target.time_low_sec;
  const high = target.time_high_sec;
  const times = validTimesSec(last_sets);
  const confidence = times.length === 0 ? CONFIDENCE.baseline : CONFIDENCE.full;
  // 시간 종목은 자체중량으로 수행한다(부하 처방 없음) → 부하 축 자체가 존재하지 않는다.
  const base = {
    weight: null,
    time_low_sec: low,
    time_high_sec: high,
    rules_version,
    load_kind: "not_applicable" as LoadKind,
    recommendation_state: "ready" as RecommendationState,
  };

  // 1) 안전 가드레일 — 진행규칙보다 항상 우선. 판정은 F-1 primitive 한 곳에서 한다.
  const timeSafety = resolveSafetyOutcome(normalizePain(safety));
  if (timeSafety === "substitution_required") {
    return {
      ...base,
      recommendation_state: "substitution_required",
      reason_code: "SUBSTITUTE_PAIN",
      confidence,
      suggest_substitution: true,
    };
  }
  if (timeSafety === "unavailable") {
    return {
      ...base,
      recommendation_state: "unavailable",
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 2) 비정상 입력 — 목표 시간이 없거나 뒤집혀 있다.
  if (low === undefined || !(low > 0) || high === undefined || high < low) {
    return {
      ...base,
      recommendation_state: "unavailable",
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 3) 기록 없음 — 목표 시간을 그대로 유지.
  if (times.length === 0) {
    return { ...base, reason_code: "BASELINE", confidence };
  }

  // 4) 진행 — 판정 기준은 가장 짧은 세트(보수적).
  const minTime = Math.min(...times);
  const stepSec = timeStepSec(high);
  if (minTime >= high) {
    return { ...base, time_high_sec: high + stepSec, reason_code: "TIME_UP", confidence };
  }
  if (minTime < low * TIME_DOWN_RATIO) {
    return {
      ...base,
      time_low_sec: Math.max(TIME_MIN_SEC, low - stepSec),
      time_high_sec: Math.max(TIME_MIN_SEC, high - stepSec),
      reason_code: "TIME_DOWN",
      confidence,
    };
  }
  return { ...base, reason_code: "TIME_HOLD", confidence };
}
