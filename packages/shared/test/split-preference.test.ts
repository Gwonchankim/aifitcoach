import { describe, expect, it } from "vitest";
import {
  buildSplitPreferenceSnapshot,
  checkRepeatedFocusRecovery,
  legacySplitPreferenceSnapshot,
  parseSplitPreferenceSnapshot,
  validateSplitPreference,
} from "../src/split-preference";

const input = { rulesVersion: "2026.09.1", daysPerWeek: 5 };
const upper = ["upper", "lower", "upper", "lower", "upper"];
const lower = ["lower", "upper", "lower", "upper", "lower"];

describe("immutable split request and effective policy", () => {
  it("omission stays null while five-day balanced is effective", () => {
    expect(buildSplitPreferenceSnapshot({ ...input, focuses: upper })).toEqual({
      requested_preference: null,
      effective_preference: "balanced",
      applicable: true,
      reason: null,
      upper_days: 3,
      lower_days: 2,
    });
  });
  it("lower request is represented by real 2:3 days, not requested/effective conflation", () => {
    expect(
      buildSplitPreferenceSnapshot({
        ...input,
        requestedPreference: "lower_priority",
        focuses: lower,
      }),
    ).toEqual({
      requested_preference: "lower_priority",
      effective_preference: "lower_priority",
      applicable: true,
      reason: null,
      upper_days: 2,
      lower_days: 3,
    });
    expect(() =>
      buildSplitPreferenceSnapshot({
        ...input,
        requestedPreference: "lower_priority",
        focuses: upper,
      }),
    ).toThrow();
  });
  it("all four wire reasons have real emit paths and no extra values", () => {
    const snapshots = [
      buildSplitPreferenceSnapshot({ ...input, focuses: upper }),
      buildSplitPreferenceSnapshot({ ...input, daysPerWeek: 4, focuses: upper.slice(0, 4) }),
      buildSplitPreferenceSnapshot({
        ...input,
        daysPerWeek: 3,
        focuses: ["full_body", "full_body", "full_body"],
      }),
      legacySplitPreferenceSnapshot(upper),
    ];
    expect(snapshots.map((s) => s.reason)).toEqual([
      null,
      "four_day_balanced_only",
      "unsupported_days",
      "legacy_input",
    ]);
    expect(snapshots.map(parseSplitPreferenceSnapshot)).toEqual(snapshots);
  });
  it.each([2, 3, 4, 6])("rejects both explicit priority choices for %i days", (daysPerWeek) => {
    for (const requestedPreference of ["upper_priority", "lower_priority"] as const)
      expect(() =>
        validateSplitPreference({ ...input, daysPerWeek, requestedPreference }),
      ).toThrow();
  });
  it.each(["2026.08.1", "2026.09.0"])("keeps %s inactive and rejects priority", (rulesVersion) => {
    expect(buildSplitPreferenceSnapshot({ ...input, rulesVersion, focuses: upper })).toEqual({
      requested_preference: null,
      effective_preference: null,
      applicable: false,
      reason: "legacy_input",
      upper_days: 3,
      lower_days: 2,
    });
    for (const requestedPreference of ["upper_priority", "lower_priority"] as const)
      expect(() =>
        validateSplitPreference({ ...input, rulesVersion, requestedPreference }),
      ).toThrow();
    expect(() =>
      validateSplitPreference({ ...input, rulesVersion, requestedPreference: "balanced" }),
    ).not.toThrow();
  });
  it("null is invalid for generation, and unavailable old focus does not invent counts", () => {
    expect(() =>
      validateSplitPreference({ ...input, requestedPreference: null as never }),
    ).toThrow();
    expect(legacySplitPreferenceSnapshot([])).toMatchObject({
      reason: "legacy_input",
      upper_days: 0,
      lower_days: 0,
    });
  });
  it("strict decoder rejects missing keys, unknown reason and incoherent effective counts", () => {
    const snapshot = buildSplitPreferenceSnapshot({ ...input, focuses: upper });
    for (const key of Object.keys(snapshot)) {
      const copy = { ...snapshot } as Record<string, unknown>;
      delete copy[key];
      expect(parseSplitPreferenceSnapshot(copy)).toBeNull();
    }
    for (const patch of [
      { reason: "legacy_bundle" },
      { upper_days: 2 },
      { applicable: false },
      { effective_preference: "lower_priority" },
    ])
      expect(parseSplitPreferenceSnapshot({ ...snapshot, ...patch })).toBeNull();
  });
});

describe("new weekly plan repeats across both week boundaries", () => {
  it("accepts exact 48-hour boundaries in approved 4/5-day calendars", () => {
    expect(
      checkRepeatedFocusRecovery(
        [0, 1, 3, 4].map((dayOffset, i) => ({ dayOffset, focus: upper[i]! })),
      ),
    ).toBe(true);
    for (const focuses of [upper, lower])
      expect(
        checkRepeatedFocusRecovery(
          [0, 1, 2, 4, 5].map((dayOffset, i) => ({ dayOffset, focus: focuses[i]! })),
        ),
      ).toBe(true);
  });
  it("rejects within-week and Sunday-to-Monday same-focus 24-hour gaps", () => {
    expect(
      checkRepeatedFocusRecovery([
        { dayOffset: 0, focus: "upper" },
        { dayOffset: 1, focus: "upper" },
      ]),
    ).toBe(false);
    expect(
      checkRepeatedFocusRecovery([
        { dayOffset: 0, focus: "lower" },
        { dayOffset: 6, focus: "lower" },
      ]),
    ).toBe(false);
  });
});
