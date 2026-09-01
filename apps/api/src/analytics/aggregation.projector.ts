import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { estimateE1rm, type E1rmSet } from "shared";
import { PrismaService } from "../prisma/prisma.service";

export type ProjectorSet = {
  completed: boolean;
  weight: number | null;
  reps: number | null;
  rir: number | null;
  /**
   * 이 수행 행이 참조하는 **immutable PlannedSet snapshot**. 세트마다 다를 수 있다 —
   * 같은 운동이라도 과거 행과 새 행의 의미가 다르면 섞어 계산하면 안 된다.
   */
  loadSemantics?: "assistance" | "external_load";
};
export type ProjectorSession = {
  userId: string;
  sessionId: string;
  scheduledDate: Date;
  completed: boolean;
  exercises: {
    exerciseId: string;
    metric: string;
    hasExternalLoad: boolean;
    /**
     * 수행 행이 참조하는 **immutable PlannedSet snapshot**. 카탈로그의 현재 값이 아니다.
     *
     * 어시스트 종목의 kg 은 **기계가 덜어주는 무게**다. `hasExternalLoad` 는
     * `default_step_kg !== null` 이라 어시스트 머신에서도 참이고, 그대로 두면
     * **도움 20kg 이 20kg 을 들어올린 것으로 e1RM·볼륨에 들어간다**(§F 가 지목한 P0 결함).
     */
    loadSemantics?: "assistance" | "external_load";
    primaryMuscles: string[];
    sets: ProjectorSet[];
  }[];
};
export type E1rmProjection = {
  userId: string;
  exerciseId: string;
  sessionId: string;
  e1rm: number;
  computedAt: Date;
};
export type MuscleLoadProjection = {
  userId: string;
  weekStart: Date;
  muscle: string;
  hardSets: number;
  volumeLoad: number;
  avgRir: number | null;
};

/** Monday 00:00 UTC, matching workout_sessions.scheduled_date. */
export function weekStart(date: Date): Date {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value;
}

/** Pure source-fact projection shared by targeted recompute and full rebuild. */
export function projectFacts(sessions: ProjectorSession[]): {
  e1rm: E1rmProjection[];
  muscleLoad: MuscleLoadProjection[];
} {
  const e1rm: E1rmProjection[] = [];
  const buckets = new Map<string, { row: MuscleLoadProjection; rirs: number[] }>();
  const seenSessions = new Set<string>();
  const completedSessions = sessions
    .filter((item) => item.completed)
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.sessionId.localeCompare(b.sessionId));
  for (const session of completedSessions) {
    const sessionKey = `${session.userId}:${session.sessionId}`;
    if (seenSessions.has(sessionKey)) continue;
    seenSessions.add(sessionKey);
    for (const exercise of session.exercises) {
      // 도움 kg 은 들어올린 부하가 아니다 — e1RM·kg 볼륨에서 뺀다.
      // 세트 수(hardSets)와 RIR 평균은 **그대로 센다**: 그 세트는 실제로 수행됐다.
      const assistedSet = (set: ProjectorSet): boolean =>
        (set.loadSemantics ?? exercise.loadSemantics) === "assistance";
      if (exercise.metric === "reps" && exercise.hasExternalLoad) {
        const sets: E1rmSet[] = exercise.sets.flatMap((set) =>
          !assistedSet(set) &&
          set.completed &&
          set.weight !== null &&
          set.weight >= 0 &&
          set.reps !== null &&
          set.reps > 0
            ? [{ w: set.weight, reps: set.reps, ...(set.rir === null ? {} : { rir: set.rir }) }]
            : [],
        );
        const value = estimateE1rm(sets, 0);
        if (value !== undefined)
          e1rm.push({
            userId: session.userId,
            exerciseId: exercise.exerciseId,
            sessionId: session.sessionId,
            e1rm: value,
            computedAt: session.scheduledDate,
          });
      }
      for (const set of exercise.sets) {
        if (!set.completed) continue;
        for (const muscle of [...new Set(exercise.primaryMuscles)].sort()) {
          const start = weekStart(session.scheduledDate);
          const key = `${session.userId}:${start.toISOString()}:${muscle}`;
          const bucket = buckets.get(key) ?? {
            row: {
              userId: session.userId,
              weekStart: start,
              muscle,
              hardSets: 0,
              volumeLoad: 0,
              avgRir: null,
            },
            rirs: [],
          };
          if (set.rir !== null && set.rir >= 0 && set.rir <= 3) bucket.row.hardSets += 1;
          if (!assistedSet(set)) bucket.row.volumeLoad += (set.weight ?? 0) * (set.reps ?? 0);
          if (set.rir !== null) bucket.rirs.push(set.rir);
          buckets.set(key, bucket);
        }
      }
    }
  }
  return {
    e1rm: e1rm.sort(
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.exerciseId.localeCompare(b.exerciseId),
    ),
    muscleLoad: [...buckets.values()]
      .map(({ row, rirs }) => ({
        ...row,
        volumeLoad: round2(row.volumeLoad),
        avgRir: rirs.length
          ? round1(rirs.reduce((sum, value) => sum + value, 0) / rirs.length)
          : null,
      }))
      .sort(
        (a, b) =>
          a.userId.localeCompare(b.userId) ||
          a.weekStart.getTime() - b.weekStart.getTime() ||
          a.muscle.localeCompare(b.muscle),
      ),
  };
}

