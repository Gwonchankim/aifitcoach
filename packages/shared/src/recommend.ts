import type { PerformedSet, Recommendation, RecommendationInput } from "./types";

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

const PAIN_STOP_THRESHOLD = 4;

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
  if (exercise.metric === "time") return recommendTime(input);

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

  const base = { reps_high: target.reps_high, rules_version, e1rm };

  // 1) 안전 가드레일 — 진행규칙보다 항상 우선.
  if (safety !== undefined && safety.pain_score >= PAIN_STOP_THRESHOLD) {
    return {
      ...base,
      // 안전 경로는 입력 검증보다 먼저라 step_kg가 비정상일 수 있다(그 땐 그리드 없이 유지).
      // 맨몸은 내릴 부하가 없어 null(대체 종목 제안으로 대응).
      weight: step === null ? null : step > 0 ? stepDown(lastWeight, step) : lastWeight,
      reps_low: target.reps_low,
      reason_code: "SUBSTITUTE_PAIN",
      confidence,
      suggest_substitution: true,
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
      weight: step === null ? null : lastWeight, // 그리드를 신뢰할 수 없으므로 정규화 없이 유지
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 3) 기록 없음 — 보수적 첫 세션(무게는 사용자 입력/워밍업으로 결정).
  if (sets.length === 0) {
    return {
      ...base,
      weight: step === null ? null : 0,
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
 * 시간 종목(metric=time) — 무게·반복 대신 목표 유지 시간을 처방한다.
 * RIR 은 시간 종목에 적용하지 않는다(수집도 생략) → 결측을 이유로 신뢰도를 깎지 않는다.
 */
function recommendTime(input: RecommendationInput): Recommendation {
  const { target, last_sets, safety, rules_version } = input;
  const low = target.time_low_sec;
  const high = target.time_high_sec;
  const times = validTimesSec(last_sets);
  const confidence = times.length === 0 ? CONFIDENCE.baseline : CONFIDENCE.full;
  // 시간 종목은 자체중량으로 수행한다(부하 처방 없음).
  const base = { weight: null, time_low_sec: low, time_high_sec: high, rules_version };

  // 1) 안전 가드레일 — 진행규칙보다 항상 우선.
  if (safety !== undefined && safety.pain_score >= PAIN_STOP_THRESHOLD) {
    return { ...base, reason_code: "SUBSTITUTE_PAIN", confidence, suggest_substitution: true };
  }

  // 2) 비정상 입력 — 목표 시간이 없거나 뒤집혀 있다.
  if (low === undefined || !(low > 0) || high === undefined || high < low) {
    return { ...base, reason_code: "INVALID_INPUT", confidence: CONFIDENCE.baseline };
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
