import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, SyncRequest, SyncResponse } from "../lib/api";
import {
  commitDraft,
  DEV_USER_SCOPE,
  PERFORMED_RECOVERY_PREFIX,
  sessionDb,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import * as database from "../components/session/session-db";

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
async function recovered() {
  await vi.waitFor(async () => {
    expect(
      (await sessionDb.syncMeta.toArray()).filter((row) =>
        row.key.startsWith(PERFORMED_RECOVERY_PREFIX),
      ).length,
    ).toBe(0);
  });
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
    await recovered();
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
    await recovered();
  }
});

it("joiners share one recovery GET and a later marker for the same parent survives the older read", async () => {
  const laterSet = "30000000-0000-4000-8000-000000000003";
  const entered = latch<void>(),
    firstRead = latch<Session>(),
    nextRead = latch<Session>();
  const fetches: string[] = [];
  let sends = 0,
    active = 0,
    maximum = 0;
  const sync = new SyncCoordinator({
    clock: { now: () => 0 },
    transport: async (body) => {
      sends += 1;
      const response = answer(body, sends === 1);
      if (sends === 2)
        response.changes = [
          {
            entity: "performed_set",
            entity_id: laterSet,
            session_id: SID,
            op: "upsert",
            server_seq: "2",
            data: actual,
          },
        ];
      return response;
    },
    fetchSession: async (id) => {
      fetches.push(id);
      active += 1;
      maximum = Math.max(maximum, active);
      entered.resolve();
      try {
        return await (fetches.length === 1 ? firstRead.promise : nextRead.promise);
      } finally {
        active -= 1;
      }
    },
  });
  const first = sync.request();
  await entered.promise;
  try {
    await sync.request(true);
    // The original GET is still held while another transport+commit has created this marker.
    expect(active).toBe(1);
    expect(fetches.length).toBe(1);
    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + laterSet]),
    ).toBeDefined();
    firstRead.resolve(authority()); // Older snapshot does not contain the later performed identity.
    await vi.waitFor(async () =>
      expect(
        await sessionDb.syncMeta.get([DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET]),
      ).toBeUndefined(),
    );
    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + laterSet]),
    ).toBeDefined();
    await vi.waitFor(() => expect(fetches.length).toBe(2));
    expect(maximum).toBe(1);
    expect(
      await sessionDb.syncMeta.get([DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + laterSet]),
    ).toBeDefined();
    const next = authority();
    next.planned_sets.push({ ...next.planned_sets[0], id: laterSet, set_no: 2 });
    nextRead.resolve(next);
    await recovered();
    expect(
      (await sessionDb.drafts.where("planned_set_id").equals(laterSet).first())?.completed,
    ).toBe(true);
    expect(await sessionDb.outbox.count()).toBe(0);
  } finally {
    firstRead.resolve(authority());
    nextRead.resolve(authority());
    await first;
    await recovered();
  }
});

it("a recovered identity is cleared even when only its marker status changes during the GET", async () => {
  const entered = latch<void>(),
    read = latch<Session>();
  const sync = new SyncCoordinator({
    clock: { now: () => 0 },
    transport: async (body) => answer(body, true),
    fetchSession: async () => {
      entered.resolve();
      return read.promise;
    },
  });
  const first = sync.request();
  await entered.promise;
  const key: [string, string] = [DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET];
  try {
    const marker = await sessionDb.syncMeta.get(key);
    expect(Boolean(marker)).toBe(true);
    const identity = JSON.parse(marker!.value);
    expect(identity.status).toBe("pending");
    // Status-only transition, preserving the exact entity and parent of this successful read.
    await sessionDb.syncMeta.put({
      ...marker!,
      value: JSON.stringify({ ...identity, status: "unresolved" }),
    });
    read.resolve(authority());
    await vi.waitFor(async () => expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(false));
    expect((await sessionDb.drafts.where("planned_set_id").equals(SET).first())?.completed).toBe(
      true,
    );
  } finally {
    read.resolve(authority());
    await first;
  }
});

