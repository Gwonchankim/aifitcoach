import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { recommendNextSet, applyDisplayGate, displayGateState } from "shared";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { encryptNumber } from "../src/common/crypto/field-encryption";
import { PrismaService } from "../src/prisma/prisma.service";
import { PlannedSetFactory, targetFor } from "../src/programs/planned-set.factory";
import {
  RecommendationService,
  requireHistory,
} from "../src/recommendation/recommendation.service";
import { rawAssistanceSafetyStatus, toRawTargetRow } from "../src/programs/assistance-migration";
import { plannedSetResponse } from "../src/sync/sync.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = ["e_assisted_pullup", "e_assisted_dips"] as const;
const EXTERNAL = "e_chest_press_machine";

function evidence(name: string, value: unknown) {
  if (process.env.AFC_ASSISTANCE_REPORT_DIR)
    writeFileSync(
      path.join(process.env.AFC_ASSISTANCE_REPORT_DIR, `${name}.json`),
      JSON.stringify(value, null, 2),
    );
}

describe("assisted dips actual API metadata, history and analytics", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recommendations: RecommendationService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    recommendations = app.get(RecommendationService);
  }, 60_000);
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, USER_ID);
    } finally {
      await app?.close();
    }
  });
  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  async function program() {
    return prisma.program.create({
      data: {
        userId: USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 3,
        minutesPerDay: 60,
        splitType: "full_body",
        rulesVersion: "2026.08.1",
        startedAt: utcToday(),
        totalWeeks: 12,
        status: "active",
        generationInput: {},
        template: [],
        excludedExercises: [],
      },
    });
  }
  async function session(programId: string, offset: number, completed = true) {
    const date = new Date(utcToday().getTime() + offset * 86400000);
    return prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: date,
        focus: "full_body",
        status: completed ? "completed" : "scheduled",
        completedAt: completed ? date : null,
      },
    });
  }
  async function fact(
    sessionId: string,
    exerciseId: string,
    weight: number,
    options: {
      pain?: number;
      invalid?: boolean;
      legacy?: boolean;
      orderIndex?: number;
    } = {},
  ) {
    const assistance = exerciseId !== EXTERNAL;
    const planned = await prisma.plannedSet.create({
      data: {
        sessionId,
        exerciseId,
        orderIndex: options.orderIndex ?? 0,
        setNo: 1,
        targetRepsLow: 6,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 120,
        recommendedReps: 6,
        recommendedWeight: weight,
        confidence: 0.85,
        reasonCode: assistance
          ? options.legacy
            ? "WEIGHT_UP_REP_TARGET_MET"
            : "ASSISTANCE_MINIMUM_REACHED"
          : "BASELINE",
        rulesVersion: assistance && !options.legacy ? "2026.08.2" : "2026.08.1",
        loadSemantics: assistance ? "assistance" : "external_load",
        ...(assistance
          ? {
              assistanceStepKg: 2.5,
              assistanceProvenance: options.legacy ? "legacy_performed" : "native",
            }
          : {}),
      },
    });
    await prisma.performedSet.create({
      data: {
        plannedSetId: planned.id,
        actualWeight: options.invalid ? null : weight,
        actualReps: 12,
        actualRir: 2,
        completed: true,
        clientId: randomUUID(),
        performedAt: utcToday(),
        ...(options.pain === undefined ? {} : { painScore: encryptNumber(options.pain) }),
      },
    });
    return planned;
  }

  it("actual add and explicit swap create native dips snapshots without changing history", async () => {
    const p = await program();
    const today = await session(p.id, 0, false);
    await request(app.getHttpServer())
      .post(`/v1/sessions/${today.id}/exercises`)
      .send({ exercise_id: EXTERNAL, sets: 1 })
      .expect(200);
    const assertDips = async () => {
      const rows = await prisma.plannedSet.findMany({
        where: { sessionId: today.id, exerciseId: "e_assisted_dips" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].loadSemantics).toBe("assistance");
      expect(Number(rows[0].assistanceStepKg)).toBe(2.5);
      expect(rows[0].assistanceProvenance).toBe("native");
      expect(rows[0].rulesVersion).toBe("2026.08.2");
      expect(rows[0].recommendedWeight).toBeNull();
      expect(rows[0].reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");
      expect(rawAssistanceSafetyStatus(toRawTargetRow(rows[0], false))).toBe("safe");
    };
    await request(app.getHttpServer())
      .post(`/v1/sessions/${today.id}/exercises`)
      .send({ exercise_id: "e_assisted_dips", sets: 1 })
      .expect(200);
    await assertDips();
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${today.id}/exercises/e_assisted_dips`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/sessions/${today.id}/exercises/${EXTERNAL}/swap`)
      .send({ to_exercise_id: "e_assisted_dips" })
      .expect(200);
    await assertDips();
    expect(
      await prisma.performedSet.count({ where: { plannedSet: { sessionId: today.id } } }),
    ).toBe(0);
  });

  it.each(ASSISTED.flatMap((id) => [0, 1, 2, 3].map((count) => [id, count] as const)))(
    "%s sample %i: shared raw → service → persisted → GET/sync/analytics preserves numbers and action gate",
    async (id, count) => {
      const p = await program();
      let sourceId: string | undefined;
      for (let n = 0; n < count; n++) {
        const s = await session(p.id, n - count);
        await fact(s.id, id, 2.5);
        sourceId = s.id;
      }
      const exercise = await prisma.exercise.findUniqueOrThrow({ where: { id } });
      const history = requireHistory(
        await recommendations.prefetchHistories(USER_ID, [
          { exerciseId: id, loadSemantics: "assistance" },
        ]),
        id,
      );
      const target = targetFor("hypertrophy", exercise);
      const calibration = await recommendations.calibrationFor(USER_ID);
      const oracle = recommendNextSet({
        goal: "hypertrophy",
        exercise: {
          id,
          type: exercise.mechanic,
          region: exercise.region,
          metric: exercise.metric,
          step_kg: 2.5,
          load_semantics: "assistance",
        },
        target,
        last_sets: history.lastSets,
        assistance: history.assistance,
        ...(calibration ? { calibration } : {}),
        rules_version: "2026.08.2",
      });
      expect(
        recommendations.recommend({ goal: "hypertrophy", exercise, target, history, calibration }),
      ).toEqual(oracle);
      expect(oracle.weight).toBe(count === 0 ? null : 2.5);
      expect(oracle.recommended_action ?? null).toEqual(
        count === 0
          ? null
          : {
              kind: "suggest_exercise_swap",
              exercise_id: id === "e_assisted_dips" ? "e_dips" : "e_pullup",
            },
      );
      const next = await session(p.id, 0, false);
      const rows = await app.get(PlannedSetFactory).build({
        userId: USER_ID,
        goal: "hypertrophy",
        exercise,
        orderIndex: 0,
        sets: 1,
        history,
        calibration,
      });
      await prisma.plannedSet.createMany({
        data: rows.map((row) => ({ ...row, sessionId: next.id })),
      });
      if (sourceId) {
        const completed = await request(app.getHttpServer())
          .post(`/v1/sessions/${sourceId}/complete`)
          .send({})
          .expect(200);
        const item = completed.body.next_recommendations.find(
          (row: { exercise_id: string }) => row.exercise_id === id,
        );
        expect(item.sample_session_count).toBe(count);
        expect(item.gate_state).toBe(displayGateState(count));
        expect(item.recommendation).toEqual(
          applyDisplayGate(count, recommendations.toApi(id, 1, oracle)),
        );
      }
      const row = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId: next.id } });
      expect(row.loadSemantics).toBe("assistance");
      expect(Number(row.assistanceStepKg)).toBe(2.5);
      expect(row.assistanceProvenance).toBe("native");
      expect(row.rulesVersion).toBe("2026.08.2");
      expect(row.recommendedWeight === null ? null : Number(row.recommendedWeight)).toBe(
        oracle.weight,
      );
      expect(row.recommendedReps).toBe(oracle.reps_low);
      expect(row.reasonCode).toBe(oracle.reason_code);
      expect(Number(row.confidence)).toBe(oracle.confidence);
      const persisted = recommendations.plannedToApi(id, 1, row);
      expect(persisted).toEqual(recommendations.toApi(id, 1, oracle));
      const snapshot = await prisma.plannedSet.findMany({
        where: { session: { programId: p.id } },
        orderBy: { id: "asc" },
        include: { performedSets: true },
      });
      const get = await request(app.getHttpServer()).get(`/v1/sessions/${next.id}`).expect(200);
      const wire = get.body.planned_sets[0];
      const sync = plannedSetResponse(row, count);
      for (const key of [
        "recommended_weight",
        "recommended_reps",
        "reason_code",
        "confidence",
        "recommendation_state",
        "recommended_action",
        "load_kind",
        "assistance_provenance",
        "rules_version",
        "assistance_safety_status",
        "recommendation_gate",
      ])
        expect(wire[key]).toEqual(sync[key as keyof typeof sync]);
      expect(wire.recommended_action).toEqual(
        applyDisplayGate(count, oracle.recommended_action ?? null),
      );
      expect(wire.assistance_safety_status).toBe(
        rawAssistanceSafetyStatus(toRawTargetRow(row, false)),
      );
      expect(wire.assistance_safety_status).toBe("safe");
      const analytics = await request(app.getHttpServer())
        .get(`/v1/analytics/e1rm?exercise_id=${id}`)
        .expect(200);
      expect(analytics.body.sample_session_count).toBe(count);
      expect(analytics.body.next_recommendation).toEqual(applyDisplayGate(count, persisted));
      evidence(`${id}-sample-${count}`, {
        id,
        count,
        history,
        oracle,
        persisted,
        raw: row,
        get: wire,
        sync,
        analytics: analytics.body,
      });
      expect(
        await prisma.plannedSet.findMany({
          where: { session: { programId: p.id } },
          orderBy: { id: "asc" },
          include: { performedSets: true },
        }),
      ).toEqual(snapshot);
    },
  );

  it.each(ASSISTED.flatMap((id) => ["pain", "invalid"].map((mode) => [id, mode] as const)))(
    "%s latest %s stays fail-closed while lifetime graduation and the sibling history remain independent",
    async (id, mode) => {
      const p = await program();
      const old = await session(p.id, -3);
      await fact(old.id, id, 20, { legacy: true });
      const legacy = await prisma.plannedSet.findMany({
        where: { sessionId: old.id },
        include: { performedSets: true },
      });
      const latest = await session(p.id, -1);
      await fact(latest.id, id, 2.5, mode === "pain" ? { pain: 5 } : { invalid: true });
      const histories = await recommendations.prefetchHistories(
        USER_ID,
        ASSISTED.map((exerciseId) => ({ exerciseId, loadSemantics: "assistance" })),
      );
      const history = requireHistory(histories, id);
      expect(history.assistance?.has_valid_positive_assistance).toBe(true);
      const sibling = ASSISTED.find((other) => other !== id)!;
      expect(requireHistory(histories, sibling)).toEqual({
        lastSets: [],
        assistance: { has_valid_positive_assistance: false },
      });
      const exercise = await prisma.exercise.findUniqueOrThrow({ where: { id } });
      const result = recommendations.recommend({
        goal: "hypertrophy",
        exercise,
        history,
        target: targetFor("hypertrophy", exercise),
      });
      expect(result.weight).toBeNull();
      expect(result.recommended_action ?? null).toBeNull();
      expect(result.reason_code).toBe(mode === "pain" ? "SUBSTITUTE_PAIN" : "INVALID_INPUT");
      const next = await session(p.id, 0, false);
      const rows = await app.get(PlannedSetFactory).build({
        userId: USER_ID,
        goal: "hypertrophy",
        exercise,
        orderIndex: 0,
        sets: 1,
        history,
        calibration: undefined,
      });
      await prisma.plannedSet.createMany({
        data: rows.map((row) => ({ ...row, sessionId: next.id })),
      });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${latest.id}/complete`)
        .send({})
        .expect(200);
      const row = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId: next.id } });
      expect(row.reasonCode).toBe(result.reason_code);
      expect(row.recommendedWeight).toBeNull();
      expect(recommendations.plannedToApi(id, 1, row).recommended_action).toBeNull();
      expect(
        await prisma.plannedSet.findMany({
          where: { sessionId: old.id },
          include: { performedSets: true },
        }),
      ).toEqual(legacy);
    },
  );

  it("mixed pullup+dips+external actual analytics preserve exact external e1RM and kg-volume", async () => {
    const p = await program();
    const sessions = [];
    for (let n = 0; n < 3; n++) {
      const s = await session(p.id, n - 3);
      sessions.push(s);
      await fact(s.id, EXTERNAL, 40);
    }
    const externalApi = async () =>
      (
        await request(app.getHttpServer())
          .get(`/v1/analytics/e1rm?exercise_id=${EXTERNAL}`)
          .expect(200)
      ).body;
    const volumes = async () =>
      (
        await prisma.muscleWeeklyLoad.findMany({
          where: { userId: USER_ID },
          orderBy: [{ weekStart: "asc" }, { muscle: "asc" }],
        })
      )
        .filter((row) => Number(row.volumeLoad) !== 0)
        .map((row) => ({
          weekStart: row.weekStart,
          muscle: row.muscle,
          volume: Number(row.volumeLoad),
        }));
    const oracle = await externalApi();
    const volumeOracle = await volumes();
    expect(oracle.points).toHaveLength(3);
    expect(volumeOracle.length).toBeGreaterThan(0);
    for (const s of sessions) {
      await fact(s.id, ASSISTED[0], 20, { orderIndex: 1 });
      await fact(s.id, ASSISTED[1], 30, { orderIndex: 2 });
    }
    for (const weight of [20, 200]) {
      await prisma.performedSet.updateMany({
        where: { plannedSet: { exerciseId: { in: [...ASSISTED] }, session: { programId: p.id } } },
        data: { actualWeight: weight },
      });
      expect(await externalApi()).toEqual(oracle);
      expect(await volumes()).toEqual(volumeOracle);
      evidence(`mixed-analytics-${weight}`, {
        assistanceWeight: weight,
        externalOracle: oracle,
        externalActual: await externalApi(),
        volumeOracle,
        volumeActual: await volumes(),
      });
      for (const id of ASSISTED) {
        const response = await request(app.getHttpServer())
          .get(`/v1/analytics/e1rm?exercise_id=${id}`)
          .expect(200);
        expect(response.body.sample_session_count).toBe(3);
        expect(response.body.points).toEqual([]);
      }
      expect(
        await prisma.estimated1rm.count({
          where: { userId: USER_ID, exerciseId: { in: [...ASSISTED] } },
        }),
      ).toBe(0);
      const map = await recommendations.prefetchHistories(USER_ID, [
        { exerciseId: EXTERNAL, loadSemantics: "external_load" },
        ...ASSISTED.map((exerciseId) => ({ exerciseId, loadSemantics: "assistance" as const })),
      ]);
      expect(requireHistory(map, EXTERNAL).lastSets.map((row) => row.w)).toEqual([40]);
      for (const id of ASSISTED)
        expect(requireHistory(map, id).lastSets.map((row) => row.w)).toEqual([weight]);
    }
  });
});
