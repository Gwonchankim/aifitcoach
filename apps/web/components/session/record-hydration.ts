import type { Session } from "../../lib/api";
import type { SetDraft } from "./session-store";

/** Read projection only: GET restores checks and values, but carries no pain score.
 * Existing drafts and pending writes are intent we cannot order against this summary:
 * performed_at is the first performance, not the last edit. Never replace them.
 */
export function hydrateRecordedSets(
  session: Session,
  drafts: Record<string, SetDraft>,
  pending: ReadonlySet<string>,
): Record<string, SetDraft> {
  const next = { ...drafts };
  for (const set of session.planned_sets) {
    const performed = set.performed_set;
    if (!performed || next[set.id] || pending.has(set.id)) continue;
    next[set.id] = {
      planned_set_id: set.id,
      actual_weight: performed.actual_weight,
      actual_reps: performed.actual_reps,
      actual_rir: performed.actual_rir,
      actual_time_sec: performed.actual_time_sec,
      pain_score: null,
      completed: performed.completed,
      // Like a pulled draft, this placeholder never goes on the wire. A user edit
      // replaces it with a new mutation UUID; retries reuse that stored outbox UUID.
      client_id: set.id,
      updated_at: "",
    };
  }
  return next;
}