it("a later deferred change for the same identity advances the cursor without being cleared by an older GET", async () => {
  const deferred = vi.spyOn(database, "deferPerformedChange");
  const entered = latch<void>(),
    firstRead = latch<Session>(),
    nextRead = latch<Session>();
  let sends = 0,
    fetches = 0;
  const sync = new SyncCoordinator({
    clock: { now: () => 0 },
    transport: async (body) => {
      sends += 1;
      const response = answer(body, true);
      response.next_cursor = String(sends);
      response.changes[0].server_seq = String(sends);
      if (sends === 2) response.changes[0].data = { ...actual, actual_weight: 70 };
      return response;
    },
    fetchSession: async () => {
      fetches += 1;
      entered.resolve();
      return fetches === 1 ? firstRead.promise : nextRead.promise;
    },
  });
  const first = sync.request();
  await entered.promise;
  const key: [string, string] = [DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET];
  try {
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(deferred).toHaveBeenCalledTimes(1);
    await sync.request(true);
    expect(deferred).toHaveBeenCalledTimes(2);
    expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(true);
    expect(JSON.parse((await sessionDb.syncMeta.get(key))!.value).server_seq).toBe("2");
    expect(fetches).toBe(1);
    firstRead.resolve(authority());
    // Either the obsolete snapshot committed (the regression) or a fresh recovery has started.
    await vi.waitFor(async () =>
      expect((await sessionDb.drafts.count()) > 0 || fetches === 2).toBe(true),
    );
    expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(true);
    await vi.waitFor(() => expect(fetches).toBe(2));
    // The same held-read state proves preservation without creating a stale protected placeholder.
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    const next = authority();
    next.planned_sets[0].performed_set = { ...actual, actual_weight: 70 };
    nextRead.resolve(next);
    await recovered();
    expect(
      (await sessionDb.drafts.where("planned_set_id").equals(SET).first())?.actual_weight === 70,
    ).toBe(true);
  } finally {
    firstRead.resolve(authority());
    nextRead.resolve(authority());
    await first;
  }
});

it("an old-server unknown-parent change keeps its newer marker and rejects an obsolete entry GET", async () => {
  const deferred = vi.spyOn(database, "deferPerformedChange");
  const entered = latch<void>(),
    oldRead = latch<Session>();
  let sends = 0;
  const sync = new SyncCoordinator({
    clock: { now: () => 0 },
    transport: async (body) => {
      const response = answer(body, true);
      response.next_cursor = String(++sends);
      response.changes[0].server_seq = String(sends);
      delete response.changes[0].session_id;
      return response;
    },
    fetchSession: async () => {
      throw new Error("unknown parent must wait for an entry GET");
    },
  });
  const key: [string, string] = [DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET];
  await sync.request();
  expect(deferred).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await sessionDb.syncMeta.get(key))!.value)).toEqual({
    entity_id: SET,
    session_id: null,
    status: "unresolved",
    server_seq: "1",
  });
  const entry = database
    .readThroughSession(
      DEV_USER_SCOPE,
      SID,
      async () => {
        entered.resolve();
        return oldRead.promise;
      },
      { offlineFallback: false },
    )
    .then(
      () => "resolved",
      () => "rejected",
    );
  try {
    await entered.promise;
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    await sync.request(true);
    expect(deferred).toHaveBeenCalledTimes(2);
    expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
    expect(JSON.parse((await sessionDb.syncMeta.get(key))!.value)).toEqual({
      entity_id: SET,
      session_id: null,
      status: "unresolved",
      server_seq: "2",
    });
    oldRead.resolve(authority());
    const outcome = await entry;
    // Preservation, no obsolete placeholder, and the fresh recovery belong to this same state.
    expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(true);
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(outcome).toBe("rejected");
    const fresh = authority();
    fresh.planned_sets[0].performed_set = { ...actual, actual_weight: 70 };
    await database.readThroughSession(DEV_USER_SCOPE, SID, async () => fresh);
    expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(false);
    expect(
      (await sessionDb.drafts.where("planned_set_id").equals(SET).first())?.actual_weight === 70,
    ).toBe(true);
    expect(await sessionDb.outbox.count()).toBe(0);
  } finally {
    oldRead.resolve(authority());
    await entry;
  }
});

