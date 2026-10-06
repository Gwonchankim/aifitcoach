/**
 * BUG-10 I — an exact replay of an already-applied sync mutation is acknowledged again and does
 * nothing else, on any date (ticket I1–I3). The four receipt short-circuits are each exercised:
 *   1. applyOnce — performed_set / session / session_routine without dependencies
 *   2. recordConflict — a completion blocked by a sibling conflict whose receipt is already applied
 *   3. the append-dependency adapter — performed_set with append_dependencies
 *   4. the session_set append service
 *
 * "Nothing else" is proven, never inferred from the HTTP status: the owner's fact, target, derived
 * and receipt rows keep their values AND their xmin (a same-value rewrite changes xmin), and the
 * recompute/projector entry points are not called (delegating spies). Real new changes in the same
 * batch keep the existing recompute-once-per-session behavior (I2).
 *
 * Q10 (a), pinned as a pair: a lone replay's change row carries no `next_recommendations` (nothing
 * was recomputed), while a replay batched with a real change of the same session carries that
 * batch's result as before. Re-review trigger: when a consumer starts reading the prescription of
 * a replayed row, reconsider attaching a stored projection (option b).
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { PlannedSet } from "@prisma/client";
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
const DAY_MS = 86_400_000;
/** Columns that differ between two reads only when the row was rewritten. */
const WRITE_MARKERS = new Set(["xmin", "computed_at"]);

type Wire = {
  applied: string[];
  conflicts: { client_id: string; entity_id: string; reason: string }[];
  changes: {
    entity: string;
    entity_id: string;
    op: string;
    data: Record<string, unknown> | null;
    server_seq: string;
  }[];
  planned_set_mappings: { correlation_id: string; planned_set_id: string }[];
  next_cursor: string;
};
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

