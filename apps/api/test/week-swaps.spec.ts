import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient, type Program, type SessionOrigin, type SessionStatus } from "@prisma/client";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { resetUserData } from "./support/app";
import { PlannedSetFactory } from "../src/programs/planned-set.factory";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import { lockProgramRows } from "../src/sessions/session-write-transaction";
import { legacyMaterializeWeek } from "./support/week-swap-legacy-materialize";

const USER_ID = devUserId();
const MONDAY = "2026-09-14";
type Summary = { id: string; scheduled_date: string; revision: string; focus: string };

describe("weekly focus swap HTTP / actual PostgreSQL", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let program: Program;
  let oldToday: string | undefined;
  let client: PrismaClient;
  const queries: string[] = [];

  beforeAll(async () => {
    oldToday = process.env.AFC_TEST_TODAY;
    process.env.AFC_TEST_TODAY = MONDAY;
    const observed = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    observed.$on("query", (event) => {
      if (!/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(event.query)) queries.push(event.query);
    });
    client = observed;
    await client.$connect();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(observed)
      .compile();
    app = configureApp(module.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    if (oldToday === undefined) delete process.env.AFC_TEST_TODAY;
    else process.env.AFC_TEST_TODAY = oldToday;
    await app?.close();
    await client?.$disconnect();
  });
  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    // The auth guard establishes the run-scoped owner before direct fixture writes.
    await request(app.getHttpServer()).get("/v1/programs/current").expect(404);
    program = await newProgram();
  });

  async function newProgram() {
    return prisma.program.create({
      data: {
        userId: USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: new Date(`${MONDAY}T00:00:00Z`),
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
  }
  async function session(
    date: string,
    region: "upper" | "lower" | "core",
    options: {
      programId?: string;
      origin?: SessionOrigin;
      status?: SessionStatus;
    } = {},
  ) {
    return prisma.workoutSession.create({
      data: {
        programId: options.programId ?? program.id,
        scheduledDate: new Date(`${date}T00:00:00Z`),
        focus: region,
        status: options.status ?? "scheduled",
        origin: options.origin ?? "planned",
        plannedSets: {
          create: {
            exerciseId: { upper: "e_bench_press", lower: "e_back_squat", core: "e_plank" }[region],
            orderIndex: 0,
            setNo: 1,
            targetRepsLow: region === "core" ? null : 8,
            targetRepsHigh: region === "core" ? null : 12,
            targetRir: region === "core" ? null : 2,
            targetTimeLowSec: region === "core" ? 30 : null,
            targetTimeHighSec: region === "core" ? 60 : null,
            restSec: 90,
            recommendedWeight: region === "core" ? null : 20,
            recommendedReps: region === "core" ? null : 8,
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
  const endpoint = (suffix: string) => `/v1/programs/${program.id}/${suffix}`;
  async function current(): Promise<Summary[]> {
    const res = await request(app.getHttpServer()).get(endpoint("weeks/current")).expect(200);
    expect(res.body.week_start).toBe(MONDAY);
    return res.body.sessions;
  }
  async function payload(today: string, target: string) {
    const rows = await current();
    return {
      client_id: randomUUID(),
      today_session_id: today,
      target_session_id: target,
      today_revision: rows.find((s) => s.id === today)!.revision,
      target_revision: rows.find((s) => s.id === target)!.revision,
    };
  }
  const post = (body: object) =>
    request(app.getHttpServer()).post(endpoint("week-swaps")).send(body);
  const candidate = () => request(app.getHttpServer()).get(endpoint("week-swaps/candidates"));
  async function snapshot() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { id: "asc" },
      include: { plannedSets: { orderBy: { id: "asc" }, include: { performedSets: true } } },
    });
  }
  function expectReason(response: request.Response, reason: string) {
    expect(response.status).toBe(409);
    expect(response.body.error.details.reason).toBe(reason);
  }

  it("current actual endpoint exists and returns persisted identity, date and aggregate revision", async () => {
    const today = await session(MONDAY, "upper");
    const rows = await current();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: today.id, scheduled_date: MONDAY, focus: "upper" });
    expect(rows[0].revision).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it("Monday U / Tuesday L / Thursday U / Friday L rejects Monday-Friday atomically", async () => {
    const a = await session(MONDAY, "upper");
    await session("2026-09-15", "lower");
    await session("2026-09-17", "upper");
    const b = await session("2026-09-18", "lower");
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
    const candidates = await candidate().expect(200);
    expect(
      candidates.body.candidates.find((c: { session: Summary }) => c.session.id === b.id),
    ).toMatchObject({ eligible: false, reason: "recovery_gap_violation" });
  });

  it("valid within-week swap changes exactly two scheduled dates; result replay survives later edits", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const history = await session("2026-09-13", "core", { status: "completed" });
    await prisma.performedSet.create({
      data: {
        plannedSetId: history.plannedSets[0].id,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date("2026-09-13T10:00:00Z"),
        actualTimeSec: 30,
      },
    });
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    const programBefore = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
      select: { template: true, generationInput: true },
    });
    const first = await post(body).expect(200);
    expect(first.body.today_session_id).toBe(b.id);
    const after = await snapshot();
    expect(
      after.map((s) => ({ ...s, updatedAt: before.find((p) => p.id === s.id)!.updatedAt })),
    ).toEqual(
      before.map((s) => ({
        ...s,
        scheduledDate:
          s.id === a.id ? b.scheduledDate : s.id === b.id ? a.scheduledDate : s.scheduledDate,
      })),
    );
    expect(
      await prisma.program.findUniqueOrThrow({
        where: { id: program.id },
        select: { template: true, generationInput: true },
      }),
    ).toEqual(programBefore);
    const protectedFields = (rows: typeof before) =>
      rows.map(({ scheduledDate, updatedAt, ...s }) => {
        void scheduledDate;
        void updatedAt;
        return s;
      });
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const protectedBefore = digest({ sessions: protectedFields(before), program: programBefore });
    const protectedAfter = digest({ sessions: protectedFields(after), program: programBefore });
    expect(protectedAfter).toBe(protectedBefore);
    console.info("T05 successful invariance", {
      protectedBefore,
      protectedAfter,
      sessions: before.length,
      planned: before.flatMap((s) => s.plannedSets).length,
      performed: before.flatMap((s) => s.plannedSets.flatMap((p) => p.performedSets)).length,
      datesBefore: [a.scheduledDate, b.scheduledDate].map((d) => d.toISOString().slice(0, 10)),
      datesAfter: [
        after.find((s) => s.id === a.id)!.scheduledDate,
        after.find((s) => s.id === b.id)!.scheduledDate,
      ].map((d) => d.toISOString().slice(0, 10)),
    });
    await prisma.plannedSet.update({ where: { id: a.plannedSets[0].id }, data: { restSec: 120 } });
    expect((await post(body).expect(200)).body).toEqual(first.body);
    expectReason(
      await post({ ...body, target_revision: "changed" }),
      "idempotency_payload_mismatch",
    );
  });

  it.each(["2026-09-13", "2026-09-21"])("checks boundary neighbor %s", async (boundary) => {
    const a = await session(MONDAY, boundary.endsWith("13") ? "upper" : "lower");
    const b = await session("2026-09-20", boundary.endsWith("13") ? "lower" : "upper");
    await session(boundary, boundary.endsWith("13") ? "lower" : "lower");
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("core-only neighbor is in chronology but does not cause recovery conflict", async () => {
    const a = await session(MONDAY, "core");
    await session("2026-09-15", "core");
    const b = await session("2026-09-17", "core");
    await post(await payload(a.id, b.id)).expect(200);
  });

  it("other Program completed/ad_hoc actual neighbor is read without changing it", async () => {
    const older = program;
    await prisma.program.update({
      where: { id: older.id },
      data: { createdAt: new Date("2026-01-01") },
    });
    program = await newProgram();
    await session("2026-09-13", "lower", {
      programId: older.id,
      origin: "ad_hoc",
      status: "completed",
    });
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("unmaterialized next-week template is read-only recovery evidence", async () => {
    const a = await session(MONDAY, "lower");
    const b = await session("2026-09-20", "upper");
    await prisma.program.update({
      where: { id: program.id },
      data: {
        template: [
          {
            day: "MON",
            focus: "lower",
            exercises: [
              {
                exercise_id: "e_back_squat",
                sets: 1,
                reps_low: 8,
                reps_high: 12,
                target_rir: 2,
                rest_sec: 90,
                time_low_sec: null,
                time_high_sec: null,
              },
            ],
          },
        ],
      },
    });
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("partial next week previews the missing Monday before its actual Tuesday neighbor", async () => {
    const a = await session(MONDAY, "lower"),
      b = await session("2026-09-20", "upper");
    await session("2026-09-22", "core");
    await prisma.program.update({
      where: { id: program.id },
      data: {
        template: [
          {
            day: "MON",
            focus: "lower",
            exercises: [
              {
                exercise_id: "e_back_squat",
                sets: 1,
                reps_low: 8,
                reps_high: 12,
                target_rir: 2,
                rest_sec: 90,
                time_low_sec: null,
                time_high_sec: null,
              },
            ],
          },
        ],
      },
    });
    const body = await payload(a.id, b.id),
      before = await snapshot();
    const candidates = await candidate().expect(200);
    expect(
      candidates.body.candidates.find((c: { session: Summary }) => c.session.id === b.id),
    ).toMatchObject({ eligible: false, reason: "recovery_gap_violation" });
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("empty template exercise row cannot certify a missing neighboring slot", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    await prisma.program.update({
      where: { id: program.id },
      data: { template: [{ day: "MON", exercises: [] }] },
    });
    expectReason(await post(await payload(a.id, b.id)), "recovery_unverifiable");
  });

  it("previous Sunday and next Monday actuals bound all possible preview neighbors", async () => {
    await prisma.program.update({
      where: { id: program.id },
      data: { startedAt: new Date("2026-09-07T00:00:00Z"), template: "unneeded invalid template" },
    });
    await session("2026-09-13", "core");
    await session("2026-09-21", "core");
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    await post(await payload(a.id, b.id)).expect(200);
  });

  it("unsupported recovery bundle fails closed", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    await prisma.program.update({ where: { id: program.id }, data: { rulesVersion: "2026.09.0" } });
    expectReason(await post(await payload(a.id, b.id)), "recovery_unverifiable");
  });

  it("unsupported neighboring Program bundle also fails closed", async () => {
    const older = program;
    await prisma.program.update({
      where: { id: older.id },
      data: { createdAt: new Date("2026-01-01"), rulesVersion: "2026.09.0" },
    });
    program = await newProgram();
    await session("2026-09-13", "core", { programId: older.id });
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    expectReason(await post(await payload(a.id, b.id)), "recovery_unverifiable");
  });

  it("empty missing-week preview is unknown, while actual-only weeks need no template parse", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    await prisma.program.update({ where: { id: program.id }, data: { template: [] } });
    const body = await payload(a.id, b.id);
    expectReason(await post(body), "recovery_unverifiable");
    await session("2026-09-21", "core");
    await prisma.program.update({
      where: { id: program.id },
      data: { template: "invalid but unused" },
    });
    await post(body).expect(200);
  });

  it("wrong-week eligibility wins over stale hash", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-21", "lower");
    const rows = await current();
    expectReason(
      await post({
        client_id: randomUUID(),
        today_session_id: a.id,
        target_session_id: b.id,
        today_revision: rows.find((s) => s.id === a.id)!.revision,
        target_revision: "stale",
      }),
      "wrong_week",
    );
  });

  it("ad_hoc target is not scheduled for swap", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower", { origin: "ad_hoc" });
    expectReason(await post(await payload(a.id, b.id)), "not_scheduled");
  });

  it("plan and incomplete performed-row changes invalidate revisions; structural performed reason wins", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    await prisma.plannedSet.update({
      where: { id: a.plannedSets[0].id },
      data: { targetRepsLow: 9 },
    });
    expectReason(await post(body), "stale_revision");
    await prisma.performedSet.create({
      data: {
        plannedSetId: a.plannedSets[0].id,
        completed: false,
        clientId: randomUUID(),
        performedAt: new Date(),
      },
    });
    expectReason(await post(body), "performed_history");
  });

  it("parallel swaps allow exactly one and leave no partial exchange", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    const responses = await Promise.all([post(body), post({ ...body, client_id: randomUUID() })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await snapshot();
    expect(after.find((s) => s.id === a.id)?.scheduledDate).toEqual(b.scheduledDate);
    expect(after.find((s) => s.id === b.id)?.scheduledDate).toEqual(a.scheduledDate);
  });

  it("ambiguous today returns null identity and explicit today eligibility", async () => {
    await session(MONDAY, "upper");
    await session(MONDAY, "lower", { origin: "ad_hoc" });
    await session("2026-09-17", "lower");
    const result = await candidate().expect(200);
    expect(result.body).toMatchObject({
      today_session_id: null,
      today_revision: null,
      today_eligible: false,
      today_reason: "ambiguous_schedule",
    });
  });

  it("commit rechecks a neighbor changed after candidates without either requested revision changing", async () => {
    const a = await session(MONDAY, "upper");
    const neighbor = await session("2026-09-15", "core");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    const result = await candidate().expect(200);
    expect(
      result.body.candidates.find((c: { session: Summary }) => c.session.id === b.id).eligible,
    ).toBe(true);
    await prisma.plannedSet.update({
      where: { id: neighbor.plannedSets[0].id },
      data: {
        exerciseId: "e_back_squat",
        targetTimeLowSec: null,
        targetTimeHighSec: null,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        recommendedReps: 8,
      },
    });
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("readonly precedes performed_history and stale_revision", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    await prisma.workoutSession.update({ where: { id: a.id }, data: { status: "completed" } });
    await prisma.performedSet.create({
      data: {
        plannedSetId: a.plannedSets[0].id,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date(),
      },
    });
    expectReason(await post(body), "readonly");
  });

  it("body validation, absent today, and missing/foreign ownership fail before mutation", async () => {
    await prisma.program.update({ where: { id: program.id }, data: { template: [] } });
    await candidate().expect(404);
    await post({ client_id: randomUUID() }).expect(400);
    await post({
      client_id: randomUUID(),
      today_session_id: randomUUID(),
      target_session_id: randomUUID(),
      today_revision: "a",
      target_revision: "b",
    }).expect(404);
  });

  it("ineligible today has its own reason and never produces a reasonless disabled candidate", async () => {
    await session(MONDAY, "upper", { status: "completed" });
    await session("2026-09-17", "lower");
    const result = await candidate().expect(200);
    expect(result.body).toMatchObject({ today_eligible: false, today_reason: "readonly" });
    expect(result.body.candidates[0]).toMatchObject({ eligible: false, reason: "readonly" });
  });

  it("warm SQL budgets and canonical Program-before-sorted-two-session lock order", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    queries.length = 0;
    await current();
    const currentCount = queries.length;
    expect(currentCount).toBeLessThanOrEqual(12);
    queries.length = 0;
    await candidate().expect(200);
    const candidateCount = queries.length;
    expect(candidateCount).toBeLessThanOrEqual(16);
    const body = await payload(a.id, b.id);
    queries.length = 0;
    await post(body).expect(200);
    const postCount = queries.length;
    expect(postCount).toBeLessThanOrEqual(22);
    const programLock = queries.findIndex((q) => /FROM programs .*FOR UPDATE/.test(q));
    const sessionLock = queries.findIndex((q) => /FROM workout_sessions .*FOR UPDATE/.test(q));
    expect(programLock).toBeGreaterThanOrEqual(0);
    expect(sessionLock).toBeGreaterThan(programLock);
    expect(queries[sessionLock]).toContain("ORDER BY id FOR UPDATE");
    expect(queries[sessionLock].match(/::uuid/g)).toHaveLength(2);
    queries.length = 0;
    await post(body).expect(200);
    const replayCount = queries.length;
    expect(replayCount).toBeLessThanOrEqual(8);
    console.info("T05 SQL counts", {
      current: currentCount,
      candidates: candidateCount,
      post: postCount,
      replay: replayCount,
    });
  });

  it("receipt insert failure rolls both date writes back", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id),
      before = await snapshot();
    // A real DB constraint fault happens after both UPDATE statements, not before the transaction starts.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION t05_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'T05 receipt fault'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER t05_receipt_fault BEFORE INSERT ON week_swap_receipts FOR EACH ROW EXECUTE FUNCTION t05_reject_receipt()`,
    );
    try {
      await post(body).expect(500);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.weekSwapReceipt.count({ where: { userId: USER_ID } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER t05_receipt_fault ON week_swap_receipts");
      await prisma.$executeRawUnsafe("DROP FUNCTION t05_reject_receipt()");
    }
  });

  it("second date UPDATE failure rolls back the first UPDATE and leaves no receipt", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id),
      before = await snapshot();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION t05_reject_second_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'T05 second date fault'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER t05_second_date_fault BEFORE UPDATE ON workout_sessions FOR EACH ROW WHEN (NEW.id = '${b.id}'::uuid) EXECUTE FUNCTION t05_reject_second_date()`,
    );
    try {
      await post(body).expect(500);
      const after = await snapshot();
      expect(after).toEqual(before);
      expect(await prisma.weekSwapReceipt.count({ where: { userId: USER_ID } })).toBe(0);
      const digest = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      console.info("T05 rejected invariance", {
        reason: "second_update_fault",
        before: digest(before),
        after: digest(after),
        sessions: after.length,
        receipts: 0,
      });
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER t05_second_date_fault ON workout_sessions");
      await prisma.$executeRawUnsafe("DROP FUNCTION t05_reject_second_date()");
    }
  });

  it("a blocked swap reads neighbor changes committed by the preceding Program lock holder", async () => {
    const a = await session(MONDAY, "upper"),
      neighbor = await session("2026-09-15", "core"),
      b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await lockProgramRows(tx, [program.id]);
      locked();
      await gate;
      await tx.plannedSet.update({
        where: { id: neighbor.plannedSets[0].id },
        data: {
          exerciseId: "e_back_squat",
          targetTimeLowSec: null,
          targetTimeHighSec: null,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          recommendedReps: 8,
        },
      });
    });
    await acquired;
    const pending = post(body).then((response) => response);
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM programs%FOR UPDATE%'`;
        if (Number(waiting[0].count) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    await blocker;
    const before = await snapshot();
    expectReason(await pending, "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("a replay blocked on its advisory identity rechecks deleted-session ownership before receipt", async () => {
    const a = await session(MONDAY, "upper"),
      b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    await post(body).expect(200);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      const key = JSON.stringify(["week_swap", USER_ID, body.client_id]);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
      await lockProgramRows(tx, [program.id]);
      locked();
      await gate;
      await tx.plannedSet.deleteMany({ where: { sessionId: a.id } });
      await tx.workoutSession.delete({ where: { id: a.id } });
    });
    await acquired;
    const pending = post(body).then((response) => response);
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
        if (Number(waiting[0].count) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    await blocker;
    const before = await snapshot();
    expect((await pending).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(await prisma.weekSwapReceipt.count({ where: { userId: USER_ID } })).toBe(1);
  });

  it("extracted lazy body generates exactly the frozen pre-extraction rows for identical inputs", async () => {
    await prisma.program.delete({ where: { id: program.id } });
    const generated = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({
        goal: "hypertrophy",
        days_per_week: 4,
        minutes_per_day: 60,
        experience_level: "intermediate",
      })
      .expect(201);
    program = await prisma.program.findUniqueOrThrow({ where: { id: generated.body.program_id } });
    const recommendation = app.get(RecommendationService),
      factory = app.get(PlannedSetFactory);
    await prisma.$transaction(async (tx) => {
      await lockProgramRows(tx, [program.id]);
      await legacyMaterializeWeek(tx, USER_ID, program, 1, recommendation, factory);
    });
    const normalize = (rows: Awaited<ReturnType<typeof snapshot>>) =>
      rows
        .sort((a, b) => +a.scheduledDate - +b.scheduledDate)
        .map(({ id, updatedAt, plannedSets, ...row }) => {
          void id;
          void updatedAt;
          return {
            ...row,
            plannedSets: plannedSets
              .sort((a, b) => a.orderIndex - b.orderIndex || a.setNo - b.setNo)
              .map(({ id, sessionId, updatedAt, ...set }) => {
                void id;
                void sessionId;
                void updatedAt;
                return set;
              }),
          };
        });
    const before = JSON.stringify(normalize(await snapshot()));
    await prisma.plannedSet.deleteMany({ where: { session: { programId: program.id } } });
    await prisma.workoutSession.deleteMany({ where: { programId: program.id } });
    queries.length = 0;
    await current();
    console.info("T05 cold lazy SQL", {
      queries: queries.length,
      sessionCount: 4,
      referenceUpperBound: 28 + 2 * 4,
    });
    expect(JSON.stringify(normalize(await snapshot()))).toBe(before);
    // A partial materialized week is repaired using the same pre-existing date-slot rule.
    const remove = await prisma.workoutSession.findFirstOrThrow({
      where: { programId: program.id },
      orderBy: { scheduledDate: "desc" },
    });
    await prisma.plannedSet.deleteMany({ where: { sessionId: remove.id } });
    await prisma.workoutSession.delete({ where: { id: remove.id } });
    await current();
    expect(JSON.stringify(normalize(await snapshot()))).toBe(before);
  });
});
