import { recommendNextSet } from "./recommend";
import { RULES_BUNDLE_V1 } from "./rules-version";
import type { ExerciseType, Goal, Metric, Region } from "./types";

/**
 * **활성 bundle 포인터.** activation 티켓에서 이 한 줄만 `RULES_BUNDLE_V2` 로 옮긴다
 * (PLAN B+C·S/C/H·packer 완료 후). 그 전까지 엔진의 V2 경로는 골든에서만 실행된다.
 */
export const ROUTINE_RULES_VERSION: string = RULES_BUNDLE_V1;

const REPS: Record<Goal, Record<ExerciseType, { low: number; high: number }>> = {
  hypertrophy: { compound: { low: 6, high: 12 }, isolation: { low: 10, high: 20 } },
  strength: { compound: { low: 3, high: 5 }, isolation: { low: 3, high: 5 } },
  diet: { compound: { low: 6, high: 12 }, isolation: { low: 6, high: 12 } },
};
const TARGET_RIR: Record<Goal, number> = { hypertrophy: 2, strength: 3, diet: 3 };
const REST_SEC: Record<Goal, number> = { hypertrophy: 120, strength: 180, diet: 90 };

export function routineRepsFor(goal: Goal, mechanic: ExerciseType): { low: number; high: number } {
  return REPS[goal][mechanic];
}

export function routineTargetRirFor(goal: Goal): number {
  return TARGET_RIR[goal];
}

export function routineRestSecFor(goal: Goal): number {
  return REST_SEC[goal];
}

export function routineSetCountFor(goal: Goal, mechanic: ExerciseType): number {
  return goal === "strength" && mechanic === "compound" ? 5 : 3;
}

export type ProvisionalExercise = {
  id: string;
  mechanic: ExerciseType;
  region: Region;
  step_kg: number | null;
  metric: Metric;
  default_time_low_sec: number | null;
  default_time_high_sec: number | null;
};

/**
 * Offline routine add has no server history response. Build a deterministic BASELINE mirror now,
 * then replace every field with the authoritative PlannedSet returned by /sync.
 */
export function buildProvisionalRoutineSets(
  goal: Goal,
  exercise: ProvisionalExercise,
  correlationIds: string[],
) {
  const reps = routineRepsFor(goal, exercise.mechanic);
  const target =
    exercise.metric === "time"
      ? {
          time_low_sec: exercise.default_time_low_sec ?? undefined,
          time_high_sec: exercise.default_time_high_sec ?? undefined,
        }
      : { reps_low: reps.low, reps_high: reps.high, rir: routineTargetRirFor(goal) };
  const recommendation = recommendNextSet({
    goal,
    exercise: {
      id: exercise.id,
      type: exercise.mechanic,
      region: exercise.region,
      step_kg: exercise.step_kg,
      metric: exercise.metric,
    },
    target,
    last_sets: [],
    rules_version: ROUTINE_RULES_VERSION,
  });

  return correlationIds.map((id, index) => ({
    id,
    exercise_id: exercise.id,
    set_no: index + 1,
    target_reps_low: target.reps_low ?? null,
    target_reps_high: target.reps_high ?? null,
    target_rir: target.rir ?? null,
    rest_sec: routineRestSecFor(goal),
    target_time_low_sec: target.time_low_sec ?? null,
    target_time_high_sec: target.time_high_sec ?? null,
    recommended_weight: recommendation.weight,
    recommended_reps: recommendation.reps_low ?? null,
    reason_code: recommendation.reason_code,
    confidence: recommendation.confidence,
    rules_version: recommendation.rules_version,
  }));
}
