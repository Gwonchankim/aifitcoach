/**
 * 세트 행의 렌더링·완료 판정 규칙(UX_STATES §5 엣지 케이스, §5.5 근거 문구).
 * 전부 순수 함수라 테스트로 고정한다(test/session-set-rules.test.ts).
 */
import type { Exercise, PlannedSet } from "../../lib/api";

export type SetKind =
  /** metric=time 종목: 시간(초)만 기록하고 RIR 을 묻지 않는다. */
  | "time"
  /** catalog step_kg === null: 자체중량. 무게 입력칸 자체가 없다. */
  | "bodyweight"
  /** recommended_weight === 0: 무게 미정. "0kg" 으로 절대 표시하지 않는다. */
  | "unknown_weight"
  /** 일반(가중·반복). */
  | "weighted";

/**
 * UX_STATES §5.1 의 판별 순서를 그대로 따른다.
 * metric/step_kg는 카탈로그가 1차 출처다. D-39 gate가 외부 부하 운동의 recommended_weight도 null로
 * 숨길 수 있으므로, null 추천값만 보고 자체중량으로 판정하면 무게 입력칸이 사라진다.
 */
export function setKind(
  set: PlannedSet,
  metric?: Exercise["metric"],
  stepKg?: Exercise["step_kg"],
): SetKind {
  const isTime = metric === "time" || (metric == null && set.target_time_low_sec != null);
  if (isTime) return "time";
  if (stepKg === null) return "bodyweight";
  if (stepKg !== undefined && set.recommended_weight === null) return "unknown_weight";
  if (set.recommended_weight === null) return "bodyweight";
  // 0 은 "0kg 을 들어라"가 아니라 "무게 미정"이다. **어떤 reason 에서도** 그렇다(AC-E-1).
  //
  // reason_code 로 좁히지 않는 이유: 0 은 V1 baseline sentinel 만이 아니다. `stepDown` 의 바닥이
  // 0 이라 마지막 무게가 1스텝 이하이면 통증·TOO_HARD 감량도 0 에 닿고(V1·V2 공통), 좁히면 그 결과가
  // `weighted` 로 떨어져 화면에 "0kg" 이 뜨고 0 이 기록값으로 프리필된다.
  // "새 reason 인데 weight 가 0" 인 잘못된 결과는 렌더러를 망가뜨려 드러내는 대신 엔진 불변식이
  // 원천에서 잡는다(packages/shared/test/recommend.test.ts "V2 캘리브레이션 상태는 0 sentinel 을 쓰지 않는다").
  if (set.recommended_weight === 0) return "unknown_weight";
  return "weighted";
}

export type SetValues = {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  timeSec: number | null;
};

/**
 * 완료 체크를 막아야 하는 빈 입력칸. 없으면 null(= 체크 가능).
 * `resolveValues` 로 프리필을 확정한 **뒤에** 판정한다 — 프리필도 없는 축만 남아 막힌다(§5.2).
 * 순서는 화면의 입력칸 순서(무게 → 횟수)와 같게 둔다(첫 빈 칸으로 포커스가 간다).
 */
export function missingField(kind: SetKind, values: SetValues): "weight" | "reps" | "time" | null {
  if (kind === "time") return values.timeSec == null ? "time" : null;
  if (hasWeightInput(kind) && values.weight == null) return "weight";
  if (values.reps == null) return "reps";
  return null;
}

/** 각 축의 프리필(추천) 값. 없는 축은 null 이다. */
export type SetPrefill = { weight: number | null; reps: number | null; timeSec: number | null };

/**
 * 입력칸에 채워 두는 추천값.
 * 무게 미정(`unknown_weight`)은 **프리필이 없다** — V1 의 0 도 V2 의 null 도 기록값으로 쓰지 않는다(AC-E-1).
 */
export function setPrefill(kind: SetKind, set: PlannedSet): SetPrefill {
  return {
    // 안전 상태에서는 무게 축을 통째로 숨긴다 — 서버가 값을 실어 보내도 쓰지 않는다(fail closed).
    weight: kind === "weighted" && !isAssistanceSafetyState(set) ? set.recommended_weight : null,
    reps: kind === "time" ? null : set.recommended_reps,
    timeSec: kind === "time" ? (set.target_time_low_sec ?? null) : null,
  };
}

