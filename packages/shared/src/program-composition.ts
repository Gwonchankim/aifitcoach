import { RULES_BUNDLE_V2, RULES_BUNDLE_V2_SPLIT } from "./rules-version";
import type { Goal } from "./types";

export type SplitPreference = "balanced" | "upper_priority" | "lower_priority";
export type SessionContainer = "S" | "C" | "H";

/** Ordered composition only; no donor prescriptions or new calendar policy are inferred. */
const ORIGINAL: Record<Goal, readonly string[]> = {
  diet: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
  hypertrophy: ["SS", "SSH", "SSSH", "SSSSH", "SSSSHH"],
  strength: ["SS", "SSH", "SSSH", "SSSHC", "SSSSHC"],
  general_fitness: ["HH", "HHC", "SSCC", "SSHCC", "SSHHCC"],
  endurance: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
};
const REVISED: Record<Goal, readonly string[]> = {
  diet: ["HH", "HHC", "HHHH", "HHHHH", "HHCCCC"],
  hypertrophy: ["SS", "SSH", "SSSH", "SSSSH", "SSSSHH"],
  strength: ["SS", "SSH", "SSSH", "SSSHH", "SSSSHC"],
  general_fitness: ["HH", "HHC", "SSHH", "SSHHH", "SSHHCC"],
  endurance: ["HH", "HHC", "HHHH", "HHHHH", "HHCCCC"],
};

export interface ProgramSlotContext {
  ordinal: number;
  container: SessionContainer;
  /** Original .09.0 slot identity, retained when C becomes H. */
  sourceContainer: SessionContainer;
  resistanceFocus: "upper" | "lower" | null;
  /** Only redesigned 4/5-day calendars are defined by this policy. */
  dayOffset: number | null;
}

export interface ProgramCompositionInput {
  rulesVersion: string;
  goal: Goal;
  daysPerWeek: number;
  splitPreference?: SplitPreference;
}

export interface ProgramComposition {
  composition: string;
  slots: ProgramSlotContext[];
  split: {
    requested: SplitPreference | null;
    effective: SplitPreference | null;
    applicable: boolean;
    reason: "unsupported_days" | "legacy_bundle" | null;
  };
  /** D5(i): no newly assigned interval on redesigned 4/5-day schedules. */
  intervalAssignment: "not_applicable" | "unassigned_preserve_source";
}

export function getProgramComposition(input: ProgramCompositionInput): ProgramComposition {
  const { rulesVersion, goal, daysPerWeek, splitPreference } = input;
  if (rulesVersion !== RULES_BUNDLE_V2 && rulesVersion !== RULES_BUNDLE_V2_SPLIT) {
    throw new RangeError("Composition requires a supported V2 bundle");
  }
  if (
    !Object.hasOwn(ORIGINAL, goal) ||
    !Number.isInteger(daysPerWeek) ||
    daysPerWeek < 2 ||
    daysPerWeek > 6
  ) {
    throw new RangeError("Unsupported composition goal or days");
  }
  if (
    splitPreference !== undefined &&
    splitPreference !== "balanced" &&
    splitPreference !== "upper_priority" &&
    splitPreference !== "lower_priority"
  ) {
    throw new RangeError("Unsupported split preference");
  }
  const revised = rulesVersion === RULES_BUNDLE_V2_SPLIT;
  const applicable = revised && (daysPerWeek === 4 || daysPerWeek === 5);
  if (
    splitPreference !== undefined &&
    splitPreference !== "balanced" &&
    (!revised || daysPerWeek !== 5)
  ) {
    throw new RangeError("Priority split requires the revised five-day policy");
  }
  const original = ORIGINAL[goal][daysPerWeek - 2]!;
  const composition = (revised ? REVISED : ORIGINAL)[goal][daysPerWeek - 2]!;
  const effective = applicable ? (splitPreference ?? "balanced") : null;
  const days = daysPerWeek === 4 ? [0, 1, 3, 4] : [0, 1, 2, 4, 5];
  return {
    composition,
    slots: [...composition].map((container, index) => ({
      ordinal: index + 1,
      container: container as SessionContainer,
      sourceContainer: original[index] as SessionContainer,
      resistanceFocus: applicable
        ? index % 2 === (effective === "lower_priority" ? 1 : 0)
          ? "upper"
          : "lower"
        : null,
      dayOffset: applicable ? days[index]! : null,
    })),
    split: {
      requested: splitPreference ?? null,
      effective,
      applicable,
      reason: applicable ? null : revised ? "unsupported_days" : "legacy_bundle",
    },
    intervalAssignment: applicable ? "unassigned_preserve_source" : "not_applicable",
  };
}
