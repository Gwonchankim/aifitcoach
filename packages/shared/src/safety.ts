/**
 * 안전 신호 primitive(F-1). **추천 경로 전체가 이 한 곳에서 통증 상태를 읽는다.**
 *
 * 복호화 경계: `PerformedSet.painScore` 는 앱 레벨 암호문(`v1:iv:tag:ciphertext`)이고
 * **복호화와 parser 는 API encryption adapter 단독 소유**다. `packages/shared` 는 브라우저
 * 번들에도 들어가므로 여기에 parser·키를 두면 암호문 형식과 키 취급이 클라이언트로 샌다.
 * 이 모듈은 adapter 가 정규화해 넘긴 **tagged 값만** 소비한다.
 */

import type { PainFailureCode } from "./assistance";

/** 통증 중단 임계. 스펙 값이라 티켓 단위로 바꾸지 않는다. */
export const PAIN_STOP_THRESHOLD = 4;

/**
 * 통증 관측값. 셋을 구분하는 것이 핵심이다 —
 * **"없음"과 "0점"과 "못 읽음"은 서로 다른 사실**이고 처리도 다르다.
 */
export type PainObservation =
  | { kind: "missing" }
  | { kind: "value"; value: number }
  | { kind: "invalid"; failure_code: PainFailureCode };

/** adapter 가 넘기는 원시 형태. `pain_failure_code` 가 있으면 값은 신뢰하지 않는다. */
export interface RawSafetyInput {
  pain_score?: number;
  pain_failure_code?: PainFailureCode;
}

/**
 * 원시 입력 → tagged 관측값. **fail-closed** 다:
 * 실패 코드가 붙었거나 숫자가 아니면 값이 있어도 `invalid` 로 떨어뜨린다.
 */
export function normalizePain(safety: RawSafetyInput | undefined): PainObservation {
  if (safety === undefined) return { kind: "missing" };
  if (safety.pain_failure_code !== undefined) {
    return { kind: "invalid", failure_code: safety.pain_failure_code };
  }
  const raw = safety.pain_score;
  if (raw === undefined || raw === null) return { kind: "missing" };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { kind: "invalid", failure_code: "nonnumeric" };
  }
  return { kind: "value", value: raw };
}

/** 안전 신호가 추천 상태에 강제하는 결과. */
export type SafetyOutcome = "proceed" | "substitution_required" | "unavailable";

/**
 * state precedence. **안전·오류가 진행규칙보다 항상 우선**한다.
 * 읽을 수 없는 값은 "괜찮다"가 아니라 `unavailable` 이다 — 모르면 멈춘다.
 */
export function resolveSafetyOutcome(observation: PainObservation): SafetyOutcome {
  if (observation.kind === "invalid") return "unavailable";
  if (observation.kind === "value" && observation.value >= PAIN_STOP_THRESHOLD) {
    return "substitution_required";
  }
  return "proceed";
}
