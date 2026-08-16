import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PlannedSet } from "@prisma/client";
import { applyDisplayGate, displayGateState } from "shared";
import type { DisplayGateState, Goal } from "shared";
import { encryptNumber } from "../common/crypto/field-encryption";
import { isUtcToday, utcToday } from "../common/date/utc-day";
import { PrismaService } from "../prisma/prisma.service";
import { AggregationProjector } from "../analytics/aggregation.projector";
import { PlannedSetFactory, PlannedSetRow } from "../programs/planned-set.factory";
import {
  MovementPattern,
  excludedPatternsFor,
  exerciseCountFor,
  patternsForBodyPart,
  prefersStableEquipment,
} from "../programs/program-rules";
import { DIFFICULTY_RANK, ProgramsService, selectExercises } from "../programs/programs.service";
import {
  ApiRecommendation,
  EngineTarget,
  RecommendationService,
  toHistory,
} from "../recommendation/recommendation.service";
import { AddExerciseDto } from "./dto/add-exercise.dto";
import { CompleteSessionDto } from "./dto/complete-session.dto";
import { CreateAdHocSessionDto } from "./dto/create-ad-hoc-session.dto";
import { SwapExerciseDto } from "./dto/swap-exercise.dto";

/** openapi: components.schemas.PlannedSet */
export interface PlannedSetResponse {
  id: string;
  exercise_id: string;
  set_no: number;
  /** metric=time 종목(e_plank)은 반복·RIR 축이 없다 → null + target_time_*_sec. */
  target_reps_low: number | null;
  target_reps_high: number | null;
  target_rir: number | null;
  rest_sec: number;
  target_time_low_sec: number | null;
  target_time_high_sec: number | null;
  /** null = 자체중량(맨몸·시간 종목). */
  recommended_weight: number | null;
  recommended_reps: number | null;
  reason_code: string | null;
  confidence: number | null;
  rules_version: string;
  recommendation_gate: DisplayGateState;
  performed_set: {
    actual_weight: number | null;
    actual_reps: number | null;
    actual_rir: number | null;
    actual_time_sec: number | null;
    completed: boolean;
    performed_at: string;
  } | null;
}

/** openapi: components.schemas.Session */
export interface SessionResponse {
  id: string;
  program_id: string;
  goal: Goal;
  scheduled_date: string;
  status: string;
  planned_sets: PlannedSetResponse[];
}

/** openapi: POST /sessions/{sessionId}/complete 200 응답 */
export interface CompleteSessionResponse {
  session: SessionResponse;
  next_recommendations: GatedRecommendation[];
}

