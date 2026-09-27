import { mandatoryBlockSeconds } from "./mixed-session-plan";
import type { CardioBlockDescriptor } from "./mixed-session-plan";
import type { CardioFallback, CardioSlotPlan, CardioSourceDay } from "./cardio-prescription";

export interface CardioIntensitySeconds {
  moderate: number;
  high: number;
  recovery: number;
}

export interface CardioSnapshot extends Omit<CardioBlockDescriptor, "kind"> {
  prescription_kind: "steady_cardio" | "interval_cardio";
  source_day: CardioSourceDay;
  source_ordinal: number;
  intensity_seconds: CardioIntensitySeconds;
  cardio_fallback: CardioFallback | null;
}

const DESCRIPTOR_FIELDS = [
  "kind",
  "duration_sec",
  "rpe_scale_id",
  "target_rpe_low",
  "target_rpe_high",
  "work_sec",
  "recovery_sec",
  "rounds",
  "final_recovery_included",
  "recovery_rpe_low",
  "recovery_rpe_high",
  "long_session_flag",
  "progression_axis",
] as const;
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const RESISTANCE_FIELDS = [
  "target_reps_low",
  "target_reps_high",
  "target_time_sec",
  "target_time_low_sec",
  "target_time_high_sec",
  "target_rir",
  "rest_sec",
  "recommended_weight",
  "recommended_reps",
  "confidence",
  "reason_code",
  "load_semantics",
  "assistance_step_kg",
  "assistance_machine_profile_id",
  "assistance_machine_profile_version",
  "assistance_snapshot",
  "calibration_gate",
  "weight_step_kg",
  "recommendation",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorEqual(left: CardioBlockDescriptor, right: CardioBlockDescriptor): boolean {
  return DESCRIPTOR_FIELDS.every((field) => left[field] === right[field]);
}

/** Reads every required field. Missing values are never defaulted or silently dropped. */
export function parseCardioDescriptor(value: unknown): CardioBlockDescriptor | null {
  if (!record(value) || DESCRIPTOR_FIELDS.some((field) => !Object.hasOwn(value, field)))
    return null;
  const descriptor = Object.fromEntries(
    DESCRIPTOR_FIELDS.map((field) => [field, value[field]]),
  ) as unknown as CardioBlockDescriptor;
  try {
    mandatoryBlockSeconds([descriptor]);
    if (descriptor.duration_sec > 2147483647) return null;
  } catch {
    return null;
  }
  return descriptor;
}

export function cardioIntensitySeconds(descriptor: CardioBlockDescriptor): CardioIntensitySeconds {
  mandatoryBlockSeconds([descriptor]);
  return descriptor.kind === "interval"
    ? {
        moderate: 0,
        high: descriptor.work_sec! * descriptor.rounds!,
        recovery: descriptor.recovery_sec! * descriptor.rounds!,
      }
    : { moderate: descriptor.duration_sec, high: 0, recovery: 0 };
}

function parseFallback(
  value: unknown,
  day: CardioSourceDay,
  ordinal: number,
  effective: CardioBlockDescriptor,
): CardioFallback | null | undefined {
  if (value === null) return null;
  if (
    !record(value) ||
    (value.cause !== "source_eligibility_fallback" && value.cause !== "redesign_recovery") ||
    value.source_day !== day ||
    value.source_ordinal !== ordinal
  )
    return undefined;
  const original_descriptor = parseCardioDescriptor(value.original_descriptor);
  const effective_descriptor = parseCardioDescriptor(value.effective_descriptor);
  if (
    !original_descriptor ||
    !effective_descriptor ||
    !descriptorEqual(effective, effective_descriptor)
  )
    return undefined;
  if (
    value.cause === "source_eligibility_fallback" &&
    (effective.kind !== "steady" || !descriptorEqual(original_descriptor, effective_descriptor))
  )
    return undefined;
  if (
    value.cause === "redesign_recovery" &&
    (original_descriptor.kind !== "interval" ||
      effective.kind !== "steady" ||
      effective.duration_sec <= original_descriptor.duration_sec)
  )
    return undefined;
  return {
    cause: value.cause,
    source_day: day,
    source_ordinal: ordinal,
    original_descriptor,
    effective_descriptor,
  };
}

/** Flat Program/Session/read-cache union payload; envelope IDs may surround these fields. */
export function parseCardioSnapshot(value: unknown): CardioSnapshot | null {
  if (
    !record(value) ||
    (value.prescription_kind !== "steady_cardio" &&
      value.prescription_kind !== "interval_cardio") ||
    typeof value.source_day !== "string" ||
    !DAYS.includes(value.source_day) ||
    typeof value.source_ordinal !== "number" ||
    !Number.isInteger(value.source_ordinal) ||
    value.source_ordinal < 1 ||
    value.source_ordinal > 6 ||
    RESISTANCE_FIELDS.some((field) => value[field] !== undefined && value[field] !== null)
  )
    return null;
  const descriptor = parseCardioDescriptor({
    ...value,
    kind:
      value.prescription_kind === "interval_cardio"
        ? "interval"
        : value.long_session_flag === true
          ? "long"
          : "steady",
  });
  if (!descriptor || !record(value.intensity_seconds)) return null;
  const intensity_seconds = cardioIntensitySeconds(descriptor);
  if (
    (Object.keys(intensity_seconds) as (keyof CardioIntensitySeconds)[]).some(
      (field) =>
        value.intensity_seconds &&
        (value.intensity_seconds as Record<string, unknown>)[field] !== intensity_seconds[field],
    )
  )
    return null;
  const source_day = value.source_day as CardioSourceDay;
  const cardio_fallback = parseFallback(
    value.cardio_fallback,
    source_day,
    value.source_ordinal,
    descriptor,
  );
  if (cardio_fallback === undefined) return null;
  const { kind: _kind, ...flat } = descriptor;
  return {
    ...flat,
    prescription_kind: value.prescription_kind,
    source_day,
    source_ordinal: value.source_ordinal,
    intensity_seconds,
    cardio_fallback,
  };
}

export function toCardioSnapshot(slot: CardioSlotPlan): CardioSnapshot {
  if (slot.descriptor === null) throw new RangeError("Resistance slot has no cardio snapshot");
  const snapshot = parseCardioSnapshot({
    ...slot.descriptor,
    prescription_kind: slot.descriptor.kind === "interval" ? "interval_cardio" : "steady_cardio",
    source_day: slot.source_day,
    source_ordinal: slot.source_ordinal,
    intensity_seconds: cardioIntensitySeconds(slot.descriptor),
    cardio_fallback: slot.cardio_fallback,
  });
  if (!snapshot) throw new RangeError("Invalid cardio snapshot");
  return snapshot;
}
