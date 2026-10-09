import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, SyncRequest, SyncResponse } from "../lib/api";
import { commitDraft, DEV_USER_SCOPE, sessionDb } from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";

const SID = "10000000-0000-4000-8000-000000000001";
const SET = "30000000-0000-4000-8000-000000000001";
const LOCAL = "30000000-0000-4000-8000-000000000002";
const CLIENT = "40000000-0000-4000-8000-000000000001";
const actual = {
  actual_weight: 60,
  actual_reps: 8,
  actual_rir: 2,
  actual_time_sec: null,
  completed: true,
  performed_at: "2026-08-14T09:00:00.000Z",
};
const authority = (): Session => ({
  id: SID,
  program_id: "20000000-0000-4000-8000-000000000001",
  goal: "hypertrophy",
  status: "scheduled",
  scheduled_date: "2026-08-14",
  planned_sets: [
    {
      id: SET,
      exercise_id: "bench",
      set_no: 1,
      source_revision: "bug02-source",
      correlation_id: null,
      append_eligibility: null,
      target_reps_low: 8,
      target_reps_high: 10,
      target_rir: 2,
      rest_sec: 90,
      recommended_weight: 60,
      recommended_reps: 9,
      reason_code: "BASELINE",
      rules_version: "2026.08.1",
      confidence: 0.8,
      load_kind: "external",
      recommendation_state: "ready",
      assistance_provenance: null,
      recommended_action: null,
      assistance_safety_status: null,
      recommendation_gate: "ready",
      performed_set: actual,
    },
  ],
});
const answer = (body: SyncRequest, first: boolean): SyncResponse => ({
  applied: body.mutations.map((row) => row.client_id),
  conflicts: [],
  planned_set_mappings: [],
  changes: first
    ? [
        {
          entity: "performed_set",
          entity_id: SET,
          session_id: SID,
          op: "upsert",
          server_seq: "1",
          data: actual,
        },
      ]
    : [],
  next_cursor: "recovery-scheduling-cursor",
});
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function writeIntent() {
  await commitDraft(
    DEV_USER_SCOPE,
    SID,
    {
      planned_set_id: LOCAL,
      ...actual,
      pain_score: null,
      client_id: CLIENT,
      updated_at: "2026-08-14T10:00:00.000Z",
    },
    "upsert",
  );
}
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it("a same-document user flush reaches transport while the earlier recovery GET is unresolved", async () => {
  const entered = latch<void>(),
    read = latch<Session>();
  const sent: SyncRequest[] = [];
  const sync = new SyncCoordinator({
    owner: "first-document",
    clock: { now: () => 0 },
    transport: async (body) => {
      sent.push(body);
      return answer(body, sent.length === 1);
    },
    fetchSession: async () => {
      entered.resolve();
      return read.promise;
    },
  });
  const first = sync.request();
  await entered.promise;
  expect(await sessionDb.syncMeta.count()).toBe(2); // cursor plus durable identity marker
  await writeIntent();
  const second = sync.request(true);
  try {
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 300, interval: 10 });
    expect(sent[1].mutations.filter((row) => row.client_id === CLIENT).length).toBe(1);
    expect(await sessionDb.outbox.count()).toBe(0);
  } finally {
    read.resolve(authority());
    await Promise.all([first, second]);
  }
});

it("reload-equivalent new owner flushes before the earlier document recovery GET settles", async () => {
  const entered = latch<void>(),
    read = latch<Session>();
  const first = new SyncCoordinator({
    owner: "old-document",
    clock: { now: () => 0 },
    transport: async (body) => answer(body, true),
    fetchSession: async () => {
      entered.resolve();
      return read.promise;
    },
  }).request();
  await entered.promise;
  await writeIntent();
  const sent = vi.fn(async (body: SyncRequest) => answer(body, false));
  const reloaded = new SyncCoordinator({
    owner: "new-document",
    clock: { now: () => 0 },
    transport: sent,
    fetchSession: async () => read.promise,
  });
  try {
    await reloaded.request();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0].mutations.filter((row) => row.client_id === CLIENT).length).toBe(
      1,
    );
    expect(await sessionDb.outbox.count()).toBe(0);
  } finally {
    read.resolve(authority());
    await first;
  }
});