export interface GatedRecommendation {
  exercise_id: string;
  sample_session_count: number;
  gate_state: DisplayGateState;
  recommendation: ApiRecommendation | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recommendation: RecommendationService,
    private readonly plannedSets: PlannedSetFactory,
    private readonly projector: AggregationProjector,
    private readonly programs: ProgramsService,
  ) {}

  async detail(userId: string, sessionId: string): Promise<SessionResponse> {
    return this.toResponse(userId, await this.load(userId, sessionId));
  }

  /** Sync writes can amend an already-completed same-day session; recompute once per batch. */
  async recomputeAfterSync(userId: string, sessionId: string): Promise<GatedRecommendation[]> {
    const session = await this.load(userId, sessionId);
    if (session.status === "completed") {
      const recommendations = await this.recompute(userId, session);
      await this.projector.recomputeSession(userId, session.id);
      return this.gateRecommendations(userId, recommendations);
    }
    return [];
  }

  /**
   * 운동 종료(FEATURES_UX F6/F7). 완료 체크된 세트만 추천 입력이 되고,
   * 같은 운동이 들어 있는 다음 세션의 recommended_* 를 재계산해 덮어쓴다.
   *
   * 재완료는 **멱등**이다(409 로 막지 않는다): STEP 6 오프라인 아웃박스가 같은 요청을 재전송하는데
   * 그때 피드백을 통째로 갈아끼우면 이미 저장된 pain(암호문)이 사라진다. 추천 재계산 입력(수행기록)이
   * 같으므로 결과도 같다.
   */
  async complete(
    userId: string,
    sessionId: string,
    dto: CompleteSessionDto,
  ): Promise<CompleteSessionResponse> {
    const session = await this.load(userId, sessionId);

    await this.prisma.workoutSession.update({
      where: { id: session.id },
      data: {
        status: "completed",
        // 최초 완료 시각을 보존한다(재시도가 기록을 앞당기거나 미루면 안 된다).
        completedAt: session.completedAt ?? new Date(),
        sessionFeedback: mergeFeedback(session.sessionFeedback, dto),
      },
    });

    const next_recommendations = await this.recompute(userId, session);
    await this.projector.recomputeSession(userId, session.id);
    return {
      session: await this.toResponse(userId, await this.load(userId, sessionId)),
      next_recommendations: await this.gateRecommendations(userId, next_recommendations),
    };
  }

  /**
   * 수행기록 → 다음 세션 추천 재계산. 종료(complete)와 **당일 종료 세션 수정**(F6-1)이 같이 쓴다.
   * 절대값 덮어쓰기 + 목표를 방금 수행한 세션에서 읽으므로 몇 번을 돌려도 결과가 같다(멱등).
   */
  private async recompute(
    userId: string,
    session: {
      id: string;
      programId: string;
      scheduledDate: Date;
      plannedSets: PlannedSet[];
      program: { goal: Goal };
    },
  ): Promise<ApiRecommendation[]> {
    const performed = await this.prisma.performedSet.findMany({
      where: { completed: true, plannedSet: { sessionId: session.id } },
      select: {
        actualWeight: true,
        actualReps: true,
        actualRir: true,
        actualTimeSec: true,
        painScore: true,
        plannedSet: { select: { exerciseId: true, setNo: true } },
      },
      orderBy: { plannedSet: { setNo: "asc" } },
    });

    const calibration = await this.recommendation.calibrationFor(userId);
    const performedByExercise = new Map<string, typeof performed>();
    for (const row of performed) {
      const rows = performedByExercise.get(row.plannedSet.exerciseId) ?? [];
      rows.push(row);
      performedByExercise.set(row.plannedSet.exerciseId, rows);
    }

    const next_recommendations: ApiRecommendation[] = [];
    for (const [exerciseId, rows] of performedByExercise) {
      const exercise = await this.prisma.exercise.findUniqueOrThrow({ where: { id: exerciseId } });
      const nextSession = await this.prisma.workoutSession.findFirst({
        where: {
          programId: session.programId,
          id: { not: session.id },
          status: { not: "completed" },
          scheduledDate: { gte: session.scheduledDate },
          plannedSets: { some: { exerciseId } },
        },
        orderBy: { scheduledDate: "asc" },
        include: { plannedSets: { where: { exerciseId }, orderBy: { setNo: "asc" } } },
      });
      const targetSets =
        nextSession?.plannedSets ??
        session.plannedSets.filter((set) => set.exerciseId === exerciseId);
      // 목표는 **방금 수행한 세션**의 계획세트에서 읽는다 — 사용자가 실제로 겨눈 값이고,
      // 다음 세션의 값을 읽으면 맨몸 REPS_UP_BODYWEIGHT/TIME_UP 처럼 목표 자체가 움직이는 종목에서
      // 아웃박스 재전송(재완료)이 두 번 진행돼 버린다.
      const performedTarget = session.plannedSets.find((set) => set.exerciseId === exerciseId);
      if (!performedTarget) continue;

      const recommendation = this.recommendation.recommend({
        goal: session.program.goal,
        exercise,
        target: toEngineTarget(performedTarget),
        history: toHistory(rows),
        ...(calibration ? { calibration } : {}),
      });

      if (nextSession) {
        await this.prisma.plannedSet.updateMany({
          where: { sessionId: nextSession.id, exerciseId },
          data: {
            recommendedWeight: recommendation.weight,
            recommendedReps: recommendation.reps_low ?? null,
            // 맨몸·시간 종목은 부하 대신 목표 범위 자체가 움직인다(REPS_UP_BODYWEIGHT/TIME_UP/TIME_DOWN).
            // 그 밖의 분기에서 엔진은 입력 목표를 그대로 돌려주므로 값이 바뀌지 않는다.
            targetRepsHigh: recommendation.reps_high ?? null,
            targetTimeLowSec: recommendation.time_low_sec ?? null,
            targetTimeHighSec: recommendation.time_high_sec ?? null,
            reasonCode: recommendation.reason_code,
            confidence: recommendation.confidence,
            rulesVersion: recommendation.rules_version,
          },
        });
      }
      next_recommendations.push(
        this.recommendation.toApi(exerciseId, targetSets.length, recommendation),
      );
    }

    return next_recommendations;
  }

  /**
   * F8-1 즉석 세션. 오늘(UTC) 날짜로 현재 프로그램에 세션을 만들고 고른 부위 루틴을 배정한다.
   * 종목 선택·목표·세트 수는 프로그램 생성과 같은 규칙(program-rules)이고,
   * 프로그램 생성 때 적용한 통증 부위 제외도 그대로 다시 적용한다(SAFETY_PAIN_MAPPING.md).
   */
  async createAdHoc(userId: string, dto: CreateAdHocSessionDto): Promise<SessionResponse> {
    await this.programs.ensureCurrentWindow(userId);
    const program = await this.prisma.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!program) {
      throw new NotFoundException("생성된 프로그램이 없다.");
    }
    const today = utcToday();
    // 오늘 세션이 둘이면 대시보드의 "오늘"이 갈라진다 → 만들지 않고 기존 세션으로 보낸다.
    // (여기 조회는 빠른 거절용이고, 실제 보장은 아래 트랜잭션 안의 재확인이 한다.)
    await this.assertNoSessionToday(this.prisma, program.id, today);

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // 통증 부위는 프로그램 생성 결과(excluded_exercises)에 남아 있는 값을 그대로 다시 쓴다.
    const painAreas = painAreasOf(program.excludedExercises);
    const excludedPatterns = excludedPatternsFor(painAreas);
    const catalog = await this.prisma.exercise.findMany();
    const allowed = catalog.filter(
      (exercise) => !excludedPatterns.has(exercise.movementPattern as MovementPattern),
    );
    // 제외로 후보가 모자라면 축소된 세션을 만든다(SAFETY_PAIN_MAPPING.md 규칙 2).
    // 다른 부위 종목으로 메우지 않는다 — 사용자가 고른 부위가 아닌 운동이 섞이면 선택의 의미가 없다.
    const exercises = selectExercises(
      allowed,
      patternsForBodyPart(dto.body_part),
      exerciseCountFor(program.minutesPerDay),
      {
        levelRank: DIFFICULTY_RANK[user.experienceLevel],
        preferStable: prefersStableEquipment(painAreas),
        substituteMuscles: new Set<string>(),
      },
    );

    const rows: PlannedSetRow[] = [];
    for (const [orderIndex, exercise] of exercises.entries()) {
      rows.push(
        ...(await this.plannedSets.build({ userId, goal: program.goal, exercise, orderIndex })),
      );
    }

    // 세션과 계획세트는 한 덩어리다(계획세트 없는 빈 세션이 남으면 오늘이 통째로 막힌다).
    const session = await this.prisma.$transaction(async (tx) => {
      // 동시 요청(더블 탭)이 둘 다 앞의 조회를 통과하면 오늘 세션이 두 개가 된다.
      // 프로그램 행을 잠그고 그 안에서 다시 확인한다 → 한 쪽만 만들고 다른 쪽은 409.
      await tx.$queryRaw`SELECT id FROM programs WHERE id = ${program.id}::uuid FOR UPDATE`;
      await this.assertNoSessionToday(tx, program.id, today);
      const created = await tx.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: today,
          // focus 는 계약상 자유 문자열이라 고른 부위를 그대로 남긴다(대시보드 routine_summary.focus).
          focus: dto.body_part,
          status: "scheduled",
          // 계획이 아니라 사용자가 그날 추가한 세션이다 → 대시보드가 "계획된 날"에서 뺀다(D-1).
          origin: "ad_hoc",
        },
      });
      await tx.plannedSet.createMany({
        data: rows.map((row) => ({ ...row, sessionId: created.id })),
      });
      return created;
    });

    return this.detail(userId, session.id);
  }

  /** 하루에 세션 하나 — 이미 있으면 409(F8-1: 기존 세션으로 이동). */
  private async assertNoSessionToday(
    client: Pick<PrismaService, "workoutSession">,
    programId: string,
    today: Date,
  ): Promise<void> {
    const existing = await client.workoutSession.findFirst({
      where: { programId, scheduledDate: today },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException("오늘은 이미 세션이 있다. 기존 세션에서 이어서 하면 된다.");
    }
  }

  /** F5 운동 추가. position 이 있으면 그 자리에 끼워 넣고 뒤 운동들을 한 칸 민다. */
  async addExercise(
    userId: string,
    sessionId: string,
    dto: AddExerciseDto,
  ): Promise<SessionResponse> {
    const session = await this.load(userId, sessionId);
    assertEditable(session);
    const exercise = await this.prisma.exercise.findUnique({ where: { id: dto.exercise_id } });
    if (!exercise) {
      // 카탈로그에 없는 exercise_id 는 "없는 리소스"가 아니라 잘못된 입력이다(제품 오너 확정).
      throw new BadRequestException(`운동을 찾을 수 없다: ${dto.exercise_id}`);
    }
    assertNotInSession(session.plannedSets, dto.exercise_id);

    const nextOrder = maxOrderIndex(session.plannedSets) + 1;
    const orderIndex = clamp(dto.position ?? nextOrder, 0, nextOrder);
    const rows = await this.plannedSets.build({
      userId,
      goal: session.program.goal,
      exercise,
      orderIndex,
      ...(dto.sets === undefined || dto.sets === null ? {} : { sets: dto.sets }),
    });

    await this.writeAtomically(
      [
        ...(orderIndex < nextOrder
          ? [
              this.prisma.plannedSet.updateMany({
                where: { sessionId: session.id, orderIndex: { gte: orderIndex } },
                data: { orderIndex: { increment: 1 } },
              }),
            ]
          : []),
        this.createPlannedSets(session.id, rows),
      ],
      dto.exercise_id,
    );

    return this.afterEdit(userId, sessionId);
  }

  /** F5 운동 삭제. 이미 수행 기록이 있으면 건강 기록을 지우지 않기 위해 409 로 거절한다. */
  async removeExercise(
    userId: string,
    sessionId: string,
    exerciseId: string,
  ): Promise<SessionResponse> {
    const session = await this.load(userId, sessionId);
    assertEditable(session);
    const ids = await this.removableSetIds(session.plannedSets, exerciseId);
    await this.prisma.plannedSet.deleteMany({ where: { sessionId: session.id, id: { in: ids } } });
    return this.afterEdit(userId, sessionId);
  }

  /** F5 운동 교체. 자리(orderIndex)와 세트 수는 유지하고 목표·추천값은 새 운동 기준으로 다시 계산한다. */
  async swapExercise(
    userId: string,
    sessionId: string,
    exerciseId: string,
    dto: SwapExerciseDto,
  ): Promise<SessionResponse> {
    const session = await this.load(userId, sessionId);
    assertEditable(session);
    const target = await this.prisma.exercise.findUnique({ where: { id: dto.to_exercise_id } });
    if (!target) {
      // 카탈로그에 없는 to_exercise_id 는 "없는 리소스"가 아니라 잘못된 입력이다(제품 오너 확정).
      throw new BadRequestException(`운동을 찾을 수 없다: ${dto.to_exercise_id}`);
    }
    if (dto.to_exercise_id !== exerciseId) {
      assertNotInSession(session.plannedSets, dto.to_exercise_id);
    }

    const replaced = session.plannedSets.filter((set) => set.exerciseId === exerciseId);
    const orderIndex = replaced[0]?.orderIndex ?? maxOrderIndex(session.plannedSets) + 1;
    const ids = await this.removableSetIds(session.plannedSets, exerciseId);

    const rows = await this.plannedSets.build({
      userId,
      goal: session.program.goal,
      exercise: target,
      orderIndex,
      sets: replaced.length,
    });

    await this.writeAtomically(
      [
        this.prisma.plannedSet.deleteMany({ where: { sessionId: session.id, id: { in: ids } } }),
        this.createPlannedSets(session.id, rows),
      ],
      dto.to_exercise_id,
    );

    return this.afterEdit(userId, sessionId);
  }

  /**
   * 편집 후 응답. **당일** 종료 세션을 고친 경우(F6-1) 종료 시의 추천 재계산을 그대로 다시 돌린다 —
   * 계획세트가 바뀌면 다음 세션에 나간 추천의 근거도 바뀌기 때문이다.
   * 재계산은 멱등이라 몇 번을 고쳐도 목표가 누적해서 올라가지 않는다.
   */
  private async afterEdit(userId: string, sessionId: string): Promise<SessionResponse> {
    const session = await this.load(userId, sessionId);
    if (session.status === "completed") {
      await this.recompute(userId, session);
    }
    return this.toResponse(userId, session);
  }

  /**
   * 편집의 쓰기들을 **하나의 트랜잭션**으로 실행한다. 묶지 않으면 앞 쓰기(교체의 삭제, 추가의 순서 밀기)만
   * 커밋된 채 뒤 생성이 유니크 제약에 걸려, 사용자는 실패(409) 응답을 받았는데 원래 운동이 사라진다
   * (최종 평가 EVAL-A1 데이터 손실).
   *
   * 앱 레벨 중복 가드(assertNotInSession)는 조회 → 삽입 사이에 경합 창이 있다.
   * 동시 요청이 둘 다 통과하면 DB 의 ux_planned_session_exercise_set 이 잡고, 그건 500 이 아니라 409 다.
   */
  private async writeAtomically(
    operations: Prisma.PrismaPromise<unknown>[],
    exerciseId: string,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(operations);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`이미 이 세션에 포함된 운동입니다: ${exerciseId}`);
      }
      throw error;
    }
  }

  private createPlannedSets(
    sessionId: string,
    rows: PlannedSetRow[],
  ): Prisma.PrismaPromise<unknown> {
    return this.prisma.plannedSet.createMany({
      data: rows.map((row) => ({ ...row, sessionId })),
    });
  }

  /** 지울 수 있는 계획세트 id 들. 없는 운동은 404, 이미 수행 기록이 있으면 409(건강 기록 보존). */
  private async removableSetIds(plannedSets: PlannedSet[], exerciseId: string): Promise<string[]> {
    const ids = plannedSets.filter((set) => set.exerciseId === exerciseId).map((set) => set.id);
    if (ids.length === 0) {
      throw new NotFoundException(`세션에 없는 운동이다: ${exerciseId}`);
    }
    const performed = await this.prisma.performedSet.count({
      where: { plannedSetId: { in: ids } },
    });
    if (performed > 0) {
      throw new ConflictException("이미 수행 기록이 있는 운동은 루틴에서 뺄 수 없다.");
    }
    return ids;
  }

  /** 소유권 확인은 여기 한 곳. 남의(또는 없는) 세션은 존재를 알리지 않고 404. */
  private async load(userId: string, sessionId: string) {
    if (!UUID_PATTERN.test(sessionId)) {
      throw new NotFoundException("세션을 찾을 수 없다.");
    }
    const session = await this.prisma.workoutSession.findFirst({
      where: { id: sessionId, program: { userId } },
      include: {
        program: true,
        plannedSets: {
          orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
          include: { performedSets: { orderBy: { performedAt: "desc" }, take: 1 } },
        },
      },
    });
    if (!session) {
      throw new NotFoundException("세션을 찾을 수 없다.");
    }
    return session;
  }

  private async toResponse(
    userId: string,
    session: Awaited<ReturnType<SessionsService["load"]>>,
  ): Promise<SessionResponse> {
    const counts = await this.completedSessionCounts(userId, [
      ...new Set(session.plannedSets.map((set) => set.exerciseId)),
    ]);
    return toSessionResponse(session, counts);
  }

  private async gateRecommendations(
    userId: string,
    recommendations: ApiRecommendation[],
  ): Promise<GatedRecommendation[]> {
    const counts = await this.completedSessionCounts(
      userId,
      recommendations.map((item) => item.exercise_id),
    );
    return recommendations.map((recommendation) => {
      const sample_session_count = counts.get(recommendation.exercise_id) ?? 0;
      return {
        exercise_id: recommendation.exercise_id,
        sample_session_count,
        gate_state: displayGateState(sample_session_count),
        recommendation: applyDisplayGate(sample_session_count, recommendation),
      };
    });
  }

  /** D-39 count unit: distinct completed workout sessions, never performed-set count. */
  async completedSessionCounts(
    userId: string,
    exerciseIds: string[],
  ): Promise<Map<string, number>> {
    if (exerciseIds.length === 0) return new Map();
    const sessions = await this.prisma.workoutSession.findMany({
      where: {
        status: "completed",
        program: { userId },
        plannedSets: {
          some: { exerciseId: { in: exerciseIds }, performedSets: { some: { completed: true } } },
        },
      },
      select: {
        plannedSets: {
          where: {
            exerciseId: { in: exerciseIds },
            performedSets: { some: { completed: true } },
          },
          select: { exerciseId: true },
        },
      },
    });
    const counts = new Map<string, number>();
    for (const session of sessions) {
      for (const exerciseId of new Set(session.plannedSets.map((set) => set.exerciseId))) {
        counts.set(exerciseId, (counts.get(exerciseId) ?? 0) + 1);
      }
    }
    return counts;
  }
}

