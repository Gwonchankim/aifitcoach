/**
 * 세트 행의 렌더링·완료 판정 규칙(UX_STATES §5 엣지 케이스, §5.5 근거 문구).
 * 전부 순수 함수라 테스트로 고정한다(test/session-set-rules.test.ts).
 */
import type { Exercise, PlannedSet } from "../../lib/api";

export type SetKind =
  /** metric=time 종목: 시간(초)만 기록하고 RIR 을 묻지 않는다. */
  | "time"
  /** recommended_weight === null: 자체중량. 무게 입력칸 자체가 없다. */
  | "bodyweight"
  /** recommended_weight === 0: 무게 미정. "0kg" 으로 절대 표시하지 않는다. */
  | "unknown_weight"
  /** 일반(가중·반복). */
  | "weighted";

/**
 * UX_STATES §5.1 의 판별 순서를 그대로 따른다.
 * metric 은 카탈로그가 1차 출처이고, 못 받았을 때만 target_time_low_sec 로 폴백한다.
 */
export function setKind(set: PlannedSet, metric?: Exercise["metric"]): SetKind {
  const isTime = metric === "time" || (metric == null && set.target_time_low_sec != null);
  if (isTime) return "time";
  if (set.recommended_weight === null) return "bodyweight";
  // 0 은 "0kg 을 들어라"가 아니라 "무게 미정"이다(BASELINE 계약).
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
 * 무게 미정(`recommended_weight === 0`)은 **프리필이 없다** — 0 을 기록값으로 쓰지 않는다(AC-E-1).
 */
export function setPrefill(kind: SetKind, set: PlannedSet): SetPrefill {
  return {
    weight: kind === "weighted" ? set.recommended_weight : null,
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

  if (kind === "weighted" && set.recommended_weight != null) {
    parts.push(`추천 ${formatKg(set.recommended_weight)}`);
  }
  return parts.join(" · ");
}

/** UX_STATES §5.5. 목록 밖 코드는 근거 영역을 숨긴다(영문 코드 노출 금지). */
const REASON_TEXT: Record<string, string> = {
  BASELINE: "첫 세션이라 무게를 직접 정해요",
  SIMILAR_INIT: "비슷한 운동 기록으로 잡은 시작 무게예요",
  WEIGHT_UP_REP_TARGET_MET: "지난번 목표 반복을 모두 채워서 무게를 올렸어요",
  ADD_ONE_REP: "무게는 그대로, 반복을 1회 늘려요",
  HOLD_RIR_LOW: "지난번이 힘들어 보여 무게를 유지해요",
  TOO_HARD: "지난번이 버거워서 무게를 조금 낮췄어요",
  RIR_TOO_EASY_INCREASE: "여유가 있어 보여 무게를 올렸어요",
  RIR_ON_TARGET_HOLD: "강도가 목표에 잘 맞아요",
  RIR_TOO_HARD_REDUCE: "강도가 높아 보여 부담을 줄였어요",
  REPS_UP_BODYWEIGHT: "자체중량이라 반복 목표를 늘려요",
  PROGRESSION_CAP_BODYWEIGHT: "반복이 충분히 늘어서 난도를 올릴 때예요",
  SUBSTITUTE_TOO_HARD_BODYWEIGHT: "지금은 조금 버거워요. 보조 운동으로 바꿔 보세요",
  TIME_UP: "목표 시간을 채워서 조금 더 늘려요",
  TIME_HOLD: "이번엔 같은 시간으로 유지해요",
  TIME_DOWN: "목표 시간을 조금 낮췄어요",
  SUBSTITUTE_PAIN: "통증이 기록돼서 다른 운동을 권해요",
  VOLUME_SPIKE_CAP: "갑작스러운 운동량 증가를 막기 위해 조절했어요",
  DELOAD_SUGGESTED: "회복을 위해 이번 주는 가볍게 가요",
  CALIBRATION_NEEDED: "강도 감각을 맞추면 추천이 더 정확해져요",
  CALIBRATION_STALE: "강도 감각을 맞추면 추천이 더 정확해져요",
  CALIBRATION_GRADUATED: "강도 감각 측정이 끝나 추천에 반영했어요",
};

/**
 * 각 근거 문구가 말하는 축. 종목의 축과 다르면 화면과 모순된다
 * (예: BASELINE "무게를 직접 정해요" 가 플랭크·풀업 카드에 붙는다).
 * 여기 없는 코드는 축을 가리지 않는 중립 문구다(RIR·디로드·캘리브레이션 등).
 */
const REASON_AXIS: Record<string, "weight" | "reps" | "time"> = {
  BASELINE: "weight",
  SIMILAR_INIT: "weight",
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
export function reasonLabel(code: string, kind?: SetKind): string | null {
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
