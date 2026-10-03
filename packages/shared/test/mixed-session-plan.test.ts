import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planMixedSession,
  MixedSessionPlanError,
  mandatoryBlockSeconds,
} from "../src/mixed-session-plan";
import type { CardioBlockDescriptor } from "../src/mixed-session-plan";
import type { PackCandidate } from "../src/session-plan";

const golden = JSON.parse(
  readFileSync(resolve(__dirname, "../../../docs/specs/cardio_baseline_golden.json"), "utf8"),
) as {
  cases: { id: string; slots: { descriptor: CardioBlockDescriptor | null }[] }[];
};
const interval = golden.cases
  .find((row) => row.id === "diet-3-30-cleared")!
  .slots.find((slot) => slot.descriptor?.kind === "interval")!.descriptor!;
const steady = golden.cases[0]!.slots[0]!.descriptor!;
const candidates: PackCandidate[] = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  mechanic: "compound",
  movement_pattern: "squat",
  unilateral: false,
  metric: "reps",
  target_reps_high: 12,
  target_time_high_sec: null,
}));

describe("explicit mandatory descriptor mixed planning", () => {
  it("counts whole interval including final recovery, with resistance-only working sets", () => {
    expect(interval).toMatchObject({ rounds: 6, duration_sec: 720, final_recovery_included: true });
    const result = planMixedSession({
      candidates,
      minutesPerDay: 90,
      restSec: 90,
      mandatoryBlocks: [interval],
    });
    expect(result.additional_fixed_block_sec).toBe(720);
    expect(result.resistanceWorkingSets).toBe(24);
    expect(result.resistance.map((row) => row.candidate.id)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
    ]);
    expect(result.estimated_total_sec).toBe(4722);
    expect(result.estimated_total_sec).toBeLessThanOrEqual(5400);
  });

  it("uses the sum of every mandatory block and preserves source descriptors", () => {
    const before = JSON.stringify([steady, interval]);
    expect(mandatoryBlockSeconds([steady, interval])).toBe(1320);
    const result = planMixedSession({
      candidates,
      minutesPerDay: 45,
      restSec: 90,
      mandatoryBlocks: [steady, interval],
    });
    expect(result.additional_fixed_block_sec).toBe(1320);
    expect(result.estimated_total_sec).toBeLessThanOrEqual(2700);
    expect(JSON.stringify([steady, interval])).toBe(before);
  });

  it("fails frozen T descriptor rather than dropping or shrinking it", () => {
    const row = golden.cases.find((item) => item.id === "diet-4-30-not_cleared")!;
    const descriptor = row.slots[2]!.descriptor!;
    expect(descriptor.duration_sec).toBe(900);
    expect(() =>
      planMixedSession({
        candidates,
        minutesPerDay: 30,
        restSec: 90,
        mandatoryBlocks: [descriptor],
      }),
    ).toThrowError(MixedSessionPlanError);
    try {
      planMixedSession({
        candidates,
        minutesPerDay: 30,
        restSec: 90,
        mandatoryBlocks: [descriptor],
      });
    } catch (error) {
      expect((error as MixedSessionPlanError).cause).toBe("mixed_time_budget");
    }
  });

  it("requires a non-core primary rather than returning cardio-only success", () => {
    for (const list of [[], [{ ...candidates[0]!, movement_pattern: "core" }]]) {
      expect(() =>
        planMixedSession({
          candidates: list,
          minutesPerDay: 90,
          restSec: 90,
          mandatoryBlocks: [steady],
        }),
      ).toThrowError("primary_unavailable");
    }
  });

  it("validates every frozen explicit donor without generating a donor", () => {
    for (const row of golden.cases) {
      for (const slot of row.slots) {
        if (slot.descriptor)
          expect(mandatoryBlockSeconds([slot.descriptor])).toBe(slot.descriptor.duration_sec);
      }
    }
  });

  it.each([
    { duration_sec: 0 },
    { duration_sec: 721 },
    { work_sec: 0 },
    { recovery_sec: null },
    { rounds: 13 },
    { rounds: 1.5 },
    { final_recovery_included: false },
    { target_rpe_low: 8 },
    { recovery_rpe_high: 4 },
    { rpe_scale_id: "borg" },
    { progression_axis: "duration_sec" },
    { long_session_flag: true },
  ])("rejects invalid interval descriptor %j", (change) => {
    expect(() =>
      mandatoryBlockSeconds([{ ...interval, ...change } as CardioBlockDescriptor]),
    ).toThrow(RangeError);
  });

  it.each([
    { rounds: 1 },
    { work_sec: 60 },
    { recovery_sec: 60 },
    { final_recovery_included: true },
    { recovery_rpe_low: 2 },
    { recovery_rpe_high: 3 },
    { target_rpe_high: 8 },
    { long_session_flag: null },
    { duration_sec: NaN },
  ])("rejects invalid steady descriptor %j", (change) => {
    expect(() =>
      mandatoryBlockSeconds([{ ...steady, ...change } as CardioBlockDescriptor]),
    ).toThrow(RangeError);
  });
});
