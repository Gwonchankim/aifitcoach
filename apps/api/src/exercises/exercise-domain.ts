// Keep one structural guard for server and future catalog readers.
import type { Exercise } from "@prisma/client";
import type { ResistanceExercise as NarrowedResistanceExercise } from "shared";
export { assertResistanceExercise, isResistanceExercise } from "shared";
export type ResistanceExercise = NarrowedResistanceExercise<Exercise>;
