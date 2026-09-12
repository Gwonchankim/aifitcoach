import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlannedSet, Session, SyncRequest, SyncResponse } from "../lib/api";
import {
  commitDraft,
  commitRoutineSnapshot,
  commitSessionCompletion,
  mirrorSession,
  readThroughSession,
  readMirroredSession,
  sessionDb,
  type OutboxMutation,
  markRemediationPending,
  markerKeyFor,
  COMPLETION_DRAIN_PENDING,
} from "../components/session/session-db";
import {
  commitSessionSetAppend,
  readAppendState,
} from "../components/session/session-set-append-db";
import { readPosition, positionKey, savePosition } from "../components/session/session-position";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import { captureAppendSource } from "../components/session/session-set-append";
import { saveRestTimer, loadRestTimer } from "../components/session/rest-timer-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { user_id: "append-owner", session_id: id(1) };
const t0 = "2026-08-14T10:00:00.000Z";
const row = (n = 1): PlannedSet => ({
  id: id(10 + n),
  exercise_id: "bench",
  set_no: n,
  source_revision: `r${n}`,
  correlation_id: null,
  append_eligibility: {
    version: 1,
    source_revision: `r${n}`,
    cohort_revision: "cohort",
    status: "allowed",
    reason: null,
  },
  target_reps_low: 8,
  target_reps_high: 12,
  target_rir: 2,
  rest_sec: 90,
  recommended_weight: 60,
  recommended_reps: 9,
  reason_code: "BASELINE",
  confidence: 0.3,
  rules_version: "2026.08.1",
  load_kind: "external",
  recommendation_state: "ready" as const,
  assistance_provenance: null,
  assistance_safety_status: null,
  recommended_action: null,
  recommendation_gate: "ready",
  performed_set: null,
});
const session = (planned_sets = [row()]) =>
  ({
    id: scope.session_id,
    status: "in_progress",
    scheduled_date: "2026-08-14",
    planned_sets,
  }) as Session;
const append = (n = 100) =>
  commitSessionSetAppend(scope, {
    exercise_id: "bench",
    today: "2026-08-14",
    generation: 0,
    client_id: id(n),
    correlation_id: id(n + 1),
    updated_at: t0,
  });