/**
 * 편집 가능 여부는 **날짜** 기준이다(FEATURES_UX F6-1).
 * 당일 세션은 종료 후에도 고칠 수 있다 — 끝내고 더 하거나 잘못 입력한 값을 고치는 일이 흔하다.
 * 다른 날짜의 종료된 세션은 읽기 전용이다: 이미 나간 추천의 근거(과거 계획세트)를 소급해 바꾸지 않는다 → 409.
 * "오늘"의 기준은 대시보드와 같은 UTC 다(common/date/utc-day).
 */
function assertEditable(session: { status: string; scheduledDate: Date }): void {
  if (session.status === "completed" && !isUtcToday(session.scheduledDate)) {
    throw new ConflictException("다른 날짜의 종료된 세션은 바꿀 수 없다.");
  }
}

/**
 * 프로그램 생성 때 쓴 통증 부위를 excluded_exercises(안전 근거)에서 되읽는다.
 * 제외된 운동이 0건인 부위(wrist)도 항목으로 남아 있으므로 여기서 같이 읽힌다(D-2).
 */
function painAreasOf(excludedExercises: Prisma.JsonValue): string[] {
  if (!Array.isArray(excludedExercises)) return [];
  const areas = excludedExercises
    .map((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as { pain_area?: unknown }).pain_area
        : undefined,
    )
    .filter((area): area is string => typeof area === "string");
  return [...new Set(areas)];
}

