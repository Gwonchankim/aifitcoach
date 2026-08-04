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

/** reps<=0(미수행·오입력) 세트는 계산에서 제외한다(GC-17). */
function isValidSet(s: PerformedSet): boolean {
  return Number.isFinite(s.w) && s.w >= 0 && Number.isFinite(s.reps) && s.reps > 0;
}

/** corrected_RIR = clamp(reported + rir_bias, 0, 6) */
function correctedRir(rir: number, bias: number): number {
  return Math.min(6, Math.max(0, rir + bias));
}

/** Epley + RIR 보정: effective_reps = reps + corrected_RIR. 저반복(<=6) 세트 우선, 그 중 최대값. */
function estimateE1rm(sets: PerformedSet[], bias: number): number | undefined {
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
  const bias = calibration?.rir_bias ?? 0;
  const step = exercise.step_kg;
  const sets = last_sets.filter(isValidSet);
  const lastWeight = sets.length > 0 ? sets[sets.length - 1]!.w : 0;
  const e1rm = estimateE1rm(sets, bias);
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
      weight: step > 0 ? stepDown(lastWeight, step) : lastWeight,
      reps_low: target.reps_low,
      reason_code: "SUBSTITUTE_PAIN",
      confidence,
      suggest_substitution: true,
    };
  }

  // 2) 비정상 입력 — 진행 계산 불가.
  if (!(step > 0) || !(target.reps_low > 0) || target.reps_high < target.reps_low) {
    return {
      ...base,
      weight: lastWeight, // 그리드를 신뢰할 수 없으므로 정규화 없이 유지
      reps_low: target.reps_low,
      reason_code: "INVALID_INPUT",
      confidence: CONFIDENCE.baseline,
    };
  }

  // 3) 기록 없음 — 보수적 첫 세션(무게는 사용자 입력/워밍업으로 결정).
  if (sets.length === 0) {
    return {
      ...base,
      weight: 0,
      reps_low: target.reps_low,
      reason_code: "BASELINE",
      confidence,
    };
  }

  // --- 판정 ---
  const hitTop = sets.every((s) => s.reps >= target.reps_high);
  const repsBelowLow = sets.some((s) => s.reps < target.reps_low);
  const rirBelowTarget = sets.some((s) => s.rir !== undefined && s.rir < target.rir - 1);
  const tooHard = repsBelowLow || rirBelowTarget;
  /** 1스텝 감량 조건: 하단 -2 이하 세트 또는 RIR 0에서 하단 미달. */
  const shouldDrop =
    sets.some((s) => s.reps <= target.reps_low - 2) ||
    sets.some((s) => s.rir === 0 && s.reps < target.reps_low);

  const weightUp: Recommendation = {
    ...base,
    weight: stepUp(lastWeight, step), // 증량은 어떤 경우에도 1스텝 이내
    reps_low: target.reps_low, // 증량 시 반복 하단 리셋
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence,
  };

  // 4) RIR 오토레귤레이션(1차 신호). rir_bias 미확보·RIR 결측이면 축 판정 보류.
  if (calibration !== undefined && hasAllRir) {
    const corrected = sets.map((s) => correctedRir(s.rir as number, bias));
    if (corrected.every((r) => r >= target.rir + 1)) {
      return { ...weightUp, reason_code: "RIR_TOO_EASY_INCREASE" };
    }
    if (corrected.some((r) => r <= target.rir - 1)) {
      return {
        ...base,
        weight: shouldDrop ? stepDown(lastWeight, step) : floorToStep(lastWeight, step),
        reps_low: target.reps_low,
        reason_code: "RIR_TOO_HARD_REDUCE",
        confidence,
      };
    }
    // on target → 더블 프로그레션으로 이어진다.
  }

  // 5) 더블 프로그레션.
  if (hitTop && !tooHard) return weightUp;

  if (tooHard) {
    return {
      ...base,
      weight: shouldDrop ? stepDown(lastWeight, step) : floorToStep(lastWeight, step),
      reps_low: target.reps_low,
      // 반복은 지켰고 RIR만 낮으면 유지 신호.
      reason_code: repsBelowLow ? "TOO_HARD" : "HOLD_RIR_LOW",
      confidence,
    };
  }

  // reps 목표 +1. 다세트일 때 기준은 가장 낮은 세트(보수적).
  // reps_high 상한은 스펙 표기를 따른 방어값 — 이 분기는 !hitTop이라 minReps < reps_high가 보장된다.
  const minReps = Math.min(...sets.map((s) => s.reps));
  return {
    ...base,
    weight: floorToStep(lastWeight, step), // 유지 — 반올림하면 무게가 올라간다
    reps_low: Math.min(minReps + 1, target.reps_high),
    reason_code: "ADD_ONE_REP",
    confidence,
  };
}
