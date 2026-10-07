/**
 * BUG-10 R — `POST /sessions/:id/complete` consumes the same shared UTC fact-write window as the sync
 * writers (R0 reproduced the defects at a74aa81: investigations/rest-complete-r0-a74aa81).
 *
 * | date class | scheduled/in_progress            | completed                                   |
 * | today      | first completion (unchanged)     | re-completion recomputes (unchanged, R3)    |
 * | previous   | first completion allowed (R4)    | no-op 200: no write, stored projection (R2) |
 * | older      | 409, nothing written (R1, D-43)  | no-op 200 (R2)                              |
 * | future     | 409, nothing written             | no-op 200 (abnormal state, never "fixed")   |
 *
 * The no-op is proven with xmin on every owned row, new-session count 0 and delegating spies on
 * recompute, the projector and lazy materialization — a 200 alone is never evidence.
 * Guarded requests are sent at the suite's fixed today; only the UTC-midnight case moves the clock.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AggregationProjector } from "../src/analytics/aggregation.projector";
import { devUserId } from "../src/auth/dev-user";
import { TEST_TODAY_ENV, isoDate, utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { SessionsService } from "../src/sessions/sessions.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER = devUserId();
const BENCH = "e_bench_press";
const SQUAT = "e_back_squat";
const DAY_MS = 86_400_000;
const COMPLETE = "/sessions/{sessionId}/complete";

type Row = Record<string, unknown>;

describe("BUG-10 R — REST complete honors the shared UTC fact-write window", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recompute: jest.SpyInstance;
  let projectorSession: jest.SpyInstance;
  let projectorRebuild: jest.SpyInstance;
  let materialize: jest.SpyInstance;
  let ensureWindow: jest.SpyInstance;
  const suiteToday = process.env[TEST_TODAY_ENV];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const sessions = app.get(SessionsService);
    const projector = app.get(AggregationProjector);
    const programs = app.get(ProgramsService);
    // Delegating spies (jest.spyOn calls through): only the calls are recorded.
    recompute = jest.spyOn(sessions as unknown as { recompute: () => unknown }, "recompute");
    projectorSession = jest.spyOn(projector, "recomputeSession");
    projectorRebuild = jest.spyOn(projector, "rebuildUser");
    materialize = jest.spyOn(programs, "materializeWeekInTransaction");
    ensureWindow = jest.spyOn(programs, "ensureCurrentWindow");
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, USER));
  afterEach(() => {
    process.env[TEST_TODAY_ENV] = suiteToday;
  });
  afterAll(async () => {
    process.env[TEST_TODAY_ENV] = suiteToday;
    jest.restoreAllMocks();
    try {
      if (prisma) await resetUserData(prisma, USER);
    } finally {
      await app?.close();
    }
  });

  const dayAt = (offset: number) => new Date(utcToday().getTime() + offset * DAY_MS);
  const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  async function program() {
    // Empty template: nothing is materialized lazily, the fixture rows are the whole state.
    return prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: dayAt(-14),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [],
      },
    });
  }

  async function session(
    programId: string,
    date: Date,
    status: "scheduled" | "in_progress" | "completed",
    performed: Readonly<Record<string, readonly number[]>> = {},
    exercises: string[] = [BENCH],
    recommendation: { weight: number; reps: number } = { weight: 60, reps: 10 },
  ) {
    const row = await prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: date,
        focus: "upper",
        status,
        ...(status === "completed"
          ? {
              completedAt: new Date(`${isoDate(date)}T11:00:00.000Z`),
              sessionFeedback: { difficulty: "moderate" },
            }
          : {}),
      },
    });
    for (const [orderIndex, exerciseId] of exercises.entries())
      await prisma.plannedSet.createMany({
        data: [1, 2, 3].map((setNo) => ({
          sessionId: row.id,
          exerciseId,
          setNo,
          orderIndex,
          targetRepsLow: 6,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 120,
          recommendedWeight: recommendation.weight,
          recommendedReps: recommendation.reps,
          reasonCode: "ADD_ONE_REP",
          confidence: 0.85,
          rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        })),
      });
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId: row.id },
      orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    });
    for (const [exerciseId, sets] of Object.entries(performed))
      for (const setNo of sets) {
        const target = planned.find((p) => p.exerciseId === exerciseId && p.setNo === setNo)!;
        const performedAt = new Date(`${isoDate(date)}T10:0${setNo}:00.000Z`);
        await prisma.performedSet.create({
          data: {
            plannedSetId: target.id,
            clientId: randomUUID(),
            completed: true,
            performedAt,
            updatedAt: performedAt,
            actualWeight: 60,
            actualReps: 10,
            actualRir: 2,
          },
        });
      }
    return { id: row.id, planned };
  }

  /** All owned rows with xmin: any write — even of identical values — changes the snapshot. */
  async function snapshot(programId: string) {
    const programs = await prisma.$queryRaw<Row[]>`
      SELECT id::text, xmin::text, status::text, updated_at FROM programs WHERE id = ${programId}::uuid`;
    const sessions = await prisma.$queryRaw<Row[]>`
      SELECT id::text, xmin::text, scheduled_date, status::text, completed_at, session_feedback
      FROM workout_sessions WHERE program_id = ${programId}::uuid ORDER BY scheduled_date, id`;
    const planned = await prisma.$queryRaw<Row[]>`
      SELECT p.id::text, p.xmin::text, p.recommended_weight, p.recommended_reps, p.reason_code,
             p.confidence, p.rules_version
      FROM planned_sets p JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY p.id`;
    const performed = await prisma.$queryRaw<Row[]>`
      SELECT f.id::text, f.xmin::text, f.actual_weight, f.actual_reps, f.performed_at, f.updated_at
      FROM performed_sets f JOIN planned_sets p ON p.id = f.planned_set_id
      JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY f.id`;
    const e1rm = await prisma.$queryRaw<Row[]>`
      SELECT exercise_id, session_id::text, xmin::text, e1rm FROM estimated_1rm
      WHERE user_id = ${USER}::uuid ORDER BY exercise_id, session_id`;
    const muscle = await prisma.$queryRaw<Row[]>`
      SELECT week_start, muscle, xmin::text, hard_sets, volume_load FROM muscle_weekly_load
      WHERE user_id = ${USER}::uuid ORDER BY week_start, muscle`;
    return JSON.parse(
      JSON.stringify(
        { programs, sessions, planned, performed, e1rm, muscle },
        (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      ),
    ) as Record<string, Row[]>;
  }

  function clearSpies() {
    for (const spy of [recompute, projectorSession, projectorRebuild, materialize, ensureWindow])
      spy.mockClear();
  }
  function expectNoDomainWork() {
    expect(recompute).not.toHaveBeenCalled();
    expect(projectorSession).not.toHaveBeenCalled();
    expect(projectorRebuild).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(ensureWindow).not.toHaveBeenCalled();
  }
  const post = (id: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`/v1/sessions/${id}/complete`).send(body);

  async function dashboardCounters() {
    const response = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
    return {
      streak: response.body.streak_days as number,
      rate: response.body.weekly_completion_rate,
    };
  }

  describe("R1 older/future scheduled — a new completion is refused with 409 and nothing is written", () => {
    it.each([
      ["older, logged but never finished", -3, { [BENCH]: [1, 2] }],
      ["older, nothing logged (would invent a workout day)", -2, {}],
      ["in the future", 1, {}],
    ] as const)("%s", async (_label, offset, performed) => {
      const p = await program();
      const target = await session(p.id, dayAt(offset), "scheduled", performed);
      await session(p.id, dayAt(-1), "completed", { [BENCH]: [1] });
      const counters = await dashboardCounters();
      const before = await snapshot(p.id);
      clearSpies();
      const response = await post(target.id, { difficulty: "moderate", pain: 3 }).expect(409);
      expectMatchesContract("post", COMPLETE, 409, response.body);
      expect(await snapshot(p.id)).toEqual(before);
      expectNoDomainWork();
      expect(await dashboardCounters()).toEqual(counters);
    });

    it("in_progress is refused the same way", async () => {
      const p = await program();
      const target = await session(p.id, dayAt(-2), "in_progress", { [BENCH]: [1] });
      const before = await snapshot(p.id);
      clearSpies();
      await post(target.id, {}).expect(409);
      expect(await snapshot(p.id)).toEqual(before);
      expectNoDomainWork();
    });
  });

  describe("R2 past/future completed re-request — 200, nothing written, stored projection only", () => {
    it.each([
      ["previous", -1],
      ["older", -4],
      ["future (abnormal)", 2],
    ] as const)(
      "%s completed: no-op with a projection of the stored next target",
      async (_l, offset) => {
        const p = await program();
        const source = await session(p.id, dayAt(offset), "completed", { [BENCH]: [1, 2] });
        // Stored next target for BENCH (a later scheduled session); nothing stored for anything else.
        const next = await session(p.id, dayAt(offset + 3), "scheduled", {}, [BENCH], {
          weight: 62.5,
          reps: 11,
        });
        await app.get(AggregationProjector).rebuildUser(USER);
        const sessionsBefore = await prisma.workoutSession.count({ where: { programId: p.id } });
        const before = await snapshot(p.id);
        clearSpies();
        const response = await post(source.id, {
          difficulty: "hard",
          pump: "high",
          pain: 4,
        }).expect(200);
        expectMatchesContract("post", COMPLETE, 200, response.body);
        expect(await snapshot(p.id)).toEqual(before);
        expect(await prisma.workoutSession.count({ where: { programId: p.id } })).toBe(
          sessionsBefore,
        );
        expectNoDomainWork();
        expect(response.body.session).toMatchObject({ id: source.id, status: "completed" });
        expect(response.body.next_recommendations).toHaveLength(1);
        expect(response.body.next_recommendations[0]).toMatchObject({
          exercise_id: BENCH,
          recommendation: expect.objectContaining({ weight: 62.5, reps_low: 11 }),
        });
        expect(next.planned).toHaveLength(3);
      },
    );

    it("only exercises with a stored target are projected; the rest are simply absent", async () => {
      const p = await program();
      const source = await session(p.id, dayAt(-1), "completed", { [BENCH]: [1], [SQUAT]: [1] }, [
        BENCH,
        SQUAT,
      ]);
      await session(p.id, dayAt(2), "scheduled", {}, [BENCH], { weight: 62.5, reps: 11 });
      const before = await snapshot(p.id);
      clearSpies();
      const response = await post(source.id, {}).expect(200);
      expect(await snapshot(p.id)).toEqual(before);
      expectNoDomainWork();
      expect(
        (response.body.next_recommendations as { exercise_id: string }[]).map((r) => r.exercise_id),
      ).toEqual([BENCH]);
    });

    it("no stored target at all → [] and still nothing written", async () => {
      const p = await program();
      const source = await session(p.id, dayAt(-2), "completed", { [BENCH]: [1, 2] });
      // A later BENCH session exists but is already completed: no pending stored target.
      await session(p.id, dayAt(-1), "completed", { [BENCH]: [1] });
      const sessionsBefore = await prisma.workoutSession.count({ where: { programId: p.id } });
      const before = await snapshot(p.id);
      clearSpies();
      const response = await post(source.id, { difficulty: "easy" }).expect(200);
      expectMatchesContract("post", COMPLETE, 200, response.body);
      expect(response.body.next_recommendations).toEqual([]);
      expect(await snapshot(p.id)).toEqual(before);
      expect(await prisma.workoutSession.count({ where: { programId: p.id } })).toBe(
        sessionsBefore,
      );
      expectNoDomainWork();
    });
  });

  describe("R3 today — the existing completion and re-completion are unchanged (reverse)", () => {
    it("first completion then a feedback re-request both recompute for every performed exercise", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "scheduled", { [BENCH]: [1, 2], [SQUAT]: [1] }, [
        BENCH,
        SQUAT,
      ]);
      await session(p.id, dayAt(3), "scheduled", {}, [BENCH, SQUAT]);
      clearSpies();
      const first = await post(today.id, {}).expect(200);
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(projectorSession).toHaveBeenCalledTimes(1);
      expect(
        (first.body.next_recommendations as { exercise_id: string }[])
          .map((r) => r.exercise_id)
          .sort(),
      ).toEqual([SQUAT, BENCH].sort());
      clearSpies();
      const again = await post(today.id, { difficulty: "hard" }).expect(200);
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(again.body.session.status).toBe("completed");
      const stored = await prisma.workoutSession.findUniqueOrThrow({ where: { id: today.id } });
      expect(stored.sessionFeedback).toMatchObject({ difficulty: "hard" });
    });
  });

  describe("R4 previous scheduled — the first completion is still allowed", () => {
    it("yesterday's unfinished session completes and recomputes", async () => {
      const p = await program();
      const yesterday = await session(p.id, dayAt(-1), "scheduled", { [BENCH]: [1, 2] });
      await session(p.id, dayAt(3), "scheduled");
      clearSpies();
      const response = await post(yesterday.id, {}).expect(200);
      expect(response.body.session.status).toBe("completed");
      expect(recompute).toHaveBeenCalledTimes(1);
    });

    it("KST 08:30 → 09:30: sets logged before UTC midnight, finished after it", async () => {
      const D = "2026-09-17";
      process.env[TEST_TODAY_ENV] = D;
      const p = await program();
      const workout = await session(p.id, dateOf(D), "scheduled");
      const mutation: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: workout.planned[0].id,
        op: "upsert",
        updated_at: `${D}T23:30:00.000Z`,
        payload: { actual_weight: 60, actual_reps: 10, actual_rir: 2, completed: true },
      };
      const synced = await request(app.getHttpServer())
        .post("/v1/sync")
        .send({ mutations: [mutation] })
        .expect(200);
      expect(synced.body.applied).toContain(mutation.client_id);
      process.env[TEST_TODAY_ENV] = "2026-09-18"; // UTC midnight = KST 09:00
      const response = await post(workout.id, { difficulty: "moderate" }).expect(200);
      expect(response.body.session.status).toBe("completed");
      process.env[TEST_TODAY_ENV] = "2026-09-19"; // one more midnight: older
      const late = await session(p.id, dateOf("2026-09-17"), "scheduled");
      await post(late.id, {}).expect(409);
    });
  });
});
