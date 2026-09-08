import { createHash } from "node:crypto";
import { Prisma, type PlannedSet } from "@prisma/client";
import { isAllowedAssistanceVersion, resolveRulesBundle } from "shared";
import { rawAssistanceSafetyStatus, toRawTargetRow } from "../programs/assistance-migration";

type CopyField =
  | "targetRepsLow"
  | "targetRepsHigh"
  | "targetTimeLowSec"
  | "targetTimeHighSec"
  | "targetRir"
  | "restSec"
  | "recommendedWeight"
  | "recommendedReps"
  | "reasonCode"
  | "confidence"
  | "rulesVersion"
  | "loadSemantics"
  | "assistanceStepKg"
  | "assistanceProvenance"
  | "orderIndex";
type IdentityField = "id" | "sessionId" | "exerciseId" | "clientCorrelationId" | "setNo";

/** A05/A06: a raw DB snapshot, never a gated wire projection or current catalog row. */
export type RawSessionSetSnapshot = Pick<PlannedSet, CopyField | IdentityField> & {
  performedSets?: readonly { completed: boolean }[];
};
export interface AppendCohort {
  userId: string;
  sessionId: string;
  exerciseId: string;
  rows: readonly RawSessionSetSnapshot[];
}
export interface AppendEligibility {
  version: 1;
  source_revision: string;
  cohort_revision: string;
  status: "allowed" | "blocked";
  reason: null | "unsafe_assistance_snapshot";
}

const digest = (canonical: string): string => createHash("sha256").update(canonical).digest("hex");
export function validateRawSessionSetSnapshot(source: RawSessionSetSnapshot): {
  status: "valid" | "invalid_raw";
} {
  // Prisma PlannedSet: PostgreSQL Int / Decimal(6,2) / confidence Decimal(3,2).
  // These are storage/axis checks, not a new recommendation or actual-RIR policy.
  const integer = (value: number | null | undefined, nullable: boolean): boolean =>
    value == null
      ? nullable
      : Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  const storedDecimal = (
    value: Prisma.Decimal | null,
    precision: number,
    nullable: boolean,
  ): boolean => {
    if (value == null) return nullable;
    try {
      const number = new Prisma.Decimal(value);
      return (
        number.isFinite() &&
        number.decimalPlaces() <= 2 &&
        number.abs().lessThan(new Prisma.Decimal(10).pow(precision - 2))
      );
    } catch {
      return false;
    }
  };
  const numeric =
    [source.setNo, source.orderIndex, source.restSec].every((value) => integer(value, false)) &&
    [
      source.targetRepsLow,
      source.targetRepsHigh,
      source.targetTimeLowSec,
      source.targetTimeHighSec,
      source.targetRir,
      source.recommendedReps,
    ].every((value) => integer(value, true)) &&
    storedDecimal(source.recommendedWeight, 6, true) &&
    storedDecimal(source.assistanceStepKg, 6, true) &&
    storedDecimal(source.confidence, 3, false);
  const reps =
    source.targetRepsLow != null &&
    source.targetRepsHigh != null &&
    source.targetRepsLow <= source.targetRepsHigh &&
    source.targetTimeLowSec == null &&
    source.targetTimeHighSec == null;
  const time =
    source.targetTimeLowSec != null &&
    source.targetTimeHighSec != null &&
    source.targetTimeLowSec <= source.targetTimeHighSec &&
    source.targetRepsLow == null &&
    source.targetRepsHigh == null &&
    source.targetRir == null &&
    source.recommendedReps == null &&
    source.recommendedWeight == null;
  return { status: numeric && (reps || time) ? "valid" : "invalid_raw" };
}
const completed = (row: RawSessionSetSnapshot): boolean =>
  row.performedSets?.some((fact) => fact.completed === true) ?? false;

function decimal(value: Prisma.Decimal | null | undefined): string | null {
  if (value == null) return null;
  const number = new Prisma.Decimal(value);
  if (!number.isFinite()) throw new RangeError("Non-finite raw snapshot decimal");
  return number.isZero() ? "0" : number.toFixed();
}

/** Exact raw copy only. Call the numeric and A08 guards before creating a new DB row. */
export function copySessionSetSnapshot(source: RawSessionSetSnapshot): Pick<PlannedSet, CopyField> {
  return {
    targetRepsLow: source.targetRepsLow,
    targetRepsHigh: source.targetRepsHigh,
    targetTimeLowSec: source.targetTimeLowSec,
    targetTimeHighSec: source.targetTimeHighSec,
    targetRir: source.targetRir,
    restSec: source.restSec,
    recommendedWeight: source.recommendedWeight,
    recommendedReps: source.recommendedReps,
    reasonCode: source.reasonCode,
    confidence: source.confidence,
    rulesVersion: source.rulesVersion,
    loadSemantics: source.loadSemantics,
    assistanceStepKg: source.assistanceStepKg,
    assistanceProvenance: source.assistanceProvenance,
    orderIndex: source.orderIndex,
  };
}

