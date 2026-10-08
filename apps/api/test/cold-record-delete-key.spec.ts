import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { onSessionDay } from "./support/utc-today";

const USER = devUserId();
describe("cold record uncheck identity", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetUserData(prisma, USER);
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({
        goal: "hypertrophy",
        days_per_week: 4,
        minutes_per_day: 60,
        experience_level: "intermediate",
      })
      .expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("a new mutation client_id deletes the row named by planned_set entity_id and permits routine removal", async () => {
    const planned = await prisma.plannedSet.findFirstOrThrow({
      where: {
        session: { program: { userId: USER } },
        exercise: { metric: "reps", equipment: { not: "bodyweight" } },
      },
      orderBy: { id: "asc" },
    });
    const original = randomUUID();
    const deleted = randomUUID();
    expect(deleted).not.toBe(original);
    await onSessionDay(prisma, planned.sessionId, async () => {
      const sync = (mutations: unknown[]) =>
        request(app.getHttpServer()).post("/v1/sync").send({ mutations }).expect(200);
      const completed = await sync([
        {
          client_id: original,
          entity: "performed_set",
          entity_id: planned.id,
          op: "upsert",
          updated_at: "2026-08-15T08:00:00.000Z",
          payload: { actual_weight: 50, actual_reps: 8, actual_rir: 2, completed: true },
        },
      ]);
      expect(completed.body.applied).toContain(original);
      const stored = await prisma.performedSet.findUniqueOrThrow({
        where: { plannedSetId: planned.id },
      });
      expect(stored.clientId).toBe(original);
      const authoritative = await request(app.getHttpServer())
        .get(`/v1/sessions/${planned.sessionId}`)
        .expect(200);
      expect(
        authoritative.body.planned_sets.find((row: { id: string }) => row.id === planned.id)
          .performed_set.completed,
      ).toBe(true);
      const answer = await sync([
        {
          client_id: deleted,
          entity: "performed_set",
          entity_id: planned.id,
          op: "delete",
          updated_at: "2026-08-15T08:01:00.000Z",
          payload: {},
        },
      ]);
      expect(answer.body.applied).toContain(deleted);
      expect(answer.body.conflicts).toEqual([]);
      expect(await prisma.performedSet.count({ where: { plannedSetId: planned.id } })).toBe(0);
      const remaining = await prisma.plannedSet.findMany({
        where: { sessionId: planned.sessionId },
        orderBy: { orderIndex: "asc" },
      });
      const routineId = randomUUID();
      const removed = await sync([
        {
          client_id: routineId,
          entity: "session_routine",
          entity_id: planned.sessionId,
          op: "upsert",
          updated_at: "2026-08-15T08:02:00.000Z",
          payload: {
            exercise_ids: [
              ...new Set(
                remaining
                  .filter((row) => row.exerciseId !== planned.exerciseId)
                  .map((row) => row.exerciseId),
              ),
            ],
          },
        },
      ]);
      expect(removed.body.applied).toContain(routineId);
      expect(removed.body.conflicts).toEqual([]);
      expect(
        await prisma.plannedSet.count({
          where: { sessionId: planned.sessionId, exerciseId: planned.exerciseId },
        }),
      ).toBe(0);
      const get = await request(app.getHttpServer())
        .get(`/v1/sessions/${planned.sessionId}`)
        .expect(200);
      expect(
        get.body.planned_sets.some(
          (row: { exercise_id: string }) => row.exercise_id === planned.exerciseId,
        ),
      ).toBe(false);
    });
  });
});
