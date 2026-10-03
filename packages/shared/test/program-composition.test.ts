import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getProgramComposition } from "../src/program-composition";
import type { SplitPreference } from "../src/program-composition";
import type { Goal } from "../src/types";

const contract = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../docs/specs/feature_improvements_contract.json"),
    "utf8",
  ),
) as {
  composition: { goal: Goal; days: number; legacy: string; revised: string }[];
  preferences: {
    days: number;
    preference: SplitPreference;
    focus: string[];
    day_offsets: number[];
  }[];
};

describe("versioned composition and slot context", () => {
  it("matches all 25 frozen original/revised cells without relabeling source slots", () => {
    expect(contract.composition).toHaveLength(25);
    for (const row of contract.composition) {
      for (const [rulesVersion, expected] of [
        ["2026.09.0", row.legacy],
        ["2026.09.1", row.revised],
      ]) {
        const result = getProgramComposition({
          rulesVersion: rulesVersion!,
          goal: row.goal,
          daysPerWeek: row.days,
        });
        expect(result.composition).toBe(expected);
        expect(result.slots.map((slot) => slot.container).join("")).toBe(expected);
        expect(result.slots.map((slot) => slot.sourceContainer).join("")).toBe(row.legacy);
        expect(result.slots.map((slot) => slot.ordinal)).toEqual(
          Array.from({ length: row.days }, (_, index) => index + 1),
        );
      }
    }
  });

  it("parses the repository composition tables independently and matches every goal", () => {
    const document = readFileSync(
      resolve(__dirname, "../../../docs/PROGRAM_V2_CONTRACT.md"),
      "utf8",
    );
    for (const [heading, end, key] of [
      ["### 2.3 S/C/H", "#### 2.3.1", "legacy"],
      ["#### 2.3.1", "### 2.4", "revised"],
    ] as const) {
      const section = document.slice(document.indexOf(heading), document.indexOf(end));
      const rows = section
        .split(/\r?\n/)
        .filter((line) =>
          /^\|\s*`?(diet|hypertrophy|strength|general_fitness|endurance)`?\s*\|/.test(line),
        );
      expect(rows).toHaveLength(5);
      const goals = new Set<string>();
      for (const line of rows) {
        const [goal, ...cells] = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim().replaceAll("`", ""));
        expect(goals.has(goal!)).toBe(false);
        goals.add(goal!);
        expect(cells).toHaveLength(5);
        cells.forEach((cell, index) => {
          expect(cell).toHaveLength(index + 2);
          expect(
            contract.composition.find((row) => row.goal === goal && row.days === index + 2)?.[key],
          ).toBe(cell);
        });
      }
    }
  });

  it("covers 30 four/five-day goal preference policy rows including explicit rejection", () => {
    let count = 0;
    for (const goal of [
      "diet",
      "hypertrophy",
      "strength",
      "general_fitness",
      "endurance",
    ] as const) {
      for (const daysPerWeek of [4, 5]) {
        for (const splitPreference of ["balanced", "upper_priority", "lower_priority"] as const) {
          count++;
          const input = { rulesVersion: "2026.09.1", goal, daysPerWeek, splitPreference };
          if (daysPerWeek === 4 && splitPreference !== "balanced") {
            expect(() => getProgramComposition(input)).toThrow(RangeError);
            continue;
          }
          const result = getProgramComposition(input);
          const expected = contract.preferences.find(
            (row) => row.days === daysPerWeek && row.preference === splitPreference,
          )!;
          expect(result.composition).not.toContain("C");
          expect(result.slots.map((slot) => slot.resistanceFocus)).toEqual(expected.focus);
          expect(result.slots.map((slot) => slot.dayOffset)).toEqual(expected.day_offsets);
          expect(result.split).toEqual({
            requested: splitPreference,
            effective: splitPreference,
            applicable: true,
            reason: null,
          });
          expect(result.intervalAssignment).toBe("unassigned_preserve_source");
        }
      }
    }
    expect(count).toBe(30);
  });

  it("marks unsupported days N/A and never infers a calendar for their slots", () => {
    for (const daysPerWeek of [2, 3, 6]) {
      for (const splitPreference of [undefined, "balanced"] as const) {
        const result = getProgramComposition({
          rulesVersion: "2026.09.1",
          goal: "diet",
          daysPerWeek,
          splitPreference,
        });
        expect(result.split).toEqual({
          requested: splitPreference ?? null,
          effective: null,
          applicable: false,
          reason: "unsupported_days",
        });
        expect(
          result.slots.every((slot) => slot.dayOffset === null && slot.resistanceFocus === null),
        ).toBe(true);
      }
      expect(() =>
        getProgramComposition({
          rulesVersion: "2026.09.1",
          goal: "diet",
          daysPerWeek,
          splitPreference: "lower_priority",
        }),
      ).toThrow(RangeError);
    }
  });

  it("does not apply revised split policy to .09.0 or silently accept unknown input", () => {
    const legacy = getProgramComposition({
      rulesVersion: "2026.09.0",
      goal: "diet",
      daysPerWeek: 4,
    });
    expect(legacy.composition).toBe("HHCC");
    expect(legacy.split.applicable).toBe(false);
    expect(legacy.slots.every((slot) => slot.resistanceFocus === null)).toBe(true);
    for (const rulesVersion of ["2026.08.1", "2026.10.0"]) {
      expect(() => getProgramComposition({ rulesVersion, goal: "diet", daysPerWeek: 4 })).toThrow(
        RangeError,
      );
    }
    expect(() =>
      getProgramComposition({ rulesVersion: "2026.09.1", goal: "diet", daysPerWeek: 7 }),
    ).toThrow(RangeError);
  });
});
