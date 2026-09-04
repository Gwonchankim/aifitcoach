/**
 * STEP 6 Sprint 0 red proof.
 *
 * Sprint 1A implementation proof. Each assertion observes persisted state or a pull
 * response rather than merely checking that the HTTP endpoint is no longer a 501.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;
const T1 = "2026-08-15T08:00:00.000Z";
const T2 = "2026-08-15T08:01:00.000Z";

describe("STEP 6 sync 계약 잠금", () => {
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

  async function firstPlannedSet() {
    return prisma.plannedSet.findFirstOrThrow({
      where: { session: { program: { userId: USER_ID } } },
      orderBy: { id: "asc" },
    });
  }

  function performedMutation(plannedSetId: string, weight: number, updatedAt = T1) {
    return {
      client_id: randomUUID(),
      entity: "performed_set",
      entity_id: plannedSetId,
      op: "upsert",
      updated_at: updatedAt,
      payload: {
        actual_weight: weight,
        actual_reps: 8,
        actual_rir: 2,
        actual_time_sec: null,
        pain_score: null,
        completed: true,
      },
    };
  }

  it("유실·중복 0: push와 동일 재시도 뒤 무게·횟수·RIR이 planned_set 한 행에 정확히 남는다", async () => {
    const planned = await firstPlannedSet();
    const mutation = performedMutation(planned.id, 50);
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [mutation] })
      .expect(200);

    const stored = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(stored.actualWeight)).toBe(50);
    expect(stored).toMatchObject({
      plannedSetId: planned.id,
      clientId: mutation.client_id,
      actualReps: 8,
      actualRir: 2,
      actualTimeSec: null,
      painScore: null,
      completed: true,
      performedAt: new Date(T1),
      updatedAt: new Date(T1),
    });

    // 네트워크 재전송은 같은 client_id를 재사용한다. 두 번째 행을 만들거나 값을 바꾸면 안 된다.
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [mutation] })
      .expect(200);
    await expect(prisma.performedSet.count({ where: { plannedSetId: planned.id } })).resolves.toBe(
      1,
    );
    const retried = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(retried.actualWeight)).toBe(50);
    expect(retried).toMatchObject({
      clientId: mutation.client_id,
      actualReps: 8,
      actualRir: 2,
      completed: true,
      updatedAt: new Date(T1),
    });
  });

  it("중복 0: 같은 planned_set의 두 번째 서버 행은 DB가 거절한다", async () => {
    const planned = await firstPlannedSet();
    await prisma.performedSet.create({
      data: {
        plannedSetId: planned.id,
        actualWeight: 50,
        actualReps: 8,
        actualRir: 2,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date(T1),
      },
    });

    await expect(
      prisma.performedSet.create({
        data: {
          plannedSetId: planned.id,
          actualWeight: 60,
          actualReps: 8,
          actualRir: 2,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(T2),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(prisma.performedSet.count({ where: { plannedSetId: planned.id } })).resolves.toBe(
      1,
    );
  });

  it("LWW: 역순 push에도 더 최신 updated_at의 값이 남는다", async () => {
    const planned = await firstPlannedSet();
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [performedMutation(planned.id, 60, T2), performedMutation(planned.id, 50, T1)],
      })
      .expect(200);

    const stored = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(stored.actualWeight)).toBe(60);
    expect(stored.updatedAt.toISOString()).toBe(T2);
  });

  it("cursor: push change를 pull하고 다음 opaque cursor를 재사용해 replay 없이 돌려준다", async () => {
    const planned = await firstPlannedSet();
    const mutationId = randomUUID();
    const pushed = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [{ ...performedMutation(planned.id, 50), client_id: mutationId }] })
      .expect(200);
    const logged = await prisma.syncMutation.findUniqueOrThrow({ where: { id: mutationId } });

    if (!Array.isArray(pushed.body.changes)) {
      throw new Error("pull 응답에 changes 배열이 없다");
    }
    expect(pushed.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "performed_set",
          entity_id: planned.id,
          op: "upsert",
          server_seq: logged.serverSeq.toString(),
        }),
      ]),
    );
    expect(pushed.body.next_cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(pushed.body.next_cursor).not.toContain(logged.serverSeq.toString());
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ since: pushed.body.next_cursor, mutations: [] })
      .expect(200)
      .expect(({ body }) => expect(body.changes).toEqual([]));
  });

  it("opaque cursor는 손상되면 400이고 페이지 replay 없이 재사용된다", async () => {
    const planned = await firstPlannedSet();
    const first = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [performedMutation(planned.id, 50)] })
      .expect(200);
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ since: "1", mutations: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ since: first.body.next_cursor, mutations: [] })
      .expect(200)
      .expect(({ body }) => expect(body.changes).toEqual([]));
  });

  it("동일 logical entity의 동시 LWW는 항상 새 mutation을 남기고 500이 아니다", async () => {
    const planned = await firstPlannedSet();
    const older = performedMutation(planned.id, 50, T1);
    const newer = performedMutation(planned.id, 70, T2);
    const responses = await Promise.all(
      [older, newer, older, newer].map((mutation) =>
        request(app.getHttpServer())
          .post("/v1/sync")
          .send({ mutations: [mutation] }),
      ),
    );
    expect(responses.map((response) => response.status)).not.toContain(500);
    await expect(
      prisma.performedSet.findUniqueOrThrow({ where: { plannedSetId: planned.id } }),
    ).resolves.toMatchObject({ actualWeight: expect.anything(), updatedAt: new Date(T2) });
    const stored = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(stored.actualWeight)).toBe(70);
  });

  it("동일 client_id의 불일치 재시도는 conflict이고 batch applied에는 한 번만 나온다", async () => {
    const planned = await firstPlannedSet();
    const mutation = performedMutation(planned.id, 50);
    const result = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          mutation,
          mutation,
          { ...mutation, payload: { ...mutation.payload, actual_weight: 80 } },
        ],
      })
      .expect(200);
    expect(result.body.applied).toEqual([mutation.client_id]);
    expect(result.body.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_id: mutation.client_id, reason: "client_id_mismatch" }),
      ]),
    );
    await expect(
      prisma.performedSet.findUniqueOrThrow({ where: { plannedSetId: planned.id } }),
    ).resolves.toMatchObject({ actualWeight: expect.anything() });
    const stored = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(stored.actualWeight)).toBe(50);
  });

  it("서로 다른 entity가 동일 client_id로 동시에 오면 한 mutation만 적용되고 500이 아니다", async () => {
    const planned = await prisma.plannedSet.findMany({
      where: { session: { program: { userId: USER_ID } } },
      orderBy: { id: "asc" },
      take: 2,
    });
    expect(planned).toHaveLength(2);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const clientId = randomUUID();
      const responses = await Promise.all(
        planned.map((set, index) =>
          request(app.getHttpServer())
            .post("/v1/sync")
            .send({
              mutations: [
                {
                  ...performedMutation(set.id, 50 + index),
                  client_id: clientId,
                },
              ],
            }),
        ),
      );

      expect(responses.map((response) => response.status)).not.toContain(500);
      await expect(prisma.syncMutation.count({ where: { id: clientId } })).resolves.toBe(1);
    }
  });

  it("한 mutation의 도메인 검증 실패는 별도 conflict로 남고 무관한 mutation은 적용된다", async () => {
    const planned = await prisma.plannedSet.findMany({
      where: { session: { program: { userId: USER_ID } } },
      orderBy: { id: "asc" },
      take: 2,
    });
    expect(planned).toHaveLength(2);
    const invalid = performedMutation(planned[0].id, 50);
    delete (invalid.payload as { actual_reps?: number }).actual_reps;
    const valid = performedMutation(planned[1].id, 60);

    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [invalid, valid] });

    expect(response.status).toBe(200);
    expect(response.body.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_id: invalid.client_id, reason: "validation_failed" }),
      ]),
    );
    expect(response.body.applied).toContain(valid.client_id);
    await expect(
      prisma.performedSet.findUnique({ where: { plannedSetId: planned[0].id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.performedSet.findUnique({ where: { plannedSetId: planned[1].id } }),
    ).resolves.not.toBeNull();
  });

  it("batch는 세트 뒤 세션 완료를 적용하고 권위 추천을 session change에 싣는다", async () => {
    const planned = await prisma.plannedSet.findFirstOrThrow({
      where: {
        exercise: { metric: "reps" },
        session: { program: { userId: USER_ID } },
      },
      include: { session: true },
      orderBy: { session: { scheduledDate: "asc" } },
    });
    const setMutation = performedMutation(planned.id, 50);
    const completion = {
      client_id: randomUUID(),
      entity: "session",
      entity_id: planned.sessionId,
      op: "upsert",
      updated_at: T2,
      payload: { status: "completed", difficulty: "moderate" },
    };

    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [completion, setMutation] })
      .expect(200);

    expect(response.body.applied).toEqual(
      expect.arrayContaining([setMutation.client_id, completion.client_id]),
    );
    await expect(
      prisma.workoutSession.findUniqueOrThrow({ where: { id: planned.sessionId } }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(response.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "session",
          entity_id: planned.sessionId,
          data: expect.objectContaining({ next_recommendations: expect.any(Array) }),
        }),
      ]),
    );
  });

  it("session_routine은 ordered snapshot을 원자 적용한다", async () => {
    const first = await firstPlannedSet();
    const current = await prisma.plannedSet.findMany({
      where: { sessionId: first.sessionId },
      orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    });
    const exerciseIds = [...new Set(current.map((set) => set.exerciseId))];
    expect(exerciseIds.length).toBeGreaterThan(1);
    const reversed = [...exerciseIds].reverse();
    const mutation = {
      client_id: randomUUID(),
      entity: "session_routine",
      entity_id: first.sessionId,
      op: "upsert",
      updated_at: T1,
      payload: { exercise_ids: reversed },
    };

    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [mutation] })
      .expect(200)
      .expect(({ body }) => expect(body.applied).toContain(mutation.client_id));

    const stored = await prisma.plannedSet.findMany({
      where: { sessionId: first.sessionId },
      orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    });
    expect([...new Set(stored.map((set) => set.exerciseId))]).toEqual(reversed);
  });

  async function provisionalRoutineFixture() {
    const first = await firstPlannedSet();
    const current = await prisma.plannedSet.findMany({
      where: { sessionId: first.sessionId },
      orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    });
    const exerciseIds = [...new Set(current.map((set) => set.exerciseId))];
    const added = await prisma.exercise.findFirstOrThrow({
      where: { id: { notIn: exerciseIds } },
      orderBy: { id: "asc" },
    });
    const correlations = [1, 2, 3].map((setNo) => ({
      correlation_id: randomUUID(),
      exercise_id: added.id,
      set_no: setNo,
    }));
    const routine = {
      client_id: randomUUID(),
      entity: "session_routine",
      entity_id: first.sessionId,
      op: "upsert",
      updated_at: T1,
      payload: {
        exercise_ids: [...exerciseIds, added.id],
        correlations,
      },
    };
    const performed = performedMutation(correlations[0].correlation_id, 55, T2);
    return { first, added, correlations, routine, performed };
  }

  it("D-31 batch 순서: routine mapping 뒤에만 임시 performed_set을 authoritative ID로 적용한다", async () => {
    const { added, correlations, routine, performed } = await provisionalRoutineFixture();
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      // 일부러 performed_set을 먼저 보내도 서버의 고정 적용 순서가 routine을 선행해야 한다.
      .send({ mutations: [performed, routine] })
      .expect(200);

    expectMatchesContract("post", "/sync", 200, response.body);
    expect(response.body.applied).toEqual(
      expect.arrayContaining([routine.client_id, performed.client_id]),
    );
    const mapping = response.body.planned_set_mappings.find(
      (item: { correlation_id: string }) => item.correlation_id === correlations[0].correlation_id,
    );
    expect(mapping).toMatchObject({
      correlation_id: correlations[0].correlation_id,
      planned_set: expect.objectContaining({ exercise_id: added.id, set_no: 1 }),
    });
    expect(mapping.planned_set_id).not.toBe(correlations[0].correlation_id);
    await expect(
      prisma.plannedSet.findUnique({ where: { id: correlations[0].correlation_id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.performedSet.findUnique({ where: { plannedSetId: mapping.planned_set_id } }),
    ).resolves.toMatchObject({ clientId: performed.client_id });
    await expect(
      prisma.syncMutation.findUniqueOrThrow({ where: { id: performed.client_id } }),
    ).resolves.toMatchObject({ entityId: mapping.planned_set_id });
  });

  it("D-31 correlation 멱등: 응답 유실 재전송에도 같은 mapping과 planned set 1개만 반환한다", async () => {
    const { added, correlations, routine, performed } = await provisionalRoutineFixture();
    const body = { mutations: [routine, performed] };
    const first = await request(app.getHttpServer()).post("/v1/sync").send(body).expect(200);
    const retry = await request(app.getHttpServer()).post("/v1/sync").send(body).expect(200);
    const ids = (response: typeof first) =>
      response.body.planned_set_mappings
        .filter((item: { correlation_id: string }) =>
          correlations.some(({ correlation_id }) => correlation_id === item.correlation_id),
        )
        .map((item: { planned_set_id: string }) => item.planned_set_id);

    expect(ids(retry)).toEqual(ids(first));
    expect(new Set(ids(first)).size).toBe(3);
    await expect(
      prisma.plannedSet.count({ where: { sessionId: routine.entity_id, exerciseId: added.id } }),
    ).resolves.toBe(3);
    await expect(
      prisma.performedSet.count({ where: { plannedSet: { exerciseId: added.id } } }),
    ).resolves.toBe(1);
  });

  it("retry와 동일 시각 tie는 client_id로 결정되고 두 번째 서버 행을 만들지 않는다", async () => {
    const planned = await firstPlannedSet();
    const winner = {
      ...performedMutation(planned.id, 70),
      client_id: "00000000-0000-4000-8000-000000000102",
    };
    const loser = {
      ...performedMutation(planned.id, 60),
      client_id: "00000000-0000-4000-8000-000000000101",
    };
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [winner] })
      .expect(200);
    const retry = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [winner] })
      .expect(200);
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [loser] })
      .expect(200);
    expect(retry.body.applied).toEqual([winner.client_id]);
    await expect(prisma.syncMutation.count({ where: { id: winner.client_id } })).resolves.toBe(1);
    await expect(
      prisma.performedSet.findUniqueOrThrow({ where: { plannedSetId: planned.id } }),
    ).resolves.toMatchObject({ actualWeight: expect.anything() });
    const stored = await prisma.performedSet.findUniqueOrThrow({
      where: { plannedSetId: planned.id },
    });
    expect(Number(stored.actualWeight)).toBe(70);
  });

  it("delete는 수행 기록을 지우고 pull에 tombstone을 남긴다", async () => {
    const planned = await firstPlannedSet();
    await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [performedMutation(planned.id, 50)] })
      .expect(200);
    const deleted = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          {
            client_id: randomUUID(),
            entity: "performed_set",
            entity_id: planned.id,
            op: "delete",
            updated_at: T2,
            payload: {},
          },
        ],
      })
      .expect(200);
    await expect(
      prisma.performedSet.findUnique({ where: { plannedSetId: planned.id } }),
    ).resolves.toBeNull();
    expect(deleted.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: planned.id, op: "delete", data: null }),
      ]),
    );
  });
});
