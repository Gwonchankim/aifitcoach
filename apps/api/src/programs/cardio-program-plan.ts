import { BadRequestException } from "@nestjs/common";
import type { Exercise } from "@prisma/client";
import {
  getProgramComposition,
  planCardioWeek,
  selectCanonicalCardio,
  RULES_BUNDLE_V2,
  RULES_BUNDLE_V2_SPLIT,
  type CardioSlotPlan,
} from "shared";
import type { GenerateProgramInput } from "./programs.service";
import { WEEKDAYS, scheduleFor } from "./program-rules";

/** No health input exists here. Production and the HTTP harness always use the unknown gate. */
export function cardioProgramPlan(dto: GenerateProgramInput, catalog: readonly Exercise[]) {
  const original = getProgramComposition({
    rulesVersion: RULES_BUNDLE_V2,
    goal: dto.goal,
    daysPerWeek: dto.days_per_week,
  });
  const revised = getProgramComposition({
    rulesVersion: RULES_BUNDLE_V2_SPLIT,
    goal: dto.goal,
    daysPerWeek: dto.days_per_week,
    splitPreference: dto.split_preference,
  });
  const schedule = scheduleFor(dto.days_per_week);
  const plan = planCardioWeek({
    rulesVersion: RULES_BUNDLE_V2_SPLIT,
    goal: dto.goal,
    minutesPerDay: dto.minutes_per_day,
    slots: original.slots.map((slot, index) => ({
      ordinal: slot.ordinal,
      container: slot.container,
      day_offset: WEEKDAYS.indexOf(schedule[index]!.day),
    })),
    eligibility: {
      screening: "unknown",
      readiness: "unknown",
      recentTwoSuccessfulCardio: null,
      latestCardioDifficulty: "unknown",
    },
    lowerExposureDays: null,
  });
  let exercise: Exercise | null = null;
  if (plan.slots.some((slot) => slot.descriptor !== null)) {
    try {
      const selected = selectCanonicalCardio({
        catalog: catalog.map((row) => ({
          ...row,
          defaultStepKg: row.defaultStepKg === null ? null : Number(row.defaultStepKg),
        })),
        equipment: dto.equipment ?? null,
        painAreas: dto.pain_areas ?? null,
        currentPain: dto.pain_areas === undefined ? null : dto.pain_areas.length > 0,
      });
      // Use the actual catalog row, never the numeric selection projection, for storage.
      exercise = catalog.find((row) => row.id === selected.id) ?? null;
      if (!exercise) throw new Error("Selected cardio catalog row is unavailable");
    } catch {
      throw new BadRequestException("현재 장비와 통증 정보로 유산소 운동을 배정할 수 없습니다.");
    }
  }
  const byDay = new Map<string, CardioSlotPlan>();
  for (const slot of plan.slots) byDay.set(slot.source_day, slot);
  return { byDay, exercise, composition: revised };
}
