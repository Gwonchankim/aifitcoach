import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { withUtcToday } from "./support/utc-today";

const USER = devUserId();
describe("cold read draft / weekly swap server counterpart", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let programId: string;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await resetUserData(prisma, USER);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(404);
    const program = await prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 2,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: new Date("2026-09-14T00:00:00Z"),
        totalWeeks: 12,
        template: [
          {
            day: "MON",
            focus: "core",
            exercises: [
              {
                exercise_id: "e_plank",
                sets: 1,
                reps_low: null,
                reps_high: null,
                target_rir: null,
                rest_sec: 90,
                time_low_sec: 30,
                time_high_sec: 60,
              },
            ],
          },
        ],
      },
    });
    programId = program.id;
  });
  async function session(date: string, status: "scheduled" | "completed" = "scheduled") {
    return prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: new Date(`${date}T00:00:00Z`),
        focus: "core",
        status,
        origin: "planned",
        plannedSets: {
          create: {
            exerciseId: "e_plank",
            orderIndex: 0,
            setNo: 1,
            targetRepsLow: null,
            targetRepsHigh: null,
            targetRir: null,
            targetTimeLowSec: 30,
            targetTimeHighSec: 60,
            restSec: 90,
            recommendedWeight: null,
            recommendedReps: null,
            reasonCode: "BASELINE",
            confidence: 0.5,
            rulesVersion: "2026.08.1",
            loadSemantics: "external_load",
          },
        },
      },
      include: { plannedSets: true },
    });
  }
  async function complete(row: Awaited<ReturnType<typeof session>>) {
    await withUtcToday(row.scheduledDate, async () => {
      const clientId = randomUUID();
      const answer = await request(app.getHttpServer())
        .post("/v1/sync")
        .send({
          mutations: [
            {
              client_id: clientId,
              entity: "performed_set",
              entity_id: row.plannedSets[0].id,
              op: "upsert",
              updated_at: row.scheduledDate.toISOString(),
              payload: { actual_time_sec: 30, completed: true },
            },
          ],
        })
        .expect(200);
      expect(answer.body.applied).toContain(clientId);
      expect(answer.body.conflicts).toEqual([]);
      expect(
        await prisma.performedSet.count({ where: { plannedSetId: row.plannedSets[0].id } }),
      ).toBe(1);
    });
  }
  async function candidates() {
    return (
      await request(app.getHttpServer())
        .get(`/v1/programs/${programId}/week-swaps/candidates`)
        .expect(200)
    ).body;
  }
  async function swap(a: string, b: string) {
    const current = (
      await request(app.getHttpServer()).get(`/v1/programs/${programId}/weeks/current`).expect(200)
    ).body;
    return request(app.getHttpServer())
      .post(`/v1/programs/${programId}/week-swaps`)
      .send({
        client_id: randomUUID(),
        today_session_id: a,
        target_session_id: b,
        today_revision: current.sessions.find((row: { id: string }) => row.id === a).revision,
        target_revision: current.sessions.find((row: { id: string }) => row.id === b).revision,
      });
  }
  it("an actual in the hydrated pair is independently rejected by the server as performed_history", async () => {
    await withUtcToday("2026-09-14", async () => {
      const a = await session("2026-09-14"),
        b = await session("2026-09-17");
      expect((await candidates()).today_eligible).toBe(true);
      await complete(a);
      expect(await candidates()).toMatchObject({
        today_eligible: false,
        today_reason: "performed_history",
      });
      const denied = await swap(a.id, b.id);
      expect(denied.status).toBe(409);
      expect(denied.body.error.details.reason).toBe("performed_history");
    });
  });
  it("an unrelated historic actual leaves the pair eligible and the real server swap succeeds", async () => {
    await withUtcToday("2026-09-14", async () => {
      const a = await session("2026-09-14"),
        b = await session("2026-09-17");
      const history = await session("2026-09-13", "completed");
      await complete(history);
      const allowed = await candidates();
      expect(allowed.today_eligible).toBe(true);
      expect(
        allowed.candidates.find((row: { session: { id: string } }) => row.session.id === b.id),
      ).toMatchObject({ eligible: true, reason: null });
      const answer = await swap(a.id, b.id);
      expect(answer.status).toBe(200);
      expect(answer.body.today_session_id).toBe(b.id);
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: a.id } })).scheduledDate
          .toISOString()
          .slice(0, 10),
      ).toBe("2026-09-17");
    });
  });
});
