import { Injectable, NotFoundException } from "@nestjs/common";
import { applyDisplayGate, displayGateState } from "shared";
import type { DisplayGateState, Goal } from "shared";
import { isoDate, utcToday } from "../common/date/utc-day";
import { PrismaService } from "../prisma/prisma.service";
import { ProgramsService } from "../programs/programs.service";
import {
  RecommendationService,
  type ApiRecommendation,
} from "../recommendation/recommendation.service";
import { AggregationProjector, weekStart } from "./aggregation.projector";
import type { CompletionQueryDto } from "./dto/completion.query.dto";
import type { E1rmQueryDto } from "./dto/e1rm.query.dto";
import type { VolumeQueryDto } from "./dto/volume.query.dto";

const DAY_MS = 86_400_000;

export type RhythmState =
  | "unperformed"
  | "in_progress"
  | "completed"
  | "partial"
  | "rest"
  | "conflict"
  | "return_after_gap"
  | "scheduled";

export interface RhythmDay {
  date: string;
  state: RhythmState;
  session_id: string | null;
  focus: string | null;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: AggregationProjector,
    private readonly programs: ProgramsService,
    private readonly recommendations: RecommendationService,
  ) {}

  async e1rm(userId: string, query: E1rmQueryDto) {
    await this.projector.rebuildUser(userId);
    const sessions = await this.prisma.workoutSession.findMany({
      where: {
        status: "completed",
        program: { userId },
        plannedSets: {
          some: {
            exerciseId: query.exercise_id,
            performedSets: { some: { completed: true } },
          },
        },
      },
      select: { id: true, scheduledDate: true },
      orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
    });
    const sample_session_count = sessions.length;
    const gate_state = displayGateState(sample_session_count);
    const inRange = (date: Date) =>
      (!query.from || date >= dateOnly(query.from)) && (!query.to || date <= dateOnly(query.to));
    const observations = sessions
      .filter((session) => inRange(session.scheduledDate))
      .map((session) => ({ session_id: session.id, date: isoDate(session.scheduledDate) }));
    const rows = await this.prisma.estimated1rm.findMany({
      where: { userId, exerciseId: query.exercise_id },
      orderBy: [{ computedAt: "asc" }, { sessionId: "asc" }],
    });
    let previousBest: number | undefined;
    const projected = rows.map((row) => {
      const e1rm = Number(row.e1rm);
      const is_pr = previousBest !== undefined && e1rm > previousBest;
      previousBest = Math.max(previousBest ?? e1rm, e1rm);
      return {
        session_id: row.sessionId,
        date: isoDate(row.computedAt),
        e1rm,
        method: row.method,
        is_pr,
      };
    });

    const next = await this.nextRecommendation(userId, query.exercise_id);
    return {
      exercise_id: query.exercise_id,
      sample_session_count,
      gate_state,
      observations,
      points:
        gate_state === "ready" ? projected.filter((point) => inRange(dateOnly(point.date))) : [],
      next_recommendation: next
        ? { ...next, confidence: applyDisplayGate(sample_session_count, next.confidence) }
        : null,
    };
  }

  async volume(userId: string, query: VolumeQueryDto) {
    await this.projector.rebuildUser(userId);
    const program = await this.programs.ensureCurrentWindow(userId);
    const goal =
      program?.goal ?? (await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })).goal;
    const start = query.week_start ? weekStart(dateOnly(query.week_start)) : weekStart(utcToday());
    const count = query.weeks ?? 1;
    const end = addDays(start, count * 7);
    const rows = await this.prisma.muscleWeeklyLoad.findMany({
      where: { userId, weekStart: { gte: start, lt: end } },
      orderBy: [{ weekStart: "asc" }, { muscle: "asc" }],
    });
    const recommendation_range = rangeFor(goal);
    return {
      goal,
      recommendation_range,
      weeks: Array.from({ length: count }, (_unused, index) => {
        const current = addDays(start, index * 7);
        return {
          week_start: isoDate(current),
          muscles: rows
            .filter((row) => row.weekStart.getTime() === current.getTime())
            .map((row) => ({
              muscle: row.muscle,
              hard_sets: row.hardSets,
              volume_load: Number(row.volumeLoad),
              avg_rir: row.avgRir === null ? null : Number(row.avgRir),
              range_status: rangeStatus(row.hardSets, recommendation_range),
            })),
        };
      }),
    };
  }

  async completion(userId: string, query: CompletionQueryDto) {
    const program = await this.programs.ensureCurrentWindow(userId);
    if (!program) throw new NotFoundException("생성된 프로그램이 없다.");
    const current_week = lifecycleWeek(program.startedAt, program.totalWeeks, utcToday());
    const start = query.week_start ? weekStart(dateOnly(query.week_start)) : weekStart(utcToday());
    const count = query.weeks ?? 1;
    const end = addDays(start, count * 7);
    const sessions = await this.prisma.workoutSession.findMany({
      where: { programId: program.id, scheduledDate: { gte: start, lt: end } },
      include: {
        plannedSets: {
          select: { id: true, performedSets: { where: { completed: true }, select: { id: true } } },
        },
      },
      orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
    });
    const template = program.template as unknown as { day: string; focus: string }[];
    const templateByDay = new Map(template.map((item) => [item.day, item.focus]));
    const today = utcToday();
    return {
      program_id: program.id,
      started_at: isoDate(program.startedAt),
      total_weeks: program.totalWeeks,
      current_week,
      weeks: Array.from({ length: count }, (_unused, index) => {
        const startOfWeek = addDays(start, index * 7);
        const week_number = lifecycleWeek(program.startedAt, program.totalWeeks, startOfWeek);
        const days = Array.from({ length: 7 }, (_day, offset) => {
          const date = addDays(startOfWeek, offset);
          const actual = sessions.find(
            (session) => session.scheduledDate.getTime() === date.getTime(),
          );
          const focus = templateByDay.get(dayName(date)) ?? null;
          return rhythmDay(date, today, actual, focus);
        });
        const planned = template.length;
        const completed = sessions.filter(
          (session) =>
            session.origin === "planned" &&
            session.status === "completed" &&
            session.scheduledDate >= startOfWeek &&
            session.scheduledDate < addDays(startOfWeek, 7),
        ).length;
        return {
          week_start: isoDate(startOfWeek),
          week_number,
          completed,
          planned,
          rate: planned === 0 ? 0 : round2(completed / planned),
          days,
        };
      }),
    };
  }

  async primaryE1rm(userId: string): Promise<{
    exercise_id: string;
    sample_session_count: number;
    gate_state: DisplayGateState;
    latest_e1rm: number | null;
  } | null> {
    await this.projector.rebuildUser(userId);
    const latest = await this.prisma.estimated1rm.findFirst({
      where: { userId },
      orderBy: [{ computedAt: "desc" }, { exerciseId: "asc" }, { sessionId: "asc" }],
    });
    if (!latest) return null;
    const sessions = await this.prisma.workoutSession.count({
      where: {
        status: "completed",
        program: { userId },
        plannedSets: {
          some: {
            exerciseId: latest.exerciseId,
            performedSets: { some: { completed: true } },
          },
        },
      },
    });
    return {
      exercise_id: latest.exerciseId,
      sample_session_count: sessions,
      gate_state: displayGateState(sessions),
      latest_e1rm: applyDisplayGate(sessions, Number(latest.e1rm)),
    };
  }

  private async nextRecommendation(
    userId: string,
    exerciseId: string,
  ): Promise<ApiRecommendation | null> {
    const program = await this.programs.ensureCurrentWindow(userId);
    if (!program) return null;
    const sets = await this.prisma.plannedSet.findMany({
      where: {
        exerciseId,
        session: {
          programId: program.id,
          status: { not: "completed" },
          scheduledDate: { gte: utcToday() },
        },
      },
      orderBy: [{ session: { scheduledDate: "asc" } }, { setNo: "asc" }],
      include: { exercise: { select: { metric: true, defaultStepKg: true } } },
    });
    const first = sets[0];
    if (!first) return null;
    const sameSession = sets.filter((set) => set.sessionId === first.sessionId);
    return this.recommendations.plannedToApi(exerciseId, sameSession.length, first);
  }
}

