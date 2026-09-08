/** Actual PostgreSQL lock witnesses; a settled Promise.all alone is never a barrier oracle. */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { copySessionSetSnapshot, sourceRevision } from "../src/sessions/session-set-snapshot";
import { createTestApp, resetUserData } from "./support/app";

const USER = devUserId();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("session mutation program lock participation / actual DB wait", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rival: PrismaClient;
  let observer: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    // Both clients inherit the coordinator's same disposable database. Never supply another URL.
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
          { day: "MON", focus: "upper", exercises: [{ exercise_id: "e_bench_press", sets: 3 }] },
        ],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "scheduled",
      },
    });
    await prisma.plannedSet.createMany({
      data: [1, 2, 3].map((setNo) => ({
        sessionId: session.id,
        exerciseId: "e_bench_press",
        setNo,
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
      })),
    });
    const source = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId: session.id },
      orderBy: { setNo: "desc" },
    });
    return { program, session, source };
  }
  async function snapshot(sessionId: string) {
    return {
      session: await observer.workoutSession.findUniqueOrThrow({ where: { id: sessionId } }),
      rows: await observer.plannedSet.findMany({ where: { sessionId }, orderBy: { id: "asc" } }),
      facts: await observer.performedSet.findMany({
        where: { plannedSet: { sessionId } },
        orderBy: { id: "asc" },
      }),
      receipts: await observer.syncMutation.findMany({
        where: { userId: USER },
        orderBy: { id: "asc" },
      }),
      audits: await observer.assistanceAudit.findMany({
        where: { plannedSet: { sessionId } },
        orderBy: { id: "asc" },
      }),
    };
  }
  async function waitForProgramLock(blocker: number, settled: () => boolean) {
    // Deadline bounds observation only. Success requires pg_blocking_pids and the real lock SQL,
    // not elapsed time or the absence of a response. There is no sleep-based race ordering.
    const deadline = Date.now() + 1_500;
    const samples: { at: string; pid: number; query: string; wait_event_type: string | null }[] =
      [];
    while (Date.now() < deadline) {
      const waiting = await observer.$queryRaw<
        { pid: number; query: string; wait_event_type: string | null }[]
      >`
        SELECT pid, query, wait_event_type FROM pg_stat_activity
        WHERE ${blocker}::int = ANY(pg_blocking_pids(pid)) AND datname = current_database()`;
      const program = waiting.find((row) => /FROM programs[\s\S]*FOR UPDATE/i.test(row.query));
      if (program) samples.push({ at: new Date().toISOString(), ...program });
      if (program?.wait_event_type === "Lock") {
        expect(program.wait_event_type).toBe("Lock");
        console.info("program-lock-native-samples", JSON.stringify({ blocker, samples }));
        return program;
      }
      if (settled())
        throw new Error(
          `Writer settled without participating in the held program row lock; samples=${JSON.stringify(samples)}`,
        );
    }
    throw new Error(
      `No actual pg_blocking_pids witness for the program FOR UPDATE within observation budget; samples=${JSON.stringify(samples)}`,
    );
  }

  const paths = [
    "append",
    "add",
    "remove",
    "swap",
    "complete",
    "routine",
    "performed",
    "delete",
    "uncomplete",
    "sync-complete",
  ] as const;
  it.each(paths)(
    "%s waits at the shared program lock before any fact/row/receipt mutation",
    async (kind) => {
      const f = await fixture();
      if (kind === "delete" || kind === "uncomplete")
        await prisma.performedSet.create({
          data: {
            plannedSetId: f.source.id,
            clientId: randomUUID(),
            performedAt: new Date("2026-08-14T08:00:00Z"),
            actualWeight: 50,
            actualReps: 10,
            actualRir: 2,
            completed: true,
          },
        });
      const before = await snapshot(f.session.id);
      const ready = deferred<number>();
      const release = deferred<void>();
      const held = rival.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM programs WHERE id = ${f.program.id}::uuid FOR UPDATE`;
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready.resolve(pid.pid);
        await release.promise;
      });
      void held.catch(ready.reject);
      let settled = false;
      let operation: Promise<request.Response> | undefined;
      try {
        const blocker = await ready.promise;
        const http = request(app.getHttpServer());
        let call: request.Test;
        if (kind === "append")
          call = http.post(`/v1/sessions/${f.session.id}/sets`).send({
            client_id: randomUUID(),
            exercise_id: f.source.exerciseId,
            correlation_id: randomUUID(),
            source: {
              source_planned_set_id: f.source.id,
              source_revision: sourceRevision(f.source),
            },
          });
        else if (kind === "add")
          call = http
            .post(`/v1/sessions/${f.session.id}/exercises`)
            .send({ exercise_id: "e_lat_pulldown", sets: 1 });
        else if (kind === "remove")
          call = http.delete(`/v1/sessions/${f.session.id}/exercises/e_bench_press`);
        else if (kind === "swap")
          call = http
            .post(`/v1/sessions/${f.session.id}/exercises/e_bench_press/swap`)
            .send({ to_exercise_id: "e_chest_press_machine" });
        else if (kind === "complete")
          call = http
            .post(`/v1/sessions/${f.session.id}/complete`)
            .send({ difficulty: "moderate" });
        else
          call = http.post("/v1/sync").send({
            mutations: [
              {
                client_id: randomUUID(),
                entity:
                  kind === "routine"
                    ? "session_routine"
                    : kind === "sync-complete"
                      ? "session"
                      : "performed_set",
                entity_id:
                  kind === "routine" || kind === "sync-complete" ? f.session.id : f.source.id,
                op: kind === "delete" || kind === "uncomplete" ? "delete" : "upsert",
                updated_at: "2026-08-14T08:00:01.000Z",
                payload:
                  kind === "routine"
                    ? { exercise_ids: [] }
                    : kind === "sync-complete"
                      ? { status: "completed" }
                      : kind === "delete" || kind === "uncomplete"
                        ? {}
                        : {
                            actual_weight: 60,
                            actual_reps: 10,
                            actual_rir: 2,
                            completed: true,
                          },
              },
            ],
          });
        operation = call.then(
          (response) => {
            settled = true;
            return response;
          },
          (error: unknown) => {
            settled = true;
            throw error;
          },
        );
        // Avoid an unhandled rejection if the witness fails; retain the original promise for settle.
        void operation.catch(() => undefined);
        const witness = await waitForProgramLock(blocker, () => settled);
        expect(witness.pid).not.toBe(blocker);
        expect(settled).toBe(false);
        expect(await snapshot(f.session.id)).toEqual(before);
        release.resolve();
        await held;
        const result = await operation;
        expect(result.status).toBe(kind === "append" ? 201 : 200);
        if (result.body.applied) {
          expect(result.body.applied).toHaveLength(1);
          expect(result.body.conflicts).toEqual([]);
        }
        if (kind === "uncomplete") {
          expect(before.facts).toHaveLength(1);
          expect(before.facts[0].completed).toBe(true);
          expect((await snapshot(f.session.id)).facts).toEqual([]);
        }
      } finally {
        release.resolve();
        // Always release the owned DB lock and drain requests, even when the assertion is RED.
        await Promise.allSettled([held, ...(operation ? [operation] : [])]);
      }
    },
  );

  const pairs = [
    "append-remove",
    "append-complete",
    "append-upsert",
    "append-delete",
    "remove-upsert",
    "remove-delete",
    "cap8",
    "cap9",
    "cap10",
    "same-uuid",
    "append-swap",
    "swap-upsert",
    "swap-delete",
  ] as const;
  it.each(
    pairs.flatMap((pair) => (["A-first", "B-first"] as const).map((order) => ({ pair, order }))),
  )(
    "I08 $pair $order holds the first real transaction and proves the second native wait",
    async ({ pair, order }) => {
      const f = await fixture();
      const initialCount = pair.startsWith("cap") ? Number(pair.slice(3)) : 3;
      if (initialCount > 3)
        await prisma.plannedSet.createMany({
          data: Array.from({ length: initialCount - 3 }, (_, index) => ({
            sessionId: f.session.id,
            exerciseId: f.source.exerciseId,
            setNo: index + 4,
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
            loadSemantics: "external_load" as const,
          })),
        });
      if (pair.endsWith("delete") || pair === "append-complete")
        await prisma.performedSet.create({
          data: {
            plannedSetId: f.source.id,
            clientId: randomUUID(),
            performedAt: new Date("2026-08-14T08:00:00Z"),
            actualWeight: 50,
            actualReps: 10,
            actualRir: 2,
            completed: true,
          },
        });
      if (pair === "append-complete")
        await prisma.workoutSession.update({
          where: { id: f.session.id },
          data: {
            status: "completed",
            completedAt: new Date("2026-08-14T08:00:00Z"),
            sessionFeedback: { difficulty: "moderate" },
          },
        });
      const unrelated = await prisma.workoutSession.create({
        data: {
          programId: f.program.id,
          scheduledDate: new Date(utcToday().getTime() + 86_400_000),
          focus: "lower",
          status: "scheduled",
        },
      });
      const unrelatedSet = await prisma.plannedSet.create({
        data: {
          sessionId: unrelated.id,
          exerciseId: "e_lat_pulldown",
          setNo: 1,
          orderIndex: 0,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 120,
          recommendedWeight: 30,
          recommendedReps: 10,
          reasonCode: "BASELINE",
          confidence: 0.6,
          rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        },
      });
      const before = await snapshot(f.session.id);
      const appendA = {
        client_id: randomUUID(),
        exercise_id: f.source.exerciseId,
        correlation_id: randomUUID(),
        source: { source_planned_set_id: f.source.id, source_revision: sourceRevision(f.source) },
      };
      const appendB =
        pair === "same-uuid"
          ? appendA
          : { ...appendA, client_id: randomUUID(), correlation_id: randomUUID() };
      const actualId = randomUUID();
      const swap = () =>
        request(app.getHttpServer())
          .post(`/v1/sessions/${f.session.id}/exercises/${f.source.exerciseId}/swap`)
          .send({ to_exercise_id: "e_chest_press_machine" });
      const operationA = () =>
        pair.startsWith("swap")
          ? swap()
          : pair.startsWith("remove")
            ? request(app.getHttpServer()).delete(
                `/v1/sessions/${f.session.id}/exercises/${f.source.exerciseId}`,
              )
            : request(app.getHttpServer()).post(`/v1/sessions/${f.session.id}/sets`).send(appendA);
      const operationB = () => {
        const http = request(app.getHttpServer());
        if (pair === "append-remove")
          return http.delete(`/v1/sessions/${f.session.id}/exercises/${f.source.exerciseId}`);
        if (pair === "append-swap") return swap();
        if (pair === "append-complete")
          return http
            .post(`/v1/sessions/${f.session.id}/complete`)
            .send({ difficulty: "moderate" });
        if (pair.startsWith("cap"))
          return http.post(`/v1/sessions/${f.session.id}/sets`).send(appendB);
        if (pair === "same-uuid")
          return http.post("/v1/sync").send({
            mutations: [
              {
                client_id: appendA.client_id,
                entity: "session_set",
                entity_id: f.session.id,
                op: "upsert",
                updated_at: "2026-08-14T08:00:01Z",
                payload: {
                  exercise_id: appendA.exercise_id,
                  correlation_id: appendA.correlation_id,
                  source: appendA.source,
                },
              },
            ],
          });
        return http.post("/v1/sync").send({
          mutations: [
            {
              client_id: actualId,
              entity: "performed_set",
              entity_id: f.source.id,
              op: pair.endsWith("delete") ? "delete" : "upsert",
              updated_at: "2026-08-14T08:00:01Z",
              payload: pair.endsWith("delete")
                ? {}
                : { actual_weight: 60, actual_reps: 10, actual_rir: 2, completed: true },
            },
          ],
        });
      };
      type Host = { $transaction: (...args: unknown[]) => Promise<unknown> };
      const host = prisma as unknown as Host;
      const original = host.$transaction.bind(prisma);
      const ready = deferred<number>();
      const release = deferred<void>();
      let firstTransaction = true;
      // Pause immediately before real commit/rollback, retaining the first writer's actual locks.
      const seam = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
        const work = args[0];
        if (typeof work !== "function" || !firstTransaction) return original(...args);
        firstTransaction = false;
        return original(async (tx: Prisma.TransactionClient) => {
          let result: unknown;
          let failure: unknown;
          try {
            result = await work(tx);
          } catch (error) {
            failure = error;
          }
          const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          ready.resolve(pid.pid);
          await release.promise;
          if (failure !== undefined) throw failure;
          return result;
        }, args[1]);
      });
      const first = (order === "A-first" ? operationA() : operationB()).then(
        (response) => response,
      );
      void first.catch(() => undefined);
      let second: Promise<request.Response> | undefined;
      let secondSettled = false;
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const blocker = await Promise.race([
          ready.promise,
          first.then(() => {
            throw new Error("First writer returned before transaction barrier");
          }),
          new Promise<never>((_, reject) => {
            observationTimer = setTimeout(
              () => reject(new Error("First DB barrier missing in1500ms")),
              1_500,
            );
          }),
        ]);
        if (observationTimer) clearTimeout(observationTimer);
        second = (order === "A-first" ? operationB() : operationA())
          .then((response) => response)
          .finally(() => {
            secondSettled = true;
          });
        void second.catch(() => undefined);
        const samples: unknown[] = [];
        const deadline = Date.now() + 1_500;
        let witnessed = false;
        while (Date.now() < deadline) {
          const waits = await observer.$queryRaw<
            { pid: number; query: string; wait_event_type: string | null }[]
          >`
            SELECT pid, query, wait_event_type FROM pg_stat_activity
            WHERE ${blocker}::int = ANY(pg_blocking_pids(pid)) AND datname=current_database()`;
          samples.push({ at: new Date().toISOString(), waits });
          const waiter = waits.find(
            (row) =>
              row.wait_event_type === "Lock" &&
              /pg_advisory_xact_lock|FROM programs[\s\S]*FOR UPDATE/i.test(row.query),
          );
          if (waiter) {
            expect(waiter.pid).not.toBe(blocker);
            witnessed = true;
            break;
          }
          if (secondSettled)
            throw new Error(`Second writer settled before native wait: ${JSON.stringify(samples)}`);
        }
        console.info("i08-two-order-native", JSON.stringify({ pair, order, blocker, samples }));
        expect(witnessed).toBe(true);
        expect(await snapshot(f.session.id)).toEqual(before);
        release.resolve();
        const firstResult = await first;
        const secondResult = await second;
        const a = order === "A-first" ? firstResult : secondResult;
        const b = order === "A-first" ? secondResult : firstResult;
        const after = await snapshot(f.session.id);
        for (const added of after.rows.filter(
          (row) =>
            row.clientCorrelationId === appendA.correlation_id ||
            row.clientCorrelationId === appendB.correlation_id,
        ))
          expect(copySessionSetSnapshot(added)).toEqual(copySessionSetSnapshot(f.source));
        if (pair.startsWith("cap")) {
          expect(after.rows).toHaveLength(Math.min(10, initialCount + 2));
          expect(after.rows.map((row) => row.setNo).sort((x, y) => x - y)).toEqual(
            Array.from({ length: Math.min(10, initialCount + 2) }, (_, i) => i + 1),
          );
          const accepted = Math.min(2, 10 - initialCount);
          expect([a, b].filter((row) => row.status === 201)).toHaveLength(accepted);
          for (const rejected of [a, b].filter((row) => row.status !== 201)) {
            expect(rejected.status).toBe(409);
            expect(rejected.body.error.details.reason).toBe("set_cap_reached");
          }
          expect(after.receipts.filter((row) => row.status === "applied")).toHaveLength(accepted);
        } else if (pair === "same-uuid") {
          expect(a.status).toBe(201);
          expect(b.status).toBe(200);
          expect(b.body.applied).toEqual([appendA.client_id]);
          expect(b.body.planned_set_mappings[0].planned_set_id).toBe(a.body.planned_set_id);
          expect(after.rows).toHaveLength(4);
          expect(after.receipts).toHaveLength(1);
          const replay = await operationA();
          expect(replay.body.planned_set_id).toBe(a.body.planned_set_id);
          expect(await snapshot(f.session.id)).toEqual(after);
        } else if (pair === "append-remove") {
          expect(b.status).toBe(200);
          expect(a.status).toBe(order === "A-first" ? 201 : 409);
          if (order === "B-first") expect(a.body.error.details.reason).toBe("source_removed");
          expect(after.rows).toEqual([]);
          expect(after.facts).toEqual([]);
        } else if (pair === "append-swap" || pair.startsWith("swap")) {
          const swapSucceeded =
            pair === "append-swap" ||
            (pair === "swap-upsert" ? order === "A-first" : order === "B-first");
          if (pair === "append-swap") {
            expect(b.status).toBe(200);
            expect(a.status).toBe(order === "A-first" ? 201 : 409);
            if (order === "B-first") expect(a.body.error.details.reason).toBe("source_removed");
          } else {
            expect(a.status).toBe(swapSucceeded ? 200 : 409);
            expect(b.status).toBe(200);
            if (pair === "swap-upsert" && order === "A-first") {
              expect(b.body.applied).toEqual([]);
              expect(b.body.conflicts[0].reason).toBe("not_found");
            } else expect(b.body.applied).toEqual([actualId]);
          }
          expect(after.rows).toHaveLength(pair === "append-swap" && order === "A-first" ? 4 : 3);
          expect(
            after.rows.every(
              (row) =>
                row.exerciseId === (swapSucceeded ? "e_chest_press_machine" : f.source.exerciseId),
            ),
          ).toBe(true);
          expect(after.rows.map((row) => row.setNo).sort((x, y) => x - y)).toEqual(
            Array.from({ length: after.rows.length }, (_, i) => i + 1),
          );
          if (swapSucceeded) {
            expect(after.rows.every((row) => !before.rows.some((old) => old.id === row.id))).toBe(
              true,
            );
            const events = after.receipts.filter(
              (row) =>
                (row.requestIdentity as { origin?: string } | null)?.origin ===
                "server_session_edit",
            );
            expect(events).toHaveLength(1);
            const removed = before.rows.map((row) => ({
              planned_set_id: row.id,
              correlation_id: row.clientCorrelationId,
              exercise_id: row.exerciseId,
            }));
            if (pair === "append-swap" && order === "A-first")
              removed.push({
                planned_set_id: a.body.planned_set_id,
                correlation_id: appendA.correlation_id,
                exercise_id: f.source.exerciseId,
              });
            expect(events[0].tombstoneIdentity).toEqual({
              v: 1,
              removed_sets: expect.arrayContaining(removed),
            });
            expect(
              (events[0].tombstoneIdentity as { removed_sets: unknown[] }).removed_sets,
            ).toHaveLength(removed.length);
          } else {
            expect(after.rows).toEqual(before.rows);
            expect(
              after.receipts.filter(
                (row) =>
                  (row.requestIdentity as { origin?: string } | null)?.origin ===
                  "server_session_edit",
              ),
            ).toEqual([]);
          }
          expect(after.facts).toHaveLength(pair === "swap-upsert" && order === "B-first" ? 1 : 0);
          if (after.facts.length) {
            expect(after.facts[0].plannedSetId).toBe(f.source.id);
            expect(Number(after.facts[0].actualWeight)).toBe(60);
          }
        } else if (pair === "append-complete") {
          expect(a.status).toBe(201);
          expect(b.status).toBe(200);
          expect(after.rows).toHaveLength(4);
          expect(after.session.completedAt).toEqual(before.session.completedAt);
          expect(after.session.sessionFeedback).toEqual(before.session.sessionFeedback);
          expect(after.facts).toEqual(before.facts);
        } else if (pair.startsWith("append")) {
          expect(a.status).toBe(201);
          expect(b.status).toBe(200);
          expect(b.body.applied).toEqual([actualId]);
          expect(after.rows).toHaveLength(4);
          if (pair.endsWith("delete")) expect(after.facts).toEqual([]);
          else {
            expect(after.facts).toHaveLength(1);
            expect(Number(after.facts[0].actualWeight)).toBe(60);
          }
          expect(after.facts.every((row) => row.plannedSetId === f.source.id)).toBe(true);
        } else {
          expect(b.status).toBe(200);
          const removeSucceeded =
            pair === "remove-delete" ? order === "B-first" : order === "A-first";
          expect(a.status).toBe(removeSucceeded ? 200 : 409);
          expect(after.rows).toHaveLength(removeSucceeded ? 0 : 3);
          if (pair === "remove-upsert" && order === "A-first") {
            expect(b.body.applied).toEqual([]);
            expect(b.body.conflicts[0].reason).toBe("not_found");
          } else expect(b.body.applied).toEqual([actualId]);
          expect(after.facts).toHaveLength(pair === "remove-upsert" && order === "B-first" ? 1 : 0);
        }
        expect(await observer.workoutSession.findUnique({ where: { id: unrelated.id } })).toEqual(
          unrelated,
        );
        expect(await observer.plannedSet.findUnique({ where: { id: unrelatedSet.id } })).toEqual(
          unrelatedSet,
        );
        expect(await observer.program.findUnique({ where: { id: f.program.id } })).toEqual(
          f.program,
        );
      } finally {
        if (observationTimer) clearTimeout(observationTimer);
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        seam.mockRestore();
      }
    },
  );
});
