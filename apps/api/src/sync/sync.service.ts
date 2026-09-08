import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type PlannedSet, type SyncEntityType, type SyncOp } from "@prisma/client";
import { applyDisplayGate, displayGateState } from "shared";
import {
  loadKindForSnapshot,
  rawAssistanceSafetyStatus,
  recommendedActionFor,
  stateForReasonCode,
  toRawTargetRow,
} from "../programs/assistance-migration";
import { encryptNumber } from "../common/crypto/field-encryption";
import { isUtcToday } from "../common/date/utc-day";
import { PlannedSetFactory } from "../programs/planned-set.factory";
import { PrismaService } from "../prisma/prisma.service";
import { SessionsService } from "../sessions/sessions.service";
import { RecommendationService, requireHistory } from "../recommendation/recommendation.service";
import { type MutationDto, SyncRequestDto } from "./dto/sync-request.dto";
import { sourceRevision } from "../sessions/session-set-snapshot";
import type { SessionSetMetadata } from "../sessions/session-set-metadata";
import {
  lockMutationIdentities,
  lockCorrelationClaims,
  lockReceiptRows,
  sessionWriteTransaction,
  SessionLockHintChanged,
} from "../sessions/session-write-transaction";
import { SessionSetAppendService } from "../sessions/session-set-append.service";
import type { AppendSetDto } from "../sessions/dto/append-set.dto";
import { readCorrelationClaims } from "../sessions/session-set-receipt";
import { clientMutationCandidates, isServerSessionEditEvent } from "../sessions/session-edit-event";
import {
  SessionDependencyService,
  type DependencyConflict,
  type MutationResult,
} from "./session-dependency";

/**
 * **최초 시도를 포함한 총 시도 횟수**다. 유한해야 한다 — 무한 재시도는 장애를 지연시킬 뿐이다.
 * "재시도 횟수"로 읽으면 실제 시도가 하나 더 늘어난다(off-by-one).
 */
const SERIALIZATION_ATTEMPTS = 5;

