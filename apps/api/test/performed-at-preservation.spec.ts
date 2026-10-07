/**
 * BUG-10 M — a performed set keeps the time it was first saved (`performed_at`) when its values are
 * corrected later; only `updated_at` follows the edit, today included (ticket M1/M2). A delete
 * followed by a real new set is a new performance with its own time.
 *
 * Every edit here is on today's session — the only date where all of them are allowed — so the
 * update path is actually reached (an edit the date window rejects never runs it).
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { isoDate, utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";

const USER = devUserId();
const BENCH = "e_bench_press";
const PLANK = "e_plank";

type Wire = {
  applied: string[];
  conflicts: { client_id: string; reason: string }[];
};

describe("BUG-10 M — performed_at is the first save; edits move only updated_at", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, USER));
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, USER);
    } finally {
      await app?.close();
    }
  });

  /** Today's UTC date at hh:mm:ss — distinct, increasing client clocks for each edit. */
  const today = (time: string) => `${isoDate(utcToday())}T${time}.000Z`;

  async function todaySession(exercise = BENCH, status: "scheduled" | "completed" = "scheduled") {
    const program = await prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: utcToday(),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status,
        ...(status === "completed" ? { completedAt: new Date(today("11:00:00")) } : {}),
      },
    });
    const time = exercise === PLANK;
    await prisma.plannedSet.createMany({
      data: [1, 2].map((setNo) => ({
        sessionId: session.id,
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
      where: { sessionId: session.id },
      orderBy: { setNo: "asc" },
    });
    return { id: session.id, planned };
  }

  async function sync(mutations: MutationDto[]): Promise<Wire> {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations })
      .expect(200);
    return response.body as Wire;
  }
  const set = (
    plannedSetId: string,
    updatedAt: string,
    actual: Record<string, number | null>,
  ): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: plannedSetId,
    op: "upsert",
    updated_at: updatedAt,
    payload: { ...actual, completed: true },
  });
  const lift = (plannedSetId: string, updatedAt: string, weight: number, reps: number) =>
    set(plannedSetId, updatedAt, { actual_weight: weight, actual_reps: reps, actual_rir: 2 });
  const remove = (plannedSetId: string, updatedAt: string): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: plannedSetId,
    op: "delete",
    updated_at: updatedAt,
    payload: {},
  });
  async function expectApplied(mutation: MutationDto) {
    const result = await sync([mutation]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual([mutation.client_id]);
  }
  const fact = (plannedSetId: string) =>
    prisma.performedSet.findUniqueOrThrow({ where: { plannedSetId } });
  async function wireFact(sessionId: string, plannedSetId: string) {
    const response = await request(app.getHttpServer())
      .get(`/v1/sessions/${sessionId}`)
      .expect(200);
    return response.body.planned_sets.find((row: { id: string }) => row.id === plannedSetId)
      .performed_set as Record<string, unknown>;
  }

  it("M1 create t0 → edit t1 → edit t2: performed_at stays t0, updated_at follows the edits", async () => {
    const workout = await todaySession();
    const [target, other] = workout.planned;
    const t0 = today("10:00:00");
    const t1 = today("10:05:00");
    const t2 = today("10:09:00");
    const created = lift(target.id, t0, 60, 10);
    await expectApplied(created);
    await expectApplied(lift(other.id, today("10:02:00"), 60, 9));
    const otherBefore = await fact(other.id);
    // M2: the first creation stores the client's save time.
    expect((await fact(target.id)).performedAt.toISOString()).toBe(t0);

    const firstEdit = lift(target.id, t1, 62.5, 8);
    await expectApplied(firstEdit);
    await expectApplied(lift(target.id, t2, 62.5, 9));

    const stored = await fact(target.id);
    expect(stored.performedAt.toISOString()).toBe(t0);
    expect(stored.updatedAt.toISOString()).toBe(t2);
    expect([Number(stored.actualWeight), stored.actualReps]).toEqual([62.5, 9]);
    expect(stored.clientId).toBe(created.client_id);
    expect(await wireFact(workout.id, target.id)).toMatchObject({
      actual_weight: 62.5,
      actual_reps: 9,
      performed_at: t0,
    });
    // Another set's times are untouched by this set's edits.
    expect(await fact(other.id)).toEqual(otherBefore);

    // An exact resend of an earlier edit moves neither time.
    expect((await sync([firstEdit])).applied).toEqual([firstEdit.client_id]);
    const replayed = await fact(target.id);
    expect(replayed.performedAt.toISOString()).toBe(t0);
    expect(replayed.updatedAt.toISOString()).toBe(t2);
  });

  it("M1 the same holds on a session that is already completed today", async () => {
    const workout = await todaySession(BENCH, "completed");
    const [target] = workout.planned;
    const t0 = today("10:00:00");
    await expectApplied(lift(target.id, t0, 60, 10));
    await expectApplied(lift(target.id, today("11:30:00"), 60, 12));
    const stored = await fact(target.id);
    expect(stored.performedAt.toISOString()).toBe(t0);
    expect(stored.updatedAt.toISOString()).toBe(today("11:30:00"));
    // completedAt is preserved by the edit as before.
    const session = await prisma.workoutSession.findUniqueOrThrow({ where: { id: workout.id } });
    expect(session.completedAt?.toISOString()).toBe(today("11:00:00"));
  });

  it("M2 delete then a real new set: a new performance with its own client_id and time", async () => {
    const workout = await todaySession();
    const [target] = workout.planned;
    const first = lift(target.id, today("10:00:00"), 60, 10);
    await expectApplied(first);
    await expectApplied(remove(target.id, today("10:03:00")));
    await expect(
      prisma.performedSet.findUnique({ where: { plannedSetId: target.id } }),
    ).resolves.toBeNull();

    const again = lift(target.id, today("10:20:00"), 60, 11);
    await expectApplied(again);
    const stored = await fact(target.id);
    expect(stored.clientId).toBe(again.client_id);
    expect(stored.performedAt.toISOString()).toBe(today("10:20:00"));
    expect(stored.updatedAt.toISOString()).toBe(today("10:20:00"));
  });

  it("M2 a time exercise: the time is corrected, performed_at stays, the RIR axis stays empty", async () => {
    const workout = await todaySession(PLANK);
    const [target] = workout.planned;
    const t0 = today("10:00:00");
    await expectApplied(set(target.id, t0, { actual_time_sec: 30 }));
    await expectApplied(set(target.id, today("10:04:00"), { actual_time_sec: 45 }));
    const stored = await fact(target.id);
    expect(stored.actualTimeSec).toBe(45);
    expect(stored.actualRir).toBeNull();
    expect(stored.actualReps).toBeNull();
    expect(stored.performedAt.toISOString()).toBe(t0);
    expect(stored.updatedAt.toISOString()).toBe(today("10:04:00"));
  });

  it("M2 LWW is unchanged: an older client clock is stale and moves neither time", async () => {
    const workout = await todaySession();
    const [target] = workout.planned;
    await expectApplied(lift(target.id, today("10:00:00"), 60, 10));
    await expectApplied(lift(target.id, today("10:10:00"), 62.5, 10));
    const stale = lift(target.id, today("10:05:00"), 50, 10);
    const result = await sync([stale]);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ client_id: stale.client_id, reason: "stale_update" }),
    ]);
    const stored = await fact(target.id);
    expect(Number(stored.actualWeight)).toBe(62.5);
    expect(stored.performedAt.toISOString()).toBe(today("10:00:00"));
    expect(stored.updatedAt.toISOString()).toBe(today("10:10:00"));
  });
});