/**
 * UX_STATES §2.4 "값 미입력": 비어 있는 칸은 **프리필 추천값을 그대로 기록값으로 확정**한다.
 * 프리필이 없으면 null 로 남고 `missingField` 가 완료 체크를 막는다.
 * 종목에 없는 축은 항상 null 로 눌러 둔다(자체중량 무게, 시간 종목의 무게·반복·RIR).
 */
export function resolveValues(kind: SetKind, values: SetValues, prefill: SetPrefill): SetValues {
  return {
    weight: hasWeightInput(kind) ? (values.weight ?? prefill.weight) : null,
    reps: kind === "time" ? null : (values.reps ?? prefill.reps),
    rir: asksRir(kind) ? values.rir : null,
    timeSec: kind === "time" ? (values.timeSec ?? prefill.timeSec) : null,
  };
}

/** 무게 입력칸을 그리는 종목인지(자체중량·시간 종목은 칸 자체가 DOM 에 없다). */
export function hasWeightInput(kind: SetKind): boolean {
  return kind === "weighted" || kind === "unknown_weight";
}

/** RIR 을 묻는 종목인지(시간 종목은 수집도 생략한다). */
export function asksRir(kind: SetKind): boolean {
  return kind !== "time";
}

/**
 * 무게 입력칸의 축 이름. 어시스트는 사용자가 적는 값도 **기계가 덜어주는 kg** 이라
 * label·placeholder 까지 같은 축이어야 한다(스크린리더 사용자에게는 이게 유일한 단서다).
 */
export function weightAxisLabel(set: PlannedSet): string {
  return isAssistanceSet(set) ? "도움" : "무게";
}

/** 무게 배지 문구. 숫자 무게는 배지 대신 입력칸 프리필로 보여준다. */
export function weightBadge(kind: SetKind): { text: string; label: string } | null {
  if (kind === "bodyweight") return { text: "자체중량", label: "자체중량 운동, 무게 입력 없음" };
  if (kind === "unknown_weight") return { text: "무게 미정", label: "추천 무게 없음, 직접 입력" };
  return null;
}

/** 62.5 → "62.5kg", 60 → "60kg" (UX_STATES §1.3). */
export function formatKg(value: number): string {
  return `${Number(value.toFixed(1))}kg`;
}

/* ── 어시스트(F-4b) ────────────────────────────────────────────────────────────
 * 어시스트 종목의 숫자는 **기계가 덜어주는 kg** 이라 방향이 반대다. 같은 숫자를 generic
 * 가중 문구로 감싸면 "20kg 로 올렸어요" 가 되어 사용자가 정반대로 읽는다.
 *
 * 판별은 **wire 의 `load_kind` 하나**로 한다 — 카탈로그의 현재 값이 아니라 생성 시점에 굳은
 * immutable snapshot 이다(F-4a 계약).
 */

/** §F safety matrix 확정 문구. 한 글자도 바꾸지 않는다(governing artifact 소유). */
export const ASSISTANCE_PAIN_COPY = "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.";
export const ASSISTANCE_INVALID_COPY = "입력값을 확인한 뒤 다시 시도하세요.";

export function isAssistanceSet(set: PlannedSet): boolean {
  return set.load_kind === "assistance";
}

/** 두 안전 상태(통증 · 입력 오류)인가. 여기서는 무게·action·증감 문구를 전부 숨긴다. */
export function isAssistanceSafetyState(set: PlannedSet): boolean {
  if (!isAssistanceSet(set)) return false;
  return (
    set.recommendation_state === "substitution_required" ||
    set.recommendation_state === "unavailable"
  );
}

/**
 * 도움 배지. **양수일 때만** 그린다 — 0 은 "도움 0(맨몸)", 음수는 있을 수 없는 값이라
 * 둘 다 어시스트 처방이 아니다. 표시하면 그 자체로 거짓말이 된다.
 */
export function assistanceBadge(set: PlannedSet): { text: string; label: string } | null {
  if (!isAssistanceSet(set) || isAssistanceSafetyState(set)) return null;
  const weight = set.recommended_weight;
  if (typeof weight !== "number" || weight <= 0) return null;
  return {
    text: `도움 ${formatKg(weight)}`,
    label: `기계가 덜어주는 무게 ${formatKg(weight).replace("kg", "킬로그램")}`,
  };
}

/** 안전 상태의 확정 문구. 그 외에는 null 이라 기존 근거 문구 경로로 돌아간다. */
export function assistanceSafetyCopy(set: PlannedSet): string | null {
  if (!isAssistanceSafetyState(set)) return null;
  return set.recommendation_state === "substitution_required"
    ? ASSISTANCE_PAIN_COPY
    : ASSISTANCE_INVALID_COPY;
}

