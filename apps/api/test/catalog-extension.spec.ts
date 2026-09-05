import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const baselineBytes = readFileSync(path.join(__dirname, "support/catalog-baseline-106.fixture"));
const baseline = JSON.parse(baselineBytes.toString()) as { exercises: { id: string }[] };
const current = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../docs/specs/exercises_seed.json"), "utf8"),
) as { exercises: { id: string; substitutions: string[] }[] };

import { CATALOG_ADDITION_IDS, CURRENT_CATALOG } from "./support/catalog-extension";

describe("Sprint02 machine catalog contract", () => {
  it("preserves all 106 baseline objects from f8627cb byte-pinned fixture", () => {
    expect(createHash("sha256").update(baselineBytes).digest("hex")).toBe(
      "6783bac18d97661e1323437d21e2a627cd84100087a1736479994cdb3d259c55",
    );
    expect(baseline.exercises).toHaveLength(106);
    expect(current.exercises.filter((row) => !CATALOG_ADDITION_IDS.includes(row.id))).toEqual(
      baseline.exercises,
    );
  });

  it("adds exactly the four agreed canonical additions (106 → 110)", () => {
    expect(current.exercises).toHaveLength(110);
    const oldIds = new Set(baseline.exercises.map((row) => row.id));
    expect(
      current.exercises
        .filter((row) => !oldIds.has(row.id))
        .map((row) => row.id)
        .sort(),
    ).toEqual([...CATALOG_ADDITION_IDS].sort());
    expect(new Set(current.exercises.map((row) => row.id)).size).toBe(110);
  });

  it.each([
    [
      "e_low_row_machine",
      "로우 로우 머신",
      "Low Row Machine",
      "horizontal_pull",
      ["lats", "upper_back"],
      ["biceps"],
      15,
      ["e_machine_row", "e_seated_cable_row"],
    ],
    [
      "e_high_row_machine",
      "하이 로우 머신",
      "High Row Machine",
      "horizontal_pull",
      ["upper_back", "lats"],
      ["biceps", "rear_delts"],
      15,
      ["e_machine_row", "e_chest_supported_row"],
    ],
    [
      "e_incline_chest_press_machine",
      "머신 인클라인 벤치프레스",
      "Incline Chest Press Machine",
      "horizontal_push",
      ["chest", "front_delts"],
      ["triceps"],
      12,
      ["e_incline_db_press", "e_smith_incline_bench_press"],
    ],
  ])(
    "%s has the agreed canonical metadata",
    (id, ko, en, pattern, primary, secondary, high, substitutions) => {
      expect(CURRENT_CATALOG.find((row) => row.id === id)).toMatchObject({
        id,
        nameKo: ko,
        nameEn: en,
        movementPattern: pattern,
        primaryMuscles: primary,
        secondaryMuscles: secondary,
        substitutions,
        defaultRepsLow: 8,
        defaultRepsHigh: high,
        equipment: "machine",
        mechanic: "compound",
        region: "upper",
        difficulty: "beginner",
        metric: "reps",
        unilateral: false,
        defaultStepKg: 2.5,
        defaultTimeLowSec: null,
        defaultTimeHighSec: null,
        loadSemantics: "external_load",
        media: { image_url: null, video_url: null },
      });
    },
  );

  it("has no dangling or self substitutions", () => {
    const ids = new Set(current.exercises.map((row) => row.id));
    expect(
      current.exercises.flatMap((row) =>
        row.substitutions.filter((id) => !ids.has(id) || id === row.id),
      ),
    ).toEqual([]);
  });
});
