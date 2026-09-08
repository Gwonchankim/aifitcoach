/** Ticket04 M1/M2 DB behavior. Coordinator-owned disposable DB execution only. */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Prisma, type PlannedSet } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { SyncService } from "../src/sync/sync.service";
import { createTestApp, resetUserData } from "./support/app";

const USER = devUserId();
const EXERCISE = "e_bench_press";
const T0 = "2026-08-14T08:00:00.000Z";
const T1 = "2026-08-14T08:00:01.000Z";
const T2 = "2026-08-14T08:00:02.000Z";
type Wire = {
  applied: string[];
  conflicts: {
    client_id: string;
    entity_id: string;
    reason: string;
    retryable?: boolean;
    cause_client_id?: string;
    cause_reason?: string;
  }[];
  planned_set_mappings: {
    correlation_id: string;
    planned_set_id: string;
    planned_set: { id: string; source_revision: string; correlation_id: string | null };
  }[];
  changes: {
    entity: string;
    entity_id: string;
    op: string;
    data: Record<string, unknown> | null;
    server_seq: string;
  }[];
  next_cursor: string;
};

describe("session set dependencies / original intent / canonical ledger / deletion", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, USER));
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, USER);
    } finally {
      await app?.close();
    }
  });

  async function fixture(empty = false) {
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
        template: [{ day: "MON", focus: "upper", exercises: [{ exercise_id: EXERCISE, sets: 3 }] }],
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
    if (!empty)
      await prisma.plannedSet.createMany({
        data: [1, 2, 3].map((setNo) => ({
          sessionId: session.id,
          exerciseId: EXERCISE,
          setNo,
          orderIndex: 0,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 120,
          recommendedWeight: 50,
          recommendedReps: 10,
          confidence: 0.6,
          reasonCode: "BASELINE",
          rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        })),
      });
    return { session, program, rows: await rows(session.id) };
  }
  const rows = (sessionId: string) =>
    prisma.plannedSet.findMany({ where: { sessionId }, orderBy: { setNo: "asc" } });
  const facts = (sessionId: string) =>
    prisma.performedSet.findMany({ where: { plannedSet: { sessionId } }, orderBy: { id: "asc" } });
  const sessionRow = (id: string) => prisma.workoutSession.findUniqueOrThrow({ where: { id } });
  const receipt = (id: string) => prisma.syncMutation.findUniqueOrThrow({ where: { id } });
  async function sync(mutations: MutationDto[], since?: string): Promise<Wire> {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations, ...(since ? { since } : {}) })
      .expect(200);
    return response.body as Wire;
  }
  function append(sessionId: string, source: PlannedSet | string): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "session_set",
      entity_id: sessionId,
      op: "upsert",
      updated_at: T0,
      payload: {
        exercise_id: EXERCISE,
        correlation_id: randomUUID(),
        source:
          typeof source === "string"
            ? { source_correlation_id: source }
            : { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
      },
    };
  }
  const correlation = (mutation: MutationDto) => mutation.payload.correlation_id as string;
  const direct = (mutation: MutationDto) =>
    request(app.getHttpServer())
      .post(`/v1/sessions/${mutation.entity_id}/sets`)
      .send({ client_id: mutation.client_id, ...mutation.payload });
  async function created(sessionId: string, source: PlannedSet) {
    const mutation = append(sessionId, source);
    const response = await direct(mutation).expect(201);
    return { mutation, id: response.body.planned_set_id as string };
  }
  function performed(parent: MutationDto, weight = 60, updatedAt = T1): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "performed_set",
      entity_id: correlation(parent),
      op: "upsert",
      updated_at: updatedAt,
      payload: { actual_weight: weight, actual_reps: 10, actual_rir: 2, completed: true },
      append_dependencies: { session_id: parent.entity_id, client_ids: [parent.client_id] },
    };
  }
  function completion(
    sessionId: string,
    parents: MutationDto[],
    actuals: MutationDto[],
  ): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "session",
      entity_id: sessionId,
      op: "upsert",
      updated_at: T2,
      payload: { status: "completed", difficulty: "moderate", pump: "high" },
      append_dependencies: {
        session_id: sessionId,
        client_ids: parents.map((row) => row.client_id).sort(),
        performed_client_ids: actuals.map((row) => row.client_id).sort(),
      },
    };
  }
  function routine(
    sessionId: string,
    exerciseIds: string[],
    correlations: object[] = [],
  ): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "session_routine",
      entity_id: sessionId,
      op: "upsert",
      updated_at: T0,
      payload: { exercise_ids: exerciseIds, correlations },
    };
  }
  function mapping(result: Wire, mutation: MutationDto) {
    const matches = result.planned_set_mappings.filter(
      (row) => row.correlation_id === correlation(mutation),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].planned_set).toMatchObject({
      id: matches[0].planned_set_id,
      correlation_id: correlation(mutation),
      source_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    return matches[0].planned_set_id;
  }
  async function pending(mutation: MutationDto, result: Wire, retryable = true) {
    expect(result.applied).not.toContain(mutation.client_id);
    expect(result.conflicts.find((row) => row.client_id === mutation.client_id)).toMatchObject({
      entity_id: mutation.entity_id,
      retryable,
      reason: retryable ? "unresolved_parent" : "dependent_conflict",
    });
    const saved = await receipt(mutation.client_id);
    expect(saved.status).toBe("pending");
    expect(saved.appliedAt).toBeNull();
    expect(saved.requestHash).toMatch(/^[a-f0-9]{64}$/);
    // Pending identity metadata must not become a second store of actual health values.
    expect(
      JSON.stringify([saved.payload, saved.requestIdentity, saved.dependencyIdentity]),
    ).not.toMatch(/actual_weight|actual_reps|actual_rir|pain_score/);
    return saved;
  }

  it.each(["POST-sync", "sync-POST"])(
    "%s replay retains one row/receipt and current mapping",
    async (direction) => {
      const f = await fixture();
      const a = append(f.session.id, f.rows[2]);
      if (direction === "POST-sync") await direct(a).expect(201);
      else expect((await sync([a])).applied).toEqual([a.client_id]);
      const before = await rows(f.session.id);
      const result = await sync([{ ...a, updated_at: T2 }]);
      expect(result.applied).toEqual([a.client_id]);
      const id = mapping(result, a);
      expect((await direct(a).expect(201)).body.planned_set_id).toBe(id);
      expect(await rows(f.session.id)).toEqual(before);
      expect(await prisma.syncMutation.count({ where: { id: a.client_id } })).toBe(1);
      expect(await facts(f.session.id)).toEqual([]);
    },
  );

  async function lineage() {
    const f = await fixture(true);
    const parentCorrelations = [1, 2, 3].map((set_no) => ({
      correlation_id: randomUUID(),
      exercise_id: EXERCISE,
      set_no,
    }));
    const p = routine(f.session.id, [EXERCISE], parentCorrelations);
    const a = append(f.session.id, parentCorrelations[2].correlation_id);
    const b = append(f.session.id, correlation(a));
    const x = performed(a);
    const y = performed(b, 62.5);
    const c = completion(f.session.id, [a, b], [x, y]);
    return { ...f, p, a, b, x, y, c };
  }
  it("reverse split batches preserve pending identities then converge without rewriting transport", async () => {
    const f = await lineage();
    const original = structuredClone([f.c, f.y, f.x, f.b, f.a]);
    const initialSession = await sessionRow(f.session.id);
    const first = await sync([f.c, f.y, f.x]);
    for (const mutation of [f.c, f.y, f.x]) await pending(mutation, first);
    expect(await facts(f.session.id)).toEqual([]);
    expect(await sessionRow(f.session.id)).toEqual(initialSession);
    const second = await sync([f.b, f.a]);
    for (const mutation of [f.b, f.a]) await pending(mutation, second);
    const hashes = await Promise.all(
      original.map(async (m) => (await receipt(m.client_id)).requestHash),
    );
    expect(await rows(f.session.id)).toEqual([]);
    expect((await sync([f.p])).applied).toEqual([f.p.client_id]);
    const result = await sync(original, second.next_cursor);
    expect(result.conflicts).toEqual([]);
    expect([...result.applied].sort()).toEqual(original.map((m) => m.client_id).sort());
    const aId = mapping(result, f.a);
    const bId = mapping(result, f.b);
    expect((await rows(f.session.id)).map((row) => row.setNo)).toEqual([1, 2, 3, 4, 5]);
    expect((await facts(f.session.id)).map((row) => row.plannedSetId).sort()).toEqual(
      [aId, bId].sort(),
    );
    expect((await sessionRow(f.session.id)).status).toBe("completed");
    for (const [index, mutation] of original.entries()) {
      const saved = await receipt(mutation.client_id);
      expect(saved.status).toBe("applied");
      expect(saved.requestHash).toBe(hashes[index]);
    }
    expect([f.c, f.y, f.x, f.b, f.a]).toEqual(original);
    const before = {
      rows: await rows(f.session.id),
      facts: await facts(f.session.id),
      session: await sessionRow(f.session.id),
    };
    const replay = await sync(original, result.next_cursor);
    expect([...replay.applied].sort()).toEqual([...result.applied].sort());
    expect(mapping(replay, f.a)).toBe(aId);
    expect(mapping(replay, f.b)).toBe(bId);
    expect({
      rows: await rows(f.session.id),
      facts: await facts(f.session.id),
      session: await sessionRow(f.session.id),
    }).toEqual(before);
  });

  it("one reverse batch reaches topology fixpoint including a new routine parent", async () => {
    const f = await lineage();
    const mutations = [f.c, f.y, f.x, f.b, f.a, f.p];
    const result = await sync(mutations);
    expect(result.conflicts).toEqual([]);
    expect([...result.applied].sort()).toEqual(mutations.map((m) => m.client_id).sort());
    expect(await rows(f.session.id)).toHaveLength(5);
    expect(await facts(f.session.id)).toHaveLength(2);
    expect((await sessionRow(f.session.id)).status).toBe("completed");
  });

  it("cyclic parents reach no-progress pending while an unrelated session applies", async () => {
    const f = await fixture();
    const other = await fixture();
    const a = append(f.session.id, randomUUID());
    const b = append(f.session.id, correlation(a));
    a.payload.source = { source_correlation_id: correlation(b) };
    const independent = append(other.session.id, other.rows[2]);
    const result = await sync([b, independent, a]);
    await pending(a, result);
    await pending(b, result);
    expect(result.applied).toEqual([independent.client_id]);
    mapping(result, independent);
    expect(await rows(f.session.id)).toEqual(f.rows);
    expect(await rows(other.session.id)).toHaveLength(4);
  });

  it.each(["payload", "updated_at", "dependency"])(
    "pending performed %s mismatch cannot replace its original receipt",
    async (field) => {
      const f = await fixture();
      const a = append(f.session.id, f.rows[2]);
      const x = performed(a);
      await pending(x, await sync([x]));
      const before = await receipt(x.client_id);
      const changed = structuredClone(x);
      if (field === "payload") changed.payload.actual_weight = 99;
      if (field === "updated_at") changed.updated_at = T2;
      if (field === "dependency") changed.append_dependencies!.client_ids = [randomUUID()];
      const result = await sync([changed]);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ client_id: x.client_id, reason: "client_id_mismatch" }),
      );
      expect(await receipt(x.client_id)).toEqual(before);
      expect(await facts(f.session.id)).toEqual([]);
    },
  );

  it.each(["missing", "pending"])(
    "completion requires its fixed performed barrier when X is %s",
    async (state) => {
      const f = await fixture();
      const a = append(f.session.id, f.rows[2]);
      const x = performed(a);
      const c = completion(f.session.id, [a], [x]);
      if (state === "pending") await pending(x, await sync([x]));
      await direct(a).expect(201);
      const before = await sessionRow(f.session.id);
      await pending(c, await sync([c]));
      expect(await sessionRow(f.session.id)).toEqual(before);
      expect(await facts(f.session.id)).toEqual([]);
      expect((await sync([x])).applied).toEqual([x.client_id]);
      // X response can be lost: its persisted applied receipt is sufficient for the fixed C barrier.
      expect((await sync([c])).applied).toEqual([c.client_id]);
      const done = await sessionRow(f.session.id);
      expect(done.status).toBe("completed");
      expect(await facts(f.session.id)).toHaveLength(1);
      await sync([x, c]);
      expect(await sessionRow(f.session.id)).toEqual(done);
      expect(await facts(f.session.id)).toHaveLength(1);
    },
  );

  it("a foreign-session applied performed UUID cannot satisfy completion lineage", async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await created(f.session.id, f.rows[2]);
    const b = await created(other.session.id, other.rows[2]);
    const x = performed(b.mutation);
    expect((await sync([x])).applied).toEqual([x.client_id]);
    const c = completion(f.session.id, [a.mutation], [x]);
    const before = await sessionRow(f.session.id);
    const result = await sync([c]);
    expect(result.applied).not.toContain(c.client_id);
    expect(result.conflicts).toHaveLength(1);
    expect(await sessionRow(f.session.id)).toEqual(before);
    expect(await facts(f.session.id)).toEqual([]);
  });

  it.each(
    (["append", "actual", "completion"] as const).flatMap((kind) =>
      (["before-receipt", "after-receipt"] as const).map((fault) => ({ kind, fault })),
    ),
  )(
    "atomic pending $kind $fault rolls back real writes and replays the unchanged intent",
    async ({ kind, fault }) => {
      const f = await fixture();
      const parent = append(f.session.id, f.rows[2]);
      const actual = performed(parent);
      const target =
        kind === "append"
          ? append(f.session.id, correlation(parent))
          : kind === "actual"
            ? actual
            : completion(f.session.id, [parent], [actual]);
      const transport = structuredClone(target);
      const pendingReceipt = await pending(target, await sync([target]));
      const parentId = (await direct(parent).expect(201)).body.planned_set_id as string;
      if (kind === "completion") expect((await sync([actual])).applied).toEqual([actual.client_id]);
      const snapshot = async () => ({
        session: await sessionRow(f.session.id),
        rows: await rows(f.session.id),
        facts: await facts(f.session.id),
        ledger: await prisma.syncMutation.findMany({
          where: { userId: USER },
          orderBy: { id: "asc" },
        }),
      });
      const before = await snapshot();
      type Host = { $transaction: (...args: unknown[]) => Promise<unknown> };
      const host = prisma as unknown as Host;
      const original = host.$transaction.bind(prisma);
      let witnessed = 0;
      let receiptWritten = 0;
      const seam = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
        const work = args[0];
        if (typeof work !== "function") return original(...args);
        return original(
          async (tx: Prisma.TransactionClient) =>
            work(
              new Proxy(tx, {
                get(client, key, receiver) {
                  if (key !== "syncMutation") return Reflect.get(client, key, receiver);
                  return new Proxy(client.syncMutation, {
                    get(delegate, operation, delegateReceiver) {
                      if (operation !== "update")
                        return Reflect.get(delegate, operation, delegateReceiver);
                      return async (options: Prisma.SyncMutationUpdateArgs) => {
                        if (
                          options.where.id !== target.client_id ||
                          options.data.status !== "applied"
                        )
                          return delegate.update(options);
                        // Observe the actual preceding SQL write inside this very transaction.
                        if (kind === "append") {
                          const added = await tx.plannedSet.findUnique({
                            where: { clientCorrelationId: correlation(target) },
                          });
                          expect(added).toMatchObject({
                            sessionId: f.session.id,
                            exerciseId: EXERCISE,
                            setNo: 5,
                          });
                          expect(
                            await tx.performedSet.count({ where: { plannedSetId: added!.id } }),
                          ).toBe(0);
                        } else if (kind === "actual") {
                          const fact = await tx.performedSet.findFirstOrThrow({
                            where: { plannedSetId: parentId },
                          });
                          expect(fact.clientId).toBe(actual.client_id);
                          expect(Number(fact.actualWeight)).toBe(60);
                          expect(fact.completed).toBe(true);
                        } else {
                          const completed = await tx.workoutSession.findUniqueOrThrow({
                            where: { id: f.session.id },
                          });
                          expect(completed.status).toBe("completed");
                          expect(completed.completedAt).not.toBeNull();
                          expect(completed.sessionFeedback).toMatchObject({
                            difficulty: "moderate",
                            pump: "high",
                          });
                        }
                        witnessed += 1;
                        if (fault === "after-receipt") {
                          await delegate.update(options);
                          expect(
                            (await delegate.findUniqueOrThrow({ where: { id: target.client_id } }))
                              .status,
                          ).toBe("applied");
                          receiptWritten += 1;
                        }
                        throw new Error("owned pending receipt atomic rollback witness");
                      };
                    },
                  });
                },
              }),
            ),
          args[1],
        );
      });
      try {
        await request(app.getHttpServer())
          .post("/v1/sync")
          .send({ mutations: [target] })
          .expect(500);
        expect(witnessed).toBe(1);
        expect(receiptWritten).toBe(fault === "after-receipt" ? 1 : 0);
      } finally {
        seam.mockRestore();
      }
      expect(await snapshot()).toEqual(before);
      expect(await receipt(target.client_id)).toEqual(pendingReceipt);
      expect(JSON.stringify(pendingReceipt.payload)).not.toMatch(
        /actual_weight|actual_reps|actual_rir|pain_score/,
      );
      const retried = await sync([target]);
      expect(retried.applied).toEqual([target.client_id]);
      expect(retried.conflicts).toEqual([]);
      const applied = await receipt(target.client_id);
      expect(applied.status).toBe("applied");
      expect(applied.requestHash).toBe(pendingReceipt.requestHash);
      expect(applied.requestIdentity).toEqual(pendingReceipt.requestIdentity);
      expect(applied.dependencyIdentity).toEqual(pendingReceipt.dependencyIdentity);
      expect(target).toEqual(transport);
      expect(await rows(f.session.id)).toHaveLength(kind === "append" ? 5 : 4);
      expect(await facts(f.session.id)).toHaveLength(kind === "append" ? 0 : 1);
      const committed = await snapshot();
      expect((await sync([target])).applied).toEqual([target.client_id]);
      expect(await snapshot()).toEqual(committed);
    },
  );

  it.each(["foreign-session-parent", "different-append-lineage"] as const)(
    "dependency scope %s cannot satisfy an applied receipt barrier",
    async (scope) => {
      const f = await fixture();
      const other = scope === "foreign-session-parent" ? await fixture() : f;
      const a = await created(f.session.id, f.rows[2]);
      const b = await created(other.session.id, other.rows[2]);
      const x = performed(b.mutation);
      expect((await sync([x])).applied).toEqual([x.client_id]);
      const target =
        scope === "foreign-session-parent"
          ? {
              ...performed(b.mutation),
              append_dependencies: { session_id: f.session.id, client_ids: [b.mutation.client_id] },
            }
          : completion(f.session.id, [a.mutation], [x]);
      const transport = structuredClone(target);
      const before = {
        session: await sessionRow(f.session.id),
        otherSession: await sessionRow(other.session.id),
        rows: await rows(f.session.id),
        otherRows: await rows(other.session.id),
        facts: await facts(f.session.id),
        otherFacts: await facts(other.session.id),
        parents: await Promise.all(
          [a.mutation.client_id, b.mutation.client_id, x.client_id].map(receipt),
        ),
      };
      const result = await sync([target]);
      expect(result.applied).toEqual([]);
      expect(result.conflicts).toEqual([
        { client_id: target.client_id, entity_id: target.entity_id, reason: "validation_failed" },
      ]);
      const terminal = await receipt(target.client_id);
      expect(terminal.status).toBe("conflict");
      expect(terminal.appliedAt).toBeNull();
      expect(JSON.stringify(terminal.payload)).not.toMatch(
        /actual_weight|actual_reps|actual_rir|pain_score/,
      );
      expect((await sync([target])).conflicts).toEqual(result.conflicts);
      expect(await receipt(target.client_id)).toEqual(terminal);
      expect({
        session: await sessionRow(f.session.id),
        otherSession: await sessionRow(other.session.id),
        rows: await rows(f.session.id),
        otherRows: await rows(other.session.id),
        facts: await facts(f.session.id),
        otherFacts: await facts(other.session.id),
        parents: await Promise.all(
          [a.mutation.client_id, b.mutation.client_id, x.client_id].map(receipt),
        ),
      }).toEqual(before);
      expect(target).toEqual(transport);
    },
  );

  const lwwCases = (["upsert", "delete", "uncomplete"] as const).flatMap((winnerKind) =>
    (["N", "O"] as const).flatMap((winner) =>
      (["winner-first", "loser-first"] as const).map((order) => ({ winnerKind, winner, order })),
    ),
  );
  it.each(lwwCases)(
    "canonical ledger $winnerKind winner=$winner $order preserves old/new compare",
    async ({ winnerKind, winner, order }) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      const n = performed(a.mutation, 70, winner === "N" ? T2 : T1);
      const o: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: a.id,
        op: "upsert",
        updated_at: winner === "O" ? T2 : T1,
        payload: { actual_weight: 80, actual_reps: 10, actual_rir: 2, completed: true },
      };
      const win = winner === "N" ? n : o;
      const lose = winner === "N" ? o : n;
      if (winnerKind === "uncomplete") {
        // Actual UI undo starts from an already committed completed fact and emits a new
        // delete intent; values/completed:false remain local (verified by the FE owner).
        const initial = performed(a.mutation, 55, T0);
        expect((await sync([initial])).applied).toEqual([initial.client_id]);
        expect((await facts(f.session.id))[0]).toMatchObject({
          completed: true,
          plannedSetId: a.id,
        });
        expect(initial.client_id).not.toBe(win.client_id);
      }
      if (winnerKind === "delete" || winnerKind === "uncomplete") {
        win.op = "delete";
        win.payload = {};
      }
      const original = structuredClone(n);
      const first = order === "winner-first" ? win : lose;
      expect((await sync([first])).applied).toEqual([first.client_id]);
      const second = order === "winner-first" ? lose : win;
      const secondResult = await sync([second]);
      if (order === "winner-first")
        expect(secondResult.conflicts).toContainEqual(
          expect.objectContaining({ client_id: lose.client_id, reason: "stale_update" }),
        );
      else expect(secondResult.applied).toEqual([win.client_id]);
      const expected = await facts(f.session.id);
      if (winnerKind === "delete" || winnerKind === "uncomplete") expect(expected).toEqual([]);
      else {
        expect(expected).toHaveLength(1);
        expect(expected[0]).toMatchObject({
          plannedSetId: a.id,
          completed: true,
        });
        expect(expected[0].actualWeight?.toNumber()).toBe(win.payload.actual_weight);
      }
      const nReceipt = await receipt(n.client_id);
      if (nReceipt.status === "applied") expect(nReceipt.entityId).toBe(a.id);
      expect(nReceipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(n).toEqual(original);
      await sync([n, o]);
      expect(await facts(f.session.id)).toEqual(expected);
    },
  );

  it.each(["N", "O"])(
    "invalid upsert completed:false is rejected without altering the committed fact (%s)",
    async (version) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      const initial = performed(a.mutation, 55, T0);
      expect((await sync([initial])).applied).toEqual([initial.client_id]);
      const before = await facts(f.session.id);
      const invalid = performed(a.mutation, 99, T2);
      invalid.payload.completed = false;
      if (version === "O") {
        invalid.entity_id = a.id;
        delete invalid.append_dependencies;
      }
      const result = await sync([invalid]);
      expect(result.applied).toEqual([]);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ client_id: invalid.client_id, reason: "validation_failed" }),
      );
      expect((await receipt(invalid.client_id)).status).toBe("conflict");
      expect(await facts(f.session.id)).toEqual(before);
    },
  );

  it.each(["N-first", "O-first"])(
    "equal timestamp retains the existing UUID tie-break: %s",
    async (order) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      const n = performed(a.mutation, 70);
      n.client_id = "10000000-0000-4000-8000-000000000001";
      const o: MutationDto = {
        ...performed(a.mutation, 80),
        entity_id: a.id,
        client_id: "f0000000-0000-4000-8000-000000000001",
      };
      delete o.append_dependencies;
      const first = order === "N-first" ? n : o;
      const second = order === "N-first" ? o : n;
      await sync([first]);
      await sync([second]);
      const actual = await facts(f.session.id);
      expect(actual).toHaveLength(1);
      expect(actual[0].actualWeight?.toNumber()).toBe(80);
      expect((await receipt(o.client_id)).status).toBe("applied");
      await sync([n, o]);
      expect(await facts(f.session.id)).toEqual(actual);
    },
  );

  it("pending and applied replay mappings are independent of an unrelated full100 page and advanced cursor", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const a = append(f.session.id, missing);
    const first = await sync([a]);
    await pending(a, first);
    // Pagination fixture only: these pre-existing identity-only receipts do not execute fake API writes.
    await prisma.syncMutation.createMany({
      data: Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        userId: USER,
        entityType: "session_routine" as const,
        entityId: f.session.id,
        op: "upsert" as const,
        clientUpdatedAt: new Date(T0),
        appliedAt: new Date(T0),
        status: "applied" as const,
        payload: { exercise_ids: [EXERCISE] },
      })),
    });
    const parent = append(f.session.id, f.rows[2]);
    parent.payload.correlation_id = missing;
    await direct(parent).expect(201);
    const applied = await sync([a]);
    expect(applied.applied).toEqual([a.client_id]);
    expect(applied.changes).toHaveLength(100);
    const id = mapping(applied, a);
    const max = await prisma.syncMutation.aggregate({
      where: { userId: USER },
      _max: { serverSeq: true },
    });
    const beyond = `v1.${Buffer.from(JSON.stringify({ v: 1, s: String(max._max.serverSeq! + 100n) })).toString("base64url")}`;
    const replay = await sync([a], beyond);
    expect(replay.changes).toEqual([]);
    expect(replay.applied).toEqual([a.client_id]);
    expect(mapping(replay, a)).toBe(id);
    expect(await rows(f.session.id)).toHaveLength(5);
  });

  it.each(["upsert", "delete"] as const)(
    "routine %s emits exact transaction tombstones and prevents old correlation recreation",
    async (op) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      const before = await rows(f.session.id);
      const removal = routine(f.session.id, []);
      removal.op = op;
      if (op === "delete") removal.payload = {};
      const result = await sync([removal]);
      expect(result.applied).toEqual([removal.client_id]);
      const tombstones = before.map((row) => ({
        planned_set_id: row.id,
        correlation_id: row.clientCorrelationId,
        exercise_id: row.exerciseId,
      }));
      const saved = await receipt(removal.client_id);
      expect(saved.tombstoneIdentity).toEqual({
        v: 1,
        removed_sets: expect.arrayContaining(tombstones),
      });
      expect((saved.tombstoneIdentity as Prisma.JsonObject).removed_sets).toHaveLength(
        before.length,
      );
      const change = result.changes.find((row) => row.server_seq === String(saved.serverSeq))!;
      expect(change).toMatchObject({
        entity: "session_routine",
        entity_id: f.session.id,
        op,
        data: { tombstones: expect.arrayContaining(tombstones) },
      });
      expect(change.data!.tombstones).toHaveLength(before.length);
      expect(await rows(f.session.id)).toEqual([]);
      const readd = routine(
        f.session.id,
        [EXERCISE],
        [1, 2, 3].map((set_no) => ({
          set_no,
          exercise_id: EXERCISE,
          correlation_id: set_no === 3 ? correlation(a.mutation) : randomUUID(),
        })),
      );
      readd.updated_at = T2;
      expect((await sync([readd])).applied).toEqual([]);
      expect(await rows(f.session.id)).toEqual([]);
      expect(await facts(f.session.id)).toEqual([]);
      expect((await receipt(a.mutation.client_id)).resultIdentity).not.toBeNull();
    },
  );

  it.each(["remove", "swap"])(
    "direct %s then a remote queued append/actual/completion cannot resurrect or partly apply",
    async (action) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      const x = performed(a.mutation);
      const c = completion(f.session.id, [a.mutation], [x]);
      const remote = structuredClone([c, x, a.mutation]);
      const parentReceipt = await receipt(a.mutation.client_id);
      if (action === "remove")
        await request(app.getHttpServer())
          .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
          .expect(200);
      else
        await request(app.getHttpServer())
          .post(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}/swap`)
          .send({ to_exercise_id: "e_chest_press_machine" })
          .expect(200);
      const before = { rows: await rows(f.session.id), session: await sessionRow(f.session.id) };
      // Separate arrival is essential: a completion may not succeed just because X is absent
      // from this batch. X has an intrinsic missing target; its already-applied parent stays applied.
      const actualResult = await sync([x]);
      expect(actualResult.applied).toEqual([]);
      const intrinsicConflict = {
        client_id: x.client_id,
        entity_id: x.entity_id,
        reason: "append_target_removed",
        retryable: false,
      };
      expect(actualResult.conflicts).toEqual([intrinsicConflict]);
      const xReceipt = await receipt(x.client_id);
      expect(xReceipt.status).toBe("conflict");
      expect(xReceipt.conflictReason).toBe("append_target_removed");
      expect(xReceipt.appliedAt).toBeNull();
      expect(
        JSON.stringify([xReceipt.payload, xReceipt.requestIdentity, xReceipt.dependencyIdentity]),
      ).not.toMatch(/actual_weight|actual_reps|actual_rir|pain_score/);
      const replayActual = await sync([x]);
      expect(replayActual.applied).toEqual([]);
      expect(replayActual.conflicts).toEqual([intrinsicConflict]);
      expect(await receipt(x.client_id)).toEqual(xReceipt);
      const completionResult = await sync([c]);
      await pending(c, completionResult, false);
      expect(completionResult.conflicts.find((row) => row.client_id === c.client_id)).toMatchObject(
        { cause_client_id: x.client_id, cause_reason: "append_target_removed" },
      );
      const result = await sync(remote);
      expect(result.applied).toEqual([]);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({
          client_id: a.mutation.client_id,
          reason: "append_target_removed",
        }),
      );
      expect(result.conflicts.find((row) => row.client_id === x.client_id)).toEqual(
        intrinsicConflict,
      );
      expect(
        result.conflicts.find((row) => row.client_id === a.mutation.client_id),
      ).not.toHaveProperty("retryable");
      await pending(c, result, false);
      expect(result.conflicts.find((row) => row.client_id === c.client_id)).toMatchObject({
        cause_client_id: x.client_id,
        cause_reason: "append_target_removed",
      });
      expect(await receipt(a.mutation.client_id)).toEqual(parentReceipt);
      expect(await receipt(x.client_id)).toEqual(xReceipt);
      expect(result.planned_set_mappings).toEqual([]);
      expect({ rows: await rows(f.session.id), session: await sessionRow(f.session.id) }).toEqual(
        before,
      );
      expect(await facts(f.session.id)).toEqual([]);
      const repeated = await sync(remote);
      expect(repeated.conflicts.find((row) => row.client_id === x.client_id)).toEqual(
        intrinsicConflict,
      );
      expect(repeated.conflicts.find((row) => row.client_id === c.client_id)).toEqual({
        client_id: c.client_id,
        entity_id: c.entity_id,
        reason: "dependent_conflict",
        retryable: false,
        cause_client_id: x.client_id,
        cause_reason: "append_target_removed",
      });
      expect(await receipt(x.client_id)).toEqual(xReceipt);
      expect(await receipt(a.mutation.client_id)).toEqual(parentReceipt);
      // An ordinary actual targeting the same deleted canonical row keeps its old terminal wire.
      // It has no append dependencies, so the narrow adapter must not add retryable:false.
      const ordinary: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: a.id,
        op: x.op,
        updated_at: x.updated_at,
        payload: structuredClone(x.payload),
      };
      const ordinaryResult = await sync([ordinary]);
      expect(ordinaryResult.applied).toEqual([]);
      expect(ordinaryResult.conflicts).toEqual([
        {
          client_id: ordinary.client_id,
          entity_id: ordinary.entity_id,
          reason: "not_found",
        },
      ]);
      expect((await sync([ordinary])).conflicts).toEqual(ordinaryResult.conflicts);
      expect({ rows: await rows(f.session.id), session: await sessionRow(f.session.id) }).toEqual(
        before,
      );
      expect(await facts(f.session.id)).toEqual([]);
      expect(remote).toEqual([c, x, a.mutation]);
    },
  );

  it("an uncreated parent rejected for deleted source blocks X through parent cause, without intrinsic X terminal", async () => {
    const f = await fixture();
    const a = append(f.session.id, f.rows[2]);
    const x = performed(a);
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
      .expect(200);
    const result = await sync([x, a]);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ client_id: a.client_id, reason: "source_removed" }),
    );
    expect((await receipt(a.client_id)).status).toBe("conflict");
    await pending(x, result, false);
    expect(result.conflicts.find((row) => row.client_id === x.client_id)).toMatchObject({
      cause_client_id: a.client_id,
      cause_reason: "source_removed",
    });
    expect(await facts(f.session.id)).toEqual([]);
    expect(await rows(f.session.id)).toEqual([]);
  });

  const serverEvents = () =>
    prisma.syncMutation.findMany({
      where: {
        userId: USER,
        requestIdentity: { path: ["origin"], equals: "server_session_edit" },
      },
      orderBy: { serverSeq: "asc" },
    });
  it.each(["remove", "swap"])(
    "server event %s reaches a previously consumed cursor exactly once and remains owner-scoped",
    async (action) => {
      const f = await fixture();
      const normal = routine(f.session.id, [EXERCISE]);
      const previous = await sync([normal]);
      expect(previous.applied).toEqual([normal.client_id]);
      const before = await rows(f.session.id);
      if (action === "remove")
        await request(app.getHttpServer())
          .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
          .expect(200);
      else
        await request(app.getHttpServer())
          .post(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}/swap`)
          .send({ to_exercise_id: "e_chest_press_machine" })
          .expect(200);
      const events = await serverEvents();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event).toMatchObject({
        userId: USER,
        entityType: "session_routine",
        entityId: f.session.id,
        op: "upsert",
        status: "applied",
        payload: {},
        requestHash: null,
        resultIdentity: null,
        correlationClaims: null,
        dependencyIdentity: null,
        requestIdentity: { v: 1, origin: "server_session_edit", session_id: f.session.id },
      });
      const tombstones = before.map((row) => ({
        planned_set_id: row.id,
        correlation_id: row.clientCorrelationId,
        exercise_id: row.exerciseId,
      }));
      const delivered = await sync([], previous.next_cursor);
      expect(delivered.applied).toEqual([]);
      expect(delivered.conflicts).toEqual([]);
      expect(delivered.changes).toEqual([
        {
          entity: "session_routine",
          entity_id: f.session.id,
          op: "upsert",
          server_seq: String(event.serverSeq),
          data: { tombstones: expect.arrayContaining(tombstones) },
        },
      ]);
      expect(delivered.changes[0].data!.tombstones).toHaveLength(tombstones.length);
      expect(await sync([], previous.next_cursor)).toEqual(delivered);
      expect((await sync([], delivered.next_cursor)).changes).toEqual([]);
      // Service owner-filter evidence, not an alternate authentication claim.
      const otherOwner = await app
        .get(SyncService)
        .sync(randomUUID(), { since: previous.next_cursor, mutations: [] });
      expect(otherOwner.changes).toEqual([]);
      expect(await facts(f.session.id)).toEqual([]);
    },
  );

  it.each(["remove", "swap"])(
    "server event %s failure rolls back both the actual deletion and event",
    async (action) => {
      const f = await fixture();
      const before = {
        rows: await rows(f.session.id),
        session: await sessionRow(f.session.id),
        ledger: await prisma.syncMutation.findMany({ where: { userId: USER } }),
      };
      type TransactionHost = { $transaction: (...args: unknown[]) => Promise<unknown> };
      const host = prisma as unknown as TransactionHost;
      const original = host.$transaction.bind(prisma);
      let attempted = 0;
      const seam = jest.spyOn(host, "$transaction").mockImplementation((...args: unknown[]) => {
        const callback = args[0];
        if (typeof callback !== "function") return original(...args);
        return original(
          (tx: Prisma.TransactionClient) =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== "syncMutation") {
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  }
                  return new Proxy(target.syncMutation, {
                    get(delegate, method) {
                      const value = Reflect.get(delegate, method);
                      if (method !== "create")
                        return typeof value === "function" ? value.bind(delegate) : value;
                      return (options: Prisma.SyncMutationCreateArgs) => {
                        const identity = options.data.requestIdentity;
                        if (
                          identity &&
                          typeof identity === "object" &&
                          !Array.isArray(identity) &&
                          "origin" in identity &&
                          identity.origin === "server_session_edit"
                        ) {
                          attempted += 1;
                          throw new Error("owned server event insertion rollback witness");
                        }
                        return delegate.create(options);
                      };
                    },
                  });
                },
              }),
            ),
          args[1],
        );
      });
      try {
        if (action === "remove")
          await request(app.getHttpServer())
            .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
            .expect(500);
        else
          await request(app.getHttpServer())
            .post(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}/swap`)
            .send({ to_exercise_id: "e_chest_press_machine" })
            .expect(500);
        expect(attempted).toBe(1);
      } finally {
        seam.mockRestore();
      }
      expect({
        rows: await rows(f.session.id),
        session: await sessionRow(f.session.id),
        ledger: await prisma.syncMutation.findMany({ where: { userId: USER } }),
      }).toEqual(before);
      expect(await facts(f.session.id)).toEqual([]);
      expect(await serverEvents()).toEqual([]);
    },
  );

  it.each(["event-before-client", "client-before-event"])(
    "server event stays outside routine LWW candidate set: %s",
    async (order) => {
      const f = await fixture();
      const c1 = routine(f.session.id, [EXERCISE]);
      const initial = await sync([c1]);
      expect(initial.applied).toEqual([c1.client_id]);
      const c2 = routine(f.session.id, [EXERCISE]);
      c2.updated_at = T2;
      if (order === "client-before-event")
        expect((await sync([c2])).applied).toEqual([c2.client_id]);
      await request(app.getHttpServer())
        .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
        .expect(200);
      const events = await serverEvents();
      expect(events).toHaveLength(1);
      if (order === "event-before-client") {
        // A legitimate newer client snapshot has an older wall clock than the server event.
        c2.payload = { exercise_ids: [] };
        expect((await sync([c2])).applied).toEqual([c2.client_id]);
      }
      const old = routine(f.session.id, []);
      old.updated_at = T1;
      const stale = await sync([old]);
      expect(stale.applied).toEqual([]);
      expect(stale.conflicts).toContainEqual(
        expect.objectContaining({ client_id: old.client_id, reason: "stale_update" }),
      );
      expect(await rows(f.session.id)).toEqual([]);
      expect(await serverEvents()).toEqual(events);
    },
  );

  it("server event UUID cannot be replayed as a client receipt or fulfill append completion dependency", async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
      .expect(200);
    const events = await serverEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    const replay = routine(f.session.id, []);
    replay.client_id = event.id;
    const result = await sync([replay]);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ client_id: event.id, reason: "client_id_mismatch" }),
    );
    const c = completion(f.session.id, [{ ...replay, entity: "session_set" }], []);
    const before = await sessionRow(f.session.id);
    const blocked = await sync([c]);
    expect(blocked.applied).toEqual([]);
    expect(blocked.conflicts).toContainEqual(
      expect.objectContaining({ client_id: c.client_id, reason: "validation_failed" }),
    );
    expect(await sessionRow(f.session.id)).toEqual(before);
    expect(await receipt(event.id)).toEqual(event);
  });

  it.each(
    (["upsert", "delete", "uncomplete"] as const).flatMap((kind) =>
      (["event-first", "event-last"] as const).map((order) => ({ kind, order })),
    ),
  )(
    "server event cannot change a retained performed $kind winner: $order",
    async ({ kind, order }) => {
      const f = await fixture();
      const a = await created(f.session.id, f.rows[2]);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${f.session.id}/exercises`)
        .send({ exercise_id: "e_lat_pulldown", sets: 1 })
        .expect(200);
      const seed = performed(a.mutation, 55, T0);
      expect((await sync([seed])).applied).toEqual([seed.client_id]);
      expect((await facts(f.session.id))[0].completed).toBe(true);
      const winner = performed(a.mutation, 80, T2);
      if (kind !== "upsert") {
        winner.op = "delete";
        winner.payload = {};
      }
      const removeOtherExercise = () =>
        request(app.getHttpServer())
          .delete(`/v1/sessions/${f.session.id}/exercises/e_lat_pulldown`)
          .expect(200);
      if (order === "event-first") await removeOtherExercise();
      expect((await sync([winner])).applied).toEqual([winner.client_id]);
      if (order === "event-last") await removeOtherExercise();
      const event = (await serverEvents())[0];
      expect(await serverEvents()).toHaveLength(1);
      const originalFact = await facts(f.session.id);
      if (kind === "upsert") expect(originalFact[0].actualWeight?.toNumber()).toBe(80);
      else expect(originalFact).toEqual([]);
      const older = performed(a.mutation, 65, T1);
      older.entity_id = a.id;
      delete older.append_dependencies;
      const result = await sync([older, winner]);
      expect(result.applied).toEqual([winner.client_id]);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({ client_id: older.client_id, reason: "stale_update" }),
      );
      expect(await facts(f.session.id)).toEqual(originalFact);
      expect((await receipt(winner.client_id)).entityId).toBe(a.id);
      expect((await receipt(a.mutation.client_id)).status).toBe("applied");
      expect(await receipt(event.id)).toEqual(event);
      expect((await rows(f.session.id)).every((row) => row.exerciseId === EXERCISE)).toBe(true);
    },
  );

  it("server event after a full100 client page is delivered once on the next cursor page", async () => {
    const f = await fixture();
    const consumed = await sync([routine(f.session.id, [EXERCISE])]);
    // Existing receipt pagination fixture only; the deletion/event itself uses the real HTTP writer.
    await prisma.syncMutation.createMany({
      data: Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        userId: USER,
        entityType: "session_routine" as const,
        entityId: f.session.id,
        op: "upsert" as const,
        status: "applied" as const,
        clientUpdatedAt: new Date(T0),
        appliedAt: new Date(T0),
        payload: { exercise_ids: [EXERCISE] },
      })),
    });
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${f.session.id}/exercises/${EXERCISE}`)
      .expect(200);
    const events = await serverEvents();
    expect(events).toHaveLength(1);
    const first = await sync([], consumed.next_cursor);
    expect(first.changes).toHaveLength(100);
    expect(first.changes.every((change) => change.server_seq !== String(events[0].serverSeq))).toBe(
      true,
    );
    const second = await sync([], first.next_cursor);
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]).toMatchObject({
      entity: "session_routine",
      entity_id: f.session.id,
      server_seq: String(events[0].serverSeq),
      data: { tombstones: expect.any(Array) },
    });
    expect(Object.keys(second.changes[0].data!)).toEqual(["tombstones"]);
    expect(await sync([], first.next_cursor)).toEqual(second);
    expect((await sync([], second.next_cursor)).changes).toEqual([]);
    expect(first.applied).toEqual([]);
    expect(second.applied).toEqual([]);
  });
});