/** A06 v1 key order is pinned by tests; changing it invalidates opaque source tokens. */
export function canonicalSourceSnapshot(source: RawSessionSetSnapshot): string {
  return JSON.stringify({
    version: 1,
    sourceId: source.id,
    sessionId: source.sessionId,
    exerciseId: source.exerciseId,
    clientCorrelationId: source.clientCorrelationId ?? null,
    setNo: source.setNo,
    orderIndex: source.orderIndex,
    targetRepsLow: source.targetRepsLow ?? null,
    targetRepsHigh: source.targetRepsHigh ?? null,
    targetTimeLowSec: source.targetTimeLowSec ?? null,
    targetTimeHighSec: source.targetTimeHighSec ?? null,
    targetRir: source.targetRir ?? null,
    restSec: source.restSec,
    recommendedWeight: decimal(source.recommendedWeight),
    recommendedReps: source.recommendedReps ?? null,
    reasonCode: source.reasonCode,
    confidence: decimal(source.confidence),
    rulesVersion: source.rulesVersion,
    loadSemantics: source.loadSemantics,
    assistanceStepKg: decimal(source.assistanceStepKg),
    assistanceProvenance: source.assistanceProvenance ?? null,
  });
}
export function sourceRevision(source: RawSessionSetSnapshot): string {
  return digest(canonicalSourceSnapshot(source));
}

/** Caller must read scope, raw rows and completed facts from one transaction snapshot. */
export function cohortRevision(cohort: AppendCohort): string {
  const members = cohort.rows
    .map((row) => ({
      id: row.id,
      source_revision: sourceRevision(row),
      completed: completed(row),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return digest(
    JSON.stringify({
      version: 1,
      userId: cohort.userId,
      sessionId: cohort.sessionId,
      exerciseId: cohort.exerciseId,
      members,
    }),
  );
}

/** A08 only: does not authorize owner/date/cap or replace numeric validation. */
export function isAppendCohortSafe(cohort: AppendCohort, sourceId: string): boolean {
  const source = cohort.rows.find((row) => row.id === sourceId);
  if (!source || new Set(cohort.rows.map((row) => row.id)).size !== cohort.rows.length)
    return false;
  try {
    const sourceStep = decimal(source.assistanceStepKg);
    for (const row of cohort.rows) {
      if (
        row.sessionId !== cohort.sessionId ||
        row.exerciseId !== cohort.exerciseId ||
        row.loadSemantics !== source.loadSemantics ||
        row.rulesVersion !== source.rulesVersion ||
        row.assistanceProvenance !== source.assistanceProvenance ||
        decimal(row.assistanceStepKg) !== sourceStep
      )
        return false;
      resolveRulesBundle(row.rulesVersion);
      if (row.loadSemantics === "external_load") {
        if (row.assistanceProvenance != null || row.assistanceStepKg != null) return false;
      } else if (row.loadSemantics === "assistance") {
        if (
          (row.assistanceProvenance !== "native" && row.assistanceProvenance !== "remediated") ||
          !isAllowedAssistanceVersion(row.assistanceProvenance, row.rulesVersion) ||
          row.assistanceStepKg == null ||
          !row.assistanceStepKg.isFinite() ||
          !row.assistanceStepKg.greaterThan(0)
        )
          return false;
        if (rawAssistanceSafetyStatus(toRawTargetRow(row, completed(row))) !== "safe") return false;
      } else return false;
    }
    // S(actual completed) above is insufficient: the new selected copy has no performed fact.
    return (
      source.loadSemantics === "external_load" ||
      rawAssistanceSafetyStatus(toRawTargetRow(source, false)) === "safe"
    );
  } catch {
    // Unknown versions/provenance and malformed raw decimal metadata fail closed.
    return false;
  }
}

/** Finite raw DB values are required for hashing. Invalid raw validation has no wire reason here. */
export function appendEligibility(
  cohort: AppendCohort,
  sourceId: string,
): AppendEligibility | null {
  const source = cohort.rows.find((row) => row.id === sourceId);
  if (!source) return null;
  const allowed = isAppendCohortSafe(cohort, sourceId);
  return {
    version: 1,
    source_revision: sourceRevision(source),
    cohort_revision: cohortRevision(cohort),
    status: allowed ? "allowed" : "blocked",
    reason: allowed ? null : "unsafe_assistance_snapshot",
  };
}

export type AppendSourceIdentity =
  | { source_planned_set_id: string; source_revision: string; source_correlation_id?: never }
  | { source_correlation_id: string; source_planned_set_id?: never; source_revision?: never };
export interface AppendIntent {
  exercise_id: string;
  correlation_id: string;
  source: AppendSourceIdentity;
  /** Ledger key and transport clock are deliberately outside the payload hash. */
  client_id?: string;
  updated_at?: string;
}
export function appendIntentHash(sessionId: string, intent: AppendIntent): string {
  // PostgreSQL UUID identity is case-insensitive. Only the hash is normalized; the DTO is untouched.
  const source =
    intent.source.source_planned_set_id !== undefined
      ? {
          source_planned_set_id: intent.source.source_planned_set_id.toLowerCase(),
          source_revision: intent.source.source_revision,
        }
      : { source_correlation_id: intent.source.source_correlation_id.toLowerCase() };
  return digest(
    JSON.stringify({
      operation: "session_set/upsert",
      session_id: sessionId.toLowerCase(),
      exercise_id: intent.exercise_id,
      correlation_id: intent.correlation_id.toLowerCase(),
      source,
    }),
  );
}