describe("BUG-10 I — an exact sync replay is an ACK with no side effects", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let projector: AggregationProjector;
  let recomputeSpy: jest.SpyInstance;
  let projectorSpy: jest.SpyInstance;
  let rebuildSpy: jest.SpyInstance;
  const suiteToday = process.env[TEST_TODAY_ENV];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    projector = app.get(AggregationProjector);
    // Delegating spies: the real implementation always runs; only the calls are recorded.
    recomputeSpy = jest.spyOn(app.get(SessionsService), "recomputeAfterSync");
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

  /** Only the "receipt outlives the window" scenario moves the clock; restored after each test. */
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

  /** Three 6–12 rep bench sets recommended at 60×10; `performedSets` are logged at 60×10 RIR 2. */
  async function session(
    programId: string,
    date: Date,
    status: "scheduled" | "completed",
    performedSets: number[] = [],
  ): Promise<{ id: string; planned: PlannedSet[] }> {
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
    await prisma.plannedSet.createMany({
      data: [1, 2, 3].map((setNo) => ({
        sessionId: row.id,
        exerciseId: BENCH,
        setNo,
        orderIndex: 0,
        targetRepsLow: 6,
        targetRepsHigh: 12,
        recommendedWeight: 60,
        recommendedReps: 10,
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
          actualWeight: 60,
          actualReps: 10,
          actualRir: 2,
        },
      });
    }
    return { id: row.id, planned };
  }

  async function sync(mutations: MutationDto[], since?: string): Promise<Wire> {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations, ...(since === undefined ? {} : { since }) })
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
  const appendSet = (sessionId: string, source: PlannedSet, updatedAt: string): MutationDto => ({
    client_id: randomUUID(),
    entity: "session_set",
    entity_id: sessionId,
    op: "upsert",
    updated_at: updatedAt,
    payload: {
      exercise_id: BENCH,
      correlation_id: randomUUID(),
      source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
    },
  });

  /** Every row the owner has, with xmin so even a same-value rewrite is visible. */
  async function snapshot(programId: string): Promise<Snapshot> {
    const sessions = await prisma.$queryRaw<Row[]>`
      SELECT id::text, xmin::text, scheduled_date, status::text, completed_at, session_feedback
      FROM workout_sessions WHERE program_id = ${programId}::uuid ORDER BY scheduled_date, id`;
    const planned = await prisma.$queryRaw<Row[]>`
      SELECT p.id::text, p.xmin::text, p.set_no, p.recommended_weight, p.recommended_reps,
             p.target_reps_low, p.target_reps_high, p.reason_code, p.confidence, p.rules_version
      FROM planned_sets p JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY p.id`;
    const performed = await prisma.$queryRaw<Row[]>`
      SELECT f.id::text, f.xmin::text, f.planned_set_id::text, f.client_id::text, f.completed,
             f.actual_weight, f.actual_reps, f.actual_rir, f.performed_at, f.updated_at
      FROM performed_sets f JOIN planned_sets p ON p.id = f.planned_set_id
      JOIN workout_sessions s ON s.id = p.session_id
      WHERE s.program_id = ${programId}::uuid ORDER BY f.id`;
    const e1rm = await prisma.$queryRaw<Row[]>`
      SELECT exercise_id, session_id::text, xmin::text, e1rm, computed_at
      FROM estimated_1rm WHERE user_id = ${USER}::uuid ORDER BY exercise_id, session_id`;
    const muscle = await prisma.$queryRaw<Row[]>`
      SELECT week_start, muscle, xmin::text, hard_sets, volume_load, avg_rir
      FROM muscle_weekly_load WHERE user_id = ${USER}::uuid ORDER BY week_start, muscle`;
    const receipts = await prisma.$queryRaw<Row[]>`
      SELECT id::text, xmin::text, server_seq, status::text, entity_type::text, entity_id,
             conflict_reason, applied_at
      FROM sync_mutations WHERE user_id = ${USER}::uuid ORDER BY server_seq`;
    return JSON.parse(
      JSON.stringify(
        { sessions, planned, performed, e1rm, muscle, receipts },
        (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      ),
    ) as Snapshot;
  }
  /** The same snapshot without write markers: what a reader sees as values. */
  function values(state: Snapshot): Snapshot {
    return Object.fromEntries(
      Object.entries(state).map(([table, rows]) => [
        table,
        rows.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => !WRITE_MARKERS.has(key))),
        ),
      ]),
    );
  }
  const withoutReceipt = (state: Snapshot, clientId: string): Snapshot => ({
    ...state,
    receipts: state.receipts.filter((row) => row.id !== clientId),
  });

  function clearSpies() {
    recomputeSpy.mockClear();
    projectorSpy.mockClear();
    rebuildSpy.mockClear();
  }
  function expectNoRecompute() {
    expect(recomputeSpy).not.toHaveBeenCalled();
    expect(projectorSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
  }
  async function targetOf(sessionId: string) {
    const row = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId, setNo: 1 } });
    return [Number(row.recommendedWeight), row.recommendedReps];
  }
  /** The change row of `mutation`'s own receipt (change rows carry server_seq, not client_id). */
  async function ownChange(result: Wire, mutation: MutationDto) {
    const receipt = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: mutation.client_id },
    });
    return result.changes.find((row) => row.server_seq === receipt.serverSeq.toString());
  }

  /**
   * Resend `mutation` three times — plain, with a cursor that already passed its receipt (a lost
   * response after a later pull), plain again — and prove each is an ACK and nothing else.
   */
  async function expectReplayIsAckOnly(programId: string, mutation: MutationDto, cursor: string) {
    const before = await snapshot(programId);
    clearSpies();
    for (const since of [undefined, cursor, undefined]) {
      const result = await sync([mutation], since);
      expect(result.applied).toEqual([mutation.client_id]);
      expect(result.conflicts).toEqual([]);
      if (since !== undefined) expect(result.changes).toEqual([]);
      else {
        // Q10 (a): nothing was recomputed, so the replay's own row carries no prescription.
        const own = await ownChange(result, mutation);
        expect(own).toBeDefined();
        expect(own?.data?.next_recommendations).toBeUndefined();
      }
    }
    const after = await snapshot(programId);
    // Values first (a changed fact/prescription), then rewrites (xmin), then calls — so a failure
    // says which of the three a replay did.
    expect(values(after)).toEqual(values(before));
    expect(after).toEqual(before);
    expectNoRecompute();
  }

  describe("I1 today's receipts (applyOnce short-circuit)", () => {
    it.each([
      ["insert of the unperformed set", "insert"],
      ["modify of a logged set", "modify"],
      ["delete (uncheck) of a logged set", "delete"],
      ["session re-completion with feedback", "session"],
    ] as const)("%s: the first send recomputes, resends only ACK", async (_label, kind) => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      const next = await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const original =
        kind === "insert"
          ? perf(today.planned[2].id, at(dayAt(0)), 60, 12)
          : kind === "modify"
            ? perf(today.planned[0].id, at(dayAt(0)), 60, 12)
            : kind === "delete"
              ? del(today.planned[1].id, at(dayAt(0)))
              : complete(today.id, at(dayAt(0)), { difficulty: "hard", pain: 3 });
      clearSpies();
      const first = await sync([original]);
      expect(first.applied).toEqual([original.client_id]);
      expect(first.conflicts).toEqual([]);
      // I2 reverse: the real change is applied and recomputes this session exactly once.
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(recomputeSpy).toHaveBeenCalledWith(USER, today.id);
      const target = await targetOf(next.id);

      await expectReplayIsAckOnly(p.id, original, first.next_cursor);
      expect(await targetOf(next.id)).toEqual(target);
    });

    it("a resend to a restarted server is still only an ACK", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const original = perf(today.planned[0].id, at(dayAt(0)), 60, 12);
      expect((await sync([original])).applied).toEqual([original.client_id]);

      // A second app instance shares only the database: no in-memory state survives a restart.
      const restarted = await createTestApp();
      try {
        const restartedProjector = restarted.get(AggregationProjector);
        const recompute = jest.spyOn(restarted.get(SessionsService), "recomputeAfterSync");
        const projectSession = jest.spyOn(restartedProjector, "recomputeSession");
        const rebuild = jest.spyOn(restartedProjector, "rebuildUser");
        const before = await snapshot(p.id);
        const response = await request(restarted.getHttpServer())
          .post("/v1/sync")
          .send({ mutations: [original] })
          .expect(200);
        expect(response.body.applied).toEqual([original.client_id]);
        expect(response.body.conflicts).toEqual([]);
        const after = await snapshot(p.id);
        expect(values(after)).toEqual(values(before));
        expect(after).toEqual(before);
        expect(recompute).not.toHaveBeenCalled();
        expect(projectSession).not.toHaveBeenCalled();
        expect(rebuild).not.toHaveBeenCalled();
      } finally {
        await restarted.close();
      }
    }, 60_000);
  });

  describe("I1 an old receipt never rewrites a newer prescription", () => {
    it("a previous-day receipt resent after a newer workout leaves the newer target alone", async () => {
      const p = await program();
      const yesterday = await session(p.id, dayAt(-1), "completed", [1, 2, 3]);
      const today = await session(p.id, dayAt(0), "scheduled");
      const next = await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      // Inside the window (previous day), so the first send is a legitimate new fact.
      const old = perf(yesterday.planned[0].id, at(dayAt(0), "08:00"), 60, 8);
      expect((await sync([old])).applied).toEqual([old.client_id]);
      // Today's workout is newer: it is the source of the next prescription.
      const workout = [
        ...today.planned.map((set) => perf(set.id, at(dayAt(0), "10:00"), 60, 12)),
        complete(today.id, at(dayAt(0), "11:00")),
      ];
      const done = await sync(workout);
      expect(done.conflicts).toEqual([]);
      const target = await targetOf(next.id);

      await expectReplayIsAckOnly(p.id, old, done.next_cursor);
      expect(await targetOf(next.id)).toEqual(target);
    });

    it("a receipt resent after its session left the window (P2) is ACKed, not re-run", async () => {
      moveServerToday("2026-09-17");
      const p = await program();
      const source = await session(p.id, dateOf("2026-09-17"), "completed", [1, 2, 3]);
      const later = await session(p.id, dateOf("2026-09-18"), "scheduled");
      const next = await session(p.id, dateOf("2026-09-21"), "scheduled");
      await projector.rebuildUser(USER);
      const original = perf(source.planned[0].id, at(dateOf("2026-09-17"), "12:00"), 60, 8);
      expect((await sync([original])).applied).toEqual([original.client_id]);

      moveServerToday("2026-09-18");
      const workout = [
        ...later.planned.map((set) => perf(set.id, at(dateOf("2026-09-18"), "10:00"), 60, 12)),
        complete(later.id, at(dateOf("2026-09-18"), "11:00")),
      ];
      const done = await sync(workout);
      expect(done.conflicts).toEqual([]);
      const target = await targetOf(next.id);

      moveServerToday("2026-09-20"); // the source session is now older than the write window
      await expectReplayIsAckOnly(p.id, original, done.next_cursor);
      expect(await targetOf(next.id)).toEqual(target);
    });
  });

  describe("I1 the other three short-circuits", () => {
    it("session_set append: the resend keeps its mapping and creates nothing", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2, 3]);
      await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const append = appendSet(today.id, today.planned[2], at(dayAt(0)));
      const correlation = append.payload.correlation_id as string;
      const first = await sync([append]);
      expect(first.applied).toEqual([append.client_id]);
      const mapping = first.planned_set_mappings.find((row) => row.correlation_id === correlation);
      expect(mapping).toBeDefined();

      const before = await snapshot(p.id);
      clearSpies();
      for (const since of [undefined, first.next_cursor, undefined]) {
        const result = await sync([append], since);
        expect(result.applied).toEqual([append.client_id]);
        expect(result.conflicts).toEqual([]);
        // The ACK still maps the correlation to the same authoritative planned set.
        expect(result.planned_set_mappings).toContainEqual(
          expect.objectContaining({
            correlation_id: correlation,
            planned_set_id: mapping!.planned_set_id,
          }),
        );
      }
      const after = await snapshot(p.id);
      expect(values(after)).toEqual(values(before));
      expect(after).toEqual(before);
      expectNoRecompute();
      expect(await prisma.plannedSet.count({ where: { sessionId: today.id } })).toBe(4);
    });

    it("append-dependency performed_set: the resend is ACK only", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2, 3]);
      await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const append = appendSet(today.id, today.planned[2], at(dayAt(0)));
      const dependent: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: append.payload.correlation_id as string,
        op: "upsert",
        updated_at: at(dayAt(0)),
        payload: { actual_weight: 60, actual_reps: 12, actual_rir: 2, completed: true },
        append_dependencies: { session_id: today.id, client_ids: [append.client_id] },
      };
      const first = await sync([append, dependent]);
      expect(first.applied).toEqual(
        expect.arrayContaining([append.client_id, dependent.client_id]),
      );
      expect(first.conflicts).toEqual([]);

      await expectReplayIsAckOnly(p.id, dependent, first.next_cursor);
    });

    it("a completion resent beside a stale sibling (recordConflict path) is ACK only", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const done = complete(today.id, at(dayAt(0), "11:00"), { difficulty: "hard" });
      expect((await sync([done])).applied).toEqual([done.client_id]);
      const fresh = perf(today.planned[0].id, at(dayAt(0), "12:00"), 62.5, 10);
      expect((await sync([fresh])).applied).toEqual([fresh.client_id]);
      // An older client clock than the stored fact: a stale_update that blocks the completion.
      const stale = perf(today.planned[0].id, at(dayAt(0), "09:00"), 50, 10);

      const before = await snapshot(p.id);
      clearSpies();
      const result = await sync([stale, done]);
      expect(result.applied).toEqual([done.client_id]);
      expect(result.conflicts).toEqual([
        expect.objectContaining({ client_id: stale.client_id, reason: "stale_update" }),
      ]);
      const after = await snapshot(p.id);
      // The stale mutation's own conflict receipt is the only new row (a normal receipt).
      expect(after.receipts.find((row) => row.id === stale.client_id)?.status).toBe("conflict");
      expect(values(withoutReceipt(after, stale.client_id))).toEqual(values(before));
      expect(withoutReceipt(after, stale.client_id)).toEqual(before);
      expectNoRecompute();
    });
  });

  describe("I2 replays mixed with real changes", () => {
    it("a replay in one session and a new change in another recompute only the changed one", async () => {
      const p = await program();
      const yesterday = await session(p.id, dayAt(-1), "completed", [1, 2]);
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const old = perf(yesterday.planned[0].id, at(dayAt(0), "08:00"), 60, 11);
      expect((await sync([old])).applied).toEqual([old.client_id]);
      const yesterdayFacts = async () =>
        (await snapshot(p.id)).performed.filter((row) =>
          yesterday.planned.some((set) => set.id === row.planned_set_id),
        );
      const before = await yesterdayFacts();

      clearSpies();
      const fresh = perf(today.planned[0].id, at(dayAt(0), "12:00"), 60, 12);
      const result = await sync([old, fresh]);
      expect(result.applied).toEqual(expect.arrayContaining([old.client_id, fresh.client_id]));
      expect(result.conflicts).toEqual([]);
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(recomputeSpy).toHaveBeenCalledWith(USER, today.id);
      expect(projectorSpy).toHaveBeenCalledTimes(1);
      expect(projectorSpy).toHaveBeenCalledWith(USER, today.id);
      expect(await yesterdayFacts()).toEqual(before);
    });

    it("a replay beside new changes of the same session: one recompute, the new facts win", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1, 2]);
      const next = await session(p.id, dayAt(3), "scheduled");
      await projector.rebuildUser(USER);
      const first = perf(today.planned[0].id, at(dayAt(0), "11:00"), 60, 12);
      expect((await sync([first])).applied).toEqual([first.client_id]);
      // 60×12 + 60×10: not every set at the top yet → one more rep at the same load.
      expect(await targetOf(next.id)).toEqual([60, 11]);

      clearSpies();
      const second = perf(today.planned[1].id, at(dayAt(0), "11:30"), 60, 12);
      const third = perf(today.planned[2].id, at(dayAt(0), "11:40"), 60, 12);
      const result = await sync([first, second, third]);
      expect(result.applied).toEqual(
        expect.arrayContaining([first.client_id, second.client_id, third.client_id]),
      );
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(recomputeSpy).toHaveBeenCalledWith(USER, today.id);
      // Every set at the top of 6–12 → one 2.5 kg step, reps back to the low end (engine contract).
      expect(await targetOf(next.id)).toEqual([62.5, 6]);
      // Q10 (a), the other half of the pair: with a real change in the batch the session is
      // recomputed once and, as before, every mutation of that session — the replay included —
      // carries that result.
      expect((await ownChange(result, third))?.data).toHaveProperty("next_recommendations");
      expect((await ownChange(result, first))?.data).toHaveProperty("next_recommendations");
    });

    it("a replay never writes its old payload over a newer value", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "completed", [1]);
      const old = perf(today.planned[0].id, at(dayAt(0), "11:00"), 70, 10);
      const newer = perf(today.planned[0].id, at(dayAt(0), "12:00"), 75, 10);
      expect((await sync([old])).applied).toEqual([old.client_id]);
      expect((await sync([newer])).applied).toEqual([newer.client_id]);

      const result = await sync([old]);
      expect(result.applied).toEqual([old.client_id]);
      const fact = await prisma.performedSet.findUniqueOrThrow({
        where: { plannedSetId: today.planned[0].id },
      });
      expect(Number(fact.actualWeight)).toBe(75);
    });
  });

  describe("I3 the same input recomputes to the same result; a replay does not recompute", () => {
    it("finishing again with unchanged facts keeps the target — and its resend is ACK only", async () => {
      const p = await program();
      const today = await session(p.id, dayAt(0), "scheduled");
      const next = await session(p.id, dayAt(3), "scheduled");
      const workout = [
        ...today.planned.map((set) => perf(set.id, at(dayAt(0), "10:00"), 60, 12)),
        complete(today.id, at(dayAt(0), "11:00")),
      ];
      expect((await sync(workout)).conflicts).toEqual([]);
      expect(await targetOf(next.id)).toEqual([62.5, 6]);

      clearSpies();
      // A NEW completion request (another client_id) with the same facts: a real recompute that
      // must land on the same target, not a second +2.5 kg step.
      const again = complete(today.id, at(dayAt(0), "12:00"), { difficulty: "hard" });
      const result = await sync([again]);
      expect(result.applied).toEqual([again.client_id]);
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(await targetOf(next.id)).toEqual([62.5, 6]);

      await expectReplayIsAckOnly(p.id, again, result.next_cursor);
      expect(await targetOf(next.id)).toEqual([62.5, 6]);
    });
  });
});
