import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

export type MutationLockIdentity = { entity: string; entityId: string; clientId?: string };
export class SessionLockHintChanged extends Error {}

/** Existing sync namespace/order. Canonical and transport hints must be collected before locking. */
export async function lockMutationIdentities(
  tx: Prisma.TransactionClient,
  userId: string,
  identities: readonly MutationLockIdentity[],
): Promise<void> {
  const keys = new Set<string>();
  for (const identity of identities) {
    if (identity.clientId) keys.add(JSON.stringify(["client", identity.clientId.toLowerCase()]));
    keys.add(JSON.stringify(["entity", userId, identity.entity, identity.entityId.toLowerCase()]));
  }
  for (const key of [...keys].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export async function lockProgramRows(
  tx: Prisma.TransactionClient,
  programIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(programIds)].sort();
  if (ids.length)
    await tx.$queryRaw`SELECT id FROM programs WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}
export async function lockSessionRows(
  tx: Prisma.TransactionClient,
  sessionIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(sessionIds)].sort();
  if (ids.length)
    await tx.$queryRaw`SELECT id FROM workout_sessions WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}
export async function lockPlannedRowsForSessions(
  tx: Prisma.TransactionClient,
  sessionIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(sessionIds)].sort();
  if (ids.length)
    await tx.$queryRaw`SELECT id FROM planned_sets WHERE session_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}
export async function lockCorrelationClaims(
  tx: Prisma.TransactionClient,
  correlationIds: readonly string[],
): Promise<void> {
  const keys = [
    ...new Set(correlationIds.map((id) => JSON.stringify(["correlation", id.toLowerCase()]))),
  ].sort();
  for (const key of keys)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export async function lockReceiptRows(
  tx: Prisma.TransactionClient,
  clientIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(clientIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length)
    await tx.$queryRaw`SELECT id FROM sync_mutations WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}

/** Keep the five-attempt budget, including the observed raw-query serialization error only. */
export async function retrySessionWrite<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof SessionLockHintChanged ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2034" ||
            error.code === "P2002" ||
            (error.code === "P2010" && error.meta?.code === "40001")));
      if (!retryable || attempt >= 4) throw error;
    }
  }
}

export const SESSION_WRITE_INCLUDE = {
  program: true,
  plannedSets: {
    orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    include: { performedSets: { orderBy: { performedAt: "desc" } } },
  },
} satisfies Prisma.WorkoutSessionInclude;
export type LockedSession = Prisma.WorkoutSessionGetPayload<{
  include: typeof SESSION_WRITE_INCLUDE;
}>;

/** Stage1 keys → owned program → current session → all planned rows, then authoritative reread. */
export async function sessionWriteTransaction<T>(
  prisma: PrismaService,
  userId: string,
  sessionId: string,
  identities: readonly MutationLockIdentity[],
  work: (tx: Prisma.TransactionClient, session: LockedSession) => Promise<T>,
  retry = true,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new NotFoundException("세션을 찾을 수 없다.");
  const operation = async () => {
    const hint = await prisma.workoutSession.findFirst({
      where: { id: sessionId, program: { userId } },
      select: { id: true, programId: true },
    });
    if (!hint) throw new NotFoundException("세션을 찾을 수 없다.");
    return prisma.$transaction(
      async (tx) => {
        await lockMutationIdentities(tx, userId, identities);
        await lockProgramRows(tx, [hint.programId]);
        await lockSessionRows(tx, [hint.id]);
        await lockPlannedRowsForSessions(tx, [hint.id]);
        const session = await tx.workoutSession.findFirst({
          where: { id: hint.id, program: { userId } },
          include: SESSION_WRITE_INCLUDE,
        });
        if (!session) throw new NotFoundException("세션을 찾을 수 없다.");
        if (session.programId !== hint.programId) throw new SessionLockHintChanged();
        return work(tx, session);
      },
      // The lock statements can wait without changing their rows. RepeatableRead would retain
      // a pre-wait snapshot and miss the previous writer's inserted/deleted membership or facts.
      // ReadCommitted refreshes the post-lock reads; the locks above remain held until commit.
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  };
  return retry ? retrySessionWrite(operation) : operation();
}
