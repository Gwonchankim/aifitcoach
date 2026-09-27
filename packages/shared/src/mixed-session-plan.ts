import { estimateSessionSeconds, packSession } from "./session-plan";
import type { PackInput, PackedExercise } from "./session-plan";

/** Explicit frozen donor input. This module does not generate or substitute cardio. */
export interface CardioBlockDescriptor {
  kind: "steady" | "long" | "interval";
  duration_sec: number;
  rpe_scale_id: "relative_effort_0_10_v1";
  target_rpe_low: number;
  target_rpe_high: number;
  work_sec: number | null;
  recovery_sec: number | null;
  rounds: number | null;
  final_recovery_included: boolean | null;
  recovery_rpe_low: number | null;
  recovery_rpe_high: number | null;
  long_session_flag: boolean;
  progression_axis: "duration_sec" | "rounds";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validates complete donor shape; null/unknown is never interpreted as zero. */
export function mandatoryBlockSeconds(blocks: readonly CardioBlockDescriptor[]): number {
  let total = 0;
  for (const block of blocks) {
    if (
      !block ||
      !positiveInteger(block.duration_sec) ||
      block.rpe_scale_id !== "relative_effort_0_10_v1"
    ) {
      throw new RangeError("Invalid mandatory cardio descriptor");
    }
    if (block.kind === "interval") {
      if (
        block.work_sec !== 60 ||
        block.recovery_sec !== 60 ||
        !positiveInteger(block.rounds) ||
        block.rounds > 12 ||
        block.duration_sec !== (block.work_sec + block.recovery_sec) * block.rounds ||
        block.target_rpe_low !== 7 ||
        block.target_rpe_high !== 8 ||
        block.recovery_rpe_low !== 2 ||
        block.recovery_rpe_high !== 3 ||
        block.final_recovery_included !== true ||
        block.long_session_flag !== false ||
        block.progression_axis !== "rounds"
      ) {
        throw new RangeError("Invalid mandatory interval descriptor");
      }
    } else if (block.kind === "steady" || block.kind === "long") {
      if (
        block.work_sec !== null ||
        block.recovery_sec !== null ||
        block.rounds !== null ||
        block.final_recovery_included !== null ||
        block.recovery_rpe_low !== null ||
        block.recovery_rpe_high !== null ||
        block.target_rpe_low !== 5 ||
        block.target_rpe_high !== 6 ||
        block.long_session_flag !== (block.kind === "long") ||
        block.progression_axis !== "duration_sec"
      ) {
        throw new RangeError("Invalid mandatory steady descriptor");
      }
    } else {
      throw new RangeError("Unknown mandatory cardio kind");
    }
    total += block.duration_sec;
    if (!Number.isSafeInteger(total)) throw new RangeError("Mandatory cardio duration overflow");
  }
  return total;
}

export class MixedSessionPlanError extends Error {
  constructor(public override readonly cause: "primary_unavailable" | "mixed_time_budget") {
    super(cause);
    this.name = "MixedSessionPlanError";
  }
}

export interface MixedSessionPlanInput extends Omit<PackInput, "additional_fixed_block_sec"> {
  mandatoryBlocks: readonly CardioBlockDescriptor[];
}

export interface MixedSessionPlan {
  resistance: PackedExercise[];
  resistanceWorkingSets: number;
  additional_fixed_block_sec: number;
  estimated_total_sec: number;
}

/** Mandatory blocks reduce time only. Their rounds never consume resistance working sets. */
export function planMixedSession(input: MixedSessionPlanInput): MixedSessionPlan {
  const additional_fixed_block_sec = mandatoryBlockSeconds(input.mandatoryBlocks);
  if (!input.candidates.some((candidate) => candidate.movement_pattern !== "core")) {
    throw new MixedSessionPlanError("primary_unavailable");
  }
  const resistance = packSession({
    candidates: input.candidates,
    minutesPerDay: input.minutesPerDay,
    restSec: input.restSec,
    additional_fixed_block_sec,
  });
  if (!resistance.some((item) => item.role === "primary" && item.sets >= 2)) {
    throw new MixedSessionPlanError("mixed_time_budget");
  }
  return {
    resistance,
    resistanceWorkingSets: resistance.reduce((total, item) => total + item.sets, 0),
    additional_fixed_block_sec,
    estimated_total_sec: estimateSessionSeconds({
      exercises: resistance.map((item) => ({
        sets: item.sets,
        reps_high: item.candidate.target_reps_high,
        time_high_sec: item.candidate.target_time_high_sec,
        unilateral: item.candidate.unilateral,
      })),
      restSec: input.restSec,
      additional_fixed_block_sec,
    }),
  };
}
