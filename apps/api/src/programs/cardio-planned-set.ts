import { BadRequestException } from "@nestjs/common";
import { Prisma, type Exercise } from "@prisma/client";
import {
  cardioIntensitySeconds,
  isCanonicalCardioCatalog,
  mandatoryBlockSeconds,
  parseCardioSnapshot,
  RULES_BUNDLE_V2,
  RULES_BUNDLE_V2_SPLIT,
  type CardioSlotPlan,
} from "shared";
import type { PlannedSetRow } from "./planned-set.factory";

/** One immutable block is one row. No resistance recommendation or health input is accepted. */
export function cardioPlannedSet(
  exercise: Exercise,
  slot: CardioSlotPlan,
  orderIndex: number,
  rulesVersion: string,
): PlannedSetRow {
  if (rulesVersion !== RULES_BUNDLE_V2 && rulesVersion !== RULES_BUNDLE_V2_SPLIT)
    throw new BadRequestException("유산소 처방을 지원하지 않는 규칙 버전입니다.");
  const descriptor = slot.descriptor;
  if (
    !descriptor ||
    !isCanonicalCardioCatalog({
      ...exercise,
      defaultStepKg: exercise.defaultStepKg === null ? null : Number(exercise.defaultStepKg),
    })
  )
    throw new BadRequestException("유산소 처방과 카탈로그가 일치하지 않습니다.");
  mandatoryBlockSeconds([descriptor]);
  return {
    exerciseId: exercise.id,
    orderIndex,
    setNo: 1,
    rulesVersion,
    prescriptionKind: descriptor.kind === "interval" ? "interval_cardio" : "steady_cardio",
    targetRepsLow: null,
    targetRepsHigh: null,
    targetTimeLowSec: null,
    targetTimeHighSec: null,
    targetRir: null,
    restSec: null,
    recommendedWeight: null,
    recommendedReps: null,
    reasonCode: null,
    confidence: null,
    loadSemantics: null,
    assistanceStepKg: null,
    assistanceProvenance: null,
    durationSec: descriptor.duration_sec,
    rpeScaleId: descriptor.rpe_scale_id,
    targetRpeLow: descriptor.target_rpe_low,
    targetRpeHigh: descriptor.target_rpe_high,
    workSec: descriptor.work_sec,
    recoverySec: descriptor.recovery_sec,
    rounds: descriptor.rounds,
    recoveryRpeLow: descriptor.recovery_rpe_low,
    recoveryRpeHigh: descriptor.recovery_rpe_high,
    finalRecoveryIncluded: descriptor.final_recovery_included,
    longSessionFlag: descriptor.long_session_flag,
    progressionAxis: descriptor.progression_axis,
    sourceDay: slot.source_day,
    sourceOrdinal: slot.source_ordinal,
    intensitySeconds: { ...cardioIntensitySeconds(descriptor) },
    cardioFallback:
      slot.cardio_fallback === null
        ? Prisma.DbNull
        : (JSON.parse(JSON.stringify(slot.cardio_fallback)) as Prisma.InputJsonObject),
  };
}

export function snapshotFromCardioRow(row: PlannedSetRow) {
  const result = parseCardioSnapshot({
    prescription_kind: row.prescriptionKind,
    duration_sec: row.durationSec,
    rpe_scale_id: row.rpeScaleId,
    target_rpe_low: row.targetRpeLow,
    target_rpe_high: row.targetRpeHigh,
    work_sec: row.workSec,
    recovery_sec: row.recoverySec,
    rounds: row.rounds,
    recovery_rpe_low: row.recoveryRpeLow,
    recovery_rpe_high: row.recoveryRpeHigh,
    final_recovery_included: row.finalRecoveryIncluded,
    long_session_flag: row.longSessionFlag,
    progression_axis: row.progressionAxis,
    source_day: row.sourceDay,
    source_ordinal: row.sourceOrdinal,
    intensity_seconds: row.intensitySeconds,
    cardio_fallback: row.cardioFallback === Prisma.DbNull ? null : row.cardioFallback,
  });
  if (!result) throw new BadRequestException("유산소 처방 snapshot을 읽을 수 없습니다.");
  return result;
}