const canonical = () => ({ ...row(2), id: id(500), correlation_id: id(101) });
const response = (applied: string[] = [], mapping = false): SyncResponse => ({
  applied,
  conflicts: [],
  changes: [],
  next_cursor: "cursor",
  planned_set_mappings: mapping
    ? [{ correlation_id: id(101), planned_set_id: id(500), planned_set: canonical() }]
    : [],
});
const draft = (client_id = id(300)) => ({
  planned_set_id: id(101),
  actual_weight: 47.5,
  actual_reps: 9,
  actual_rir: 2,
  actual_time_sec: null,
  pain_score: null,
  completed: true,
  client_id,
  updated_at: t0,
});
function capturedSource(rows = [row()]) {
  const result = captureAppendSource({
    ...scope,
    exercise_id: "bench",
    today: "2026-08-14",
    scheduled_date: "2026-08-14",
    status: "in_progress",
    snapshot: { ...scope, rows },
    entries: [],
    tombstones: [],
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capture;
}
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
  await mirrorSession(scope.user_id, scope.session_id, session());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it("creation tx preserves clicked source across a newer authoritative maximum and coherent cohort", async () => {
  const capture = capturedSource();
  const rows = [row(), { ...row(2), recommended_weight: 75 }].map((value) => ({
    ...value,
    append_eligibility: { ...value.append_eligibility!, cohort_revision: "next-cohort" },
  }));
  await mirrorSession(scope.user_id, scope.session_id, session(rows));
  const entry = await commitSessionSetAppend(scope, {
    exercise_id: "bench",
    today: "2026-08-14",
    generation: 0,
    client_id: id(100),
    correlation_id: id(101),
    updated_at: t0,
    captured: capture,
  });
  expect(entry.intent.transport.payload.source).toEqual(capture.source);
  expect(entry.provisional).toMatchObject({ set_no: 3, recommended_weight: 60 });
});

it("GET-only canonical observation keeps the captured parent correlation and both original pending transports", async () => {
  await append();
  const current = (await readMirroredSession<Session>(scope.user_id, scope.session_id))!;
  const captured = captureAppendSource({
    ...scope,
    exercise_id: "bench",
    today: "2026-08-14",
    scheduled_date: current.scheduled_date,
    status: current.status,
    snapshot: { ...scope, rows: current.planned_sets },
    entries: (await readAppendState(scope)).entries,
    tombstones: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const original = (await sessionDb.outbox.toArray()).map(transportOf);
  await readThroughSession(scope.user_id, scope.session_id, async () =>
    session([row(), canonical()]),
  );
  const child = await commitSessionSetAppend(scope, {
    exercise_id: "bench",
    today: "2026-08-14",
    generation: 0,
    client_id: id(200),
    correlation_id: id(201),
    updated_at: t0,
    captured: captured.capture,
  });
  expect(child.intent.transport.payload.source).toEqual({ source_correlation_id: id(101) });
  expect(child.provisional.set_no).toBe(3);
  const outbox = (await sessionDb.outbox.toArray()).map(transportOf);
  expect(outbox).toHaveLength(2);
  expect(outbox.find((item) => item.client_id === id(100))).toEqual(original[0]);
  expect((await readAppendState(scope)).entries[0].execution.phase).toBe("pending");
});

it.each(["revision", "deleted", "unsafe", "scope"])(
  "creation tx rejects captured %s changes with no partial outbox/row/position",
  async (kind) => {
    const capture = capturedSource();
    const changed =
      kind === "revision"
        ? {
            ...row(),
            source_revision: "new",
            append_eligibility: { ...row().append_eligibility!, source_revision: "new" },
          }
        : kind === "unsafe"
          ? {
              ...row(),
              append_eligibility: {
                ...row().append_eligibility!,
                status: "blocked" as const,
                reason: "unsafe_assistance_snapshot" as const,
              },
            }
          : row();
    await mirrorSession(
      scope.user_id,
      scope.session_id,
      session(kind === "deleted" ? [] : [changed]),
    );
    const before = {
      sessions: await sessionDb.sessions.toArray(),
      outbox: await sessionDb.outbox.toArray(),
      meta: await sessionDb.syncMeta.toArray(),
    };
    await expect(
      commitSessionSetAppend(scope, {
        exercise_id: "bench",
        today: "2026-08-14",
        generation: 0,
        client_id: id(100),
        correlation_id: id(101),
        updated_at: t0,
        captured: kind === "scope" ? { ...capture, session_id: id(2) } : capture,
      }),
    ).rejects.toThrow();
    expect({
      sessions: await sessionDb.sessions.toArray(),
      outbox: await sessionDb.outbox.toArray(),
      meta: await sessionDb.syncMeta.toArray(),
    }).toEqual(before);
  },
);

it("atomically commits append intent/outbox/public provisional mirror/position, never an actual draft", async () => {
  const entry = await append();
  const stored = await readAppendState(scope);
  expect(stored.entries).toEqual([entry]);
  expect(await sessionDb.outbox.get(id(100))).toEqual({
    ...entry.intent.transport,
    user_id: scope.user_id,
    attempts: 0,
  });
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (s) => s.id,
    ),
  ).toEqual([row().id, id(101)]);
  expect((await readPosition(scope.user_id, scope.session_id)).position).toEqual({
    exercise_id: "bench",
    planned_set_id: id(101),
    expanded: false,
  });
  expect(await sessionDb.drafts.count()).toBe(0);
  sessionDb.close();
  await sessionDb.open();
  expect((await readAppendState(scope)).entries).toEqual([entry]);
});

it("rolls all creation tables back when the position write fails", async () => {
  const put = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
  vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((...args) => {
    if (args[0].key === positionKey(scope.session_id)) throw new Error("position write failed");
    return put(...args);
  });
  await expect(append()).rejects.toThrow("position write failed");
  expect((await readAppendState(scope)).entries).toEqual([]);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(await readMirroredSession(scope.user_id, scope.session_id)).toEqual(session());
});

it("serializes concurrent creation transactions on one connection against current membership", async () => {
  await Promise.all([append(), append(102)]);
  const state = await readAppendState(scope);
  expect(state.entries.map((e) => e.provisional.set_no)).toEqual([2, 3]);
  expect(state.entries[1].intent.transport.payload.source).toEqual({
    source_correlation_id: id(101),
  });
  await mirrorSession(
    scope.user_id,
    scope.session_id,
    session([{ ...row(), append_eligibility: null }]),
  );
  await expect(append(200)).rejects.toThrow("eligibility_unavailable");
  await expect(
    commitSessionSetAppend(
      { ...scope, session_id: id(2) },
      {
        exercise_id: "bench",
        today: "2026-08-14",
        generation: 0,
        client_id: id(200),
        correlation_id: id(201),
        updated_at: t0,
      },
    ),
  ).rejects.toThrow();
});

it("GET exact correlation updates execution identity but never acknowledges or rewrites original transport", async () => {
  const entry = await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  const before = await sessionDb.outbox.toArray();
  const fetched = await readThroughSession(scope.user_id, scope.session_id, async () =>
    session([row(), canonical()]),
  );
  expect(fetched.planned_sets.map((s) => s.id)).toEqual([row().id, id(500)]);
  const observed = (await readAppendState(scope)).entries[0];
  expect(observed.intent).toEqual(entry.intent);
  expect(observed.execution.phase).toBe("pending");
  expect(observed.execution.canonical_id).toBe(id(500));
  const after = await sessionDb.outbox.toArray();
  expect(after.map(({ canonical_entity_id: _ref, ...transport }) => transport)).toEqual(before);
  expect((await readPosition(scope.user_id, scope.session_id)).position?.planned_set_id).toBe(
    id(500),
  );
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toBeUndefined();
});

it("actual coordinator ACK atomically remaps drafts/position/execution, preserving dependent UUID/payload/time", async () => {
  const entry = await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  const original = await sessionDb.outbox.get(id(300));
  const transport = vi.fn(async (): Promise<SyncResponse> => ({
    ...response([id(100)], true),
    changes: [
      {
        entity: "performed_set",
        entity_id: id(500),
        op: "upsert",
        data: { actual_weight: 999 },
        server_seq: "1",
      },
    ],
  }));
  await new SyncCoordinator({ userId: scope.user_id, transport }).request();
  expect((await readAppendState(scope)).entries[0]).toMatchObject({
    intent: entry.intent,
    execution: { phase: "applied", canonical_id: id(500) },
  });
  expect(await sessionDb.outbox.get(id(100))).toBeUndefined();
  expect(await sessionDb.outbox.get(id(300))).toEqual({
    ...original,
    canonical_entity_id: id(500),
  });
  // An old-ID replay after alias creation must preserve the already committed original transport.
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  expect(await sessionDb.outbox.get(id(300))).toEqual({
    ...original,
    canonical_entity_id: id(500),
  });
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(500)])).toEqual({
    ...draft(),
    planned_set_id: id(500),
    ...scope,
  });
  const outgoing = vi.fn(async (_body: SyncRequest) => response());
  await new SyncCoordinator({ userId: scope.user_id, transport: outgoing }).request();
  expect(outgoing.mock.calls[0][0].mutations).toEqual([
    {
      client_id: id(300),
      entity: "performed_set",
      entity_id: id(101),
      op: "upsert",
      updated_at: t0,
      payload: original!.payload,
      append_dependencies: { session_id: scope.session_id, client_ids: [id(100)] },
    },
  ]);
  await commitDraft(scope.user_id, scope.session_id, draft(id(301)), "upsert");
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toBeUndefined();
  expect((await sessionDb.outbox.get(id(301)))?.entity_id).toBe(id(500));
});

