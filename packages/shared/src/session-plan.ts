import type { ExerciseType, Metric } from "./types";

/**
 * 역할·시간 기반 세션 packer (V2-PLAN-01). 계약: docs/PROGRAM_V2_CONTRACT.md §4.4.
 *
 * 순수·결정론적이다. 서버 생성기와 오프라인 미러가 같은 함수를 쓴다(추천 엔진과 같은 이유).
 * **활성 bundle 이 2026.08.1 인 동안 production 은 이 파일을 타지 않는다** — 호출은
 * 예약 bundle(2026.09.0) 경로에서만 일어난다.
 */

/** 시간 상수는 전부 단일값이다. 범위로 두면 같은 입력이 다른 계획을 낸다(§4.4). */
export const TIME_CONSTANTS = {
  warmupSec: 480,
  /** PLAN-02 의 mobility/cooldown 이 쓸 자리. 생략되면 실제 소요만 짧아진다. */
  cooldownReserveSec: 300,
  transitionSec: 90,
  workPerRepSec: 4,
  workMinSec: 20,
  workMaxSec: 90,
} as const;

/** 세션 총 작업세트 hard cap. 시간 예산과 함께 **둘 다** 만족해야 한다. */
export const SESSION_SET_CAP: Readonly<Record<number, number>> = {
  30: 8,
  45: 12,
  60: 16,
  75: 20,
  90: 24,
};

/** V2 기본 세트 수. B 결정으로 strength compound 가 5→3 이 되면서 전 종목이 3 으로 수렴한다. */
const BASE_SETS = 3;
/**
 * envelope 하한. **모든 role 이 여기까지 줄인다** — primary 도 3 → 2 를 시도한다.
 * primary 만 하한을 못 쓰면 줄일 수 있는 비-primary 가 살아남고 primary 가 탈락한다.
 */
const MIN_SETS = 2;

export type SessionRole = "primary" | "secondary" | "accessory" | "core";

/** 추가 순서. 제거 순서는 이 배열의 역순이다(accessory → core → secondary → primary). */
const ADD_ORDER: readonly SessionRole[] = ["primary", "secondary", "core", "accessory"];

export interface PackCandidate {
  id: string;
  mechanic: ExerciseType;
  movement_pattern: string;
  unilateral: boolean;
  metric: Metric;
  /** metric=reps 의 목표 반복 상단. 수행시간 계산에 쓴다. */
  target_reps_high: number | null;
  /** metric=time 의 목표 시간 상단. */
  target_time_high_sec: number | null;
}

export interface EstimateExercise {
  sets: number;
  reps_high: number | null;
  time_high_sec: number | null;
  unilateral: boolean;
}

export interface EstimateInput {
  exercises: EstimateExercise[];
  restSec: number;
  /**
   * cardio·mobility 처럼 세트 구조가 없는 고정 블록의 초. PLAN-02 가 쓴다.
   * **modality 별 분기를 만들지 않는다** — 단순 덧셈 입력이다.
   */
  additional_fixed_block_sec?: number;
}

/** 세트 1회 수행시간. 시간 종목은 목표 시간 그대로, 반복 종목은 clamp(reps×4, 20, 90). */
function workSecPerSet(exercise: EstimateExercise): number {
  const { workPerRepSec, workMinSec, workMaxSec } = TIME_CONSTANTS;
  const base =
    exercise.time_high_sec !== null
      ? exercise.time_high_sec
      : Math.min(workMaxSec, Math.max(workMinSec, (exercise.reps_high ?? 0) * workPerRepSec));
  // unilateral 은 좌우를 따로 수행하므로 **수행시간만** 2배다(휴식·전환은 그대로).
  return exercise.unilateral ? base * 2 : base;
}

/**
 * 세션 예상 소요(초). 이 함수의 계약은 **"추정치가 상한을 넘지 않음"** 이다 —
 * 실제 소요와의 오차는 KPI 이지 여기 계약이 아니다.
 */
export function estimateSessionSeconds(input: EstimateInput): number {
  const { warmupSec, cooldownReserveSec, transitionSec } = TIME_CONSTANTS;
  const n = input.exercises.length;
  const rest = input.exercises.reduce((sum, e) => sum + (e.sets - 1) * input.restSec, 0);
  const work = input.exercises.reduce((sum, e) => sum + e.sets * workSecPerSet(e), 0);
  // 마지막 운동 뒤에는 전환이 없다. 마지막 세트 뒤 휴식도 세지 않고 전환만 센다.
  const transition = n > 0 ? (n - 1) * transitionSec : 0;
  return (
    warmupSec +
    cooldownReserveSec +
    rest +
    work +
    transition +
    (input.additional_fixed_block_sec ?? 0)
  );
}

