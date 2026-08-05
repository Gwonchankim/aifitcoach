/**
 * 통합 테스트(실제 postgres): 데일리 루틴 편집(FEATURES_UX F5) — 운동 추가/삭제/교체.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
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

const ADD_PATH = "/sessions/{sessionId}/exercises";
const ITEM_PATH = "/sessions/{sessionId}/exercises/{plannedExerciseId}";
const SWAP_PATH = "/sessions/{sessionId}/exercises/{plannedExerciseId}/swap";

/** 응답 planned_sets 를 운동 단위(등장 순서)로 접는다. */
function exerciseOrder(body: { planned_sets: { exercise_id: string }[] }): string[] {
  return [...new Set(body.planned_sets.map((set) => set.exercise_id))];
}

describe("데일리 루틴 편집 (F5)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionId: string;
  let exerciseIds: string[];

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
    const session = await prisma.workoutSession.findFirstOrThrow({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
    sessionId = session.id;
    const detail = await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}`).expect(200);
    exerciseIds = exerciseOrder(detail.body);
  });

  describe("추가", () => {
    it("200 + openapi Session 스키마, 맨 뒤에 붙는다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull" })
        .expect(200);

      expectMatchesContract("post", ADD_PATH, 200, response.body);
      expect(exerciseOrder(response.body)).toEqual([...exerciseIds, "e_face_pull"]);
      // 고립운동 기본 3세트 + 근비대 고립 반복 10~20 (program-rules)
      const added = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === "e_face_pull",
      );
      expect(added).toHaveLength(3);
      expect(added[0]).toMatchObject({ target_reps_low: 10, target_reps_high: 20, rest_sec: 120 });
    });

    it("sets 를 주면 그 개수만큼 만든다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull", sets: 5 })
        .expect(200);

      const added = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === "e_face_pull",
      );
      expect(added.map((set: { set_no: number }) => set.set_no)).toEqual([1, 2, 3, 4, 5]);
    });

    it("position 을 주면 그 자리에 끼워 넣고 뒤 운동을 민다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull", position: 1 })
        .expect(200);

      expect(exerciseOrder(response.body)).toEqual([
        exerciseIds[0],
        "e_face_pull",
        ...exerciseIds.slice(1),
      ]);
    });

    /** 없는 exercise_id 는 잘못된 입력(400)이고, 없는 세션만 404 다(제품 오너 확정). */
    it("없는 운동은 400, 없는 세션은 404 + openapi 스키마", async () => {
      const unknownExercise = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_does_not_exist" });
      const unknownSession = await request(app.getHttpServer())
        .post(`/v1/sessions/${randomUUID()}/exercises`)
        .send({ exercise_id: "e_face_pull" });

      expectErrorMatchesContract("post", ADD_PATH, 400, unknownExercise);
      expect(unknownExercise.body.error.code).toBe("VALIDATION_ERROR");
      expectErrorMatchesContract("post", ADD_PATH, 404, unknownSession);
      expect(unknownSession.body.error.code).toBe("NOT_FOUND");
    });

    it("exercise_id 가 없으면 400", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({});

      expectErrorMatchesContract("post", ADD_PATH, 400, response);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    /** sets 무제한은 자원 남용 + 유령 운동(0세트) 을 만든다(STEP 4 평가 I-14). */
    it.each([0, -1, 11, 300, 1e10])("sets=%p 는 400 + 에러 엔벨로프", async (sets) => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull", sets });

      expectErrorMatchesContract("post", ADD_PATH, 400, response);
      expect(response.body).toEqual({
        error: { code: "VALIDATION_ERROR", message: expect.any(String) },
      });
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: "e_face_pull" } }),
      ).resolves.toBe(0);
    });

    /**
     * plannedExerciseId = exercise_id 라서 같은 운동이 두 번 들어가면 하나를 지울 때 둘 다 지워진다
     * (세션 안에서 운동을 지목할 방법이 사라진다) → 한 세션에 같은 종목은 1회만.
     */
    it("이미 세션에 있는 운동을 또 추가하면 409 이고 세트가 늘지 않는다", async () => {
      const before = await prisma.plannedSet.count({ where: { sessionId } });

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: exerciseIds[0] });

      expectErrorMatchesContract("post", ADD_PATH, 409, response);
      expect(response.body.error.code).toBe("CONFLICT");
      expect(response.body.error.message).toContain("이미 이 세션에 포함된 운동");
      await expect(prisma.plannedSet.count({ where: { sessionId } })).resolves.toBe(before);
      await expect(
        prisma.plannedSet
          .findMany({ where: { sessionId, exerciseId: exerciseIds[0] } })
          .then((sets) => new Set(sets.map((set) => set.orderIndex)).size),
      ).resolves.toBe(1);
    });

    /**
     * 앱 레벨 가드(조회 → 삽입)에는 경합 창이 있다. 동시 요청 두 개가 둘 다 가드를 통과해도
     * DB 유니크 제약(ux_planned_session_exercise_set)이 잡아야 하고, 그건 500 이 아니라 409 다.
     */
    describe("동시 추가(경합)", () => {
      it("같은 운동을 동시에 추가하면 한 쪽만 성공하고 다른 쪽은 409 다", async () => {
        const responses = await Promise.all([
          request(app.getHttpServer())
            .post(`/v1/sessions/${sessionId}/exercises`)
            .send({ exercise_id: "e_face_pull" }),
          request(app.getHttpServer())
            .post(`/v1/sessions/${sessionId}/exercises`)
            .send({ exercise_id: "e_face_pull" }),
        ]);

        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        const conflict = responses.find((response) => response.status === 409)!;
        expectErrorMatchesContract("post", ADD_PATH, 409, conflict);
        expect(conflict.body.error.code).toBe("CONFLICT");
        await expect(
          prisma.plannedSet.count({ where: { sessionId, exerciseId: "e_face_pull" } }),
        ).resolves.toBe(3);
      });

      it("DB 가 (session_id, exercise_id, set_no) 중복을 거절한다", async () => {
        const existing = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId } });

        await expect(
          prisma.plannedSet.create({
            data: {
              sessionId,
              exerciseId: existing.exerciseId,
              orderIndex: 99,
              setNo: existing.setNo,
              targetRepsLow: 6,
              targetRepsHigh: 12,
              targetRir: 2,
              restSec: 120,
              recommendedWeight: 0,
              recommendedReps: 6,
              reasonCode: "BASELINE",
              confidence: 0.5,
              rulesVersion: "2026.08.1",
            },
          }),
        ).rejects.toMatchObject({ code: "P2002" });
      });
    });

    it("sets=null 은 기본 세트수로 처리한다(openapi nullable)", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull", sets: null })
        .expect(200);

      const added = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === "e_face_pull",
      );
      expect(added).toHaveLength(3);
    });
  });

  describe("삭제", () => {
    it("200 + 해당 운동의 계획세트가 모두 사라진다", async () => {
      const removed = exerciseIds[1];

      const response = await request(app.getHttpServer())
        .delete(`/v1/sessions/${sessionId}/exercises/${removed}`)
        .expect(200);

      expectMatchesContract("delete", ITEM_PATH, 200, response.body);
      expect(exerciseOrder(response.body)).toEqual(exerciseIds.filter((id) => id !== removed));
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: removed } }),
      ).resolves.toBe(0);
    });

    it("세션에 없는 운동은 404 + openapi 404 스키마", async () => {
      const response = await request(app.getHttpServer()).delete(
        `/v1/sessions/${sessionId}/exercises/e_face_pull`,
      );

      expectErrorMatchesContract("delete", ITEM_PATH, 404, response);
    });

    it("이미 수행 기록이 있으면 409 (건강 기록을 지우지 않는다)", async () => {
      const planned = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId, exerciseId: exerciseIds[0] },
      });
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned.id,
          actualWeight: 60,
          actualReps: 10,
          actualRir: 2,
          painScore: null,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(),
        },
      });

      const response = await request(app.getHttpServer()).delete(
        `/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}`,
      );

      expectErrorMatchesContract("delete", ITEM_PATH, 409, response);
      expect(response.body.error.code).toBe("CONFLICT");
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: exerciseIds[0] } }),
      ).resolves.toBe(3);
    });
  });

  describe("교체", () => {
    it("200 + 같은 자리·같은 세트수로 새 운동이 들어온다", async () => {
      const from = exerciseIds[0];
      const setCount = await prisma.plannedSet.count({ where: { sessionId, exerciseId: from } });

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${from}/swap`)
        .send({ to_exercise_id: "e_chest_press_machine" })
        .expect(200);

      expectMatchesContract("post", SWAP_PATH, 200, response.body);
      expect(exerciseOrder(response.body)).toEqual([
        "e_chest_press_machine",
        ...exerciseIds.slice(1),
      ]);
      const swapped = response.body.planned_sets.filter(
        (set: { exercise_id: string }) => set.exercise_id === "e_chest_press_machine",
      );
      expect(swapped).toHaveLength(setCount);
    });

    it("대체 종목의 mechanic 에 맞춰 목표 반복이 다시 계산된다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({ to_exercise_id: "e_lateral_raise" })
        .expect(200);

      const swapped = response.body.planned_sets.find(
        (set: { exercise_id: string }) => set.exercise_id === "e_lateral_raise",
      );
      // 근비대 고립: 10~20 (복합은 6~12)
      expect(swapped).toMatchObject({ target_reps_low: 10, target_reps_high: 20 });
    });

    /** 카탈로그에 없는 to_exercise_id 는 400, 세션에 없는 교체 대상은 404 다. */
    it("없는 대상은 400, 세션에 없는 운동은 404 + openapi 스키마", async () => {
      const unknownTarget = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({ to_exercise_id: "e_does_not_exist" });
      const notInSession = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/e_face_pull/swap`)
        .send({ to_exercise_id: "e_lateral_raise" });

      expectErrorMatchesContract("post", SWAP_PATH, 400, unknownTarget);
      expect(unknownTarget.body.error.code).toBe("VALIDATION_ERROR");
      expectErrorMatchesContract("post", SWAP_PATH, 404, notInSession);
      expect(notInSession.body.error.code).toBe("NOT_FOUND");
    });

    it("to_exercise_id 가 없으면 400", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({});

      expectErrorMatchesContract("post", SWAP_PATH, 400, response);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    /** 교체도 같은 가드다 — 이미 세션에 있는 종목으로 바꾸면 중복이 된다. */
    it("이미 세션에 있는 종목으로 교체하면 409 이고 양쪽이 그대로 남는다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({ to_exercise_id: exerciseIds[1] });

      expectErrorMatchesContract("post", SWAP_PATH, 409, response);
      expect(response.body.error.code).toBe("CONFLICT");
      expect(response.body.error.message).toContain("이미 이 세션에 포함된 운동");
      const detail = await request(app.getHttpServer())
        .get(`/v1/sessions/${sessionId}`)
        .expect(200);
      expect(exerciseOrder(detail.body)).toEqual(exerciseIds);
    });

    it("이미 수행 기록이 있으면 409", async () => {
      const planned = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId, exerciseId: exerciseIds[0] },
      });
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned.id,
          actualWeight: 60,
          actualReps: 10,
          actualRir: 2,
          painScore: null,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(),
        },
      });

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({ to_exercise_id: "e_chest_press_machine" });

      expectErrorMatchesContract("post", SWAP_PATH, 409, response);
    });
  });

  /**
   * 편집은 한 요청 안에서 쓰기를 여러 번 한다(교체 = 삭제 + 생성, 위치 지정 추가 = 순서 밀기 + 생성).
   * 트랜잭션으로 묶지 않으면 뒤 쓰기가 유니크 제약(P2002)에 걸릴 때 앞 쓰기만 커밋되어
   * **사용자는 실패(409)를 받았는데 원래 운동이 사라진다**(최종 평가 EVAL-A1 데이터 손실).
   */
  describe("원자성", () => {
    const CONFLICT_TARGET = "e_face_pull";

    /** 커밋하지 않은 채로 CONFLICT_TARGET 1세트를 잡아 두는 트랜잭션. 커밋 시점을 테스트가 정한다. */
    function holdConflictingSet(): { commit: () => void; done: Promise<unknown> } {
      let commit!: () => void;
      const committed = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await tx.plannedSet.create({
            data: {
              sessionId,
              exerciseId: CONFLICT_TARGET,
              orderIndex: 99,
              setNo: 1,
              targetRepsLow: 10,
              targetRepsHigh: 20,
              targetRir: 2,
              restSec: 120,
              recommendedWeight: 0,
              recommendedReps: 10,
              reasonCode: "BASELINE",
              confidence: 0.5,
              rulesVersion: "2026.08.1",
            },
          });
          await committed;
        },
        { timeout: 20_000 },
      );
      return { commit, done };
    }

    /**
     * 다른 요청이 먼저 같은 종목을 넣은 상황을 결정적으로 재현한다.
     * 커밋 전이라 편집 요청의 조회에는 보이지 않고(read committed), 생성만 유니크 인덱스에서 대기한다.
     */
    async function raceAgainstConflict(start: () => Promise<{ status: number; body: unknown }>) {
      const conflict = holdConflictingSet();
      const inFlight = start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      conflict.commit();
      await conflict.done;
      return inFlight;
    }

    it("교체의 생성이 409 로 실패하면 삭제도 되돌아간다", async () => {
      const from = exerciseIds[0];
      const before = await prisma.plannedSet.count({ where: { sessionId, exerciseId: from } });

      const response = await raceAgainstConflict(() =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${sessionId}/exercises/${from}/swap`)
          .send({ to_exercise_id: CONFLICT_TARGET })
          .then((result) => result),
      );

      expectErrorMatchesContract("post", SWAP_PATH, 409, response);
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: from } }),
      ).resolves.toBe(before);
    });

    it("추가의 생성이 409 로 실패하면 순서 밀기도 되돌아간다", async () => {
      const before = await prisma.plannedSet.findMany({
        where: { sessionId },
        select: { id: true, orderIndex: true },
        orderBy: { id: "asc" },
      });

      const response = await raceAgainstConflict(() =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${sessionId}/exercises`)
          .send({ exercise_id: CONFLICT_TARGET, position: 0 })
          .then((result) => result),
      );

      expectErrorMatchesContract("post", ADD_PATH, 409, response);
      await expect(
        prisma.plannedSet.findMany({
          where: { sessionId, exerciseId: { in: exerciseIds } },
          select: { id: true, orderIndex: true },
          orderBy: { id: "asc" },
        }),
      ).resolves.toEqual(before);
    });

    /** 최종 평가 재현 시나리오(EVAL-A1): 교체와 추가가 같은 종목을 동시에 노린다. */
    it("교체와 추가가 같은 종목을 동시에 노려도 운동이 사라지지 않는다", async () => {
      const from = exerciseIds[0];

      const [swap, add] = await Promise.all([
        request(app.getHttpServer())
          .post(`/v1/sessions/${sessionId}/exercises/${from}/swap`)
          .send({ to_exercise_id: CONFLICT_TARGET }),
        request(app.getHttpServer())
          .post(`/v1/sessions/${sessionId}/exercises`)
          .send({ exercise_id: CONFLICT_TARGET }),
      ]);

      expect([swap.status, add.status].sort()).toEqual([200, 409]);
      const detail = await request(app.getHttpServer())
        .get(`/v1/sessions/${sessionId}`)
        .expect(200);
      // 성공한 쪽의 결과만 남는다. 실패한 교체가 원래 운동까지 지우면 여기서 깨진다.
      const expected =
        swap.status === 200
          ? [CONFLICT_TARGET, ...exerciseIds.slice(1)]
          : [...exerciseIds, CONFLICT_TARGET];
      expect(exerciseOrder(detail.body).sort()).toEqual([...expected].sort());
    });
  });

  /**
   * F5 편집은 "오늘 루틴"(아직 안 끝난 세션) 스코프다. 이미 완료한 세션을 편집하면 과거 기록이 바뀐다
   * (STEP 4 평가 I-13) → 409.
   */
  describe("완료된 세션은 편집할 수 없다", () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/complete`)
        .send({})
        .expect(200);
    });

    it("추가는 409 이고 계획세트가 늘지 않는다", async () => {
      const before = await prisma.plannedSet.count({ where: { sessionId } });

      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: "e_face_pull" });

      expectErrorMatchesContract("post", ADD_PATH, 409, response);
      expect(response.body.error.code).toBe("CONFLICT");
      await expect(prisma.plannedSet.count({ where: { sessionId } })).resolves.toBe(before);
    });

    it("삭제는 409 이고 계획세트가 남는다", async () => {
      const response = await request(app.getHttpServer()).delete(
        `/v1/sessions/${sessionId}/exercises/${exerciseIds[1]}`,
      );

      expectErrorMatchesContract("delete", ITEM_PATH, 409, response);
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: exerciseIds[1] } }),
      ).resolves.toBe(3);
    });

    it("교체는 409 이고 원래 운동이 남는다", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${exerciseIds[0]}/swap`)
        .send({ to_exercise_id: "e_chest_press_machine" });

      expectErrorMatchesContract("post", SWAP_PATH, 409, response);
      await expect(
        prisma.plannedSet.count({ where: { sessionId, exerciseId: exerciseIds[0] } }),
      ).resolves.toBe(3);
    });
  });
});
