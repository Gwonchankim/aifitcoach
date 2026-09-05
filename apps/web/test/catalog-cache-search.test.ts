import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../docs/specs/exercises_seed.json";
import type { Exercise } from "../lib/api";
let sessionDb: typeof import("../components/session/session-db").sessionDb;
let DEV_USER_SCOPE: string;

const exercisesMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { exercises: exercisesMock } }));
let fetchAllExercises: typeof import("../components/session/exercise-catalog").fetchAllExercises;
let matchesExerciseSearch: typeof import("../components/session/exercise-catalog").matchesExerciseSearch;
const additions = [
  "e_low_row_machine",
  "e_high_row_machine",
  "e_incline_chest_press_machine",
  "e_assisted_dips",
];
const old106 = seed.exercises
  .filter((item) => !additions.includes(item.id))
  .map((item) => ({
    id: item.id,
    name_ko: item.name_ko,
    name_en: item.name_en,
    primary_muscles: item.primary_muscles,
    movement_pattern: item.movement_pattern,
    equipment: item.equipment,
    difficulty: item.difficulty,
    mechanic: item.mechanic,
    region: item.region,
    metric: item.metric,
    step_kg: item.default_step_kg,
    default_time_low_sec: "default_time_low_sec" in item ? item.default_time_low_sec : null,
    default_time_high_sec: "default_time_high_sec" in item ? item.default_time_high_sec : null,
    substitutions: item.substitutions,
    media_url: item.media.image_url,
  })) as Exercise[];
const new4: Exercise[] = [
  ["e_low_row_machine", "로우 로우 머신", "Low Row Machine"],
  ["e_high_row_machine", "하이 로우 머신", "High Row Machine"],
  ["e_incline_chest_press_machine", "머신 인클라인 벤치프레스", "Incline Chest Press Machine"],
  ["e_assisted_dips", "어시스트 딥스 머신", "Assisted Dip Machine"],
].map(([id, name_ko, name_en]) => ({ ...old106[0], id, name_ko, name_en, equipment: "machine" }));
const full110 = [...old106, ...new4];
const stamp = "2026-08-14T00:00:00.000Z";

beforeEach(async () => {
  // Every test owns a fresh in-memory factory. No existing browser database is opened or deleted.
  vi.resetModules();
  Dexie.dependencies.indexedDB = new IDBFactory();
  ({ sessionDb, DEV_USER_SCOPE } = await import("../components/session/session-db"));
  ({ fetchAllExercises, matchesExerciseSearch } =
    await import("../components/session/exercise-catalog"));
  await sessionDb.open();
  exercisesMock.mockReset();
  const common = { user_id: DEV_USER_SCOPE, session_id: "session-search", updated_at: stamp };
  await sessionDb.sessions.put({ ...common, session: { id: "session-search", planned_sets: [] } });
  await sessionDb.routines.put({
    ...common,
    exercise_ids: ["e_machine_row"],
    correlations: [
      {
        correlation_id: "correlation-search",
        exercise_id: "e_machine_row",
        set_no: 1,
        planned_set_id: "set-search",
      },
    ],
  });
  await sessionDb.drafts.put({
    ...common,
    planned_set_id: "set-search",
    actual_weight: 41,
    actual_reps: 9,
    actual_rir: 2,
    actual_time_sec: null,
    pain_score: null,
    client_id: "draft-search",
    completed: false,
  });
  await sessionDb.outbox.put({
    user_id: DEV_USER_SCOPE,
    client_id: "outbox-search",
    entity: "performed_set",
    entity_id: "set-search",
    op: "upsert",
    updated_at: stamp,
    payload: { reps: 9 },
    attempts: 0,
  });
});
afterEach(() => sessionDb.close());
const snapshot = async () =>
  Promise.all([
    sessionDb.drafts.toArray(),
    sessionDb.outbox.toArray(),
    sessionDb.sessions.toArray(),
    sessionDb.routines.toArray(),
  ]);
const cache = () => sessionDb.catalogs.get(DEV_USER_SCOPE);
const warm = (catalog = old106) =>
  sessionDb.catalogs.put({ user_id: DEV_USER_SCOPE, catalog, updated_at: stamp });
function pages(catalog = full110, failPage = -1) {
  exercisesMock.mockReset();
  for (let start = 0; start < catalog.length; start += 20) {
    if (start / 20 === failPage) {
      exercisesMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      break;
    }
    exercisesMock.mockResolvedValueOnce({
      items: catalog.slice(start, start + 20),
      next_cursor: start + 20 < catalog.length ? catalog[start + 19].id : null,
    });
  }
}
function assertSearch6(catalog: Exercise[]) {
  for (const item of new4)
    expect(
      catalog.filter((row) => matchesExerciseSearch(row, item.name_ko)).map((row) => row.id),
    ).toEqual(
      item.id === "e_incline_chest_press_machine"
        ? ["e_smith_incline_bench_press", item.id]
        : [item.id],
    );
  expect(
    catalog.filter((row) => matchesExerciseSearch(row, "머신 벤치 프레스")).map((row) => row.id),
  ).toEqual(["e_chest_press_machine", "e_smith_bench_press"]);
  expect(
    catalog.filter((row) => matchesExerciseSearch(row, "시티드 머신 로우")).map((row) => row.id),
  ).toEqual(["e_machine_row"]);
}

