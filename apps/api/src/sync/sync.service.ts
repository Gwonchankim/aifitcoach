import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type PlannedSet, type SyncEntityType, type SyncOp } from "@prisma/client";
import { applyDisplayGate, displayGateState } from "shared";
import { encryptNumber } from "../common/crypto/field-encryption";
import { isUtcToday } from "../common/date/utc-day";
import { PlannedSetFactory } from "../programs/planned-set.factory";
import { PrismaService } from "../prisma/prisma.service";
import { SessionsService } from "../sessions/sessions.service";
import { type MutationDto, SyncRequestDto } from "./dto/sync-request.dto";

type Conflict = { client_id: string; entity_id: string; reason: string };
type Change = {
  entity: string;
  entity_id: string;
  op: string;
  data: Record<string, unknown> | null;
  server_seq: string;
};
type PlannedSetCorrelation = {
  correlation_id: string;
  exercise_id: string;
  set_no: number;
};

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plannedSets: PlannedSetFactory,
    private readonly sessions: SessionsService,
  ) {}

  async sync(userId: string, dto: SyncRequestDto) {
    const applied = new Set<string>();
    const conflicts: Conflict[] = [];
    const changedSessions = new Set<string>();
    const mutationSessions = new Map<string, string>();
    const recommendations = new Map<string, unknown>();
    const routineAndSets = dto.mutations.filter((mutation) => mutation.entity !== "session");
    const completions = dto.mutations.filter((mutation) => mutation.entity === "session");
    const routineMutations = routineAndSets.filter(
      (mutation) => mutation.entity === "session_routine",
    );
    const performedMutations = routineAndSets.filter(
      (mutation) => mutation.entity === "performed_set",
    );

    // D-24/D-31: routine correlations must exist before any provisional performed_set is resolved.
    for (const mutation of routineMutations) {
      const result = await this.apply(userId, mutation);
      if (result.applied) {
        applied.add(mutation.client_id);
        if (result.sessionId) {
          changedSessions.add(result.sessionId);
          mutationSessions.set(mutation.client_id, result.sessionId);
        }
      } else if (result.conflict) {
        conflicts.push(result.conflict);
      }
    }

    const planned_set_mappings = await this.plannedSetMappings(
      userId,
      routineMutations.flatMap((mutation) => correlationsOf(mutation)),
    );
    const mappedIds = new Map(
      planned_set_mappings.map((mapping) => [mapping.correlation_id, mapping.planned_set_id]),
    );

    for (const original of performedMutations) {
      // Normalize before locks, LWW lookup and audit persistence. A correlation UUID must never
      // become the server logical entity ID in performed_sets or sync_mutations.
      const authoritativeId =
        mappedIds.get(original.entity_id) ??
        (await this.plannedSetIdForCorrelation(userId, original.entity_id));
      const mutation = authoritativeId ? { ...original, entity_id: authoritativeId } : original;
      const result = await this.apply(userId, mutation);
      if (result.applied) {
        applied.add(original.client_id);
        if (result.sessionId) {
          changedSessions.add(result.sessionId);
          mutationSessions.set(original.client_id, result.sessionId);
        }
      } else if (result.conflict) {
        conflicts.push({ ...result.conflict, entity_id: original.entity_id });
      }
    }

    for (const mutation of completions) {
      const dependentConflict = conflicts.some(
        (conflict) => conflict.entity_id === mutation.entity_id,
      );
      // A routine conflict identifies the session directly; a set conflict is resolved to its owning session.
      const blocked =
        dependentConflict ||
        (await this.hasConflictingSetForSession(userId, mutation.entity_id, conflicts));
      const result = blocked
        ? await this.recordConflict(userId, mutation, "dependent_conflict")
        : await this.apply(userId, mutation);
      if (result.applied) {
        applied.add(mutation.client_id);
        changedSessions.add(mutation.entity_id);
        mutationSessions.set(mutation.client_id, mutation.entity_id);
      } else if (result.conflict) {
        conflicts.push(result.conflict);
      }
    }

    for (const sessionId of changedSessions) {
      const result = await this.sessions.recomputeAfterSync(userId, sessionId);
      for (const [mutationId, changedSessionId] of mutationSessions) {
        if (changedSessionId === sessionId) recommendations.set(mutationId, result);
      }
    }

    const since = parseCursor(dto.since);
    const rows = await this.prisma.syncMutation.findMany({
      where: { userId, status: "applied", ...(since === null ? {} : { serverSeq: { gt: since } }) },
      orderBy: { serverSeq: "asc" },
      take: 100,
    });
    const changes = rows.map((row) => toChange(row, recommendations.get(row.id)));
    const next_cursor = encodeCursor(rows.at(-1)?.serverSeq ?? since ?? 0n);
    return { applied: [...applied], conflicts, changes, planned_set_mappings, next_cursor };
  }

  private async plannedSetIdForCorrelation(
    userId: string,
    correlationId: string,
  ): Promise<string | undefined> {
    return (
      await this.prisma.plannedSet.findFirst({
        where: { clientCorrelationId: correlationId, session: { program: { userId } } },
        select: { id: true },
      })
    )?.id;
  }

  private async plannedSetMappings(userId: string, requested: PlannedSetCorrelation[]) {
    if (requested.length === 0) return [];
    const ids = [...new Set(requested.map((item) => item.correlation_id))];
    const rows = await this.prisma.plannedSet.findMany({
      where: { clientCorrelationId: { in: ids }, session: { program: { userId } } },
      orderBy: [{ exerciseId: "asc" }, { setNo: "asc" }],
    });
    const completedCounts = await this.sessions.completedSessionCounts(userId, [
      ...new Set(rows.map((row) => row.exerciseId)),
    ]);
    const byCorrelation = new Map(rows.map((row) => [row.clientCorrelationId, row]));
    return requested.flatMap((item) => {
      const row = byCorrelation.get(item.correlation_id);
      // A later routine snapshot in the same batch may legitimately remove an unperformed
      // provisional exercise. It has no remaining draft to remap, so no mapping is needed.
      if (!row) return [];
      if (row.exerciseId !== item.exercise_id || row.setNo !== item.set_no)
        throw new ConflictException("planned set correlation을 권위 ID로 확인하지 못했다.");
      return [
        {
          correlation_id: item.correlation_id,
          planned_set_id: row.id,
          planned_set: plannedSetResponse(row, completedCounts.get(row.exerciseId) ?? 0),
        },
      ];
    });
  }

  private async apply(
    userId: string,
    mutation: MutationDto,
  ): Promise<{ applied: boolean; sessionId?: string; conflict?: Conflict }> {
    validateMutation(mutation);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockMutation(tx, userId, mutation);
        const existing = await tx.syncMutation.findUnique({ where: { id: mutation.client_id } });
        if (existing) {
          if (existing.userId !== userId)
            return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
          if (!sameMutation(existing, mutation))
            return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
          return existing.status === "applied"
            ? { applied: true, sessionId: await this.sessionFor(userId, mutation) }
            : { applied: false, conflict: conflictOf(mutation, "stale_update") };
        }
        const latest = await tx.syncMutation.findFirst({
          where: {
            userId,
            entityType: mutation.entity,
            entityId: mutation.entity_id,
            status: "applied",
          },
          orderBy: [{ clientUpdatedAt: "desc" }, { id: "desc" }],
        });
        if (latest && compare(mutation, latest) <= 0) {
          await tx.syncMutation.create({ data: mutationRow(userId, mutation, "conflict") });
          return { applied: false, conflict: conflictOf(mutation, "stale_update") };
        }
        const sessionId = await this.sessionFor(userId, mutation);
        if (mutation.entity === "performed_set") await this.applyPerformed(tx, userId, mutation);
        if (mutation.entity === "session_routine") await this.applyRoutine(tx, userId, mutation);
        if (mutation.entity === "session") await this.applySession(tx, userId, mutation);
        await tx.syncMutation.create({ data: mutationRow(userId, mutation, "applied") });
        return { applied: true, sessionId };
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )
        return this.recordConflict(
          userId,
          mutation,
          error instanceof BadRequestException
            ? "validation_failed"
            : error instanceof NotFoundException
              ? "not_found"
              : "conflict",
        );
      throw error;
    }
  }

  private async recordConflict(userId: string, mutation: MutationDto, reason: string) {
    validateMutation(mutation);
    return this.prisma.$transaction(async (tx) => {
      await this.lockMutation(tx, userId, mutation);
      const existing = await tx.syncMutation.findUnique({
        where: { id: mutation.client_id },
      });
      if (existing?.userId !== undefined && existing.userId !== userId)
        return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
      if (existing && !sameMutation(existing, mutation))
        return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
      if (existing?.status === "applied")
        return {
          applied: true,
          sessionId: await this.sessionFor(userId, mutation),
        };
      if (!existing)
        await tx.syncMutation.create({ data: mutationRow(userId, mutation, "conflict") });
      return { applied: false, conflict: conflictOf(mutation, reason) };
    });
  }

  private async lockMutation(
    tx: Prisma.TransactionClient,
    userId: string,
    mutation: MutationDto,
  ): Promise<void> {
    // A mutation id is globally unique while LWW is tenant/entity scoped. Lock both in a
    // stable order so concurrent retries and two different entities reusing one id cannot
    // race either unique constraint or the logical-entity read/write section.
    const keys = [
      JSON.stringify(["client", mutation.client_id]),
      JSON.stringify(["entity", userId, mutation.entity, mutation.entity_id]),
    ].sort();
    for (const key of keys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private async applyPerformed(
    tx: Prisma.TransactionClient,
    userId: string,
    mutation: MutationDto,
  ): Promise<void> {
    const planned = await tx.plannedSet.findFirst({
      where: { id: mutation.entity_id, session: { program: { userId } } },
      include: { exercise: true },
    });
    if (!planned) throw new NotFoundException("계획 세트를 찾을 수 없다.");
    if (mutation.op === "delete") {
      await tx.performedSet.deleteMany({ where: { plannedSetId: planned.id } });
      return;
    }
    const payload = mutation.payload as PerformedPayload;
    validatePerformedForMetric(payload, planned.exercise.metric);
    await tx.performedSet.upsert({
      where: { plannedSetId: planned.id },
      create: {
        plannedSetId: planned.id,
        clientId: mutation.client_id,
        performedAt: new Date(mutation.updated_at),
        updatedAt: new Date(mutation.updated_at),
        actualWeight: payload.actual_weight ?? null,
        actualReps: payload.actual_reps ?? null,
        actualRir: payload.actual_rir ?? null,
        actualTimeSec: payload.actual_time_sec ?? null,
        painScore: encryptNumber(payload.pain_score ?? null),
        completed: payload.completed ?? false,
      },
      update: {
        actualWeight: payload.actual_weight ?? null,
        actualReps: payload.actual_reps ?? null,
        actualRir: payload.actual_rir ?? null,
        actualTimeSec: payload.actual_time_sec ?? null,
        painScore: encryptNumber(payload.pain_score ?? null),
        completed: payload.completed ?? false,
        performedAt: new Date(mutation.updated_at),
        updatedAt: new Date(mutation.updated_at),
      },
    });
  }

  private async applyRoutine(
    tx: Prisma.TransactionClient,
    userId: string,
    mutation: MutationDto,
  ): Promise<void> {
    const session = await tx.workoutSession.findFirst({
      where: { id: mutation.entity_id, program: { userId } },
      include: {
        program: true,
        plannedSets: { orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }] },
      },
    });
    if (!session) throw new NotFoundException("세션을 찾을 수 없다.");
    if (session.status === "completed" && !isUtcToday(session.scheduledDate))
      throw new ConflictException("다른 날짜의 종료된 세션은 바꿀 수 없다.");
    const exerciseIds =
      mutation.op === "delete" ? [] : (mutation.payload as RoutinePayload).exercise_ids;
    const correlations =
      mutation.op === "delete" ? [] : ((mutation.payload as RoutinePayload).correlations ?? []);
    const byExercise = new Map<string, PlannedSetCorrelation[]>();
    for (const correlation of correlations)
      byExercise.set(correlation.exercise_id, [
        ...(byExercise.get(correlation.exercise_id) ?? []),
        correlation,
      ]);
    const current = new Map<string, PlannedSet[]>();
    for (const set of session.plannedSets)
      current.set(set.exerciseId, [...(current.get(set.exerciseId) ?? []), set]);
    const removed = [...current.entries()]
      .filter(([id]) => !exerciseIds.includes(id))
      .flatMap(([, sets]) => sets.map((set) => set.id));
    if (
      removed.length &&
      (await tx.performedSet.count({ where: { plannedSetId: { in: removed } } }))
    )
      throw new ConflictException("이미 수행 기록이 있는 운동은 루틴에서 뺄 수 없다.");
    await tx.plannedSet.deleteMany({ where: { id: { in: removed } } });
    for (const [orderIndex, exerciseId] of exerciseIds.entries()) {
      const existing = current.get(exerciseId);
      const requested = [...(byExercise.get(exerciseId) ?? [])].sort((a, b) => a.set_no - b.set_no);
      if (existing) {
        if (
          requested.length > 0 &&
          (requested.length !== existing.length ||
            existing.some(
              (set) =>
                requested[set.setNo - 1]?.correlation_id !== set.clientCorrelationId ||
                requested[set.setNo - 1]?.set_no !== set.setNo,
            ))
        )
          throw new ConflictException("기존 planned set과 correlation snapshot이 일치하지 않는다.");
        await tx.plannedSet.updateMany({
          where: { id: { in: existing.map((set) => set.id) } },
          data: { orderIndex },
        });
      } else {
        if (requested.length === 0)
          throw new BadRequestException("새 운동은 planned set correlation이 필요하다.");
        if (requested.some((item, index) => item.set_no !== index + 1))
          throw new BadRequestException(
            "planned set correlation의 set_no는 1부터 연속이어야 한다.",
          );
        if (
          await tx.plannedSet.count({
            where: { clientCorrelationId: { in: requested.map((item) => item.correlation_id) } },
          })
        )
          throw new ConflictException("이미 다른 planned set이 사용 중인 correlation이다.");
        const exercise = await tx.exercise.findUnique({ where: { id: exerciseId } });
        if (!exercise) throw new BadRequestException(`운동을 찾을 수 없다: ${exerciseId}`);
        const rows = await this.plannedSets.build({
          userId,
          goal: session.program.goal,
          exercise,
          orderIndex,
          sets: requested.length,
        });
        await tx.plannedSet.createMany({
          data: rows.map((row) => ({
            ...row,
            sessionId: session.id,
            clientCorrelationId: requested[row.setNo - 1].correlation_id,
          })),
        });
      }
    }
  }

  private async applySession(
    tx: Prisma.TransactionClient,
    userId: string,
    mutation: MutationDto,
  ): Promise<void> {
    const session = await tx.workoutSession.findFirst({
      where: { id: mutation.entity_id, program: { userId } },
    });
    if (!session) throw new NotFoundException("세션을 찾을 수 없다.");
    if (mutation.op === "delete") throw new ConflictException("종료된 세션은 삭제할 수 없다.");
    const payload = mutation.payload as SessionPayload;
    await tx.workoutSession.update({
      where: { id: session.id },
      data: {
        status: "completed",
        completedAt: session.completedAt ?? new Date(mutation.updated_at),
        sessionFeedback: {
          ...asObject(session.sessionFeedback),
          ...(payload.difficulty === undefined ? {} : { difficulty: payload.difficulty }),
          ...(payload.pump === undefined ? {} : { pump: payload.pump }),
          ...(payload.pain === undefined ? {} : { pain: encryptNumber(payload.pain) }),
        },
      },
    });
  }

  private async sessionFor(userId: string, mutation: MutationDto): Promise<string | undefined> {
    if (mutation.entity !== "performed_set") return mutation.entity_id;
    return (
      await this.prisma.plannedSet.findFirst({
        where: { id: mutation.entity_id, session: { program: { userId } } },
        select: { sessionId: true },
      })
    )?.sessionId;
  }

  private async hasConflictingSetForSession(
    userId: string,
    sessionId: string,
    conflicts: Conflict[],
  ): Promise<boolean> {
    const ids = conflicts.map((conflict) => conflict.entity_id);
    if (ids.length === 0) return false;
    return (
      (await this.prisma.plannedSet.count({
        where: { id: { in: ids }, sessionId, session: { program: { userId } } },
      })) > 0
    );
  }
}

