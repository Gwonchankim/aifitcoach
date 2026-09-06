import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  sessionDb,
  DEV_USER_SCOPE as USER,
  cleanupSessionCache,
} from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import { useSessionLog } from "../components/session/session-store";
import {
  parsePosition,
  readPosition,
  savePosition,
  positionKey,
  clearPositionInTransaction,
  resolveSessionPosition,
} from "../components/session/session-position";
import {
  readRestoreSnapshot,
  saveRestTimer,
  loadRestTimer,
} from "../components/session/rest-timer-store";
import type { PlannedSet, Session, SyncResponse } from "../lib/api";

const p = { exercise_id: "bench", planned_set_id: "local", expanded: true };
const row = (id: string, exercise = "bench", performed = false) =>
  ({
    id,
    exercise_id: exercise,
    set_no: 1,
    load_kind: "external",
    performed_set: performed ? {} : null,
  }) as PlannedSet;
const response = {
  applied: ["routine-write"],
  conflicts: [],
  changes: [],
  next_cursor: "next",
  planned_set_mappings: [
    { correlation_id: "local", planned_set_id: "server", planned_set: row("server") },
  ],
} as SyncResponse;
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: async () => null };
});
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
});
afterEach(async () => {
  await sessionDb.delete();
});
async function seed() {
  await savePosition(USER, "A", p, 0);
  await sessionDb.sessions.put({
    user_id: USER,
    session_id: "A",
    session: { id: "A", status: "in_progress", planned_sets: [row("local")] },
    updated_at: "now",
  });
  await sessionDb.outbox.put({
    user_id: USER,
    client_id: "routine-write",
    entity: "session_routine",
    entity_id: "A",
    op: "upsert",
    updated_at: "now",
    payload: {},
    attempts: 0,
  });
  await sessionDb.drafts.put({
    user_id: USER,
    session_id: "A",
    planned_set_id: "local",
    actual_weight: 73,
    actual_reps: 8,
    actual_rir: 1,
    actual_time_sec: null,
    pain_score: null,
    completed: true,
    client_id: "actual-client",
    updated_at: "now",
  });
  await saveRestTimer(USER, "A", "local", "rest", { totalSec: 90, endsAt: Date.now() + 60000 });
}
const sync = (fail = false) =>
  new SyncCoordinator({
    transport: async () => response,
    duringMappingCommit: () => {
      if (fail) throw new Error("rollback");
    },
  }).request();