it("rolls ACK remap back with the original pending bytes when the existing mapping transaction fails", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  const state = await readAppendState(scope);
  const outbox = await sessionDb.outbox.toArray();
  const position = await readPosition(scope.user_id, scope.session_id);
  await expect(
    new SyncCoordinator({
      userId: scope.user_id,
      transport: async () => response([id(100)], true),
      duringMappingCommit: () => {
        throw new Error("ACK fault");
      },
    }).request(),
  ).rejects.toThrow("ACK fault");
  expect(await readAppendState(scope)).toEqual(state);
  expect(await sessionDb.outbox.toArray()).toEqual(outbox);
  expect(await readPosition(scope.user_id, scope.session_id)).toEqual(position);
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toBeDefined();
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(500)])).toBeUndefined();
});

it.each([
  ["canonical first, later timestamp", false, "2026-08-14T10:01:00.000Z", 301, "canonical"],
  ["provisional first, later timestamp", true, "2026-08-14T10:01:00.000Z", 301, "canonical"],
  ["canonical UUID wins timestamp tie", false, t0, 301, "canonical"],
  ["provisional UUID wins timestamp tie", true, t0, 299, "provisional"],
  ["provisional later timestamp", false, "2026-08-14T09:59:00.000Z", 301, "provisional"],
] as const)(
  "append ACK retains LWW winner: %s",
  async (_name, provisionalFirst, canonicalTime, canonicalClient, winner) => {
    await append();
    await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
    const transport = transportOf((await sessionDb.outbox.get(id(300)))!);
    const old = { ...draft(), ...scope };
    const current = {
      ...draft(id(canonicalClient)),
      ...scope,
      planned_set_id: id(500),
      actual_weight: 72.5,
      updated_at: canonicalTime,
    };
    await sessionDb.drafts.delete([scope.user_id, scope.session_id, id(101)]);
    for (const value of provisionalFirst ? [old, current] : [current, old])
      await sessionDb.drafts.put(value);
    await new SyncCoordinator({
      userId: scope.user_id,
      transport: async () => response([id(100)], true),
    }).request();
    expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(500)])).toEqual(
      winner === "canonical" ? current : { ...old, planned_set_id: id(500) },
    );
    expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toBeUndefined();
    expect(transportOf((await sessionDb.outbox.get(id(300)))!)).toEqual(transport);
  },
);

it("keeps remediation completion drain pending for immutable provisional Y after C ACK until Y itself is ACKed", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  await commitDraft(
    scope.user_id,
    scope.session_id,
    { ...draft(id(301)), updated_at: "2026-08-14T10:01:00.000Z" },
    "upsert",
  );
  const y = transportOf((await sessionDb.outbox.get(id(301)))!);
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100), id(300)], true),
  }).request();
  expect((await sessionDb.outbox.get(id(301)))?.canonical_entity_id).toBe(id(500));
  expect((await sessionDb.outbox.get(id(400)))?.append_dependencies?.performed_client_ids).toEqual([
    id(300),
  ]);
  await markRemediationPending(scope.user_id, scope.session_id);
  const sync = new SyncCoordinator({
    userId: scope.user_id,
    fetchSession: async () => {
      throw new Error("offline");
    },
    transport: async () => response([id(400)]),
  });
  await sync.request();
  expect((await sessionDb.sessions.get([scope.user_id, scope.session_id]))?.session).toMatchObject({
    status: "completed",
  });
  expect(
    (await sessionDb.syncMeta.get([scope.user_id, markerKeyFor(scope.session_id)]))?.value,
  ).toBe(COMPLETION_DRAIN_PENDING);
  expect(transportOf((await sessionDb.outbox.get(id(301)))!)).toEqual(y);
  expect(await sessionDb.outbox.get(id(400))).toBeUndefined();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(301)]),
  }).request();
  expect(await sessionDb.sessions.get([scope.user_id, scope.session_id])).toBeUndefined();
  expect(
    await sessionDb.syncMeta.get([scope.user_id, markerKeyFor(scope.session_id)]),
  ).toBeUndefined();
});

