import { PrismaClient } from "@prisma/client";

/** Explicitly owned synthetic E2E graph only. Never loads root .env or falls back to dev DB. */
export async function resetWeekSwapE2eOwner({
  expectedOwnerId,
}: {
  expectedOwnerId: string;
}): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (
    !url ||
    url !== process.env.DATABASE_URL ||
    url !== process.env.DIRECT_URL ||
    !process.env.E2E_DEV_USER_ID ||
    expectedOwnerId !== process.env.E2E_DEV_USER_ID ||
    !/^[0-9a-f-]{36}$/i.test(expectedOwnerId)
  )
    throw new Error("WEEK_SWAP_FIXTURE_OWNER_ENV");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("WEEK_SWAP_FIXTURE_URL");
  }
  if (
    !["postgresql:", "postgres:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/afc_[a-zA-Z0-9_]+_e2e$/.test(parsed.pathname)
  )
    throw new Error("WEEK_SWAP_FIXTURE_DATABASE_SCOPE");
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: expectedOwnerId } })))
        throw new Error("WEEK_SWAP_FIXTURE_OWNER_ABSENT");
      const userId = expectedOwnerId;
      await tx.weekSwapReceipt.deleteMany({ where: { userId } });
      await tx.syncMutation.deleteMany({ where: { userId } });
      await tx.estimated1rm.deleteMany({ where: { userId } });
      await tx.muscleWeeklyLoad.deleteMany({ where: { userId } });
      await tx.performedSet.deleteMany({
        where: { plannedSet: { session: { program: { userId } } } },
      });
      await tx.assistanceAudit.deleteMany({
        where: { plannedSet: { session: { program: { userId } } } },
      });
      await tx.plannedSet.deleteMany({ where: { session: { program: { userId } } } });
      await tx.workoutSession.deleteMany({ where: { program: { userId } } });
      await tx.program.deleteMany({ where: { userId } });
      await tx.userRirCalibration.deleteMany({ where: { userId } });
    });
  } catch {
    throw new Error("WEEK_SWAP_FIXTURE_DATABASE_OPERATION");
  } finally {
    await db.$disconnect();
  }
}
