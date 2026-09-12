import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitAuthoritativeSession,
  commitDraft,
  DEV_USER_SCOPE,
  isRemediationPending,
  mirrorSession,
  sessionDb,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import type { PlannedSet, SyncRequest } from "../lib/api";

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
      planned_sets: [
        { id: id("11"), exercise_id: "e_bench_press", set_no: 1, load_kind: "external" },
      ],
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
    await mirrorSession(
      DEV_USER_SCOPE,
      id("21"),
      {
        id: id("21"),
        planned_sets: [
          {
            id: correlationId,
            exercise_id: "e_bench_press",
            set_no: 1,
            recommended_weight: 0,
          },
        ],
      },
      new Set([correlationId]),
    );

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
                load_kind: "external",
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

  it.each([false, true])(
    "mapping ACK preserves T0; only an acknowledged performed pull records local T1 (pull=%s)",
    async (pull) => {
      const correlationId = id("31");
      const serverId = id("32");
      const sessionId = id("21");
      const t0 = "2026-08-14T10:00:02.580Z";
      const t1 = "2026-08-14T10:00:02.742Z";
      const original = { ...draft(), planned_set_id: correlationId, updated_at: t0 };
      await commitDraft(DEV_USER_SCOPE, sessionId, original, "upsert");
      const before = (await sessionDb.drafts.get([DEV_USER_SCOPE, sessionId, correlationId]))!;
      const outgoing = (await sessionDb.outbox.get(original.client_id))!;
      const wire = {
        client_id: outgoing.client_id,
        entity: outgoing.entity,
        entity_id: outgoing.entity_id,
        op: outgoing.op,
        updated_at: outgoing.updated_at,
        payload: outgoing.payload,
      };
      const canonical: PlannedSet = {
        id: serverId,
        source_revision: "fixture-sync-ack-canonical",
        correlation_id: null,
        append_eligibility: null,
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
        load_kind: "external",
        recommendation_state: "ready" as const,
        assistance_provenance: null,
        recommended_action: null,
        assistance_safety_status: null,
        recommendation_gate: "ready",
        performed_set: null,
      };
      const network = vi.fn(async (body: SyncRequest) => {
        if (body.mutations.length === 0) return response();
        expect(body.mutations).toEqual([wire]);
        return {
          ...response([original.client_id]),
          planned_set_mappings: [
            {
              correlation_id: correlationId,
              planned_set_id: serverId,
              planned_set: canonical,
            },
          ],
          changes: pull
            ? [
                {
                  entity: "performed_set" as const,
                  entity_id: serverId,
                  op: "upsert" as const,
                  data: { ...outgoing.payload },
                  server_seq: "130",
                },
              ]
            : [],
        };
      });
      const sync = new SyncCoordinator({
        clock: { now: () => Date.parse(t1) },
        transport: network,
      });
      await sync.request();
      const expected = { ...before, planned_set_id: serverId, updated_at: pull ? t1 : t0 };
      expect(await sessionDb.drafts.toArray()).toEqual([expected]);
      expect(await sessionDb.outbox.count()).toBe(0);
      expect(await sessionDb.conflicts.count()).toBe(0);
      // Local pull materialization must never rewrite or replay the original LWW envelope.
      expect(network.mock.calls[0][0].mutations).toEqual([wire]);
      await sync.request();
      expect(network.mock.calls).toHaveLength(2);
      expect(network.mock.calls[1][0].mutations).toEqual([]);
      expect(await sessionDb.drafts.toArray()).toEqual([expected]);
      expect(await sessionDb.outbox.count()).toBe(0);
    },
  );

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
    await mirrorSession(
      DEV_USER_SCOPE,
      id("21"),
      {
        id: id("21"),
        planned_sets: [
          {
            id: correlationId,
            exercise_id: "e_bench_press",
            set_no: 1,
            recommended_weight: 0,
          },
        ],
      },
      new Set([correlationId]),
    );
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

/**
 * F-4b fixup — **매핑도 미러 쓰기다.** 서버가 안전하다고 말하지 않은 처방을 매핑으로 심으면
 * v4 가 지운 세션이 sync 경로로 되살아난다. 여기서는 진짜 `SyncCoordinator` 를 돌린다.
 */
