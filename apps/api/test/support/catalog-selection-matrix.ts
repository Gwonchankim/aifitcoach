import type { Exercise } from "@prisma/client";
import type { GenerateProgramDto } from "../../src/programs/dto/generate-program.dto";
import { buildProgramSelectionContext, selectExercises } from "../../src/programs/programs.service";
import {
  exerciseCountFor,
  PAIN_AREAS,
  patternsFor,
  scheduleFor,
} from "../../src/programs/program-rules";
import { BASELINE_CATALOG, CURRENT_CATALOG } from "./catalog-extension";

export function weeklySelection(catalog: Exercise[], input: GenerateProgramDto) {
  const context = buildProgramSelectionContext(catalog, input);
  return scheduleFor(input.days_per_week).map(({ day, focus }) => ({
    day,
    focus,
    ids: selectExercises(
      context.allowed,
      patternsFor(focus),
      exerciseCountFor(input.minutes_per_day),
      context.options,
    ).map((row) => row.id),
  }));
}

/** Active V1 production helpers and counts; preserve exact weekly IDs and order for every input. */
export function catalogSelectionMatrix() {
  const result = [];
  for (const pain of [undefined, ...PAIN_AREAS])
    for (const goal of ["diet", "hypertrophy", "strength"] as const)
      for (const days of [2, 3, 4, 5, 6])
        for (const minutes of [30, 45, 60, 75, 90] as const)
          for (const level of ["beginner", "intermediate", "advanced"] as const) {
            const input: GenerateProgramDto = {
              goal,
              days_per_week: days,
              minutes_per_day: minutes,
              experience_level: level,
              ...(pain ? { pain_areas: [pain] } : {}),
            };
            const before = weeklySelection(BASELINE_CATALOG, input);
            const after = weeklySelection(CURRENT_CATALOG, input);
            result.push({
              input,
              before,
              after,
              changed: JSON.stringify(before) !== JSON.stringify(after),
            });
          }
  return result;
}