type PerformedPayload = {
  actual_weight?: number | null;
  actual_reps?: number | null;
  actual_rir?: number | null;
  actual_time_sec?: number | null;
  pain_score?: number | null;
  completed?: boolean;
};
type RoutinePayload = { exercise_ids: string[]; correlations?: PlannedSetCorrelation[] };
type SessionPayload = {
  status: "completed";
  difficulty?: "easy" | "moderate" | "hard";
  pump?: "low" | "medium" | "high";
  pain?: number;
};

function mutationRow(userId: string, mutation: MutationDto, status: "applied" | "conflict") {
  return {
    id: mutation.client_id,
    userId,
    entityType: mutation.entity as SyncEntityType,
    entityId: mutation.entity_id,
    op: mutation.op as SyncOp,
    payload: mutation.payload as Prisma.InputJsonValue,
    clientUpdatedAt: new Date(mutation.updated_at),
    appliedAt: status === "applied" ? new Date() : null,
    status,
  };
}
function conflictOf(mutation: MutationDto, reason: string): Conflict {
  return { client_id: mutation.client_id, entity_id: mutation.entity_id, reason };
}
function compare(mutation: MutationDto, latest: { clientUpdatedAt: Date; id: string }): number {
  const time = new Date(mutation.updated_at).getTime() - latest.clientUpdatedAt.getTime();
  return time || mutation.client_id.localeCompare(latest.id);
}
function parseCursor(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  const match = /^v1\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new BadRequestException("since 는 유효한 opaque cursor 여야 한다.");
  try {
    const token = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as unknown;
    if (
      !token ||
      typeof token !== "object" ||
      (token as { v?: unknown }).v !== 1 ||
      !/^\d+$/.test((token as { s?: unknown }).s as string)
    )
      throw new Error("invalid token");
    return BigInt((token as { s: string }).s);
  } catch {
    throw new BadRequestException("since 는 유효한 opaque cursor 여야 한다.");
  }
}
function encodeCursor(sequence: bigint): string {
  return `v1.${Buffer.from(JSON.stringify({ v: 1, s: sequence.toString() })).toString("base64url")}`;
}
function toChange(
  row: {
    id: string;
    entityType: string;
    entityId: string;
    op: string;
    payload: Prisma.JsonValue;
    serverSeq: bigint;
  },
  recommendation?: unknown,
): Change {
  return {
    entity: row.entityType,
    entity_id: row.entityId,
    op: row.op,
    data:
      row.op === "delete"
        ? null
        : {
            ...publicChangePayload(row.entityType, row.payload),
            ...(recommendation === undefined ? {} : { next_recommendations: recommendation }),
          },
    server_seq: row.serverSeq.toString(),
  };
}
function publicChangePayload(
  entityType: string,
  payload: Prisma.JsonValue,
): Record<string, unknown> {
  const value = asObject(payload);
  if (entityType !== "session_routine") return value;
  return { exercise_ids: value.exercise_ids };
}
function sameMutation(
  existing: {
    entityType: string;
    entityId: string;
    op: string;
    clientUpdatedAt: Date;
    payload: Prisma.JsonValue;
  },
  mutation: MutationDto,
): boolean {
  return (
    existing.entityType === mutation.entity &&
    existing.entityId === mutation.entity_id &&
    existing.op === mutation.op &&
    existing.clientUpdatedAt.getTime() === new Date(mutation.updated_at).getTime() &&
    stableJson(existing.payload) === stableJson(mutation.payload)
  );
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function validateMutation(m: MutationDto): void {
  if (m.op === "delete") {
    if (Object.keys(m.payload).length)
      throw new BadRequestException("delete payload 는 빈 객체여야 한다.");
    return;
  }
  const keys = Object.keys(m.payload);
  const allowed: Record<string, string[]> = {
    performed_set: [
      "actual_weight",
      "actual_reps",
      "actual_rir",
      "actual_time_sec",
      "pain_score",
      "completed",
    ],
    session_routine: ["exercise_ids", "correlations"],
    session: ["status", "difficulty", "pump", "pain"],
  };
  if (keys.some((key) => !allowed[m.entity].includes(key)))
    throw new BadRequestException("entity에 맞지 않는 payload 이다.");
  if (m.entity === "performed_set") validatePerformed(m.payload as PerformedPayload);
  if (m.entity === "session_routine") validateRoutine(m.payload as RoutinePayload);
  if (m.entity === "session" && (m.payload as SessionPayload).status !== "completed")
    throw new BadRequestException("session upsert 는 completed 상태만 허용한다.");
}
function validateRoutine(payload: RoutinePayload): void {
  if (
    !Array.isArray(payload.exercise_ids) ||
    new Set(payload.exercise_ids).size !== payload.exercise_ids.length ||
    !payload.exercise_ids.every((id) => typeof id === "string")
  )
    throw new BadRequestException("session_routine 은 고유한 exercise_ids snapshot 이 필요하다.");
  const correlations = payload.correlations ?? [];
  if (!Array.isArray(correlations))
    throw new BadRequestException("correlations는 배열이어야 한다.");
  const ids = new Set<string>();
  for (const item of correlations) {
    if (
      !item ||
      typeof item !== "object" ||
      !UUID_PATTERN.test(item.correlation_id) ||
      typeof item.exercise_id !== "string" ||
      !payload.exercise_ids.includes(item.exercise_id) ||
      !Number.isInteger(item.set_no) ||
      item.set_no < 1 ||
      item.set_no > 10 ||
      ids.has(item.correlation_id)
    )
      throw new BadRequestException("planned set correlation이 잘못되었다.");
    ids.add(item.correlation_id);
  }
}

function correlationsOf(mutation: MutationDto): PlannedSetCorrelation[] {
  if (mutation.entity !== "session_routine" || mutation.op === "delete") return [];
  return (mutation.payload as RoutinePayload).correlations ?? [];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plannedSetResponse(set: PlannedSet, sampleCount: number) {
  return {
    id: set.id,
    exercise_id: set.exerciseId,
    set_no: set.setNo,
    target_reps_low: set.targetRepsLow,
    target_reps_high: set.targetRepsHigh,
    target_rir: set.targetRir,
    rest_sec: set.restSec,
    target_time_low_sec: set.targetTimeLowSec,
    target_time_high_sec: set.targetTimeHighSec,
    recommended_weight: applyDisplayGate(
      sampleCount,
      set.recommendedWeight === null ? null : Number(set.recommendedWeight),
    ),
    recommended_reps: applyDisplayGate(sampleCount, set.recommendedReps),
    reason_code: applyDisplayGate(sampleCount, set.reasonCode),
    confidence: applyDisplayGate(sampleCount, Number(set.confidence)),
    rules_version: set.rulesVersion,
    recommendation_gate: displayGateState(sampleCount),
    performed_set: null,
  };
}
function validatePerformed(p: PerformedPayload): void {
  for (const key of [
    "actual_weight",
    "actual_reps",
    "actual_rir",
    "actual_time_sec",
    "pain_score",
  ] as const) {
    const value = p[key];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw new BadRequestException("performed_set payload 값이 잘못되었다.");
  }
  if (
    p.actual_rir !== undefined &&
    p.actual_rir !== null &&
    (!Number.isInteger(p.actual_rir) || p.actual_rir < 0 || p.actual_rir > 6)
  )
    throw new BadRequestException("actual_rir 범위가 잘못되었다.");
  if (
    p.pain_score !== undefined &&
    p.pain_score !== null &&
    (!Number.isInteger(p.pain_score) || p.pain_score < 0 || p.pain_score > 10)
  )
    throw new BadRequestException("pain_score 범위가 잘못되었다.");
  if (
    p.actual_time_sec !== undefined &&
    p.actual_time_sec !== null &&
    (!Number.isInteger(p.actual_time_sec) || p.actual_time_sec < 1)
  )
    throw new BadRequestException("actual_time_sec 범위가 잘못되었다.");
  if (p.completed !== undefined && typeof p.completed !== "boolean")
    throw new BadRequestException("completed 값이 잘못되었다.");
}
function validatePerformedForMetric(p: PerformedPayload, metric: string): void {
  if (p.completed !== true)
    throw new BadRequestException("performed_set upsert 는 completed=true 이어야 한다.");
  if (p.actual_weight !== undefined && p.actual_weight !== null && p.actual_weight < 0)
    throw new BadRequestException("actual_weight 는 0 이상이어야 한다.");
  if (metric === "reps") {
    if (!Number.isInteger(p.actual_reps) || (p.actual_reps as number) < 1)
      throw new BadRequestException("반복 종목은 양의 actual_reps 가 필요하다.");
    if (p.actual_time_sec !== undefined && p.actual_time_sec !== null)
      throw new BadRequestException("반복 종목에는 actual_time_sec 를 보낼 수 없다.");
  } else {
    if (!Number.isInteger(p.actual_time_sec) || (p.actual_time_sec as number) < 1)
      throw new BadRequestException("시간 종목은 양의 actual_time_sec 가 필요하다.");
    if (p.actual_reps !== undefined && p.actual_reps !== null)
      throw new BadRequestException("시간 종목에는 actual_reps 를 보낼 수 없다.");
  }
}
