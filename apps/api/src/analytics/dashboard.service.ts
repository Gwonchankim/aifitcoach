import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** openapi: DashboardSummary.today.routine_summary / tomorrow.routine_summary */
export interface RoutineSummary {
  exercise_count: number;
  focus: string;
}

/** openapi: DashboardSummary.today.done_summary */
export interface DoneSummary {
  total_volume: number;
  sets_completed: number;
  pr_count: number;
}

/** openapi: components.schemas.DashboardSummary */
export interface DashboardResponse {
  date: string;
  today: {
    status: "workout" | "rest" | "done";
    /** 오늘 세션 id(대시보드 → 데일리 루틴 진입 경로). 휴식일이면 null. */
    session_id: string | null;
    routine_summary: RoutineSummary | null;
    done_summary: DoneSummary | null;
  };
  tomorrow: {
    status: "workout" | "rest";
    routine_summary: RoutineSummary | null;
  };
  streak_days: number;
  weekly_completion_rate: number;
}

interface SessionRow {
  id: string;
  scheduledDate: Date;
  status: string;
  focus: string;
}

const DAY_MS = 86_400_000;

/**
 * 대시보드 요약(FEATURES_UX F8).
 *
 * 스코프: **최신 프로그램 1개**(GET /programs/current 와 같은 프로그램)의 세션들만 본다.
 * 프로그램을 다시 만들면 이전 프로그램의 예정 세션이 남는데(생성이 지우지 않는다), 그걸 같이 세면
 * 오늘 세션이 둘이 되고 주간 완료율의 분모가 두 배가 된다. 예외는 PR 비교 이력 하나다(prCount 주석).
 *
 * 날짜 기준: **UTC**. 프로그램 생성이 UTC 월요일부터 세션을 펼치므로(ProgramsService.mondayOfWeek)
 * 여기서 다른 기준을 쓰면 "오늘 세션"이 scheduled_date 와 어긋난다.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<DashboardResponse> {
    const today = utcToday();
    // 테넌시: 여기서 정한 프로그램이 아래 모든 조회의 스코프다.
    const program = await this.prisma.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!program) return emptySummary(today);

    const sessions = await this.prisma.workoutSession.findMany({
      where: { programId: program.id },
      select: { id: true, scheduledDate: true, status: true, focus: true },
      orderBy: { scheduledDate: "asc" },
    });
    const todaySession = sessionOn(sessions, today);
    const tomorrowSession = sessionOn(sessions, addDays(today, 1));
    const counts = await this.exerciseCounts([todaySession, tomorrowSession]);

    return {
      date: isoDate(today),
      today: {
        status:
          todaySession === null ? "rest" : todaySession.status === "completed" ? "done" : "workout",
        session_id: todaySession?.id ?? null,
        routine_summary: routineSummary(todaySession, counts),
        done_summary:
          todaySession === null || todaySession.status !== "completed"
            ? null
            : await this.doneSummary(userId, todaySession.id, today),
      },
      tomorrow: {
        status: tomorrowSession === null ? "rest" : "workout",
        routine_summary: routineSummary(tomorrowSession, counts),
      },
      streak_days: streakDays(sessions, today),
      weekly_completion_rate: weeklyCompletionRate(sessions, today),
    };
  }

  /** 세션별 운동 수(계획세트의 서로 다른 exercise_id 수). 오늘·내일을 한 번에 읽어 N+1 을 피한다. */
  private async exerciseCounts(sessions: (SessionRow | null)[]): Promise<Map<string, number>> {
    const sessionIds = sessions.filter((session) => session !== null).map((session) => session.id);
    if (sessionIds.length === 0) return new Map();

    const rows = await this.prisma.plannedSet.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, exerciseId: true },
      distinct: ["sessionId", "exerciseId"],
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * 오늘 기록 요약(F6 운동 종료 요약과 같은 값).
   * 볼륨은 무게 축이 있는 세트만 더한다 — 맨몸·시간 종목은 actual_weight 가 null 이라 0을 곱하면
   * 볼륨이 사라진다(기술총괄 결정: 볼륨 산입 제외, 완료 세트 수에는 포함).
   */
  private async doneSummary(userId: string, sessionId: string, today: Date): Promise<DoneSummary> {
    const performed = await this.prisma.performedSet.findMany({
      where: { completed: true, plannedSet: { sessionId } },
      select: {
        actualWeight: true,
        actualReps: true,
        plannedSet: { select: { exerciseId: true } },
      },
    });

    let volume = 0;
    const bestToday = new Map<string, number>();
    for (const set of performed) {
      if (set.actualWeight === null || set.actualReps === null) continue;
      const weight = Number(set.actualWeight);
      volume += weight * set.actualReps;
      const exerciseId = set.plannedSet.exerciseId;
      bestToday.set(
        exerciseId,
        Math.max(bestToday.get(exerciseId) ?? 0, e1rm(weight, set.actualReps)),
      );
    }

    return {
      total_volume: round2(volume),
      sets_completed: performed.length,
      pr_count: await this.prCount(userId, bestToday, today),
    };
  }

  /**
   * PR = 오늘 그 종목의 최고 e1RM 이 **오늘 이전 내 모든 기록**의 최고 e1RM 을 넘긴 종목 수(종목당 1).
   * e1RM 은 Epley(`weight * (1 + reps/30)`, docs/RECOMMENDATION_ENGINE.md) — 무게만 보면 1회 고중량이
   * 반복 향상을 가려버린다. 기록이 처음인 종목은 "경신"이 아니라 세지 않는다(첫날 전 종목 PR 방지).
   *
   * 이력은 프로그램이 아니라 **사용자** 스코프다: 개인 기록은 프로그램을 다시 만들어도 이어진다.
   *
   * 최고값 집계를 DB 에서 한다(종목당 1행). 수행기록을 앱으로 다 끌어오면 1년치(약 3000행)에서
   * 대시보드 응답이 20ms → 300ms 로 늘어난다(측정). 산술은 JS 와 같은 float8 로 맞춘다.
   */
  private async prCount(
    userId: string,
    bestToday: Map<string, number>,
    today: Date,
  ): Promise<number> {
    if (bestToday.size === 0) return 0;

    const history = await this.prisma.$queryRaw<{ exercise_id: string; best_e1rm: number }[]>`
      SELECT ps.exercise_id,
             MAX(pf.actual_weight::float8 * (1 + pf.actual_reps::float8 / 30)) AS best_e1rm
      FROM performed_sets pf
      JOIN planned_sets ps ON ps.id = pf.planned_set_id
      JOIN workout_sessions ws ON ws.id = ps.session_id
      JOIN programs p ON p.id = ws.program_id
      -- 테넌시: 남의 기록은 내 PR 판정에 들어오지 않는다.
      WHERE p.user_id = ${userId}::uuid
        AND pf.completed
        AND pf.actual_weight IS NOT NULL
        AND pf.actual_reps IS NOT NULL
        AND ws.scheduled_date < ${isoDate(today)}::date
        AND ps.exercise_id IN (${Prisma.join([...bestToday.keys()])})
      GROUP BY ps.exercise_id`;

    const bestBefore = new Map(history.map((row) => [row.exercise_id, row.best_e1rm]));

    let count = 0;
    for (const [exerciseId, today1rm] of bestToday) {
      const before = bestBefore.get(exerciseId);
      if (before !== undefined && today1rm > before) count += 1;
    }
    return count;
  }
}

