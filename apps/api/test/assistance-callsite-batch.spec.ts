/**
 * F-4a final fixup — **production call-site** 의 batch 경계와 action display gate.
 *
 * helper 를 직접 불러 "1회"를 세는 것은 증거가 아니다. loop 를 도는 것은 endpoint 다 —
 * 프로그램 생성과 세션 종료를 **실제로 호출**해서 종목 수가 늘어도 질의가 고정인지 본다.
 *
 * `recommended_action` 은 **처방 축**이라 state/reason/weight 와 같은 게이트를 받는다.
 * `assistance_safety_status` 와 `load_kind` 는 구조·안전 축이라 게이트되지 않는다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PlannedSetFactory } from "../src/programs/planned-set.factory";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  RecommendationService,
  requireHistory,
} from "../src/recommendation/recommendation.service";
import { plannedSetResponse } from "../src/sync/sync.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

type PlannedSetWire = {
  exercise_id: string;
  load_kind: string;
  recommendation_state: string | null;
  recommended_action: { kind: string; exercise_id: string } | null;
  assistance_safety_status: string | null;
  recommendation_gate: string;
};

describe("production call-site batch · action gate", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  /**
   * **질의 종류별로 나눠 센다.** 총합 상한만 보면 latest 를 batch 하고 lifetime 을 N+1 로 두는
   * 부분 batching 을 못 잡는다. 코드 계약과 정확히 대응하는 shape 로 구분한다:
   *   - latest  : `where.OR[].plannedSet.exerciseId` (spec 별 분기)
   *   - lifetime: `where.plannedSet.exerciseId.in` + `loadSemantics: assistance`
   *   - cohort  : `where.plannedSetId.in` (수행 사실 존재 확인)
   */
  type QueryKinds = { latest: number; lifetime: number; cohort: number; other: number };

  function classify(args: unknown): keyof QueryKinds {
    const where = (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    if (Array.isArray(where.OR)) return "latest";
    const planned = where.plannedSet as
      { exerciseId?: unknown; loadSemantics?: unknown } | undefined;
    if (planned?.loadSemantics === "assistance" && planned.exerciseId !== undefined)
      return "lifetime";
    if (where.plannedSetId !== undefined) return "cohort";
    return "other";
  }

  /** Observe actual delegates on both clients; post-lock writers now read through tx.
   * Forward the original receiver, args, PrismaPromise and transaction options unchanged.
   */
  function observeReads(
    onPerformed: (args: unknown, scope: "root" | "tx") => void,
    onCalibration: (scope: "root" | "tx") => void,
  ) {
    const original = prisma.performedSet.findMany.bind(prisma.performedSet);
    const spy = jest.spyOn(prisma.performedSet, "findMany").mockImplementation(((
      args: Parameters<typeof original>[0],
    ) => {
      onPerformed(args, "root");
      return original(args);
    }) as typeof original);
    const calOriginal = prisma.userRirCalibration.findUnique.bind(prisma.userRirCalibration);
    const calSpy = jest.spyOn(prisma.userRirCalibration, "findUnique").mockImplementation(((
      args: unknown,
    ) => {
      onCalibration("root");
      return (calOriginal as (a: unknown) => unknown)(args);
    }) as unknown as typeof prisma.userRirCalibration.findUnique);
    type TransactionHost = { $transaction: (...args: unknown[]) => Promise<unknown> };
    const host = prisma as unknown as TransactionHost;
    const transaction = host.$transaction.bind(prisma);
    const transactionSpy = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
      const callback = args[0];
      if (typeof callback !== "function") return transaction(...args);
      return transaction(
        (tx: Prisma.TransactionClient) =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                if (key === "performedSet" || key === "userRirCalibration")
                  return new Proxy(target[key], {
                    get(delegate, method) {
                      const value = Reflect.get(delegate, method);
                      const observed =
                        (key === "performedSet" && method === "findMany") ||
                        (key === "userRirCalibration" && method === "findUnique");
                      if (observed)
                        return (...queryArgs: unknown[]) => {
                          if (key === "performedSet") onPerformed(queryArgs[0], "tx");
                          else onCalibration("tx");
                          return Reflect.apply(value, delegate, queryArgs);
                        };
                      return typeof value === "function" ? value.bind(delegate) : value;
                    },
                  });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ...args.slice(1),
      );
    });
    return () => {
      transactionSpy.mockRestore();
      spy.mockRestore();
      calSpy.mockRestore();
    };
  }

  async function countQueries<T>(body: () => Promise<T>): Promise<[T, QueryKinds, number, number]> {
    const kinds: QueryKinds = { latest: 0, lifetime: 0, cohort: 0, other: 0 };
    let calibration = 0;
    let rootReads = 0;
    const restore = observeReads(
      (args, scope) => {
        kinds[classify(args)] += 1;
        if (scope === "root") rootReads += 1;
      },
      (scope) => {
        calibration += 1;
        if (scope === "root") rootReads += 1;
      },
    );
    try {
      return [await body(), kinds, calibration, rootReads];
    } finally {
      restore();
    }
  }

  /** 뒤 호환: 총합만 필요한 곳. */
  async function countPerformedQueries<T>(body: () => Promise<T>): Promise<[T, number]> {
    const [value, kinds] = await countQueries(body);
    return [value, kinds.latest + kinds.lifetime + kinds.cohort + kinds.other];
  }

  async function generate(): Promise<void> {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
  }

  async function sessions() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
  }

  /** 대상에 어시스트 종목이 실제로 들어갔는지 — 안 들어갔으면 lifetime 단언이 공허하다. */
  async function assistedIsTargeted(): Promise<boolean> {
    return (
      (await prisma.plannedSet.count({
        where: { session: { program: { userId: USER_ID } }, exerciseId: ASSISTED },
      })) > 0
    );
  }

  describe("① 프로그램 생성 endpoint — query-kind exact count", () => {
    it("POST /programs/generate 는 latest 1 · calibration 1 이다", async () => {
      const [, kinds, calibration] = await countQueries(generate);
      expect(kinds.latest).toBe(1);
      expect(calibration).toBe(1);
      // 생성 시점에는 아직 planned row 가 없어 cohort 질의도 없다.
      expect(kinds.cohort).toBe(0);
    });

    /**
     * **어시스트 유무를 나눠서 exact 로 센다.** 한 프로그램만 보면 lifetime 이 "상수 1" 인지
     * "어시스트가 있을 때만 1" 인지 구분되지 않는다. 어시스트를 강제로 배제한 대조군이 있어야
     * `loadSemantics === "assistance"` 분기가 실제로 존재한다는 증거가 된다.
     */
    async function generateWithout(...avoid: string[]): Promise<void> {
      await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...PROGRAM, avoid_exercises: avoid })
        .expect(201);
    }

    const WEEKS = 2; // MATERIALIZED_WEEK_WINDOW

    it("어시스트가 대상이면 generate lifetime 1 · materialize lifetime 2 다", async () => {
      const [, gen, genCal] = await countQueries(generate);
      const [, mat, matCal, matRootReads] = await countQueries(async () => {
        await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      });

      // **비공허성 선행 확인**: 어시스트가 실제로 대상이어야 아래 단언이 의미를 가진다.
      expect(await assistedIsTargeted()).toBe(true);
      expect(gen).toEqual({ latest: 1, lifetime: 1, cohort: 0, other: 0 });
      expect(genCal).toBe(1);
      // materialize 는 **주 단위**로 한 번씩이다(세션·종목 수를 따라가지 않는다).
      expect(mat).toEqual({ latest: WEEKS, lifetime: WEEKS, cohort: 0, other: 0 });
      expect(matCal).toBe(WEEKS);
      // Latest/lifetime/calibration reads are intentionally inside the post-lock tx.
      expect(matRootReads).toBe(0);
    });

    it("어시스트를 배제하면 lifetime 은 0 이고 latest 는 그대로다", async () => {
      const [, gen, genCal] = await countQueries(() => generateWithout(ASSISTED));
      const [, mat, matCal, matRootReads] = await countQueries(async () => {
        await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      });

      // 대조군이 실제로 어시스트 없는 프로그램인지 확인한다.
      expect(await assistedIsTargeted()).toBe(false);
      // lifetime 만 사라진다 — latest·calibration 은 어시스트와 무관하게 같은 횟수다.
      expect(gen).toEqual({ latest: 1, lifetime: 0, cohort: 0, other: 0 });
      expect(genCal).toBe(1);
      expect(mat).toEqual({ latest: WEEKS, lifetime: 0, cohort: 0, other: 0 });
      expect(matCal).toBe(WEEKS);
      expect(matRootReads).toBe(0);
    });

    it("materialize 질의 수는 종목 수와 무관하다", async () => {
      await generate();
      const [, kinds, , rootReads] = await countQueries(async () => {
        await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      });

      const exercises = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } } },
        select: { exerciseId: true },
        distinct: ["exerciseId"],
      });
      // 종목이 주 질의 수보다 훨씬 많다 — N+1 이면 여기서 갈린다.
      expect(exercises.length).toBeGreaterThan(WEEKS * 2);
      expect(kinds.latest + kinds.lifetime).toBe(WEEKS * 2);
      expect(rootReads).toBe(0);
    });

    it("즉석 세션(ad-hoc)도 종목 수와 무관하다", async () => {
      // 세션을 지워서 휴식일을 만들 수 없다 — 다음 조회가 다시 만든다(ad-hoc-session.spec 의 교훈).
      // 고정 "오늘"(2026-08-14 금)이 휴식일인 **주 2일 프로그램**으로 만든다.
      await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...PROGRAM, days_per_week: 2 })
        .expect(201);
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      expect(
        await prisma.workoutSession.count({
          where: { program: { userId: USER_ID }, scheduledDate: utcToday() },
        }),
      ).toBe(0);

      const [created, calls] = await countPerformedQueries(async () => {
        const response = await request(app.getHttpServer())
          .post("/v1/sessions/ad-hoc")
          .send({ body_part: "legs" })
          .expect(201);
        return response.body as { planned_sets: { exercise_id: string }[] };
      });

      const picked = new Set(created.planned_sets.map((row) => row.exercise_id)).size;
      expect(picked).toBeGreaterThan(1);
      // ad-hoc 은 lazy materialize(주 2회) + 자기 prefetch 1회를 함께 탄다 —
      // **종목 수를 따라가지 않는 것**이 핵심이다.
      expect(calls).toBeLessThanOrEqual(4);
      expect(calls).toBeLessThan(picked * 2);
    });

    /**
     * 추가·교체는 **어시스트가 빠진 세션**에서 시작해야 배선을 밟는다.
     * 이미 들어 있으면 409 라 fixture 가 조용히 아무것도 검증하지 못한다.
     */
    async function sessionWithoutAssisted(): Promise<{ id: string; present: string[] }> {
      await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...PROGRAM, avoid_exercises: [ASSISTED] })
        .expect(201);
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      const [first] = await sessions();
      const present = [
        ...new Set(
          (
            await prisma.plannedSet.findMany({
              where: { sessionId: first.id },
              select: { exerciseId: true },
            })
          ).map((row) => row.exerciseId),
        ),
      ];
      expect(present).not.toContain(ASSISTED);
      return { id: first.id, present };
    }

    /** 세션에 없는 **비어시스트** 종목 하나 — 대조군이다. */
    async function plainOutside(present: string[]): Promise<string> {
      const row = await prisma.exercise.findFirstOrThrow({
        where: { id: { notIn: [...present, ASSISTED] }, loadSemantics: "external_load" },
        orderBy: { id: "asc" },
      });
      return row.id;
    }

    it.each([
      ["어시스트", ASSISTED, 1],
      ["비어시스트", null, 0],
    ])(
      "운동 추가(%s)는 latest 1 · calibration 1 이고 lifetime 이 갈린다",
      async (_label, fixed, lifetime) => {
        const { id, present } = await sessionWithoutAssisted();
        const added = fixed ?? (await plainOutside(present));

        const [, kinds, calibration] = await countQueries(async () => {
          await request(app.getHttpServer())
            .post(`/v1/sessions/${id}/exercises`)
            .send({ exercise_id: added })
            .expect(200);
        });

        expect(kinds).toEqual({ latest: 1, lifetime, cohort: 0, other: 0 });
        expect(calibration).toBe(1);
        // 실제로 들어갔는지 — 안 들어갔으면 위 숫자는 아무것도 뜻하지 않는다.
        expect(await prisma.plannedSet.count({ where: { sessionId: id, exerciseId: added } })).toBe(
          3,
        );
      },
    );

    it.each([
      ["어시스트", ASSISTED, 1],
      ["비어시스트", null, 0],
    ])(
      "운동 교체(→%s)는 latest 1 · calibration 1 이고 lifetime 이 갈린다",
      async (_label, fixed, lifetime) => {
        const { id, present } = await sessionWithoutAssisted();
        const to = fixed ?? (await plainOutside(present));
        const from = present[0];

        const [, kinds, calibration] = await countQueries(async () => {
          await request(app.getHttpServer())
            .post(`/v1/sessions/${id}/exercises/${from}/swap`)
            .send({ to_exercise_id: to })
            .expect(200);
        });

        expect(kinds).toEqual({ latest: 1, lifetime, cohort: 0, other: 0 });
        expect(calibration).toBe(1);
        // 교체가 실제로 일어났다 — 나간 종목은 없고 들어온 종목이 있다.
        expect(await prisma.plannedSet.count({ where: { sessionId: id, exerciseId: from } })).toBe(
          0,
        );
        expect(
          await prisma.plannedSet.count({ where: { sessionId: id, exerciseId: to } }),
        ).toBeGreaterThan(0);
      },
    );

    /**
     * **factory 는 DB 를 스스로 읽지 않는다.** 이력은 호출자가 넘긴다.
     * factory 안에 fallback 조회가 하나라도 있으면 batch 경계가 무의미해진다 —
     * 호출 구간을 정확히 잘라 그 안의 질의가 0 인지 본다.
     */
    it("planned set factory 는 build 중에 이력 질의를 0회 한다", async () => {
      const { id, present } = await sessionWithoutAssisted();
      const factory = app.get(PlannedSetFactory);
      let inside = 0;
      let depth = 0;
      const restoreReads = observeReads(
        () => {
          if (depth > 0) inside += 1;
        },
        () => {},
      );
      // build 호출 **구간**을 표시한다 — 그 안에서 나간 질의만 factory 의 것이다.
      // 호출 인자는 여기서 직접 모은다(`mockRestore` 가 `mock.calls` 를 지운다).
      const built: { history?: unknown }[] = [];
      const buildOriginal = factory.build.bind(factory);
      const buildSpy = jest.spyOn(factory, "build").mockImplementation(async (params) => {
        built.push(params);
        depth += 1;
        try {
          return await buildOriginal(params);
        } finally {
          depth -= 1;
        }
      });

      try {
        await request(app.getHttpServer())
          .post(`/v1/sessions/${id}/exercises`)
          .send({ exercise_id: ASSISTED })
          .expect(200);
        await request(app.getHttpServer())
          .post(`/v1/sessions/${id}/exercises/${present[0]}/swap`)
          .send({ to_exercise_id: await plainOutside([...present, ASSISTED]) })
          .expect(200);
      } finally {
        buildSpy.mockRestore();
        restoreReads();
      }

      // 호출은 실제로 있었고(공허하지 않다), 그 안에서 읽은 이력은 0 이다.
      expect(built.length).toBe(2);
      expect(inside).toBe(0);
      // 이력은 **항상 호출자가 넘긴다** — undefined 면 factory 가 스스로 읽어야만 한다.
      for (const params of built) {
        expect(params.history).toBeDefined();
      }
    });
  });

  describe("①-b sync routine — 여러 종목을 한 요청에 넣어도 고정이다", () => {
    it("새 종목 2개 이상을 한 mutation 으로 추가해도 latest 1 · calibration 1", async () => {
      await generate();
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      const [first] = await sessions();
      const existing = await prisma.plannedSet.findMany({
        where: { sessionId: first.id },
        orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
      });
      const keep = [...new Set(existing.map((row) => row.exerciseId))];

      // 세션에 없는 종목 2개를 새로 넣는다 — 이게 factory 를 도는 loop 다.
      const added = (
        await prisma.exercise.findMany({
          where: { id: { notIn: keep } },
          orderBy: { id: "asc" },
          take: 2,
        })
      ).map((row) => row.id);
      expect(added.length).toBe(2);

      const correlations = added.flatMap((exerciseId) =>
        [1, 2, 3].map((setNo) => ({
          correlation_id: randomUUID(),
          exercise_id: exerciseId,
          set_no: setNo,
        })),
      );
      const mutation = {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: first.id,
        op: "upsert",
        updated_at: "2026-08-14T08:00:00.000Z",
        payload: { exercise_ids: [...keep, ...added], correlations },
      };

      // sync 는 **트랜잭션 client** 로 읽으므로 `prisma.performedSet` spy 로는 안 보인다.
      // batch 진입점 자체를 센다 — loop 안으로 들어가면 종목 수만큼 늘어난다.
      const recommendation = app.get(RecommendationService);
      const prefetchSpy = jest.spyOn(recommendation, "prefetchHistories");
      const calibrationSpy = jest.spyOn(recommendation, "calibrationFor");
      try {
        await request(app.getHttpServer())
          .post("/v1/sync")
          .send({ mutations: [mutation] })
          .expect(200)
          .expect(({ body }) => expect(body.applied).toContain(mutation.client_id));

        // routine apply 1회 + 이어지는 recompute 1회. 종목 수(2)를 따라가지 않는다.
        const routineCalls = prefetchSpy.mock.calls.filter((args) => (args[1] ?? []).length === 2);
        expect(routineCalls).toHaveLength(1);
        expect(calibrationSpy.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        prefetchSpy.mockRestore();
        calibrationSpy.mockRestore();
      }

      // 두 종목 모두 실제로 만들어졌다(빈 loop 로 통과하지 않는다).
      const created = await prisma.plannedSet.findMany({
        where: { sessionId: first.id, exerciseId: { in: added } },
        select: { exerciseId: true },
        distinct: ["exerciseId"],
      });
      expect(created).toHaveLength(2);
    });
  });

  describe("①-c fail closed · 스냅샷 · loop read 0", () => {
    it("prefetch 는 요청한 spec 전부를 map 에 넣는다 — 이력이 없어도 키가 있다", async () => {
      const recommendation = app.get(RecommendationService);
      const specs = [
        { exerciseId: ASSISTED, loadSemantics: "assistance" as const },
        { exerciseId: "e_face_pull", loadSemantics: "external_load" as const },
      ];
      const map = await recommendation.prefetchHistories(USER_ID, specs);
      for (const spec of specs) {
        expect(map.has(spec.exerciseId)).toBe(true);
        expect(map.get(spec.exerciseId)?.lastSets).toEqual([]);
      }
    });

    it("prefetch 안 된 종목을 요구하면 invariant error 다 — 조용한 기본값이 아니다", () => {
      expect(() => requireHistory(new Map(), "e_missing")).toThrow(/prefetch 되지 않은/);
    });

    it("sync writer 트랜잭션은 잠금 뒤 최신 읽기를 위해 ReadCommitted 로 고정된다", async () => {
      await generate();
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      const [first] = await sessions();
      const existing = await prisma.plannedSet.findMany({ where: { sessionId: first.id } });
      const keep = [...new Set(existing.map((row) => row.exerciseId))];

      // jest.spyOn 은 $transaction 의 오버로드와 안 맞는다 — 직접 감싼다.
      const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };
      const originalTx = client.$transaction.bind(prisma);
      const options: unknown[] = [];
      client.$transaction = ((...args: unknown[]) => {
        options.push(args[1]);
        return originalTx(...args);
      }) as never;
      try {
        await request(app.getHttpServer())
          .post("/v1/sync")
          .send({
            mutations: [
              {
                client_id: randomUUID(),
                entity: "session_routine",
                entity_id: first.id,
                op: "upsert",
                updated_at: "2026-08-14T08:00:00.000Z",
                payload: { exercise_ids: keep },
              },
            ],
          })
          .expect(200);
        // Approved writer policy: refresh reads after lock waits. Reader RR is a separate path.
        expect(options.filter(Boolean)).toContainEqual(
          expect.objectContaining({ isolationLevel: "ReadCommitted" }),
        );
      } finally {
        client.$transaction = originalTx as never;
      }
    });

    /**
     * **DTO 검증이 먼저 잡는다**(400). 트랜잭션 안의 batch 검사는 그 뒤를 받치는 backstop 이라
     * 이 경로로는 도달하지 않는다 — 여기서는 "요청이 거절되고 행이 안 생긴다"만 단언한다.
     */
    it("한 요청 안에 같은 correlation 이 두 번이면 거절되고 행이 안 생긴다", async () => {
      await generate();
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      const [first] = await sessions();
      const existing = await prisma.plannedSet.findMany({ where: { sessionId: first.id } });
      const keep = [...new Set(existing.map((row) => row.exerciseId))];
      // **서로 다른 두 종목**이 같은 correlation 을 쓴다. 종목별 검사로는 안 잡히고
      // DB 에도 아직 없어서, **요청 전체를 모아 보는 검사**만이 잡는다.
      const added = (
        await prisma.exercise.findMany({
          where: { id: { notIn: keep } },
          orderBy: { id: "asc" },
          take: 2,
        })
      ).map((row) => row.id);
      expect(added.length).toBe(2);
      const duplicated = randomUUID();

      await request(app.getHttpServer())
        .post("/v1/sync")
        .send({
          mutations: [
            {
              client_id: randomUUID(),
              entity: "session_routine",
              entity_id: first.id,
              op: "upsert",
              updated_at: "2026-08-14T08:00:00.000Z",
              payload: {
                exercise_ids: [...keep, ...added],
                correlations: added.map((exerciseId) => ({
                  correlation_id: duplicated,
                  exercise_id: exerciseId,
                  set_no: 1,
                })),
              },
            },
          ],
        })
        .expect(400);

      // 어느 층이 잡든 **행은 생기지 않아야** 한다.
      expect(
        await prisma.plannedSet.count({
          where: { sessionId: first.id, exerciseId: { in: added } },
        }),
      ).toBe(0);
    });
  });

  describe("② 세션 종료 endpoint — lifetime 질의가 1회다", () => {
    it("여러 종목을 수행해도 recompute 의 performed 질의가 고정이다", async () => {
      await generate();
      await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
      const [first] = await sessions();
      const planned = await prisma.plannedSet.findMany({
        where: { sessionId: first.id },
        orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
      });
      const exerciseIds = [...new Set(planned.map((row) => row.exerciseId))];
      expect(exerciseIds.length).toBeGreaterThan(2);

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

      const [, calls] = await countPerformedQueries(async () => {
        await request(app.getHttpServer())
          .post(`/v1/sessions/${first.id}/complete`)
          .send({})
          .expect(200);
      });

      // 종목마다 lifetime 질의를 하면 calls 가 종목 수만큼 늘어난다.
      expect(calls).toBeLessThan(exerciseIds.length);
    });
  });

  describe("③ recommended_action display gate", () => {
    /** 최소 경계 처방(action 이 붙는 유일한 상태)을 게이트 상태별로 심는다. */
    async function seedMinimumReached(completedSessions: number): Promise<string> {
      const program = await prisma.program.create({
        data: {
          userId: USER_ID,
          goal: "hypertrophy",
          daysPerWeek: 3,
          minutesPerDay: 60,
          splitType: "full_body",
          rulesVersion: "2026.08.1",
          startedAt: new Date("2026-08-03T00:00:00Z"),
          totalWeeks: 12,
          status: "active",
          generationInput: {},
          template: [],
          excludedExercises: [],
        },
      });
      let target = "";
      for (let index = 0; index <= completedSessions; index += 1) {
        const done = index < completedSessions;
        const workout = await prisma.workoutSession.create({
          data: {
            programId: program.id,
            scheduledDate: new Date(Date.UTC(2026, 7, 3 + index)),
            focus: "full_body",
            status: done ? "completed" : "scheduled",
            ...(done ? { completedAt: new Date(Date.UTC(2026, 7, 3 + index, 10)) } : {}),
          },
        });
        const planned = await prisma.plannedSet.create({
          data: {
            sessionId: workout.id,
            exerciseId: ASSISTED,
            orderIndex: 0,
            setNo: 1,
            targetRepsLow: 8,
            targetRepsHigh: 12,
            targetRir: 2,
            restSec: 90,
            recommendedReps: 8,
            recommendedWeight: "2.50",
            reasonCode: "ASSISTANCE_MINIMUM_REACHED",
            confidence: "0.85",
            rulesVersion: "2026.08.2",
            loadSemantics: "assistance",
            assistanceStepKg: "2.50",
            assistanceProvenance: "native",
          },
        });
        if (done) {
          await prisma.performedSet.create({
            data: {
              plannedSetId: planned.id,
              actualWeight: "2.50",
              actualReps: 12,
              actualRir: 2,
              completed: true,
              clientId: randomUUID(),
              performedAt: new Date(Date.UTC(2026, 7, 3 + index, 10)),
            },
          });
        } else {
          target = workout.id;
        }
      }
      return target;
    }

    async function wireOf(sessionId: string): Promise<PlannedSetWire> {
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${sessionId}`)
        .expect(200);
      return (response.body.planned_sets as PlannedSetWire[]).find(
        (row) => row.exercise_id === ASSISTED,
      )!;
    }

    it("no_history · early 는 action 이 null 이다 — 처방 축이라 함께 가려진다", async () => {
      for (const completed of [0, 1]) {
        await resetUserData(prisma, USER_ID);
        const target = await seedMinimumReached(completed);
        const wire = await wireOf(target);
        expect(wire.recommendation_gate).not.toBe("ready");
        expect(wire.recommended_action).toBeNull();
        expect(wire.recommendation_state).toBeNull();
        // 구조·안전 축은 게이트되지 않는다.
        expect(wire.load_kind).toBe("assistance");
        expect(wire.assistance_safety_status).not.toBeNull();
      }
    });

    it("ready 면 exact swap action 이 나온다", async () => {
      const target = await seedMinimumReached(3);
      const wire = await wireOf(target);
      expect(wire.recommendation_gate).toBe("ready");
      expect(wire.recommended_action).toEqual({
        kind: "suggest_exercise_swap",
        exercise_id: "e_pullup",
      });
      expect(wire.recommendation_state).toBe("ready");
    });

    /**
     * **sync serializer 는 독립 경로다.** session 쪽만 고치면 오프라인 미러가 게이트 전에
     * action 을 받아 버린다. 같은 행을 sync 매핑으로 직렬화해 게이트를 따로 잠근다.
     */
    it("sync planned_set_mappings 도 같은 게이트를 적용한다", async () => {
      const target = await seedMinimumReached(3);
      const row = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: target, exerciseId: ASSISTED },
      });

      for (const [count, expected] of [
        [0, null],
        [1, null],
        [3, { kind: "suggest_exercise_swap", exercise_id: "e_pullup" }],
      ] as const) {
        const wire = plannedSetResponse(row, count);
        expect(`${count}:${JSON.stringify(wire.recommended_action)}`).toBe(
          `${count}:${JSON.stringify(expected)}`,
        );
        // 구조·안전 축은 게이트와 무관하게 항상 실린다.
        expect(wire.load_kind).toBe("assistance");
        expect(wire.assistance_safety_status).not.toBeNull();
      }
    });
  });
});