it("a held legacy marker survives its upgrade and the fresh GET creates the current projection", async () => {
  const key: [string, string] = [DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET];
  await sessionDb.syncMeta.put({
    user_id: DEV_USER_SCOPE,
    key: key[1],
    value: JSON.stringify({ entity_id: SET, session_id: SID, status: "pending" }),
  });
  const entered = latch<void>(),
    firstRead = latch<Session>(),
    nextRead = latch<Session>();
  let sends = 0,
    fetches = 0;
  const sync = new SyncCoordinator({
    transport: async (body) => answer(body, ++sends === 2),
    fetchSession: async () => {
      fetches += 1;
      entered.resolve();
      return fetches === 1 ? firstRead.promise : nextRead.promise;
    },
  });
  const first = sync.request();
  await entered.promise;
  try {
    expect(JSON.parse((await sessionDb.syncMeta.get(key))!.value).server_seq).toBeUndefined();
    await sync.request(true);
    expect(JSON.parse((await sessionDb.syncMeta.get(key))!.value).server_seq).toBe("1");
    firstRead.resolve(authority());
    await vi.waitFor(() => expect(fetches).toBe(2));
    expect(Boolean(await sessionDb.syncMeta.get(key))).toBe(true);
    expect(await sessionDb.sessions.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    const fresh = authority();
    fresh.planned_sets[0].performed_set = { ...actual, actual_weight: 70 };
    nextRead.resolve(fresh);
    await recovered();
    expect(
      (await sessionDb.drafts.where("planned_set_id").equals(SET).first())?.actual_weight === 70,
    ).toBe(true);
  } finally {
    firstRead.resolve(authority());
    nextRead.resolve(authority());
    await first;
  }
});

it("replayed or older sequence preserves unresolved work and a newer sequence reopens it exactly", async () => {
  const key: [string, string] = [DEV_USER_SCOPE, PERFORMED_RECOVERY_PREFIX + SET];
  const seq = "9007199254740993";
  await sessionDb.syncMeta.put({
    user_id: DEV_USER_SCOPE,
    key: key[1],
    value: JSON.stringify({
      entity_id: SET,
      session_id: SID,
      status: "unresolved",
      server_seq: seq,
    }),
  });
  const before = (await sessionDb.syncMeta.get(key))!.value;
  await database.deferPerformedChange(DEV_USER_SCOPE, SET, SID, seq);
  await database.deferPerformedChange(DEV_USER_SCOPE, SET, SID, "9007199254740992");
  expect((await sessionDb.syncMeta.get(key))!.value === before).toBe(true);
  await database.deferPerformedChange(DEV_USER_SCOPE, SET, SID, "9007199254740994");
  const current = JSON.parse((await sessionDb.syncMeta.get(key))!.value);
  expect(current.status).toBe("pending");
  expect(current.server_seq).toBe("9007199254740994");
  expect(Object.keys(current).sort()).toEqual(["entity_id", "server_seq", "session_id", "status"]);
});

it.each(["uncheck", "removed-draft", "latest-edit"] as const)(
  "a queued sync commit overlaps recovery hydration without replacing %s intent",
  async (kind) => {
    const readEntered = latch<void>(),
      read = latch<Session>();
    const syncReady = latch<void>(),
      allowSync = latch<void>();
    const hydrateHeld = latch<void>(),
      allowHydrate = latch<void>(),
      overlap = latch<void>();
    let sends = 0,
      hydrateActive = false,
      held = false;
    const put = sessionDb.sessions.put.bind(sessionDb.sessions);
    vi.spyOn(sessionDb.sessions, "put").mockImplementation((row) => {
      if (row.session_id !== SID || held) return put(row);
      held = true;
      hydrateActive = true;
      hydrateHeld.resolve();
      return Dexie.Promise.resolve(Dexie.waitFor(allowHydrate.promise))
        .then(() => put(row))
        .finally(() => {
          hydrateActive = false;
        });
    });
    const transact = sessionDb.transaction;
    vi.spyOn(sessionDb, "transaction").mockImplementation(((
      ...args: Parameters<typeof transact>
    ) => {
      const tables = args[1];
      if (Array.isArray(tables) && tables.length === 8 && hydrateActive) overlap.resolve();
      return Reflect.apply(transact, sessionDb, args);
    }) as typeof transact);
    const sync = new SyncCoordinator({
      transport: async (body) => {
        sends += 1;
        const response = answer(body, true);
        response.next_cursor = String(sends);
        response.changes[0].server_seq = String(sends);
        // The original user intent remains pending; this read/other pull does not acknowledge it.
        response.applied = [];
        return response;
      },
      beforeLocalCommit: async () => {
        if (sends === 2) {
          syncReady.resolve();
          await allowSync.promise;
        }
      },
      fetchSession: async () => {
        readEntered.resolve();
        return read.promise;
      },
    });
    const first = sync.request();
    await readEntered.promise;
    const intent = {
      planned_set_id: SET,
      ...actual,
      actual_weight: 99,
      pain_score: null,
      completed: kind === "latest-edit",
      client_id: CLIENT,
      updated_at: "2026-08-14T10:00:00.000Z",
    };
    await commitDraft(DEV_USER_SCOPE, SID, intent, kind === "latest-edit" ? "upsert" : "delete");
    if (kind === "removed-draft") await sessionDb.drafts.delete([DEV_USER_SCOPE, SID, SET]);
    const draftsBefore = JSON.stringify(await sessionDb.drafts.toArray());
    const pendingBefore = JSON.stringify(await sessionDb.outbox.toArray());
    const second = sync.request(true);
    await syncReady.promise;
    try {
      read.resolve(authority());
      await hydrateHeld.promise;
      allowSync.resolve();
      await overlap.promise;
      // A real sync transaction was requested while the authoritative transaction was held.
      // IndexedDB serializes the writes; both live commit operations are measured, not parallel writes.
      expect(hydrateActive).toBe(true);
      expect(sends).toBe(2);
      allowHydrate.resolve();
      await second;
      await recovered();
      expect(JSON.stringify(await sessionDb.drafts.toArray()) === draftsBefore).toBe(true);
      expect(JSON.stringify(await sessionDb.outbox.toArray()) === pendingBefore).toBe(true);
      expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
    } finally {
      read.resolve(authority());
      allowSync.resolve();
      allowHydrate.resolve();
      await Promise.all([first, second]);
    }
  },
);

it.each(["uncheck", "removed-draft", "latest-edit"] as const)(
  "recovery queues behind a held sync commit and preserves %s intent after that commit",
  async (kind) => {
    const entered = latch<void>(),
      read = latch<Session>();
    const syncHeld = latch<void>(),
      allowSync = latch<void>(),
      recoveryQueued = latch<void>();
    let sends = 0,
      held = false;
    const put = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((row) => {
      if (row.key !== "cursor" || row.value !== "2") return put(row);
      held = true;
      syncHeld.resolve();
      return Dexie.Promise.resolve(Dexie.waitFor(allowSync.promise))
        .then(() => put(row))
        .finally(() => {
          held = false;
        });
    });
    const get = sessionDb.syncMeta.get;
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementation(((...args: Parameters<typeof get>) => {
      const key = args[0];
      if (held && Array.isArray(key) && key[1] === "week-swap-epoch") recoveryQueued.resolve();
      return Reflect.apply(get, sessionDb.syncMeta, args);
    }) as typeof get);
    const sync = new SyncCoordinator({
      transport: async (body) => {
        sends += 1;
        const response = answer(body, true);
        response.next_cursor = String(sends);
        response.changes[0].server_seq = String(sends);
        response.applied = [];
        return response;
      },
      fetchSession: async () => {
        entered.resolve();
        return read.promise;
      },
    });
    const first = sync.request();
    await entered.promise;
    await commitDraft(
      DEV_USER_SCOPE,
      SID,
      {
        planned_set_id: SET,
        ...actual,
        actual_weight: 99,
        pain_score: null,
        completed: kind === "latest-edit",
        client_id: CLIENT,
        updated_at: "2026-08-14T10:00:00.000Z",
      },
      kind === "latest-edit" ? "upsert" : "delete",
    );
    if (kind === "removed-draft") await sessionDb.drafts.delete([DEV_USER_SCOPE, SID, SET]);
    const draftsBefore = JSON.stringify(await sessionDb.drafts.toArray());
    const pendingBefore = JSON.stringify(await sessionDb.outbox.toArray());
    const second = sync.request(true);
    await syncHeld.promise;
    try {
      read.resolve(authority());
      await recoveryQueued.promise;
      // The real recovery first queues its post-GET epoch read, before starting the hydrate tx.
      expect(held).toBe(true);
      expect(sends).toBe(2);
      allowSync.resolve();
      await second;
      await recovered();
      expect(JSON.stringify(await sessionDb.drafts.toArray()) === draftsBefore).toBe(true);
      expect(JSON.stringify(await sessionDb.outbox.toArray()) === pendingBefore).toBe(true);
      expect((await sessionDb.syncMeta.get([DEV_USER_SCOPE, "cursor"]))?.value).toBe("2");
    } finally {
      read.resolve(authority());
      allowSync.resolve();
      await Promise.all([first, second]);
    }
  },
);