it("an older GET cannot replace a newly ACKed row and plain GET absence cannot delete it", async () => {
  await append();
  let release!: (s: Session) => void;
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const late = readThroughSession(scope.user_id, scope.session_id, () => {
    started();
    return new Promise<Session>((resolve) => {
      release = resolve;
    });
  });
  await fetching;
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  release(session([row(), { ...canonical(), recommended_weight: 999 }]));
  expect((await late).planned_sets[1]).toEqual(canonical());
  expect(
    (await readThroughSession(scope.user_id, scope.session_id, async () => session()))
      .planned_sets[1],
  ).toEqual(canonical());
});

it("generation mismatch after completed position clear cannot create a late append", async () => {
  await sessionDb.syncMeta.put({
    user_id: scope.user_id,
    key: positionKey(scope.session_id),
    value: JSON.stringify({ v: 1, session_id: scope.session_id, generation: 1, position: null }),
  });
  await expect(append()).rejects.toThrow();
  expect(await sessionDb.outbox.count()).toBe(0);
  await savePosition(
    scope.user_id,
    scope.session_id,
    { exercise_id: "bench", planned_set_id: row().id, expanded: false },
    1,
  );
});

it("preserves the committed append view when a safe GET's cache transaction fails", async () => {
  await append();
  vi.spyOn(sessionDb.sessions, "put").mockRejectedValueOnce(new Error("cache write failed"));
  const read = await readThroughSession(scope.user_id, scope.session_id, async () => session());
  expect(read.planned_sets.map((s) => s.id)).toEqual([row().id, id(101)]);
  expect(await sessionDb.outbox.count()).toBe(1);
});

it("still fetches a safe online session when append metadata reads fail and no append is locally known", async () => {
  vi.spyOn(sessionDb.syncMeta, "get").mockRejectedValue(new Error("IDB read failed"));
  const online = session([{ ...row(), recommended_weight: 65 }]);
  const fetch = vi.fn(async () => online);
  await expect(readThroughSession(scope.user_id, scope.session_id, fetch)).resolves.toEqual(online);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not interpret a failed request-start state read as empty when a pending mirror exists", async () => {
  await append();
  const before = await sessionDb.outbox.toArray();
  vi.spyOn(sessionDb.syncMeta, "get").mockRejectedValueOnce(new Error("IDB read failed"));
  const fetch = vi.fn(async () => session());
  const result = await readThroughSession(scope.user_id, scope.session_id, fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.planned_sets.map((s) => s.id)).toEqual([row().id, id(101)]);
  expect(await sessionDb.outbox.toArray()).toEqual(before);
  expect((await readAppendState(scope)).entries[0].execution.phase).toBe("pending");
});

it("retains a known pending mirror and outbox without acknowledging when metadata remains unreadable", async () => {
  await append();
  const before = await sessionDb.sessions.get([scope.user_id, scope.session_id]);
  const outbox = await sessionDb.outbox.toArray();
  vi.spyOn(sessionDb.syncMeta, "get").mockRejectedValue(new Error("IDB read failed"));
  const fetch = vi.fn(async () => session());
  await expect(readThroughSession(scope.user_id, scope.session_id, fetch)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await sessionDb.sessions.get([scope.user_id, scope.session_id])).toEqual(before);
  expect(await sessionDb.outbox.toArray()).toEqual(outbox);
});

it("preserves routine local_ids with the current mixed mirror when a GET predates append creation", async () => {
  let release!: (value: Session) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reading = readThroughSession(scope.user_id, scope.session_id, () => {
    started();
    return new Promise<Session>((resolve) => {
      release = resolve;
    });
  });
  await waiting;
  const baseline = {
    ...row(),
    id: id(700),
    exercise_id: "curl",
    load_kind: undefined,
    recommendation_state: undefined,
    source_revision: undefined,
    append_eligibility: null,
    recommended_weight: 0,
  } as unknown as PlannedSet;
  await commitRoutineSnapshot(
    scope.user_id,
    scope.session_id,
    ["bench", "curl"],
    id(800),
    t0,
    [{ correlation_id: id(700), exercise_id: "curl", set_no: 1 }],
    session([row(), baseline]),
    new Set([id(700)]),
  );
  await append();
  const before = await sessionDb.sessions.get([scope.user_id, scope.session_id]);
  expect(before?.local_ids).toEqual([id(700)]);
  release(session());
  const restored = await reading;
  expect(restored.planned_sets.map((s) => s.id)).toEqual([row().id, id(101), id(700)]);
  expect((await sessionDb.sessions.get([scope.user_id, scope.session_id]))?.local_ids).toEqual([
    id(700),
  ]);
  expect(await readMirroredSession(scope.user_id, scope.session_id)).toEqual(restored);
});

it("maps an append timer with exact deadline and a late old-ID timer save after ACK", async () => {
  await append();
  const now = Date.parse(t0);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const timer = { endsAt: now + 90_000, totalSec: 90 };
  expect(await saveRestTimer(scope.user_id, scope.session_id, id(101), "벤치", timer, now)).toBe(
    true,
  );
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  expect(await loadRestTimer(scope.user_id, scope.session_id, now)).toEqual({
    plannedSetId: id(500),
    title: "벤치",
    timer,
  });
  expect(await saveRestTimer(scope.user_id, scope.session_id, id(101), "벤치", timer, now)).toBe(
    true,
  );
  expect(await loadRestTimer(scope.user_id, scope.session_id, now)).toEqual({
    plannedSetId: id(500),
    title: "벤치",
    timer,
  });
});

