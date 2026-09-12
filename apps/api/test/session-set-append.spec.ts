/** Ticket04 direct append DB contract. Execute only through the coordinator's owned DB gate. */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, type PlannedSet, type SessionStatus } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import { createTestApp, resetUserData } from "./support/app";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";
import { testUserId } from "./support/users";

const PATH = "/sessions/{id}/sets";
const userId = devUserId();
const otherUserId = testUserId("tenancy");
const DAY = 86_400_000;
const rawCopyFields = [
  "targetRepsLow",
  "targetRepsHigh",
  "targetTimeLowSec",
  "targetTimeHighSec",
  "targetRir",
  "restSec",
  "recommendedWeight",
  "recommendedReps",
  "reasonCode",
  "confidence",
  "rulesVersion",
  "loadSemantics",
  "assistanceStepKg",
  "assistanceProvenance",
  "orderIndex",
] as const;
const rawCopy = (row: PlannedSet) =>
  Object.fromEntries(rawCopyFields.map((key) => [key, row[key]]));

describe("session set append direct API / raw reader / receipt atomicity", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  beforeEach(async () => {
    await resetUserData(prisma, userId, otherUserId);
  });
  afterAll(async () => {
    try {
      if (prisma) {
        await resetUserData(prisma, userId, otherUserId);
        await prisma.user.deleteMany({ where: { id: otherUserId } });
      }
    } finally {
      await app?.close();
    }
  });

  async function fixture(
    options: {
      owner?: string;
      count?: number;
      offset?: number;
      status?: SessionStatus;
      raw?: Partial<Prisma.PlannedSetCreateManyInput>;
    } = {},
  ) {
    const owner = options.owner ?? userId;
    if (owner !== userId)
      await prisma.user.upsert({
        where: { id: owner },
        update: {},
        create: {
          id: owner,
          sex: "other",
          birthYear: 1990,
          heightCm: 180,
          weightKg: 80,
          goal: "hypertrophy",
          experienceLevel: "intermediate",
          constraints: {},
        },
      });
    const program = await prisma.program.create({
      data: {
        userId: owner,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: utcToday(),
        generationInput: {
          goal: "hypertrophy",
          days_per_week: 4,
          minutes_per_day: 60,
          experience_level: "intermediate",
        },
        template: [
          { day: "MON", focus: "upper", exercises: [{ exercise_id: "e_bench_press", sets: 3 }] },
        ],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date(utcToday().getTime() + (options.offset ?? 0) * DAY),
        focus: "upper",
        status: options.status ?? "scheduled",
        ...(options.status === "completed"
          ? {
              completedAt: new Date(utcToday().getTime() + 10 * 3_600_000),
              sessionFeedback: { difficulty: "moderate", pump: "high" },
            }
          : {}),
      },
    });
    await prisma.plannedSet.createMany({
      data: Array.from({ length: options.count ?? 3 }, (_, index) => ({
        sessionId: session.id,
        exerciseId: "e_bench_press",
        orderIndex: 2,
        setNo: index + 1,
        targetRepsLow: 7,
        targetRepsHigh: 13,
        targetRir: 3,
        restSec: 137,
        targetTimeLowSec: null,
        targetTimeHighSec: null,
        recommendedWeight: 56.25,
        recommendedReps: 9,
        reasonCode: "BASELINE",
        confidence: 0.63,
        rulesVersion: "2026.08.1",
        loadSemantics: "external_load",
        assistanceStepKg: null,
        assistanceProvenance: null,
        ...options.raw,
      })),
    });
    const rows = await prisma.plannedSet.findMany({
      where: { sessionId: session.id },
      orderBy: { setNo: "asc" },
    });
    return { session, program, rows, source: rows.at(-1)! };
  }
  function intent(source: PlannedSet) {
    return {
      client_id: randomUUID(),
      exercise_id: source.exerciseId,
      correlation_id: randomUUID(),
      source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
    };
  }
  const post = (sessionId: string, payload: object) =>
    request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/sets`).send(payload);
  const get = (sessionId: string) =>
    request(app.getHttpServer()).get(`/v1/sessions/${sessionId}`).expect(200);
  async function noFacts(sessionId: string) {
    expect(await prisma.performedSet.count({ where: { plannedSet: { sessionId } } })).toBe(0);
    expect(await prisma.assistanceAudit.count({ where: { plannedSet: { sessionId } } })).toBe(0);
    expect(await prisma.estimated1rm.count({ where: { userId } })).toBe(0);
    expect(await prisma.muscleWeeklyLoad.count({ where: { userId } })).toBe(0);
  }
  async function conflict(sessionId: string, payload: object, reason: string) {
    const before = await prisma.plannedSet.findMany({
      where: { sessionId },
      orderBy: { id: "asc" },
    });
    const response = await post(sessionId, payload);
    expectErrorMatchesContract("post", PATH, 409, response);
    expect(response.body.error.details).toEqual({ reason });
    expect(
      await prisma.plannedSet.findMany({ where: { sessionId }, orderBy: { id: "asc" } }),
    ).toEqual(before);
    return response;
  }

  it("GET exposes raw token/nullable correlation and cohort eligibility before the display gate", async () => {
    const { session, source } = await fixture();
    const response = await get(session.id);
    expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
    const wire = response.body.planned_sets.find((row: { id: string }) => row.id === source.id);
    expect(wire).toMatchObject({
      source_revision: sourceRevision(source),
      correlation_id: null,
      recommendation_gate: "no_history",
      recommended_weight: 56.25,
      reason_code: "BASELINE",
      append_eligibility: {
        version: 1,
        source_revision: sourceRevision(source),
        status: "allowed",
        reason: null,
      },
    });
    expect(wire.append_eligibility.cohort_revision).toMatch(/^[a-f0-9]{64}$/);
    const revision = wire.source_revision;
    const cohortRevision = wire.append_eligibility.cohort_revision;
    await prisma.performedSet.create({
      data: {
        plannedSetId: source.id,
        clientId: randomUUID(),
        performedAt: new Date(),
        completed: true,
        actualWeight: 80,
        actualReps: 10,
        actualRir: 2,
      },
    });
    const after = (await get(session.id)).body.planned_sets.find(
      (row: { id: string }) => row.id === source.id,
    );
    expect(after.source_revision).toBe(revision);
    expect(after.append_eligibility.cohort_revision).not.toBe(cohortRevision);
    expect(after.performed_set.actual_weight).toBe(80);
  });

  it.each(["scheduled", "in_progress", "completed"] as const)(
    "today %s appends one exact raw snapshot, no facts or template propagation",
    async (status) => {
      const { session, source, program, rows } = await fixture({ status });
      const future = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date(utcToday().getTime() + DAY),
          focus: "upper",
          status: "scheduled",
        },
      });
      const payload = intent(source);
      const response = await post(session.id, payload).expect(201);
      expectMatchesContract("post", PATH, 201, response.body);
      expect(response.body).toMatchObject({
        client_id: payload.client_id,
        session_id: session.id,
        correlation_id: payload.correlation_id,
        planned_set: { correlation_id: payload.correlation_id, set_no: 4, performed_set: null },
      });
      const created = await prisma.plannedSet.findUniqueOrThrow({
        where: { id: response.body.planned_set_id },
      });
      expect(created.id).not.toBe(source.id);
      expect(created.clientCorrelationId).toBe(payload.correlation_id);
      expect(rawCopy(created)).toEqual(rawCopy(source));
      expect(response.body.planned_set.source_revision).toBe(sourceRevision(created));
      expect(response.body.planned_set.id).toBe(created.id);
      expect(
        await prisma.plannedSet.findMany({
          where: { id: { in: rows.map((row) => row.id) } },
          orderBy: { setNo: "asc" },
        }),
      ).toEqual(rows);
      expect(await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).toEqual(
        program,
      );
      const afterSession = await prisma.workoutSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(afterSession).toMatchObject({
        status: session.status,
        completedAt: session.completedAt,
        sessionFeedback: session.sessionFeedback,
      });
      expect(await prisma.plannedSet.count({ where: { sessionId: future.id } })).toBe(0);
      const receipt = await prisma.syncMutation.findUniqueOrThrow({
        where: { id: payload.client_id },
      });
      expect(receipt).toMatchObject({
        userId,
        entityType: "session_set",
        entityId: session.id,
        status: "applied",
      });
      expect(receipt.appliedAt).not.toBeNull();
      // Only append identity is stored, never the raw result/health payload.
      expect(receipt.payload).toEqual({
        exercise_id: payload.exercise_id,
        correlation_id: payload.correlation_id,
        source: payload.source,
      });
      await noFacts(session.id);
    },
  );

  it.each([
    ["external assisted catalog ID", { exerciseId: "e_assisted_dips" }],
    ["bodyweight", { exerciseId: "e_pushup", recommendedWeight: null }],
    [
      "time",
      {
        exerciseId: "e_plank",
        recommendedWeight: null,
        recommendedReps: null,
        targetRepsLow: null,
        targetRepsHigh: null,
        targetRir: null,
        targetTimeLowSec: 35,
        targetTimeHighSec: 65,
      },
    ],
    [
      "native minimum",
      {
        exerciseId: "e_assisted_dips",
        loadSemantics: "assistance",
        assistanceProvenance: "native",
        assistanceStepKg: 2.5,
        rulesVersion: "2026.08.2",
        reasonCode: "ASSISTANCE_MINIMUM_REACHED",
      },
    ],
    [
      "remediated ready",
      {
        exerciseId: "e_assisted_pullup",
        loadSemantics: "assistance",
        assistanceProvenance: "remediated",
        assistanceStepKg: 5,
        rulesVersion: "2026.08.2",
        reasonCode: "ASSISTANCE_DOWN_RIR_EASY",
      },
    ],
    [
      "calibration null",
      {
        exerciseId: "e_assisted_dips",
        loadSemantics: "assistance",
        assistanceProvenance: "native",
        assistanceStepKg: 2.5,
        rulesVersion: "2026.08.2",
        reasonCode: "ASSISTANCE_CALIBRATION_NEEDED",
        recommendedWeight: null,
      },
    ],
    [
      "pain null",
      {
        exerciseId: "e_assisted_dips",
        loadSemantics: "assistance",
        assistanceProvenance: "native",
        assistanceStepKg: 2.5,
        rulesVersion: "2026.08.2",
        reasonCode: "SUBSTITUTE_PAIN",
        recommendedWeight: null,
      },
    ],
    [
      "invalid null",
      {
        exerciseId: "e_assisted_dips",
        loadSemantics: "assistance",
        assistanceProvenance: "native",
        assistanceStepKg: 2.5,
        rulesVersion: "2026.08.2",
        reasonCode: "INVALID_INPUT",
        recommendedWeight: null,
      },
    ],
  ] as Array<[string, Partial<Prisma.PlannedSetCreateManyInput>]>)(
    "M4 direct exact copy: %s",
    async (_name, raw) => {
      const { session, source } = await fixture({ raw });
      const response = await post(session.id, intent(source)).expect(201);
      expectMatchesContract("post", PATH, 201, response.body);
      const created = await prisma.plannedSet.findUniqueOrThrow({
        where: { id: response.body.planned_set_id },
      });
      expect(rawCopy(created)).toEqual(rawCopy(source));
      expect(response.body.planned_set).toMatchObject({
        performed_set: null,
        append_eligibility: { status: "allowed", reason: null },
        recommendation_gate: "no_history",
        recommended_action:
          raw.reasonCode === "ASSISTANCE_MINIMUM_REACHED"
            ? { kind: "suggest_exercise_swap", exercise_id: "e_dips" }
            : null,
      });
      await noFacts(session.id);
    },
  );

  it("performed-safe assistance source with zero weight is blocked for a new unperformed copy", async () => {
    const { session, source } = await fixture({
      count: 1,
      raw: {
        exerciseId: "e_assisted_dips",
        loadSemantics: "assistance",
        assistanceProvenance: "native",
        assistanceStepKg: 2.5,
        rulesVersion: "2026.08.2",
        reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
        recommendedWeight: 0,
      },
    });
    const fact = await prisma.performedSet.create({
      data: {
        plannedSetId: source.id,
        clientId: randomUUID(),
        performedAt: new Date(),
        completed: true,
        actualWeight: 10,
        actualReps: 10,
        actualRir: 2,
      },
    });
    const wire = (await get(session.id)).body.planned_sets[0];
    expect(wire).toMatchObject({
      assistance_safety_status: "safe",
      append_eligibility: { status: "blocked", reason: "unsafe_assistance_snapshot" },
    });
    await conflict(session.id, intent(source), "unsafe_assistance_snapshot");
    expect(await prisma.performedSet.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    expect(await prisma.assistanceAudit.count({ where: { plannedSetId: source.id } })).toBe(0);
  });

  it("invalid raw has reader eligibility null and POST400, not source_changed/unsafe409", async () => {
    const { session, source } = await fixture({ raw: { targetRepsLow: 13, targetRepsHigh: 7 } });
    expect((await get(session.id)).body.planned_sets.at(-1).append_eligibility).toBeNull();
    const response = await post(session.id, intent(source));
    expectErrorMatchesContract("post", PATH, 400, response);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.plannedSet.count({ where: { sessionId: session.id } })).toBe(3);
    expect(await prisma.syncMutation.count({ where: { userId, status: "applied" } })).toBe(0);
    await noFacts(session.id);
  });

  it.each([-1, 1])(
    "new request date offset %i is readonly even if not completed",
    async (offset) => {
      const { session, source } = await fixture({ offset });
      await conflict(session.id, intent(source), "readonly");
    },
  );
  it("stale source raw revision is source_changed; performed and updatedAt alone do not stale it", async () => {
    const { session, source } = await fixture();
    const original = intent(source);
    await prisma.plannedSet.update({ where: { id: source.id }, data: { recommendedWeight: 60 } });
    await conflict(session.id, original, "source_changed");
    const fresh = await prisma.plannedSet.findUniqueOrThrow({ where: { id: source.id } });
    const payload = intent(fresh);
    await prisma.plannedSet.update({ where: { id: source.id }, data: { updatedAt: new Date() } });
    await post(session.id, payload).expect(201);
  });
  it.each([0, 5])("gap/out of sequence source setNo=%i is never renumbered", async (setNo) => {
    const { session, source } = await fixture();
    const changed = await prisma.plannedSet.update({ where: { id: source.id }, data: { setNo } });
    await conflict(session.id, intent(changed), "set_number_gap");
  });
  it.each([8, 9])(
    "two distinct append requests from the same fixed N=%i source respect atomic cap",
    async (count) => {
      const { session, source } = await fixture({ count });
      const responses = await Promise.all([
        post(session.id, intent(source)),
        post(session.id, intent(source)),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual(
        count === 8 ? [201, 201] : [201, 409],
      );
      if (count === 9)
        expect(responses.find((response) => response.status === 409)!.body.error.details).toEqual({
          reason: "set_cap_reached",
        });
      const rows = await prisma.plannedSet.findMany({
        where: { sessionId: session.id },
        orderBy: { setNo: "asc" },
      });
      expect(rows.map((row) => row.setNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      for (const created of rows.slice(count)) expect(rawCopy(created)).toEqual(rawCopy(source));
      expect(await prisma.syncMutation.count({ where: { userId, status: "applied" } })).toBe(
        10 - count,
      );
    },
  );
  it("same UUID concurrent request creates one row/receipt and both return identical identity", async () => {
    const { session, source } = await fixture();
    const payload = intent(source);
    const [a, b] = await Promise.all([post(session.id, payload), post(session.id, payload)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect(
      await prisma.plannedSet.count({ where: { clientCorrelationId: payload.correlation_id } }),
    ).toBe(1);
    expect(await prisma.syncMutation.count({ where: { id: payload.client_id } })).toBe(1);
  });
  it("successful replay reads current target before new date/source/cap guards", async () => {
    const { session, source } = await fixture({ count: 9 });
    const payload = intent(source);
    const first = await post(session.id, payload).expect(201);
    await prisma.plannedSet.update({
      where: { id: first.body.planned_set_id },
      data: { targetRir: 4, restSec: 155 },
    });
    await prisma.plannedSet.delete({ where: { id: source.id } });
    await prisma.workoutSession.update({
      where: { id: session.id },
      data: { scheduledDate: new Date(utcToday().getTime() - DAY) },
    });
    const replay = await post(session.id, payload).expect(201);
    expect(replay.body.planned_set_id).toBe(first.body.planned_set_id);
    expect(replay.body.planned_set).toMatchObject({ target_rir: 4, rest_sec: 155 });
    expect(replay.body.planned_set.source_revision).not.toBe(
      first.body.planned_set.source_revision,
    );
    expect(await prisma.syncMutation.count({ where: { id: payload.client_id } })).toBe(1);
  });
  it("same UUID changed payload and second creator correlation are distinct permanent conflicts", async () => {
    const { session, source } = await fixture();
    const payload = intent(source);
    await post(session.id, payload).expect(201);
    await conflict(
      session.id,
      { ...payload, correlation_id: randomUUID() },
      "idempotency_payload_mismatch",
    );
    await conflict(session.id, { ...payload, client_id: randomUUID() }, "correlation_mismatch");
  });
  it("target removal preserves receipt and prevents correlation resurrection", async () => {
    const { session, source } = await fixture();
    const payload = intent(source);
    const first = await post(session.id, payload).expect(201);
    await prisma.plannedSet.delete({ where: { id: first.body.planned_set_id } });
    await conflict(session.id, payload, "append_target_removed");
    await conflict(session.id, { ...payload, client_id: randomUUID() }, "correlation_mismatch");
    expect(
      await prisma.syncMutation.count({ where: { id: payload.client_id, status: "applied" } }),
    ).toBe(1);
  });
  it("correlation child copies the parent's creation revision; changed parent cannot be silently substituted", async () => {
    const { session, source } = await fixture();
    const parent = intent(source);
    const first = await post(session.id, parent).expect(201);
    const child = {
      client_id: randomUUID(),
      exercise_id: source.exerciseId,
      correlation_id: randomUUID(),
      source: { source_correlation_id: parent.correlation_id },
    };
    const created = await post(session.id, child).expect(201);
    expect(created.body.planned_set.set_no).toBe(5);
    await prisma.plannedSet.update({
      where: { id: first.body.planned_set_id },
      data: { recommendedWeight: 70 },
    });
    await conflict(
      session.id,
      { ...child, client_id: randomUUID(), correlation_id: randomUUID() },
      "source_changed",
    );
    expect((await post(session.id, child).expect(201)).body.planned_set_id).toBe(
      created.body.planned_set_id,
    );
  });
  it("unresolved parent persists pending identity only; changing pending intent cannot overwrite it", async () => {
    const { session, source } = await fixture();
    const payload = {
      client_id: randomUUID(),
      exercise_id: source.exerciseId,
      correlation_id: randomUUID(),
      source: { source_correlation_id: randomUUID() },
    };
    await conflict(session.id, payload, "unresolved_parent");
    const pending = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: payload.client_id },
    });
    expect(pending).toMatchObject({ status: "pending", appliedAt: null });
    expect(pending.payload).toEqual({
      exercise_id: payload.exercise_id,
      correlation_id: payload.correlation_id,
      source: payload.source,
    });
    await conflict(
      session.id,
      { ...payload, source: { source_correlation_id: randomUUID() } },
      "idempotency_payload_mismatch",
    );
    expect(
      await prisma.syncMutation.findUniqueOrThrow({ where: { id: payload.client_id } }),
    ).toEqual(pending);
    await noFacts(session.id);
  });
  it("foreign and missing sessions are indistinguishable404 with no owner/result disclosure", async () => {
    const { session, source } = await fixture({ owner: otherUserId });
    const payload = intent(source);
    const foreign = await post(session.id, payload);
    const missing = await post(randomUUID(), payload);
    expectErrorMatchesContract("post", PATH, 404, foreign);
    expectErrorMatchesContract("post", PATH, 404, missing);
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain(otherUserId);
    expect(await prisma.syncMutation.count({ where: { id: payload.client_id } })).toBe(0);
  });
});
