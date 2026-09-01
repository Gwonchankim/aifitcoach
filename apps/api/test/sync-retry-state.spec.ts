/**
 * F-4a final closure — sync 재시도 상태 머신과 **트랜잭션 내부** 질의 수.
 *
 * `RepeatableRead` 는 동시 쓰기를 직렬화 실패로 거절한다. 격리 수준을 올렸으면 **재시도는
 * 선택이 아니라 의무**다 — 안 하면 정상 동시성이 500 으로 샌다.
 *
 * 여기 seam 은 **전부 테스트 쪽**이다. production 에 middleware 나 테스트 분기를 넣지 않는다.
 * `$transaction` 을 감싸 (a) 원하는 시점에 Prisma 오류를 던지고 (b) 콜백에 넘어가는 `tx` 를
 * Proxy 로 감싸 **트랜잭션 안에서 실제로 나간 질의**를 센다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import { SyncService } from "../src/sync/sync.service";
import type { SyncRequestDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

/** Prisma 가 실제로 던지는 모양 그대로 만든다 — 코드 문자열이 계약이다. */
function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`forced ${code}`, {
    code,
    clientVersion: "test",
    meta,
  });
}

type TxCounts = Record<string, number>;

/**
 * tx 안에서 나간 `performedSet.findMany` 를 **args shape 로** 분류한다.
 * 델리게이트 총합만 보면 latest 를 batch 하고 lifetime 을 N+1 로 둔 부분 batching 을 못 잡는다.
 */
type FindManyKind = "latest" | "lifetime" | "cohort" | "other";