it("copies an early-analysis assistance prescription only through its exact local append envelope", async () => {
  const source = {
    ...row(),
    load_kind: "assistance" as const,
    rules_version: "2026.08.2",
    assistance_provenance: "native" as const,
    assistance_safety_status: "safe" as const,
    recommendation_gate: "early" as const,
    recommended_weight: 20,
    recommended_reps: 9,
    reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
    confidence: null,
  };
  await mirrorSession(scope.user_id, scope.session_id, session([source]));
  await append();
  const offline = await readThroughSession<Session>(scope.user_id, scope.session_id, async () => {
    throw new Error("offline");
  });
  expect(offline.planned_sets[1]).toMatchObject({
    recommended_weight: 20,
    recommended_reps: 9,
    reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
    confidence: null,
    recommendation_state: "ready" as const,
    recommended_action: null,
    performed_set: null,
  });
  const mirror = (await sessionDb.sessions.get([scope.user_id, scope.session_id]))!;
  await sessionDb.sessions.put({
    ...mirror,
    session: {
      ...offline,
      planned_sets: [source, { ...offline.planned_sets[1], recommended_weight: 999 }],
    },
  });
  expect(await readMirroredSession(scope.user_id, scope.session_id)).toBeNull();
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(1);
});

const completion = (client = id(400)) =>
  commitSessionCompletion(scope.user_id, scope.session_id, { pain: 0 }, client, t0);
const transportOf = (row: OutboxMutation) => ({
  client_id: row.client_id,
  entity: row.entity,
  entity_id: row.entity_id,
  op: row.op,
  updated_at: row.updated_at,
  payload: row.payload,
  append_dependencies: row.append_dependencies,
});

const deletionResponse = (
  sessionId = scope.session_id,
  plannedId = id(500),
  correlationId: string | null = id(101),
): SyncResponse => ({
  ...response(),
  changes: [
    {
      entity: "session_routine",
      entity_id: sessionId,
      op: "delete",
      server_seq: "42",
      data: {
        tombstones: [
          { planned_set_id: plannedId, correlation_id: correlationId, exercise_id: "bench" },
        ],
      },
    },
  ],
});

it("applies exact routine tombstones despite pending C, retains actual intents and prevents stale GET resurrection", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const original = (await sessionDb.outbox.toArray()).map(transportOf);
  const savedDraft = await sessionDb.drafts.toArray();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => deletionResponse(),
  }).request();
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id]);
  expect((await sessionDb.outbox.toArray()).map(transportOf)).toEqual(original);
  expect(await sessionDb.drafts.toArray()).toEqual(savedDraft);
  expect((await sessionDb.outbox.toArray()).every((row) => row.sync_status === "blocked")).toBe(
    true,
  );
  const readded = { ...row(2), id: id(600), correlation_id: id(601) };
  const fetched = await readThroughSession(scope.user_id, scope.session_id, async () =>
    session([row(), canonical(), readded]),
  );
  expect(fetched.planned_sets.map((row) => row.id)).toEqual([row().id, id(600)]);
  const sent = vi.fn(async (_body: SyncRequest) => response());
  await new SyncCoordinator({ userId: scope.user_id, transport: sent }).request();
  expect(sent.mock.calls[0][0].mutations).toEqual([]);
});

it("closes a confirmed source deletion over pending append descendants without changing their transport", async () => {
  await append();
  await append(200);
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const original = (await sessionDb.outbox.toArray()).map(transportOf);
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => deletionResponse(scope.session_id, row().id, null),
  }).request();
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets,
  ).toEqual([]);
  expect((await readAppendState(scope)).entries.map((entry) => entry.execution.phase)).toEqual([
    "blocked",
    "blocked",
  ]);
  expect((await sessionDb.outbox.toArray()).map(transportOf)).toEqual(original);
  expect((await sessionDb.outbox.toArray()).every((row) => row.sync_status === "blocked")).toBe(
    true,
  );
});

it("does not infer tombstones from legacy routine deletion or another session's exact identities", async () => {
  await append();
  const before = await readAppendState(scope);
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      changes: [
        {
          entity: "session_routine",
          entity_id: scope.session_id,
          op: "delete",
          server_seq: "1",
          data: null,
        },
        ...deletionResponse(id(999), row().id, null).changes,
      ],
    }),
  }).request();
  expect(await readAppendState(scope)).toEqual(before);
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id, id(101)]);
});

it("rolls a completion ACK, draft remap and audit cleanup back together when clearing position fails", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      conflicts: [
        {
          client_id: id(400),
          entity_id: scope.session_id,
          reason: "unresolved_parent",
          retryable: true,
        },
      ],
    }),
  }).request();
  const snapshot = async () => ({
    drafts: await sessionDb.drafts.toArray(),
    outbox: (await sessionDb.outbox.toArray()).map(transportOf),
    audits: await sessionDb.conflicts.toArray(),
    mirror: await sessionDb.sessions.toArray(),
    position: await readPosition(scope.user_id, scope.session_id),
    state: await readAppendState(scope),
  });
  const before = await snapshot();
  const put = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
  vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((...args) => {
    if (
      args[0].key === positionKey(scope.session_id) &&
      JSON.parse(args[0].value).position === null
    )
      throw new Error("position clear failed");
    return put(...args);
  });
  await expect(
    new SyncCoordinator({
      userId: scope.user_id,
      transport: async () => response([id(100), id(300), id(400)], true),
    }).request(),
  ).rejects.toThrow("position clear failed");
  expect(await snapshot()).toEqual(before);
});

