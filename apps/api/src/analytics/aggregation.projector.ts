import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { estimateE1rm, type E1rmSet } from "shared";
import { PrismaService } from "../prisma/prisma.service";

export type ProjectorSet = {
  completed: boolean;
  weight: number | null;
  reps: number | null;
  rir: number | null;
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
      if (exercise.metric === "reps" && exercise.hasExternalLoad) {
        const sets: E1rmSet[] = exercise.sets.flatMap((set) =>
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
          bucket.row.volumeLoad += (set.weight ?? 0) * (set.reps ?? 0);
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

  async recomputeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.workoutSession.findFirst({
      where: { id: sessionId, program: { userId } },
      select: { scheduledDate: true },
    });
    if (!session) return;
    const start = weekStart(session.scheduledDate);
    const projection = projectFacts(await this.loadFacts(userId, { week: start }));
    await this.prisma.$transaction(async (tx) => {
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
    const projection = projectFacts(await this.loadFacts(userId, {}));
    await this.prisma.$transaction(async (tx) => {
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
    userId: string,
    filter: { sessionIds?: string[]; week?: Date },
  ): Promise<ProjectorSession[]> {
    const nextWeek = filter.week ? new Date(filter.week.getTime() + 7 * 86_400_000) : undefined;
    const rows = await this.prisma.workoutSession.findMany({
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
            primaryMuscles: exercise.primaryMuscles,
            sets: sets.flatMap((set) =>
              set.performedSets.map((performed) => ({
                completed: performed.completed,
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
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
