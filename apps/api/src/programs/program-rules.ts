/**
 * 룰 기반 프로그램 생성 규칙.
 *
 * 문서 근거를 표기했고, 문서가 침묵하는 값은 "해석"으로 표시했다(스펙 확정 시 여기만 고친다).
 * 추천 수학(무게/진행)은 여기 없다 — packages/shared 의 recommendNextSet 이 유일한 출처다.
 */
import type { Goal } from "shared";

export type Mechanic = "compound" | "isolation";
export type MovementPattern =
  | "squat"
  | "hinge"
  | "lunge"
  | "knee_extension"
  | "knee_flexion"
  | "calf"
  | "horizontal_push"
  | "vertical_push"
  | "horizontal_pull"
  | "vertical_pull"
  | "elbow_extension"
  | "elbow_flexion"
  | "shoulder_isolation"
  | "core";

/**
 * docs/RECOMMENDATION_ENGINE.md 머리말: api 가 맨몸(step_kg=null)·시간(metric=time) 처방을
 * 실제로 내보내는 시점에 2026.08.1 로 올린다.
 */
export const RULES_VERSION = "2026.08.1";

/** 요일 표기(openapi Program.sessions[].day 예시 "MON")와 월요일 기준 오프셋. */
export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ScheduledDay {
  day: Weekday;
  focus: Focus;
}

export type Focus = "full_body" | "upper" | "lower" | "push" | "pull" | "legs";

/**
 * 분할·요일 배치 (해석: 문서에 표가 없다. openapi 는 split_type 예시로 upper_lower 만 준다).
 * 규칙: 2~3일 전신, 4일 상·하체, 5~6일 push/pull/legs. 요일은 회복일을 사이에 두고 고정 배치.
 */
const SCHEDULES: Record<number, ScheduledDay[]> = {
  2: [
    { day: "MON", focus: "full_body" },
    { day: "THU", focus: "full_body" },
  ],
  3: [
    { day: "MON", focus: "full_body" },
    { day: "WED", focus: "full_body" },
    { day: "FRI", focus: "full_body" },
  ],
  4: [
    { day: "MON", focus: "upper" },
    { day: "TUE", focus: "lower" },
    { day: "THU", focus: "upper" },
    { day: "FRI", focus: "lower" },
  ],
  5: [
    { day: "MON", focus: "push" },
    { day: "TUE", focus: "pull" },
    { day: "WED", focus: "legs" },
    { day: "FRI", focus: "push" },
    { day: "SAT", focus: "pull" },
  ],
  6: [
    { day: "MON", focus: "push" },
    { day: "TUE", focus: "pull" },
    { day: "WED", focus: "legs" },
    { day: "THU", focus: "push" },
    { day: "FRI", focus: "pull" },
    { day: "SAT", focus: "legs" },
  ],
};

export function scheduleFor(daysPerWeek: number): ScheduledDay[] {
  const schedule = SCHEDULES[daysPerWeek];
  if (!schedule) {
    throw new Error(`지원하지 않는 days_per_week: ${daysPerWeek}`);
  }
  return schedule;
}

export function splitTypeFor(daysPerWeek: number): string {
  if (daysPerWeek <= 3) return "full_body";
  if (daysPerWeek === 4) return "upper_lower";
  return "push_pull_legs";
}

/**
 * 하루 운동 개수 (해석: 문서에 표가 없다). openapi 의 minutes_per_day enum 에 1:1 대응시키고,
 * 세트 사이 휴식(60~180초)을 포함해 운동 1개당 약 12~13분으로 잡았다.
 */
const EXERCISE_COUNT: Record<number, number> = { 30: 3, 45: 4, 60: 5, 75: 6, 90: 7 };

export function exerciseCountFor(minutesPerDay: number): number {
  const count = EXERCISE_COUNT[minutesPerDay];
  if (!count) {
    throw new Error(`지원하지 않는 minutes_per_day: ${minutesPerDay}`);
  }
  return count;
}

