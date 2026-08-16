/**
 * 통합 테스트(실제 postgres): **테넌시 격리**.
 *
 * 다른 user_id 의 program/session/planned_set/performed_set 을 실제로 만들어 두고
 *  (a) 세션 엔드포인트 5개가 남의 세션을 404 로 감추는지 (SessionsService.load 의 `program: { userId }`)
 *  (b) 남의 수행기록이 내 추천 계산에 섞이지 않는지 (RecommendationService.historyFor 의 `program: { userId }`)
 * 를 고정한다. "없는 UUID → 404" 만으로는 두 술어를 지워도 테스트가 통과한다(STEP 4 평가 blocker).
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { testUserId } from "./support/users";

const USER_ID = devUserId();
/** dev-user(...0001) 와 다른 고정 UUID. 이 spec 밖으로 새어 나가지 않게 afterAll 에서 지운다. */
const OTHER_USER_ID = testUserId("tenancy");

const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

/** 내 프로그램에 들어가는 종목(복합 6~12) / 내 프로그램에 없어서 추가로 붙이는 종목(고립 10~20). */
const SHARED_EXERCISE = "e_bench_press";
const ADDED_EXERCISE = "e_face_pull";
/** 남의 예정 세션에만 들어 있는 종목(삭제/교체 404 검증용). */
const FOREIGN_ONLY_EXERCISE = "e_lateral_raise";

