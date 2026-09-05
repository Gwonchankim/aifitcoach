import type { RecommendedAction } from "./types";

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