describe("planned_set mapping 의 fail-closed 경계", () => {
  const correlationId = id("51");
  const serverId = id("52");
  const sessionId = id("53");

  /** 매핑 전 로컬 상태: 임시 correlation id 를 가진 provisional 행. */
  async function seedPreMapping() {
    await commitDraft(
      DEV_USER_SCOPE,
      sessionId,
      { ...draft(id("54")), planned_set_id: correlationId },
      "upsert",
    );
    await mirrorSession(
      DEV_USER_SCOPE,
      sessionId,
      {
        id: sessionId,
        planned_sets: [
          {
            id: correlationId,
            exercise_id: "e_assisted_pullup",
            set_no: 1,
            recommended_weight: 0,
          },
        ],
      },
      new Set([correlationId]),
    );
  }

  function mappingResponse(planned: Record<string, unknown>) {
    return {
      ...response(),
      planned_set_mappings: [
        { correlation_id: correlationId, planned_set_id: serverId, planned_set: planned },
      ],
    };
  }

  const unsafeAssisted = {
    id: serverId,
    exercise_id: "e_assisted_pullup",
    set_no: 1,
    recommended_weight: 20,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    rules_version: "2026.08.1",
    load_kind: "assistance",
    assistance_safety_status: "unsafe",
  };

  it("unsafe 매핑은 미러에 쓰지 않고 marker 를 세운다 — 그래도 draft·outbox 는 remap 한다", async () => {
    await seedPreMapping();

    await new SyncCoordinator({
      transport: async () => mappingResponse(unsafeAssisted) as never,
    }).request();

    // 사용자의 기록은 서버 ID 로 옮겨간다 — 이걸 잃으면 진짜 데이터 손실이다.
    await expect(
      sessionDb.drafts.where("planned_set_id").equals(serverId).first(),
    ).resolves.toMatchObject({ planned_set_id: serverId });
    // 처방은 심지 않지만 **identity 는 옮긴다** — 네 소비자가 같은 ID 를 봐야 기록이 화면에 남는다.
    const mirror = await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId]);
    const row = (mirror?.session as { planned_sets: Record<string, unknown>[] }).planned_sets[0];
    expect(row.id).toBe(serverId);
    expect(row.recommended_weight).toBe(0);
    expect(row.assistance_safety_status).toBeUndefined();
    expect(
      (await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]))
        ?.value,
    ).toBe("pending_refetch");
  });

  it("load_kind 가 없는 구형 매핑도 같은 이유로 막는다", async () => {
    await seedPreMapping();
    const legacy = { ...unsafeAssisted } as Record<string, unknown>;
    delete legacy.load_kind;
    delete legacy.assistance_safety_status;

    await new SyncCoordinator({
      transport: async () => mappingResponse(legacy) as never,
    }).request();

    const mirror = await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId]);
    const row = (mirror?.session as { planned_sets: Record<string, unknown>[] }).planned_sets[0];
    expect(row.id).toBe(serverId);
    expect(row.recommended_weight).toBe(0);
  });

  it("safe 매핑은 그대로 미러에 반영된다 — 비공허성", async () => {
    await seedPreMapping();
    const safe = { ...unsafeAssisted, assistance_safety_status: "safe" };

    await new SyncCoordinator({ transport: async () => mappingResponse(safe) as never }).request();

    const mirror = await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId]);
    expect((mirror?.session as { planned_sets: { id: string }[] }).planned_sets[0].id).toBe(
      serverId,
    );
    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]),
    ).toBeUndefined();
  });
});

/**
 * governing §F: `session complete/abandon → server 성공 + outbox drain 뒤 marker·cache cleanup`.
 * **marker 만 지우면 미러의 unsafe 처방이 다시 노출된다** — 둘을 함께 지운다.
 */
