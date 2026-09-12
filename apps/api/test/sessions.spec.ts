/**
 * 통합 테스트(실제 postgres): GET /v1/sessions/{id}, POST /v1/sessions/{id}/complete.
 * 완료 시 packages/shared 의 recommendNextSet 결과가 다음 세션 planned_set 에 반영되는지 검증한다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { decryptNumber, encryptNumber } from "../src/common/crypto/field-encryption";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

interface Performed {
  w: number;
  reps: number;
  rir?: number;
  pain?: number;
}

describe("sessions", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  });

  /** 프로그램의 세션들을 날짜 오름차순으로 (MON upper, TUE lower, THU upper, FRI lower, …). */
  async function sessions() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
      include: { plannedSets: { orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }] } },
    });
  }

  async function recordSets(
    sessionId: string,
    exerciseId: string,
    performed: Performed[],
  ): Promise<void> {
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId, exerciseId },
      orderBy: { setNo: "asc" },
    });
    for (const [index, set] of performed.entries()) {
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned[index].id,
          actualWeight: set.w,
          actualReps: set.reps,
          actualRir: set.rir ?? null,
          painScore: encryptNumber(set.pain ?? null),
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(),
        },
      });
    }
  }

  describe("GET /sessions/{sessionId}", () => {
    it("200 + openapi Session 스키마", async () => {
      const [first] = await sessions();

      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${first.id}`)
        .expect(200);

      expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
      expect(response.body.id).toBe(first.id);
      expect(response.body.status).toBe("scheduled");
      expect(response.body.planned_sets).toHaveLength(15);
      expect(response.body.scheduled_date).toBe(first.scheduledDate.toISOString().slice(0, 10));
    });

    it("계획세트는 운동 순서(orderIndex) → 세트 번호 순으로 나온다", async () => {
      const [first] = await sessions();

      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${first.id}`)
        .expect(200);

      const setNos = response.body.planned_sets.map((set: { set_no: number }) => set.set_no);
      expect(setNos).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
    });

    it("존재하지 않는/남의 세션은 404 + openapi 404 스키마", async () => {
      const unknown = await request(app.getHttpServer()).get(`/v1/sessions/${randomUUID()}`);
      const malformed = await request(app.getHttpServer()).get("/v1/sessions/not-a-uuid");

      expectErrorMatchesContract("get", "/sessions/{sessionId}", 404, unknown);
      expectErrorMatchesContract("get", "/sessions/{sessionId}", 404, malformed);
    });
  });

  describe("POST /sessions/{sessionId}/complete", () => {
    it("ADR-70: 완료 1회부터 다음 세션 wire의 처방을 공개하고 분석은 닫아 둔다", async () => {
      const [first, , next] = await sessions();
      const exerciseId = first.plannedSets[0].exerciseId;
      const step = Number(
        (await prisma.exercise.findUniqueOrThrow({ where: { id: exerciseId } })).defaultStepKg,
      );
      await recordSets(first.id, exerciseId, [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
      ]);
      const completed = await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/complete`)
        .send({})
        .expect(200);
      const detail = await request(app.getHttpServer()).get(`/v1/sessions/${next.id}`).expect(200);
      const rows = detail.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === exerciseId,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          recommended_weight: 60 + step,
          recommended_reps: row.target_reps_low,
          reason_code: "WEIGHT_UP_REP_TARGET_MET",
          recommendation_state: "ready",
          recommendation_gate: "early",
          confidence: null,
        });
      }
      expect(completed.body.next_recommendations[0]).toMatchObject({
        sample_session_count: 1,
        gate_state: "early",
        recommendation: { weight: 60 + step, recommendation_state: "ready", confidence: null },
      });
      const analytics = await request(app.getHttpServer())
        .get("/v1/analytics/e1rm")
        .query({ exercise_id: exerciseId })
        .expect(200);
      expect(analytics.body).toMatchObject({
        sample_session_count: 1,
        gate_state: "early",
        points: [],
      });
      const dashboard = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
      if (dashboard.body.primary_e1rm) expect(dashboard.body.primary_e1rm.latest_e1rm).toBeNull();
    });

    it("200 + openapi 응답 스키마 + 세션이 completed 로 바뀐다", async () => {
      const [first] = await sessions();
      const exerciseId = first.plannedSets[0].exerciseId;
      await recordSets(first.id, exerciseId, [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
      ]);

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/complete`)
        .send({ difficulty: "moderate", pump: "high", pain: 1 })
        .expect(200);

      expectMatchesContract("post", "/sessions/{sessionId}/complete", 200, response.body);
      expect(response.body.session.status).toBe("completed");
      expect(response.body.next_recommendations).toHaveLength(1);
      expect(response.body.next_recommendations[0]).toMatchObject({
        exercise_id: exerciseId,
        sample_session_count: 1,
        gate_state: "early",
        recommendation: {
          recommendation_state: "ready",
          reason_code: "WEIGHT_UP_REP_TARGET_MET",
          confidence: null,
        },
      });
    });

    it("다음 같은 focus 세션의 recommended_* 가 엔진 결과로 갱신된다", async () => {
      const [monday, tuesday, thursday] = await sessions();
      const exerciseId = monday.plannedSets[0].exerciseId;
      const step = Number(
        (await prisma.exercise.findUniqueOrThrow({ where: { id: exerciseId } })).defaultStepKg,
      );
      await recordSets(monday.id, exerciseId, [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
      ]);

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({})
        .expect(200);

      const recommendation = response.body.next_recommendations[0];
      expect(recommendation).toMatchObject({
        exercise_id: exerciseId,
        sample_session_count: 1,
        gate_state: "early",
        recommendation: {
          recommendation_state: "ready",
          reason_code: "WEIGHT_UP_REP_TARGET_MET",
          confidence: null,
        },
      });

      const updated = await prisma.plannedSet.findMany({
        where: { sessionId: thursday.id, exerciseId },
      });
      expect(updated).toHaveLength(3);
      for (const set of updated) {
        expect(Number(set.recommendedWeight)).toBe(60 + step);
        expect(set.reasonCode).toBe("WEIGHT_UP_REP_TARGET_MET");
        expect(set.recommendedReps).toBe(set.targetRepsLow);
      }

      // 다른 focus(하체) 세션은 건드리지 않는다
      const untouched = await prisma.plannedSet.findMany({ where: { sessionId: tuesday.id } });
      for (const set of untouched) {
        expect(set.reasonCode).toBe("BASELINE");
      }
    });

    it("부분 수행(F7): 같은 부위라도 기록이 없는 다른 운동의 추천은 재계산하지 않는다", async () => {
      const [monday, , thursday] = await sessions();
      const performedExercise = monday.plannedSets[0].exerciseId;
      const skipped = monday.plannedSets.find(
        (set) => set.exerciseId !== performedExercise,
      )!.exerciseId;
      const regions = await prisma.exercise.findMany({
        where: { id: { in: [performedExercise, skipped] } },
        select: { id: true, region: true },
      });
      expect(regions).toHaveLength(2);
      expect(new Set(regions.map((exercise) => exercise.region)).size).toBe(1);
      await recordSets(monday.id, performedExercise, [{ w: 40, reps: 6, rir: 2 }]);

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({})
        .expect(200);

      expect(
        response.body.next_recommendations.map((r: { exercise_id: string }) => r.exercise_id),
      ).toEqual([performedExercise]);

      const untouched = await prisma.plannedSet.findMany({
        where: { sessionId: thursday.id, exerciseId: skipped },
      });
      for (const set of untouched) {
        expect(set.reasonCode).toBe("BASELINE");
        expect(Number(set.recommendedWeight)).toBe(0);
      }
    });

    it("통증 보고(pain_score >= 4)는 안전 가드레일로 감량 + 대체 제안", async () => {
      const [monday, , thursday] = await sessions();
      const exerciseId = monday.plannedSets[0].exerciseId;
      await recordSets(monday.id, exerciseId, [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2, pain: 5 },
      ]);

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({})
        .expect(200);

      expect(response.body.next_recommendations[0]).toMatchObject({
        exercise_id: exerciseId,
        gate_state: "early",
        recommendation: {
          recommendation_state: "substitution_required",
          reason_code: "SUBSTITUTE_PAIN",
          confidence: null,
        },
      });
      const recommendation = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: thursday.id, exerciseId },
      });
      expect(recommendation.reasonCode).toBe("SUBSTITUTE_PAIN");
      expect(Number(recommendation.recommendedWeight)).toBeLessThan(60);
    });

    it("세션 피드백의 pain 은 암호화되어 저장된다(SECURITY_PIPA)", async () => {
      const [monday] = await sessions();

      await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({ difficulty: "hard", pain: 3 })
        .expect(200);

      const stored = await prisma.workoutSession.findUniqueOrThrow({ where: { id: monday.id } });
      const feedback = stored.sessionFeedback as { difficulty: string; pain: string };
      expect(feedback.difficulty).toBe("hard");
      expect(feedback.pain).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
      expect(feedback.pain).not.toBe("3");
      expect(decryptNumber(feedback.pain)).toBe(3);
    });

    /**
     * STEP 6 오프라인 아웃박스는 같은 complete 를 재전송할 수 있다.
     * 재완료는 멱등이어야 하고, 바디에 없는 피드백 키(특히 암호화된 pain)를 지우면 안 된다.
     */
    describe("재완료 멱등성 (아웃박스 재시도)", () => {
      it("빈 바디로 재완료해도 기존 pain/pump/difficulty 가 보존된다", async () => {
        const [monday] = await sessions();
        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({ difficulty: "moderate", pump: "high", pain: 3 })
          .expect(200);

        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({})
          .expect(200);

        const stored = await prisma.workoutSession.findUniqueOrThrow({ where: { id: monday.id } });
        const feedback = stored.sessionFeedback as {
          difficulty: string;
          pump: string;
          pain: string;
        };
        expect(feedback.difficulty).toBe("moderate");
        expect(feedback.pump).toBe("high");
        expect(decryptNumber(feedback.pain)).toBe(3);
      });

      it("재완료 바디에 있는 키만 덮어쓴다", async () => {
        const [monday] = await sessions();
        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({ difficulty: "moderate", pain: 3 })
          .expect(200);

        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({ difficulty: "hard" })
          .expect(200);

        const stored = await prisma.workoutSession.findUniqueOrThrow({ where: { id: monday.id } });
        const feedback = stored.sessionFeedback as { difficulty: string; pain: string };
        expect(feedback.difficulty).toBe("hard");
        expect(decryptNumber(feedback.pain)).toBe(3);
      });

      it("최초 완료 시각(completed_at)은 재완료로 바뀌지 않는다", async () => {
        const [monday] = await sessions();
        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({ pain: 2 })
          .expect(200);
        const first = await prisma.workoutSession.findUniqueOrThrow({ where: { id: monday.id } });

        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({})
          .expect(200);

        const second = await prisma.workoutSession.findUniqueOrThrow({ where: { id: monday.id } });
        expect(second.completedAt).toEqual(first.completedAt);
      });

      it("재완료해도 다음 세션 추천이 두 번 진행되지 않는다", async () => {
        const [monday, , thursday] = await sessions();
        const exerciseId = monday.plannedSets[0].exerciseId;
        const step = Number(
          (await prisma.exercise.findUniqueOrThrow({ where: { id: exerciseId } })).defaultStepKg,
        );
        await recordSets(monday.id, exerciseId, [
          { w: 60, reps: 12, rir: 2 },
          { w: 60, reps: 12, rir: 2 },
          { w: 60, reps: 12, rir: 2 },
        ]);

        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({})
          .expect(200);
        await request(app.getHttpServer())
          .post(`/v1/sessions/${monday.id}/complete`)
          .send({})
          .expect(200);

        const updated = await prisma.plannedSet.findMany({
          where: { sessionId: thursday.id, exerciseId },
        });
        for (const set of updated) {
          expect(Number(set.recommendedWeight)).toBe(60 + step);
        }
      });
    });

    it("pain 이 0~10 범위를 벗어나면 400 (DB CHECK 대신 DTO 검증)", async () => {
      const [monday] = await sessions();

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({ pain: 11 });

      expectErrorMatchesContract("post", "/sessions/{sessionId}/complete", 400, response);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("없는 세션은 404 + openapi 404 스키마", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${randomUUID()}/complete`)
        .send({});

      expectErrorMatchesContract("post", "/sessions/{sessionId}/complete", 404, response);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  /**
   * calibration 객체의 존재 자체가 RIR 축 활성 스위치다(PROGRESS.md STEP 3).
   * 같은 입력이 캘리브레이션 유무에 따라 다른 reason_code 로 갈라지는지 고정한다.
   */
  describe("RIR 캘리브레이션 게이팅", () => {
    const easySets: Performed[] = [
      { w: 60, reps: 8, rir: 4 },
      { w: 60, reps: 8, rir: 4 },
      { w: 60, reps: 8, rir: 4 },
    ];

    async function completeWithEasySets(): Promise<{ reason_code: string; weight: number }> {
      const [monday, , thursday] = await sessions();
      const exerciseId = monday.plannedSets[0].exerciseId;
      await recordSets(monday.id, exerciseId, easySets);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${monday.id}/complete`)
        .send({})
        .expect(200);
      const stored = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: thursday.id, exerciseId },
      });
      return { reason_code: stored.reasonCode, weight: Number(stored.recommendedWeight) };
    }

    it("캘리브레이션 행이 없으면 RIR 축을 쓰지 않는다(반복 기반 ADD_ONE_REP)", async () => {
      expect(await completeWithEasySets()).toMatchObject({
        reason_code: "ADD_ONE_REP",
        weight: 60,
      });
    });

    it("튜토리얼 미완료(status != graduated) 도 RIR 축을 쓰지 않는다", async () => {
      await prisma.userRirCalibration.create({
        data: {
          userId: USER_ID,
          biasOverall: 0,
          biasByRegion: {},
          confidence: 0.5,
          samples: 3,
          status: "in_progress",
        },
      });

      expect(await completeWithEasySets()).toMatchObject({ reason_code: "ADD_ONE_REP" });
    });

    it("graduated 면 RIR 축이 켜져 RIR_TOO_EASY_INCREASE 로 간다", async () => {
      await prisma.userRirCalibration.create({
        data: {
          userId: USER_ID,
          biasOverall: 0,
          biasByRegion: {},
          confidence: 0.8,
          samples: 12,
          status: "graduated",
        },
      });

      const recommendation = await completeWithEasySets();
      expect(recommendation.reason_code).toBe("RIR_TOO_EASY_INCREASE");
      expect(recommendation.weight).toBeGreaterThan(60);
    });
  });
});
