import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { RULES_VERSION } from "../src/programs/program-rules";
import { createTestApp, resetUserData } from "./support/app";

describe("SIMILAR_INIT persisted session and existing wire gate", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = devUserId();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) await resetUserData(prisma, userId);
    await app?.close();
  });

  it("persists 45kg from bench history but masks the new incline prescription as no_history", async () => {
    await resetUserData(prisma, userId);
    await request(app.getHttpServer()).get("/v1/exercises").expect(200);
    await prisma.program.create({
      data: {
        userId,
        goal: "hypertrophy",
        daysPerWeek: 2,
        minutesPerDay: 30,
        splitType: "full_body",
        rulesVersion: RULES_VERSION,
        generationInput: {},
        template: [],
        createdAt: new Date("2026-07-01"),
        sessions: {
          create: {
            scheduledDate: new Date("2026-07-01"),
            completedAt: new Date("2026-07-01T12:00:00Z"),
            status: "completed",
            focus: "upper",
            plannedSets: {
              create: [1, 2, 3].map((setNo) => ({
                exerciseId: "e_bench_press",
                setNo,
                orderIndex: 0,
                targetRepsLow: 8,
                targetRepsHigh: 12,
                targetRir: 2,
                restSec: 120,
                recommendedWeight: 60,
                recommendedReps: 8,
                confidence: 0.3,
                reasonCode: "BASELINE",
                rulesVersion: RULES_VERSION,
                loadSemantics: "external_load" as const,
                performedSets: {
                  create: {
                    clientId: randomUUID(),
                    actualWeight: 60,
                    actualReps: 10,
                    actualRir: 2,
                    completed: true,
                    performedAt: new Date("2026-07-01T11:00:00Z"),
                  },
                },
              })),
            },
          },
        },
      },
    });
    const catalog = await prisma.exercise.findMany({ select: { id: true } });
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({
        goal: "hypertrophy",
        days_per_week: 2,
        minutes_per_day: 30,
        experience_level: "intermediate",
        avoid_exercises: catalog.map((e) => e.id).filter((id) => id !== "e_incline_bench_press"),
      })
      .expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const planned = await prisma.plannedSet.findFirstOrThrow({
      where: {
        exerciseId: "e_incline_bench_press",
        session: { status: "scheduled", program: { userId } },
      },
    });
    expect(planned.reasonCode).toBe("SIMILAR_INIT");
    // 60*(1+(10+2)/30)=84; floorToStep(84*.8/(1+14/30), 2.5)=45.
    expect(Number(planned.recommendedWeight)).toBe(45);
    expect([planned.targetRepsLow, planned.targetRepsHigh, planned.targetRir]).toEqual([6, 12, 2]);
    expect(planned.rulesVersion).toBe(RULES_VERSION);
    const response = await request(app.getHttpServer())
      .get(`/v1/sessions/${planned.sessionId}`)
      .expect(200);
    const wire = response.body.planned_sets.find((set: { id: string }) => set.id === planned.id);
    expect(wire).toBeDefined();
    expect(wire).toMatchObject({
      recommendation_gate: "no_history",
      recommended_weight: null,
      recommended_reps: null,
      reason_code: null,
      confidence: null,
      recommendation_state: null,
    });
  });
});