describe("테넌시 격리 (user_id)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let foreignSessionId: string;
  let mySessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await resetUserData(prisma, USER_ID, OTHER_USER_ID);
      await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
    }
    await app?.close();
  });

  /** 남의 planned_set 한 운동분(3세트). 추천값은 이 spec 에서 쓰지 않으므로 고정값을 넣는다. */
  function plannedSetRows(sessionId: string, exerciseId: string, orderIndex: number) {
    return [1, 2, 3].map((setNo) => ({
      sessionId,
      exerciseId,
      orderIndex,
      setNo,
      targetRepsLow: 6,
      targetRepsHigh: 12,
      targetRir: 2,
      restSec: 120,
      recommendedWeight: 100,
      recommendedReps: 6,
      reasonCode: "BASELINE",
      confidence: 0.5,
      rulesVersion: "2026.07.1",
    }));
  }

  /**
   * 남의 데이터: 예정 세션 1개(엔드포인트 404 용) + 완료 세션 1개(무거운 수행기록 — 추천 오염 용).
   * 완료 기록은 목표 반복 상단(12/20)·RIR 2 라 새어 들어오면 곧바로 WEIGHT_UP_REP_TARGET_MET 로 갈린다.
   */
  async function seedForeignData(): Promise<void> {
    await prisma.user.upsert({
      where: { id: OTHER_USER_ID },
      update: {},
      create: {
        id: OTHER_USER_ID,
        sex: "other",
        birthYear: 1990,
        heightCm: 180,
        weightKg: 80,
        goal: "hypertrophy",
        experienceLevel: "advanced",
        constraints: {},
      },
    });
    const program = await prisma.program.create({
      data: {
        userId: OTHER_USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.07.1",
      },
    });

    const scheduled = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date("2026-08-10T00:00:00.000Z"),
        focus: "upper",
        status: "scheduled",
      },
    });
    await prisma.plannedSet.createMany({
      data: plannedSetRows(scheduled.id, FOREIGN_ONLY_EXERCISE, 0),
    });
    foreignSessionId = scheduled.id;

    const completed = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date("2026-08-03T00:00:00.000Z"),
        focus: "upper",
        status: "completed",
        completedAt: new Date("2026-08-03T10:00:00.000Z"),
      },
    });
    await prisma.plannedSet.createMany({
      data: [
        ...plannedSetRows(completed.id, SHARED_EXERCISE, 0),
        ...plannedSetRows(completed.id, ADDED_EXERCISE, 1),
      ],
    });
    const planned = await prisma.plannedSet.findMany({ where: { sessionId: completed.id } });
    await prisma.performedSet.createMany({
      data: planned.map((set) => ({
        plannedSetId: set.id,
        actualWeight: 100,
        actualReps: set.exerciseId === ADDED_EXERCISE ? 20 : 12,
        actualRir: 2,
        painScore: null,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date("2026-08-03T10:00:00.000Z"),
      })),
    });
  }

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID, OTHER_USER_ID);
    await seedForeignData();
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const session = await prisma.workoutSession.findFirstOrThrow({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
    mySessionId = session.id;
  });

  describe("남의 세션은 존재를 알리지 않고 404", () => {
    it("GET /sessions/{id}", async () => {
      await request(app.getHttpServer()).get(`/v1/sessions/${foreignSessionId}`).expect(404);
    });

    it("POST /sessions/{id}/complete — 남의 세션은 완료되지 않는다", async () => {
      await request(app.getHttpServer())
        .post(`/v1/sessions/${foreignSessionId}/complete`)
        .send({ difficulty: "hard" })
        .expect(404);

      const untouched = await prisma.workoutSession.findUniqueOrThrow({
        where: { id: foreignSessionId },
      });
      expect(untouched.status).toBe("scheduled");
      expect(untouched.sessionFeedback).toBeNull();
    });

    it("POST /sessions/{id}/exercises — 남의 세션에 운동이 추가되지 않는다", async () => {
      await request(app.getHttpServer())
        .post(`/v1/sessions/${foreignSessionId}/exercises`)
        .send({ exercise_id: ADDED_EXERCISE })
        .expect(404);

      await expect(
        prisma.plannedSet.count({ where: { sessionId: foreignSessionId } }),
      ).resolves.toBe(3);
    });

    it("DELETE /sessions/{id}/exercises/{exerciseId} — 실제로 들어 있는 운동이어도 404", async () => {
      await request(app.getHttpServer())
        .delete(`/v1/sessions/${foreignSessionId}/exercises/${FOREIGN_ONLY_EXERCISE}`)
        .expect(404);

      await expect(
        prisma.plannedSet.count({
          where: { sessionId: foreignSessionId, exerciseId: FOREIGN_ONLY_EXERCISE },
        }),
      ).resolves.toBe(3);
    });

    it("POST /sessions/{id}/exercises/{exerciseId}/swap — 실제로 들어 있는 운동이어도 404", async () => {
      await request(app.getHttpServer())
        .post(`/v1/sessions/${foreignSessionId}/exercises/${FOREIGN_ONLY_EXERCISE}/swap`)
        .send({ to_exercise_id: ADDED_EXERCISE })
        .expect(404);

      await expect(
        prisma.plannedSet.count({
          where: { sessionId: foreignSessionId, exerciseId: FOREIGN_ONLY_EXERCISE },
        }),
      ).resolves.toBe(3);
    });
  });

  describe("남의 수행기록은 내 추천 계산에 쓰이지 않는다", () => {
    it("프로그램 생성: 남이 같은 종목을 무겁게 해도 내 계획세트는 BASELINE(0kg)", async () => {
      const mine = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } }, exerciseId: SHARED_EXERCISE },
      });

      expect(mine.length).toBeGreaterThan(0);
      for (const set of mine) {
        expect(set.reasonCode).toBe("BASELINE");
        expect(Number(set.recommendedWeight)).toBe(0);
      }
    });

    it("운동 추가: 남의 기록이 있는 종목을 붙여도 BASELINE(0kg)", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${mySessionId}/exercises`)
        .send({ exercise_id: ADDED_EXERCISE })
        .expect(200);

      const added = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === ADDED_EXERCISE,
      );
      expect(added.length).toBeGreaterThan(0);
      for (const set of added) {
        expect(set).toMatchObject({
          reason_code: null,
          recommended_weight: null,
          recommendation_gate: "no_history",
        });
      }
      const stored = await prisma.plannedSet.findMany({
        where: { sessionId: mySessionId, exerciseId: ADDED_EXERCISE },
      });
      expect(stored.every((set) => set.reasonCode === "BASELINE")).toBe(true);
      expect(stored.every((set) => Number(set.recommendedWeight) === 0)).toBe(true);
    });

    it("운동 교체: 남의 기록이 있는 종목으로 바꿔도 BASELINE(0kg)", async () => {
      const detail = await request(app.getHttpServer())
        .get(`/v1/sessions/${mySessionId}`)
        .expect(200);
      const first = detail.body.planned_sets[0].exercise_id;

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${mySessionId}/exercises/${first}/swap`)
        .send({ to_exercise_id: ADDED_EXERCISE })
        .expect(200);

      const swapped = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === ADDED_EXERCISE,
      );
      expect(swapped.length).toBeGreaterThan(0);
      for (const set of swapped) {
        expect(set).toMatchObject({
          reason_code: null,
          recommended_weight: null,
          recommendation_gate: "no_history",
        });
      }
      const stored = await prisma.plannedSet.findMany({
        where: { sessionId: mySessionId, exerciseId: ADDED_EXERCISE },
      });
      expect(stored.every((set) => set.reasonCode === "BASELINE")).toBe(true);
      expect(stored.every((set) => Number(set.recommendedWeight) === 0)).toBe(true);
    });
  });
});