/**
 * focus 별 동작 패턴 우선순위. 앞에서부터 채우고, 개수가 모자라면 뒤 항목까지 쓴다.
 * (같은 패턴이 두 번 나오면 그 패턴의 다음 후보 종목을 고른다.)
 * 해석: 문서에 목록이 없다 — 복합 → 고립 순서, 길항근 균형을 기준으로 정렬했다.
 */
const PATTERNS_BY_FOCUS: Record<Focus, MovementPattern[]> = {
  full_body: [
    "squat",
    "horizontal_push",
    "horizontal_pull",
    "hinge",
    "vertical_push",
    "vertical_pull",
    "core",
  ],
  upper: [
    "horizontal_push",
    "horizontal_pull",
    "vertical_push",
    "vertical_pull",
    "elbow_flexion",
    "elbow_extension",
    "shoulder_isolation",
  ],
  lower: ["squat", "hinge", "lunge", "knee_extension", "knee_flexion", "calf", "core"],
  legs: ["squat", "hinge", "lunge", "knee_extension", "knee_flexion", "calf", "core"],
  push: [
    "horizontal_push",
    "vertical_push",
    "elbow_extension",
    "shoulder_isolation",
    "horizontal_push",
    "vertical_push",
    "elbow_extension",
  ],
  pull: [
    "vertical_pull",
    "horizontal_pull",
    "elbow_flexion",
    "shoulder_isolation",
    "vertical_pull",
    "horizontal_pull",
    "elbow_flexion",
  ],
};

export function patternsFor(focus: Focus): MovementPattern[] {
  return PATTERNS_BY_FOCUS[focus];
}

/**
 * F8-1 즉석 세션의 **부위**(openapi CreateAdHocSessionRequest.body_part) → 동작 패턴 우선순위.
 * F5 운동 추가 팝업의 6개 부위와 같고, focus 표와 같은 규칙으로 앞에서부터 채운다.
 * 하체는 focus lower/legs 목록에서 core 를 뺀 것이다 — 코어는 별도 부위라 사용자가 직접 고른다.
 */
const PATTERNS_BY_BODY_PART: Record<string, MovementPattern[]> = {
  chest: ["horizontal_push"],
  back: ["vertical_pull", "horizontal_pull"],
  shoulders: ["vertical_push", "shoulder_isolation"],
  arms: ["elbow_flexion", "elbow_extension"],
  legs: ["squat", "hinge", "lunge", "knee_extension", "knee_flexion", "calf"],
  core: ["core"],
};

/**
 * 서버가 받아들이는 부위 = openapi CreateAdHocSessionRequest.body_part 의 enum.
 * 매핑에서 파생하므로 계약·검증이 갈라질 수 없다(pain_areas 와 같은 방식).
 */
export const BODY_PARTS = Object.keys(PATTERNS_BY_BODY_PART);

/**
 * 부위별 패턴 목록은 focus 보다 짧다(가슴·코어는 1개) → 하루 최대 운동 수만큼 우선순위를 순환시킨다.
 * 선택 로직은 같은 패턴이 다시 나오면 그 패턴의 다음 후보 종목을 고른다(PATTERNS_BY_FOCUS.push 와 같은 방식).
 */
export function patternsForBodyPart(bodyPart: string): MovementPattern[] {
  const base = PATTERNS_BY_BODY_PART[bodyPart];
  if (!base) {
    throw new Error(`지원하지 않는 body_part: ${bodyPart}`);
  }
  const maxExercises = Math.max(...Object.values(EXERCISE_COUNT));
  return Array.from({ length: maxExercises }, () => base).flat();
}

/**
 * 통증 부위 → 제외할 movement_pattern. **docs/SAFETY_PAIN_MAPPING.md 매핑표를 그대로 옮긴 값**이고
 * 사람이 확정한 안전 계약이다(코드에서 임의로 바꾸지 않는다 — 변경 시 사람 리뷰).
 * `wrist` 는 제외 패턴이 없고, 대신 머신/케이블 우선 정렬만 적용한다(규칙 4).
 */
