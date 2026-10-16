import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Dexie from "dexie";
import type { Session, SyncResponse } from "../lib/api";
import {
  commitDraft,
  DEV_USER_SCOPE,
  loadDrafts,
  mirrorSession,
  readThroughSession,
  sessionDb,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import * as database from "../components/session/session-db";
import { expectPrivateEqual, expectPrivateMatch } from "./support/private-record-assertions";

const USER = DEV_USER_SCOPE;
const SID = "10000000-0000-4000-8000-000000000001";
const SET = "30000000-0000-4000-8000-000000000001";
const OTHER = "30000000-0000-4000-8000-000000000002";
const PREFIX = "performed-recovery:";
const actual = {
  actual_weight: 72.5,
  actual_reps: 8,
  actual_rir: 1,
  actual_time_sec: null,
  completed: true,
  performed_at: "2026-08-14T09:00:00.000Z",
};
const session = (): Session => ({
  id: SID,
  program_id: "20000000-0000-4000-8000-000000000001",
  goal: "hypertrophy",
  status: "scheduled",
  scheduled_date: "2026-08-14",
  planned_sets: [SET, OTHER].map((id, index) => ({
    id,
    exercise_id: "bench",
    set_no: index + 1,
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
  })),
});
const change = (
  entity_id = SET,
  session_id: string | null | undefined = SID,
): SyncResponse["changes"][number] => ({
  entity: "performed_set",
  entity_id,
  op: "upsert",
  server_seq: "1",
  data: { ...actual, pain_score: 2 },
  ...(session_id === undefined ? {} : { session_id }),
});
const response = (changes: SyncResponse["changes"] = [change()]): SyncResponse => ({
  applied: [],
  conflicts: [],
  planned_set_mappings: [],
  changes,
  next_cursor: "cursor-after-record",
});
const markers = () =>
  sessionDb.syncMeta
    .where("user_id")
    .equals(USER)
    .filter((row) => row.key.startsWith(PREFIX))
    .toArray();
const localDraft = (planned_set_id = OTHER, completed = true) => ({
  planned_set_id,
  ...actual,
  completed,
  pain_score: null,
  client_id: "40000000-0000-4000-8000-000000000001",
  updated_at: "2026-08-14T10:00:00.000Z",
});

const performRecovery = database.processPerformedRecovery;
let recoveryFinishes = 0;
async function settled(sync: SyncCoordinator) {
  const before = recoveryFinishes;
  await sync.request();
  // request resolves after transport+commit. Observe the real detached processor without replacing it.
  await vi.waitFor(() => expect(recoveryFinishes).toBeGreaterThan(before));
}

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
  recoveryFinishes = 0;
  vi.spyOn(database, "processPerformedRecovery").mockImplementation(async (...args) => {
    try {
      return await performRecovery(...args);
    } finally {
      recoveryFinishes += 1;
    }
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it("B1: a cold change survives close/open beyond its cursor and foreground GET recovers it without a write", async () => {
  await settled(
    new SyncCoordinator({
      transport: async () => response(),
      fetchSession: async () => {
        throw new TypeError("offline");
      },
    }),
  );
  expect(await sessionDb.sessions.count()).toBe(0);
  expect(await sessionDb.drafts.count()).toBe(0);
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe("cursor-after-record");
  expect((await markers()).length).toBe(1);
  sessionDb.close();
  await sessionDb.open();
  const fetch = vi.fn(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    return session();
  });
  const pull = vi.fn(async (body) => {
    expect(body.since).toBe("cursor-after-record");
    return response([]);
  });
  await settled(new SyncCoordinator({ transport: pull, fetchSession: fetch }));
  expect(fetch).toHaveBeenCalledExactlyOnceWith(SID);
  expectPrivateMatch((await loadDrafts(USER, SID))[SET], {
    completed: true,
    actual_weight: 72.5,
    client_id: SET,
  });
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(pull.mock.calls[0][0].mutations.length).toBe(0);
});

it("B2: mixed unknown UUID, normal change and exact ACK retain durable recovery while cursor advances; replay is idempotent", async () => {
  await mirrorSession(USER, SID, session());
  await commitDraft(USER, SID, localDraft(), "upsert");
  const lost = "30000000-0000-4000-8000-000000000099";
  const unknown = change(lost);
  delete unknown.session_id;
  const answer = response([change(SET), unknown]);
  answer.applied = [localDraft().client_id];
  const fetch = vi.fn();
  const sync = new SyncCoordinator({ transport: async () => answer, fetchSession: fetch });
  await settled(sync);
  expect((await loadDrafts(USER, SID))[SET]?.completed).toBe(true);
  expect((await loadDrafts(USER, SID))[OTHER]?.client_id).toBe(localDraft().client_id);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe(answer.next_cursor);
  const first = await markers();
  expect(first.length).toBe(1);
  expectPrivateEqual(JSON.parse(first[0].value), {
    entity_id: lost,
    session_id: null,
    status: "unresolved",
    server_seq: "1",
  });
  await settled(sync);
  expectPrivateEqual(await markers(), first);
  expect(await sessionDb.drafts.count()).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  const recovered = session();
  recovered.planned_sets.push({ ...recovered.planned_sets[0], id: lost, set_no: 3 });
  await readThroughSession(USER, SID, async () => recovered);
  expect((await loadDrafts(USER, SID))[lost]?.completed).toBe(true);
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe(answer.next_cursor);
});

it("old-server field absence is unresolved until a session-entry authority GET hydrates and atomically clears it", async () => {
  const legacy = change();
  delete legacy.session_id;
  await settled(
    new SyncCoordinator({
      transport: async () => response([legacy]),
      fetchSession: vi.fn(),
    }),
  );
  expectPrivateEqual(JSON.parse((await markers())[0].value), {
    entity_id: SET,
    session_id: null,
    status: "unresolved",
    server_seq: "1",
  });
  await readThroughSession(USER, SID, async () => session());
  expect((await loadDrafts(USER, SID))[SET]?.completed).toBe(true);
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("same-parent changes share one GET, keep health payload out of durable markers and recover delete data:null", async () => {
  const answer = response([change(), { ...change(OTHER), op: "delete", data: null }]);
  const fetched = session();
  fetched.planned_sets[1].performed_set = null;
  let storedKeys: string[][] = [];
  const fetch = vi.fn(async () => {
    // Check names before values so a privacy regression never prints health data in the log.
    storedKeys = (await markers()).map((row) => Object.keys(JSON.parse(row.value)).sort());
    expectPrivateEqual(
      (await markers()).map((row) => JSON.parse(row.value)),
      [
        { entity_id: SET, session_id: SID, status: "pending", server_seq: "1" },
        { entity_id: OTHER, session_id: SID, status: "pending", server_seq: "1" },
      ],
    );
    return fetched;
  });
  await settled(new SyncCoordinator({ transport: async () => answer, fetchSession: fetch }));
  expect(fetch).toHaveBeenCalledExactlyOnceWith(SID);
  expect(storedKeys).toEqual([
    ["entity_id", "server_seq", "session_id", "status"],
    ["entity_id", "server_seq", "session_id", "status"],
  ]);
  expect((await markers()).length).toBe(0);
  expect((await loadDrafts(USER, SID))[SET]?.completed).toBe(true);
  expect((await loadDrafts(USER, SID))[OTHER]).toBeUndefined();
});

it("marker and cursor roll back together when cursor persistence fails", async () => {
  const put = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
  vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((row) => {
    if (row.key === "cursor") throw new Error("cursor fault");
    return put(row);
  });
  const outcome = await new SyncCoordinator({
    transport: async () => response(),
    fetchSession: vi.fn(),
  })
    .request()
    .then(
      () => "resolved",
      (error: Error) => error.message,
    );
  expect(outcome).toBe("cursor fault");
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.syncMeta.get([USER, "cursor"])).toBeUndefined();
});

it("failed durable marker write keeps the previous cursor and ACK for replay on the next pull", async () => {
  await sessionDb.syncMeta.put({ user_id: USER, key: "cursor", value: "previous-cursor" });
  await commitDraft(USER, SID, localDraft(), "upsert");
  const answer = response();
  answer.applied = [localDraft().client_id];
  const put = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
  const spy = vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((row) => {
    if (row.key.startsWith(PREFIX)) throw new Error("marker quota");
    return put(row);
  });
  const pull = vi.fn(async (body) => {
    expect(body.since).toBe("previous-cursor");
    return answer;
  });
  // A resolved response can contain health values. Assert only the failure outcome.
  const outcome = await new SyncCoordinator({ transport: pull, fetchSession: vi.fn() })
    .request()
    .then(
      () => "resolved",
      (error: Error) => error.message,
    );
  expect(outcome).toBe("marker quota");
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe("previous-cursor");
  expect(await sessionDb.outbox.count()).toBe(1);
  spy.mockImplementation(put);
  await settled(new SyncCoordinator({ transport: pull, fetchSession: async () => session() }));
  expect(pull).toHaveBeenCalledTimes(2);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe(answer.next_cursor);
  expect((await loadDrafts(USER, SID))[SET]?.completed).toBe(true);
});

it("terminal parent 404 stays explicitly unresolved and does not stall other foreground pulls", async () => {
  const fetch = vi.fn(async () => {
    throw { status: 404 };
  });
  const sync = new SyncCoordinator({ transport: async () => response(), fetchSession: fetch });
  await settled(sync);
  await settled(sync);
  expectPrivateEqual(JSON.parse((await markers())[0].value), {
    entity_id: SET,
    session_id: SID,
    status: "unresolved",
    server_seq: "1",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe("cursor-after-record");
});

it("a pending uncheck made during recovery GET is never resurrected", async () => {
  await settled(
    new SyncCoordinator({
      transport: async () => response(),
      fetchSession: async () => {
        await commitDraft(USER, SID, localDraft(SET, false), "delete");
        return session();
      },
    }),
  );
  expectPrivateMatch((await loadDrafts(USER, SID))[SET], {
    completed: false,
    client_id: localDraft().client_id,
  });
  expect(await sessionDb.outbox.count()).toBe(1);
  expect((await sessionDb.outbox.toArray())[0].op).toBe("delete");
});

it("failed durable hydrate does not erase the recovery marker; next successful GET retries", async () => {
  const put = sessionDb.sessions.put.bind(sessionDb.sessions);
  vi.spyOn(sessionDb.sessions, "put").mockRejectedValueOnce(new Error("quota"));
  await settled(
    new SyncCoordinator({
      transport: async () => response(),
      fetchSession: async () => session(),
    }),
  );
  expect((await markers()).length).toBe(1);
  expect(await sessionDb.drafts.count()).toBe(0);
  vi.mocked(sessionDb.sessions.put).mockImplementation(put);
  await readThroughSession(USER, SID, async () => session());
  expect((await markers()).length).toBe(0);
  expect((await loadDrafts(USER, SID))[SET]?.completed).toBe(true);
});

it.each(["upsert", "delete"] as const)(
  "explicit null parent %s is terminal server absence, so it creates no recovery work",
  async (op) => {
    const fetch = vi.fn();
    await settled(
      new SyncCoordinator({
        transport: async () =>
          response([{ ...change(SET, null), op, data: op === "delete" ? null : actual }]),
        fetchSession: fetch,
      }),
    );
    expect((await markers()).length).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(await sessionDb.outbox.count()).toBe(0);
    expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe("cursor-after-record");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("explicit null parent releases previous known recovery work without manufacturing a projection", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("offline");
  });
  await settled(new SyncCoordinator({ transport: async () => response(), fetchSession: fetch }));
  expect((await markers()).length).toBe(1);
  fetch.mockClear();
  await settled(
    new SyncCoordinator({
      transport: async () => response([{ ...change(SET, null), op: "delete", data: null }]),
      fetchSession: fetch,
    }),
  );
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("explicit null cleanup preserves pending uncheck draft and delete outbox bytes, and replay is idempotent", async () => {
  await settled(
    new SyncCoordinator({
      transport: async () => response(),
      fetchSession: async () => {
        throw new TypeError("offline");
      },
    }),
  );
  await commitDraft(USER, SID, localDraft(SET, false), "delete");
  const drafts = await sessionDb.drafts.toArray();
  const outbox = await sessionDb.outbox.toArray();
  const answer = response([{ ...change(SET, null), op: "delete", data: null }]);
  const sync = new SyncCoordinator({ transport: async () => answer, fetchSession: vi.fn() });
  await settled(sync);
  expect((await markers()).length).toBe(0);
  expectPrivateEqual(await sessionDb.drafts.toArray(), drafts);
  expectPrivateEqual(await sessionDb.outbox.toArray(), outbox);
  await settled(sync);
  expect((await markers()).length).toBe(0);
  expectPrivateEqual(await sessionDb.drafts.toArray(), drafts);
  expectPrivateEqual(await sessionDb.outbox.toArray(), outbox);
});

it("a null-parent delete still marks an existing non-pending draft incomplete, as the original pull did", async () => {
  await commitDraft(USER, SID, localDraft(SET), null);
  await settled(
    new SyncCoordinator({
      transport: async () => response([{ ...change(SET, null), op: "delete", data: null }]),
      fetchSession: vi.fn(),
    }),
  );
  expect((await loadDrafts(USER, SID))[SET].completed).toBe(false);
  expect((await markers()).length).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
});
