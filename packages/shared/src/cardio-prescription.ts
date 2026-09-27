import type { CardioBlockDescriptor } from "./mixed-session-plan";
import { mandatoryBlockSeconds } from "./mixed-session-plan";
import { getProgramComposition } from "./program-composition";
import { RULES_BUNDLE_V2, RULES_BUNDLE_V2_SPLIT } from "./rules-version";
import type { Goal } from "./types";

export type CardioSourceDay = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
export interface CardioEligibility {
  screening: "low_risk" | "not_cleared" | "unknown";
  readiness: "low" | "normal" | "high" | "unknown";
  recentTwoSuccessfulCardio: boolean | null;
  latestCardioDifficulty: "easy" | "moderate" | "hard" | "unknown";
}
export interface CardioBaselineInput {
  goal: Goal;
  minutesPerDay: number;
  slots: readonly { ordinal: number; day_offset: number; container: "S" | "C" | "H" }[];
  eligibility: CardioEligibility;
  /** Explicit original resistance exposure dates, including adjacent weeks. null means unknown. */
  lowerExposureDays: readonly number[] | null;
}
export interface CardioFallback {
  cause: "source_eligibility_fallback" | "redesign_recovery";
  source_day: CardioSourceDay;
  source_ordinal: number;
  original_descriptor: CardioBlockDescriptor;
  effective_descriptor: CardioBlockDescriptor;
}
export interface CardioSlotPlan {
  source_day: CardioSourceDay;
  source_ordinal: number;
  descriptor: CardioBlockDescriptor | null;
  cardio_fallback: CardioFallback | null;
}
export interface CardioTotals {
  total_sec: number;
  moderate_sec: number;
  vigorous_sec: number;
  light_sec: number;
  interval_work_sec: number;
  interval_rounds: number;
  long_sec: number;
}
export interface CardioBaselinePlan {
  slots: CardioSlotPlan[];
  interval_selected_ordinal: number | null;
  original_fallback_reason:
    "no_nonlong_C_slot" | "screening_or_history_not_cleared" | "lower_recovery_unavailable" | null;
  totals: CardioTotals;
}
export interface CardioCatalogEntry {
  id: string;
  modality: string | null;
  metric: string;
  equipment: string;
  mechanic: string | null;
  movementPattern: string | null;
  region: string | null;
  loadSemantics: string | null;
  defaultRepsLow: number | null;
  defaultRepsHigh: number | null;
  defaultTimeLowSec: number | null;
  defaultTimeHighSec: number | null;
  defaultStepKg: number | null;
  cardioMovementRegions: readonly string[];
  prescriptionKindsSupported: readonly string[];
  blockedReportedPainAreas: readonly string[];
}