it("a parent-only terminal response blocks missing-response descendants and C without removing any original intent", async () => {
  await append();
  await append(200);
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const before = (await sessionDb.outbox.toArray()).map(transportOf);
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      conflicts: [
        {
          client_id: id(100),
          entity_id: scope.session_id,
          reason: "source_removed",
          retryable: false,
        },
      ],
    }),
  }).request();
  expect((await sessionDb.outbox.toArray()).map(transportOf)).toEqual(before);
  for (const client of [id(200), id(300), id(400)])
    expect(await sessionDb.outbox.get(client)).toMatchObject({
      sync_status: "blocked",
      sync_reason: "dependent_conflict",
      cause_client_id: id(100),
      cause_reason: "source_removed",
    });
});

it("rejects malformed tombstone input atomically without partially applying its earlier exact identity", async () => {
  await append();
  const before = await readAppendState(scope);
  const wire = deletionResponse(scope.session_id, row().id, null);
  (wire.changes[0].data as { tombstones: unknown[] }).tombstones.push({
    planned_set_id: "not-an-id",
    correlation_id: null,
    exercise_id: "bench",
  });
  await expect(
    new SyncCoordinator({ userId: scope.user_id, transport: async () => wire }).request(),
  ).rejects.toThrow("invalid routine tombstone identity");
  expect(await readAppendState(scope)).toEqual(before);
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id, id(101)]);
});

it("uses an ACKed append's exact intrinsic X target deletion to block C without resurrecting or discarding its actual", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const intents = (await sessionDb.outbox.toArray()).map(transportOf);
  const actual = await sessionDb.drafts.toArray();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      conflicts: [
        {
          client_id: id(300),
          entity_id: id(500),
          reason: "append_target_removed",
          retryable: false,
        },
        {
          client_id: id(400),
          entity_id: scope.session_id,
          reason: "dependent_conflict",
          retryable: false,
          cause_client_id: id(300),
          cause_reason: "append_target_removed",
        },
      ],
    }),
  }).request();
  expect((await sessionDb.outbox.toArray()).map(transportOf)).toEqual(intents);
  expect(await sessionDb.drafts.toArray()).toEqual(actual);
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id]);
  expect(
    (
      await readThroughSession(scope.user_id, scope.session_id, async () =>
        session([row(), canonical()]),
      )
    ).planned_sets.map((row) => row.id),
  ).toEqual([row().id]);
  expect(await sessionDb.outbox.get(id(400))).toMatchObject({
    sync_status: "blocked",
    sync_reason: "dependent_conflict",
    cause_client_id: id(300),
    cause_reason: "append_target_removed",
  });
});

it("does not turn a generic actual error or a foreign completion cause into append target deletion", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  await sessionDb.outbox.put({
    ...(await sessionDb.outbox.get(id(300)))!,
    user_id: "other-owner",
    client_id: id(999),
  });
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      conflicts: [
        { client_id: id(300), entity_id: id(500), reason: "not_found", retryable: false },
        {
          client_id: id(400),
          entity_id: scope.session_id,
          reason: "dependent_conflict",
          retryable: false,
          cause_client_id: id(999),
          cause_reason: "append_target_removed",
        },
      ],
    }),
  }).request();
  expect((await readAppendState(scope)).tombstones).toEqual([]);
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id, id(500)]);
});

it("accepts C-only deletion proof only for its fixed actual barrier and exact owner/session append lineage", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const actual = await sessionDb.drafts.toArray();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => ({
      ...response(),
      conflicts: [
        {
          client_id: id(400),
          entity_id: scope.session_id,
          reason: "dependent_conflict",
          retryable: false,
          cause_client_id: id(300),
          cause_reason: "append_target_removed",
        },
      ],
    }),
  }).request();
  expect((await readAppendState(scope)).tombstones).toEqual([id(500), id(101)]);
  expect(await sessionDb.drafts.toArray()).toEqual(actual);
  expect(await sessionDb.outbox.get(id(300))).toMatchObject({ sync_status: "blocked" });
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id]);
});

it("fixes C's barrier at committed in-flight X and keeps C pending through missing responses, excluding later Y", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sync = new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response();
    },
  }).request();
  await waiting;
  await completion();
  const c = transportOf((await sessionDb.outbox.get(id(400)))!);
  expect(c.append_dependencies).toEqual({
    session_id: scope.session_id,
    client_ids: [id(100)],
    performed_client_ids: [id(300)],
  });
  expect((await readMirroredSession<Session>(scope.user_id, scope.session_id))!.status).toBe(
    "in_progress",
  );
  expect((await readPosition(scope.user_id, scope.session_id)).position).not.toBeNull();
  await commitDraft(
    scope.user_id,
    scope.session_id,
    { ...draft(id(301)), updated_at: "2026-08-14T10:01:00.000Z" },
    "upsert",
  );
  await completion(); // Retry creation may not expand the same C intent to include Y.
  expect(transportOf((await sessionDb.outbox.get(id(400)))!)).toEqual(c);
  release();
  await sync;
  expect(transportOf((await sessionDb.outbox.get(id(400)))!)).toEqual(c);
});

