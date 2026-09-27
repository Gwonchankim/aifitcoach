import type { ExerciseType, LoadSemantics, Region } from "./types";

export type ExerciseModality = "resistance" | "cardio" | "mobility" | "warmup";
export type ResistanceMovementPattern =
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

/** Nullable persistence shape. A missing modality alone never identifies resistance. */
export interface ExerciseClassification {
  modality?: string | null;
  movementPattern: string | null;
  mechanic: string | null;
  region: string | null;
}

export interface ExerciseDomain extends ExerciseClassification {
  loadSemantics: string | null;
}

export type ResistanceClassification<T extends ExerciseClassification> = T & {
  modality?: "resistance" | null;
  movementPattern: ResistanceMovementPattern;
  mechanic: ExerciseType;
  region: Region;
};

export type ResistanceExercise<T extends ExerciseDomain> = ResistanceClassification<T> & {
  loadSemantics: LoadSemantics;
};

const PATTERNS: ReadonlySet<string> = new Set([
  "squat",
  "hinge",
  "lunge",
  "knee_extension",
  "knee_flexion",
  "calf",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "elbow_extension",
  "elbow_flexion",
  "shoulder_isolation",
  "core",
]);

/** Legacy NULL is accepted only with complete resistance classification. */
export function isResistanceClassification<T extends ExerciseClassification>(
  exercise: T,
): exercise is ResistanceClassification<T> {
  return (
    (exercise.modality == null || exercise.modality === "resistance") &&
    exercise.movementPattern !== null &&
    PATTERNS.has(exercise.movementPattern) &&
    (exercise.mechanic === "compound" || exercise.mechanic === "isolation") &&
    (exercise.region === "upper" || exercise.region === "lower" || exercise.region === "core")
  );
}

/** Persistence consumers additionally require explicit load semantics. */
export function isResistanceExercise<T extends ExerciseDomain>(
  exercise: T,
): exercise is ResistanceExercise<T> {
  return (
    isResistanceClassification(exercise) &&
    (exercise.loadSemantics === "external_load" || exercise.loadSemantics === "assistance")
  );
}

export function assertResistanceExercise<T extends ExerciseDomain>(
  exercise: T,
): asserts exercise is ResistanceExercise<T> {
  if (!isResistanceExercise(exercise))
    throw new Error("Unsupported or incomplete resistance exercise domain");
}