describe("완료 세션의 remediation cleanup", () => {
  const sessionId = id("61");
  const completionClientId = id("62");
  const plannedSetId = id("66");

  async function seedPendingCompletedSession() {
    await sessionDb.sessions.put({
      user_id: DEV_USER_SCOPE,
      session_id: sessionId,
      session: {
        id: sessionId,
        planned_sets: [
          { id: plannedSetId, exercise_id: "e_bench_press", set_no: 1, load_kind: "external" },
        ],
      },
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.routines.put({
      user_id: DEV_USER_SCOPE,
      session_id: sessionId,
      exercise_ids: ["e_bench_press"],
      correlations: [],
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.readModels.put({
      user_id: DEV_USER_SCOPE,
      cache_key: `history-session:${sessionId}`,
      kind: "history-session",
      data: {},
      request_started_at: 0,
      synced_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.syncMeta.put({
      user_id: DEV_USER_SCOPE,
      key: `assistance-remediation:${sessionId}`,
      value: "pending_refetch",
    });
    await sessionDb.outbox.put({
      client_id: completionClientId,
      user_id: DEV_USER_SCOPE,
      entity: "session",
      entity_id: sessionId,
      op: "upsert",
      updated_at: "2026-08-14T10:00:00.000Z",
      payload: { status: "completed" },
      attempts: 0,
    });
  }

  it("server 가 완료를 적용하고 outbox 가 비면 marker 와 캐시를 함께 지운다", async () => {
    await seedPendingCompletedSession();

    await new SyncCoordinator({
      transport: async () => response([completionClientId]) as never,
    }).request();

    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]),
    ).toBeUndefined();
    // marker 만 지우면 아래 셋이 stale 인 채로 다시 보인다.
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(await sessionDb.routines.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(
      await sessionDb.readModels.get([DEV_USER_SCOPE, `history-session:${sessionId}`]),
    ).toBeUndefined();
  });

  it("pending performed_set 이 남아 있으면 정리하지 않는다 — 실제 planned-set keyed outbox", async () => {
    await seedPendingCompletedSession();
    // **production 이 실제로 만드는 모양**으로 심는다: entity_id 는 sessionId 가 아니라 planned_set_id 다.
    await commitDraft(
      DEV_USER_SCOPE,
      sessionId,
      { ...draft(id("64")), planned_set_id: plannedSetId },
      "upsert",
    );
    const pending = await sessionDb.outbox.get(id("64"));
    expect(pending?.entity_id).toBe(plannedSetId);
    expect(pending?.entity_id).not.toBe(sessionId);

    await new SyncCoordinator({
      transport: async () => response([completionClientId]) as never,
    }).request();

    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]),
    ).toBeDefined();
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeDefined();
  });

  it("그 mutation 까지 ack 되면 네 store 가 함께 정리된다", async () => {
    await seedPendingCompletedSession();
    await commitDraft(
      DEV_USER_SCOPE,
      sessionId,
      { ...draft(id("65")), planned_set_id: plannedSetId },
      "upsert",
    );

    await new SyncCoordinator({
      transport: async () => response([completionClientId, id("65")]) as never,
    }).request();

    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]),
    ).toBeUndefined();
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(await sessionDb.routines.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(
      await sessionDb.readModels.get([DEV_USER_SCOPE, `history-session:${sessionId}`]),
    ).toBeUndefined();
  });

  it("marker 가 없는 평범한 완료는 캐시를 건드리지 않는다 — 오프라인 열람 회귀 금지", async () => {
    await seedPendingCompletedSession();
    await sessionDb.syncMeta.delete([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]);

    await new SyncCoordinator({
      transport: async () => response([completionClientId]) as never,
    }).request();

    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeDefined();
  });
});

/**
 * **helper 가 아니라 production call 을 검증한다.** `SyncCoordinator.sync()` 의 호출 줄을 지워도
 * helper 단위 테스트는 그대로 통과했다(독립 재리뷰 P2-3).
 */
describe("sync 가 실제로 marker processor 를 부른다", () => {
  const sessionId = id("71");

  it("request() 뒤 pending marker 가 authoritative refetch 로 해제된다", async () => {
    await sessionDb.syncMeta.put({
      user_id: DEV_USER_SCOPE,
      key: `assistance-remediation:${sessionId}`,
      value: "pending_refetch",
    });
    const fetched: string[] = [];

    await new SyncCoordinator({
      transport: async () => response() as never,
      fetchSession: async (id) => {
        fetched.push(id);
        return {
          id,
          status: "scheduled",
          planned_sets: [
            { id: "ps-1", exercise_id: "e_bench_press", set_no: 1, load_kind: "external" },
          ],
        };
      },
    }).request();

    expect(fetched).toEqual([sessionId]);
    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, `assistance-remediation:${sessionId}`]),
    ).toBeUndefined();
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeDefined();
  });
});

/**
 * **completion cleanup 은 sync 를 넘어 살아남아야 한다.**
 *
 * completion ack 와 마지막 performed-set ack 가 **다른 sync** 에 오면, 보류 사실이 현재 response 의
 * 메모리 `Set` 에만 있을 때 후보가 통째로 사라진다. 게다가 그 사이 일반 refetch 가 safe 200 으로
 * marker 를 먼저 지우면 cleanup 은 영영 다시 시도되지 않는다(독립 재리뷰 P1).
 */