it.each(["upsert", "delete"] as const)(
  "captures committed %s X, then excludes it only after successful ACK",
  async (op) => {
    await append();
    await commitDraft(
      scope.user_id,
      scope.session_id,
      { ...draft(), completed: op === "upsert" },
      op,
    );
    await completion();
    expect(
      (await sessionDb.outbox.get(id(400)))?.append_dependencies?.performed_client_ids,
    ).toEqual([id(300)]);
    await new SyncCoordinator({
      userId: scope.user_id,
      transport: async () => response([id(100), id(300)], true),
    }).request();
    await completion(id(401));
    expect(
      (await sessionDb.outbox.get(id(401)))?.append_dependencies?.performed_client_ids,
    ).toEqual([]);
    expect(
      (await sessionDb.outbox.get(id(400)))?.append_dependencies?.performed_client_ids,
    ).toEqual([id(300)]);
  },
);

it("keeps retryable C and exact draft/position, upserts one audit, then ACKs the original C without waiting for later Y", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const c = transportOf((await sessionDb.outbox.get(id(400)))!);
  const position = await readPosition(scope.user_id, scope.session_id);
  const deferred: SyncResponse = {
    ...response(),
    conflicts: [
      {
        client_id: id(400),
        entity_id: scope.session_id,
        reason: "unresolved_parent",
        retryable: true,
        cause_client_id: id(300),
      },
    ],
  };
  const sync = new SyncCoordinator({ userId: scope.user_id, transport: async () => deferred });
  await sync.request();
  await sync.request();
  expect(transportOf((await sessionDb.outbox.get(id(400)))!)).toEqual(c);
  expect(await sessionDb.conflicts.where("client_id").equals(id(400)).count()).toBe(1);
  expect(await readPosition(scope.user_id, scope.session_id)).toEqual(position);
  expect((await readMirroredSession<Session>(scope.user_id, scope.session_id))!.status).toBe(
    "in_progress",
  );
  await commitDraft(scope.user_id, scope.session_id, draft(id(301)), "upsert");
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100), id(300), id(400)], true),
  }).request();
  expect(await sessionDb.outbox.get(id(400))).toBeUndefined();
  expect(await sessionDb.outbox.get(id(301))).toBeDefined();
  expect(await sessionDb.conflicts.where("client_id").equals(id(400)).count()).toBe(0);
  expect((await readMirroredSession<Session>(scope.user_id, scope.session_id))!.status).toBe(
    "completed",
  );
  expect((await readPosition(scope.user_id, scope.session_id)).position).toBeNull();
});

it("retains terminal append/X/C intents and draft, stops automatic resend, and does not complete or clean position", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await completion();
  const original = (await sessionDb.outbox.toArray()).map(transportOf);
  const position = await readPosition(scope.user_id, scope.session_id);
  const terminal: SyncResponse = {
    ...response(),
    conflicts: [
      {
        client_id: id(100),
        entity_id: scope.session_id,
        reason: "source_removed",
        retryable: false,
      },
      {
        client_id: id(300),
        entity_id: id(101),
        reason: "unresolved_parent",
        retryable: false,
        cause_client_id: id(100),
        cause_reason: "source_removed",
      },
      {
        client_id: id(400),
        entity_id: scope.session_id,
        reason: "unresolved_parent",
        retryable: false,
        cause_client_id: id(100),
        cause_reason: "source_removed",
      },
    ],
  };
  await new SyncCoordinator({ userId: scope.user_id, transport: async () => terminal }).request();
  expect((await sessionDb.outbox.toArray()).map(transportOf)).toEqual(original);
  expect((await readAppendState(scope)).entries[0].execution.phase).toBe("blocked");
  expect(await readPosition(scope.user_id, scope.session_id)).toEqual(position);
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toEqual({
    ...draft(),
    ...scope,
  });
  const sent = vi.fn(async (_body: SyncRequest) => response());
  await new SyncCoordinator({ userId: scope.user_id, transport: sent }).request();
  expect(sent.mock.calls[0][0].mutations).toEqual([]);
  expect((await sessionDb.sessions.get([scope.user_id, scope.session_id]))?.session).toMatchObject({
    status: "in_progress",
  });
});

it("retains a mixed routine envelope through append then routine creation and a fresh GET while routine ACK is pending", async () => {
  await append();
  const current = (await readMirroredSession<Session>(scope.user_id, scope.session_id))!;
  const baseline = {
    ...row(),
    id: id(700),
    exercise_id: "curl",
    load_kind: undefined,
    recommendation_state: undefined,
    source_revision: undefined,
    append_eligibility: null,
    recommended_weight: 0,
  } as unknown as PlannedSet;
  await commitRoutineSnapshot(
    scope.user_id,
    scope.session_id,
    ["bench", "curl"],
    id(800),
    t0,
    [{ correlation_id: id(700), exercise_id: "curl", set_no: 1 }],
    { ...current, planned_sets: [...current.planned_sets, baseline] },
    new Set([id(700)]),
  );
  const before = await sessionDb.sessions.get([scope.user_id, scope.session_id]);
  expect(before?.append_ids).toEqual([id(101)]);
  const fetched = await readThroughSession(scope.user_id, scope.session_id, async () => session());
  expect(fetched.planned_sets.map((row) => row.id)).toEqual([row().id, id(101), id(700)]);
  expect((await sessionDb.sessions.get([scope.user_id, scope.session_id]))?.local_ids).toEqual([
    id(700),
  ]);
});

