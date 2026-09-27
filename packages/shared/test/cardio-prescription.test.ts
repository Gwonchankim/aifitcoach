import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCardioBaseline,
  collectLowerResistanceDays,
  planCardioWeek,
  progressCardioDescriptor,
  selectCanonicalCardio,
} from "../src/cardio-prescription";
import type {
  CardioBaselineInput,
  CardioEligibility,
  CardioCatalogEntry,
} from "../src/cardio-prescription";
import type { CardioBlockDescriptor } from "../src/mixed-session-plan";
import type { Goal } from "../src/types";

const goldenPath = resolve(__dirname, "../../../docs/specs/cardio_baseline_golden.json");
const goldenRaw = readFileSync(goldenPath);
const golden = JSON.parse(goldenRaw.toString("utf8")) as {
  cases: {
    id: string;
    goal: Goal;
    days: number;
    minutes_per_day: number;
    profile: {
      screening: CardioEligibility["screening"];
      readiness: CardioEligibility["readiness"];
      recent_two_successful_cardio: boolean;
      latest_cardio_difficulty: CardioEligibility["latestCardioDifficulty"];
    };
    slots: {
      ordinal: number;
      day_offset: number;
      original_container: "S" | "H" | "C";
      descriptor: CardioBlockDescriptor | null;
    }[];
    original_lower_days: number[];
    interval_selected_ordinal: number | null;
    original_fallback_reason: string | null;
    totals: {
      total_sec: number;
      moderate_sec: number;
      vigorous_sec: number;
      light_sec: number;
      interval_work_sec: number;
      interval_rounds: number;
      long_sec: number;
    };
  }[];
};
// N08 witness inputs are constructed independently; expected prescriptions are fixture-only.
const compositions: Record<Goal, string[]> = {
  diet: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
  hypertrophy: ["SS", "SSH", "SSSH", "SSSSH", "SSSSHH"],
  strength: ["SS", "SSH", "SSSH", "SSSHC", "SSSSHC"],
  general_fitness: ["HH", "HHC", "SSCC", "SSHCC", "SSHHCC"],
  endurance: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
};
const days: Record<number, number[]> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
};
const focuses: Record<number, string[]> = {
  2: ["F", "F"],
  3: ["F", "F", "F"],
  4: ["U", "L", "U", "L"],
  5: ["U", "L", "U", "L", "U"],
  6: ["P", "Q", "L", "P", "Q", "L"],
};
const qualified: CardioEligibility = {
  screening: "low_risk",
  readiness: "normal",
  recentTwoSuccessfulCardio: true,
  latestCardioDifficulty: "moderate",
};
function input(
  goal: Goal,
  count: number,
  minutes = 60,
  eligibility: CardioEligibility = qualified,
): CardioBaselineInput {
  const slots = [...compositions[goal][count - 2]!].map((container, index) => ({
    ordinal: index + 1,
    day_offset: days[count]![index]!,
    container: container as "S" | "H" | "C",
  }));
  const lower = slots
    .filter(
      (slot) => slot.container !== "C" && ["F", "L"].includes(focuses[count]![slot.ordinal - 1]!),
    )
    .map((slot) => slot.day_offset);
  return {
    goal,
    minutesPerDay: minutes,
    slots,
    eligibility,
    lowerExposureDays: lower.flatMap((day) => [day - 7, day, day + 7]),
  };
}
const painAreas = ["knee", "lower_back", "shoulder", "elbow", "wrist", "hip", "neck", "ankle"];
const bike: CardioCatalogEntry = {
  id: "e_stationary_bike",
  modality: "cardio",
  metric: "time",
  equipment: "stationary_bike",
  mechanic: null,
  movementPattern: null,
  region: null,
  loadSemantics: null,
  defaultRepsLow: null,
  defaultRepsHigh: null,
  defaultTimeLowSec: null,
  defaultTimeHighSec: null,
  defaultStepKg: null,
  cardioMovementRegions: ["lower"],
  prescriptionKindsSupported: ["steady_cardio", "interval_cardio"],
  blockedReportedPainAreas: painAreas,
};

