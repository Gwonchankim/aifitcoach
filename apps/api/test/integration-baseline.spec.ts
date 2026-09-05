import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { applyTestDatabaseEnv } from "./global-setup";
import { REPO_ROOT, testDatabaseUrl } from "./support/database-url";

import { CATALOG_COUNT } from "./support/catalog-extension";
import { createTestApp, resetUserData } from "./support/app";
import { ProgramsService } from "../src/programs/programs.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { RecommendationService } from "../src/recommendation/recommendation.service";

/** Real seed replay must preserve a pre-existing performed history, not merely exercise count. */
it("baseline reseed preserves exact program/session/planned/performed snapshots", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
  const userId = randomUUID();
  const programId = randomUUID();
  const sessionId = randomUUID();
  const plannedId = randomUUID();
  const assistedId = randomUUID();
  let app: INestApplication | undefined;
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
    await prisma.plannedSet.create({
      data: {
        id: assistedId,
        sessionId,
        exerciseId: "e_assisted_pullup",
        setNo: 1,
        orderIndex: 1,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 90,
        recommendedWeight: 20,
        recommendedReps: 10,
        reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
        confidence: 0.3,
        rulesVersion: "2026.08.2",
        loadSemantics: "assistance",
        assistanceStepKg: 2.5,
        assistanceProvenance: "native",
        performedSets: {
          create: {
            clientId: randomUUID(),
            actualWeight: 20,
            actualReps: 10,
            actualRir: 2,
            completed: true,
            performedAt: new Date("2026-08-14T09:59:00Z"),
          },
        },
      },
    });
    const snapshot = () =>
      prisma.program.findUniqueOrThrow({
        where: { id: programId },
        include: {
          sessions: {
            orderBy: { id: "asc" },
            include: {
              plannedSets: {
                orderBy: { orderIndex: "asc" },
                include: { performedSets: { orderBy: { id: "asc" } } },
              },
            },
          },
        },
      });
    const before = await snapshot();
    const exercisesBefore = await prisma.exercise.findMany({
      orderBy: { id: "asc" },
    });
    execSync("pnpm --filter api db:seed", {
      cwd: REPO_ROOT,
      env: applyTestDatabaseEnv({ ...process.env }, testDatabaseUrl()),
      stdio: "pipe",
    });
    expect(await snapshot()).toEqual(before);
    expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(exercisesBefore);
    expect(exercisesBefore).toHaveLength(CATALOG_COUNT);
    // Replay twice with completed external + assistance facts already present.
    execSync("pnpm --filter api db:seed", {
      cwd: REPO_ROOT,
      env: applyTestDatabaseEnv({ ...process.env }, testDatabaseUrl()),
      stdio: "pipe",
    });
    expect(await snapshot()).toEqual(before);
    expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(exercisesBefore);
    app = await createTestApp();
    const programs = app.get(ProgramsService);
    const recommendations = app.get(RecommendationService);
    const historySpecs = [
      { exerciseId: "e_bench_press", loadSemantics: "external_load" as const },
      { exerciseId: "e_assisted_pullup", loadSemantics: "assistance" as const },
      { exerciseId: "e_low_row_machine", loadSemantics: "external_load" as const },
      { exerciseId: "e_high_row_machine", loadSemantics: "external_load" as const },
      { exerciseId: "e_incline_chest_press_machine", loadSemantics: "external_load" as const },
    ];
    const historiesBefore = await recommendations.prefetchHistories(userId, historySpecs);
    expect(historiesBefore.get("e_bench_press")?.lastSets).toHaveLength(1);
    expect(historiesBefore.get("e_assisted_pullup")?.lastSets).toHaveLength(1);
    for (const { exerciseId } of historySpecs.slice(2))
      expect(historiesBefore.get(exerciseId)?.lastSets).toEqual([]);
    await programs.generate(userId, {
      goal: "hypertrophy",
      days_per_week: 4,
      minutes_per_day: 60,
      experience_level: "beginner",
    });
    await programs.current(userId);
    expect(await snapshot()).toEqual(before);
    // A new machine fact must not rewrite either pre-existing exercise history chain.
    const newSession = await prisma.workoutSession.findFirstOrThrow({
      where: { program: { userId }, id: { not: sessionId } },
    });
    await prisma.plannedSet.create({
      data: {
        sessionId: newSession.id,
        exerciseId: "e_low_row_machine",
        orderIndex: 99,
        setNo: 1,
        targetRepsLow: 8,
        targetRepsHigh: 15,
        targetRir: 2,
        restSec: 120,
        recommendedWeight: 25,
        recommendedReps: 10,
        reasonCode: "BASELINE",
        confidence: 0.3,
        rulesVersion: "2026.08.1",
        loadSemantics: "external_load",
        performedSets: {
          create: {
            clientId: randomUUID(),
            actualWeight: 25,
            actualReps: 10,
            actualRir: 2,
            completed: true,
            performedAt: new Date("2026-08-15T10:00:00Z"),
          },
        },
      },
    });
    await prisma.workoutSession.update({
      where: { id: newSession.id },
      data: { status: "completed", completedAt: new Date("2026-08-15T10:01:00Z") },
    });
    const historiesAfter = await recommendations.prefetchHistories(userId, historySpecs);
    for (const { exerciseId } of historySpecs.filter(
      (row) => row.exerciseId !== "e_low_row_machine",
    ))
      expect(historiesAfter.get(exerciseId)).toEqual(historiesBefore.get(exerciseId));
    expect(historiesAfter.get("e_low_row_machine")?.lastSets).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  } finally {
    await resetUserData(prisma as PrismaService, userId);
    await app?.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
}, 120_000);