type Conflict = DependencyConflict;
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
    private readonly recommendation: RecommendationService,
    private readonly appendSets: SessionSetAppendService,
    private readonly dependencies: SessionDependencyService,
  ) {}

  async sync(userId: string, dto: SyncRequestDto) {
    const applied = new Set<string>();
    const conflicts: Conflict[] = [];
    const changedSessions = new Set<string>();
    const mutationSessions = new Map<string, string>();
    const recommendations = new Map<string, unknown>();
    const completions = dto.mutations.filter(
      (mutation) => mutation.entity === "session" && !mutation.append_dependencies,
    );
    const routineMutations = dto.mutations.filter(
      (mutation) => mutation.entity === "session_routine",
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

    const routineMappings = await this.plannedSetMappings(
      userId,
      routineMutations.flatMap((mutation) => correlationsOf(mutation)),
    );
    const mappedIds = new Map(
      routineMappings.map((mapping) => [mapping.correlation_id, mapping.planned_set_id]),
    );

    let pending = dto.mutations.filter(
      (m) => m.entity === "session_set" || m.entity === "performed_set" || m.append_dependencies,
    );
    const pendingConflicts = new Map<string, Conflict>();
    const appendResults = new Map<
      string,
      { sessionId: string; correlationId: string; plannedSetId: string }
    >();
    // Each progressing pass removes at least one request. No-progress is a finite deferred reply.
    while (pending.length) {
      const next: MutationDto[] = [];
      for (const original of pending) {
        let result: MutationResult;
        if (original.entity === "session_set") {
          const append = await this.appendSets.apply(
            userId,
            original.entity_id,
            { ...original.payload, client_id: original.client_id } as AppendSetDto,
            original.updated_at,
          );
          result =
            append.status === "applied"
              ? { applied: true, sessionId: append.sessionId }
              : {
                  applied: false,
                  conflict: {
                    ...conflictOf(original, append.reason),
                    ...(append.status === "pending" ? { retryable: true } : {}),
                  },
                };
          if (append.status === "applied") appendResults.set(original.client_id, append);
        } else if (original.append_dependencies) {
          validateMutation(original);
          result = await this.dependencies.apply(
            userId,
            original,
            (tx, owner, mutation) =>
              mutation.entity === "performed_set"
                ? this.applyPerformed(tx, owner, mutation)
                : this.applySession(tx, owner, mutation),
            compare,
          );
        } else {
          // Preserve the existing non-dependent normalization and comparator policy.
          const authoritativeId =
            mappedIds.get(original.entity_id) ??
            (await this.plannedSetIdForCorrelation(userId, original.entity_id));
          result = await this.apply(
            userId,
            authoritativeId ? { ...original, entity_id: authoritativeId } : original,
          );
        }
        if (result.applied) {
          applied.add(original.client_id);
          pendingConflicts.delete(original.client_id);
          if (result.sessionId) {
            changedSessions.add(result.sessionId);
            mutationSessions.set(original.client_id, result.sessionId);
          }
        } else if (result.conflict) {
          pendingConflicts.set(original.client_id, {
            ...result.conflict,
            entity_id: original.entity_id,
          });
          if (result.conflict.retryable === true) next.push(original);
        }
      }
      if (next.length === pending.length) break;
      pending = next;
    }
    conflicts.push(...pendingConflicts.values());

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

    // Request mappings are independent of the changes page/cursor and are projected after facts.
    const planned_set_mappings = await this.plannedSetMappings(
      userId,
      routineMutations.flatMap(correlationsOf),
    );
    for (const result of appendResults.values()) {
      const session = await this.sessions.detail(userId, result.sessionId);
      const planned = session.planned_sets.find((row) => row.id === result.plannedSetId);
      if (planned)
        planned_set_mappings.push({
          correlation_id: result.correlationId,
          planned_set_id: planned.id,
          planned_set: planned,
        });
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
    // Replay is a current authoritative row, including actual completed facts and its full cohort.
    const authoritative = new Map<
      string,
      Awaited<ReturnType<SessionsService["detail"]>>["planned_sets"][number]
    >();
    for (const sessionId of new Set(rows.map((row) => row.sessionId))) {
      const session = await this.sessions.detail(userId, sessionId);
      for (const row of session.planned_sets) authoritative.set(row.id, row);
    }
    const byCorrelation = new Map(rows.map((row) => [row.clientCorrelationId, row]));
    return requested.flatMap((item) => {
      const row = byCorrelation.get(item.correlation_id);
      // A later routine snapshot in the same batch may legitimately remove an unperformed
      // provisional exercise. It has no remaining draft to remap, so no mapping is needed.
      if (!row) return [];
      const planned = authoritative.get(row.id);
      if (!planned) return [];
      if (planned.exercise_id !== item.exercise_id || planned.set_no !== item.set_no)
        throw new ConflictException("planned set correlation을 권위 ID로 확인하지 못했다.");
      return [
        {
          correlation_id: item.correlation_id,
          planned_set_id: row.id,
          planned_set: planned,
        },
      ];
    });
  }

  /**
   * 세션 쓰기는 공통 ReadCommitted tx의 잠금 뒤 다시 읽는다. 여전히 발생할 수 있는
   * 직렬화/유니크 충돌과 변경된 routing hint는 전체 tx를 처음부터 유한 재시도한다.
   * 같은 mutation 은 멱등(client_id 로 판정)이라 재시도해도 두 번 적용되지 않는다.
   */
  private async apply(
    userId: string,
    mutation: MutationDto,
  ): Promise<{ applied: boolean; sessionId?: string; conflict?: Conflict }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.applyOnce(userId, mutation);
      } catch (error) {
        // P2034 = 직렬화 실패, P2002 = 유니크 충돌. 기존 총 5회 예산 안에서 routing hint와
        // 잠금 뒤 권위 행을 다시 읽어 멱등 경로(적용됨/conflict)를 재평가한다.
        const retryable =
          error instanceof SessionLockHintChanged ||
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2034" ||
              error.code === "P2002" ||
              (error.code === "P2010" && error.meta?.code === "40001")));
        if (!retryable || attempt >= SERIALIZATION_ATTEMPTS - 1) throw error;
      }
    }
  }

  private async applyOnce(
    userId: string,
    mutation: MutationDto,
  ): Promise<{ applied: boolean; sessionId?: string; conflict?: Conflict }> {
    validateMutation(mutation);
    try {
      const sessionHint = await this.sessionFor(userId, mutation);
      if (!sessionHint) throw new NotFoundException("계획 세트를 찾을 수 없다.");
      return await sessionWriteTransaction(
        this.prisma,
        userId,
        sessionHint,
        [{ clientId: mutation.client_id, entity: mutation.entity, entityId: mutation.entity_id }],
        async (tx, lockedSession) => {
          const correlationIds =
            mutation.entity === "session_routine"
              ? [
                  ...lockedSession.plannedSets.flatMap((row) =>
                    row.clientCorrelationId ? [row.clientCorrelationId] : [],
                  ),
                  ...correlationsOf(mutation).map((row) => row.correlation_id),
                ]
              : [];
          await lockCorrelationClaims(tx, correlationIds);
          const claims = await readCorrelationClaims(tx, correlationIds);
          await lockReceiptRows(tx, [mutation.client_id, ...claims.map((row) => row.receipt.id)]);
          const existing = await tx.syncMutation.findUnique({ where: { id: mutation.client_id } });
          if (existing) {
            if (existing.requestHash !== null || isServerSessionEditEvent(existing))
              return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
            if (existing.userId !== userId)
              return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
            if (!sameMutation(existing, mutation))
              return { applied: false, conflict: conflictOf(mutation, "client_id_mismatch") };
            return existing.status === "applied"
              ? { applied: true, sessionId: lockedSession.id }
              : { applied: false, conflict: conflictOf(mutation, "stale_update") };
          }
          const latest = await tx.syncMutation.findFirst({
            where: {
              ...clientMutationCandidates(lockedSession.id),
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
          const sessionId = lockedSession.id;
          if (mutation.entity === "performed_set") await this.applyPerformed(tx, userId, mutation);
          const routineIdentity =
            mutation.entity === "session_routine"
              ? await this.applyRoutine(tx, userId, mutation)
              : {};
          if (mutation.entity === "session") await this.applySession(tx, userId, mutation);
          await tx.syncMutation.create({
            data: { ...mutationRow(userId, mutation, "applied"), ...routineIdentity },
          });
          return { applied: true, sessionId };
        },
        false,
      );
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
      if (existing && (existing.requestHash || isServerSessionEditEvent(existing)))
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
    await lockMutationIdentities(tx, userId, [
      { clientId: mutation.client_id, entity: mutation.entity, entityId: mutation.entity_id },
    ]);
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
  ): Promise<{
    correlationClaims: Prisma.InputJsonValue;
    tombstoneIdentity: Prisma.InputJsonValue;
  }> {
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
    const removedIdentities = session.plannedSets
      .filter((row) => removed.includes(row.id))
      .map((row) => ({
        planned_set_id: row.id,
        correlation_id: row.clientCorrelationId,
        exercise_id: row.exerciseId,
      }));
    if (
      removed.length &&
      (await tx.performedSet.count({ where: { plannedSetId: { in: removed } } }))
    )
      throw new ConflictException("이미 수행 기록이 있는 운동은 루틴에서 뺄 수 없다.");
    // assistance_audits 는 FK 가 RESTRICT 라 planned row 보다 먼저 지운다(F-3 fixup).
    await tx.assistanceAudit.deleteMany({ where: { plannedSetId: { in: removed } } });
    await tx.plannedSet.deleteMany({ where: { id: { in: removed } } });

    // **새로 들어오는 종목만** 모아 루프 전에 한 번 읽는다. 종목마다 읽으면 그 자체로 N+1 이다.
    //
    // TOCTOU 경계: 이 prefetch 는 **같은 트랜잭션(`tx`)** 에서 읽는다. 바깥 클라이언트로 읽으면
    // 이 트랜잭션이 방금 지운 행이 아직 보이거나(스냅샷 차이) 잠금 밖에서 읽어 결과가 흔들린다.
    // 읽는 대상은 **다른 완료 세션의 수행 기록**이라 이 트랜잭션의 쓰기와 겹치지 않는다.
    const newExerciseIds = exerciseIds.filter((id) => !current.has(id));
    const newCatalog = new Map(
      (await tx.exercise.findMany({ where: { id: { in: newExerciseIds } } })).map((row) => [
        row.id,
        row,
      ]),
    );
    const prefetched = await this.recommendation.prefetchHistories(
      userId,
      [...newCatalog.values()].map((row) => ({
        exerciseId: row.id,
        loadSemantics: row.loadSemantics,
      })),
      tx,
    );
    const calibration = await this.recommendation.calibrationFor(userId, tx);

    // correlation 중복 검사도 **루프 전에 한 번**이다. 종목마다 세면 그것만으로 N+1 이 된다.
    const newCorrelationIds = newExerciseIds.flatMap((id) =>
      (byExercise.get(id) ?? []).map((item) => item.correlation_id),
    );
    if ((await readCorrelationClaims(tx, newCorrelationIds)).length)
      throw new ConflictException("이미 생성 이력이 있는 correlation이다.");
    // 요청 내부 중복은 **DTO 검증이 유일한 owner** 다(도달 불가한 중복 방어를 두지 않는다).
    if (
      newCorrelationIds.length &&
      (await tx.plannedSet.count({ where: { clientCorrelationId: { in: newCorrelationIds } } }))
    )
      throw new ConflictException("이미 다른 planned set이 사용 중인 correlation이다.");

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
        // 카탈로그·이력 모두 루프 전에 읽었다. map miss 는 **fail closed** 다.
        const exercise = newCatalog.get(exerciseId);
        if (!exercise) throw new BadRequestException(`운동을 찾을 수 없다: ${exerciseId}`);
        const rows = await this.plannedSets.build({
          userId,
          goal: session.program.goal,
          exercise,
          orderIndex,
          sets: requested.length,
          // factory 안에서 읽지 않는다 — 여기서 명시적으로 넘긴다.
          history: requireHistory(prefetched, exerciseId),
          calibration,
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
    const created = await tx.plannedSet.findMany({
      where: {
        sessionId: session.id,
        clientCorrelationId: { in: newCorrelationIds },
      },
      orderBy: { id: "asc" },
    });
    return {
      correlationClaims: created.map((row) => ({
        correlation_id: row.clientCorrelationId!,
        session_id: session.id,
        exercise_id: row.exerciseId,
        planned_set_id: row.id,
        creation_revision: sourceRevision(row),
      })),
      tombstoneIdentity: { v: 1, removed_sets: removedIdentities },
    };
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
    tombstoneIdentity?: Prisma.JsonValue | null;
    requestIdentity: Prisma.JsonValue | null;
  },
  recommendation?: unknown,
): Change {
  const removed = asObject(row.tombstoneIdentity ?? null).removed_sets;
  const tombstones =
    row.entityType === "session_routine" && Array.isArray(removed) && removed.length
      ? { tombstones: removed }
      : {};
  if (isServerSessionEditEvent(row)) {
    return {
      entity: row.entityType,
      entity_id: row.entityId,
      op: row.op,
      data: tombstones,
      server_seq: row.serverSeq.toString(),
    };
  }
  return {
    entity: row.entityType,
    entity_id: row.entityId,
    op: row.op,
    data:
      row.op === "delete" && !Object.keys(tombstones).length
        ? null
        : {
            ...(row.op === "delete" ? {} : publicChangePayload(row.entityType, row.payload)),
            ...tombstones,
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

export function plannedSetResponse(
  set: PlannedSet,
  sampleCount: number,
  metadata?: SessionSetMetadata,
) {
  return {
    ...(metadata ?? {
      source_revision: sourceRevision(set),
      correlation_id: set.clientCorrelationId,
      append_eligibility: null,
    }),
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
    // 오프라인 미러도 같은 축을 받아야 predicate 를 돌릴 수 있다(F-4a, server-first 경계).
    load_kind: loadKindForSnapshot(set),
    recommendation_state: applyDisplayGate(sampleCount, stateForReasonCode(set.reasonCode)),
    assistance_provenance: set.assistanceProvenance,
    // action 은 처방 축이라 state/reason/weight 와 **같은 게이트**를 받는다.
    recommended_action: applyDisplayGate(
      sampleCount,
      recommendedActionFor(set.reasonCode, set.exerciseId, set.loadSemantics),
    ),
    // sync 로 만들어진 행은 아직 수행 사실이 없다(방금 생성된 planned row 의 매핑이다).
    assistance_safety_status: rawAssistanceSafetyStatus(toRawTargetRow(set, false)),
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
