import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AggregationProjector } from "../src/analytics/aggregation.projector";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const PROGRAM_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_IDS = [
  "40000000-0000-4000-8000-000000000101",
  "40000000-0000-4000-8000-000000000102",
  "40000000-0000-4000-8000-000000000103",
] as const;
const DATES = ["2026-08-03", "2026-08-04", "2026-08-05"] as const;

describe("M-4′ analytics 결정론", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let projector: AggregationProjector;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    projector = app.get(AggregationProjector);
  });

  afterAll(async () => {
    if (prisma) await resetUserData(prisma, USER_ID);
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  async function seed(order: readonly number[]): Promise<void> {
    await prisma.program.create({
      data: {
        id: PROGRAM_ID,
        userId: USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 3,
        minutesPerDay: 60,
        splitType: "full_body",
        rulesVersion: "2026.08.1",
        startedAt: new Date("2026-08-03T00:00:00.000Z"),
        template: [
          {
            day: "MON",
            focus: "full_body",
            exercises: [
              {
                exercise_id: "e_bench_press",
                sets: 1,
                target_reps_low: 6,
                target_reps_high: 12,
                target_rir: 2,
                rest_sec: 120,
              },
            ],
          },
        ],
        excludedExercises: [],
      },
    });
    for (const index of order) {
      const setId = `40000000-0000-4000-8000-0000000002${index}1`;
      await prisma.workoutSession.create({
        data: {
          id: SESSION_IDS[index],
          programId: PROGRAM_ID,
          scheduledDate: new Date(`${DATES[index]}T00:00:00.000Z`),
          focus: "full_body",
          status: "completed",
          completedAt: new Date(`${DATES[index]}T10:00:00.000Z`),
          plannedSets: {
            create: {
              id: setId,
              exerciseId: "e_bench_press",
              orderIndex: 0,
              setNo: 1,
              targetRepsLow: 6,
              targetRepsHigh: 12,
              targetRir: 2,
              restSec: 120,
              recommendedWeight: 60,
              recommendedReps: 6,
              reasonCode: "BASELINE",
              confidence: 0.5,
              loadSemantics: "external_load" as const,
              rulesVersion: "2026.08.1",
              performedSets: {
                create: {
                  id: `40000000-0000-4000-8000-0000000003${index}1`,
                  clientId: `40000000-0000-4000-8000-0000000004${index}1`,
                  actualWeight: 80 + index * 5,
                  actualReps: 5,
                  actualRir: 1,
                  completed: true,
                  performedAt: new Date(`${DATES[index]}T09:00:00.000Z`),
                },
              },
            },
          },
        },
      });
    }
  }

  async function e1rmResponse(): Promise<unknown> {
    const response = await request(app.getHttpServer())
      .get("/v1/analytics/e1rm")
      .query({ exercise_id: "e_bench_press" })
      .expect(200);
    expectMatchesContract("get", "/analytics/e1rm", 200, response.body);
    return response.body;
  }

  async function derivedRows(): Promise<string> {
    const [e1rm, volume] = await Promise.all([
      prisma.estimated1rm.findMany({
        where: { userId: USER_ID },
        orderBy: [{ sessionId: "asc" }, { exerciseId: "asc" }],
      }),
      prisma.muscleWeeklyLoad.findMany({
        where: { userId: USER_ID },
        orderBy: [{ weekStart: "asc" }, { muscle: "asc" }],
      }),
    ]);
    return JSON.stringify({
      e1rm: e1rm.map((row) => ({
        exercise_id: row.exerciseId,
        session_id: row.sessionId,
        e1rm: Number(row.e1rm),
        method: row.method,
        computed_at: row.computedAt.toISOString(),
      })),
      volume: volume.map((row) => ({
        week_start: row.weekStart.toISOString(),
        muscle: row.muscle,
        hard_sets: row.hardSets,
        volume_load: Number(row.volumeLoad),
        avg_rir: row.avgRir === null ? null : Number(row.avgRir),
      })),
    });
  }

  it("같은 source facts의 삽입 순서를 바꿔도 API 응답 바이트가 동일하다", async () => {
    await seed([0, 1, 2]);
    const forward = JSON.stringify(await e1rmResponse());
    await resetUserData(prisma, USER_ID);
    await seed([2, 1, 0]);
    const reversed = JSON.stringify(await e1rmResponse());
    expect(reversed).toBe(forward);
  });

  it("affected-session 증분 재계산 결과가 전체 rebuild와 행 단위로 동일하다", async () => {
    await seed([0, 1, 2]);
    await projector.rebuildUser(USER_ID);
    await prisma.performedSet.update({
      where: { plannedSetId: "40000000-0000-4000-8000-000000000201" },
      data: { actualWeight: 92.5, actualRir: 0 },
    });
    await projector.recomputeSession(USER_ID, SESSION_IDS[0]);
    const incremental = await derivedRows();
    await prisma.estimated1rm.deleteMany({ where: { userId: USER_ID } });
    await prisma.muscleWeeklyLoad.deleteMany({ where: { userId: USER_ID } });
    await projector.rebuildUser(USER_ID);
    expect(await derivedRows()).toBe(incremental);
  });

  it("같은 사용자의 동시 rebuild를 직렬화해 유일 키 충돌 없이 수렴한다", async () => {
    await seed([0, 1, 2]);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION afc_test_delay_muscle_load_insert()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER afc_test_delay_muscle_load_insert
      BEFORE INSERT ON muscle_weekly_load
      FOR EACH ROW EXECUTE FUNCTION afc_test_delay_muscle_load_insert()
    `);

    try {
      await expect(
        Promise.all([projector.rebuildUser(USER_ID), projector.rebuildUser(USER_ID)]),
      ).resolves.toEqual([undefined, undefined]);
      expect(await prisma.muscleWeeklyLoad.count({ where: { userId: USER_ID } })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS afc_test_delay_muscle_load_insert ON muscle_weekly_load",
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS afc_test_delay_muscle_load_insert()");
    }
  });
});
