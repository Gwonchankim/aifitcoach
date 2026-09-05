import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  BASELINE_CATALOG,
  CURRENT_CATALOG,
  CATALOG_COUNT,
  MACHINE_IDS,
} from "./support/catalog-extension";
import { catalogSelectionMatrix, weeklySelection } from "./support/catalog-selection-matrix";
import { buildProgramSelectionContext, DIFFICULTY_RANK } from "../src/programs/programs.service";
import { excludedPatternsFor } from "../src/programs/program-rules";

describe("106 → 109 production selection matrix", () => {
  const matrix = catalogSelectionMatrix();

  it("freezes all 2025 exact before/after weekly plans and their measured change distribution", () => {
    expect(BASELINE_CATALOG).toHaveLength(106);
    expect(CURRENT_CATALOG).toHaveLength(CATALOG_COUNT);
    expect(matrix).toHaveLength(2025);
    const serialized = JSON.stringify(matrix);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const changed = matrix.filter((row) => row.changed);
    const changedByPain: Record<string, number> = {};
    for (const row of changed) {
      const pain = row.input.pain_areas?.[0] ?? "none";
      changedByPain[pain] = (changedByPain[pain] ?? 0) + 1;
    }
    // Optional operator evidence is written outside artifacts. Never update the expected hash here.
    if (process.env.AFC_CATALOG_REPORT)
      writeFileSync(
        process.env.AFC_CATALOG_REPORT,
        JSON.stringify({ sha256, changedByPain, matrix }, null, 2),
      );
    expect(sha256).toBe("adfce0343a6e095554f6dc7ef7532c07e0d8c98989f90e08d523e5ef9de77383");
    expect(changedByPain).toEqual({
      knee: 45,
      lower_back: 45,
      shoulder: 36,
      elbow: 45,
      wrist: 45,
      hip: 45,
      neck: 99,
      ankle: 45,
    });
  });

  it("all selected IDs obey level and pain constraints; removing only the new rows restores baseline", () => {
    const ids = new Set(CURRENT_CATALOG.map((row) => row.id));
    const restored = CURRENT_CATALOG.filter((row) => !MACHINE_IDS.includes(row.id));
    expect(restored).toEqual(BASELINE_CATALOG);
    for (const { input, before, after } of matrix) {
      expect(weeklySelection(restored, input)).toEqual(before);
      const context = buildProgramSelectionContext(CURRENT_CATALOG, input);
      const excluded = excludedPatternsFor(input.pain_areas ?? []);
      for (const day of after) {
        expect(new Set(day.ids).size).toBe(day.ids.length);
        for (const id of day.ids) {
          expect(ids.has(id)).toBe(true);
          const row = CURRENT_CATALOG.find((item) => item.id === id)!;
          expect(DIFFICULTY_RANK[row.difficulty]).toBeLessThanOrEqual(
            DIFFICULTY_RANK[input.experience_level],
          );
          expect(excluded.has(row.movementPattern)).toBe(false);
        }
      }
      if (input.pain_areas?.includes("shoulder")) {
        expect(context.allowed.some((row) => row.id === "e_incline_chest_press_machine")).toBe(
          false,
        );
        expect(after.flatMap((day) => day.ids)).not.toContain("e_incline_chest_press_machine");
      }
      if (input.pain_areas?.includes("wrist")) expect(context.options.preferStable).toBe(true);
      if (input.pain_areas?.includes("elbow")) {
        expect(
          context.allowed
            .filter((row) => MACHINE_IDS.includes(row.id))
            .map((row) => row.id)
            .sort(),
        ).toEqual([...MACHINE_IDS].sort());
      }
    }
  });
});
