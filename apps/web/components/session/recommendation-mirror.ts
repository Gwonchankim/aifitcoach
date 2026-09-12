import { normalizeRecommendationState, type LoadKind } from "shared";
import type { Exercise } from "../../lib/api";

const LOAD_KINDS = new Set(["external", "bodyweight", "not_applicable", "assistance"]);

/** Normalize server/legacy rows only. Local envelopes must continue to assert no prescription. */
export function normalizeSessionRecommendations<T>(
  session: T,
  catalog: readonly Exercise[] = [],
  localIds: ReadonlySet<string> = new Set(),
): T {
  if (!session || typeof session !== "object" || !("planned_sets" in session)) return session;
  if (!Array.isArray(session.planned_sets)) return session;
  return {
    ...session,
    planned_sets: session.planned_sets.map((row: Record<string, unknown>) => {
      if (!row || typeof row !== "object" || localIds.has(String(row.id))) return row;
      const exercise = catalog.find((item) => item.id === row.exercise_id);
      const loadKind: LoadKind | undefined = LOAD_KINDS.has(String(row.load_kind))
        ? (row.load_kind as LoadKind)
        : exercise?.metric === "time"
          ? "not_applicable"
          : exercise?.step_kg === null
            ? "bodyweight"
            : exercise?.step_kg !== undefined
              ? "external"
              : undefined;
      const state = normalizeRecommendationState({
        state: row.recommendation_state,
        reason: row.reason_code,
        weight: typeof row.recommended_weight === "number" ? row.recommended_weight : null,
        load_kind: loadKind,
      });
      return {
        ...row,
        recommendation_state: state,
        ...(loadKind ? { load_kind: loadKind } : {}),
        ...(state === "load_calibration_needed" ? { recommended_weight: null } : {}),
      };
    }),
  };
}