/**
 * 한 세션에 같은 exercise_id 는 1회만 — plannedExerciseId = exercise_id 라서 중복이 생기면
 * 세션 안에서 그 운동을 지목할 수 없다(하나를 지우면 둘 다 지워진다) → 409.
 */
function assertNotInSession(plannedSets: PlannedSet[], exerciseId: string): void {
  if (plannedSets.some((set) => set.exerciseId === exerciseId)) {
    throw new ConflictException(`이미 이 세션에 포함된 운동입니다: ${exerciseId}`);
  }
}

/**
 * 세션 피드백 병합. 요청 바디에 없는 키는 그대로 둔다 — 빈 바디 재완료가 이미 저장된
 * pain(암호문)을 지우면 건강 민감정보 유실이다(SECURITY_PIPA.md).
 * pain 은 DTO 검증 직후 암호화해서 넣는다.
 */
function mergeFeedback(
  existing: Prisma.JsonValue | null,
  dto: CompleteSessionDto,
): Prisma.InputJsonObject {
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Prisma.InputJsonObject)
      : {};
  return {
    ...base,
    ...(dto.difficulty === undefined ? {} : { difficulty: dto.difficulty }),
    ...(dto.pump === undefined ? {} : { pump: dto.pump }),
    ...(dto.pain === undefined ? {} : { pain: encryptNumber(dto.pain) }),
  };
}