/**
 * `recommended_action` 은 **최소 경계 전용**이다. 안전 상태에서 서버가 값을 실어 보내도
 * 쓰지 않는다 — 통증으로 중단하라면서 교체 버튼을 함께 띄우면 안내가 충돌한다.
 */
export function assistanceAction(set: PlannedSet): PlannedSet["recommended_action"] {
  if (!isAssistanceSet(set) || isAssistanceSafetyState(set)) return null;
  return set.recommended_action ?? null;
}

/**
 * 기록 무게의 음수 가드. **어시스트에서 음수는 특히 위험하다** — `-20` 은 "도움 20kg" 의 부호를
 * 뒤집은 값이라 저장되면 이후 이력·graduation 이 통째로 오염된다. 서버도 400 으로 막지만
 * 그때는 이미 사용자가 세트를 잃는다. 입력 단계에서 값으로 인정하지 않는다.
 */
export function nonNegativeWeight(value: number | null): number | null {
  return value !== null && value < 0 ? null : value;
}

/** 도움 축 문구. generic 가중 문구를 재사용하면 숫자 방향과 문장이 모순된다. */
const ASSISTANCE_REASON_TEXT: Record<string, string> = {
  ASSISTANCE_DOWN_REP_TARGET_MET: "목표를 채워서 도움을 한 단계 줄여요",
  ASSISTANCE_DOWN_RIR_EASY: "여유가 있어 보여 도움을 한 단계 줄여요",
  ASSISTANCE_UP_RIR_HARD: "강도가 높아 보여 도움을 한 단계 늘려요",
  ASSISTANCE_UP_TOO_HARD: "버거워 보여 도움을 한 단계 늘려요",
  ASSISTANCE_MINIMUM_REACHED: "도움을 더 줄이기 어려워요. 다음 단계 운동을 권해요",
  ASSISTANCE_CALIBRATION_NEEDED: "기계에서 편한 도움 무게를 직접 정해요",
  ADD_ONE_REP: "도움은 그대로, 반복을 1회 늘려요",
  HOLD_RIR_LOW: "지난번이 힘들어 보여 도움을 유지해요",
};

/**
 * 목표 표기. null 인 축은 아예 렌더하지 않는다(`-`·`0` 출력 금지).
 * 목표 RIR 은 여기 넣지 않는다 — F1-1 이후 RIR 입력칸 옆에 붙어 있어서 두 번 나오면 안 된다.
 */
export function targetLabel(kind: SetKind, set: PlannedSet): string {
  const parts: string[] = [];

  if (kind === "time") {
    const low = set.target_time_low_sec;
    const high = set.target_time_high_sec;
    if (low != null && high != null && low !== high) parts.push(`목표 ${low}~${high}초`);
    else if (low != null) parts.push(`목표 ${low}초`);
    else if (high != null) parts.push(`목표 ${high}초`);
    return parts.join(" · ");
  }

  const low = set.target_reps_low;
  const high = set.target_reps_high;
  if (low != null && high != null && low !== high) parts.push(`목표 ${low}~${high}회`);
  else if (low != null) parts.push(`목표 ${low}회`);
  else if (high != null) parts.push(`목표 ${high}회`);

  // 어시스트는 **도움 축**이다. 같은 숫자에 `추천 20kg` 을 붙이면 부하로 읽힌다.
  const assistance = assistanceBadge(set);
  if (assistance) {
    parts.push(assistance.text);
    return parts.join(" · ");
  }
  if (kind === "weighted" && !isAssistanceSet(set) && set.recommended_weight != null) {
    parts.push(`추천 ${formatKg(set.recommended_weight)}`);
  }
  return parts.join(" · ");
}

/**
 * UX_STATES §5.5. 목록 밖 코드는 근거 영역을 숨긴다(영문 코드 노출 금지).
 * `LOAD_CALIBRATION_NEEDED` 는 여기 없다 — 활성 bundle 이 V1 이라 웹에 도달하지 않고,
 * 확정 문구·축 매핑·E2E 는 V2-GATE-01 소유다. 도달하더라도 목록 밖 규칙으로 근거 영역이 비어 있다.
 */
