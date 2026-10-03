import { createHash } from "node:crypto";
import type { PlannedSet, WorkoutSession } from "@prisma/client";

export type WeekSwapAggregate = Pick<
  WorkoutSession,
  "id" | "programId" | "scheduledDate" | "status" | "focus" | "origin"
> & {
  plannedSets: (PlannedSet & {
    performedSets: {
      id: string;
      plannedSetId: string;
      updatedAt: Date;
      completed: boolean;
    }[];
  })[];
};

/** Explicit, versioned aggregate: no ORM enumeration order or transport projection is authoritative. */
export function weekSwapRevision(session: WeekSwapAggregate): string {
  const canonical = {
    id: session.id,
    programId: session.programId,
    scheduledDate: session.scheduledDate.toISOString().slice(0, 10),
    status: session.status,
    focus: session.focus,
    origin: session.origin,
    planned: [...session.plannedSets]
      .sort((a, b) => a.orderIndex - b.orderIndex || a.setNo - b.setNo || a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        clientCorrelationId: p.clientCorrelationId,
        sessionId: p.sessionId,
        exerciseId: p.exerciseId,
        orderIndex: p.orderIndex,
        setNo: p.setNo,
        targetRepsLow: p.targetRepsLow,
        targetRepsHigh: p.targetRepsHigh,
        targetRir: p.targetRir,
        restSec: p.restSec,
        targetTimeLowSec: p.targetTimeLowSec,
        targetTimeHighSec: p.targetTimeHighSec,
        recommendedWeight: p.recommendedWeight?.toString() ?? null,
        recommendedReps: p.recommendedReps,
        reasonCode: p.reasonCode,
        confidence: p.confidence?.toString() ?? null,
        rulesVersion: p.rulesVersion,
        loadSemantics: p.loadSemantics,
        assistanceStepKg: p.assistanceStepKg?.toString() ?? null,
        assistanceProvenance: p.assistanceProvenance,
        ...(p.prescriptionKind == null
          ? {}
          : {
              prescriptionKind: p.prescriptionKind,
              durationSec: p.durationSec,
              rpeScaleId: p.rpeScaleId,
              targetRpeLow: p.targetRpeLow,
              targetRpeHigh: p.targetRpeHigh,
              workSec: p.workSec,
              recoverySec: p.recoverySec,
              rounds: p.rounds,
              recoveryRpeLow: p.recoveryRpeLow,
              recoveryRpeHigh: p.recoveryRpeHigh,
              finalRecoveryIncluded: p.finalRecoveryIncluded,
              longSessionFlag: p.longSessionFlag,
              progressionAxis: p.progressionAxis,
              sourceDay: p.sourceDay,
              sourceOrdinal: p.sourceOrdinal,
              intensitySeconds: p.intensitySeconds,
              cardioFallback: p.cardioFallback,
            }),
        updatedAt: p.updatedAt.toISOString(),
        performed: [...p.performedSets]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((f) => ({
            id: f.id,
            plannedSetId: f.plannedSetId,
            updatedAt: f.updatedAt.toISOString(),
            completed: f.completed,
          })),
      })),
  };
  return `v1:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