/** 프로그램이 없으면 오늘·내일 모두 휴식이고 지표는 0 이다(UX_STATES S3 빈 상태 ①). */
function emptySummary(today: Date): DashboardResponse {
  return {
    date: isoDate(today),
    today: { status: "rest", session_id: null, routine_summary: null, done_summary: null },
    tomorrow: { status: "rest", routine_summary: null },
    streak_days: 0,
    weekly_completion_rate: 0,
  };
}

function sessionOn(sessions: SessionRow[], date: Date): SessionRow | null {
  return sessions.find((session) => isoDate(session.scheduledDate) === isoDate(date)) ?? null;
}

/** 세션이 있으면 요약을 만든다(계획세트가 0개여도 키는 유지 — ADR-22). 없으면 null. */
function routineSummary(
  session: SessionRow | null,
  counts: Map<string, number>,
): RoutineSummary | null {
  if (session === null) return null;
  return { exercise_count: counts.get(session.id) ?? 0, focus: session.focus };
}

/**
 * 스트릭 = 오늘(오늘 기록이 아직 없으면 어제)부터 하루씩 거슬러 올라가며 센 **연속 완료 운동일 수**.
 * 계획이 없는 날(휴식일)은 끊지 않고 건너뛴다 — 주 4일 프로그램에서 휴식일이 끊으면 지표가 항상 1~2 에
 * 갇힌다. 계획이 있었는데 완료하지 않은 날에서 끊는다. 오늘은 아직 남았으므로 미완료여도 끊지 않는다.
 */
function streakDays(sessions: SessionRow[], today: Date): number {
  const earliest = sessions[0]?.scheduledDate;
  if (earliest === undefined) return 0;

  const completed = new Set(
    sessions
      .filter((session) => session.status === "completed")
      .map((s) => isoDate(s.scheduledDate)),
  );
  const scheduled = new Set(sessions.map((session) => isoDate(session.scheduledDate)));

  let cursor = completed.has(isoDate(today)) ? today : addDays(today, -1);
  let streak = 0;
  while (cursor.getTime() >= earliest.getTime()) {
    const day = isoDate(cursor);
    if (completed.has(day)) streak += 1;
    else if (scheduled.has(day)) break;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 이번 주(UTC 월~일) 완료 세션 / 예정 세션. 이번 주 계획이 0 이면 0 이다(UX_STATES S3 빈 상태 ③). */
function weeklyCompletionRate(sessions: SessionRow[], today: Date): number {
  const monday = mondayOfWeek(today).getTime();
  const nextMonday = monday + 7 * DAY_MS;
  const week = sessions.filter(
    (session) =>
      session.scheduledDate.getTime() >= monday && session.scheduledDate.getTime() < nextMonday,
  );
  if (week.length === 0) return 0;
  const done = week.filter((session) => session.status === "completed").length;
  return round2(done / week.length);
}

/** Epley e1RM — docs/RECOMMENDATION_ENGINE.md "e1RM (표시·추세)". RIR 보정은 쓰지 않는다(실측 기록 비교). */
function e1rm(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function mondayOfWeek(date: Date): Date {
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
