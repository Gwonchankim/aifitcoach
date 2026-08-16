import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionDb } from "../components/session/session-db";
import { readThroughReadModel } from "../lib/read-model-cache";

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

afterEach(async () => {
  await sessionDb.delete();
});

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("M-4′ user-scoped read-model mirror", () => {
  it("persists a server snapshot and returns its real sync time when offline", async () => {
    const now = () => new Date("2026-08-16T12:00:00.000Z");
    await readThroughReadModel({
      userId: "user-a",
      kind: "dashboard",
      cacheKey: "dashboard",
      fetcher: () => Promise.resolve({ gate_state: "early", primary_e1rm: null }),
      now,
    });

    await expect(
      readThroughReadModel({
        userId: "user-a",
        kind: "dashboard",
        cacheKey: "dashboard",
        fetcher: offline,
      }),
    ).resolves.toEqual({
      data: { gate_state: "early", primary_e1rm: null },
      source: "mirror",
      stale: true,
      syncedAt: "2026-08-16T12:00:00.000Z",
    });
  });

  it("does not cross user scopes and does not hide non-transport failures", async () => {
    await readThroughReadModel({
      userId: "user-a",
      kind: "dashboard",
      cacheKey: "dashboard",
      fetcher: () => Promise.resolve({ owner: "a" }),
    });
    await expect(
      readThroughReadModel({
        userId: "user-b",
        kind: "dashboard",
        cacheKey: "dashboard",
        fetcher: offline,
      }),
    ).rejects.toThrow("Failed to fetch");
    await expect(
      readThroughReadModel({
        userId: "user-a",
        kind: "dashboard",
        cacheKey: "dashboard",
        fetcher: () => Promise.reject(new Error("HTTP 500")),
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("keeps only the eight most recently synced e1RM query snapshots", async () => {
    for (let index = 0; index < 10; index += 1) {
      await readThroughReadModel({
        userId: "user-a",
        kind: "e1rm",
        cacheKey: `e1rm:e-${index}`,
        fetcher: () => Promise.resolve({ index }),
        now: () => new Date(`2026-08-16T12:00:${String(index).padStart(2, "0")}.000Z`),
      });
    }

    const rows = await sessionDb.readModels
      .where("[user_id+kind]")
      .equals(["user-a", "e1rm"])
      .toArray();
    expect(rows.map((row) => row.cache_key).sort()).toEqual([
      "e1rm:e-2",
      "e1rm:e-3",
      "e1rm:e-4",
      "e1rm:e-5",
      "e1rm:e-6",
      "e1rm:e-7",
      "e1rm:e-8",
      "e1rm:e-9",
    ]);
  });

  it("does not let a late response from an older request overwrite a newer server snapshot", async () => {
    let releaseOlder!: (value: { version: string }) => void;
    const older = new Promise<{ version: string }>((resolve) => {
      releaseOlder = resolve;
    });
    const oldRequest = readThroughReadModel({
      userId: "user-a",
      kind: "dashboard",
      cacheKey: "dashboard",
      fetcher: () => older,
      now: () => new Date("2026-08-16T12:00:00.000Z"),
    });
    await readThroughReadModel({
      userId: "user-a",
      kind: "dashboard",
      cacheKey: "dashboard",
      fetcher: () => Promise.resolve({ version: "new" }),
      now: () => new Date("2026-08-16T12:00:01.000Z"),
    });
    releaseOlder({ version: "old" });
    await oldRequest;

    const cached = await readThroughReadModel({
      userId: "user-a",
      kind: "dashboard",
      cacheKey: "dashboard",
      fetcher: offline,
    });
    expect(cached.data).toEqual({ version: "new" });
  });
});
