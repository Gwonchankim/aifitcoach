/**
 * 통합 테스트(실제 postgres): 종료 후 **당일** 기록 추가·수정(FEATURES_UX F6-1).
 *
 * 고정하는 성질 두 가지다.
 *  1) 당일 종료 세션을 고치면 종료 시의 추천 재계산이 다시 돌고, 그 재계산은 **멱등**이다
 *     (같은 입력으로 여러 번 돌아도 다음 세션 목표가 두 번 올라가지 않는다).
 *  2) 대시보드·요약(done_summary/routine_summary)이 수정 결과를 그대로 반영한다.
 *
 * 세트 기록 자체는 아직 API 가 없다(오프라인 /sync = STEP 6) → performed_set 은 직접 심고,
 * 루틴 편집은 실제 엔드포인트로 한다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const DAY_MS = 86_400_000;

/**
 * 서비스와 같은 기준(UTC)의 날짜. offset=0 이 오늘이다.
 * **`new Date()` 를 쓰지 않는다** — 서버는 utcToday()(고정 가능, ADR-50)를 보는데 테스트가 실제 시계를
 * 보면 기대값이 하루씩 어긋난다. 같은 시계를 봐야 요일 고정이 의미를 갖는다.
 */
function utcDay(offset: number): Date {
  return new Date(utcToday().getTime() + offset * DAY_MS);
}