const DAYS: readonly CardioSourceDay[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const MINUTES = [30, 45, 60, 75, 90];
// PROGRAM_V2_CONTRACT §2.7 N01–N05. Runtime never imports the golden fixture.
const DOSES: Record<Goal, { H: readonly number[]; C: readonly number[] | null }> = {
  diet: { H: [10, 15, 20, 25, 30], C: [15, 25, 35, 45, 55] },
  hypertrophy: { H: [5, 5, 10, 10, 15], C: null },
  strength: { H: [5, 5, 5, 10, 10], C: [10, 15, 20, 25, 30] },
  general_fitness: { H: [10, 10, 15, 20, 20], C: [15, 20, 30, 40, 45] },
  endurance: { H: [10, 15, 20, 25, 30], C: [15, 25, 35, 45, 55] },
};
const PAIN_AREAS = ["knee", "lower_back", "shoulder", "elbow", "wrist", "hip", "neck", "ankle"];

export class CardioPlanError extends Error {
  constructor(
    public override readonly cause: "metadata_unknown" | "cardio_unavailable" | "mixed_time_budget",
  ) {
    super(cause);
    this.name = "CardioPlanError";
  }
}

function steadyDescriptor(duration: number, long = false): CardioBlockDescriptor {
  return {
    kind: long ? "long" : "steady",
    duration_sec: duration,
    rpe_scale_id: "relative_effort_0_10_v1",
    target_rpe_low: 5,
    target_rpe_high: 6,
    work_sec: null,
    recovery_sec: null,
    rounds: null,
    final_recovery_included: null,
    recovery_rpe_low: null,
    recovery_rpe_high: null,
    long_session_flag: long,
    progression_axis: "duration_sec",
  };
}

function intervalDescriptor(index: number): CardioBlockDescriptor {
  const rounds = [6, 8, 10, 10, 10][index]!;
  return {
    kind: "interval",
    duration_sec: rounds * 120,
    rpe_scale_id: "relative_effort_0_10_v1",
    target_rpe_low: 7,
    target_rpe_high: 8,
    work_sec: 60,
    recovery_sec: 60,
    rounds,
    final_recovery_included: true,
    recovery_rpe_low: 2,
    recovery_rpe_high: 3,
    long_session_flag: false,
    progression_axis: "rounds",
  };
}

export function cardioTotals(slots: readonly CardioSlotPlan[]): CardioTotals {
  const totals: CardioTotals = {
    total_sec: 0,
    moderate_sec: 0,
    vigorous_sec: 0,
    light_sec: 0,
    interval_work_sec: 0,
    interval_rounds: 0,
    long_sec: 0,
  };
  for (const { descriptor } of slots) {
    if (descriptor === null) continue;
    mandatoryBlockSeconds([descriptor]);
    totals.total_sec += descriptor.duration_sec;
    if (descriptor.kind === "interval") {
      const work = descriptor.work_sec! * descriptor.rounds!;
      totals.vigorous_sec += work;
      totals.interval_work_sec += work;
      totals.interval_rounds += descriptor.rounds!;
      totals.light_sec += descriptor.recovery_sec! * descriptor.rounds!;
    } else {
      totals.moderate_sec += descriptor.duration_sec;
      if (descriptor.long_session_flag) totals.long_sec += descriptor.duration_sec;
    }
  }
  return totals;
}

/** Original .09.0 donors only: calendar/exposure facts are explicit inputs, never a health adapter. */
export function buildCardioBaseline(input: CardioBaselineInput): CardioBaselinePlan {
  const doseIndex = MINUTES.indexOf(input.minutesPerDay);
  const original = getProgramComposition({
    rulesVersion: RULES_BUNDLE_V2,
    goal: input.goal,
    daysPerWeek: input.slots.length,
  });
  if (
    doseIndex < 0 ||
    input.slots.map((slot) => slot.container).join("") !== original.composition ||
    input.slots.some(
      (slot, index) =>
        slot.ordinal !== index + 1 ||
        !Number.isInteger(slot.day_offset) ||
        slot.day_offset < 0 ||
        slot.day_offset > 6 ||
        (index > 0 && slot.day_offset <= input.slots[index - 1]!.day_offset),
    ) ||
    (input.lowerExposureDays !== null &&
      input.lowerExposureDays.some((day) => !Number.isSafeInteger(day)))
  ) {
    throw new CardioPlanError("metadata_unknown");
  }
  const slots: CardioSlotPlan[] = input.slots.map((slot) => {
    const long = input.goal === "endurance" && slot.ordinal === input.slots.length;
    const minutes =
      slot.container === "S"
        ? null
        : long
          ? (slot.container === "C" ? [15, 30, 40, 55, 70] : [10, 20, 30, 40, 50])[doseIndex]!
          : DOSES[input.goal][slot.container]![doseIndex]!;
    return {
      source_day: DAYS[slot.day_offset]!,
      source_ordinal: slot.ordinal,
      descriptor: minutes === null ? null : steadyDescriptor(minutes * 60, long),
      cardio_fallback: null,
    };
  });
  const candidates =
    input.goal === "hypertrophy" || input.goal === "strength"
      ? []
      : input.slots.filter(
          (slot) => slot.container === "C" && slots[slot.ordinal - 1]!.descriptor!.kind !== "long",
        );
  const eligible =
    input.eligibility.screening === "low_risk" &&
    (input.eligibility.readiness === "normal" || input.eligibility.readiness === "high") &&
    input.eligibility.recentTwoSuccessfulCardio === true &&
    (input.eligibility.latestCardioDifficulty === "easy" ||
      input.eligibility.latestCardioDifficulty === "moderate");
  const selected =
    eligible && input.lowerExposureDays !== null
      ? candidates.find((slot) =>
          input.lowerExposureDays!.every((day) => Math.abs(slot.day_offset - day) >= 2),
        )
      : undefined;
  const reason: CardioBaselinePlan["original_fallback_reason"] =
    candidates.length === 0
      ? "no_nonlong_C_slot"
      : !eligible || input.lowerExposureDays === null
        ? "screening_or_history_not_cleared"
        : selected
          ? null
          : "lower_recovery_unavailable";
  if (selected) slots[selected.ordinal - 1]!.descriptor = intervalDescriptor(doseIndex);
  else if (candidates.length > 0) {
    const fallbackSlot = slots[candidates[0]!.ordinal - 1]!;
    // The source under unknown/denied eligibility was always steady, not an invented interval.
    fallbackSlot.cardio_fallback = {
      cause: "source_eligibility_fallback",
      source_day: fallbackSlot.source_day,
      source_ordinal: fallbackSlot.source_ordinal,
      original_descriptor: { ...fallbackSlot.descriptor! },
      effective_descriptor: { ...fallbackSlot.descriptor! },
    };
  }
  return {
    slots,
    interval_selected_ordinal: selected?.ordinal ?? null,
    original_fallback_reason: reason,
    totals: cardioTotals(slots),
  };
}

/** D5(i) changes assignment, while retaining both source interval and same-slot steady donor. */
export function planCardioWeek(
  input: CardioBaselineInput & { rulesVersion: string },
): CardioBaselinePlan & { source_totals: CardioTotals } {
  if (input.rulesVersion !== RULES_BUNDLE_V2 && input.rulesVersion !== RULES_BUNDLE_V2_SPLIT)
    throw new RangeError("Unsupported cardio rules bundle");
  const source = buildCardioBaseline(input);
  const source_totals = { ...source.totals };
  if (
    input.rulesVersion === RULES_BUNDLE_V2_SPLIT &&
    [4, 5].includes(input.slots.length) &&
    source.interval_selected_ordinal !== null
  ) {
    const ordinal = source.interval_selected_ordinal;
    const slot = source.slots[ordinal - 1]!;
    const original_descriptor = { ...slot.descriptor! };
    // Look up the original C donor directly; redesigned H capacity must never change its dose.
    const effective_descriptor = steadyDescriptor(
      DOSES[input.goal].C![MINUTES.indexOf(input.minutesPerDay)]! * 60,
    );
    slot.descriptor = effective_descriptor;
    slot.cardio_fallback = {
      cause: "redesign_recovery",
      source_day: slot.source_day,
      source_ordinal: ordinal,
      original_descriptor,
      effective_descriptor: { ...effective_descriptor },
    };
    return { ...source, slots: source.slots, totals: cardioTotals(source.slots), source_totals };
  }
  return { ...source, source_totals };
}

/** N07 counts only known actual working resistance, including fullbody; cardio never contributes. */
export function collectLowerResistanceDays(
  input: readonly {
    day_offset: number;
    modality: string | null;
    region: string | null;
    workingSets: number;
  }[],
): number[] | null {
  const result = new Set<number>();
  for (const row of input) {
    if (
      !Number.isSafeInteger(row.day_offset) ||
      !Number.isSafeInteger(row.workingSets) ||
      row.workingSets < 0
    )
      return null;
    if (row.modality === "cardio" || row.modality === "mobility" || row.modality === "warmup")
      continue;
    if (row.modality !== "resistance") return null;
    if (row.workingSets === 0) continue;
    if (
      row.region !== "upper" &&
      row.region !== "lower" &&
      row.region !== "core" &&
      row.region !== "fullbody"
    )
      return null;
    if (row.region === "lower" || row.region === "fullbody") result.add(row.day_offset);
  }
  return [...result].sort((a, b) => a - b);
}

export function progressCardioDescriptor(
  descriptor: CardioBlockDescriptor,
  input: {
    recentTwoSuccessfulCardio: boolean | null;
    originalTotalSec: number;
    originalBudgetSec: number;
    recoverySatisfied: boolean | null;
  },
): CardioBlockDescriptor {
  mandatoryBlockSeconds([descriptor]);
  if (
    !Number.isSafeInteger(input.originalTotalSec) ||
    !Number.isSafeInteger(input.originalBudgetSec) ||
    input.originalTotalSec < descriptor.duration_sec ||
    input.originalBudgetSec <= 0
  )
    throw new CardioPlanError("metadata_unknown");
  if (input.originalTotalSec > input.originalBudgetSec)
    throw new CardioPlanError("mixed_time_budget");
  if (input.recentTwoSuccessfulCardio !== true || input.recoverySatisfied !== true)
    return { ...descriptor };
  if (descriptor.kind === "interval" && descriptor.rounds === 12) return { ...descriptor };
  const increment =
    descriptor.kind === "interval" ? descriptor.work_sec! + descriptor.recovery_sec! : 300;
  if (input.originalTotalSec + increment > input.originalBudgetSec) return { ...descriptor };
  return {
    ...descriptor,
    duration_sec: descriptor.duration_sec + increment,
    rounds: descriptor.kind === "interval" ? descriptor.rounds! + 1 : null,
  };
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

/** D7 is an exact allowlist, not an inference from an exercise's name or generic equipment. */
export function isCanonicalCardioCatalog(row: CardioCatalogEntry): boolean {
  return (
    row.id === "e_stationary_bike" &&
    row.modality === "cardio" &&
    row.metric === "time" &&
    row.equipment === "stationary_bike" &&
    [
      row.mechanic,
      row.movementPattern,
      row.region,
      row.loadSemantics,
      row.defaultRepsLow,
      row.defaultRepsHigh,
      row.defaultTimeLowSec,
      row.defaultTimeHighSec,
      row.defaultStepKg,
    ].every((value) => value === null) &&
    exactSet(row.cardioMovementRegions, ["lower"]) &&
    exactSet(row.prescriptionKindsSupported, ["steady_cardio", "interval_cardio"]) &&
    exactSet(row.blockedReportedPainAreas, PAIN_AREAS)
  );
}

export function selectCanonicalCardio<T extends CardioCatalogEntry>(input: {
  catalog: readonly T[];
  equipment: readonly string[] | null;
  painAreas: readonly string[] | null;
  currentPain: boolean | null;
}): T {
  if (
    input.currentPain === true ||
    input.painAreas?.some((area) => PAIN_AREAS.includes(area)) ||
    (input.equipment !== null && !input.equipment.includes("stationary_bike"))
  )
    throw new CardioPlanError("cardio_unavailable");
  if (
    input.equipment === null ||
    input.painAreas === null ||
    input.currentPain !== false ||
    input.painAreas.some((area) => !PAIN_AREAS.includes(area))
  )
    throw new CardioPlanError("metadata_unknown");
  const matches = input.catalog.filter((row) => row.id === "e_stationary_bike");
  if (matches.length === 0) throw new CardioPlanError("cardio_unavailable");
  if (matches.length !== 1 || !isCanonicalCardioCatalog(matches[0]!))
    throw new CardioPlanError("metadata_unknown");
  return matches[0]!;
}
