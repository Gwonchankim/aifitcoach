import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { applyTestDatabaseEnv } from "./global-setup";
import { REPO_ROOT, testDatabaseUrl } from "./support/database-url";

/** Real seed replay must preserve a pre-existing performed history, not merely exercise count. */
it("baseline reseed preserves exact program/session/planned/performed snapshots", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
  const userId = randomUUID();
  const programId = randomUUID();
  const sessionId = randomUUID();
  const plannedId = randomUUID();
  try {
    await prisma.user.create({
      data: {
        id: userId,
        sex: "other",
        birthYear: 1990,
        heightCm: 170,
        weightKg: 70,
        goal: "hypertrophy",
        experienceLevel: "beginner",
        constraints: {},
        programs: {
          create: {
            id: programId,
            goal: "hypertrophy",
            daysPerWeek: 4,
            minutesPerDay: 60,
            splitType: "upper_lower",
            rulesVersion: "2026.08.1",
            generationInput: { sentinel: "preserve" },
            template: [{ sentinel: "immutable" }],
            sessions: {
              create: {
                id: sessionId,
                scheduledDate: new Date("2026-08-14"),
                status: "completed",
                focus: "upper",
                completedAt: new Date("2026-08-14T10:00:00Z"),
                plannedSets: {
                  create: {
                    id: plannedId,
                    exerciseId: "e_bench_press",
                    setNo: 1,
                    orderIndex: 0,
                    targetRepsLow: 6,
                    targetRepsHigh: 12,
                    targetRir: 2,
                    restSec: 120,
                    recommendedWeight: 40,
                    recommendedReps: 10,
                    reasonCode: "BASELINE",
                    confidence: 0.3,
                    rulesVersion: "2026.08.1",
                    loadSemantics: "external_load",
                    performedSets: {
                      create: {
                        clientId: randomUUID(),
                        actualWeight: 40,
                        actualReps: 10,
                        actualRir: 2,
                        completed: true,
                        performedAt: new Date("2026-08-14T09:59:00Z"),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const snapshot = () =>
      prisma.program.findUniqueOrThrow({
        where: { id: programId },
        include: { sessions: { include: { plannedSets: { include: { performedSets: true } } } } },
      });
    const before = await snapshot();
    const exerciseIds = await prisma.exercise.findMany({
      orderBy: { id: "asc" },
      select: { id: true },
    });
    execSync("pnpm --filter api db:seed", {
      cwd: REPO_ROOT,
      env: applyTestDatabaseEnv({ ...process.env }, testDatabaseUrl()),
      stdio: "pipe",
    });
    expect(await snapshot()).toEqual(before);
    expect(
      await prisma.exercise.findMany({ orderBy: { id: "asc" }, select: { id: true } }),
    ).toEqual(exerciseIds);
    expect(exerciseIds).toHaveLength(106);
  } finally {
    await prisma.performedSet.deleteMany({ where: { plannedSetId: plannedId } });
    await prisma.plannedSet.deleteMany({ where: { id: plannedId } });
    await prisma.workoutSession.deleteMany({ where: { id: sessionId } });
    await prisma.program.deleteMany({ where: { id: programId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
}, 120_000);
