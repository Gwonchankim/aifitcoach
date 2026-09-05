import { readFileSync } from "node:fs";
import path from "node:path";
import type { Exercise } from "@prisma/client";
import { loadSemanticsFor } from "../../src/programs/assistance-migration";
export const MACHINE_IDS = [
  "e_low_row_machine",
  "e_high_row_machine",
  "e_incline_chest_press_machine",
];
export const CATALOG_COUNT = 109;
export const BASELINE_RAW = JSON.parse(
  readFileSync(path.join(__dirname, "catalog-baseline-106.fixture"), "utf8"),
).exercises as Record<string, unknown>[];
export const CURRENT_RAW = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../docs/specs/exercises_seed.json"), "utf8"),
).exercises as Record<string, unknown>[];
export function toRow(raw: Record<string, unknown>): Exercise {
  return {
    id: raw.id,
    nameKo: raw.name_ko,
    nameEn: raw.name_en,
    movementPattern: raw.movement_pattern,
    mechanic: raw.mechanic,
    region: raw.region,
    primaryMuscles: raw.primary_muscles,
    secondaryMuscles: raw.secondary_muscles,
    equipment: raw.equipment,
    difficulty: raw.difficulty,
    metric: raw.metric,
    defaultRepsLow: raw.default_reps_low ?? null,
    defaultRepsHigh: raw.default_reps_high ?? null,
    defaultTimeLowSec: raw.default_time_low_sec ?? null,
    defaultTimeHighSec: raw.default_time_high_sec ?? null,
    defaultStepKg: raw.default_step_kg ?? null,
    unilateral: raw.unilateral,
    loadSemantics: loadSemanticsFor(String(raw.id)),
    substitutions: raw.substitutions,
    cues: raw.cues,
    media: raw.media,
  } as unknown as Exercise;
}

export const BASELINE_CATALOG = BASELINE_RAW.map(toRow);
export const CURRENT_CATALOG = CURRENT_RAW.map(toRow);
