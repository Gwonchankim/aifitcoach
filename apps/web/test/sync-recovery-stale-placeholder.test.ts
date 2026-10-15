import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, SyncRequest, SyncResponse } from "../lib/api";
import * as database from "../components/session/session-db";
import {
  commitDraft,
  DEV_USER_SCOPE,
  PERFORMED_RECOVERY_PREFIX,
  sessionDb,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";

const SID = "10000000-0000-4000-8000-000000000001";
const SET = "30000000-0000-4000-8000-000000000001";
const LATER = "30000000-0000-4000-8000-000000000002";
const CLIENT = "40000000-0000-4000-8000-000000000001";
const actual = (weight: number) => ({
  actual_weight: weight,
  actual_reps: 8,
  actual_rir: 2,
  actual_time_sec: null,
  completed: true,
  performed_at: "2026-08-14T09:00:00.000Z",
});
const row = (id: string, weight: number): Session["planned_sets"][number] => ({
  id,
  exercise_id: "bench",
  set_no: id === SET ? 1 : 2,
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
  performed_set: actual(weight),
});
const authority = (weight: number): Session => ({
  id: SID,
  program_id: "20000000-0000-4000-8000-000000000001",
  goal: "hypertrophy",
  status: "scheduled",
  scheduled_date: "2026-08-14",
  planned_sets: [row(SET, 60), row(LATER, weight)],
});
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const markerKey = (id: string): [string, string] => [
  DEV_USER_SCOPE,
  PERFORMED_RECOVERY_PREFIX + id,
];
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it.each([
  [true, "none"],
  [true, "pending"],
  [true, "acked"],
  [false, "none"],
  [false, "pending"],
  [false, "acked"],
] as const)(
  "stale-placeholder: known parent=%s, later user intent=%s",
  async (knownParent, intent) => {
    const entered = latch<void>(),
      oldRead = latch<Session>(),
      freshRead = latch<Session>();
    let sends = 0,
      fetches = 0,
      finishes = 0;
    const sent: SyncRequest[] = [];
    const acknowledgements: string[][] = [];
    let entry: Promise<"resolved" | "rejected"> | undefined;
    const original = database.processPerformedRecovery;
    vi.spyOn(database, "processPerformedRecovery").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } finally {
        finishes++;
      }
    });
    const deferred = vi.spyOn(database, "deferPerformedChange");
    const sync = new SyncCoordinator({
      transport: async (body: SyncRequest): Promise<SyncResponse> => {
        const n = ++sends;
        const applied = body.mutations.map((item) => item.client_id);
        sent.push(body);
        acknowledgements.push(applied);
        return {
          applied,
          conflicts: [],
          planned_set_mappings: [],
          next_cursor: String(n),
          changes:
            n <= 2
              ? [
                  {
                    entity: "performed_set",
                    entity_id: n === 1 ? SET : LATER,
                    ...(knownParent ? { session_id: SID } : {}),
                    op: "upsert",
                    server_seq: String(n),
                    data: actual(n === 1 ? 60 : 55),
                  },
                ]
              : [],
        };
      },
      fetchSession: async (id) => {
        expect(knownParent).toBe(true);
        expect(id).toBe(SID);
        fetches++;
        entered.resolve();
        return fetches === 1 ? oldRead.promise : freshRead.promise;
      },
    });
    await sync.request();
    if (!knownParent) {
      await vi.waitFor(() => expect(finishes).toBe(1));
      entry = database
        .readThroughSession(
          DEV_USER_SCOPE,
          SID,
          async () => {
            fetches++;
            entered.resolve();
            return oldRead.promise;
          },
          { offlineFallback: false },
        )
        .then(
          () => "resolved" as const,
          () => "rejected" as const,
        );
    }
    await entered.promise;
    try {
      expect(await sessionDb.sessions.count()).toBe(0);
      expect(await sessionDb.drafts.count()).toBe(0);
      await sync.request(true);
      if (!knownParent) await vi.waitFor(() => expect(finishes).toBe(2));
      expect(deferred).toHaveBeenCalledTimes(2);
      expect(fetches).toBe(1);
      expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
      expect(JSON.parse((await sessionDb.syncMeta.get(markerKey(LATER)))!.value)).toEqual({
        entity_id: LATER,
        session_id: knownParent ? SID : null,
        status: knownParent ? "pending" : "unresolved",
        server_seq: "2",
      });
      oldRead.resolve(authority(40));
      if (knownParent) await vi.waitFor(() => expect(fetches).toBe(2));
      else await entry;
      // The newly marked identity was already in the stale GET: do not manufacture its placeholder.
      expect(await sessionDb.syncMeta.get(markerKey(LATER))).toBeDefined();
      expect(await sessionDb.sessions.count()).toBe(0);
      expect(await sessionDb.drafts.count()).toBe(0);
      expect(await sessionDb.syncMeta.get(markerKey(SET))).toBeDefined();
      expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
      if (!knownParent) expect(await entry).toBe("rejected");
      let beforeDrafts = "",
        beforeOutbox = "";
      if (intent !== "none") {
        await commitDraft(
          DEV_USER_SCOPE,
          SID,
          {
            planned_set_id: LATER,
            actual_weight: 90,
            actual_reps: 8,
            actual_rir: 2,
            actual_time_sec: null,
            completed: true,
            pain_score: null,
            client_id: CLIENT,
            updated_at: "2026-08-14T10:00:00.000Z",
          },
          "upsert",
        );
        expect(await sessionDb.outbox.count()).toBe(1);
        if (intent === "acked") {
          await sync.request(true);
          if (!knownParent) await vi.waitFor(() => expect(finishes).toBe(3));
          expect(sends).toBe(3);
          expect(sent[2].mutations.map((item) => item.client_id)).toEqual([CLIENT]);
          expect(acknowledgements[2]).toEqual([CLIENT]);
          expect(await sessionDb.outbox.count()).toBe(0);
        }
        beforeDrafts = JSON.stringify(await sessionDb.drafts.toArray());
        beforeOutbox = JSON.stringify(await sessionDb.outbox.toArray());
      }
      if (knownParent) freshRead.resolve(authority(55));
      else
        await database.readThroughSession(
          DEV_USER_SCOPE,
          SID,
          async () => {
            fetches++;
            return authority(55);
          },
          { offlineFallback: false },
        );
      await vi.waitFor(async () =>
        expect(
          (await sessionDb.syncMeta.toArray()).filter((item) =>
            item.key.startsWith(PERFORMED_RECOVERY_PREFIX),
          ),
        ).toHaveLength(0),
      );
      if (knownParent) await vi.waitFor(() => expect(finishes).toBe(intent === "acked" ? 3 : 2));
      expect(fetches).toBe(2);
      expect((await sessionDb.drafts.get([DEV_USER_SCOPE, SID, LATER]))?.actual_weight).toBe(
        intent === "none" ? 55 : 90,
      );
      expect(await sessionDb.drafts.get([DEV_USER_SCOPE, SID, SET])).toMatchObject({
        actual_weight: 60,
        actual_reps: 8,
        actual_rir: 2,
        actual_time_sec: null,
        completed: true,
        client_id: SET,
      });
      expect(await sessionDb.outbox.count()).toBe(intent === "pending" ? 1 : 0);
      if (intent !== "none") {
        const laterDraft = await sessionDb.drafts.get([DEV_USER_SCOPE, SID, LATER]);
        expect(laterDraft?.client_id).toBe(CLIENT);
        // SET is newly projected by the fresh GET; compare the user's exact row, not all rows.
        expect(JSON.stringify([laterDraft])).toBe(beforeDrafts);
        expect(JSON.stringify(await sessionDb.outbox.toArray())).toBe(beforeOutbox);
      }
    } finally {
      oldRead.resolve(authority(40));
      freshRead.resolve(authority(55));
      if (entry) await entry;
      if (knownParent) await vi.waitFor(() => expect(finishes).toBeGreaterThanOrEqual(2));
    }
  },
);
