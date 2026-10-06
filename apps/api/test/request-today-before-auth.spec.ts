/**
 * BUG-10 C1 (evaluator round 2): the decision instant is captured before authentication.
 *
 * Session auth awaits `findActiveSession` (a DB read) before any controller runs. When that wait
 * crosses UTC midnight, a request that arrived on day D must still be judged on D — both ways:
 *  - a write for D-1 (the previous day, open on D) stays ACCEPTED;
 *  - a write for D+1 (a future day, closed on D) stays REFUSED — the dangerous side: judged after
 *    the wait it became "today" and the fact was recorded.
 * Same method as the lock-wait reproduction (session-fact-date-guard): the server's today moves
 * while the request waits — here inside the real authentication lookup.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AuthService } from "../src/auth/auth.service";
import { TEST_TODAY_ENV } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import { createTestApp, resetUserData } from "./support/app";

const OWNER_CODE = "test-owner-recovery-code-for-the-request-today-spec-only";
const BOOTSTRAP = {
  owner_code: OWNER_CODE,
  profile: {
    sex: "other",
    birth_year: 1990,
    height_cm: 175,
    weight_kg: 70,
    body_fat_pct: null,
    goal: "hypertrophy",
    experience_level: "intermediate",
  },
  consents: [{ type: "privacy_collection", version: "2026-08-17-draft", granted: true }],
};
const BENCH = "e_bench_press";
const ARRIVAL = "2026-09-18";
const LATER = "2026-09-19";
const [PREVIOUS, FUTURE] = ["2026-09-17", "2026-09-19"];

describe("BUG-10 C1 — the day is captured before the authentication wait", () => {
  const original = {
    authMode: process.env.AUTH_MODE,
    ownerCode: process.env.OWNER_RECOVERY_CODE,
    today: process.env[TEST_TODAY_ENV],
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let ownerId: string;
  let sid: string;
  let csrf: string;

  async function removeOwners() {
    const owners = (
      await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } })
    ).map((owner) => owner.id);
    if (!owners.length) return;
    await resetUserData(prisma, ...owners);
    await prisma.accessAudit.deleteMany({ where: { userId: { in: owners } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: owners } } });
    await prisma.consent.deleteMany({ where: { userId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = "session";
    process.env.OWNER_RECOVERY_CODE = OWNER_CODE;
    app = await createTestApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    await removeOwners();
    await prisma.authAttempt.deleteMany({ where: { scope: "owner-login" } });
    const bootstrap = await request(app.getHttpServer())
      .post("/v1/auth/owner/bootstrap")
      .send(BOOTSTRAP)
      .expect(201);
    ownerId = bootstrap.body.user.id as string;
    csrf = bootstrap.body.csrf_token as string;
    const cookies = bootstrap.headers["set-cookie"] as unknown as string[];
    sid = cookies.find((cookie) => cookie.startsWith("sid="))!.split(";", 1)[0];
  }, 60_000);
  beforeEach(async () => {
    process.env[TEST_TODAY_ENV] = ARRIVAL;
    await resetUserData(prisma, ownerId);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env[TEST_TODAY_ENV] = original.today;
  });
  afterAll(async () => {
    process.env[TEST_TODAY_ENV] = original.today;
    try {
      if (prisma) {
        await removeOwners();
        await prisma.authAttempt.deleteMany({ where: { scope: "owner-login" } });
      }
    } finally {
      await app?.close();
      if (original.authMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = original.authMode;
      if (original.ownerCode === undefined) delete process.env.OWNER_RECOVERY_CODE;
      else process.env.OWNER_RECOVERY_CODE = original.ownerCode;
    }
  });

  /** The authentication lookup of the next request takes until after UTC midnight. */
  function midnightDuringAuthentication() {
    const lookup = auth.findActiveSession.bind(auth);
    jest.spyOn(auth, "findActiveSession").mockImplementationOnce(async (token: string) => {
      process.env[TEST_TODAY_ENV] = LATER;
      return lookup(token);
    });
  }

  /** One owner program with one session on `date` holding a single bench set. */
  async function sessionOn(date: string, status: "scheduled" | "in_progress" | "completed") {
    const program = await prisma.program.create({
      data: {
        userId: ownerId,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: new Date(`${ARRIVAL}T00:00:00.000Z`),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date(`${date}T00:00:00.000Z`),
        focus: "upper",
        status,
      },
    });
    const planned = await prisma.plannedSet.create({
      data: {
        sessionId: session.id,
        exerciseId: BENCH,
        setNo: 1,
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
      },
    });
    return { sessionId: session.id, plannedSetId: planned.id, planned };
  }

  const authed = (call: request.Test) => call.set("Cookie", sid).set("X-CSRF-Token", csrf);
  async function logSet(plannedSetId: string) {
    const clientId = randomUUID();
    const response = await authed(request(app.getHttpServer()).post("/v1/sync")).send({
      mutations: [
        {
          client_id: clientId,
          entity: "performed_set",
          entity_id: plannedSetId,
          op: "upsert",
          updated_at: `${ARRIVAL}T23:59:00.000Z`,
          payload: {
            actual_weight: 60,
            actual_reps: 10,
            actual_rir: 2,
            actual_time_sec: null,
            pain_score: null,
            completed: true,
          },
        },
      ],
    });
    expect(response.status).toBe(200);
    return { clientId, body: response.body as { applied: string[]; conflicts: unknown[] } };
  }
  const fact = (plannedSetId: string) =>
    prisma.performedSet.findUnique({ where: { plannedSetId } });

  it("sync: a write for the previous day stays accepted when the authentication wait crosses midnight", async () => {
    const { plannedSetId } = await sessionOn(PREVIOUS, "in_progress");
    midnightDuringAuthentication();
    const { clientId, body } = await logSet(plannedSetId);
    expect(body.conflicts).toEqual([]);
    expect(body.applied).toEqual([clientId]);
    expect(await fact(plannedSetId)).not.toBeNull();
  });

  it("sync: a write for a future day stays refused when the authentication wait crosses midnight", async () => {
    const { plannedSetId } = await sessionOn(FUTURE, "scheduled");
    midnightDuringAuthentication();
    const { clientId, body } = await logSet(plannedSetId);
    expect(body.applied).toEqual([]);
    expect(body.conflicts).toEqual([
      expect.objectContaining({ client_id: clientId, reason: "conflict" }),
    ]);
    expect(await fact(plannedSetId)).toBeNull();
  });

  it("REST complete: the previous day stays completable when the authentication wait crosses midnight", async () => {
    const { sessionId } = await sessionOn(PREVIOUS, "in_progress");
    midnightDuringAuthentication();
    await authed(request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/complete`))
      .send({})
      .expect(200);
    expect(
      (await prisma.workoutSession.findUniqueOrThrow({ where: { id: sessionId } })).status,
    ).toBe("completed");
  });

  it("REST complete: a future day stays refused when the authentication wait crosses midnight", async () => {
    const { sessionId } = await sessionOn(FUTURE, "scheduled");
    midnightDuringAuthentication();
    await authed(request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/complete`))
      .send({})
      .expect(409);
    expect(
      (await prisma.workoutSession.findUniqueOrThrow({ where: { id: sessionId } })).status,
    ).toBe("scheduled");
  });

  /*
   * The other REST entries that judge a date get the same arrival day. Each is checked on the side
   * where the later day would refuse: a set appended to the arrival day's session (today-only), and
   * a routine edit of the arrival day's finished session (ADR-38, same day only).
   */
  const exerciseIds = async (sessionId: string) =>
    (await prisma.plannedSet.findMany({ where: { sessionId }, select: { exerciseId: true } })).map(
      (row) => row.exerciseId,
    );

  it("REST append: the arrival day's session still takes a new set when the authentication wait crosses midnight", async () => {
    const { sessionId, planned } = await sessionOn(ARRIVAL, "in_progress");
    midnightDuringAuthentication();
    await authed(request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/sets`))
      .send({
        client_id: randomUUID(),
        correlation_id: randomUUID(),
        exercise_id: BENCH,
        source: { source_planned_set_id: planned.id, source_revision: sourceRevision(planned) },
      })
      .expect(201);
    expect(await exerciseIds(sessionId)).toEqual([BENCH, BENCH]);
  });

  const ADDED = "e_face_pull";
  const routineEdits = {
    add: (sessionId: string) =>
      authed(request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/exercises`)).send({
        exercise_id: ADDED,
      }),
    remove: (sessionId: string) =>
      authed(request(app.getHttpServer()).delete(`/v1/sessions/${sessionId}/exercises/${BENCH}`)),
    swap: (sessionId: string) =>
      authed(
        request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/exercises/${BENCH}/swap`),
      ).send({ to_exercise_id: ADDED }),
  };
  const afterEdit = { add: [BENCH, ADDED], remove: [], swap: [ADDED] };
  it.each(["add", "remove", "swap"] as const)(
    "REST %s: the arrival day's finished session stays editable when the authentication wait crosses midnight",
    async (edit) => {
      const { sessionId } = await sessionOn(ARRIVAL, "completed");
      midnightDuringAuthentication();
      await routineEdits[edit](sessionId).expect(200);
      expect([...new Set(await exerciseIds(sessionId))].sort()).toEqual(afterEdit[edit]);
    },
  );
});