@Injectable()
export class AggregationProjector {
  constructor(private readonly prisma: PrismaService) {}

  /** D-34 migration/backfill entrypoint. Stable user ordering makes reruns auditable. */
  async rebuildAll(): Promise<number> {
    const programs = await this.prisma.program.findMany({
      select: { userId: true },
      distinct: ["userId"],
      orderBy: { userId: "asc" },
    });
    for (const { userId } of programs) await this.rebuildUser(userId);
    return programs.length;
  }

  async recomputeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const session = await tx.workoutSession.findFirst({
        where: { id: sessionId, program: { userId } },
        select: { scheduledDate: true },
      });
      if (!session) return;
      const start = weekStart(session.scheduledDate);
      const projection = projectFacts(await this.loadFacts(tx, userId, { week: start }));
      await tx.estimated1rm.deleteMany({ where: { userId, sessionId } });
      await tx.muscleWeeklyLoad.deleteMany({ where: { userId, weekStart: start } });
      await this.write(tx, {
        ...projection,
        e1rm: projection.e1rm.filter((row) => row.sessionId === sessionId),
      });
    });
  }

  /** Backfill entrypoint: rebuild all derived rows from performed_sets/workout_sessions. */
  async rebuildUser(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const projection = projectFacts(await this.loadFacts(tx, userId, {}));
      await tx.estimated1rm.deleteMany({ where: { userId } });
      await tx.muscleWeeklyLoad.deleteMany({ where: { userId } });
      await this.write(tx, projection);
    });
  }

  private async write(
    tx: Prisma.TransactionClient,
    projection: ReturnType<typeof projectFacts>,
  ): Promise<void> {
    if (projection.e1rm.length)
      await tx.estimated1rm.createMany({
        data: projection.e1rm.map((row) => ({
          ...row,
          e1rm: new Prisma.Decimal(row.e1rm),
          method: "epley_corrected_rir_v1",
        })),
      });
    if (projection.muscleLoad.length)
      await tx.muscleWeeklyLoad.createMany({
        data: projection.muscleLoad.map((row) => ({
          ...row,
          volumeLoad: new Prisma.Decimal(row.volumeLoad),
          avgRir: row.avgRir === null ? null : new Prisma.Decimal(row.avgRir),
        })),
      });
  }

  private async loadFacts(
    tx: Prisma.TransactionClient,
    userId: string,
    filter: { sessionIds?: string[]; week?: Date },
  ): Promise<ProjectorSession[]> {
    const nextWeek = filter.week ? new Date(filter.week.getTime() + 7 * 86_400_000) : undefined;
    const rows = await tx.workoutSession.findMany({
      where: {
        program: { userId },
        ...(filter.sessionIds ? { id: { in: filter.sessionIds } } : {}),
        ...(filter.week ? { scheduledDate: { gte: filter.week, lt: nextWeek } } : {}),
      },
      include: {
        plannedSets: {
          include: { exercise: true, performedSets: true },
          orderBy: [{ exerciseId: "asc" }, { setNo: "asc" }],
        },
      },
      orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
    });
    return rows.map((session) => ({
      userId,
      sessionId: session.id,
      scheduledDate: session.scheduledDate,
      completed: session.status === "completed",
      exercises: [...new Set(session.plannedSets.map((set) => set.exerciseId))].map(
        (exerciseId) => {
          const sets = session.plannedSets.filter((set) => set.exerciseId === exerciseId);
          const exercise = sets[0]!.exercise;
          return {
            exerciseId,
            metric: exercise.metric,
            hasExternalLoad: exercise.defaultStepKg !== null,
            // 카탈로그가 아니라 **저장된 planned snapshot** 이 원천이다(§F consumer 열거).
            loadSemantics: sets[0]!.loadSemantics,
            primaryMuscles: exercise.primaryMuscles,
            sets: sets.flatMap((set) =>
              set.performedSets.map((performed) => ({
                completed: performed.completed,
                loadSemantics: set.loadSemantics,
                weight: performed.actualWeight === null ? null : Number(performed.actualWeight),
                reps: performed.actualReps,
                rir: performed.actualRir,
              })),
            ),
          };
        },
      ),
    }));
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const key = JSON.stringify(["analytics-projector", userId]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
