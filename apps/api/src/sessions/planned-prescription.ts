import {
  isResistanceExercise,
  isV2RulesBundle,
  resolveRulesBundle,
  isCanonicalCardioCatalog,
  parseCardioSnapshot,
  type CardioSnapshot,
  type RecommendationState,
} from "shared";
import type { SessionSetMetadata } from "./session-set-metadata";
import { sourceRevision } from "./session-set-snapshot";
import type { Exercise, PlannedSet } from "@prisma/client";

type ResistanceStorage = {
  prescriptionKind?: string | null;
  loadSemantics: string | null;
  reasonCode: string | null;
  restSec: number | null;
  confidence: unknown;
  rulesVersion: string;
};
export type ResistanceSnapshot<T> = T & {
  loadSemantics: "external_load" | "assistance";
  reasonCode: string;
  restSec: number;
  confidence: NonNullable<PlannedSet["confidence"]>;
};
/** Reading an existing resistance snapshot does not resolve or recompute its bundle. */
export function isResistanceReadSnapshot<T extends ResistanceStorage>(
  row: T,
): row is ResistanceSnapshot<T> {
  if (row.prescriptionKind != null && row.prescriptionKind !== "resistance") return false;
  return (
    (row.loadSemantics === "external_load" || row.loadSemantics === "assistance") &&
    typeof row.reasonCode === "string" &&
    row.restSec != null &&
    row.confidence != null
  );
}
/** Mutations and recomputation additionally require an executable, supported bundle. */
export function isResistanceSnapshot<T extends ResistanceStorage>(
  row: T,
): row is ResistanceSnapshot<T> {
  if (!isResistanceReadSnapshot(row)) return false;
  try {
    resolveRulesBundle(row.rulesVersion);
    return true;
  } catch {
    return false;
  }
}
export function resistanceReadMatchesCatalog<T extends ResistanceStorage>(
  row: T,
  catalog: Exercise | null | undefined,
): row is ResistanceSnapshot<T> {
  return isResistanceReadSnapshot(row) && catalog != null && isResistanceExercise(catalog);
}
export function resistanceSnapshotMatchesCatalog<T extends ResistanceStorage>(
  row: T,
  catalog: Exercise | null | undefined,
): row is ResistanceSnapshot<T> {
  return isResistanceSnapshot(row) && catalog != null && isResistanceExercise(catalog);
}

/** Exact stored projection. No progression, fallback or health inference occurs on reads. */
export function storedCardioSnapshot(row: PlannedSet): CardioSnapshot | null {
  return parseCardioSnapshot({
    prescription_kind: row.prescriptionKind,
    duration_sec: row.durationSec,
    rpe_scale_id: row.rpeScaleId,
    target_rpe_low: row.targetRpeLow,
    target_rpe_high: row.targetRpeHigh,
    work_sec: row.workSec,
    recovery_sec: row.recoverySec,
    rounds: row.rounds,
    final_recovery_included: row.finalRecoveryIncluded,
    recovery_rpe_low: row.recoveryRpeLow,
    recovery_rpe_high: row.recoveryRpeHigh,
    long_session_flag: row.longSessionFlag,
    progression_axis: row.progressionAxis,
    source_day: row.sourceDay,
    source_ordinal: row.sourceOrdinal,
    intensity_seconds: row.intensitySeconds,
    cardio_fallback: row.cardioFallback,
  });
}
export function cardioPlannedSetResponse(
  row: PlannedSet,
  catalog: Exercise | null | undefined,
  metadata?: SessionSetMetadata,
) {
  if (row.prescriptionKind == null || row.prescriptionKind === "resistance") {
    return {
      ...(metadata ?? {
        source_revision: sourceRevision(row),
        correlation_id: row.clientCorrelationId,
        append_eligibility: null,
      }),
      append_eligibility: null,
      ...resistancePrescriptionKindForWire(row),
      id: row.id,
      exercise_id: row.exerciseId,
      set_no: row.setNo,
      target_reps_low: row.targetRepsLow,
      target_reps_high: row.targetRepsHigh,
      target_rir: row.targetRir,
      rest_sec: row.restSec,
      target_time_low_sec: row.targetTimeLowSec,
      target_time_high_sec: row.targetTimeHighSec,
      recommended_weight: row.recommendedWeight == null ? null : Number(row.recommendedWeight),
      recommended_reps: row.recommendedReps,
      reason_code: row.reasonCode,
      confidence: null,
      rules_version: row.rulesVersion,
      load_kind: "not_applicable" as const,
      recommendation_state: "unavailable" as const,
      assistance_provenance: row.assistanceProvenance,
      recommended_action: null,
      assistance_safety_status: null,
      performed_set: null,
    };
  }
  const snapshot = storedCardioSnapshot(row);
  const catalogValid =
    catalog != null &&
    isCanonicalCardioCatalog({
      ...catalog,
      defaultStepKg: catalog.defaultStepKg == null ? null : Number(catalog.defaultStepKg),
    });
  const inactiveNull = [
    row.targetRepsLow,
    row.targetRepsHigh,
    row.targetTimeLowSec,
    row.targetTimeHighSec,
    row.targetRir,
    row.restSec,
    row.recommendedWeight,
    row.recommendedReps,
    row.reasonCode,
    row.confidence,
    row.loadSemantics,
    row.assistanceStepKg,
    row.assistanceProvenance,
  ].every((value) => value === null);
  const recommendation_state: RecommendationState =
    snapshot &&
    catalogValid &&
    inactiveNull &&
    (row.rulesVersion === "2026.09.0" || row.rulesVersion === "2026.09.1")
      ? "ready"
      : "unavailable";
  return {
    ...(metadata ?? {
      source_revision: sourceRevision(row),
      correlation_id: row.clientCorrelationId,
      append_eligibility: null,
    }),
    append_eligibility: null,
    id: row.id,
    exercise_id: row.exerciseId,
    set_no: row.setNo,
    prescription_kind: row.prescriptionKind,
    duration_sec: row.durationSec,
    rpe_scale_id: row.rpeScaleId,
    target_rpe_low: row.targetRpeLow,
    target_rpe_high: row.targetRpeHigh,
    work_sec: row.workSec,
    recovery_sec: row.recoverySec,
    rounds: row.rounds,
    final_recovery_included: row.finalRecoveryIncluded,
    recovery_rpe_low: row.recoveryRpeLow,
    recovery_rpe_high: row.recoveryRpeHigh,
    long_session_flag: row.longSessionFlag,
    progression_axis: row.progressionAxis,
    source_day: row.sourceDay,
    source_ordinal: row.sourceOrdinal,
    intensity_seconds: row.intensitySeconds,
    cardio_fallback: row.cardioFallback,
    target_reps_low: null,
    target_reps_high: null,
    target_rir: null,
    rest_sec: null,
    target_time_low_sec: null,
    target_time_high_sec: null,
    recommended_weight: null,
    recommended_reps: null,
    reason_code: null,
    confidence: null,
    load_semantics: null,
    rules_version: row.rulesVersion,
    load_kind: "not_applicable" as const,
    recommendation_state,
    assistance_provenance: null,
    recommended_action: null,
    assistance_safety_status: null,
    performed_set: null,
  };
}

/** V1 wire stays byte-compatible even when a new writer stores an explicit raw kind. */
export function resistancePrescriptionKindForWire(row: {
  prescriptionKind?: string | null;
  rulesVersion: string;
}): { prescription_kind?: "resistance" } {
  try {
    return row.prescriptionKind === "resistance" && isV2RulesBundle(row.rulesVersion)
      ? { prescription_kind: "resistance" }
      : {};
  } catch {
    return {};
  }
}