describe("frozen baseline cardio prescriptions", () => {
  it("reads the unchanged 250-case golden as a test fixture", () => {
    expect(golden.cases).toHaveLength(250);
    expect(createHash("sha256").update(goldenRaw).digest("hex")).toBe(
      "7dc2306294fc7bae629ffa4a07f5262ea310a2096f8c955cd77018607f172202",
    );
  });
  for (const row of golden.cases)
    it(row.id, () => {
      const result = buildCardioBaseline(
        input(row.goal, row.days, row.minutes_per_day, {
          screening: row.profile.screening,
          readiness: row.profile.readiness,
          recentTwoSuccessfulCardio: row.profile.recent_two_successful_cardio,
          latestCardioDifficulty: row.profile.latest_cardio_difficulty,
        }),
      );
      expect(result.slots.map((slot) => slot.descriptor)).toEqual(
        row.slots.map((slot) => slot.descriptor),
      );
      expect(result.interval_selected_ordinal).toBe(row.interval_selected_ordinal);
      expect(result.original_fallback_reason).toBe(row.original_fallback_reason);
      expect(result.totals).toEqual(row.totals);
    });
  it("does not infer clearance from unknown screening/readiness/history/lower schedule", () => {
    const original = input("diet", 4);
    for (const eligibility of [
      { ...qualified, screening: "unknown" as const },
      { ...qualified, readiness: "unknown" as const },
      { ...qualified, recentTwoSuccessfulCardio: null },
      { ...qualified, latestCardioDifficulty: "unknown" as const },
      { ...qualified, readiness: "low" as const },
      { ...qualified, latestCardioDifficulty: "hard" as const },
    ]) {
      const result = buildCardioBaseline({ ...original, eligibility });
      expect(result.interval_selected_ordinal).toBeNull();
      expect(result.slots[2]!.descriptor!.duration_sec).toBe(2100);
      expect(result.slots[2]!.cardio_fallback).toMatchObject({
        cause: "source_eligibility_fallback",
        source_day: "THU",
        source_ordinal: 3,
      });
      expect(result.slots[2]!.cardio_fallback!.original_descriptor).toEqual(
        result.slots[2]!.descriptor,
      );
    }
    expect(
      buildCardioBaseline({ ...original, lowerExposureDays: null }).interval_selected_ordinal,
    ).toBeNull();
  });
  it("checks adjacent-week and same-day lower resistance rather than just current-week neighbors", () => {
    const original = input("diet", 4);
    expect(
      buildCardioBaseline({ ...original, lowerExposureDays: [3, 4] }).interval_selected_ordinal,
    ).toBeNull();
    const singleC = { ...input("diet", 3), lowerExposureDays: [5] };
    expect(buildCardioBaseline(singleC).interval_selected_ordinal).toBeNull();
    expect(
      buildCardioBaseline({ ...singleC, lowerExposureDays: [6] }).interval_selected_ordinal,
    ).toBe(3);
  });
  it("N07 ignores lower cardio and core, counts actual lower/fullbody working resistance, fails unknown", () => {
    const exposures = [
      { day_offset: 3, modality: "cardio", region: "lower", workingSets: 1 },
      { day_offset: 1, modality: "resistance", region: "lower", workingSets: 2 },
      { day_offset: 4, modality: "resistance", region: "core", workingSets: 2 },
      { day_offset: 6, modality: "resistance", region: "fullbody", workingSets: 2 },
    ];
    expect(collectLowerResistanceDays(exposures)).toEqual([1, 6]);
    expect(
      collectLowerResistanceDays([
        ...exposures,
        { day_offset: 2, modality: "resistance", region: null, workingSets: 1 },
      ]),
    ).toBeNull();
    expect(
      buildCardioBaseline({
        ...input("diet", 4),
        lowerExposureDays: collectLowerResistanceDays(exposures),
      }).interval_selected_ordinal,
    ).toBe(3);
  });
});