/**
 * role 파생. focus pattern 목록과 기존 comparator 순서를 **그대로 승계**한 배열을 받는다.
 *
 * `primary 는 항상 compound` 를 절대 규칙으로 두지 않는다 — 통증·장비 필터 뒤에는
 * compound 가 하나도 없는 세션이 정상적으로 존재할 수 있고, 그 때는 isolation 이 primary 다.
 */
export function assignRoles(candidates: PackCandidate[]): Map<string, SessionRole> {
  const roles = new Map<string, SessionRole>();
  let primaryTaken = false;
  for (const c of candidates) {
    if (c.movement_pattern === "core") {
      roles.set(c.id, "core");
      continue;
    }
    if (!primaryTaken) {
      primaryTaken = true;
      roles.set(c.id, "primary");
      continue;
    }
    roles.set(c.id, c.mechanic === "compound" ? "secondary" : "accessory");
  }
  return roles;
}

export interface PackedExercise {
  candidate: PackCandidate;
  role: SessionRole;
  sets: number;
}

export interface PackInput {
  /** 이미 focus pattern + comparator 순으로 정렬된 후보. packer 는 순서를 바꾸지 않는다. */
  candidates: PackCandidate[];
  minutesPerDay: number;
  restSec: number;
}

function toEstimate(p: PackedExercise): EstimateExercise {
  return {
    sets: p.sets,
    reps_high: p.candidate.target_reps_high,
    time_high_sec: p.candidate.target_time_high_sec,
    unilateral: p.candidate.unilateral,
  };
}

/**
 * 세션 구성. **cap 과 시간 예산은 둘 다 hard constraint 이고 더 엄격한 쪽이 구속한다.**
 *
 * 추가 순서 `primary → secondary → core → accessory` 로 greedy 하게 넣는다. 들어가지 못한 후보는
 * 그대로 빠지므로 **제거 순서가 추가 순서의 역순**(accessory → core → secondary → primary)이 되고,
 * `accessory` 가 남은 채 `primary` 가 빠지는 결과가 구조적으로 불가능하다.
 */
export function packSession(input: PackInput): PackedExercise[] {
  const cap = SESSION_SET_CAP[input.minutesPerDay];
  if (cap === undefined) {
    throw new RangeError(
      `지원하지 않는 minutes_per_day: ${input.minutesPerDay}. 지원: ${Object.keys(SESSION_SET_CAP).join(", ")}`,
    );
  }
  const budgetSec = input.minutesPerDay * 60;
  const roles = assignRoles(input.candidates);

  // 추가 순서로 재배열하되 같은 role 안에서는 원래 comparator 순서를 유지한다.
  const ordered = ADD_ORDER.flatMap((role) =>
    input.candidates.filter((c) => roles.get(c.id) === role),
  );

  const packed: PackedExercise[] = [];
  const fits = (next: PackedExercise[]) =>
    next.reduce((a, p) => a + p.sets, 0) <= cap &&
    estimateSessionSeconds({ exercises: next.map(toEstimate), restSec: input.restSec }) <=
      budgetSec;

  for (const c of ordered) {
    const role = roles.get(c.id)!;
    // 기본 세트로 먼저 시도하고, 안 되면 하한까지 줄여 다시 시도한다.
    // **primary 도 3 → 2 를 시도한다.** primary 만 하한을 못 쓰면 줄일 수 있는 비-primary 가
    // 살아남고 줄일 수 없는 primary 가 탈락해, 보호하려던 것이 오히려 먼저 죽는다.
    for (const sets of [BASE_SETS, MIN_SETS]) {
      const next = [...packed, { candidate: c, role, sets }];
      if (fits(next)) {
        packed.push({ candidate: c, role, sets });
        break;
      }
    }
    // primary 가 2세트로도 못 들어가면 **세션이 성립하지 않는다.**
    // accessory 만 남은 세션을 내보내느니 아무것도 내보내지 않는다(fail-closed).
    if (role === "primary" && !packed.some((p) => p.role === "primary")) return [];
  }
  return packed;
}
