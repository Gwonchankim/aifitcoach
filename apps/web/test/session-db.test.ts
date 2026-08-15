import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitDraft,
  commitDraftBatch,
  commitRoutineSnapshot,
  commitSessionCompletion,
  DEV_USER_SCOPE,
  loadDrafts,
  mirrorSession,
  readMirroredSession,
  readThroughSession,
  sessionDb,
} from "../components/session/session-db";
import type { Exercise } from "../lib/api";

const draft = (client_id = "00000000-0000-4000-8000-000000000001") => ({
  planned_set_id: "set-1",
  actual_weight: 60,
  actual_reps: 8,
  actual_rir: 2,
  actual_time_sec: null,
  pain_score: null,
  completed: true,
  client_id,
  updated_at: "2026-08-15T00:00:00.000Z",
});

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("Dexie local mirror and outbox", () => {
  it("persists drafts across a reload-like read", async () => {
    await commitDraft(DEV_USER_SCOPE, "s-1", draft(), "upsert");
    expect((await loadDrafts(DEV_USER_SCOPE, "s-1"))["set-1"].actual_weight).toBe(60);
  });

  it("commits the local entity and outbox mutation atomically", async () => {
    await commitDraft(DEV_USER_SCOPE, "s-1", draft(), "upsert");
    expect(await sessionDb.drafts.count()).toBe(1);
    expect((await sessionDb.outbox.toArray())[0]).toMatchObject({
      entity: "performed_set",
      op: "upsert",
      entity_id: "set-1",
    });
  });

  it("omits an unentered RIR from the wire payload instead of conflating it with zero", async () => {
    await commitDraft(DEV_USER_SCOPE, "s-1", { ...draft(), actual_rir: null }, "upsert");
    const payload = (await sessionDb.outbox.toArray())[0].payload;
    expect(payload).not.toHaveProperty("actual_rir");
    await sessionDb.outbox.clear();
    await commitDraft(
      DEV_USER_SCOPE,
      "s-1",
      { ...draft("00000000-0000-4000-8000-000000000002"), actual_rir: 0 },
      "upsert",
    );
    expect((await sessionDb.outbox.toArray())[0].payload).toHaveProperty("actual_rir", 0);
  });

  it("does not leave an outbox row when the entity write fails", async () => {
    vi.spyOn(sessionDb.drafts, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(commitDraft(DEV_USER_SCOPE, "s-1", draft(), "upsert")).rejects.toThrow(
      "disk full",
    );
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(await sessionDb.outbox.count()).toBe(0);
  });

  it("rolls back every draft in a multi-set action when its outbox write fails", async () => {
    vi.spyOn(sessionDb.outbox, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      commitDraftBatch(DEV_USER_SCOPE, "s-1", [
        { draft: { ...draft(), planned_set_id: "set-1", completed: false }, op: null },
        { draft: { ...draft(), planned_set_id: "set-2" }, op: "upsert" },
      ]),
    ).rejects.toThrow("disk full");
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(await sessionDb.outbox.count()).toBe(0);
  });

  it("uses a new client id for a later edit and preserves each mutation for retry", async () => {
    await commitDraft(
      DEV_USER_SCOPE,
      "s-1",
      draft("00000000-0000-4000-8000-000000000001"),
      "upsert",
    );
    await commitDraft(
      DEV_USER_SCOPE,
      "s-1",
      draft("00000000-0000-4000-8000-000000000002"),
      "upsert",
    );
    expect((await sessionDb.outbox.toArray()).map((row) => row.client_id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("writes a newer delete tombstone on uncomplete", async () => {
    await commitDraft(
      DEV_USER_SCOPE,
      "s-1",
      { ...draft(), completed: false, client_id: "00000000-0000-4000-8000-000000000003" },
      "delete",
    );
    expect((await sessionDb.outbox.get("00000000-0000-4000-8000-000000000003"))?.op).toBe("delete");
  });

  it("isolates users and sessions", async () => {
    await commitDraft("user-a", "s-1", draft(), "upsert");
    await commitDraft("user-b", "s-1", { ...draft(), actual_weight: 80 }, "upsert");
    await commitDraft("user-a", "s-2", { ...draft(), actual_weight: 90 }, "upsert");
    expect((await loadDrafts("user-a", "s-1"))["set-1"].actual_weight).toBe(60);
    expect((await loadDrafts("user-b", "s-1"))["set-1"].actual_weight).toBe(80);
  });

  it("uses the session mirror as an offline read fallback", async () => {
    await mirrorSession(DEV_USER_SCOPE, "s-1", { id: "s-1", status: "active" });
    await expect(
      readThroughSession(DEV_USER_SCOPE, "s-1", () => Promise.reject(new Error("offline"))),
    ).resolves.toEqual({
      id: "s-1",
      status: "active",
    });
  });

  it("uses the user-scoped exercise catalog mirror as an offline read fallback", async () => {
    const catalog = [{ id: "e-1", name_ko: "오프라인 운동" }] as Exercise[];
    const { mirrorCatalog, readThroughCatalog } = await import("../components/session/session-db");
    await mirrorCatalog(DEV_USER_SCOPE, catalog);
    await expect(
      readThroughCatalog(DEV_USER_SCOPE, () => Promise.reject(new Error("offline"))),
    ).resolves.toEqual(catalog);
  });

  it("does not discard a successful online read when only the mirror write fails", async () => {
    vi.spyOn(sessionDb.sessions, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      readThroughSession(DEV_USER_SCOPE, "s-1", () =>
        Promise.resolve({ id: "s-1", status: "active" }),
      ),
    ).resolves.toEqual({ id: "s-1", status: "active" });
  });

  it("commits a routine snapshot and outbox mutation together", async () => {
    await commitRoutineSnapshot(
      DEV_USER_SCOPE,
      "s-1",
      ["exercise-2", "exercise-1"],
      "00000000-0000-4000-8000-000000000010",
      "2026-08-15T00:01:00.000Z",
    );
    await expect(sessionDb.routines.get([DEV_USER_SCOPE, "s-1"])).resolves.toMatchObject({
      exercise_ids: ["exercise-2", "exercise-1"],
    });
    await expect(
      sessionDb.outbox.get("00000000-0000-4000-8000-000000000010"),
    ).resolves.toMatchObject({ entity: "session_routine", entity_id: "s-1" });
  });

  it("commits session completion mirror state and outbox together", async () => {
    await mirrorSession(DEV_USER_SCOPE, "s-1", { id: "s-1", status: "active" });
    await commitSessionCompletion(
      DEV_USER_SCOPE,
      "s-1",
      { pain: 2 },
      "00000000-0000-4000-8000-000000000011",
      "2026-08-15T00:02:00.000Z",
    );
    await expect(readMirroredSession(DEV_USER_SCOPE, "s-1")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      sessionDb.outbox.get("00000000-0000-4000-8000-000000000011"),
    ).resolves.toMatchObject({
      entity: "session",
      payload: { pain: 2, status: "completed" },
    });
  });
});