/** planned_set 에 저장된 목표를 엔진 입력으로 되돌린다(반복 축과 시간 축은 배타적이다). */
function toEngineTarget(set: PlannedSet): EngineTarget {
  return {
    ...(set.targetRepsLow === null ? {} : { reps_low: set.targetRepsLow }),
    ...(set.targetRepsHigh === null ? {} : { reps_high: set.targetRepsHigh }),
    ...(set.targetRir === null ? {} : { rir: set.targetRir }),
    ...(set.targetTimeLowSec === null ? {} : { time_low_sec: set.targetTimeLowSec }),
    ...(set.targetTimeHighSec === null ? {} : { time_high_sec: set.targetTimeHighSec }),
  };
}

function maxOrderIndex(plannedSets: PlannedSet[]): number {
  return plannedSets.reduce((max, set) => Math.max(max, set.orderIndex), -1);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function toSessionResponse(
  session: {
    id: string;
    programId: string;
    scheduledDate: Date;
    status: string;
    plannedSets: (PlannedSet & {
      performedSets: {
        actualWeight: Prisma.Decimal | null;
        actualReps: number | null;
        actualRir: number | null;
        actualTimeSec: number | null;
        completed: boolean;
        performedAt: Date;
      }[];
    })[];
    program: { goal: Goal };
  },
  completedCounts: Map<string, number>,
): SessionResponse {
  return {
    id: session.id,
    program_id: session.programId,
    goal: session.program.goal,
    scheduled_date: session.scheduledDate.toISOString().slice(0, 10),
    status: session.status,
    planned_sets: session.plannedSets.map((set) => {
      const sampleCount = completedCounts.get(set.exerciseId) ?? 0;
      const performed = set.performedSets[0];
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
        performed_set: performed
          ? {
              actual_weight:
                performed.actualWeight === null ? null : Number(performed.actualWeight),
              actual_reps: performed.actualReps,
              actual_rir: performed.actualRir,
              actual_time_sec: performed.actualTimeSec,
              completed: performed.completed,
              performed_at: performed.performedAt.toISOString(),
            }
          : null,
      };
    }),
  };
}