describe("completion cleanup 의 durable 재시도", () => {
  const sessionId = id("81");
  const completionClientId = id("82");
  const plannedSetId = id("83");
  const setClientId = id("84");
  const markerKey = `assistance-remediation:${sessionId}`;

  async function seed() {
    await sessionDb.sessions.put({
      user_id: DEV_USER_SCOPE,
      session_id: sessionId,
      session: {
        id: sessionId,
        planned_sets: [
          { id: plannedSetId, exercise_id: "e_bench_press", set_no: 1, load_kind: "external" },
        ],
      },
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.routines.put({
      user_id: DEV_USER_SCOPE,
      session_id: sessionId,
      exercise_ids: ["e_bench_press"],
      correlations: [],
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.readModels.put({
      user_id: DEV_USER_SCOPE,
      cache_key: `history-session:${sessionId}`,
      kind: "history-session",
      data: {},
      request_started_at: 0,
      synced_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.syncMeta.put({
      user_id: DEV_USER_SCOPE,
      key: markerKey,
      value: "pending_refetch",
    });
    await sessionDb.outbox.put({
      client_id: completionClientId,
      user_id: DEV_USER_SCOPE,
      entity: "session",
      entity_id: sessionId,
      op: "upsert",
      updated_at: "2026-08-14T10:00:00.000Z",
      payload: { status: "completed" },
      attempts: 0,
    });
  }

  /** 안전한 authoritative 응답 — 일반 refetch 가 성공하는 상황을 실제로 만든다. */
  const safeSession = {
    id: sessionId,
    status: "completed",
    planned_sets: [
      { id: plannedSetId, exercise_id: "e_bench_press", set_no: 1, load_kind: "external" },
    ],
  };

  it("두 request 에 걸쳐도 cleanup 이 정확히 한 번 완료된다", async () => {
    await seed();

    // ── 첫 sync: completion 만 ack. transport 중에 실제 기록이 들어온다.
    let fetched = 0;
    await new SyncCoordinator({
      transport: async () => {
        await commitDraft(
          DEV_USER_SCOPE,
          sessionId,
          { ...draft(setClientId), planned_set_id: plannedSetId },
          "upsert",
        );
        return response([completionClientId]) as never;
      },
      fetchSession: async () => {
        fetched += 1;
        return safeSession;
      },
    }).request();

    // drain 이 안 끝났으니 아무것도 지우지 않는다.
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeDefined();
    expect(await sessionDb.routines.get([DEV_USER_SCOPE, sessionId])).toBeDefined();
    // **후보가 durable 하게 남는다** — 메모리 Set 이 아니라 syncMeta 다.
    const held = await sessionDb.syncMeta.get([DEV_USER_SCOPE, markerKey]);
    expect(held).toBeDefined();
    // 그리고 일반 refetch 가 그 marker 를 지우지도, 미러를 확정하지도 못한다.
    expect(fetched).toBe(0);
    // 사용자의 기록은 그대로다.
    expect(await sessionDb.outbox.get(setClientId)).toBeDefined();

    // ── 둘째 sync: performed-set 만 ack. completion response 는 더 없다.
    await new SyncCoordinator({
      transport: async () => response([setClientId]) as never,
      fetchSession: async () => safeSession,
    }).request();

    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(await sessionDb.routines.get([DEV_USER_SCOPE, sessionId])).toBeUndefined();
    expect(
      await sessionDb.readModels.get([DEV_USER_SCOPE, `history-session:${sessionId}`]),
    ).toBeUndefined();
    expect(await sessionDb.syncMeta.get([DEV_USER_SCOPE, markerKey])).toBeUndefined();
    // drafts 는 보존한다 — 정리 대상이 아니다.
    expect(await sessionDb.drafts.where("planned_set_id").equals(plannedSetId).count()).toBe(1);
  });

  it("completion 후보인 동안에는 safe GET 이 marker 도 미러도 건드리지 않는다", async () => {
    await seed();
    await commitDraft(
      DEV_USER_SCOPE,
      sessionId,
      { ...draft(setClientId), planned_set_id: plannedSetId },
      "upsert",
    );

    await new SyncCoordinator({
      transport: async () => response([completionClientId]) as never,
      fetchSession: async () => safeSession,
    }).request();

    // 후보 상태에서 authoritative commit 을 직접 시도해도 거절된다.
    expect(await commitAuthoritativeSession(DEV_USER_SCOPE, sessionId, safeSession)).toBe(false);
    expect(await sessionDb.syncMeta.get([DEV_USER_SCOPE, markerKey])).toBeDefined();
    // 읽기 경로도 계속 막힌다(오프라인 폴백 0).
    expect(await isRemediationPending(DEV_USER_SCOPE, sessionId)).toBe(true);
  });

  it("모르는 marker 값은 fail closed 다 — 해제도 refetch 도 하지 않는다", async () => {
    await seed();
    await sessionDb.syncMeta.put({
      user_id: DEV_USER_SCOPE,
      key: markerKey,
      value: "who_knows",
    });

    let fetched = 0;
    await new SyncCoordinator({
      transport: async () => response() as never,
      fetchSession: async () => {
        fetched += 1;
        return safeSession;
      },
    }).request();

    expect(fetched).toBe(0);
    expect(await sessionDb.syncMeta.get([DEV_USER_SCOPE, markerKey])).toBeDefined();
    expect(await isRemediationPending(DEV_USER_SCOPE, sessionId)).toBe(true);
  });
});