it.each([
  undefined,
  "{",
  JSON.stringify({ v: 2 }),
  JSON.stringify({ v: 1, session_id: "B", generation: 0, position: p }),
  JSON.stringify({ v: 1, session_id: "A", generation: -1, position: p }),
  JSON.stringify({ v: 1, session_id: "A", generation: 0, position: { ...p, expanded: "yes" } }),
])("rejects malformed/cross-session record %s", (raw) => {
  expect(parsePosition(raw, "A")).toBeNull();
});
it("resolves membership then same exercise / next exercise / summary without rebinding old expanded identity", () => {
  const ordered = [row("a", "other"), row("b"), row("c")];
  expect(resolveSessionPosition(p, ordered, new Map())).toEqual({
    ...p,
    planned_set_id: "b",
    expanded: false,
  });
  expect(
    resolveSessionPosition(
      p,
      ordered,
      new Map([
        ["b", true],
        ["c", true],
      ]),
    )?.planned_set_id,
  ).toBe("a");
  expect(resolveSessionPosition(p, ordered, new Map(ordered.map((s) => [s.id, true])))).toBeNull();
  expect(
    resolveSessionPosition({ ...p, planned_set_id: "b" }, ordered, new Map([["b", true]]))
      ?.expanded,
  ).toBe(true);
});
it.each([
  { wire: false, local: undefined, complete: false },
  { wire: true, local: undefined, complete: true },
  { wire: false, local: false, complete: false },
  { wire: true, local: false, complete: false },
  { wire: false, local: true, complete: true },
  { wire: true, local: true, complete: true },
])(
  "uses explicit completion facts for expanded and fallback: wire=$wire local=$local",
  ({ wire, local, complete }) => {
    const target: PlannedSet = {
      ...row("target"),
      performed_set: {
        actual_weight: 60,
        actual_reps: 8,
        actual_rir: 2,
        actual_time_sec: null,
        completed: wire,
        performed_at: "2026-08-14T08:00:00.000Z",
      },
    };
    const completed = new Map<string, boolean>(local === undefined ? [] : [[target.id, local]]);
    // A present performed_set with completed:false is still an input row, not an expanded completed row.
    expect(
      resolveSessionPosition({ ...p, planned_set_id: target.id }, [target], completed),
    ).toEqual({ ...p, planned_set_id: target.id, expanded: complete });
    expect(
      resolveSessionPosition(
        { ...p, planned_set_id: target.id, expanded: false },
        [target],
        completed,
      )?.expanded,
    ).toBe(false);
    const other = row("other-first", "other-exercise");
    // Same-exercise incomplete has priority even when another exercise occurs earlier in the session.
    expect(resolveSessionPosition(p, [other, target], completed)).toEqual(
      complete
        ? { exercise_id: other.exercise_id, planned_set_id: other.id, expanded: false }
        : { ...p, planned_set_id: target.id, expanded: false },
    );
    // With no matching exercise, whole-session fallback uses the same explicit completion predicate.
    expect(
      resolveSessionPosition({ ...p, exercise_id: "removed-exercise" }, [target, other], completed)
        ?.planned_set_id,
    ).toBe(complete ? other.id : target.id);
    // Summary is the fallback only when no incomplete member remains.
    expect(resolveSessionPosition(p, [target], completed)).toEqual(
      complete ? null : { ...p, planned_set_id: target.id, expanded: false },
    );
  },
);
it("ACK atomically promotes position/draft/timer; failed ACK restores every byte then retry converges", async () => {
  await seed();
  const snapshot = async () =>
    JSON.stringify([
      await sessionDb.syncMeta.toArray(),
      await sessionDb.drafts.toArray(),
      await sessionDb.outbox.toArray(),
      await sessionDb.sessions.toArray(),
    ]);
  const before = await snapshot();
  await expect(sync(true)).rejects.toThrow("rollback");
  expect(await snapshot()).toBe(before);
  await sync();
  expect((await readPosition(USER, "A")).position).toEqual({ ...p, planned_set_id: "server" });
  expect((await sessionDb.drafts.toArray())[0]).toMatchObject({
    planned_set_id: "server",
    actual_weight: 73,
    client_id: "actual-client",
  });
  expect((await loadRestTimer(USER, "A", Date.now()))?.plannedSetId).toBe("server");
  expect(await sessionDb.outbox.count()).toBe(0);
  await savePosition(USER, "A", p, 0);
  expect((await readPosition(USER, "A")).position?.planned_set_id).toBe("server");
});
it("late actual write uses the canonical key in durable storage AND Zustand, without reviving provisional memory", async () => {
  await seed();
  await sync();
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("local", { weight: 81, reps: 7, rir: 2, timeSec: null });
  expect(useSessionLog.getState().drafts.local).toBeUndefined();
  const draft = useSessionLog.getState().drafts.server;
  expect(draft).toMatchObject({ planned_set_id: "server", actual_weight: 81, completed: true });
  expect(await sessionDb.drafts.get([USER, "A", "server"])).toEqual({
    ...draft,
    user_id: USER,
    session_id: "A",
  });
  expect(await sessionDb.drafts.get([USER, "A", "local"])).toBeUndefined();
  await useSessionLog.getState().uncompleteSet("local");
  expect(useSessionLog.getState().drafts.server).toMatchObject({
    actual_weight: 81,
    completed: false,
  });
  expect(
    (await sessionDb.outbox.toArray()).some(
      (mutation) => mutation.entity_id === "server" && mutation.op === "delete",
    ),
  ).toBe(true);
});
it("two connections serialize clear against a stale generation; new explicit edit may write but other scopes never alias", async () => {
  await seed();
  await sync();
  const other = new Dexie(sessionDb.name);
  await other.open();
  try {
    await sessionDb.transaction("rw", sessionDb.syncMeta, () =>
      clearPositionInTransaction(USER, "A"),
    );
    expect(await savePosition(USER, "A", p, 0)).toBeNull();
    expect(
      JSON.parse((await other.table("syncMeta").get([USER, positionKey("A")])).value).position,
    ).toBeNull();
    await savePosition(USER, "A", p, 1);
    await savePosition(USER, "B", p, 0);
    await savePosition("other-owner", "A", p, 0);
    expect((await readPosition(USER, "A")).position?.planned_set_id).toBe("server");
    expect((await readPosition(USER, "B")).position?.planned_set_id).toBe("local");
    expect((await readPosition("other-owner", "A")).position?.planned_set_id).toBe("local");
  } finally {
    other.close();
  }
});
it("removed membership rejects a timer even when its completed draft remains; terminal cleanup clears only position intent", async () => {
  await seed();
  const before = await sessionDb.drafts.toArray();
  expect(
    await readRestoreSnapshot(
      USER,
      "A",
      { status: "in_progress", planned_sets: [row("different")] } as Session,
      Date.now(),
    ),
  ).toEqual({ kind: "none" });
  expect(await loadRestTimer(USER, "A", Date.now())).toBeNull();
  await cleanupSessionCache(USER, "A");
  expect((await readPosition(USER, "A")).position).toBeNull();
  expect(await sessionDb.drafts.toArray()).toEqual(before);
  expect(await sessionDb.outbox.count()).toBe(1);
});

it("an actual second module/connection writes during a held ACK transaction and resolves its alias after commit", async () => {
  await seed();
  vi.resetModules();
  const second = await import("../components/session/session-position");
  const { sessionDb: secondDb } = await import("../components/session/session-db");
  await secondDb.open();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const ack = new SyncCoordinator({
      transport: async () => response,
      duringMappingCommit: async () => {
        entered();
        await Dexie.waitFor(held);
      },
    }).request();
    await started;
    const late = Dexie.ignoreTransaction(() => second.savePosition(USER, "A", p, 0));
    release();
    await Promise.all([
      ack.catch((error: unknown) => {
        throw new Error("held ACK failed", { cause: error });
      }),
      late.catch((error: unknown) => {
        throw new Error("second connection save failed", { cause: error });
      }),
    ]);
    expect(
      (await Dexie.ignoreTransaction(() => second.readPosition(USER, "A"))).position
        ?.planned_set_id,
    ).toBe("server");
    await Dexie.ignoreTransaction(() => sync());
    expect((await Dexie.ignoreTransaction(() => readPosition(USER, "A"))).position).toEqual({
      ...p,
      planned_set_id: "server",
    });
  } finally {
    release();
    secondDb.close();
  }
});
