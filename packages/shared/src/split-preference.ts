import type { SplitPreference } from "./program-composition";
import { RULES_BUNDLE_V2_SPLIT } from "./rules-version";

const PREFERENCES = ["balanced", "upper_priority", "lower_priority"] as const;
export const SPLIT_SNAPSHOT_REASONS = [
  null,
  "unsupported_days",
  "four_day_balanced_only",
  "legacy_input",
] as const;

export interface SplitProgramSnapshot {
  requested_preference: SplitPreference | null;
  effective_preference: SplitPreference | null;
  applicable: boolean;
  reason: (typeof SPLIT_SNAPSHOT_REASONS)[number];
  upper_days: number;
  lower_days: number;
}

interface SplitInput {
  rulesVersion: string;
  daysPerWeek: number;
  requestedPreference?: SplitPreference;
}

function isPreference(value: unknown): value is SplitPreference {
  return PREFERENCES.includes(value as SplitPreference);
}

/** A profile may store a priority that a generation request cannot use. No profile fallback. */
export function validateSplitPreference(input: SplitInput): void {
  const { daysPerWeek, rulesVersion, requestedPreference } = input;
  if (!Number.isInteger(daysPerWeek) || daysPerWeek < 2 || daysPerWeek > 6)
    throw new RangeError("Unsupported split days");
  if (requestedPreference !== undefined && !isPreference(requestedPreference))
    throw new RangeError("Unsupported split preference");
  if (
    requestedPreference !== undefined &&
    requestedPreference !== "balanced" &&
    (rulesVersion !== RULES_BUNDLE_V2_SPLIT || daysPerWeek !== 5)
  )
    throw new RangeError("Priority requires the supported five-day policy");
}

function counts(focuses: readonly string[]) {
  return {
    upper_days: focuses.filter((focus) => focus === "upper").length,
    lower_days: focuses.filter((focus) => focus === "lower").length,
  };
}

/** Legacy counts describe persisted template focus, never current profile state. */
export function legacySplitPreferenceSnapshot(focuses: readonly string[]): SplitProgramSnapshot {
  return {
    requested_preference: null,
    effective_preference: null,
    applicable: false,
    reason: "legacy_input",
    ...counts(focuses),
  };
}

export function buildSplitPreferenceSnapshot(
  input: SplitInput & { focuses: readonly string[] },
): SplitProgramSnapshot {
  validateSplitPreference(input);
  const requested_preference = input.requestedPreference ?? null;
  if (input.daysPerWeek !== 4 && input.daysPerWeek !== 5)
    return {
      requested_preference,
      effective_preference: null,
      applicable: false,
      reason: "unsupported_days",
      upper_days: 0,
      lower_days: 0,
    };
  if (input.rulesVersion !== RULES_BUNDLE_V2_SPLIT)
    return { ...legacySplitPreferenceSnapshot(input.focuses), requested_preference };
  const effective_preference = input.requestedPreference ?? "balanced";
  const result: SplitProgramSnapshot = {
    requested_preference,
    effective_preference,
    applicable: true,
    reason: input.daysPerWeek === 4 ? "four_day_balanced_only" : null,
    ...counts(input.focuses),
  };
  const expectedUpper =
    input.daysPerWeek === 4 || effective_preference === "lower_priority" ? 2 : 3;
  if (
    input.focuses.length !== input.daysPerWeek ||
    result.upper_days !== expectedUpper ||
    result.lower_days !== input.daysPerWeek - expectedUpper
  )
    throw new RangeError("Actual split focus does not match the requested policy");
  return result;
}

/** Missing/invalid new data is not silently repaired into a successful preference. */
export function parseSplitPreferenceSnapshot(value: unknown): SplitProgramSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = [
    "requested_preference",
    "effective_preference",
    "applicable",
    "reason",
    "upper_days",
    "lower_days",
  ];
  if (Object.keys(v).length !== keys.length || keys.some((key) => !Object.hasOwn(v, key)))
    return null;
  if (
    (v.requested_preference !== null && !isPreference(v.requested_preference)) ||
    (v.effective_preference !== null && !isPreference(v.effective_preference)) ||
    typeof v.applicable !== "boolean" ||
    !SPLIT_SNAPSHOT_REASONS.includes(v.reason as SplitProgramSnapshot["reason"]) ||
    ![v.upper_days, v.lower_days].every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5,
    )
  )
    return null;
  const snapshot = v as unknown as SplitProgramSnapshot;
  if (!snapshot.applicable) {
    if (snapshot.effective_preference !== null) return null;
    if (snapshot.reason === "legacy_input") return snapshot;
    return snapshot.reason === "unsupported_days" &&
      snapshot.upper_days === 0 &&
      snapshot.lower_days === 0 &&
      (snapshot.requested_preference === null || snapshot.requested_preference === "balanced")
      ? snapshot
      : null;
  }
  if (snapshot.effective_preference !== (snapshot.requested_preference ?? "balanced")) return null;
  if (snapshot.reason === "four_day_balanced_only")
    return snapshot.effective_preference === "balanced" &&
      snapshot.upper_days === 2 &&
      snapshot.lower_days === 2
      ? snapshot
      : null;
  if (snapshot.reason !== null) return null;
  const expectedUpper = snapshot.effective_preference === "lower_priority" ? 2 : 3;
  return snapshot.upper_days === expectedUpper && snapshot.lower_days === 5 - expectedUpper
    ? snapshot
    : null;
}

/** P09 applies to this new template repeated weekly, not another program's past actuals. */
export function checkRepeatedFocusRecovery(
  slots: readonly { dayOffset: number; focus: string }[],
): boolean {
  if (
    slots.some(
      (slot) => !Number.isInteger(slot.dayOffset) || slot.dayOffset < 0 || slot.dayOffset > 6,
    )
  )
    return false;
  for (const focus of ["upper", "lower"]) {
    const days = slots
      .filter((slot) => slot.focus === focus)
      .map((slot) => slot.dayOffset)
      .sort((a, b) => a - b);
    for (let i = 0; i < days.length; i++)
      if ((i + 1 < days.length ? days[i + 1]! : days[0]! + 7) - days[i]! < 2) return false;
  }
  return true;
}
