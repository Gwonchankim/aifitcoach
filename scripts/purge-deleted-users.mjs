/**
 * Permanently remove accounts that were already soft-deleted before PURGE_BEFORE.
 *
 * This is intentionally an explicit Cloud Run Job command rather than an API startup
 * task.  A missing cutoff is an error: the operator must choose the retention window
 * for each execution instead of silently applying an invented default.
 */
import { createRequire } from "node:module";
import { log } from "node:console";
import process from "node:process";
import { URL } from "node:url";

// Prisma is an apps/api dependency in this pnpm workspace, not a root dependency.
const requireApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { PrismaClient } = requireApi("@prisma/client");

const beforeRaw = process.env.PURGE_BEFORE;
if (!beforeRaw) {
  throw new Error("PURGE_BEFORE(ISO-8601 시각)가 필요하다. 예: 2026-09-01T00:00:00.000Z");
}

const before = new Date(beforeRaw);
if (Number.isNaN(before.getTime())) {
  throw new Error("PURGE_BEFORE 는 유효한 ISO-8601 시각이어야 한다.");
}

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DIRECT_URL 또는 DATABASE_URL 이 필요하다.");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function purgeUser(userId) {
  return prisma.$transaction(async (tx) => {
    // A concurrent administrator cannot reactivate accounts today, but keep the
    // cutoff predicate in the transaction so a future recovery path cannot be purged.
    const user = await tx.user.findFirst({
      where: { id: userId, deletedAt: { lte: before } },
      select: { id: true },
    });
    if (!user) return false;

    // FK is RESTRICT by design.  Child -> parent order is mirrored in SECURITY_PIPA.md.
    await tx.accessAudit.deleteMany({ where: { userId } });
    await tx.authSession.deleteMany({ where: { userId } });
    await tx.performedSet.deleteMany({
      where: { plannedSet: { session: { program: { userId } } } },
    });
    await tx.assistanceAudit.deleteMany({
      where: { plannedSet: { session: { program: { userId } } } },
    });
    await tx.plannedSet.deleteMany({ where: { session: { program: { userId } } } });
    await tx.workoutSession.deleteMany({ where: { program: { userId } } });
    await tx.program.deleteMany({ where: { userId } });
    await tx.calibrationSet.deleteMany({ where: { userId } });
    await tx.userRirCalibration.deleteMany({ where: { userId } });
    await tx.estimated1rm.deleteMany({ where: { userId } });
    await tx.muscleWeeklyLoad.deleteMany({ where: { userId } });
    await tx.syncMutation.deleteMany({ where: { userId } });
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.consent.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
    return true;
  });
}

try {
  const candidates = await prisma.user.findMany({
    where: { deletedAt: { lte: before } },
    select: { id: true },
  });

  let purged = 0;
  for (const { id } of candidates) {
    if (await purgeUser(id)) purged += 1;
  }
  // Do not log account identifiers or user data from this privacy operation.
  log(`[purge-deleted-users] ${before.toISOString()} 이전 계정 ${purged}건을 영구 삭제했습니다.`);
} finally {
  await prisma.$disconnect();
}
