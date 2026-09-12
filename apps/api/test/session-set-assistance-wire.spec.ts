/** M4/G3 real append wire matrix. Only main runs the ordinary owned DB hooks.
 * Count: 80 assistance + 8 external assisted IDs + 4 bodyweight/time + 32 raw + 12 cohort.
 * Database constraints stay enabled. Impossible metadata combinations remain pure-only.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, type PlannedSet } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import type { PlannedSetResponse } from "../src/sessions/sessions.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";

const USER = devUserId();
const DAY = 86_400_000;
const IDS = ["e_assisted_pullup", "e_assisted_dips"] as const;
const SAMPLES = [0, 1, 2, 3] as const;
const PATH = "/sessions/{id}/sets";
type Raw = Partial<Prisma.PlannedSetCreateManyInput>;
type Scenario = {
  name: string;
  raw: Raw;
  state: PlannedSetResponse["recommendation_state"];
  load: PlannedSetResponse["load_kind"];
  safety: PlannedSetResponse["assistance_safety_status"];
  action?: PlannedSetResponse["recommended_action"];
  performed?: boolean;
  sibling?: Raw;
  invalid?: boolean;
};
const assistance: Raw = {
  loadSemantics: "assistance",
  assistanceProvenance: "native",
  assistanceStepKg: 2.5,
  rulesVersion: "2026.08.2",
  recommendedWeight: 20,
  reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
};
const copyFields = [
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
const rawCopy = (row: PlannedSet) => Object.fromEntries(copyFields.map((key) => [key, row[key]]));

const assistanceStates: Scenario[] = [
  { name: "positive", raw: {}, state: "ready", load: "assistance", safety: "safe" },
  {
    name: "minimum performed source",
    raw: { reasonCode: "ASSISTANCE_MINIMUM_REACHED", recommendedWeight: 2.5 },
    state: "ready",
    load: "assistance",
    safety: "safe",
    performed: true,
  },
  {
    name: "calibration null",
    raw: { reasonCode: "ASSISTANCE_CALIBRATION_NEEDED", recommendedWeight: null },
    state: "load_calibration_needed",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "pain null",
    raw: { reasonCode: "SUBSTITUTE_PAIN", recommendedWeight: null },
    state: "substitution_required",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "invalid null",
    raw: { reasonCode: "INVALID_INPUT", recommendedWeight: null },
    state: "unavailable",
    load: "assistance",
    safety: "safe",
  },
];
const allowedAssistance = IDS.flatMap((exerciseId) =>
  (["native", "remediated"] as const).flatMap((provenance) =>
    assistanceStates.flatMap((scenario) =>
      SAMPLES.map((sample) => ({
        ...scenario,
        name: `${exerciseId} ${provenance} ${scenario.name} sample${sample}`,
        sample,
        raw: { ...assistance, exerciseId, assistanceProvenance: provenance, ...scenario.raw },
        action:
          scenario.raw.reasonCode === "ASSISTANCE_MINIMUM_REACHED"
            ? {
                kind: "suggest_exercise_swap" as const,
                exercise_id: exerciseId === IDS[0] ? "e_pullup" : "e_dips",
              }
            : null,
      })),
    ),
  ),
);
const externalAssisted = IDS.flatMap((exerciseId) =>
  SAMPLES.map((sample) => ({
    name: `${exerciseId} external snapshot sample${sample}`,
    sample,
    // A known assisted ID and minimum reason must not turn an external snapshot into assistance.
    raw: { exerciseId, reasonCode: "ASSISTANCE_MINIMUM_REACHED" },
    state: "ready" as const,
    load: "external" as const,
    safety: null,
  })),
);
const otherAxes: Scenario[] = [
  {
    name: "bodyweight",
    raw: { exerciseId: "e_pushup", recommendedWeight: null },
    state: "ready",
    load: "bodyweight",
    safety: null,
  },
  {
    name: "time",
    state: "ready",
    load: "not_applicable",
    safety: null,
    raw: {
      exerciseId: "e_plank",
      recommendedWeight: null,
      recommendedReps: null,
      targetRepsLow: null,
      targetRepsHigh: null,
      targetRir: null,
      targetTimeLowSec: 35,
      targetTimeHighSec: 65,
    },
  },
];
const rawRejected: Scenario[] = [
  {
    name: "Ssafe Cunsafe ready zero",
    raw: { recommendedWeight: 0 },
    state: "ready",
    load: "assistance",
    safety: "safe",
    performed: true,
  },
  {
    name: "Ssafe Cunsafe ready null",
    raw: { recommendedWeight: null },
    state: "ready",
    load: "assistance",
    safety: "safe",
    performed: true,
  },
  {
    name: "Ssafe Cunsafe BASELINE positive",
    raw: { reasonCode: "BASELINE" },
    state: "ready",
    load: "assistance",
    safety: "safe",
    performed: true,
  },
  {
    name: "Sunperformed unsafe ready zero",
    raw: { recommendedWeight: 0 },
    state: "ready",
    load: "assistance",
    safety: "unsafe",
  },
  {
    name: "pain with raw weight",
    raw: { reasonCode: "SUBSTITUTE_PAIN" },
    state: "substitution_required",
    load: "assistance",
    safety: "unsafe",
    performed: true,
  },
  {
    name: "invalid with raw weight",
    raw: { reasonCode: "INVALID_INPUT" },
    state: "unavailable",
    load: "assistance",
    safety: "unsafe",
  },
  {
    name: "legacy performed reader safe append blocked",
    raw: { assistanceProvenance: "legacy_performed", rulesVersion: "2026.08.1" },
    state: "ready",
    load: "assistance",
    safety: "safe",
    performed: true,
  },
  {
    name: "invalid raw reps range",
    raw: { targetRepsLow: 13, targetRepsHigh: 7 },
    state: "ready",
    load: "assistance",
    safety: "safe",
    invalid: true,
  },
];
const cohortRejected: Scenario[] = [
  {
    name: "mixed semantics",
    sibling: { loadSemantics: "external_load", assistanceProvenance: null, assistanceStepKg: null },
    raw: {},
    state: "ready",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "mixed provenance",
    sibling: { assistanceProvenance: "remediated" },
    raw: {},
    state: "ready",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "mixed known version",
    sibling: { rulesVersion: "2026.09.0" },
    raw: {},
    state: "ready",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "mixed step",
    sibling: { assistanceStepKg: 5 },
    raw: {},
    state: "ready",
    load: "assistance",
    safety: "safe",
  },
  {
    name: "external unknown version",
    raw: {
      loadSemantics: "external_load",
      assistanceProvenance: null,
      assistanceStepKg: null,
      rulesVersion: "unknown-wire-fixture",
      reasonCode: "BASELINE",
    },
    state: "ready",
    load: "external",
    safety: null,
  },
  {
    name: "nonpositive step",
    raw: { assistanceStepKg: 0 },
    state: "ready",
    load: "assistance",
    safety: "safe",
  },
];

describe("M4 G3 assistance append actual HTTP wire matrix", () => {
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

  async function fixture(scenario: Scenario, sample: number) {
    const exerciseId = scenario.raw.exerciseId ?? IDS[0];
    const program = await prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.2",
        startedAt: utcToday(),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [
          { day: "MON", focus: "upper", exercises: [{ exercise_id: exerciseId, sets: 1 }] },
        ],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "scheduled",
      },
    });
    const base = {
      exerciseId,
      orderIndex: 2,
      setNo: 1,
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
      loadSemantics: "external_load" as const,
      assistanceStepKg: null,
      assistanceProvenance: null,
    };
    const source = await prisma.plannedSet.create({
      data: { ...base, ...scenario.raw, sessionId: session.id },
    });
    if (scenario.sibling)
      await prisma.plannedSet.create({
        data: { ...base, ...scenario.raw, ...scenario.sibling, sessionId: session.id, setNo: 2 },
      });
    const createFact = (row: PlannedSet, performedAt: Date) =>
      prisma.performedSet.create({
        data: {
          plannedSetId: row.id,
          clientId: randomUUID(),
          performedAt,
          completed: true,
          actualWeight:
            row.targetTimeHighSec !== null || row.recommendedWeight === null ? null : 10,
          actualReps: row.targetTimeHighSec !== null ? null : 10,
          actualRir: row.targetTimeHighSec !== null ? null : 2,
          actualTimeSec: row.targetTimeHighSec !== null ? 45 : null,
        },
      });
    // Actual target facts are independent from the completed-session sample count.
    const sourceFact = scenario.performed ? await createFact(source, utcToday()) : null;
    for (let index = 0; index < sample; index++) {
      const date = new Date(utcToday().getTime() - (index + 1) * DAY);
      const history = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: date,
          focus: "upper",
          status: "completed",
          completedAt: date,
          sessionFeedback: { difficulty: "moderate", pump: "high" },
        },
      });
      // Multiple completed facts in ONE session must still contribute only one sample.
      for (const setNo of [1, 2]) {
        const axes =
          scenario.load === "not_applicable"
            ? {
                recommendedWeight: null,
                recommendedReps: null,
                targetRepsLow: null,
                targetRepsHigh: null,
                targetRir: null,
                targetTimeLowSec: 35,
                targetTimeHighSec: 65,
              }
            : scenario.load === "bodyweight"
              ? { recommendedWeight: null }
              : {};
        const row = await prisma.plannedSet.create({
          data: { ...base, ...axes, sessionId: history.id, setNo },
        });
        await createFact(row, date);
      }
    }
    expect(
      await prisma.workoutSession.count({ where: { programId: program.id, status: "completed" } }),
    ).toBe(sample);
    expect(
      await prisma.performedSet.count({
        where: { plannedSet: { session: { programId: program.id } } },
      }),
    ).toBe(sample * 2 + Number(Boolean(sourceFact)));
    return { session, source, sourceFact };
  }

  async function preservedState() {
    const owner = { session: { program: { userId: USER } } };
    return {
      rows: await prisma.plannedSet.findMany({ where: owner, orderBy: { id: "asc" } }),
      facts: await prisma.performedSet.findMany({
        where: { plannedSet: owner },
        orderBy: { id: "asc" },
      }),
      audits: await prisma.assistanceAudit.findMany({
        where: { plannedSet: owner },
        orderBy: { id: "asc" },
      }),
      programs: await prisma.program.findMany({ where: { userId: USER }, orderBy: { id: "asc" } }),
      sessions: await prisma.workoutSession.findMany({
        where: { program: { userId: USER } },
        orderBy: { id: "asc" },
      }),
      calibration: await prisma.userRirCalibration.findMany({ where: { userId: USER } }),
      e1rm: await prisma.estimated1rm.findMany({ where: { userId: USER } }),
      volume: await prisma.muscleWeeklyLoad.findMany({ where: { userId: USER } }),
    };
  }
  function intent(source: PlannedSet): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "session_set",
      entity_id: source.sessionId,
      op: "upsert",
      updated_at: "2026-08-14T08:00:00.000Z",
      payload: {
        exercise_id: source.exerciseId,
        correlation_id: randomUUID(),
        source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
      },
    };
  }
  const direct = (mutation: MutationDto) =>
    request(app.getHttpServer())
      .post(`/v1/sessions/${mutation.entity_id}/sets`)
      .send({ client_id: mutation.client_id, ...mutation.payload });
  async function sync(mutation: MutationDto) {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [mutation] })
      .expect(200);
    expectMatchesContract("post", "/sync", 200, response.body);
    return response.body as {
      applied: string[];
      conflicts: { client_id: string; reason: string }[];
      planned_set_mappings: {
        correlation_id: string;
        planned_set_id: string;
        planned_set: PlannedSetResponse;
      }[];
    };
  }
  async function get(sessionId: string) {
    const response = await request(app.getHttpServer())
      .get(`/v1/sessions/${sessionId}`)
      .expect(200);
    expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
    return response.body.planned_sets as PlannedSetResponse[];
  }
  function expectProjection(
    wire: PlannedSetResponse,
    raw: PlannedSet,
    scenario: Scenario,
    sample: number,
    eligibility: "allowed" | "blocked" | null,
  ) {
    expect(wire).toMatchObject({
      id: raw.id,
      exercise_id: raw.exerciseId,
      set_no: raw.setNo,
      correlation_id: raw.clientCorrelationId,
      source_revision: sourceRevision(raw),
      target_reps_low: raw.targetRepsLow,
      target_reps_high: raw.targetRepsHigh,
      target_time_low_sec: raw.targetTimeLowSec,
      target_time_high_sec: raw.targetTimeHighSec,
      target_rir: raw.targetRir,
      rest_sec: raw.restSec,
      load_kind: scenario.load,
      rules_version: raw.rulesVersion,
      assistance_provenance: raw.assistanceProvenance,
      assistance_safety_status: scenario.safety,
      recommendation_gate: sample === 0 ? "no_history" : sample < 3 ? "early" : "ready",
      // Prescriptions are independent of analysis maturity (ADR-70).
      recommended_weight: raw.recommendedWeight === null ? null : Number(raw.recommendedWeight),
      recommended_reps: raw.recommendedReps,
      reason_code: raw.reasonCode,
      confidence: sample < 3 ? null : Number(raw.confidence),
      recommendation_state: scenario.state,
      recommended_action: scenario.action ?? null,
    });
    if (eligibility === null) expect(wire.append_eligibility).toBeNull();
    else {
      expect(wire.append_eligibility).toEqual({
        version: 1,
        source_revision: sourceRevision(raw),
        cohort_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: eligibility,
        reason: eligibility === "allowed" ? null : "unsafe_assistance_snapshot",
      });
    }
  }

  async function allowed(scenario: Scenario, sample: number) {
    const { session, source, sourceFact } = await fixture(scenario, sample);
    const before = await preservedState();
    const sourceWire = (await get(session.id)).find((row) => row.id === source.id)!;
    expectProjection(sourceWire, source, scenario, sample, "allowed");
    expect(sourceWire.performed_set).toEqual(
      sourceFact
        ? {
            actual_weight: 10,
            actual_reps: 10,
            actual_rir: 2,
            actual_time_sec: null,
            completed: true,
            performed_at: sourceFact.performedAt.toISOString(),
          }
        : null,
    );
    const first = intent(source);
    const transport = JSON.stringify(first);
    const response = await direct(first).expect(201);
    expectMatchesContract("post", PATH, 201, response.body);
    const id = response.body.planned_set_id as string;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(id).not.toBe(source.id);
    const copied = await prisma.plannedSet.findUniqueOrThrow({ where: { id } });
    expect(rawCopy(copied)).toEqual(rawCopy(source));
    expect(copied).toMatchObject({
      sessionId: session.id,
      exerciseId: source.exerciseId,
      setNo: 2,
      clientCorrelationId: first.payload.correlation_id,
    });
    expect(response.body).toMatchObject({
      client_id: first.client_id,
      session_id: session.id,
      correlation_id: first.payload.correlation_id,
      planned_set_id: id,
    });
    expectProjection(response.body.planned_set, copied, scenario, sample, "allowed");
    expect(response.body.planned_set.performed_set).toBeNull();
    const firstGet = (await get(session.id)).find((row) => row.id === id)!;
    expect(firstGet).toEqual(response.body.planned_set);
    expect(firstGet.append_eligibility!.cohort_revision).not.toBe(
      sourceWire.append_eligibility!.cohort_revision,
    );
    const replay = await sync(first);
    expect(replay.applied).toEqual([first.client_id]);
    expect(replay.conflicts).toEqual([]);
    expect(replay.planned_set_mappings).toEqual([
      { correlation_id: first.payload.correlation_id, planned_set_id: id, planned_set: firstGet },
    ]);
    const second = intent(source);
    const created = await sync(second);
    expect(created.applied).toEqual([second.client_id]);
    expect(created.conflicts).toEqual([]);
    expect(created.planned_set_mappings).toHaveLength(1);
    const mapping = created.planned_set_mappings[0];
    const copiedAgain = await prisma.plannedSet.findUniqueOrThrow({
      where: { id: mapping.planned_set_id },
    });
    expect(new Set([source.id, copied.id, copiedAgain.id]).size).toBe(3);
    expect(rawCopy(copiedAgain)).toEqual(rawCopy(source));
    expect(copiedAgain).toMatchObject({
      sessionId: session.id,
      exerciseId: source.exerciseId,
      setNo: 3,
      clientCorrelationId: second.payload.correlation_id,
    });
    expect(mapping.correlation_id).toBe(second.payload.correlation_id);
    expectProjection(mapping.planned_set, copiedAgain, scenario, sample, "allowed");
    expect(mapping.planned_set.performed_set).toBeNull();
    const finalRows = await get(session.id);
    expect(finalRows).toHaveLength(3);
    expect(finalRows.find((row) => row.id === copiedAgain.id)).toEqual(mapping.planned_set);
    // Membership changed the cohort token, never the original raw source token.
    const finalSource = finalRows.find((row) => row.id === source.id)!;
    expectProjection(finalSource, source, scenario, sample, "allowed");
    expect(finalSource.performed_set).toEqual(sourceWire.performed_set);
    expect(finalSource.append_eligibility!.cohort_revision).toBe(
      mapping.planned_set.append_eligibility!.cohort_revision,
    );
    expect(finalSource.append_eligibility!.cohort_revision).not.toBe(
      firstGet.append_eligibility!.cohort_revision,
    );
    expect(JSON.stringify(first)).toBe(transport);
    for (const mutation of [first, second]) {
      const receipt = await prisma.syncMutation.findUniqueOrThrow({
        where: { id: mutation.client_id },
      });
      expect(receipt).toMatchObject({
        userId: USER,
        entityType: "session_set",
        entityId: session.id,
        status: "applied",
        payload: mutation.payload,
      });
      expect(receipt.payload).toEqual(mutation.payload); // Identity-only original payload; no copied health fields.
      const target = mutation === first ? copied : copiedAgain;
      const resultIdentity = {
        correlation_id: mutation.payload.correlation_id,
        session_id: session.id,
        exercise_id: source.exerciseId,
        planned_set_id: target.id,
        creation_revision: sourceRevision(target),
        source_planned_set_id: source.id,
        source_revision: sourceRevision(source),
      };
      expect(receipt.requestIdentity).toEqual({ session_id: session.id, ...mutation.payload });
      expect(receipt.resultIdentity).toEqual(resultIdentity);
      expect(receipt.correlationClaims).toEqual([resultIdentity]);
      expect(receipt.dependencyIdentity).toBeNull();
      expect(receipt.tombstoneIdentity).toBeNull();
    }
    expect(await prisma.syncMutation.count({ where: { userId: USER } })).toBe(2);
    const after = await preservedState();
    expect(after.rows.filter((row) => row.id !== copied.id && row.id !== copiedAgain.id)).toEqual(
      before.rows,
    );
    expect(after.rows).toHaveLength(before.rows.length + 2);
    const { rows: _beforeRows, ...beforeUnchanged } = before;
    const { rows: _afterRows, ...afterUnchanged } = after;
    expect(afterUnchanged).toEqual(beforeUnchanged);
    expect(after.audits).toEqual([]);
    expect(after.calibration).toEqual([]);
    expect(after.e1rm).toEqual([]);
    expect(after.volume).toEqual([]);
  }

  it.each(allowedAssistance)("allowed assistance $name", async (scenario) =>
    allowed(scenario, scenario.sample),
  );
  it.each(externalAssisted)("external assisted ID $name", async (scenario) =>
    allowed(scenario, scenario.sample),
  );
  it.each(
    otherAxes.flatMap((scenario) =>
      [0, 3].map((sample) => ({ ...scenario, sample, name: `${scenario.name} sample${sample}` })),
    ),
  )("other load axis $name", async (scenario) => allowed(scenario, scenario.sample));

  async function rejected(scenario: Scenario, sample: number) {
    const { session, source, sourceFact } = await fixture(scenario, sample);
    const before = await preservedState();
    const wire = (await get(session.id)).find((row) => row.id === source.id)!;
    expectProjection(wire, source, scenario, sample, scenario.invalid ? null : "blocked");
    expect(wire.performed_set).toEqual(
      sourceFact
        ? {
            actual_weight:
              sourceFact.actualWeight === null ? null : Number(sourceFact.actualWeight),
            actual_reps: sourceFact.actualReps,
            actual_rir: sourceFact.actualRir,
            actual_time_sec: sourceFact.actualTimeSec,
            completed: true,
            performed_at: sourceFact.performedAt.toISOString(),
          }
        : null,
    );
    const first = intent(source);
    const response = await direct(first);
    if (scenario.invalid) expectErrorMatchesContract("post", PATH, 400, response);
    else {
      expectErrorMatchesContract("post", PATH, 409, response);
      expect(response.body.error.details).toEqual({ reason: "unsafe_assistance_snapshot" });
    }
    // A distinct sync intent executes its own guard; it cannot pass using a direct receipt replay.
    const second = intent(source);
    const result = await sync(second);
    expect(result.applied).toEqual([]);
    expect(result.planned_set_mappings).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      client_id: second.client_id,
      reason: scenario.invalid ? "validation_failed" : "unsafe_assistance_snapshot",
    });
    const receipt = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: second.client_id },
    });
    expect(receipt).toMatchObject({ status: "conflict", payload: second.payload });
    expect(receipt.payload).toEqual(second.payload);
    expect(await get(session.id)).toContainEqual(wire);
    expect(await preservedState()).toEqual(before);
  }
  it.each(
    rawRejected.flatMap((scenario, index) =>
      SAMPLES.map((sample) => ({
        ...scenario,
        raw: { ...assistance, exerciseId: IDS[index % 2], ...scenario.raw },
        sample,
        name: `${scenario.name} sample${sample}`,
      })),
    ),
  )("raw rejected $name", async (scenario) => rejected(scenario, scenario.sample));
  it.each(
    cohortRejected.flatMap((scenario, index) =>
      [0, 3].map((sample) => ({
        ...scenario,
        raw: { ...assistance, exerciseId: IDS[index % 2], ...scenario.raw },
        sample,
        name: `${scenario.name} sample${sample}`,
      })),
    ),
  )("cohort rejected $name", async (scenario) => rejected(scenario, scenario.sample));
});
