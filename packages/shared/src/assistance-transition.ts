import type { RecommendedAction } from "./types";

/** 신규 native 생성용 canonical 목록. 적용된 historical migration 목록은 보존한다. */
export const ASSISTED_EXERCISE_IDS = ["e_assisted_pullup", "e_assisted_dips"] as const;

export function isAssistedExercise(exerciseId: string): boolean {
  return (ASSISTED_EXERCISE_IDS as readonly string[]).includes(exerciseId);
}

/** Metadata only: callers retain the assistance, minimum and safety gates. */
export function assistanceTransitionAction(exerciseId?: string): RecommendedAction | null {
  switch (exerciseId) {
    case "e_assisted_pullup":
      return { kind: "suggest_exercise_swap", exercise_id: "e_pullup" };
    case "e_assisted_dips":
      return { kind: "suggest_exercise_swap", exercise_id: "e_dips" };
    default:
      return null;
  }
}
