import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { RULES_BUNDLE_V2_SPLIT } from "shared";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { plannedSetResponse } from "../src/sync/sync.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import { createTestApp, resetUserData } from "./support/app";

describe("S2 cardio authoritative read and resistance mutation boundary", () => {
  let app: INestApplication, prisma: PrismaService, programs: ProgramsService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
  }, 60_000);
  afterAll(async () => app?.close());
  beforeEach(async () => resetUserData(prisma, devUserId()));
  async function fixture() {
    const result = await programs.generateWithRulesVersion(
      devUserId(),
      {
        goal: "hypertrophy",
        days_per_week: 4,
        minutes_per_day: 60,
        experience_level: "intermediate",
        equipment: ["bodyweight", "barbell", "dumbbell", "machine", "cable", "stationary_bike"],
        pain_areas: [],
      },
      RULES_BUNDLE_V2_SPLIT,
    );
    await programs.current(devUserId());
    const row = await prisma.plannedSet.findFirstOrThrow({
      where: { session: { programId: result.program_id }, exerciseId: "e_stationary_bike" },
      include: { exercise: true },
    });
    await prisma.workoutSession.update({
      where: { id: row.sessionId },
      data: { scheduledDate: utcToday() },
    });
    return row;
  }
  it("GET and sync projection preserve every cardio scalar, identity, intensity and fallback exactly", async () => {
    const row = await fixture();
    const get = await request(app.getHttpServer()).get(`/v1/sessions/${row.sessionId}`).expect(200);
    const wire = get.body.planned_sets.find((set: { id: string }) => set.id === row.id);
    expect(wire).toEqual(plannedSetResponse(row, 0, undefined, row.exercise));
    expect(wire).toMatchObject({
      prescription_kind: "steady_cardio",
      duration_sec: 600,
      rpe_scale_id: "relative_effort_0_10_v1",
      target_rpe_low: 5,
      target_rpe_high: 6,
      source_day: "FRI",
      source_ordinal: 4,
      intensity_seconds: { moderate: 600, high: 0, recovery: 0 },
      recommendation_state: "ready",
      append_eligibility: null,
      load_kind: "not_applicable",
    });
    for (const key of [
      "target_reps_low",
      "target_reps_high",
      "target_rir",
      "rest_sec",
      "target_time_low_sec",
      "target_time_high_sec",
      "recommended_weight",
      "recommended_reps",
      "confidence",
      "reason_code",
      "load_semantics",
      "assistance_provenance",
      "recommended_action",
      "assistance_safety_status",
      "performed_set",
    ])
      expect(wire[key]).toBeNull();
    expect(wire).not.toHaveProperty("recommendation");
    expect(await prisma.plannedSet.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
      (({ exercise: _exercise, ...stored }) => stored)(row),
    );
  });
  it("rejects cardio append, swap and removal without changing its raw row", async () => {
    const row = await fixture();
    const before = await prisma.plannedSet.findMany({
      where: { sessionId: row.sessionId },
      orderBy: { id: "asc" },
    });
    await request(app.getHttpServer())
      .post(`/v1/sessions/${row.sessionId}/sets`)
      .send({
        client_id: randomUUID(),
        correlation_id: randomUUID(),
        exercise_id: row.exerciseId,
        source: { source_planned_set_id: row.id, source_revision: sourceRevision(row) },
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v1/sessions/${row.sessionId}/exercises/${row.exerciseId}/swap`)
      .send({ to_exercise_id: "e_plank" })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${row.sessionId}/exercises/${row.exerciseId}`)
      .expect(400);
    expect(
      await prisma.plannedSet.findMany({
        where: { sessionId: row.sessionId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });
  it("sync rejects performed and routine writes while leaving cardio unchanged", async () => {
    const row = await fixture();
    const before = await prisma.plannedSet.findMany({
      where: { sessionId: row.sessionId },
      orderBy: { id: "asc" },
    });
    const mutations = [
      {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: row.id,
        op: "upsert",
        updated_at: new Date().toISOString(),
        payload: { actual_time_sec: 600, completed: true },
      },
      {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: row.sessionId,
        op: "upsert",
        updated_at: new Date().toISOString(),
        payload: { exercise_ids: ["e_plank"] },
      },
    ];
    const result = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ since: null, mutations })
      .expect(200);
    expect(result.body.applied).toEqual([]);
    expect(result.body.conflicts.map((item: { reason: string }) => item.reason)).toEqual([
      "validation_failed",
      "validation_failed",
    ]);
    expect(await prisma.performedSet.count({ where: { plannedSetId: row.id } })).toBe(0);
    expect(
      await prisma.plannedSet.findMany({
        where: { sessionId: row.sessionId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });
  it("cross-validates a resistance-shaped legacy row against actual cardio catalog before append", async () => {
    const row = await fixture();
    const counterfeit = await prisma.plannedSet.create({
      data: {
        sessionId: row.sessionId,
        exerciseId: row.exerciseId,
        setNo: 2,
        orderIndex: 99,
        targetTimeLowSec: 30,
        targetTimeHighSec: 60,
        restSec: 90,
        reasonCode: "BASELINE",
        confidence: 0.5,
        rulesVersion: "2026.08.1",
        loadSemantics: "external_load",
      },
    });
    const get = await request(app.getHttpServer()).get(`/v1/sessions/${row.sessionId}`).expect(200);
    expect(
      get.body.planned_sets.find((set: { id: string }) => set.id === counterfeit.id)
        .recommendation_state,
    ).toBe("unavailable");
    await request(app.getHttpServer())
      .post(`/v1/sessions/${row.sessionId}/sets`)
      .send({
        client_id: randomUUID(),
        correlation_id: randomUUID(),
        exercise_id: row.exerciseId,
        source: {
          source_planned_set_id: counterfeit.id,
          source_revision: sourceRevision(counterfeit),
        },
      })
      .expect(400);
    expect(
      await prisma.plannedSet.count({
        where: { sessionId: row.sessionId, exerciseId: row.exerciseId },
      }),
    ).toBe(2);
  });
  it.each(["2026.08.1", "2026.09.0", "2026.09.1"])(
    "raw resistance discriminator obeys %s wire contract in GET and sync",
    async (rulesVersion) => {
      const cardio = await fixture();
      const raw = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: cardio.sessionId, loadSemantics: { not: null } },
      });
      const row = await prisma.plannedSet.update({
        where: { id: raw.id },
        data: { prescriptionKind: "resistance", rulesVersion },
        include: { exercise: true },
      });
      const get = await request(app.getHttpServer())
        .get(`/v1/sessions/${row.sessionId}`)
        .expect(200);
      const wire = get.body.planned_sets.find((set: { id: string }) => set.id === row.id);
      const sync = plannedSetResponse(row, 0, undefined, row.exercise);
      for (const value of [wire, sync]) {
        if (rulesVersion === "2026.08.1") expect(value).not.toHaveProperty("prescription_kind");
        else expect(value.prescription_kind).toBe("resistance");
      }
      expect(
        (await prisma.plannedSet.findUniqueOrThrow({ where: { id: row.id } })).prescriptionKind,
      ).toBe("resistance");
    },
  );
});
