/**
 * BUG-10 D — the sync fact writers (performed_set and session completion) enforce the shared UTC
 * fact-write window (`classifySessionFactWriteDate`, A: UTC today + the previous UTC day).
 *
 * These guard tests deliberately do NOT use any clock-alignment helper: the guarded write is sent at
 * the suite's fixed today against sessions dated relative to it, so the rejection path itself is
 * exercised. Only the UTC-midnight scenarios move the server clock, because crossing midnight is
 * what they test (`moveServerToday`, restored after each test).
 *
 * "No write" is proven with PostgreSQL `xmin` (a same-value rewrite still changes it) plus delegating
 * spies on the recompute/projector entry points — never with the HTTP status alone.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AggregationProjector } from "../src/analytics/aggregation.projector";
import { devUserId } from "../src/auth/dev-user";
import { TEST_TODAY_ENV, isoDate, utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import { SessionsService } from "../src/sessions/sessions.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";

const USER = devUserId();
const BENCH = "e_bench_press";
const PLANK = "e_plank";
const DAY_MS = 86_400_000;

type Wire = {
  applied: string[];
  conflicts: { client_id: string; entity_id: string; reason: string }[];
  changes: {
    entity: string;
    entity_id: string;
    op: string;
    data: Record<string, unknown> | null;
  }[];
  next_cursor: string;
};
type Row = Record<string, unknown>;

describe("BUG-10 D — sync fact writers honor the shared UTC fact-write window", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionsService;
  let projector: AggregationProjector;
  let recomputeSpy: jest.SpyInstance;
  let projectorSpy: jest.SpyInstance;
  let rebuildSpy: jest.SpyInstance;
  const suiteToday = process.env[TEST_TODAY_ENV];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
    projector = app.get(AggregationProjector);
    // Delegating spies: the real implementation always runs; only the calls are recorded.
    recomputeSpy = jest.spyOn(sessions, "recomputeAfterSync");
    projectorSpy = jest.spyOn(projector, "recomputeSession");
    rebuildSpy = jest.spyOn(projector, "rebuildUser");
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

  /** The UTC-midnight scenarios own the clock; nothing else in this file moves it. */
  function moveServerToday(date: string): void {
    process.env[TEST_TODAY_ENV] = date;
  }
  const dayAt = (offset: number) => new Date(utcToday().getTime() + offset * DAY_MS);
  const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  let tick = 0;
  /** Client clock for mutation updated_at: strictly increasing, on the given UTC day/time. */
  const at = (day: Date, hhmm = "10:00") =>
    new Date(Date.parse(`${isoDate(day)}T${hhmm}:00.000Z`) + tick++ * 1000).toISOString();

  async function program() {
    // Empty template: no lazy materialization, so dashboard reads never add rows to the fixture.
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
    performedSets: number[] = [],
    exercise = BENCH,
  ) {
    const row = await prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: date,
        focus: "upper",
        status,
        ...(status === "completed"
          ? { completedAt: new Date(`${isoDate(date)}T11:00:00.000Z`) }
          : {}),
      },
    });
    const time = exercise === PLANK;
    await prisma.plannedSet.createMany({
      data: [1, 2, 3].map((setNo) => ({
        sessionId: row.id,
        exerciseId: exercise,
        setNo,
        orderIndex: 0,
        ...(time
          ? { targetTimeLowSec: 30, targetTimeHighSec: 60 }
          : { targetRepsLow: 6, targetRepsHigh: 12, recommendedWeight: 60, recommendedReps: 10 }),
        targetRir: 2,
        restSec: 120,
        reasonCode: "ADD_ONE_REP",
        confidence: 0.85,
        rulesVersion: "2026.08.1",
        loadSemantics: "external_load",
      })),
    });
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId: row.id },
      orderBy: { setNo: "asc" },
    });
    for (const setNo of performedSets) {
      const performedAt = new Date(`${isoDate(date)}T10:0${setNo}:00.000Z`);
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned[setNo - 1].id,
          clientId: randomUUID(),
          completed: true,
          performedAt,
          updatedAt: performedAt,
          ...(time ? { actualTimeSec: 30 } : { actualWeight: 60, actualReps: 10, actualRir: 2 }),
        },
      });
    }
    return { id: row.id, date, planned };
  }

  /** older completed source with a later scheduled target that holds a known stored prescription. */
  async function history(sourceOffset: number) {
    const p = await program();
    const source = await session(p.id, dayAt(sourceOffset), "completed", [1, 2]);
    const target = await session(p.id, dayAt(3), "scheduled");
    await prisma.plannedSet.updateMany({
      where: { sessionId: target.id },
      data: { recommendedWeight: 62.5, recommendedReps: 12, reasonCode: "ADD_ONE_REP" },
    });
    await projector.rebuildUser(USER);
    return { program: p, source, target };
  }

  async function sync(mutations: MutationDto[]): Promise<Wire> {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations })
      .expect(200);
    return response.body as Wire;
  }
  const perf = (plannedSetId: string, updatedAt: string, weight = 60, reps = 10): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: plannedSetId,
    op: "upsert",
    updated_at: updatedAt,
    payload: {
      actual_weight: weight,
      actual_reps: reps,
      actual_rir: 2,
      actual_time_sec: null,
      pain_score: null,
      completed: true,
    },
  });
  const timed = (plannedSetId: string, updatedAt: string, seconds: number): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: plannedSetId,
    op: "upsert",
    updated_at: updatedAt,
    payload: {
      actual_weight: null,
      actual_reps: null,
      actual_time_sec: seconds,
      pain_score: null,
      completed: true,
    },
  });
  const del = (plannedSetId: string, updatedAt: string): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: plannedSetId,
    op: "delete",
    updated_at: updatedAt,
    payload: {},
  });
  const complete = (sessionId: string, updatedAt: string, extra: Row = {}): MutationDto => ({
    client_id: randomUUID(),
    entity: "session",
    entity_id: sessionId,
    op: "upsert",
    updated_at: updatedAt,
    payload: { status: "completed", ...extra },
  });

  /** Every fact/derived row of the owner, with xmin so even a same-value rewrite is visible. */
  async function snapshot(programId: string) {
    const sessionsRows = await prisma.$queryRaw<Row[]>`
      SELECT id::text, xmin::text, scheduled_date, status::text, completed_at, session_feedback
      FROM workout_sessions WHERE program_id = ${programId}::uuid ORDER BY scheduled_date, id`;
    const planned = await prisma.$queryRaw<Row[]>`
      SELECT p.id::text, p.xmin::text, p.recommended_weight, p.recommended_reps, p.target_reps_low,
             p.target_reps_high, p.reason_code, p.confidence, p.rules_version
      FROM planned_sets p JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY p.id`;
    const performed = await prisma.$queryRaw<Row[]>`
      SELECT f.id::text, f.xmin::text, f.planned_set_id::text, f.client_id::text, f.completed,
             f.actual_weight, f.actual_reps, f.actual_rir, f.actual_time_sec, f.performed_at, f.updated_at
      FROM performed_sets f JOIN planned_sets p ON p.id = f.planned_set_id
      JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY f.id`;
    const e1rm = await prisma.$queryRaw<Row[]>`
      SELECT exercise_id, session_id::text, xmin::text, e1rm, computed_at
      FROM estimated_1rm WHERE user_id = ${USER}::uuid ORDER BY exercise_id, session_id`;
    const muscle = await prisma.$queryRaw<Row[]>`
      SELECT week_start, muscle, xmin::text, hard_sets, volume_load, avg_rir
      FROM muscle_weekly_load WHERE user_id = ${USER}::uuid ORDER BY week_start, muscle`;
    return JSON.parse(
      JSON.stringify({ sessionsRows, planned, performed, e1rm, muscle }, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) as Record<string, Row[]>;
  }

  async function dashboardCounters() {
    const response = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
    return {
      streak: response.body.streak_days as number,
      rate: response.body.weekly_completion_rate as number,
    };
  }

  function clearSpies() {
    recomputeSpy.mockClear();
    projectorSpy.mockClear();
    rebuildSpy.mockClear();
  }

  /** The envelope rejects exactly this mutation, stores a conflict receipt and writes nothing. */
  async function expectRejected(
    programId: string,
    mutations: MutationDto[],
    rejected: MutationDto[],
  ) {
    const before = await snapshot(programId);
    clearSpies();
    const result = await sync(mutations);
    for (const mutation of rejected) {
      expect(result.applied).not.toContain(mutation.client_id);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ client_id: mutation.client_id, entity_id: mutation.entity_id }),
      );
      const receipt = await prisma.syncMutation.findUniqueOrThrow({
        where: { id: mutation.client_id },
      });
      expect(receipt.status).toBe("conflict");
    }
    expect(await snapshot(programId)).toEqual(before);
    expect(recomputeSpy).not.toHaveBeenCalled();
    expect(projectorSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    return result;
  }

  describe("D1 older completed session — new performed facts are rejected", () => {
    it.each([
      ["insert into the unperformed set", "insert"],
      ["modify an existing set", "modify"],
      ["delete an existing set", "delete"],
    ] as const)("%s is rejected with an envelope conflict and no write", async (_label, op) => {
      const { program: p, source } = await history(-2);
      const mutation =
        op === "insert"
          ? perf(source.planned[2].id, at(dayAt(0)), 60, 12)
          : op === "modify"
            ? perf(source.planned[0].id, at(dayAt(0)), 80, 12)
            : del(source.planned[0].id, at(dayAt(0)));
      const result = await expectRejected(p.id, [mutation], [mutation]);
      expect(result.conflicts.find((c) => c.client_id === mutation.client_id)?.reason).toBe(
        "conflict",
      );
    });

    it("a far older session and a future client clock are rejected the same way", async () => {
      const { program: p, source } = await history(-9);
      // A client cannot disguise an old write as new with its own clock.
      const mutation = perf(source.planned[0].id, "2030-01-01T00:00:00.000Z", 80, 12);
      await expectRejected(p.id, [mutation], [mutation]);
    });
  });

  describe("D2 older completed session — completion/feedback changes are rejected", () => {
    it("re-completion with new feedback keeps status, completedAt, feedback and counters", async () => {
      const { program: p, source } = await history(-2);
      const counters = await dashboardCounters();
      const mutation = complete(source.id, at(dayAt(0)), { difficulty: "hard", pain: 4 });
      await expectRejected(p.id, [mutation], [mutation]);
      expect(await dashboardCounters()).toEqual(counters);
    });

    it("a rejected performed write never lets its companion completion through", async () => {
      const { program: p, source } = await history(-2);
      const fact = perf(source.planned[2].id, at(dayAt(0)), 60, 12);
      const done = complete(source.id, at(dayAt(0)), { difficulty: "easy" });
      await expectRejected(p.id, [fact, done], [fact, done]);
    });
  });

  describe("D3 older scheduled/in_progress session — no after-the-fact completion", () => {
    it.each([
      ["performed only", "facts"],
      ["completion only", "complete"],
      ["performed then completion", "batch"],
      ["completion then performed", "reversed"],
    ] as const)("%s is rejected; no fact, no completed transition", async (_label, mode) => {
      const p = await program();
      const missed = await session(p.id, dayAt(-3), "scheduled");
      await session(p.id, dayAt(-1), "completed", [1, 2]);
      const counters = await dashboardCounters();
      const fact = perf(missed.planned[0].id, at(dayAt(0)));
      const done = complete(missed.id, at(dayAt(0)));
      const mutations =
        mode === "facts"
          ? [fact]
          : mode === "complete"
            ? [done]
            : mode === "batch"
              ? [fact, done]
              : [done, fact];
      await expectRejected(p.id, mutations, mutations);
      expect(await dashboardCounters()).toEqual(counters);
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: missed.id } })).status,
      ).toBe("scheduled");
    });

    it("an older session that was logged but never finished cannot be finished later", async () => {
      const p = await program();
      const logged = await session(p.id, dayAt(-4), "scheduled", [1, 2]);
      const done = complete(logged.id, at(dayAt(0)), { difficulty: "moderate" });
      await expectRejected(p.id, [done], [done]);
    });

    it("in_progress is treated like scheduled", async () => {
      const p = await program();
      const started = await session(p.id, dayAt(-2), "in_progress", [1]);
      const fact = perf(started.planned[1].id, at(dayAt(0)));
      const done = complete(started.id, at(dayAt(0)));
      await expectRejected(p.id, [fact, done], [fact, done]);
    });
  });

  describe("D4 window boundaries on the server's UTC today", () => {
    it.each([
      [0, true],
      [-1, true],
      [-2, false],
      [1, false],
    ] as const)("a completed session at offset %i accepts new facts: %s", async (offset, ok) => {
      const p = await program();
      const target = await session(p.id, dayAt(offset), "completed", [1]);
      const fact = perf(target.planned[1].id, at(dayAt(0)));
      if (!ok) {
        await expectRejected(p.id, [fact], [fact]);
        return;
      }
      const result = await sync([fact]);
      expect(result.applied).toContain(fact.client_id);
      expect(result.conflicts).toEqual([]);
      expect(
        await prisma.performedSet.count({ where: { plannedSetId: target.planned[1].id } }),
      ).toBe(1);
    });

    it("a future scheduled session accepts neither facts nor completion", async () => {
      const p = await program();
      const upcoming = await session(p.id, dayAt(1), "scheduled");
      const fact = perf(upcoming.planned[0].id, at(dayAt(0)));
      const done = complete(upcoming.id, at(dayAt(0)));
      await expectRejected(p.id, [fact, done], [fact, done]);
    });

    it("owner, LWW and client_id protections still apply inside the window", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "scheduled");
      const first = perf(today.planned[0].id, at(dayAt(0), "11:00"), 60, 10);
      expect((await sync([first])).applied).toContain(first.client_id);
      // Older client clock than the stored fact → stale_update, not a silent overwrite.
      const stale = perf(today.planned[0].id, at(dayAt(0), "09:00"), 90, 10);
      const staleResult = await sync([stale]);
      expect(staleResult.conflicts).toContainEqual(
        expect.objectContaining({ client_id: stale.client_id, reason: "stale_update" }),
      );
      // Same client_id with a different payload → client_id_mismatch.
      const reused = { ...first, payload: { ...first.payload, actual_reps: 11 } };
      const reusedResult = await sync([reused]);
      expect(reusedResult.conflicts).toContainEqual(
        expect.objectContaining({ client_id: first.client_id, reason: "client_id_mismatch" }),
      );
      // Another owner's planned set is invisible (not_found), never written.
      const foreign = perf(randomUUID(), at(dayAt(0)));
      const foreignResult = await sync([foreign]);
      expect(foreignResult.conflicts).toContainEqual(
        expect.objectContaining({ client_id: foreign.client_id, reason: "not_found" }),
      );
    });
  });

  describe("D5 today — every normal edit keeps working (reverse)", () => {
    it("today scheduled: insert, modify, delete, partial completion", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "scheduled");
      const insert = perf(today.planned[0].id, at(dayAt(0)));
      const modify = perf(today.planned[0].id, at(dayAt(0)), 62.5, 9);
      const insert2 = perf(today.planned[1].id, at(dayAt(0)));
      const remove = del(today.planned[1].id, at(dayAt(0)));
      for (const mutation of [insert, modify, insert2, remove]) {
        const result = await sync([mutation]);
        expect(result.applied).toContain(mutation.client_id);
        expect(result.conflicts).toEqual([]);
      }
      const facts = await prisma.performedSet.findMany({
        where: { plannedSet: { sessionId: today.id } },
      });
      expect(facts).toHaveLength(1);
      expect(Number(facts[0].actualWeight)).toBe(62.5);
      const partial = [perf(today.planned[2].id, at(dayAt(0))), complete(today.id, at(dayAt(0)))];
      const result = await sync(partial);
      expect(result.applied).toEqual(expect.arrayContaining(partial.map((m) => m.client_id)));
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: today.id } })).status,
      ).toBe("completed");
    });

    it("today scheduled with no facts can still be finished empty", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "scheduled");
      const done = complete(today.id, at(dayAt(0)));
      expect((await sync([done])).applied).toContain(done.client_id);
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: today.id } })).status,
      ).toBe("completed");
    });

    it("today completed: modify, add the unperformed set, uncheck, re-finish all recompute", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      const next = await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      clearSpies();
      // 60x12 + 60x10 → not every set at the top → add one rep at the same load.
      const modify = perf(today.planned[0].id, at(dayAt(0)), 60, 12);
      expect((await sync([modify])).applied).toContain(modify.client_id);
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(projectorSpy).toHaveBeenCalledTimes(1);
      const afterModify = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: next.id, setNo: 1 },
      });
      expect([Number(afterModify.recommendedWeight), afterModify.recommendedReps]).toEqual([
        60, 11,
      ]);
      // Every set at the top of 6–12 → one 2.5 kg step up, reps reset to the low end.
      const top2 = perf(today.planned[1].id, at(dayAt(0)), 60, 12);
      const top3 = perf(today.planned[2].id, at(dayAt(0)), 60, 12);
      expect((await sync([top2, top3])).applied).toEqual(
        expect.arrayContaining([top2.client_id, top3.client_id]),
      );
      const afterTop = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: next.id, setNo: 1 },
      });
      expect([Number(afterTop.recommendedWeight), afterTop.recommendedReps]).toEqual([62.5, 6]);
      const uncheck = del(today.planned[2].id, at(dayAt(0)));
      expect((await sync([uncheck])).applied).toContain(uncheck.client_id);
      const refinish = complete(today.id, at(dayAt(0)), { difficulty: "hard" });
      expect((await sync([refinish])).applied).toContain(refinish.client_id);
      const stored = await prisma.workoutSession.findUniqueOrThrow({ where: { id: today.id } });
      expect(stored.status).toBe("completed");
      expect(stored.completedAt?.toISOString()).toBe(`${isoDate(dayAt(0))}T11:00:00.000Z`);
      expect(stored.sessionFeedback).toMatchObject({ difficulty: "hard" });
    });

    it("today completed time exercise: the time value can still be corrected", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1], PLANK);
      const fix = timed(today.planned[0].id, at(dayAt(0)), 45);
      expect((await sync([fix])).applied).toContain(fix.client_id);
      const fact = await prisma.performedSet.findFirstOrThrow({
        where: { plannedSetId: today.planned[0].id },
      });
      expect(fact.actualTimeSec).toBe(45);
    });
  });

  describe("D6 UTC midnight — KST 08:30 start → 09:30 finish", () => {
    it("online: sets before midnight, more sets/edits/finish after midnight all succeed", async () => {
      const D = "2026-09-17";
      const D1 = "2026-09-18";
      const D2 = "2026-09-19";
      moveServerToday(D);
      const p = await program();
      const workout = await session(p.id, dateOf(D), "scheduled");
      await session(p.id, dateOf("2026-09-21"), "scheduled");
      const s1 = perf(workout.planned[0].id, at(dateOf(D), "23:30"));
      expect((await sync([s1])).applied).toContain(s1.client_id);

      moveServerToday(D1); // UTC midnight passed: KST 09:00
      const s2 = perf(workout.planned[1].id, at(dateOf(D1), "00:10"));
      const fix1 = perf(workout.planned[0].id, at(dateOf(D1), "00:15"), 62.5, 10);
      const done = complete(workout.id, at(dateOf(D1), "00:30"), { difficulty: "moderate" });
      const batch = await sync([s2, fix1, done]);
      expect(batch.conflicts).toEqual([]);
      expect(batch.applied).toEqual(
        expect.arrayContaining([s2.client_id, fix1.client_id, done.client_id]),
      );
      // After finishing, the previous-day window still allows actual edits and a re-finish.
      const fix2 = perf(workout.planned[1].id, at(dateOf(D1), "00:40"), 62.5, 11);
      const refinish = complete(workout.id, at(dateOf(D1), "00:45"), { difficulty: "hard" });
      expect((await sync([fix2])).applied).toContain(fix2.client_id);
      expect((await sync([refinish])).applied).toContain(refinish.client_id);
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: workout.id } })).status,
      ).toBe("completed");

      moveServerToday(D2); // one more midnight: the session is now older
      const late = perf(workout.planned[2].id, at(dateOf(D2), "00:10"));
      const lateDone = complete(workout.id, at(dateOf(D2), "00:20"), { difficulty: "easy" });
      await expectRejected(p.id, [late, lateDone], [late, lateDone]);
    });

    it("offline-first: everything logged before midnight is first sent after it and succeeds", async () => {
      const D = "2026-09-17";
      const D1 = "2026-09-18";
      moveServerToday(D);
      const p = await program();
      const workout = await session(p.id, dateOf(D), "scheduled");
      const outbox = [
        perf(workout.planned[0].id, at(dateOf(D), "23:30")),
        perf(workout.planned[1].id, at(dateOf(D), "23:40")),
        complete(workout.id, at(dateOf(D), "23:55")),
      ];
      moveServerToday(D1); // no server request at all before midnight
      const result = await sync(outbox);
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toEqual(expect.arrayContaining(outbox.map((m) => m.client_id)));
      expect(
        (await prisma.workoutSession.findUniqueOrThrow({ where: { id: workout.id } })).status,
      ).toBe("completed");
    });

    it("month boundary: 09-30 is previous on 10-01, 09-29 is older", async () => {
      moveServerToday("2026-10-01");
      const p = await program();
      const previous = await session(p.id, dateOf("2026-09-30"), "completed", [1]);
      const older = await session(p.id, dateOf("2026-09-29"), "completed", [1]);
      const ok = perf(previous.planned[1].id, at(dateOf("2026-10-01")));
      expect((await sync([ok])).applied).toContain(ok.client_id);
      const blocked = perf(older.planned[1].id, at(dateOf("2026-10-01")));
      await expectRejected(p.id, [blocked], [blocked]);
    });
  });

  describe("D7 routine permissions are unchanged (actual ≠ routine)", () => {
    it("previous completed: routine edits stay blocked (REST 409, sync conflict) while facts are allowed", async () => {
      const p = await program();
      const yesterday = await session(p.id, dayAt(-1), "completed", [1]);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${yesterday.id}/exercises`)
        .send({ exercise_id: "e_face_pull" })
        .expect(409);
      const routine: MutationDto = {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: yesterday.id,
        op: "upsert",
        updated_at: at(dayAt(0)),
        payload: { exercise_ids: [BENCH] },
      };
      const routineResult = await sync([routine]);
      expect(routineResult.conflicts).toContainEqual(
        expect.objectContaining({ client_id: routine.client_id, reason: "conflict" }),
      );
      const fact = perf(yesterday.planned[1].id, at(dayAt(0)));
      expect((await sync([fact])).applied).toContain(fact.client_id);
    });

    it("older scheduled: the existing routine allowance is kept (facts are not)", async () => {
      const p = await program();
      const missed = await session(p.id, dayAt(-3), "scheduled");
      await request(app.getHttpServer())
        .post(`/v1/sessions/${missed.id}/exercises`)
        .send({ exercise_id: "e_face_pull" })
        .expect(200);
      // The sync routine path keeps the same allowance: the fact window never applies to routine.
      const routine: MutationDto = {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: missed.id,
        op: "upsert",
        updated_at: at(dayAt(0)),
        payload: { exercise_ids: [BENCH] },
      };
      const routineResult = await sync([routine]);
      expect(routineResult.applied).toEqual([routine.client_id]);
      expect(routineResult.conflicts).toEqual([]);
      const fact = perf(missed.planned[0].id, at(dayAt(0)));
      await expectRejected(p.id, [fact], [fact]);
    });

    it("today completed: routine edits remain allowed", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1]);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${today.id}/exercises`)
        .send({ exercise_id: "e_face_pull" })
        .expect(200);
    });
  });

  describe("append-dependency adapter maps the date rejection instead of failing", () => {
    it("a dependent performed write arriving after the window closes is a conflict, not a 500", async () => {
      const D = "2026-09-17";
      moveServerToday(D);
      const p = await program();
      const workout = await session(p.id, dateOf(D), "scheduled");
      const source = workout.planned[2];
      const parent: MutationDto = {
        client_id: randomUUID(),
        entity: "session_set",
        entity_id: workout.id,
        op: "upsert",
        updated_at: at(dateOf(D), "09:00"),
        payload: {
          exercise_id: BENCH,
          correlation_id: randomUUID(),
          source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
        },
      };
      const appended = await sync([parent]);
      expect(appended.applied).toContain(parent.client_id);

      moveServerToday("2026-09-19"); // two midnights later: older
      const dependent: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: parent.payload.correlation_id as string,
        op: "upsert",
        updated_at: at(dateOf("2026-09-19"), "09:00"),
        payload: { actual_weight: 60, actual_reps: 10, actual_rir: 2, completed: true },
        append_dependencies: { session_id: workout.id, client_ids: [parent.client_id] },
      };
      const before = await snapshot(p.id);
      const result = await sync([dependent]);
      expect(result.applied).not.toContain(dependent.client_id);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ client_id: dependent.client_id, reason: "conflict" }),
      );
      expect(await snapshot(p.id)).toEqual(before);
    });
  });
});