describe("D5(i) redesign and progression", () => {
  for (const goal of ["diet", "general_fitness", "endurance"] as const)
    for (const count of [4, 5])
      it(`${goal}/${count} preserves source interval and assigns its larger same-slot steady donor`, () => {
        const result = planCardioWeek({ ...input(goal, count), rulesVersion: "2026.09.1" });
        const changed = result.slots.filter(
          (slot) => slot.cardio_fallback?.cause === "redesign_recovery",
        );
        expect(changed).toHaveLength(1);
        const slot = changed[0]!;
        expect(slot.cardio_fallback!.original_descriptor.kind).toBe("interval");
        expect(slot.descriptor!.kind).toBe("steady");
        expect(slot.cardio_fallback!.effective_descriptor).toEqual(slot.descriptor);
        expect(slot.cardio_fallback!.source_ordinal).toBe(slot.source_ordinal);
        expect(slot.cardio_fallback!.source_day).toBe(slot.source_day);
        expect(result.totals.total_sec - result.source_totals.total_sec).toBeGreaterThan(0);
        expect(result.totals.vigorous_sec).toBe(0);
        expect(result.slots.filter((value) => value.descriptor?.kind === "interval")).toHaveLength(
          0,
        );
      });
  it("preserves original .09.0 and six-day interval assignment", () => {
    expect(planCardioWeek({ ...input("diet", 4), rulesVersion: "2026.09.0" }).slots).toEqual(
      buildCardioBaseline(input("diet", 4)).slots,
    );
    expect(
      planCardioWeek({ ...input("diet", 6), rulesVersion: "2026.09.1" }).slots[2]!.descriptor!.kind,
    ).toBe("interval");
  });
  it("progresses duration by exactly 300 or rounds by one, else holds without truncation", () => {
    const steady = buildCardioBaseline(input("diet", 2)).slots[0]!.descriptor!;
    const interval = buildCardioBaseline(input("diet", 4)).slots[2]!.descriptor!;
    const options = {
      recentTwoSuccessfulCardio: true,
      originalTotalSec: 2400,
      originalBudgetSec: 3600,
      recoverySatisfied: true,
    };
    expect(progressCardioDescriptor(steady, options)).toEqual({
      ...steady,
      duration_sec: steady.duration_sec + 300,
    });
    expect(progressCardioDescriptor(interval, options)).toEqual({
      ...interval,
      rounds: 11,
      duration_sec: 1320,
    });
    for (const guard of [
      { originalBudgetSec: 2400 },
      { recoverySatisfied: false },
      { recoverySatisfied: null },
      { recentTwoSuccessfulCardio: false },
      { recentTwoSuccessfulCardio: null },
    ])
      expect(progressCardioDescriptor(steady, { ...options, ...guard })).toEqual(steady);
    const maximum = { ...interval, rounds: 12, duration_sec: 1440 };
    expect(progressCardioDescriptor(maximum, options)).toEqual(maximum);
    expect(() => progressCardioDescriptor(steady, { ...options, originalTotalSec: 3601 })).toThrow(
      "mixed_time_budget",
    );
  });
});

describe("canonical stationary-bike safety gate", () => {
  const allowed = {
    catalog: [bike],
    equipment: ["stationary_bike"],
    painAreas: [] as string[],
    currentPain: false,
  };
  it("requires the exact known canonical metadata and explicit bike availability", () => {
    expect(selectCanonicalCardio(allowed)).toEqual(bike);
    for (const equipment of [null, [], ["machine"], ["bodyweight"]])
      expect(() => selectCanonicalCardio({ ...allowed, equipment })).toThrow();
    expect(() =>
      selectCanonicalCardio({ ...allowed, catalog: [{ ...bike, cardioMovementRegions: [] }] }),
    ).toThrow("metadata_unknown");
    expect(() =>
      selectCanonicalCardio({
        ...allowed,
        catalog: [{ ...bike, blockedReportedPainAreas: ["knee"] }],
      }),
    ).toThrow("metadata_unknown");
    expect(() =>
      selectCanonicalCardio({ ...allowed, catalog: [{ ...bike, loadSemantics: "external_load" }] }),
    ).toThrow("metadata_unknown");
  });
  it("rejects all eight pain areas and unknown pain without a steady escape hatch", () => {
    for (const area of painAreas)
      expect(() => selectCanonicalCardio({ ...allowed, painAreas: [area] })).toThrow(
        "cardio_unavailable",
      );
    expect(() => selectCanonicalCardio({ ...allowed, painAreas: null })).toThrow(
      "metadata_unknown",
    );
    expect(() => selectCanonicalCardio({ ...allowed, currentPain: null })).toThrow(
      "metadata_unknown",
    );
    expect(() => selectCanonicalCardio({ ...allowed, currentPain: true })).toThrow(
      "cardio_unavailable",
    );
    expect(() => selectCanonicalCardio({ ...allowed, painAreas: ["unknown_body_area"] })).toThrow(
      "metadata_unknown",
    );
  });
});