describe("M3 complete catalog read-through with real IndexedDB", () => {
  it("keeps the old cache until the final page arrives and preserves it when the cache write fails", async () => {
    await warm();
    const before = await snapshot();
    const cached = await cache();
    let release!: (value: { items: Exercise[]; next_cursor: null }) => void;
    const lastPage = new Promise<{ items: Exercise[]; next_cursor: null }>((resolve) => {
      release = resolve;
    });
    for (let start = 0; start < 100; start += 20)
      exercisesMock.mockResolvedValueOnce({
        items: full110.slice(start, start + 20),
        next_cursor: full110[start + 19].id,
      });
    exercisesMock.mockReturnValueOnce(lastPage);
    const result = fetchAllExercises();
    await vi.waitFor(() => expect(exercisesMock).toHaveBeenCalledTimes(6));
    expect(await cache()).toEqual(cached);
    const write = vi
      .spyOn(sessionDb.catalogs, "put")
      .mockRejectedValueOnce(new Error("quota exceeded"));
    release({ items: full110.slice(100), next_cursor: null });
    expect(await result).toEqual(full110);
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
    expect(await cache()).toEqual(cached);
    expect(await snapshot()).toEqual(before);
  });
  it("cold offline rejects without a fake catalog and preserves all local records", async () => {
    const before = await snapshot();
    exercisesMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchAllExercises()).rejects.toThrow("Failed to fetch");
    expect(await cache()).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
  it("warm110 offline and reopen searches six canonical IDs without changing timestamp or local records", async () => {
    await warm(full110);
    const before = await snapshot();
    const cached = await cache();
    sessionDb.close();
    await sessionDb.open();
    exercisesMock.mockRejectedValue(new TypeError("Failed to fetch"));
    assertSearch6(await fetchAllExercises());
    expect(await cache()).toEqual(cached);
    expect(await snapshot()).toEqual(before);
  });
  it("old106 offline searches aliases but cannot invent the four new exercises", async () => {
    expect(old106).toHaveLength(106);
    await warm();
    const before = await snapshot();
    exercisesMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await fetchAllExercises();
    expect(result).toEqual(old106);
    for (const item of new4)
      expect(
        result.filter((row) => matchesExerciseSearch(row, item.name_ko)).map((row) => row.id),
      ).toEqual(item.id === "e_incline_chest_press_machine" ? ["e_smith_incline_bench_press"] : []);
    expect(
      result.filter((row) => matchesExerciseSearch(row, "시티드 머신 로우")).map((row) => row.id),
    ).toEqual(["e_machine_row"]);
    expect(await snapshot()).toEqual(before);
  });
  it("updates 106→109→110 only on complete fetches with baseline objects exact-preserved", async () => {
    await warm();
    const before = await snapshot();
    for (const expected of [full110.slice(0, 109), full110]) {
      const write = vi.spyOn(sessionDb.catalogs, "put");
      pages(expected);
      expect(await fetchAllExercises()).toEqual(expected);
      expect(write).toHaveBeenCalledTimes(1);
      write.mockRestore();
      expect((await cache())?.catalog).toEqual(expected);
      expect((await cache())?.catalog.slice(0, 106)).toEqual(old106);
      expect(exercisesMock).toHaveBeenCalledTimes(6);
      expect(exercisesMock).toHaveBeenNthCalledWith(2, { cursor: expected[19].id });
      expect(new Set((await cache())?.catalog.map((item) => item.id)).size).toBe(expected.length);
    }
    assertSearch6((await cache())!.catalog);
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])(
    "mid-page failure preserves cache exactly (warm=%s), then complete retry converges",
    async (isWarm) => {
      if (isWarm) await warm();
      const before = await snapshot();
      const cached = await cache();
      pages(full110, 2);
      if (isWarm) expect(await fetchAllExercises()).toEqual(old106);
      else await expect(fetchAllExercises()).rejects.toThrow("Failed to fetch");
      expect(exercisesMock).toHaveBeenCalledTimes(3);
      expect(await cache()).toEqual(cached);
      expect(await snapshot()).toEqual(before);
      pages();
      assertSearch6(await fetchAllExercises());
      expect((await cache())?.catalog).toEqual(full110);
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(["repeated cursor", "duplicate ID", "page limit"])(
    "never commits partial data after %s",
    async (kind) => {
      await warm();
      const cached = await cache();
      const before = await snapshot();
      if (kind === "repeated cursor") {
        exercisesMock
          .mockResolvedValueOnce({ items: [new4[0]], next_cursor: "loop" })
          .mockResolvedValue({ items: [new4[1]], next_cursor: "loop" });
      } else if (kind === "duplicate ID") {
        exercisesMock
          .mockResolvedValueOnce({ items: [new4[0]], next_cursor: "next" })
          .mockResolvedValueOnce({ items: [new4[0]], next_cursor: null });
      } else {
        for (let index = 0; index < 20; index += 1)
          exercisesMock.mockResolvedValueOnce({
            items: [{ ...new4[0], id: `page-${index}` }],
            next_cursor: `cursor-${index}`,
          });
      }
      expect(await fetchAllExercises()).toEqual(old106);
      expect(await cache()).toEqual(cached);
      expect(await snapshot()).toEqual(before);
    },
  );
});