const REASON_TEXT: Record<string, string> = {
  BASELINE: "첫 세션이라 무게를 직접 정해요",
  WEIGHT_UP_REP_TARGET_MET: "지난번 목표 반복을 모두 채워서 무게를 올렸어요",
  ADD_ONE_REP: "무게는 그대로, 반복을 1회 늘려요",
  HOLD_RIR_LOW: "지난번이 힘들어 보여 무게를 유지해요",
  TOO_HARD: "지난번이 버거워서 무게를 조금 낮췄어요",
  RIR_TOO_EASY_INCREASE: "여유가 있어 보여 무게를 올렸어요",
  RIR_TOO_HARD_REDUCE: "강도가 높아 보여 부담을 줄였어요",
  REPS_UP_BODYWEIGHT: "자체중량이라 반복 목표를 늘려요",
  PROGRESSION_CAP_BODYWEIGHT: "반복이 충분히 늘어서 난도를 올릴 때예요",
  SUBSTITUTE_TOO_HARD_BODYWEIGHT: "지금은 조금 버거워요. 보조 운동으로 바꿔 보세요",
  TIME_UP: "목표 시간을 채워서 조금 더 늘려요",
  TIME_HOLD: "이번엔 같은 시간으로 유지해요",
  TIME_DOWN: "목표 시간을 조금 낮췄어요",
  SUBSTITUTE_PAIN: "통증이 기록돼서 다른 운동을 권해요",
};

/**
 * 각 근거 문구가 말하는 축. 종목의 축과 다르면 화면과 모순된다
 * (예: BASELINE "무게를 직접 정해요" 가 플랭크·풀업 카드에 붙는다).
 * 여기 없는 코드는 축을 가리지 않는 중립 문구다(RIR·디로드·캘리브레이션 등).
 */
const REASON_AXIS: Record<string, "weight" | "reps" | "time"> = {
  BASELINE: "weight",
  WEIGHT_UP_REP_TARGET_MET: "weight",
  ADD_ONE_REP: "weight",
  HOLD_RIR_LOW: "weight",
  TOO_HARD: "weight",
  RIR_TOO_EASY_INCREASE: "weight",
  REPS_UP_BODYWEIGHT: "reps",
  PROGRESSION_CAP_BODYWEIGHT: "reps",
  SUBSTITUTE_TOO_HARD_BODYWEIGHT: "reps",
  TIME_UP: "time",
  TIME_HOLD: "time",
  TIME_DOWN: "time",
};

const KIND_AXIS: Record<SetKind, "weight" | "reps" | "time"> = {
  time: "time",
  bodyweight: "reps",
  unknown_weight: "weight",
  weighted: "weight",
};

/** 축이 다른 종목에도 같은 뜻을 전할 수 있는 문구는 숨기지 않고 바꿔 쓴다. */
const KIND_REASON_TEXT: Partial<Record<SetKind, Record<string, string>>> = {
  time: { BASELINE: "첫 세션이라 목표 시간부터 시작해요" },
  bodyweight: { BASELINE: "첫 세션이라 반복 목표부터 시작해요" },
};

/**
 * `kind` 를 주면 종목과 모순되는 문구를 걸러낸다(주지 않으면 §5.5 기본 매핑 그대로).
 * 걸러낸 자리에는 코드 원문을 노출하지 않고 근거 영역을 비운다(AC-E-6).
 */
export function reasonLabel(code: string, kind?: SetKind, set?: PlannedSet): string | null {
  if (set && isAssistanceSet(set)) {
    // 안전 상태가 최우선이다 — 증감 문구가 안전 안내를 덮으면 안 된다.
    const safety = assistanceSafetyCopy(set);
    if (safety) return safety;
    // 어시스트 행에 generic 가중 문구는 **없는 것이 맞다**. 코드 원문도 노출하지 않는다.
    return ASSISTANCE_REASON_TEXT[code] ?? null;
  }
  if (kind) {
    const replacement = KIND_REASON_TEXT[kind]?.[code];
    if (replacement) return replacement;
    const axis = REASON_AXIS[code];
    if (axis && axis !== KIND_AXIS[kind]) return null;
  }
  return REASON_TEXT[code] ?? null;
}

/** 통증 안내를 띄우는 임계(RECOMMENDATION_ENGINE 안전 가드레일과 동일). */
export const PAIN_ALERT_THRESHOLD = 4;

/** 통증 문구에 항상 함께 붙는 고지(SAFETY_PAIN_MAPPING 규칙 6, AC-S4-5). */
export const MEDICAL_DISCLAIMER =
  "일반적인 안내이며 의료적 조언이 아니에요. 통증이 계속되거나 심해지면 전문가와 상담해 주세요.";
