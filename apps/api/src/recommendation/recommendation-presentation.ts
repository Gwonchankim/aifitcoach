import { normalizeRecommendationState, type LoadKind } from "shared";
import { loadKindForSnapshot, stateForReasonCode } from "../programs/assistance-migration";

export type PrescriptionCatalog = {
  metric: string;
  defaultStepKg: unknown;
  modality?: string | null;
};

/** ADR-70 response-only normalization. Never changes the stored prescription or F safety verdict. */
export function storedRecommendationPresentation(
  row: {
    prescriptionKind?: string | null;
    reasonCode: string | null;
    recommendedWeight: unknown;
    loadSemantics: "assistance" | "external_load" | null;
    targetTimeHighSec: number | null;
  },
  exercise?: PrescriptionCatalog | null,
) {
  if (
    row.reasonCode == null ||
    row.loadSemantics == null ||
    (row.prescriptionKind != null && row.prescriptionKind !== "resistance") ||
    (exercise?.modality != null && exercise.modality !== "resistance")
  )
    return {
      load_kind: "not_applicable" as const,
      recommendation_state: "unavailable" as const,
      recommended_weight: null,
    };
  const weight = row.recommendedWeight == null ? null : Number(row.recommendedWeight);
  const needsCatalog = row.loadSemantics !== "assistance" && weight === null;
  const missingCatalog = needsCatalog && !exercise;
  const loadKind: LoadKind = needsCatalog
    ? exercise?.metric === "time"
      ? "not_applicable"
      : exercise?.defaultStepKg === null
        ? "bodyweight"
        : "external"
    : loadKindForSnapshot({ ...row, loadSemantics: row.loadSemantics });
  const state = normalizeRecommendationState({
    state: missingCatalog ? "unavailable" : stateForReasonCode(row.reasonCode),
    reason: row.reasonCode,
    weight,
    load_kind: missingCatalog ? undefined : loadKind,
  });
  return {
    load_kind: loadKind,
    recommendation_state: state,
    recommended_weight: state === "load_calibration_needed" ? null : weight,
  };
}
