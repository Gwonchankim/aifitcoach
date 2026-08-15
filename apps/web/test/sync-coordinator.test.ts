import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitDraft,
  DEV_USER_SCOPE,
  mirrorSession,
  sessionDb,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import type { SyncRequest } from "../lib/api";

const id = (last: string) => `00000000-0000-4000-8000-0000000000${last}`;
const draft = (clientId = id("01")) => ({
  planned_set_id: id("11"),
  actual_weight: 60,
  actual_reps: 8,
  actual_rir: 2,
  actual_time_sec: null,
  pain_score: null,
  completed: true,
  client_id: clientId,
  updated_at: "2026-08-15T00:00:00.000Z",
});
const response = (applied: string[] = []) => ({
  applied,
  conflicts: [],
  changes: [],
  planned_set_mappings: [],
  next_cursor: "v1.cursor",
});

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("foreground sync coordinator", () => {
  it("excludes a concurrent tab and lets it take an expired lease", async () => {
    let now = 0;
    const network = vi.fn(async (body: SyncRequest) =>
      response(body.mutations.map((row) => row.client_id)),
    );
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const a = new SyncCoordinator({ owner: "a", clock: { now: () => now }, transport: network });
    const b = new SyncCoordinator({ owner: "b", clock: { now: () => now }, transport: network });
    await Promise.all([a.request(), b.request()]);
    expect(network).toHaveBeenCalledTimes(1);
    now = 15_001;
    await b.request();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated triggers into one push", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const network = vi.fn(async (body: SyncRequest) => {
      await waiting;
      return response(body.mutations.map((row) => row.client_id));
    });
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const sync = new SyncCoordinator({ owner: "a", transport: network });
    const one = sync.request();
    const two = sync.request();
    expect(one).toBe(two);
    release();
    await one;
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("reruns after a failing in-flight attempt when a newer trigger must not be lost", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const sync = new SyncCoordinator({
      transport: async (body) => {
        attempts += 1;
        if (attempts === 1) {
          await waiting;
          throw new Error("offline request finally settled");
        }
        return response(body.mutations.map((row) => row.client_id));
      },
    });
    const first = sync.request();
    const latest = sync.request(true);
    expect(latest).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ applied: [id("01")] });
    expect(attempts).toBe(2);
    expect(await sessionDb.outbox.count()).toBe(0);
  });

  it("retries a response-loss request with the original mutation ID", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const sent: string[][] = [];
    const network = vi.fn(async (body: SyncRequest) => {
      sent.push(body.mutations.map((row) => row.client_id));
      throw new Error("response lost");
    });
    const a = new SyncCoordinator({ owner: "a", clock: { now: () => 0 }, transport: network });
    await expect(a.request()).rejects.toThrow("response lost");
    const b = new SyncCoordinator({ owner: "b", clock: { now: () => 20_000 }, transport: network });
    await expect(b.request()).rejects.toThrow("response lost");
    expect(sent).toEqual([[id("01")], [id("01")]]);
    expect(await sessionDb.outbox.count()).toBe(1);
  });

  it("releases a failed transport lease so a reloaded tab can retry immediately", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    await expect(
      new SyncCoordinator({
        owner: "a",
        clock: { now: () => 0 },
        transport: async () => {
          throw new Error("offline");
        },
      }).request(),
    ).rejects.toThrow("offline");
    const retried = vi.fn(async (body: SyncRequest) =>
      response(body.mutations.map((row) => row.client_id)),
    );
    await new SyncCoordinator({
      owner: "b",
      clock: { now: () => 0 },
      transport: retried,
    }).request();
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it("sends only OpenAPI mutation fields, never local user or retry metadata", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const network = vi.fn(async (body: SyncRequest) => {
      expect(Object.keys(body.mutations[0]).sort()).toEqual([
        "client_id",
        "entity",
        "entity_id",
        "op",
        "payload",
        "updated_at",
      ]);
      expect(body.mutations[0]).not.toHaveProperty("user_id");
      expect(body.mutations[0]).not.toHaveProperty("attempts");
      return response([body.mutations[0].client_id]);
    });
    await new SyncCoordinator({ transport: network }).request();
    expect(await sessionDb.outbox.count()).toBe(0);
  });

  it("fences a late response after another tab takes an expired lease", async () => {
    let now = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const first = new SyncCoordinator({
      owner: "a",
      clock: { now: () => now },
      transport: async (body) => {
        await waiting;
        return response(body.mutations.map((row) => row.client_id));
      },
    }).request();
    await vi.waitFor(async () => {
      expect((await sessionDb.leases.get([DEV_USER_SCOPE, "foreground-sync"]))?.owner).toBe("a");
    });
    now = 15_001;
    await new SyncCoordinator({
      owner: "b",
      clock: { now: () => now },
      transport: async () => response(),
    }).request();
    release();
    await expect(first).rejects.toThrow("lease lost");
    expect(await sessionDb.outbox.count()).toBe(1);
  });

  it("acknowledges only after a successful response, preserves conflicts, and advances cursor", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const sync = new SyncCoordinator({
      transport: async () => ({
        applied: [],
        conflicts: [{ client_id: id("01"), entity_id: id("11"), reason: "stale_update" }],
        changes: [],
        planned_set_mappings: [],
        next_cursor: "v1.next",
      }),
    });
    await sync.request();
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(await sessionDb.conflicts.toArray()).toMatchObject([
      { client_id: id("01"), kind: "stale_update" },
    ]);
    await expect(sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"])).resolves.toMatchObject({
      value: "v1.next",
    });
  });

  it("applies safe pulled local mirrors atomically", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(id("02")), null);
    const sync = new SyncCoordinator({
      transport: async () => ({
        ...response(),
        next_cursor: "v1.next",
        changes: [
          {
            entity: "performed_set",
            entity_id: id("11"),
            op: "upsert",
            server_seq: "8",
            data: {
              actual_weight: 70,
              actual_reps: 9,
              actual_rir: 1,
              actual_time_sec: null,
              pain_score: null,
            },
          },
        ],
      }),
    });
    await sync.request();
    const stored = await sessionDb.drafts.where("planned_set_id").equals(id("11")).first();
    expect(stored?.actual_weight).toBe(70);
    expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("v1.next");
  });

  it("does not refresh the UI from an acknowledged change when a newer local write is pending", async () => {
    const sessionId = id("21");
    const original = { ...draft(id("51")), actual_weight: 50, completed: false };
    await commitDraft(DEV_USER_SCOPE, sessionId, original, "delete");
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    try {
      await new SyncCoordinator({
        beforeLocalCommit: async () => {
          await commitDraft(
            DEV_USER_SCOPE,
            sessionId,
            {
              ...original,
              actual_weight: 60,
              completed: true,
              client_id: id("52"),
              updated_at: "2026-08-15T00:00:01.000Z",
            },
            "upsert",
          );
        },
        transport: async () => ({
          ...response([id("51")]),
          changes: [
            {
              entity: "performed_set",
              entity_id: id("11"),
              op: "delete",
              server_seq: "8",
              data: null,
            },
          ],
        }),
      }).request();
    } finally {
      vi.unstubAllGlobals();
    }

    await expect(
      sessionDb.drafts.where("planned_set_id").equals(id("11")).first(),
    ).resolves.toMatchObject({ actual_weight: 60, completed: true });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("pull은 기존 draft가 없어도 session mirror에서 소유 세션을 찾아 만들고 tombstone을 반영한다", async () => {
    await mirrorSession(DEV_USER_SCOPE, id("21"), {
      id: id("21"),
      planned_sets: [{ id: id("11"), exercise_id: "e_bench_press", set_no: 1 }],
    });
    let deleted = false;
    const sync = new SyncCoordinator({
      transport: async () => ({
        ...response(),
        next_cursor: deleted ? "v1.delete" : "v1.upsert",
        changes: [
          {
            entity: "performed_set",
            entity_id: id("11"),
            op: deleted ? "delete" : "upsert",
            server_seq: deleted ? "9" : "8",
            data: deleted
              ? null
              : {
                  actual_weight: 65,
                  actual_reps: 8,
                  actual_rir: 2,
                  actual_time_sec: null,
                  pain_score: null,
                  completed: true,
                },
          },
        ],
      }),
    });

    await sync.request();
    await expect(
      sessionDb.drafts.where("planned_set_id").equals(id("11")).first(),
    ).resolves.toMatchObject({ session_id: id("21"), actual_weight: 65, completed: true });
    deleted = true;
    await sync.request();
    await expect(
      sessionDb.drafts.where("planned_set_id").equals(id("11")).first(),
    ).resolves.toMatchObject({ actual_weight: 65, completed: false });
  });

  it("keeps outbox and cursor retriable when the local response transaction fails", async () => {
    await commitDraft(DEV_USER_SCOPE, id("21"), draft(), "upsert");
    const sync = new SyncCoordinator({
      transport: async (body) => response(body.mutations.map((row) => row.client_id)),
      beforeLocalCommit: () => {
        throw new Error("disk full");
      },
    });
    await expect(sync.request()).rejects.toThrow("disk full");
    expect(await sessionDb.outbox.count()).toBe(1);
    expect(await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"])).toBeUndefined();
  });

  it("D-31 mapping commit은 draft·pending outbox·session mirror의 임시 ID를 함께 치환한다", async () => {
    const correlationId = id("31");
    const serverId = id("32");
    const pendingId = id("33");
    await commitDraft(
      DEV_USER_SCOPE,
      id("21"),
      { ...draft(), planned_set_id: correlationId },
      null,
    );
    await sessionDb.outbox.put({
      client_id: pendingId,
      user_id: DEV_USER_SCOPE,
      entity: "performed_set",
      entity_id: correlationId,
      op: "upsert",
      updated_at: "2026-08-15T00:01:00.000Z",
      payload: { actual_weight: 70, actual_reps: 8, completed: true },
      attempts: 0,
    });
    await mirrorSession(DEV_USER_SCOPE, id("21"), {
      id: id("21"),
      planned_sets: [{ id: correlationId, exercise_id: "e_bench_press", set_no: 1 }],
    });

    await new SyncCoordinator({
      transport: async () =>
        ({
          ...response(),
          planned_set_mappings: [
            {
              correlation_id: correlationId,
              planned_set_id: serverId,
              planned_set: {
                id: serverId,
                exercise_id: "e_bench_press",
                set_no: 1,
                target_reps_low: 8,
                target_reps_high: 12,
                target_rir: 2,
                rest_sec: 120,
                target_time_low_sec: null,
                target_time_high_sec: null,
                recommended_weight: 60,
                recommended_reps: 8,
                reason_code: "BASELINE",
                confidence: 0.3,
                rules_version: "2026.08.1",
              },
            },
          ],
        }) as never,
    }).request();

    expect(await sessionDb.drafts.where("planned_set_id").equals(correlationId).count()).toBe(0);
    await expect(
      sessionDb.drafts.where("planned_set_id").equals(serverId).first(),
    ).resolves.toMatchObject({
      planned_set_id: serverId,
    });
    await expect(sessionDb.outbox.get(pendingId)).resolves.toMatchObject({ entity_id: serverId });
    await expect(sessionDb.sessions.get([DEV_USER_SCOPE, id("21")])).resolves.toMatchObject({
      session: {
        planned_sets: [expect.objectContaining({ id: serverId, recommended_weight: 60 })],
      },
    });
  });

  it("D-31 mapping transaction 중단은 모든 테이블을 온전한 임시 ID 상태로 롤백한다", async () => {
    const correlationId = id("41");
    const serverId = id("42");
    const pendingId = id("43");
    await commitDraft(
      DEV_USER_SCOPE,
      id("21"),
      { ...draft(), planned_set_id: correlationId },
      null,
    );
    await sessionDb.outbox.put({
      client_id: pendingId,
      user_id: DEV_USER_SCOPE,
      entity: "performed_set",
      entity_id: correlationId,
      op: "upsert",
      updated_at: "2026-08-15T00:01:00.000Z",
      payload: { actual_weight: 70, actual_reps: 8, completed: true },
      attempts: 0,
    });
    await mirrorSession(DEV_USER_SCOPE, id("21"), {
      id: id("21"),
      planned_sets: [{ id: correlationId, exercise_id: "e_bench_press", set_no: 1 }],
    });
    const mapping = {
      correlation_id: correlationId,
      planned_set_id: serverId,
      planned_set: {
        id: serverId,
        exercise_id: "e_bench_press",
        set_no: 1,
        target_reps_low: 8,
        target_reps_high: 12,
        target_rir: 2,
        rest_sec: 120,
        target_time_low_sec: null,
        target_time_high_sec: null,
        recommended_weight: 60,
        recommended_reps: 8,
        reason_code: "BASELINE",
        confidence: 0.3,
        rules_version: "2026.08.1",
      },
    } as const;

    await expect(
      new SyncCoordinator({
        transport: async () => ({ ...response(), planned_set_mappings: [mapping] }) as never,
        duringMappingCommit: () => {
          throw new Error("mapping disk failure");
        },
      }).request(),
    ).rejects.toThrow("mapping disk failure");

    await expect(
      sessionDb.drafts.where("planned_set_id").equals(correlationId).first(),
    ).resolves.toMatchObject({ planned_set_id: correlationId });
    expect(await sessionDb.drafts.where("planned_set_id").equals(serverId).count()).toBe(0);
    await expect(sessionDb.outbox.get(pendingId)).resolves.toMatchObject({
      entity_id: correlationId,
    });
    await expect(sessionDb.sessions.get([DEV_USER_SCOPE, id("21")])).resolves.toMatchObject({
      session: { planned_sets: [expect.objectContaining({ id: correlationId })] },
    });
    expect(await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"])).toBeUndefined();
  });
});