function classifyFindMany(args: unknown): FindManyKind {
  const where = (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
  if (Array.isArray(where.OR)) return "latest";
  const planned = where.plannedSet as { exerciseId?: unknown; loadSemantics?: unknown } | undefined;
  if (planned?.loadSemantics === "assistance" && planned.exerciseId !== undefined)
    return "lifetime";
  if (where.plannedSetId !== undefined) return "cohort";
  return "other";
}

describe("sync 재시도 상태 머신 · tx 내부 질의", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  /** 앱이 쓰는 것과 **다른 연결**이다. 여기 커밋은 앱 트랜잭션의 스냅샷 밖에서 일어난다. */
  let rival: PrismaClient;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    rival = new PrismaClient();
    await rival.$connect();
  }, 60_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  type Client = { $transaction: (...args: unknown[]) => unknown };

  /**
   * `$transaction` 을 감싼다.
   * - `failures`: 앞에서부터 그 순서의 호출을 강제로 실패시킨다(실제 실행 없이).
   * - `beforeFail`: 실패를 던지기 **직전에** 실행한다. 여기서 별도 클라이언트로 경쟁 커밋을
   *   만들면, 다음 시도의 새 RepeatableRead 스냅샷이 그 커밋을 보게 된다 — 실제 수렴 경로다.
   * - `counts`: 콜백에 넘어간 `tx` 의 델리게이트 호출을 `model.method` 로 센다.
   * - `errors`: 던진 오류 **객체 자체**를 순서대로 모은다. 전파된 오류가 이 중 마지막과
   *   같은 인스턴스인지 봐야 "원 오류를 그대로 던진다"를 증명할 수 있다.
   */
  async function withSeam<T>(
    options: {
      failures?: (string | null)[];
      meta?: Record<string, unknown>;
      beforeFail?: (index: number) => Promise<void>;
    },
    body: () => Promise<T>,
  ): Promise<{
    value: T;
    attempts: number;
    counts: TxCounts;
    errors: Prisma.PrismaClientKnownRequestError[];
  }> {
    const client = prisma as unknown as Client;
    const original = client.$transaction.bind(prisma);
    const counts: TxCounts = {};
    const errors: Prisma.PrismaClientKnownRequestError[] = [];
    let attempts = 0;

    client.$transaction = ((...args: unknown[]) => {
      const callback = args[0];
      if (typeof callback !== "function") return original(...args);
      const index = attempts;
      attempts += 1;
      const forced = options.failures?.[index] ?? null;
      if (forced !== null) {
        const error = prismaError(forced, options.meta);
        errors.push(error);
        return (options.beforeFail?.(index) ?? Promise.resolve()).then(() => Promise.reject(error));
      }

      const wrapped = (tx: Record<string, unknown>) => {
        const proxy = new Proxy(tx, {
          get(target, model: string) {
            const delegate = (target as Record<string, unknown>)[model];
            if (typeof delegate !== "object" || delegate === null) return delegate;
            return new Proxy(delegate as Record<string, unknown>, {
              get(inner, method: string) {
                const fn = (inner as Record<string, unknown>)[method];
                if (typeof fn !== "function") return fn;
                return (...callArgs: unknown[]) => {
                  counts[`${model}.${method}`] = (counts[`${model}.${method}`] ?? 0) + 1;
                  if (model === "performedSet" && method === "findMany") {
                    const kind = classifyFindMany(callArgs[0]);
                    counts[`findMany:${kind}`] = (counts[`findMany:${kind}`] ?? 0) + 1;
                  }
                  return (fn as (...a: unknown[]) => unknown).apply(inner, callArgs);
                };
              },
            });
          },
        });
        return (callback as (t: unknown) => unknown)(proxy);
      };
      return original(wrapped, args[1]);
    }) as never;

    try {
      return { value: await body(), attempts, counts, errors };
    } finally {
      client.$transaction = original as never;
    }
  }

  async function seedSession(): Promise<{ sessionId: string; keep: string[] }> {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    // 어시스트가 **없는** 세션을 고른다 — 신규 추가 경로를 밟아야 lifetime 질의가 나간다.
    const candidates = await prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
      include: { plannedSets: { select: { exerciseId: true } } },
    });
    const session =
      candidates.find((row) => !row.plannedSets.some((set) => set.exerciseId === ASSISTED)) ??
      candidates[0];
    return {
      sessionId: session.id,
      keep: [...new Set(session.plannedSets.map((row) => row.exerciseId))],
    };
  }

  function routineMutation(sessionId: string, exerciseIds: string[]) {
    return {
      client_id: randomUUID(),
      entity: "session_routine",
      entity_id: sessionId,
      op: "upsert",
      updated_at: "2026-08-14T08:00:00.000Z",
      payload: { exercise_ids: exerciseIds },
    };
  }

  async function postSync(mutation: ReturnType<typeof routineMutation>) {
    return request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations: [mutation] });
  }

  /** 새 종목을 **실제로 추가하는** routine mutation. 적용 여부를 DB 로 볼 수 있어야 한다. */
  function addingMutation(sessionId: string, keep: string[], added: string) {
    const exercise_ids = [...keep, added];
    return {
      ...routineMutation(sessionId, exercise_ids),
      payload: {
        exercise_ids,
        correlations: [1, 2, 3].map((setNo) => ({
          correlation_id: randomUUID(),
          exercise_id: added,
          set_no: setNo,
        })),
      },
    };
  }

  /** 경쟁 커밋을 **별도 클라이언트**로 넣는다 — seam 이 막 거절한 트랜잭션 바깥이다. */
  async function commitRival(
    mutation: ReturnType<typeof addingMutation>,
    override: { id?: string; clientUpdatedAt?: Date; appliedAt: Date },
  ) {
    await rival.syncMutation.create({
      data: {
        id: override.id ?? mutation.client_id,
        userId: USER_ID,
        entityType: "session_routine",
        entityId: mutation.entity_id,
        op: "upsert",
        payload: mutation.payload,
        clientUpdatedAt: override.clientUpdatedAt ?? new Date(mutation.updated_at),
        appliedAt: override.appliedAt,
        status: "applied",
      },
    });
  }

  /** 사용자의 계획세트 전량을 문자열로 굳힌다 — "영향 행 불변"을 눈으로 세지 않고 비교한다. */
  async function plannedSnapshot(): Promise<string> {
    return JSON.stringify(
      await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } } },
        orderBy: { id: "asc" },
      }),
    );
  }

  describe("재시도 분류", () => {
    it("P2034 1회 → 재시도해서 성공하고 적용은 1회다", async () => {
      const { sessionId, keep } = await seedSession();
      const mutation = routineMutation(sessionId, keep);

      const { value, attempts } = await withSeam(
        { failures: ["P2034"] },
        async () => (await postSync(mutation)).status,
      );

      expect(value).toBe(200);
      // 최초 실패 + 재시도 성공 = 2회.
      expect(attempts).toBe(2);
      expect(await prisma.syncMutation.count({ where: { id: mutation.client_id } })).toBe(1);
    });

    it("P2002 1회 → 새 스냅샷에서 멱등 경로로 수렴한다", async () => {
      const { sessionId, keep } = await seedSession();
      const mutation = routineMutation(sessionId, keep);

      const { value } = await withSeam(
        { failures: ["P2002"] },
        async () => (await postSync(mutation)).status,
      );

      expect(value).toBe(200);
      // 재시도해도 **한 번만** 적용된다(client_id 멱등).
      expect(await prisma.syncMutation.count({ where: { id: mutation.client_id } })).toBe(1);
    });

    it("재시도 대상이 아닌 오류는 즉시 전파된다 — 삼키지 않는다", async () => {
      const { sessionId, keep } = await seedSession();
      const mutation = routineMutation(sessionId, keep);

      const { value, attempts } = await withSeam(
        { failures: ["P2010"] },
        async () => (await postSync(mutation)).status,
      );

      expect(value).toBe(500);
      // 한 번만 시도한다 — 재시도 분류에 없으면 바로 던진다.
      expect(attempts).toBe(1);
      expect(await prisma.syncMutation.count({ where: { id: mutation.client_id } })).toBe(0);
    });

    it.each([["P2034"], ["P2002"]])("%s 가 계속 나면 유한 횟수에서 멈춘다", async (code) => {
      const { sessionId, keep } = await seedSession();
      const mutation = routineMutation(sessionId, keep);
      // **최초 시도를 포함해 총 5회**다. 그보다 넉넉히 실패시켜 소진을 강제한다.
      const failures = Array.from({ length: 12 }, () => code);

      const { value, attempts } = await withSeam(
        { failures },
        async () => (await postSync(mutation)).status,
      );

      expect(value).toBe(500);
      // **무한 재시도가 아니다.** 총 5회를 넘지 않는다.
      expect(attempts).toBe(5);
    });
  });

  /**
   * 강제 오류만으로는 "재시도했다"까지만 보인다. 재시도가 **의미 있으려면** 새 스냅샷이
   * 앞 시도가 못 보던 커밋을 봐야 한다. 그래서 실패 직전에 별도 연결로 실제 커밋을 만든다.
   */
  describe("경쟁 커밋 후 두 번째 스냅샷의 수렴", () => {
    it("같은 client-id 를 남이 먼저 적용했으면 멱등 적용으로 끝난다 — 다시 쓰지 않는다", async () => {
      const { sessionId, keep } = await seedSession();
      const mutation = addingMutation(sessionId, keep, ASSISTED);
      const appliedAt = new Date("2026-08-13T01:02:03.000Z");
      const before = await plannedSnapshot();

      const { value, attempts } = await withSeam(
        {
          failures: ["P2002"],
          beforeFail: async () => {
            await commitRival(mutation, { appliedAt });
          },
        },
        async () => (await postSync(mutation)).body,
      );

      expect(attempts).toBe(2);
      // 두 번째 스냅샷이 그 행을 보고 **적용됨**으로 답한다 — 사용자에게는 성공이다.
      expect(value.applied).toEqual([mutation.client_id]);
      expect(value.conflicts).toEqual([]);

      const rows = await prisma.syncMutation.findMany({ where: { id: mutation.client_id } });
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("applied");
      // **경쟁자가 쓴 값 그대로**다. 덮어썼다면 appliedAt 이 지금 시각으로 바뀐다.
      expect(rows[0].appliedAt?.toISOString()).toBe(appliedAt.toISOString());
      // 멱등이므로 루틴은 **다시 적용되지 않는다** — 어시스트 종목은 생기지 않는다.
      expect(await prisma.plannedSet.count({ where: { sessionId, exerciseId: ASSISTED } })).toBe(0);
      expect(await plannedSnapshot()).toBe(before);
    });

    it("남의 더 최신 스냅샷이 먼저 커밋되면 LWW 로 밀려 conflict 가 된다", async () => {
      const { sessionId, keep } = await seedSession();
      const mutation = addingMutation(sessionId, keep, ASSISTED);
      const winner = randomUUID();
      const before = await plannedSnapshot();

      const { value, attempts } = await withSeam(
        {
          failures: ["P2002"],
          beforeFail: async () => {
            await commitRival(mutation, {
              id: winner,
              // 내 updated_at(08-14T08:00) 보다 **뒤**다 — LWW 승자다.
              clientUpdatedAt: new Date("2026-08-14T09:00:00.000Z"),
              appliedAt: new Date("2026-08-14T09:00:01.000Z"),
            });
          },
        },
        async () => (await postSync(mutation)).body,
      );

      expect(attempts).toBe(2);
      expect(value.applied).toEqual([]);
      expect(value.conflicts).toEqual([
        { client_id: mutation.client_id, entity_id: sessionId, reason: "stale_update" },
      ]);

      // 내 mutation 은 **conflict 로 기록**된다(조용히 사라지지 않는다).
      const mine = await prisma.syncMutation.findUnique({ where: { id: mutation.client_id } });
      expect(mine?.status).toBe("conflict");
      expect(mine?.appliedAt).toBeNull();
      // 진 쪽의 쓰기는 **하나도** 반영되지 않는다.
      expect(await prisma.plannedSet.count({ where: { sessionId, exerciseId: ASSISTED } })).toBe(0);
      expect(await plannedSnapshot()).toBe(before);
    });
  });

  describe("소진 시 전파되는 오류와 DB 불변", () => {
    async function exhaust(code: string, meta?: Record<string, unknown>) {
      const { sessionId, keep } = await seedSession();
      const mutation = addingMutation(sessionId, keep, ASSISTED);
      const before = await plannedSnapshot();
      const sync = app.get(SyncService);

      const { value, attempts, errors } = await withSeam(
        { failures: Array.from({ length: 12 }, () => code), meta },
        async () => {
          try {
            await sync.sync(USER_ID, { mutations: [mutation] } as unknown as SyncRequestDto);
            return null;
          } catch (error) {
            return error;
          }
        },
      );
      return { sessionId, mutation, before, value, attempts, errors };
    }

    it.each([["P2034"], ["P2002"]])(
      "%s 소진이면 **마지막 오류 객체 그대로** 나오고 영향 행이 안 바뀐다",
      async (code) => {
        const { sessionId, mutation, before, value, attempts, errors } = await exhaust(code);

        expect(attempts).toBe(5);
        expect(errors.length).toBe(5);
        // 감싸거나 바꾸지 않는다 — **마지막에 던진 그 객체**다.
        expect(value).toBe(errors[4]);
        expect((value as Prisma.PrismaClientKnownRequestError).code).toBe(code);
        // 영향 행 전부 불변: 계획세트도, mutation 기록도 남지 않는다.
        expect(await plannedSnapshot()).toBe(before);
        expect(await prisma.plannedSet.count({ where: { sessionId, exerciseId: ASSISTED } })).toBe(
          0,
        );
        expect(await prisma.syncMutation.count({ where: { id: mutation.client_id } })).toBe(0);
      },
    );

    it("sync 와 무관한 unique 충돌(P2002)도 총 5회 뒤 원 오류로 나온다 — 코드만 보고 재시도한다", async () => {
      // 재시도 분류는 **오류 코드**만 본다. 원인이 sync 의 stale 스냅샷이 아니어도 5회를 채운다.
      // 그러니 마지막에 나오는 것은 반드시 **가공되지 않은 원 오류**여야 한다.
      const meta = { target: ["users_email_key"] };
      const { before, value, attempts, errors } = await exhaust("P2002", meta);

      expect(attempts).toBe(5);
      expect(value).toBe(errors[4]);
      const propagated = value as Prisma.PrismaClientKnownRequestError;
      expect(propagated.code).toBe("P2002");
      // meta 까지 그대로다 — 어느 제약이 깨졌는지가 운영에서 유일한 단서다.
      expect(propagated.meta).toEqual(meta);
      expect(await plannedSnapshot()).toBe(before);
    });
  });

  describe("recompute fail closed", () => {
    it("prefetch map 에 키가 없으면 invariant error 이고 저장 행이 안 바뀐다", async () => {
      const { sessionId } = await seedSession();
      const planned = await prisma.plannedSet.findMany({
        where: { sessionId },
        orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
      });
      for (const row of planned) {
        await prisma.performedSet.create({
          data: {
            plannedSetId: row.id,
            actualWeight: row.recommendedWeight ?? "20",
            actualReps: row.targetRepsHigh ?? 10,
            actualRir: 2,
            completed: true,
            clientId: randomUUID(),
            performedAt: new Date("2026-08-14T10:00:00.000Z"),
          },
        });
      }
      const next = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } }, sessionId: { not: sessionId } },
        orderBy: { id: "asc" },
      });
      const before = JSON.stringify(next);

      // **prefetch 를 빠뜨린 상태**를 강제한다 — 조용한 기본값이면 처방이 초기화된다.
      const recommendation = app.get(RecommendationService);
      const spy = jest.spyOn(recommendation, "prefetchHistories").mockResolvedValue(new Map());
      try {
        await request(app.getHttpServer())
          .post(`/v1/sessions/${sessionId}/complete`)
          .send({})
          .expect(500);
      } finally {
        spy.mockRestore();
      }

      const after = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } }, sessionId: { not: sessionId } },
        orderBy: { id: "asc" },
      });
      // 저장 행 **변경 0** — 절반만 적용된 상태를 남기지 않는다.
      expect(JSON.stringify(after)).toBe(before);
    });
  });

  describe("트랜잭션 내부 질의 수", () => {
    it("새 종목 2개를 넣어도 tx 안 이력·correlation 질의가 각각 1회다", async () => {
      const { sessionId, keep } = await seedSession();
      // 어시스트 종목을 **반드시 새로 추가**한다(lifetime 질의가 실제로 나가야 한다).
      // 이미 들어 있는 세션이면 그 종목은 "신규"가 아니라 factory 를 안 탄다.
      if (keep.includes(ASSISTED)) {
        throw new Error("이 세션에는 이미 어시스트가 있어 신규 추가 경로를 못 밟는다.");
      }
      const others = (
        await prisma.exercise.findMany({
          where: { id: { notIn: [...keep, ASSISTED] } },
          orderBy: { id: "asc" },
          take: 1,
        })
      ).map((row) => row.id);
      const added = [ASSISTED, ...others];
      expect(added.length).toBe(2);

      const correlations = added.flatMap((exerciseId) =>
        [1, 2, 3].map((setNo) => ({
          correlation_id: randomUUID(),
          exercise_id: exerciseId,
          set_no: setNo,
        })),
      );
      const mutation = {
        ...routineMutation(sessionId, [...keep, ...added]),
        payload: { exercise_ids: [...keep, ...added], correlations },
      };

      const { counts } = await withSeam({}, async () => {
        await postSync(mutation).then((response) => expect(response.status).toBe(200));
      });

      // **target 에 어시스트가 실제로 들어갔는지 먼저 확인한다** — 아니면 lifetime 단언이 공허하다.
      const assistedTargeted = added.includes(ASSISTED);
      expect(assistedTargeted).toBe(true);

      // args shape 별 exact count. 종목이 2개여도 각각 1회다.
      expect(counts["findMany:latest"] ?? 0).toBe(1);
      expect(counts["findMany:lifetime"] ?? 0).toBe(1);
      // single-spec fallback 을 추가하면 latest 가 2 이상이 된다.
      expect(counts["performedSet.findMany"] ?? 0).toBe(2);
      expect(counts["userRirCalibration.findUnique"] ?? 0).toBe(1);
      expect(counts["plannedSet.count"] ?? 0).toBe(1);
      // 카탈로그도 한 번에 읽는다(종목마다 findUnique 하지 않는다).
      expect(counts["exercise.findUnique"] ?? 0).toBe(0);
      expect(counts["exercise.findMany"] ?? 0).toBe(1);

      // 두 종목이 실제로 생성됐다 — 빈 loop 로 통과하지 않는다.
      expect(
        await prisma.plannedSet.count({ where: { sessionId, exerciseId: { in: added } } }),
      ).toBe(6);
    });
  });
});