const PAIN_EXCLUSIONS: Record<string, MovementPattern[]> = {
  knee: ["squat", "lunge", "knee_extension"],
  lower_back: ["hinge", "squat"],
  shoulder: ["vertical_push", "horizontal_push", "shoulder_isolation"],
  elbow: ["elbow_extension", "elbow_flexion"],
  wrist: [],
  hip: ["hinge", "lunge", "squat"],
  neck: ["vertical_push", "shoulder_isolation"],
  ankle: ["lunge", "calf", "squat"],
};

/**
 * 서버가 받아들이는 통증 부위 = openapi GenerateProgramRequest.pain_areas 의 enum.
 * 매핑표에서 파생하므로 문서·계약·검증이 갈라질 수 없다. 여기 없는 값(오타·대소문자·한글)은 400 이다 —
 * 조용히 무시하면 사용자는 통증을 입력했다고 믿는데 안전 필터가 아무것도 하지 않는다(최종 평가).
 */
export const PAIN_AREAS = Object.keys(PAIN_EXCLUSIONS);

/** 머신/케이블 = 궤적이 고정돼 상대적으로 안정적인 장비(SAFETY_PAIN_MAPPING.md 규칙 1·4). */
const STABLE_EQUIPMENT = new Set(["machine", "cable"]);

export function isStableEquipment(equipment: string): boolean {
  return STABLE_EQUIPMENT.has(equipment);
}

/** 제외할 패턴 → 그 원인이 된 pain_area(근거 문구용). 모르는 부위는 무시한다. */
export function excludedPatternsFor(painAreas: string[]): Map<MovementPattern, string> {
  const result = new Map<MovementPattern, string>();
  for (const area of painAreas) {
    for (const pattern of PAIN_EXCLUSIONS[area] ?? []) {
      if (!result.has(pattern)) result.set(pattern, area);
    }
  }
  return result;
}

/** 손목 통증은 제외 대신 머신/케이블 우선(규칙 4). 제외가 있는 부위도 안정성 우선으로 고른다(규칙 1). */
export function prefersStableEquipment(painAreas: string[]): boolean {
  return painAreas.some((area) => area in PAIN_EXCLUSIONS);
}

/** docs/RECOMMENDATION_ENGINE.md "목표별 파라미터" 표를 그대로 옮긴 값. */
const REPS: Record<Goal, Record<Mechanic, { low: number; high: number }>> = {
  hypertrophy: { compound: { low: 6, high: 12 }, isolation: { low: 10, high: 20 } },
  strength: { compound: { low: 3, high: 5 }, isolation: { low: 3, high: 5 } },
  diet: { compound: { low: 6, high: 12 }, isolation: { low: 6, high: 12 } },
};

export function repsFor(goal: Goal, mechanic: Mechanic): { low: number; high: number } {
  return REPS[goal][mechanic];
}

/**
 * 목표 RIR. 위 표는 범위(hypertrophy 1–2, strength 2–4, diet 2–3)를 주는데
 * 엔진 입력 target.rir 은 정수 하나다 → 범위 중앙값을 올림해서 쓴다(해석).
 */
const TARGET_RIR: Record<Goal, number> = { hypertrophy: 2, strength: 3, diet: 3 };

export function targetRirFor(goal: Goal): number {
  return TARGET_RIR[goal];
}

/** docs/FEATURES_UX.md F2: 근비대 90~180, 스트렝스 180+, 다이어트 60~90 (각 범위 안의 값). */
const REST_SEC: Record<Goal, number> = { hypertrophy: 120, strength: 180, diet: 90 };

export function restSecFor(goal: Goal): number {
  return REST_SEC[goal];
}

/**
 * 운동당 세트 수 (해석: 문서에 표가 없다).
 * 근비대 주간 세트 목표(MEV≈10, RECOMMENDATION_ENGINE.md "볼륨 관리")에 맞춰 기본 3세트,
 * 저반복인 스트렝스의 복합운동만 5세트로 둔다.
 */
export function setCountFor(goal: Goal, mechanic: Mechanic): number {
  return goal === "strength" && mechanic === "compound" ? 5 : 3;
}