describe("종료 후 당일 수정 (F6-1)", () => {
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
  });

  /**
   * 프로그램을 만들고 세션을 **오늘 1개 + 내일 1개**만 남긴다.
   * 요일 배치(MON/WED/FRI…)를 그대로 두면 "다음 세션"이 오늘이 무슨 요일이냐에 따라 달라진다.
   */
  async function twoSessions(program: object): Promise<[string, string]> {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(program).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const all = await prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
    const [today, tomorrow, ...rest] = all;
    const restIds = rest.map((session) => session.id);
    await prisma.plannedSet.deleteMany({ where: { sessionId: { in: restIds } } });
    await prisma.workoutSession.deleteMany({ where: { id: { in: restIds } } });
    await prisma.workoutSession.update({
      where: { id: today.id },
      data: { scheduledDate: utcDay(0) },
    });
    await prisma.workoutSession.update({
      where: { id: tomorrow.id },
      data: { scheduledDate: utcDay(1) },
    });
    return [today.id, tomorrow.id];
  }

  async function recordSet(
    sessionId: string,
    exerciseId: string,
    setNo: number,
    values: { weight?: number | null; reps?: number | null; timeSec?: number },
  ): Promise<string> {
    const planned = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId, exerciseId, setNo },
    });
    const performed = await prisma.performedSet.create({
      data: {
        plannedSetId: planned.id,
        actualWeight: values.weight ?? null,
        actualReps: values.reps ?? null,
        actualTimeSec: values.timeSec ?? null,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date(),
      },
    });
    return performed.id;
  }

  function complete(sessionId: string) {
    return request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/complete`)
      .send({})
      .expect(200);
  }

  function addExercise(sessionId: string, exerciseId: string) {
    return request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/exercises`)
      .send({ exercise_id: exerciseId })
      .expect(200);
  }

  function removeExercise(sessionId: string, exerciseId: string) {
    return request(app.getHttpServer())
      .delete(`/v1/sessions/${sessionId}/exercises/${exerciseId}`)
      .expect(200);
  }

  /**
   * 재계산 멱등성의 가장 예민한 자리: 맨몸(REPS_UP_BODYWEIGHT)·시간(TIME_UP)은 **목표 범위 자체**가
   * 움직인다. 편집마다 재계산이 돌아도 목표가 누적해 올라가면 안 된다.
   */
  describe("수정하면 추천이 다시 계산되고, 몇 번을 해도 결과가 같다", () => {
    const BODYWEIGHT_PROGRAM = {
      goal: "hypertrophy",
      days_per_week: 3,
      minutes_per_day: 60,
      experience_level: "intermediate",
      equipment: ["bodyweight"],
    };

    async function nextTargets(sessionId: string) {
      const sets = await prisma.plannedSet.findMany({
        where: { sessionId },
        orderBy: [{ exerciseId: "asc" }, { setNo: "asc" }],
        select: {
          exerciseId: true,
          setNo: true,
          targetRepsLow: true,
          targetRepsHigh: true,
          targetTimeLowSec: true,
          targetTimeHighSec: true,
          recommendedWeight: true,
          recommendedReps: true,
          reasonCode: true,
        },
      });
      return sets;
    }

    it("같은 수정을 두 번 해도 다음 세션 목표가 두 번 올라가지 않는다", async () => {
      const [todayId, tomorrowId] = await twoSessions(BODYWEIGHT_PROGRAM);
      for (const setNo of [1, 2, 3]) {
        await recordSet(todayId, "e_dips", setNo, { reps: 12 });
      }
      for (const setNo of [1, 2, 3]) {
        await recordSet(todayId, "e_plank", setNo, { timeSec: 60 });
      }

      await complete(todayId);
      const afterComplete = await nextTargets(tomorrowId);
      // 종료 시 재계산: 맨몸은 목표 상단 +1, 시간은 상단 +10
      expect(afterComplete.find((set) => set.exerciseId === "e_dips")!.targetRepsHigh).toBe(13);
      expect(afterComplete.find((set) => set.exerciseId === "e_plank")!.targetTimeHighSec).toBe(70);

      // 같은 수정(운동 추가 → 삭제)을 두 번 반복한다. 그때마다 재계산이 다시 돈다.
      for (const round of [1, 2]) {
        await addExercise(todayId, "e_face_pull");
        await removeExercise(todayId, "e_face_pull");
        expect({ round, targets: await nextTargets(tomorrowId) }).toEqual({
          round,
          targets: afterComplete,
        });
      }
    });

    it("수정 후 기록이 바뀌면 그 기록대로 다시 계산된다(재계산이 실제로 돈다)", async () => {
      const [todayId, tomorrowId] = await twoSessions(BODYWEIGHT_PROGRAM);
      await recordSet(todayId, "e_dips", 1, { reps: 12 });
      await recordSet(todayId, "e_dips", 2, { reps: 12 });
      await complete(todayId);
      expect(
        (await nextTargets(tomorrowId)).find((set) => set.exerciseId === "e_dips")!.targetRepsHigh,
      ).toBe(13);

      // 종료 후 세 번째 세트를 추가로 기록했는데 목표에 크게 못 미쳤다(2회).
      await recordSet(todayId, "e_dips", 3, { reps: 2 });
      await addExercise(todayId, "e_face_pull");

      const dips = (await nextTargets(tomorrowId)).find((set) => set.exerciseId === "e_dips")!;
      expect(dips.targetRepsHigh).toBe(12);
      expect(dips.reasonCode).not.toBe("REPS_UP_BODYWEIGHT");
    });

    it("다른 날짜의 종료 세션은 편집이 막히므로 재계산도 돌지 않는다", async () => {
      const [todayId, tomorrowId] = await twoSessions(BODYWEIGHT_PROGRAM);
      for (const setNo of [1, 2, 3]) {
        await recordSet(todayId, "e_dips", setNo, { reps: 12 });
      }
      await complete(todayId);
      const afterComplete = await nextTargets(tomorrowId);

      await prisma.workoutSession.update({
        where: { id: todayId },
        data: { scheduledDate: utcDay(-1) },
      });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${todayId}/exercises`)
        .send({ exercise_id: "e_face_pull" })
        .expect(409);

      expect(await nextTargets(tomorrowId)).toEqual(afterComplete);
    });
  });

  /** 대시보드의 "오늘 기록"은 저장된 수행기록을 그때그때 집계한다 → 수정이 곧바로 보인다. */
  describe("대시보드·요약이 수정 결과를 반영한다", () => {
    const PROGRAM = {
      goal: "hypertrophy",
      days_per_week: 4,
      minutes_per_day: 60,
      experience_level: "intermediate",
    };

    async function dashboard() {
      const response = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
      expectMatchesContract("get", "/dashboard", 200, response.body);
      return response.body;
    }

    it("종료 후 세트를 더 하면 total_volume·sets_completed 가 늘어난다", async () => {
      const [todayId] = await twoSessions(PROGRAM);
      await recordSet(todayId, "e_bench_press", 1, { weight: 60, reps: 10 });
      await recordSet(todayId, "e_bench_press", 2, { weight: 60, reps: 10 });
      await complete(todayId);

      expect((await dashboard()).today).toMatchObject({
        status: "partial",
        session_id: todayId,
        done_summary: { total_volume: 1200, sets_completed: 2 },
      });

      await recordSet(todayId, "e_bench_press", 3, { weight: 60, reps: 10 });

      expect((await dashboard()).today.done_summary).toMatchObject({
        total_volume: 1800,
        sets_completed: 3,
      });
    });

    it("잘못 입력한 값을 고치면 요약이 그 값으로 바뀐다", async () => {
      const [todayId] = await twoSessions(PROGRAM);
      const performedId = await recordSet(todayId, "e_bench_press", 1, { weight: 60, reps: 10 });
      await complete(todayId);
      expect((await dashboard()).today.done_summary.total_volume).toBe(600);

      // 60kg 이 아니라 70kg 이었다.
      await prisma.performedSet.update({
        where: { id: performedId },
        data: { actualWeight: 70 },
      });

      expect((await dashboard()).today.done_summary.total_volume).toBe(700);
    });

    it("종료 후 루틴을 편집하면 오늘 요약의 운동 수가 바뀐다(상태는 done 유지)", async () => {
      const [todayId] = await twoSessions(PROGRAM);
      await recordSet(todayId, "e_bench_press", 1, { weight: 60, reps: 10 });
      await complete(todayId);
      const before = (await dashboard()).today.routine_summary.exercise_count;

      await addExercise(todayId, "e_face_pull");

      const body = await dashboard();
      expect(body.today.status).toBe("partial");
      expect(body.today.routine_summary.exercise_count).toBe(before + 1);
      expect(body.today.done_summary).toMatchObject({ total_volume: 600, sets_completed: 1 });
    });
  });
});
