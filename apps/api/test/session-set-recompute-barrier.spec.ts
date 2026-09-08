/** M3 strong witnesses. Only the coordinator runs this against its disposable PostgreSQL. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient, type PlannedSet } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { PlannedSetFactory } from "../src/programs/planned-set.factory";
import { exerciseCountFor, patternsForBodyPart } from "../src/programs/program-rules";
import {
  DIFFICULTY_RANK,
  ProgramsService,
  selectExercises,
} from "../src/programs/programs.service";
import {
  RecommendationService,
  requireHistory,
} from "../src/recommendation/recommendation.service";
import { copySessionSetSnapshot, sourceRevision } from "../src/sessions/session-set-snapshot";
import { SessionsService, type SessionResponse } from "../src/sessions/sessions.service";
import { SyncService } from "../src/sync/sync.service";
import { createTestApp, resetUserData } from "./support/app";

const USER = devUserId();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
type TransactionHost = { $transaction: (...args: unknown[]) => Promise<unknown> };
type Query = { sql?: string; strings?: readonly string[]; values?: readonly unknown[] };
const sqlText = (args: unknown[]) => {
  const query = args[0] as Query;
  return query.sql ?? query.strings?.join("?") ?? String(query);
};
const queryValues = (args: unknown[]): unknown[] => {
  const expand = (value: unknown): unknown[] => {
    const values =
      value && typeof value === "object" && "values" in value ? value.values : undefined;
    return Array.isArray(values) ? values.flatMap(expand) : [value];
  };
  // Prisma supports both tagged-template args and a single Prisma.Sql object.
  // TemplateStringsArray.values is an iterator method, not SQL bind parameters.
  return Array.isArray(args[0]) ? args.slice(1).flatMap(expand) : expand(args[0]);
};

describe("session append raw UPDATE and postcommit recompute / strong two-order DB witnesses", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rival: PrismaClient;
  let observer: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    rival = new PrismaClient();
    observer = new PrismaClient();
    await rival.$connect();
    await observer.$connect();
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, USER));
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, USER);
    } finally {
      await observer?.$disconnect();
      await rival?.$disconnect();
      await app?.close();
    }
  });
  async function fixture() {
    const program = await prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: utcToday(),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [
          { day: "MON", focus: "upper", exercises: [{ exercise_id: "e_bench_press", sets: 1 }] },
        ],
      },
    });
    async function session(offset: number, completed: boolean) {
      const row = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date(utcToday().getTime() + offset * 86_400_000),
          focus: "upper",
          status: completed ? "completed" : "scheduled",
        },
      });
      const set = await prisma.plannedSet.create({
        data: {
          sessionId: row.id,
          exerciseId: "e_bench_press",
          setNo: 1,
          orderIndex: 0,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 120,
          recommendedWeight: 50,
          recommendedReps: 10,
          reasonCode: "BASELINE",
          confidence: 0.6,
          rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        },
      });
      return { ...row, set };
    }
    return { program, session };
  }
  const raw = (sessionId: string) =>
    observer.plannedSet.findMany({ where: { sessionId }, orderBy: { setNo: "asc" } });
  const factRows = (sessionId: string) =>
    observer.performedSet.findMany({
      where: { plannedSet: { sessionId } },
      orderBy: { plannedSetId: "asc" },
    });
  function append(source: PlannedSet) {
    return request(app.getHttpServer())
      .post(`/v1/sessions/${source.sessionId}/sets`)
      .send({
        client_id: randomUUID(),
        exercise_id: source.exerciseId,
        correlation_id: randomUUID(),
        source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
      })
      .then((response) => response);
  }
  function actual(setId: string, weight: number, second: number) {
    const id = randomUUID();
    return request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          {
            client_id: id,
            entity: "performed_set",
            entity_id: setId,
            op: "upsert",
            updated_at: `2026-08-14T08:00:0${second}.000Z`,
            payload: { actual_weight: weight, actual_reps: 12, actual_rir: 2, completed: true },
          },
        ],
      })
      .then((response) => {
        expect(response.status).toBe(200);
        expect(response.body.applied).toEqual([id]);
        expect(response.body.conflicts).toEqual([]);
        return response;
      });
  }
  async function gateReached<T>(ready: Promise<T>, operation: Promise<unknown>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ready,
        operation.then(() => {
          throw new Error("Operation settled before the required authoritative DB gate");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Authoritative DB gate not reached in 1500ms observation budget")),
            1_500,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function waitForLock(blocker: number, query: RegExp, settled: () => boolean) {
    const samples: unknown[] = [];
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const rows = await observer.$queryRaw<
        { pid: number; query: string; wait_event_type: string | null }[]
      >`
        SELECT pid, query, wait_event_type FROM pg_stat_activity
        WHERE ${blocker}::int = ANY(pg_blocking_pids(pid)) AND datname = current_database()`;
      samples.push({ at: new Date().toISOString(), rows });
      const row = rows.find((item) => query.test(item.query) && item.wait_event_type === "Lock");
      if (row) {
        expect(row.pid).not.toBe(blocker);
        expect(row.wait_event_type).toBe("Lock");
        console.info("m3-native-wait", JSON.stringify({ blocker, samples }));
        return row;
      }
      if (settled())
        throw new Error(
          `Writer settled without the required native wait: ${JSON.stringify(samples)}`,
        );
    }
    throw new Error(`Native lock predicate not reached: ${JSON.stringify(samples)}`);
  }
  // Test-only transaction observation: forward real arguments/results/errors; pause only at a real SQL boundary.
  function observeTransactions(
    onQuery: (
      tx: Prisma.TransactionClient,
      args: unknown[],
      run: () => Promise<unknown>,
    ) => Promise<unknown>,
    onFacts?: (
      tx: Prisma.TransactionClient,
      args: Prisma.PerformedSetFindManyArgs,
      result: unknown,
    ) => Promise<void>,
  ) {
    const host = prisma as unknown as TransactionHost;
    const original = host.$transaction.bind(prisma);
    return jest.spyOn(host, "$transaction").mockImplementation((...args) => {
      const callback = args[0];
      if (typeof callback !== "function") return original(...args);
      return original(
        (tx: Prisma.TransactionClient) =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                const value = Reflect.get(target, key);
                if (key === "$queryRaw")
                  return (...queryArgs: unknown[]) =>
                    onQuery(target, queryArgs, () => value.apply(target, queryArgs));
                if (key === "performedSet" && onFacts)
                  return new Proxy(target.performedSet, {
                    get(delegate, method) {
                      const member = Reflect.get(delegate, method);
                      if (method === "findMany")
                        return async (options: Prisma.PerformedSetFindManyArgs) => {
                          const result = await delegate.findMany(options);
                          await onFacts(target, options, result);
                          return result;
                        };
                      return typeof member === "function" ? member.bind(delegate) : member;
                    },
                  });
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        args[1],
      );
    });
  }

  it("raw UPDATE owns source first: append waits, rereads revision, and adds no partial row", async () => {
    const f = await fixture();
    const s = await f.session(0, false);
    const ready = deferred<number>();
    const release = deferred<void>();
    const update = rival.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE planned_sets SET recommended_weight = 75 WHERE id = ${s.set.id}::uuid`;
      const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready.resolve(pid.pid);
      await release.promise;
    });
    let operation: Promise<request.Response> | undefined;
    let settled = false;
    try {
      const blocker = await gateReached(ready.promise, update);
      operation = append(s.set).finally(() => {
        settled = true;
      });
      void operation.catch(() => undefined);
      await waitForLock(blocker, /FROM planned_sets[\s\S]*FOR UPDATE/i, () => settled);
      expect(await raw(s.id)).toEqual([s.set]);
      release.resolve();
      await update;
      const response = await operation;
      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe("source_changed");
      const rows = await raw(s.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].recommendedWeight)).toBe(75);
      expect(await factRows(s.id)).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([update, ...(operation ? [operation] : [])]);
    }
  });

  it("append owns source first: raw UPDATE waits and cannot alter the exact copied snapshot", async () => {
    const f = await fixture();
    const s = await f.session(0, false);
    const ready = deferred<number>();
    const release = deferred<void>();
    let paused = false;
    const seam = observeTransactions(async (tx, args, run) => {
      const result = await run();
      if (!paused && /FROM planned_sets[\s\S]*FOR UPDATE/i.test(sqlText(args))) {
        paused = true;
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready.resolve(pid.pid);
        await release.promise;
      }
      return result;
    });
    const operation = append(s.set);
    void operation.catch(() => undefined);
    let update: Promise<unknown> | undefined;
    let settled = false;
    try {
      const blocker = await gateReached(ready.promise, operation);
      update =
        rival.$executeRaw`UPDATE planned_sets SET recommended_weight = 75 WHERE id = ${s.set.id}::uuid`.finally(
          () => {
            settled = true;
          },
        );
      void update.catch(() => undefined);
      await waitForLock(blocker, /UPDATE planned_sets SET recommended_weight/i, () => settled);
      expect(await raw(s.id)).toEqual([s.set]);
      release.resolve();
      expect((await operation).status).toBe(201);
      await update;
      const rows = await raw(s.id);
      expect(rows).toHaveLength(2);
      expect(copySessionSetSnapshot(rows[1])).toEqual(copySessionSetSnapshot(s.set));
      expect(Number(rows[0].recommendedWeight)).toBe(75);
      expect(Number(rows[1].recommendedWeight)).toBe(50);
    } finally {
      release.resolve();
      await Promise.allSettled([operation, ...(update ? [update] : [])]);
      seam.mockRestore();
    }
  });

  async function projection(targetId: string, sourceIds: string[]) {
    const response = await request(app.getHttpServer()).get(`/v1/sessions/${targetId}`).expect(200);
    const sources: SessionResponse[] = [];
    for (const id of sourceIds) {
      const detail = await request(app.getHttpServer()).get(`/v1/sessions/${id}`).expect(200);
      sources.push(detail.body);
    }
    return {
      // A06 canonical raw excludes transport updatedAt; repeat recompute legitimately rewrites that timestamp.
      raw: (await raw(targetId)).map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        exerciseId: row.exerciseId,
        setNo: row.setNo,
        orderIndex: row.orderIndex,
        clientCorrelationId: row.clientCorrelationId,
        snapshot: copySessionSetSnapshot(row),
        sourceRevision: sourceRevision(row),
      })),
      wire: response.body,
      sources,
      // Authoritative GET fact summary, not a browser UI assertion.
      factSummary: sources.map((session) => ({
        sessionId: session.id,
        completed: session.planned_sets.filter((set) => set.performed_set?.completed === true)
          .length,
        externalKgVolume: session.planned_sets.reduce((sum, set) => {
          const fact = set.performed_set;
          return (
            sum +
            (fact?.completed === true && set.load_kind === "external"
              ? (fact.actual_weight ?? 0) * (fact.actual_reps ?? 0)
              : 0)
          );
        }, 0),
      })),
      e1rm: await observer.estimated1rm.findMany({
        where: { userId: USER },
        orderBy: { sessionId: "asc" },
        select: { sessionId: true, exerciseId: true, e1rm: true, computedAt: true, method: true },
      }),
      volume: await observer.muscleWeeklyLoad.findMany({
        where: { userId: USER },
        orderBy: [{ weekStart: "asc" }, { muscle: "asc" }],
      }),
    };
  }
  it.each(["before-lock-same-session", "locked-same-session", "locked-different-session"] as const)(
    "%s recompute reaches B standalone oracle through actual program lock ordering",
    async (order) => {
      const f = await fixture();
      const a = await f.session(order === "locked-different-session" ? -1 : 0, true);
      const b = order === "locked-different-session" ? await f.session(0, true) : a;
      const target = await f.session(1, false);
      // Both calls select this very same unfinished target under the unchanged date/source rule.
      for (const source of [a, b]) {
        const chosen = await observer.workoutSession.findFirst({
          where: {
            programId: f.program.id,
            id: { not: source.id },
            status: { not: "completed" },
            scheduledDate: { gte: source.scheduledDate },
            plannedSets: { some: { exerciseId: "e_bench_press" } },
          },
          orderBy: { scheduledDate: "asc" },
        });
        expect(chosen?.id).toBe(target.id);
      }
      const service = app.get(SessionsService);
      const scope = new AsyncLocalStorage<boolean>();
      const original = service.recomputeAfterSync.bind(service);
      let first = true;
      const entry = jest
        .spyOn(service, "recomputeAfterSync")
        .mockImplementation((owner, sessionId) => {
          if (first) {
            first = false;
            return scope.run(true, () => original(owner, sessionId));
          }
          return original(owner, sessionId);
        });
      const ready = deferred<number>();
      const release = deferred<void>();
      let paused = false;
      let lockedProgram = false;
      let lockedPlanned = false;
      const plannedLockSessions = new Set<unknown>();
      const seam = observeTransactions(
        async (tx, args, run) => {
          const text = sqlText(args);
          const selected = scope.getStore() === true && !paused;
          if (
            selected &&
            order === "before-lock-same-session" &&
            /FROM programs[\s\S]*FOR UPDATE/i.test(text)
          ) {
            paused = true;
            ready.resolve(0); // This gate intentionally precedes lock acquisition; no blocker PID claim.
            await release.promise;
          }
          const result = await run();
          if (selected && /FROM programs[\s\S]*FOR UPDATE/i.test(text)) lockedProgram = true;
          if (selected && /FROM planned_sets[\s\S]*FOR UPDATE/i.test(text)) {
            lockedPlanned = true;
            for (const value of queryValues(args)) plannedLockSessions.add(value);
          }
          return result;
        },
        async (tx, options, result) => {
          if (
            scope.getStore() === true &&
            !paused &&
            order !== "before-lock-same-session" &&
            lockedProgram &&
            lockedPlanned &&
            plannedLockSessions.has(a.id) &&
            plannedLockSessions.has(target.id) &&
            options.where?.completed === true &&
            options.where.plannedSet &&
            "sessionId" in options.where.plannedSet &&
            options.where.plannedSet.sessionId === a.id
          ) {
            paused = true;
            expect(result).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ actualWeight: new Prisma.Decimal(60) }),
              ]),
            );
            const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            ready.resolve(pid.pid);
            await release.promise;
          }
        },
      );
      const operationA = actual(a.set.id, 60, 1);
      void operationA.catch(() => undefined);
      let operationB: Promise<request.Response> | undefined;
      let bSettled = false;
      try {
        const blocker = await gateReached(ready.promise, operationA);
        expect(Number((await factRows(a.id))[0].actualWeight)).toBe(60); // A fact transaction committed first.
        const targetBefore = await raw(target.id);
        const factsBefore = await factRows(b.id);
        operationB = actual(b.set.id, 80, 2).finally(() => {
          bSettled = true;
        });
        void operationB.catch(() => undefined);
        if (order === "before-lock-same-session") {
          await operationB;
          const bOracle = await projection(target.id, [b.id]);
          release.resolve();
          await operationA;
          expect(await projection(target.id, [b.id])).toEqual(bOracle);
        } else {
          await waitForLock(blocker, /FROM programs[\s\S]*FOR UPDATE/i, () => bSettled);
          expect(await raw(target.id)).toEqual(targetBefore);
          expect(await factRows(b.id)).toEqual(factsBefore);
          release.resolve();
          await operationA;
          await operationB;
          const afterRace = await projection(target.id, [...new Set([a.id, b.id])]);
          // Sequential B-only recompute is the unchanged production-helper oracle, not a race retry.
          await original(USER, b.id);
          expect(await projection(target.id, [...new Set([a.id, b.id])])).toEqual(afterRace);
        }
        const finalFacts = await factRows(b.id);
        expect(finalFacts).toHaveLength(1);
        expect(finalFacts[0]).toMatchObject({ completed: true, actualReps: 12, actualRir: 2 });
        expect(Number(finalFacts[0].actualWeight)).toBe(80);
        expect((await projection(target.id, [b.id])).factSummary).toEqual([
          { sessionId: b.id, completed: 1, externalKgVolume: 960 },
        ]);
        expect(sourceRevision((await raw(target.id))[0])).not.toBe(sourceRevision(target.set));
      } finally {
        release.resolve();
        await Promise.allSettled([operationA, ...(operationB ? [operationB] : [])]);
        seam.mockRestore();
        entry.mockRestore();
        scope.disable();
      }
    },
  );

  it("recompute waiting on B fact commit reads B itself before B postcommit recompute may run", async () => {
    const f = await fixture();
    const source = await f.session(0, true);
    const target = await f.session(1, false);
    await actual(source.set.id, 60, 1);
    const scope = new AsyncLocalStorage<"a" | "b">();
    const syncService = app.get(SyncService);
    const sessions = app.get(SessionsService);
    const originalSync = syncService.sync.bind(syncService);
    const originalRecompute = sessions.recomputeAfterSync.bind(sessions);
    const syncEntry = jest
      .spyOn(syncService, "sync")
      .mockImplementation((owner, dto) => scope.run("b", () => originalSync(owner, dto)));
    const factReady = deferred<number>();
    const releaseFact = deferred<void>();
    const postReady = deferred<void>();
    const releasePost = deferred<void>();
    let postReleased = false;
    const recomputeEntry = jest
      .spyOn(sessions, "recomputeAfterSync")
      .mockImplementation(async (owner, sessionId) => {
        if (scope.getStore() === "b") {
          postReady.resolve();
          await releasePost.promise;
          postReleased = true;
        }
        return originalRecompute(owner, sessionId);
      });
    const host = prisma as unknown as TransactionHost;
    const originalTransaction = host.$transaction.bind(prisma);
    let heldB = false;
    let aProgramLocked = false;
    const aPlannedSessions = new Set<unknown>();
    const reads: {
      weights: number[];
      programLocked: boolean;
      plannedSessions: unknown[];
      bPostReleased: boolean;
    }[] = [];
    const seam = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
      const work = args[0];
      if (typeof work !== "function") return originalTransaction(...args);
      const selected = scope.getStore();
      return originalTransaction(async (tx: Prisma.TransactionClient) => {
        const result = await work(
          new Proxy(tx, {
            get(client, key) {
              const value = Reflect.get(client, key);
              if (key === "$queryRaw")
                return async (...queryArgs: unknown[]) => {
                  const rows = await value.apply(client, queryArgs);
                  if (selected === "a") {
                    if (/FROM programs[\s\S]*FOR UPDATE/i.test(sqlText(queryArgs)))
                      aProgramLocked = true;
                    if (/FROM planned_sets[\s\S]*FOR UPDATE/i.test(sqlText(queryArgs)))
                      for (const id of queryValues(queryArgs)) aPlannedSessions.add(id);
                  }
                  return rows;
                };
              if (key === "performedSet")
                return new Proxy(client.performedSet, {
                  get(delegate, method) {
                    const member = Reflect.get(delegate, method);
                    if (method === "findMany")
                      return async (options: Prisma.PerformedSetFindManyArgs) => {
                        const rows = await delegate.findMany(options);
                        if (
                          selected === "a" &&
                          options.where?.completed === true &&
                          options.where.plannedSet &&
                          "sessionId" in options.where.plannedSet &&
                          options.where.plannedSet.sessionId === source.id
                        ) {
                          reads.push({
                            weights: rows.map((row) => Number(row.actualWeight)),
                            programLocked: aProgramLocked,
                            plannedSessions: [...aPlannedSessions],
                            bPostReleased: postReleased,
                          });
                        }
                        return rows;
                      };
                    return typeof member === "function" ? member.bind(delegate) : member;
                  },
                });
              return typeof value === "function" ? value.bind(client) : value;
            },
          }),
        );
        if (selected === "b" && !heldB) {
          heldB = true;
          const fact = await tx.performedSet.findFirstOrThrow({
            where: { plannedSetId: source.set.id },
          });
          expect(Number(fact.actualWeight)).toBe(80);
          const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          factReady.resolve(pid.pid);
          await releaseFact.promise;
        }
        return result;
      }, args[1]);
    });
    const operationB = actual(source.set.id, 80, 2);
    void operationB.catch(() => undefined);
    let operationA: ReturnType<SessionsService["recomputeAfterSync"]> | undefined;
    let aSettled = false;
    try {
      const blocker = await gateReached(factReady.promise, operationB);
      operationA = scope
        .run("a", () => originalRecompute(USER, source.id))
        .finally(() => {
          aSettled = true;
        });
      void operationA.catch(() => undefined);
      await waitForLock(blocker, /FROM programs[\s\S]*FOR UPDATE/i, () => aSettled);
      expect(Number((await factRows(source.id))[0].actualWeight)).toBe(60);
      releaseFact.resolve();
      await gateReached(postReady.promise, operationB);
      await operationA;
      console.info("m3-recompute-after-fact-wait", JSON.stringify({ reads, postReleased }));
      expect(postReleased).toBe(false);
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.programLocked).toBe(true);
        expect(read.plannedSessions).toEqual(expect.arrayContaining([source.id, target.id]));
        expect(read.bPostReleased).toBe(false);
        expect(read.weights).toEqual([80]);
      }
      const fromA = await projection(target.id, [source.id]);
      releasePost.resolve();
      await operationB;
      expect(await projection(target.id, [source.id])).toEqual(fromA);
      expect(fromA.factSummary).toEqual([
        { sessionId: source.id, completed: 1, externalKgVolume: 960 },
      ]);
    } finally {
      releaseFact.resolve();
      releasePost.resolve();
      await Promise.allSettled([operationB, ...(operationA ? [operationA] : [])]);
      seam.mockRestore();
      recomputeEntry.mockRestore();
      syncEntry.mockRestore();
      scope.disable();
    }
  });

  it.each(["lazy", "ad-hoc"] as const)(
    "%s creation rereads history committed while its program lock is still pending",
    async (kind) => {
      const f = await fixture();
      const historySession = await f.session(-1, true);
      let exercise = await prisma.exercise.findUniqueOrThrow({ where: { id: "e_bench_press" } });
      if (kind === "ad-hoc") {
        // Rest-day program: ensureCurrentWindow does not itself add a session today.
        await prisma.program.update({ where: { id: f.program.id }, data: { template: [] } });
        const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
        const selected = selectExercises(
          await prisma.exercise.findMany(),
          patternsForBodyPart("chest"),
          exerciseCountFor(f.program.minutesPerDay),
          {
            levelRank: DIFFICULTY_RANK[user.experienceLevel],
            preferStable: false,
            substituteMuscles: new Set<string>(),
          },
        );
        const weighted = selected.find(
          (row) =>
            row.metric === "reps" &&
            row.loadSemantics === "external_load" &&
            row.defaultStepKg !== null,
        );
        expect(weighted).toBeDefined();
        exercise = weighted!;
        await prisma.plannedSet.update({
          where: { id: historySession.set.id },
          data: { exerciseId: exercise.id },
        });
      }
      await actual(historySession.set.id, 60, 0);
      const recommendation = app.get(RecommendationService);
      const factory = app.get(PlannedSetFactory);
      const factoryOracle = async () => {
        const history = await recommendation.prefetchHistories(USER, [
          { exerciseId: exercise.id, loadSemantics: exercise.loadSemantics },
        ]);
        return factory.build({
          userId: USER,
          goal: "hypertrophy",
          exercise,
          orderIndex: 0,
          ...(kind === "lazy" ? { sets: 1 } : {}),
          history: requireHistory(history, exercise.id),
          calibration: await recommendation.calibrationFor(USER),
        });
      };
      const oldOracle = await factoryOracle();
      const scope = new AsyncLocalStorage<boolean>();
      const programs = app.get(ProgramsService);
      const sessions = app.get(SessionsService);
      // Keep the real HTTP/lazy prerequisite path, but distinguish the ad-hoc writer's own lock.
      const originalEnsure = programs.ensureCurrentWindow.bind(programs);
      const prerequisite = jest
        .spyOn(programs, "ensureCurrentWindow")
        .mockImplementation((owner) => scope.run(false, () => originalEnsure(owner)));
      const originalCurrent = programs.current.bind(programs);
      const current = jest
        .spyOn(programs, "current")
        .mockImplementation((owner) => scope.run(true, () => originalCurrent(owner)));
      const originalAdHoc = sessions.createAdHoc.bind(sessions);
      const adHoc = jest
        .spyOn(sessions, "createAdHoc")
        .mockImplementation((owner, dto) => scope.run(true, () => originalAdHoc(owner, dto)));
      const ready = deferred<void>();
      const release = deferred<void>();
      let paused = false;
      const seam = observeTransactions(async (_tx, args, run) => {
        if (
          scope.getStore() === true &&
          !paused &&
          /FROM programs[\s\S]*FOR UPDATE/i.test(sqlText(args))
        ) {
          paused = true;
          ready.resolve();
          await release.promise;
        }
        return run();
      });
      const operation = (
        kind === "lazy"
          ? request(app.getHttpServer()).get("/v1/programs/current")
          : request(app.getHttpServer()).post("/v1/sessions/ad-hoc").send({ body_part: "chest" })
      ).then((response) => response);
      void operation.catch(() => undefined);
      try {
        await gateReached(ready.promise, operation);
        expect(
          await observer.workoutSession.count({
            where: { programId: f.program.id, scheduledDate: utcToday() },
          }),
        ).toBe(0);
        await actual(historySession.set.id, 80, 2);
        const expected = await factoryOracle();
        expect(Number(expected[0].recommendedWeight)).not.toBe(
          Number(oldOracle[0].recommendedWeight),
        );
        release.resolve();
        const response = await operation;
        expect(response.status).toBe(kind === "lazy" ? 200 : 201);
        const created = await observer.workoutSession.findMany({
          where: { programId: f.program.id, scheduledDate: utcToday() },
        });
        expect(created).toHaveLength(1);
        const actualRows = (await raw(created[0].id)).filter(
          (row) => row.exerciseId === exercise.id,
        );
        expect(actualRows).toHaveLength(expected.length);
        for (const [index, row] of actualRows.entries()) {
          // Compare every factory prescription field; ids/order are separately scoped to this exercise.
          const oracle = expected[index];
          expect(row).toMatchObject({
            targetRepsLow: oracle.targetRepsLow,
            targetRepsHigh: oracle.targetRepsHigh,
            targetRir: oracle.targetRir,
            restSec: oracle.restSec,
            targetTimeLowSec: oracle.targetTimeLowSec ?? null,
            targetTimeHighSec: oracle.targetTimeHighSec ?? null,
            recommendedReps: oracle.recommendedReps,
            reasonCode: oracle.reasonCode,
            rulesVersion: oracle.rulesVersion,
            loadSemantics: oracle.loadSemantics,
            assistanceProvenance: oracle.assistanceProvenance ?? null,
          });
          expect(row.assistanceStepKg).toBeNull(); // Selected fixture exercise is external load.
          expect(Number(row.recommendedWeight)).toBe(Number(oracle.recommendedWeight));
          // Prisma persists this factory field as numeric(3,2), without altering the engine oracle.
          expect(Number(row.confidence)).toBe(
            new Prisma.Decimal(String(oracle.confidence)).toDecimalPlaces(2).toNumber(),
          );
        }
      } finally {
        release.resolve();
        await Promise.allSettled([operation]);
        seam.mockRestore();
        adHoc.mockRestore();
        current.mockRestore();
        prerequisite.mockRestore();
        scope.disable();
      }
    },
  );
});
