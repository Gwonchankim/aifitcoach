import { describe, expect, it } from "vitest";
import { buildCardioBaseline, planCardioWeek } from "../src/cardio-prescription";
import type { CardioBaselineInput } from "../src/cardio-prescription";
import {
  cardioIntensitySeconds,
  parseCardioDescriptor,
  parseCardioSnapshot,
  toCardioSnapshot,
} from "../src/cardio-prescription-codec";

const input: CardioBaselineInput = {
  goal: "diet",
  minutesPerDay: 60,
  slots: [
    { ordinal: 1, day_offset: 0, container: "H" },
    { ordinal: 2, day_offset: 1, container: "H" },
    { ordinal: 3, day_offset: 3, container: "C" },
    { ordinal: 4, day_offset: 4, container: "C" },
  ],
  eligibility: {
    screening: "low_risk",
    readiness: "normal",
    recentTwoSuccessfulCardio: true,
    latestCardioDifficulty: "moderate",
  },
  lowerExposureDays: [-6, 1, 8],
};

describe("cardio wire descriptor and intensity decoder", () => {
  it("round trips steady, interval, long and D5 source/effective identity exactly", () => {
    const baseline = buildCardioBaseline(input);
    const long = buildCardioBaseline({ ...input, goal: "endurance" }).slots[3]!;
    const redesign = planCardioWeek({ ...input, rulesVersion: "2026.09.1" }).slots[2]!;
    for (const slot of [baseline.slots[0]!, baseline.slots[2]!, long, redesign]) {
      const snapshot = toCardioSnapshot(slot);
      expect(snapshot).not.toHaveProperty("kind");
      expect(parseCardioSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
      expect(parseCardioDescriptor(slot.descriptor)).toEqual(slot.descriptor);
      expect(snapshot.source_day).toBe(slot.source_day);
      expect(snapshot.source_ordinal).toBe(slot.source_ordinal);
      expect(snapshot.cardio_fallback).toEqual(slot.cardio_fallback);
    }
    expect(cardioIntensitySeconds(baseline.slots[2]!.descriptor!)).toEqual({
      moderate: 0,
      high: 600,
      recovery: 600,
    });
    expect(toCardioSnapshot(redesign).intensity_seconds).toEqual({
      moderate: 2100,
      high: 0,
      recovery: 0,
    });
  });
  it("fails each omitted field rather than filling it or interpreting null as zero", () => {
    const snapshot = toCardioSnapshot(buildCardioBaseline(input).slots[2]!);
    for (const key of Object.keys(snapshot)) {
      const incomplete: Record<string, unknown> = { ...snapshot };
      delete incomplete[key];
      expect(parseCardioSnapshot(incomplete), key).toBeNull();
    }
    for (const key of ["moderate", "high", "recovery"]) {
      const intensity: Record<string, unknown> = { ...snapshot.intensity_seconds };
      delete intensity[key];
      expect(parseCardioSnapshot({ ...snapshot, intensity_seconds: intensity }), key).toBeNull();
    }
  });
  it("rejects mismatched kind, scale, seconds, final recovery, axis, RPE and numeric overflow", () => {
    const snapshot = toCardioSnapshot(buildCardioBaseline(input).slots[2]!);
    for (const patch of [
      { prescription_kind: "resistance" },
      { prescription_kind: "steady_cardio" },
      { rpe_scale_id: null },
      { duration_sec: 1199 },
      { rounds: 13 },
      { rounds: 0 },
      { rounds: 1.5 },
      { duration_sec: Number.MAX_SAFE_INTEGER + 1 },
      { final_recovery_included: false },
      { recovery_rpe_low: null },
      { target_rpe_low: 6 },
      { target_rpe_high: 9 },
      { progression_axis: "duration_sec" },
      { long_session_flag: true },
      { intensity_seconds: { moderate: 600, high: 0, recovery: 600 } },
      { source_day: "Monday" },
      { source_ordinal: 0 },
    ])
      expect(parseCardioSnapshot({ ...snapshot, ...patch })).toBeNull();
    expect(
      parseCardioDescriptor({ ...buildCardioBaseline(input).slots[0]!.descriptor, work_sec: 60 }),
    ).toBeNull();
  });
  it("rejects unknown, contradictory and missing fallback data instead of dropping provenance", () => {
    const snapshot = toCardioSnapshot(
      planCardioWeek({ ...input, rulesVersion: "2026.09.1" }).slots[2]!,
    );
    const fallback = snapshot.cardio_fallback!;
    for (const patch of [
      { cause: "unknown" },
      { source_day: "FRI" },
      { source_ordinal: 4 },
      { original_descriptor: null },
      { effective_descriptor: { ...fallback.effective_descriptor, duration_sec: 1800 } },
    ])
      expect(
        parseCardioSnapshot({ ...snapshot, cardio_fallback: { ...fallback, ...patch } }),
      ).toBeNull();
    expect(
      parseCardioSnapshot({
        ...snapshot,
        cardio_fallback: { ...fallback, original_descriptor: fallback.effective_descriptor },
      }),
    ).toBeNull();
    const source = buildCardioBaseline({
      ...input,
      eligibility: { ...input.eligibility, screening: "unknown" },
    }).slots[2]!;
    expect(parseCardioSnapshot(toCardioSnapshot(source))).toEqual(toCardioSnapshot(source));
  });
  it.each([
    ["sets", 8],
    ["reps_low", 20],
    ["reps_high", 30],
    ["time_low_sec", 20],
    ["time_high_sec", 30],
    ["assistance_provenance", "native"],
    ["recommended_action", "increase_assistance"],
    ["assistance_safety_status", "safe"],
  ])(
    "rejects inactive Program/session axis %s without changing valid null envelopes",
    (field, value) => {
      const snapshot = toCardioSnapshot(buildCardioBaseline(input).slots[0]!);
      const encoded = JSON.stringify(snapshot);
      expect(parseCardioSnapshot({ ...snapshot, [field]: value })).toBeNull();
      expect(JSON.stringify(parseCardioSnapshot({ ...snapshot, [field]: null }))).toBe(encoded);
      expect(JSON.stringify(parseCardioSnapshot(snapshot))).toBe(encoded);
    },
  );
  it("rejects non-null resistance payload and keeps null compatible union fields", () => {
    const snapshot = toCardioSnapshot(buildCardioBaseline(input).slots[0]!);
    for (const [field, value] of Object.entries({
      target_reps_low: 1,
      target_reps_high: 1,
      target_time_sec: 30,
      target_time_low_sec: 30,
      target_time_high_sec: 30,
      target_rir: 3,
      rest_sec: 90,
      recommended_weight: 0,
      recommended_reps: 1,
      confidence: 1,
      reason_code: "BASELINE",
      load_semantics: "external_load",
      assistance_step_kg: 5,
    })) {
      expect(parseCardioSnapshot({ ...snapshot, [field]: value }), field).toBeNull();
      expect(parseCardioSnapshot({ ...snapshot, [field]: null }), field).toEqual(snapshot);
    }
  });
});
