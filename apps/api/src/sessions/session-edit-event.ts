import { randomUUID } from "node:crypto";
import { Prisma, type PlannedSet, type SyncMutation } from "@prisma/client";

function marker(sessionId: string) {
  return { v: 1, origin: "server_session_edit", session_id: sessionId };
}

/** A sequence event is not a client mutation, a dependency success, or an LWW contender. */
export function isServerSessionEditEvent(
  row: Pick<SyncMutation, "entityId" | "requestIdentity"> & { entityType: string },
): boolean {
  const identity = row.requestIdentity;
  return (
    row.entityType === "session_routine" &&
    identity !== null &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    identity.v === 1 &&
    identity.origin === "server_session_edit" &&
    identity.session_id === row.entityId
  );
}

/** Filter before ORDER BY/take1, including legacy SQL-null identity rows explicitly. */
export function clientMutationCandidates(sessionId: string): Prisma.SyncMutationWhereInput {
  return {
    OR: [
      { requestIdentity: { equals: Prisma.DbNull } },
      { requestIdentity: { not: marker(sessionId) } },
    ],
  };
}

/** Caller holds the edit transaction locks. A failed event insert rolls its deletion back. */
export async function recordSessionEditEvent(
  tx: Prisma.TransactionClient,
  userId: string,
  sessionId: string,
  removed: readonly Pick<PlannedSet, "id" | "clientCorrelationId" | "exerciseId">[],
): Promise<void> {
  if (!removed.length) return;
  const now = new Date();
  await tx.syncMutation.create({
    data: {
      id: randomUUID(),
      userId,
      entityType: "session_routine",
      entityId: sessionId,
      op: "upsert",
      status: "applied",
      payload: {},
      clientUpdatedAt: now,
      appliedAt: now,
      requestIdentity: marker(sessionId),
      requestHash: null,
      resultIdentity: Prisma.DbNull,
      correlationClaims: Prisma.DbNull,
      dependencyIdentity: Prisma.DbNull,
      tombstoneIdentity: {
        v: 1,
        removed_sets: removed.map((row) => ({
          planned_set_id: row.id,
          correlation_id: row.clientCorrelationId,
          exercise_id: row.exerciseId,
        })),
      },
    },
  });
}