it("a routine edit from an older render retains the latest appended row without serializing append correlations as routine parents", async () => {
  const stale = session();
  await append();
  const baseline = {
    ...row(),
    id: id(700),
    exercise_id: "curl",
    load_kind: undefined,
    recommendation_state: undefined,
    source_revision: undefined,
    append_eligibility: null,
    recommended_weight: 0,
  } as unknown as PlannedSet;
  await commitRoutineSnapshot(
    scope.user_id,
    scope.session_id,
    ["bench", "curl"],
    id(800),
    t0,
    [{ correlation_id: id(700), exercise_id: "curl", set_no: 1 }],
    { ...stale, planned_sets: [...stale.planned_sets, baseline] },
    new Set([id(700)]),
  );
  expect(
    (await readMirroredSession<Session>(scope.user_id, scope.session_id))!.planned_sets.map(
      (row) => row.id,
    ),
  ).toEqual([row().id, id(101), id(700)]);
  expect((await sessionDb.outbox.get(id(800)))?.payload.correlations).toEqual([
    { correlation_id: id(700), exercise_id: "curl", set_no: 1 },
  ]);
});

it("the requesting routine's successful ACK confirms its exact removed identities without a GET-absence inference", async () => {
  await append();
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(100)], true),
  }).request();
  await commitRoutineSnapshot(scope.user_id, scope.session_id, [], id(800), t0, [], session([]));
  expect((await readAppendState(scope)).tombstones).toEqual([]); // Local intent alone is not server deletion proof.
  await new SyncCoordinator({
    userId: scope.user_id,
    transport: async () => response([id(800)]),
  }).request();
  const stale = await readThroughSession(scope.user_id, scope.session_id, async () =>
    session([row(), canonical()]),
  );
  expect(stale.planned_sets).toEqual([]);
  expect((await readAppendState(scope)).tombstones).toContain(id(500));
});

it.each(["value", "time", "op"] as const)(
  "atomically rejects a reused append actual UUID with changed %s",
  async (kind) => {
    await append();
    await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
    const before = {
      drafts: await sessionDb.drafts.toArray(),
      outbox: await sessionDb.outbox.toArray(),
    };
    const changed = {
      ...draft(),
      ...(kind === "value" ? { actual_weight: 99 } : {}),
      ...(kind === "time" ? { updated_at: "2026-08-14T10:01:00.000Z" } : {}),
      ...(kind === "op" ? { completed: false } : {}),
    };
    await expect(
      commitDraft(scope.user_id, scope.session_id, changed, kind === "op" ? "delete" : "upsert"),
    ).rejects.toThrow("immutable append intent");
    expect({
      drafts: await sessionDb.drafts.toArray(),
      outbox: await sessionDb.outbox.toArray(),
    }).toEqual(before);
  },
);

it.each(["pain", "time"] as const)(
  "rejects reused C UUID with changed %s without recomputing its fixed barrier",
  async (kind) => {
    await append();
    await completion();
    const before = await sessionDb.outbox.toArray();
    await expect(
      commitSessionCompletion(
        scope.user_id,
        scope.session_id,
        { pain: kind === "pain" ? 5 : 0 },
        id(400),
        kind === "time" ? "2026-08-14T10:01:00.000Z" : t0,
      ),
    ).rejects.toThrow("immutable append intent");
    expect(await sessionDb.outbox.toArray()).toEqual(before);
  },
);

it("replaying an old immutable actual after GET mapping cannot overwrite a newer canonical draft", async () => {
  await append();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  await readThroughSession(scope.user_id, scope.session_id, async () =>
    session([row(), canonical()]),
  );
  const newer = {
    ...draft(id(301)),
    planned_set_id: id(500),
    actual_weight: 75,
    updated_at: "2026-08-14T10:01:00.000Z",
  };
  await commitDraft(scope.user_id, scope.session_id, newer, "upsert");
  const original = await sessionDb.outbox.toArray();
  await commitDraft(scope.user_id, scope.session_id, draft(), "upsert");
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(500)])).toEqual({
    ...newer,
    ...scope,
  });
  expect(await sessionDb.drafts.get([scope.user_id, scope.session_id, id(101)])).toBeUndefined();
  expect(await sessionDb.outbox.toArray()).toEqual(original);
});

it("a same-UUID append undo cannot change retained local actual values behind its empty DELETE payload", async () => {
  await append();
  const undone = { ...draft(), completed: false };
  await commitDraft(scope.user_id, scope.session_id, undone, "delete");
  const before = {
    drafts: await sessionDb.drafts.toArray(),
    outbox: await sessionDb.outbox.toArray(),
  };
  expect(before.outbox.find((row) => row.client_id === undone.client_id)?.payload).toEqual({});
  await expect(
    commitDraft(scope.user_id, scope.session_id, { ...undone, actual_weight: 99 }, "delete"),
  ).rejects.toThrow("immutable append intent");
  expect({
    drafts: await sessionDb.drafts.toArray(),
    outbox: await sessionDb.outbox.toArray(),
  }).toEqual(before);
});
