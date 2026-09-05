import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BASELINE_CATALOG,
  CATALOG109,
  CURRENT_CATALOG,
  CURRENT_RAW,
  CATALOG109_RAW,
} from "./support/catalog-extension";
import { catalogSelectionMatrix } from "./support/catalog-selection-matrix";
import { buildProgramSelectionContext, DIFFICULTY_RANK } from "../src/programs/programs.service";
import { excludedPatternsFor } from "../src/programs/program-rules";

describe("ticket02 retains 109 baseline and freezes 110 selection effects", () => {
  it("pins all 109 objects, with only assisted dips added", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(__dirname, "support/catalog-baseline-109.fixture")))
        .digest("hex"),
    ).toBe("c3170d88c30207811b0c1ae8d280e4933ded8567364cb12ca8fa74bc05d15174");
    expect(CURRENT_CATALOG).toHaveLength(110);
    expect(CURRENT_RAW.filter((row) => row.id !== "e_assisted_dips")).toEqual(CATALOG109_RAW);
    expect(CURRENT_CATALOG.find((row) => row.id === "e_assisted_dips")).toMatchObject({
      nameKo: "어시스트 딥스 머신",
      nameEn: "Assisted Dip Machine",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest", "triceps"],
      secondaryMuscles: ["front_delts"],
      defaultRepsLow: 6,
      defaultRepsHigh: 12,
      equipment: "machine",
      mechanic: "compound",
      region: "upper",
      difficulty: "beginner",
      metric: "reps",
      unilateral: false,
      defaultStepKg: 2.5,
      defaultTimeLowSec: null,
      defaultTimeHighSec: null,
      loadSemantics: "assistance",
      substitutions: ["e_dips", "e_chest_press_machine"],
      media: { image_url: null, video_url: null },
    });
  });

  it.each([
    [
      "106-110",
      BASELINE_CATALOG,
      "43e4c2fa18a970417b8b0a6df872ba5231d11dc3b40ce3a0c4d18b43471d681b",
    ],
    ["109-110", CATALOG109, "24c2740981460dc0d5cb59c1d72907abfacd87cdb595f71684d8ae32b1e1b0bd"],
  ] as const)("%s: exact 2025 weekly plans with level/pain invariants", (label, baseline, hash) => {
    const matrix = catalogSelectionMatrix(baseline, CURRENT_CATALOG);
    expect(matrix).toHaveLength(2025);
    const sha256 = createHash("sha256").update(JSON.stringify(matrix)).digest("hex");
    const changedByPain: Record<string, number> = {};
    for (const row of matrix.filter((item) => item.changed)) {
      const pain = row.input.pain_areas?.[0] ?? "none";
      changedByPain[pain] = (changedByPain[pain] ?? 0) + 1;
    }
    if (process.env.AFC_CATALOG_REPORT_DIR)
      writeFileSync(
        path.join(process.env.AFC_CATALOG_REPORT_DIR, `selection-${label}.json`),
        JSON.stringify({ sha256, changedByPain, matrix }, null, 2),
      );
    for (const { input, after } of matrix) {
      const context = buildProgramSelectionContext(CURRENT_CATALOG, input);
      const excluded = excludedPatternsFor(input.pain_areas ?? []);
      for (const id of after.flatMap((day) => day.ids)) {
        const row = CURRENT_CATALOG.find((item) => item.id === id)!;
        expect(row).toBeDefined();
        expect(DIFFICULTY_RANK[row.difficulty]).toBeLessThanOrEqual(
          DIFFICULTY_RANK[input.experience_level],
        );
        expect(excluded.has(row.movementPattern)).toBe(false);
      }
      if (input.pain_areas?.includes("shoulder")) {
        expect(
          context.allowed.filter((row) =>
            ["e_assisted_dips", "e_incline_chest_press_machine"].includes(row.id),
          ),
        ).toEqual([]);
      }
      if (input.pain_areas?.includes("wrist")) expect(context.options.preferStable).toBe(true);
      if (input.pain_areas?.includes("elbow"))
        expect(context.allowed.some((row) => row.id === "e_assisted_dips")).toBe(true);
    }
    expect(changedByPain).toEqual({
      none: 75,
      knee: 225,
      lower_back: 225,
      ...(label === "106-110" ? { shoulder: 36 } : {}),
      elbow: 225,
      wrist: 225,
      hip: 225,
      neck: 225,
      ankle: 225,
    });
    expect(sha256).toBe(hash);
  });
});
