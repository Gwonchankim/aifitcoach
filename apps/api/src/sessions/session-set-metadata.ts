import {
  appendEligibility,
  sourceRevision,
  validateRawSessionSetSnapshot,
  type AppendEligibility,
  type RawSessionSetSnapshot,
} from "./session-set-snapshot";

export type SessionSetMetadata = {
  source_revision: string;
  correlation_id: string | null;
  append_eligibility: AppendEligibility | null;
};

/** All rows/facts must come from one authoritative session read snapshot. */
export function sessionSetMetadata(
  userId: string,
  sessionId: string,
  rows: readonly RawSessionSetSnapshot[],
): Map<string, SessionSetMetadata> {
  const cohorts = new Map<string, RawSessionSetSnapshot[]>();
  for (const row of rows)
    cohorts.set(row.exerciseId, [...(cohorts.get(row.exerciseId) ?? []), row]);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        // Non-finite persisted raw decimal encoding is deliberately not invented here (A06).
        source_revision: sourceRevision(row),
        correlation_id: row.clientCorrelationId ?? null,
        append_eligibility:
          validateRawSessionSetSnapshot(row).status === "valid"
            ? appendEligibility(
                {
                  userId,
                  sessionId,
                  exerciseId: row.exerciseId,
                  rows: cohorts.get(row.exerciseId)!,
                },
                row.id,
              )
            : null,
      },
    ]),
  );
}
