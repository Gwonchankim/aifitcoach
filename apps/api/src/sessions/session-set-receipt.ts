import { Prisma, type SyncMutation } from "@prisma/client";
import { isServerSessionEditEvent } from "./session-edit-event";

export type CorrelationClaim = {
  correlation_id: string;
  session_id: string;
  exercise_id: string;
  planned_set_id: string | null;
  creation_revision: string | null;
};
export type StoredCorrelationClaim = { receipt: SyncMutation; claim: CorrelationClaim };
export function identityObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Global claims include historical routine identities even after their PlannedSet has gone. */
export async function readCorrelationClaims(
  tx: Prisma.TransactionClient,
  correlationIds: readonly string[],
): Promise<StoredCorrelationClaim[]> {
  const ids = [...new Set(correlationIds.map((id) => id.toLowerCase()))];
  if (!ids.length) return [];
  const predicates = ids.map(
    (id) => Prisma.sql`(
    correlation_claims @> ${JSON.stringify([{ correlation_id: id }])}::jsonb
    OR (entity_type = 'session_routine' AND status = 'applied' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'correlations') = 'array'
        THEN payload->'correlations' ELSE '[]'::jsonb END) AS item
      WHERE lower(item->>'correlation_id') = ${id}
    ))
  )`,
  );
  const matches = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM sync_mutations WHERE ${Prisma.join(predicates, " OR ")} ORDER BY id`);
  const receipts = await tx.syncMutation.findMany({
    where: { id: { in: matches.map((row) => row.id) } },
    orderBy: { id: "asc" },
  });
  const result: StoredCorrelationClaim[] = [];
  const legacyResult: StoredCorrelationClaim[] = [];
  for (const receipt of receipts) {
    if (isServerSessionEditEvent(receipt)) continue;
    const current = Array.isArray(receipt.correlationClaims) ? receipt.correlationClaims : [];
    const legacy =
      receipt.entityType === "session_routine" && receipt.status === "applied"
        ? identityObject(receipt.payload).correlations
        : [];
    for (const raw of current) {
      const value = identityObject(raw);
      if (
        typeof value.correlation_id !== "string" ||
        !ids.includes(value.correlation_id.toLowerCase())
      )
        continue;
      result.push({
        receipt,
        claim: {
          correlation_id: value.correlation_id.toLowerCase(),
          session_id: typeof value.session_id === "string" ? value.session_id : "",
          exercise_id: typeof value.exercise_id === "string" ? value.exercise_id : "",
          planned_set_id: typeof value.planned_set_id === "string" ? value.planned_set_id : null,
          creation_revision:
            typeof value.creation_revision === "string" ? value.creation_revision : null,
        },
      });
    }
    if (!Array.isArray(legacy)) continue;
    for (const raw of legacy) {
      const value = identityObject(raw);
      if (
        typeof value.correlation_id !== "string" ||
        !ids.includes(value.correlation_id.toLowerCase())
      )
        continue;
      // This is an old identity reservation, not proof of a creation revision. Never guess it.
      legacyResult.push({
        receipt,
        claim: {
          correlation_id: value.correlation_id.toLowerCase(),
          session_id: receipt.entityId,
          exercise_id: typeof value.exercise_id === "string" ? value.exercise_id : "",
          planned_set_id: null,
          creation_revision: null,
        },
      });
    }
  }
  return [
    ...result,
    ...legacyResult.filter(
      (legacy) => !result.some((item) => item.claim.correlation_id === legacy.claim.correlation_id),
    ),
  ];
}
