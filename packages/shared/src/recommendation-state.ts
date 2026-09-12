import type { LoadKind, RecommendationState } from "./types";

export type RecommendationStateInput = {
  state?: unknown;
  reason?: unknown;
  weight?: number | null;
  /** Canonical modality or the server's persisted load snapshot; never inferred from null weight. */
  load_kind?: LoadKind;
};

/** ADR-70: reason OR explicit state, conservative priority; unknown strings are not signals. */
export function normalizeRecommendationState({
  state,
  reason,
  weight,
  load_kind,
}: RecommendationStateInput): RecommendationState {
  if (reason === "SUBSTITUTE_PAIN" || state === "substitution_required")
    return "substitution_required";
  if (reason === "INVALID_INPUT" || state === "unavailable") return "unavailable";
  if (
    reason === "LOAD_CALIBRATION_NEEDED" ||
    reason === "ASSISTANCE_CALIBRATION_NEEDED" ||
    state === "load_calibration_needed"
  )
    return "load_calibration_needed";
  if (load_kind === undefined) return "unavailable";
  // V1 display gates removed every prescription signal, including for bodyweight/time.
  // Modality alone cannot reconstruct that hidden prescription; wait for fresh authority.
  if (state == null && reason == null && weight == null) return "unavailable";
  if (reason === "BASELINE" && load_kind === "external" && (weight === 0 || weight === null))
    return "load_calibration_needed";
  return "ready";
}