function rhythmDay(
  date: Date,
  today: Date,
  session:
    | {
        id: string;
        focus: string;
        status: string;
        plannedSets: { id: string; performedSets: { id: string }[] }[];
      }
    | undefined,
  plannedFocus: string | null,
): RhythmDay {
  if (session) {
    const completedSets = session.plannedSets.filter((set) => set.performedSets.length > 0).length;
    const state: RhythmState =
      session.status === "completed"
        ? completedSets < session.plannedSets.length
          ? "partial"
          : "completed"
        : session.status === "in_progress"
          ? "in_progress"
          : date > today
            ? "scheduled"
            : "unperformed";
    return { date: isoDate(date), state, session_id: session.id, focus: session.focus };
  }
  if (plannedFocus !== null) {
    return {
      date: isoDate(date),
      state: date > today ? "scheduled" : "unperformed",
      session_id: null,
      focus: plannedFocus,
    };
  }
  return { date: isoDate(date), state: "rest", session_id: null, focus: null };
}

function rangeFor(goal: Goal): { min_hard_sets: number; max_hard_sets: number } | null {
  if (goal === "hypertrophy") return { min_hard_sets: 10, max_hard_sets: 20 };
  if (goal === "diet") return { min_hard_sets: 8, max_hard_sets: 14 };
  return null;
}

function rangeStatus(
  hardSets: number,
  range: { min_hard_sets: number; max_hard_sets: number } | null,
) {
  if (!range) return "not_applicable" as const;
  if (hardSets < range.min_hard_sets) return "below" as const;
  if (hardSets > range.max_hard_sets) return "above" as const;
  return "within" as const;
}

function lifecycleWeek(startedAt: Date, totalWeeks: number, date: Date): number {
  const elapsed = Math.floor((weekStart(date).getTime() - startedAt.getTime()) / (7 * DAY_MS));
  return Math.min(totalWeeks, Math.max(1, elapsed + 1));
}

function dayName(date: Date): string {
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getUTCDay()]!;
}

function dateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
