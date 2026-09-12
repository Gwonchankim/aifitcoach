import { normalizeRecommendationState, type LoadKind } from "shared";
import { loadKindForSnapshot, stateForReasonCode } from "../programs/assistance-migration";

export type PrescriptionCatalog = { metric: string; defaultStepKg: unknown };

/** ADR-70 response-only normalization. Never changes the stored prescription or F safety verdict. */
export function storedRecommendationPresentation(
  row: {
    reasonCode: string;
    recommendedWeight: unknown;
    loadSemantics: "assistance" | "external_load";
    targetTimeHighSec: number | null;
  },
  exercise?: PrescriptionCatalog | null,
) {
  const weight = row.recommendedWeight == null ? null : Number(row.recommendedWeight);
  const needsCatalog = row.loadSemantics !== "assistance" && weight === null;
  const missingCatalog = needsCatalog && !exercise;
  const loadKind: LoadKind = needsCatalog
    ? exercise?.metric === "time"
      ? "not_applicable"
      : exercise?.defaultStepKg === null
        ? "bodyweight"
        : "external"
    : loadKindForSnapshot(row);
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
