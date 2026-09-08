/** Remaining ticket04 identity/atomicity witnesses. Only main runs the disposable DB gate.
 * Service calls exercise explicit owner + real DB boundaries, not alternate authentication. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import type { AppendSetDto } from "../src/sessions/dto/append-set.dto";
import { SessionSetAppendService } from "../src/sessions/session-set-append.service";
import { copySessionSetSnapshot, sourceRevision } from "../src/sessions/session-set-snapshot";
import { SessionsService } from "../src/sessions/sessions.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { SyncService } from "../src/sync/sync.service";
import { createTestApp, resetUserData } from "./support/app";
import { REPO_ROOT } from "./support/database-url";

const USER = devUserId();
const OTHER = randomUUID();
const EXERCISE = "e_bench_press";
const T0 = "2026-08-14T08:00:00.000Z";
type Host = { $transaction: (...args: unknown[]) => Promise<unknown> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

describe("session set remaining owner/claim/initial receipt/purge boundaries", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let observer: PrismaClient;
  let appendService: SessionSetAppendService;
  let sessions: SessionsService;
  let sync: SyncService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    appendService = app.get(SessionSetAppendService);
    sessions = app.get(SessionsService);
    sync = app.get(SyncService);
    observer = new PrismaClient();
    await observer.$connect();
  }, 60_000);
  beforeEach(async () => {
    await resetUserData(prisma, USER, OTHER);
    await prisma.user.upsert({
      where: { id: OTHER },
      update: { deletedAt: null },
      create: {
        id: OTHER,
        sex: "other",
        birthYear: 1990,
        heightCm: 180,
        weightKg: 80,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
      },
    });
  });
  afterAll(async () => {
    try {
      if (prisma) {
        await resetUserData(prisma, USER, OTHER);
        await prisma.user.deleteMany({ where: { id: OTHER } });
      }
    } finally {
      await observer?.$disconnect();
      await app?.close();
    }
  });
  async function fixture(owner = USER, existingProgram?: string) {
    const programId =
      existingProgram ??
      (
        await prisma.program.create({
          data: {
            userId: owner,
            goal: "hypertrophy",
            daysPerWeek: 4,
            minutesPerDay: 60,
            splitType: "upper_lower",
            rulesVersion: "2026.08.1",
            startedAt: utcToday(),
            generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
            template: [
              { day: "MON", focus: "upper", exercises: [{ exercise_id: EXERCISE, sets: 3 }] },
            ],
          },
        })
      ).id;
    const session = await prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "scheduled",
      },
    });
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
        loadSemantics: "external_load" as const,
      })),
    });
    const source = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId: session.id },
      orderBy: { setNo: "desc" },
    });
    return { owner, programId, session, source };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const intent = (f: Fixture): AppendSetDto => ({
    client_id: randomUUID(),
    exercise_id: EXERCISE,
    correlation_id: randomUUID(),
    source: { source_planned_set_id: f.source.id, source_revision: sourceRevision(f.source) },
  });
  const apply = (f: Fixture, dto: AppendSetDto) => appendService.apply(f.owner, f.session.id, dto);
  const rows = (id: string) =>
    observer.plannedSet.findMany({ where: { sessionId: id }, orderBy: { id: "asc" } });
  const ledger = () =>
    observer.syncMutation.findMany({
      where: { userId: { in: [USER, OTHER] } },
      orderBy: { id: "asc" },
    });
  async function state(ids: string[]) {
    const currentSessions = await observer.workoutSession.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
    });
    return {
      sessions: currentSessions,
      programs: await observer.program.findMany({
        where: { id: { in: [...new Set(currentSessions.map((row) => row.programId))] } },
        orderBy: { id: "asc" },
      }),
      rows: await observer.plannedSet.findMany({
        where: { sessionId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      facts: await observer.performedSet.findMany({
        where: { plannedSet: { sessionId: { in: ids } } },
        orderBy: { id: "asc" },
      }),
      audits: await observer.assistanceAudit.findMany({
        where: { plannedSet: { sessionId: { in: ids } } },
        orderBy: { id: "asc" },
      }),
      ledger: await ledger(),
    };
  }
  /** The first operation's real callback is paused before commit. The second must be a native waiter. */
  async function ordered<A, B>(
    label: string,
    firstCall: () => Promise<A>,
    secondCall: () => Promise<B>,
    ids: string[],
  ): Promise<[A, B]> {
    const host = prisma as unknown as Host;
    const original = host.$transaction.bind(prisma);
    const ready = deferred<number>();
    const release = deferred<void>();
    let firstTx = true;
    let committedFirstLedger: Awaited<ReturnType<typeof ledger>> | undefined;
    const before = await state(ids);
    const seam = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
      const work = args[0];
      if (typeof work !== "function" || !firstTx) return original(...args);
      firstTx = false;
      return original(async (tx: Prisma.TransactionClient) => {
        const result = await work(tx);
        committedFirstLedger = await tx.syncMutation.findMany({
          where: { userId: { in: [USER, OTHER] } },
          orderBy: { id: "asc" },
        });
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready.resolve(pid.pid);
        await release.promise;
        return result;
      }, args[1]);
    });
    const first = firstCall();
    void first.catch(() => undefined);
    let second: Promise<B> | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const blocker = await Promise.race([
        ready.promise,
        first.then(() => {
          throw new Error("First operation settled before DB barrier");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("First DB barrier missing in1500ms")), 1500);
        }),
      ]);
      if (timer) clearTimeout(timer);
      second = secondCall().finally(() => {
        settled = true;
      });
      void second.catch(() => undefined);
      const samples: unknown[] = [];
      const deadline = Date.now() + 1500;
      let witnessed = false;
      while (Date.now() < deadline) {
        const waits = await observer.$queryRaw<
          { pid: number; query: string; wait_event_type: string | null }[]
        >`
          SELECT pid,query,wait_event_type FROM pg_stat_activity
          WHERE ${blocker}::int=ANY(pg_blocking_pids(pid)) AND datname=current_database()`;
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
        if (settled)
          throw new Error(
            `Second operation settled without native wait: ${JSON.stringify(samples)}`,
          );
      }
      console.info("scope-native-wait", JSON.stringify({ label, blocker, samples }));
      expect(witnessed).toBe(true);
      expect(await state(ids)).toEqual(before);
      release.resolve();
      const results: [A, B] = [await first, await second];
      const finalLedger = await ledger();
      expect(committedFirstLedger).toBeDefined();
      for (const receipt of committedFirstLedger!)
        expect(finalLedger.find((row) => row.id === receipt.id)).toEqual(receipt);
      return results;
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      seam.mockRestore();
    }
  }

  it.each(
    (["same-program", "different-program", "different-owner"] as const).flatMap((scope) =>
      (["uuid", "correlation"] as const).flatMap((identity) =>
        (["A-first", "B-first"] as const).map((order) => ({ scope, identity, order })),
      ),
    ),
  )(
    "scope race $scope $identity $order preserves one creator without cross-scope writes",
    async ({ scope, identity, order }) => {
      const a = await fixture();
      const b = await fixture(
        scope === "different-owner" ? OTHER : USER,
        scope === "same-program" ? a.programId : undefined,
      );
      const da = intent(a),
        db = intent(b);
      if (identity === "uuid") db.client_id = da.client_id;
      else db.correlation_id = da.correlation_id;
      const transport = structuredClone([da, db]);
      const baselineA = await rows(a.session.id),
        baselineB = await rows(b.session.id);
      const [first, second] =
        order === "A-first"
          ? await ordered(
              `${scope}/${identity}/${order}`,
              () => apply(a, da),
              () => apply(b, db),
              [a.session.id, b.session.id],
            )
          : await ordered(
              `${scope}/${identity}/${order}`,
              () => apply(b, db),
              () => apply(a, da),
              [a.session.id, b.session.id],
            );
      expect(first.status).toBe("applied");
      expect(second).toEqual({
        status: "conflict",
        reason: identity === "uuid" ? "idempotency_payload_mismatch" : "correlation_mismatch",
      });
      const winner = order === "A-first" ? a : b,
        loser = order === "A-first" ? b : a;
      const winIntent = order === "A-first" ? da : db,
        loseIntent = order === "A-first" ? db : da;
      const winning = await rows(winner.session.id);
      expect(winning).toHaveLength(4);
      const added = winning.find((row) => row.clientCorrelationId === winIntent.correlation_id)!;
      expect(copySessionSetSnapshot(added)).toEqual(copySessionSetSnapshot(winner.source));
      expect(winning.filter((row) => row.id !== added.id)).toEqual(
        order === "A-first" ? baselineA : baselineB,
      );
      expect(await rows(loser.session.id)).toEqual(order === "A-first" ? baselineB : baselineA);
      const saved = await ledger();
      expect(saved.filter((row) => row.status === "applied")).toHaveLength(1);
      expect(saved).toHaveLength(identity === "uuid" ? 1 : 2);
      expect(saved.find((row) => row.id === winIntent.client_id)?.userId).toBe(winner.owner);
      if (identity === "correlation")
        expect(saved.find((row) => row.id === loseIntent.client_id)?.correlationClaims).toBeNull();
      const after = await state([a.session.id, b.session.id]);
      expect(after.facts).toEqual([]);
      expect(after.sessions.find((row) => row.id === a.session.id)).toEqual(a.session);
      expect(after.sessions.find((row) => row.id === b.session.id)).toEqual(b.session);
      expect(await apply(loser, loseIntent)).toEqual(second);
      expect(await apply(winner, winIntent)).toEqual(first);
      expect(await state([a.session.id, b.session.id])).toEqual(after);
      expect([da, db]).toEqual(transport);
    },
  );

  it.each(
    (["replay", "new-claim"] as const).flatMap((kind) =>
      (["add-first", "claim-first"] as const).map((order) => ({ kind, order })),
    ),
  )("deleted claim $kind $order never binds to replacement rows", async ({ kind, order }) => {
    const f = await fixture();
    const old = intent(f);
    expect((await apply(f, old)).status).toBe("applied");
    const originalReceipt = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: old.client_id },
    });
    await sessions.removeExercise(USER, f.session.id, EXERCISE);
    expect(await rows(f.session.id)).toEqual([]);
    expect(await prisma.syncMutation.findUnique({ where: { id: old.client_id } })).toEqual(
      originalReceipt,
    );
    const reused = kind === "replay" ? old : { ...old, client_id: randomUUID() };
    const add = () => sessions.addExercise(USER, f.session.id, { exercise_id: EXERCISE });
    const claim = () => apply(f, reused);
    const result =
      order === "add-first"
        ? (await ordered(`${kind}/${order}`, add, claim, [f.session.id]))[1]
        : (await ordered(`${kind}/${order}`, claim, add, [f.session.id]))[0];
    expect(result).toEqual({
      status: "conflict",
      reason: kind === "replay" ? "append_target_removed" : "correlation_mismatch",
    });
    const replacement = await rows(f.session.id);
    expect(replacement).toHaveLength(3);
    expect(
      replacement.every(
        (row) => row.clientCorrelationId !== old.correlation_id && row.id !== f.source.id,
      ),
    ).toBe(true);
    expect(await prisma.syncMutation.findUnique({ where: { id: old.client_id } })).toEqual(
      originalReceipt,
    );
    const after = await state([f.session.id]);
    expect(after.facts).toEqual([]);
    expect(await claim()).toEqual(result);
    expect(await state([f.session.id])).toEqual(after);
  });

  const actual = (f: Fixture, parent: AppendSetDto): MutationDto => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: parent.correlation_id,
    op: "upsert",
    updated_at: T0,
    payload: { actual_weight: 60, actual_reps: 10, actual_rir: 2, completed: true },
    append_dependencies: { session_id: f.session.id, client_ids: [parent.client_id] },
  });
  it.each(["parent", "performed"] as const)(
    "foreign owner applied %s receipt cannot satisfy local dependency",
    async (kind) => {
      const a = await fixture(),
        b = await fixture(OTHER);
      const da = intent(a),
        db = intent(b);
      expect((await apply(a, da)).status).toBe("applied");
      expect((await apply(b, db)).status).toBe("applied");
      const x = actual(b, db);
      expect((await sync.sync(OTHER, { mutations: [x] })).applied).toEqual([x.client_id]);
      const mutation: MutationDto =
        kind === "parent"
          ? {
              ...actual(b, db),
              append_dependencies: { session_id: a.session.id, client_ids: [db.client_id] },
            }
          : {
              client_id: randomUUID(),
              entity: "session",
              entity_id: a.session.id,
              op: "upsert",
              updated_at: T0,
              payload: { status: "completed" },
              append_dependencies: {
                session_id: a.session.id,
                client_ids: [da.client_id],
                performed_client_ids: [x.client_id],
              },
            };
      const before = await state([a.session.id, b.session.id]);
      const response = await sync.sync(USER, { mutations: [mutation] });
      expect(response.applied).toEqual([]);
      expect(response.conflicts).toEqual([
        {
          client_id: mutation.client_id,
          entity_id: mutation.entity_id,
          reason: "validation_failed",
        },
      ]);
      expect(JSON.stringify(response)).not.toContain(OTHER);
      expect(JSON.stringify(response)).not.toContain(b.session.id);
      expect(JSON.stringify(response)).not.toContain(b.source.id);
      const rejected = await prisma.syncMutation.findUniqueOrThrow({
        where: { id: mutation.client_id },
      });
      expect(rejected).toMatchObject({ userId: USER, status: "conflict", appliedAt: null });
      expect(JSON.stringify(rejected.payload)).not.toMatch(
        /actual_weight|actual_reps|actual_rir|pain_score/,
      );
      const after = await state([a.session.id, b.session.id]);
      expect({
        ...after,
        ledger: after.ledger.filter((row) => row.id !== mutation.client_id),
      }).toEqual(before);
      expect((await sync.sync(USER, { mutations: [mutation] })).conflicts).toEqual(
        response.conflicts,
      );
      expect(await state([a.session.id, b.session.id])).toEqual(after);
    },
  );

  it.each(["before", "after"] as const)(
    "initial append receipt %s insertion fault rolls back planned row and retries once",
    async (fault) => {
      const f = await fixture(),
        dto = intent(f),
        before = await state([f.session.id]);
      const originalIntent = structuredClone(dto);
      const host = prisma as unknown as Host,
        original = host.$transaction.bind(prisma);
      let witnessed = 0,
        receiptWritten = 0;
      const error = new Error("owned initial append receipt rollback witness");
      const seam = jest.spyOn(host, "$transaction").mockImplementation((...args) => {
        const work = args[0];
        if (typeof work !== "function") return original(...args);
        return original(
          (tx: Prisma.TransactionClient) =>
            work(
              new Proxy(tx, {
                get(client, key, receiver) {
                  if (key !== "syncMutation") return Reflect.get(client, key, receiver);
                  return new Proxy(client.syncMutation, {
                    get(delegate, method, delegateReceiver) {
                      if (method !== "create")
                        return Reflect.get(delegate, method, delegateReceiver);
                      return async (options: Prisma.SyncMutationCreateArgs) => {
                        if (options.data.id !== dto.client_id || options.data.status !== "applied")
                          return delegate.create(options);
                        const added = await tx.plannedSet.findUniqueOrThrow({
                          where: { clientCorrelationId: dto.correlation_id },
                        });
                        expect(added.setNo).toBe(4);
                        expect(copySessionSetSnapshot(added)).toEqual(
                          copySessionSetSnapshot(f.source),
                        );
                        expect(
                          await tx.performedSet.count({ where: { plannedSetId: added.id } }),
                        ).toBe(0);
                        witnessed++;
                        if (fault === "after") {
                          await delegate.create(options);
                          expect(
                            (await delegate.findUniqueOrThrow({ where: { id: dto.client_id } }))
                              .status,
                          ).toBe("applied");
                          receiptWritten++;
                        }
                        throw error;
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
        await expect(apply(f, dto)).rejects.toBe(error);
        expect(witnessed).toBe(1);
        expect(receiptWritten).toBe(fault === "after" ? 1 : 0);
      } finally {
        seam.mockRestore();
      }
      expect(await state([f.session.id])).toEqual(before);
      const success = await apply(f, dto);
      expect(success.status).toBe("applied");
      expect(await rows(f.session.id)).toHaveLength(4);
      const committed = await state([f.session.id]);
      expect(committed.ledger).toHaveLength(1);
      expect(await apply(f, dto)).toEqual(success);
      expect(await state([f.session.id])).toEqual(committed);
      expect(dto).toEqual(originalIntent);
    },
  );

  it("existing owner purge removes new receipt metadata only after account cutoff", async () => {
    const active = await fixture(USER),
      gone = await fixture(OTHER),
      health = await fixture(OTHER);
    const da = intent(active),
      dg = intent(gone),
      dh = intent(health);
    for (const [f, dto] of [
      [active, da],
      [gone, dg],
      [health, dh],
    ] as const)
      expect((await apply(f, dto)).status).toBe("applied");
    const x = actual(health, dh);
    expect((await sync.sync(OTHER, { mutations: [x] })).applied).toEqual([x.client_id]);
    const pendingDto = { ...intent(gone), source: { source_correlation_id: randomUUID() } };
    expect(await apply(gone, pendingDto)).toEqual({
      status: "pending",
      reason: "unresolved_parent",
    });
    const conflictDto = { ...dg, client_id: randomUUID() };
    expect(await apply(gone, conflictDto)).toEqual({
      status: "conflict",
      reason: "correlation_mismatch",
    });
    const appliedReceipt = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: dg.client_id },
    });
    await sessions.removeExercise(OTHER, gone.session.id, EXERCISE);
    expect(await prisma.syncMutation.findUnique({ where: { id: dg.client_id } })).toEqual(
      appliedReceipt,
    );
    const doomed = await prisma.syncMutation.findMany({
      where: { userId: OTHER },
      orderBy: { id: "asc" },
    });
    expect(doomed.map((row) => row.status)).toEqual(
      expect.arrayContaining(["applied", "pending", "conflict"]),
    );
    expect(
      doomed.some(
        (row) =>
          (row.requestIdentity as { origin?: string } | null)?.origin === "server_session_edit",
      ),
    ).toBe(true);
    expect(doomed.find((row) => row.id === x.client_id)?.dependencyIdentity).not.toBeNull();
    expect(doomed.find((row) => row.id === dg.client_id)?.correlationClaims).not.toBeNull();
    await prisma.user.update({
      where: { id: OTHER },
      data: { deletedAt: new Date("2026-01-01T00:00:00Z") },
    });
    const cutoff = new Date("2026-02-01T00:00:00Z");
    expect(
      await prisma.user.findMany({ where: { deletedAt: { lte: cutoff } }, select: { id: true } }),
    ).toEqual([{ id: OTHER }]);
    const retained = await state([active.session.id]);
    const retainedUser = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "purge-deleted-users.mjs")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DIRECT_URL: process.env.DATABASE_URL,
          PURGE_BEFORE: cutoff.toISOString(),
        },
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1건을 영구 삭제했습니다.");
    expect(await prisma.user.findUnique({ where: { id: OTHER } })).toBeNull();
    expect(
      await prisma.syncMutation.findMany({ where: { id: { in: doomed.map((row) => row.id) } } }),
    ).toEqual([]);
    expect(await prisma.program.count({ where: { userId: OTHER } })).toBe(0);
    expect(
      await prisma.workoutSession.count({
        where: { id: { in: [gone.session.id, health.session.id] } },
      }),
    ).toBe(0);
    expect(await prisma.performedSet.count({ where: { clientId: x.client_id } })).toBe(0);
    const after = await state([active.session.id]);
    expect(after).toEqual({
      ...retained,
      ledger: retained.ledger.filter((row) => row.userId === USER),
    });
    expect(await prisma.user.findUnique({ where: { id: USER } })).toEqual(retainedUser);
  });
});
