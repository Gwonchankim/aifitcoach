/** The production purge Job physically removes only accounts deleted before its explicit cutoff. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { REPO_ROOT } from "./support/database-url";
import { testUserId } from "./support/users";

const USER_ID = testUserId("purge");
const prisma = new PrismaClient();

async function removeFixture(): Promise<void> {
  await prisma.accessAudit.deleteMany({ where: { userId: USER_ID } });
  await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
  // assistance_audits 는 ON DELETE RESTRICT 라 planned_sets 보다 먼저 지운다.
  await prisma.assistanceAudit.deleteMany({
    where: { plannedSet: { session: { program: { userId: USER_ID } } } },
  });
  await prisma.plannedSet.deleteMany({ where: { session: { program: { userId: USER_ID } } } });
  await prisma.workoutSession.deleteMany({ where: { program: { userId: USER_ID } } });
  await prisma.program.deleteMany({ where: { userId: USER_ID } });
  await prisma.consent.deleteMany({ where: { userId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

/**
 * 어시스트 처방 row 와 거기 매달린 audit 를 만든다.
 * audit 가 남아 있으면 `planned_sets` 삭제가 FK 로 막혀 **계정 영구 삭제 자체가 실패**한다 —
 * PIPA 삭제권을 못 지키는 상태라 purge Job 이 이 조합을 반드시 통과해야 한다.
 */
async function createAssistanceAuditFixture(): Promise<void> {
  const program = await prisma.program.create({
    data: {
      userId: USER_ID,
      goal: "hypertrophy",
      daysPerWeek: 3,
      minutesPerDay: 60,
      splitType: "full_body",
      rulesVersion: "2026.08.1",
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
      totalWeeks: 12,
      status: "active",
      generationInput: {},
      template: [],
      excludedExercises: [],
    },
  });
  const session = await prisma.workoutSession.create({
    data: {
      programId: program.id,
      scheduledDate: new Date("2026-08-03T00:00:00.000Z"),
      focus: "full_body",
      status: "scheduled",
    },
  });
  const planned = await prisma.plannedSet.create({
    data: {
      sessionId: session.id,
      exerciseId: "e_assisted_pullup",
      orderIndex: 0,
      setNo: 1,
      restSec: 90,
      recommendedReps: 8,
      reasonCode: "ASSISTANCE_CALIBRATION_NEEDED",
      confidence: "0",
      rulesVersion: "2026.08.2",
      loadSemantics: "assistance",
      assistanceStepKg: "2.50",
      assistanceProvenance: "native",
    },
  });
  await prisma.assistanceAudit.create({
    data: { plannedSetId: planned.id, action: "native", metadata: {} },
  });
}

describe("deleted-user purge Job", () => {
  beforeEach(async () => {
    await removeFixture();
    await prisma.user.create({
      data: {
        id: USER_ID,
        sex: "other",
        birthYear: 1995,
        heightCm: 175,
        weightKg: 75,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.consent.create({
      data: {
        userId: USER_ID,
        type: "privacy_collection",
        version: "test",
        granted: true,
        grantedAt: new Date(),
      },
    });
    await prisma.authSession.create({
      data: {
        userId: USER_ID,
        sessionTokenHash: createHash("sha256").update(`${USER_ID}:sid`).digest("hex"),
        csrfTokenHash: createHash("sha256").update(`${USER_ID}:csrf`).digest("hex"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    await prisma.accessAudit.create({
      data: { userId: USER_ID, action: "account_delete_requested" },
    });
    await createAssistanceAuditFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await prisma.$disconnect();
  });

  it("requires an explicit cutoff and deletes child records before the soft-deleted account", async () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "purge-deleted-users.mjs")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DIRECT_URL: process.env.DATABASE_URL,
          PURGE_BEFORE: "2026-02-01T00:00:00.000Z",
        },
        encoding: "utf8",
      },
    );

    if (result.status !== 0) {
      throw new Error(`purge Job 실패\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    expect(result.stdout).toContain("1건을 영구 삭제했습니다.");
    await expect(prisma.user.findUnique({ where: { id: USER_ID } })).resolves.toBeNull();
    await expect(prisma.authSession.count({ where: { userId: USER_ID } })).resolves.toBe(0);
    await expect(prisma.accessAudit.count({ where: { userId: USER_ID } })).resolves.toBe(0);
    await expect(prisma.consent.count({ where: { userId: USER_ID } })).resolves.toBe(0);
    await expect(
      prisma.plannedSet.count({ where: { session: { program: { userId: USER_ID } } } }),
    ).resolves.toBe(0);
    await expect(
      prisma.assistanceAudit.count({
        where: { plannedSet: { session: { program: { userId: USER_ID } } } },
      }),
    ).resolves.toBe(0);
  });
});
