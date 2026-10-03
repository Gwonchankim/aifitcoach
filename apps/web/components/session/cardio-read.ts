import { parseCardioSnapshot, RULES_BUNDLE_V2, RULES_BUNDLE_V2_SPLIT } from "shared";
import type { Exercise, PlannedSet } from "../../lib/api";

export function cardioRulesAllowRead(version: unknown): boolean {
  return version === RULES_BUNDLE_V2 || version === RULES_BUNDLE_V2_SPLIT;
}

export function cardioCatalogAllowsRead(exercise: Exercise): boolean {
  const exact = (values: readonly string[] | undefined, expected: readonly string[]) =>
    Array.isArray(values) &&
    values.length === expected.length &&
    new Set(values).size === expected.length &&
    expected.every((value) => values.includes(value));
  return (
    exercise.id === "e_stationary_bike" &&
    exercise.modality === "cardio" &&
    exercise.metric === "time" &&
    exercise.equipment === "stationary_bike" &&
    exercise.mechanic === null &&
    exercise.movement_pattern === null &&
    exercise.region === null &&
    exercise.step_kg === null &&
    exact(exercise.cardio_movement_regions, ["lower"]) &&
    exact(exercise.prescription_kinds_supported, ["steady_cardio", "interval_cardio"]) &&
    exact(exercise.blocked_reported_pain_areas, [
      "knee",
      "lower_back",
      "shoulder",
      "elbow",
      "wrist",
      "hip",
      "neck",
      "ankle",
    ])
  );
}

/** Cardio-shaped rows must never fall back to the legacy resistance reader. */
export function hasCardioPrescription(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  return (
    value.prescription_kind === "steady_cardio" ||
    value.prescription_kind === "interval_cardio" ||
    value.exercise_id === "e_stationary_bike" ||
    value.duration_sec != null ||
    value.rpe_scale_id != null ||
    value.intensity_seconds != null
  );
}

export type ResistancePlannedSet = Extract<PlannedSet, { rest_sec: number }>;
export function isResistancePlannedSet(row: PlannedSet): row is ResistancePlannedSet {
  return (
    !hasCardioPrescription(row) &&
    (!("prescription_kind" in row) || row.prescription_kind === "resistance")
  );
}

/** Preserves exact authoritative bytes; only the union boundary is validated here. */
export function assertCardioReadPayload(value: unknown): void {
  function visit(value: unknown, inheritedVersion?: unknown, validEnvelope = true): void {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const ownVersion = "rules_version" in row;
    const version = ownVersion ? row.rules_version : inheritedVersion;
    const supported = validEnvelope && (!ownVersion || cardioRulesAllowRead(version));
    if (
      hasCardioPrescription(row) &&
      (!supported || !cardioRulesAllowRead(version) || !parseCardioSnapshot(row))
    )
      throw new Error("Invalid cardio read snapshot");
    for (const key of ["planned_sets", "sessions", "exercises"]) {
      const items = row[key];
      if (Array.isArray(items)) for (const item of items) visit(item, version, supported);
    }
  }
  visit(value);
}
