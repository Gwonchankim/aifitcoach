import { Injectable } from "@nestjs/common";
import { isoDate, utcToday } from "../common/date/utc-day";
import { PrismaService } from "../prisma/prisma.service";
import { ProgramsService } from "../programs/programs.service";
import { AnalyticsService, type RhythmDay } from "./analytics.service";

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
    status:
      "unperformed" | "in_progress" | "done" | "partial" | "rest" | "conflict" | "return_after_gap";
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
  weekly_rhythm: RhythmDay[];
  primary_e1rm: {
    exercise_id: string;
    sample_session_count: number;
    gate_state: "no_history" | "early" | "ready";
    latest_e1rm: number | null;
  } | null;
}

interface SessionRow {
  id: string;
  scheduledDate: Date;
  status: string;
  focus: string;
  /** planned = 프로그램 계획, ad_hoc = 사용자가 그날 추가한 즉석 세션(F8-1). */
  origin: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly programs: ProgramsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async summary(userId: string): Promise<DashboardResponse> {
    const today = utcToday();
    await this.programs.ensureCurrentWindow(userId);
    // 테넌시: 여기서 정한 프로그램이 아래 모든 조회의 스코프다.
    const program = await this.prisma.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!program) return emptySummary(today);

    const sessions = await this.prisma.workoutSession.findMany({
      where: { programId: program.id },
      select: { id: true, scheduledDate: true, status: true, focus: true, origin: true },
      orderBy: { scheduledDate: "asc" },
    });
    const todaySession = sessionOn(sessions, today);
    const tomorrowSession = sessionOn(sessions, addDays(today, 1));
    const counts = await this.exerciseCounts([todaySession, tomorrowSession]);
    const completion = await this.analytics.completion(userId, {
      week_start: isoDate(mondayOfWeek(today)),
      weeks: 1,
    });
    const weekly_rhythm = completion.weeks[0]?.days ?? [];
    const todayState = weekly_rhythm.find((day) => day.date === isoDate(today))?.state;
    const primary_e1rm = await this.analytics.primaryE1rm(userId);

    return {
      date: isoDate(today),
      today: {
        status:
          todaySession === null
            ? "rest"
            : todayState === "completed"
              ? "done"
              : todayState === "partial"
                ? "partial"
                : todayState === "in_progress"
                  ? "in_progress"
                  : "unperformed",
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
      weekly_rhythm,
      primary_e1rm,
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
        plannedSet: { select: { exerciseId: true, loadSemantics: true } },
      },
    });

    let volume = 0;
    for (const set of performed) {
      // 어시스트 kg 은 **기계가 덜어준 무게**다 — 들어올린 볼륨이 아니다(§F).
      // 맨몸·시간 종목과 같은 취급: 볼륨에서 빼고 완료 세트 수에는 그대로 센다.
      if (set.plannedSet.loadSemantics === "assistance") continue;
      if (set.actualWeight === null || set.actualReps === null) continue;
      const weight = Number(set.actualWeight);
      volume += weight * set.actualReps;
    }

    return {
      total_volume: round2(volume),
      sets_completed: performed.length,
      pr_count: await this.prCount(userId, sessionId, today),
    };
  }

  /**
   * PR = 오늘 projector e1RM 이 **오늘 이전 내 모든 projector e1RM** 최고를 넘긴 종목 수(종목당 1).
   * raw Epley를 다시 계산하지 않고 추천 엔진과 같은 shared corrected-RIR 함수를 거친 derived row만 쓴다.
   * 기록이 처음인 종목은 "경신"이 아니라 세지 않는다(첫날 전 종목 PR 방지).
   *
   * 이력은 프로그램이 아니라 **사용자** 스코프다: 개인 기록은 프로그램을 다시 만들어도 이어진다.
   *
   * 기존 raw-Epley 파생값은 Sprint 2 backfill에서 projector 전체 rebuild로 교체한다.
   */
  private async prCount(userId: string, sessionId: string, today: Date): Promise<number> {
    const current = await this.prisma.estimated1rm.findMany({ where: { userId, sessionId } });
    if (current.length === 0) return 0;
    const history = await this.prisma.estimated1rm.findMany({
      where: {
        userId,
        exerciseId: { in: current.map((row) => row.exerciseId) },
        computedAt: { lt: today },
      },
    });
    const bestBefore = new Map<string, number>();
    for (const row of history) {
      bestBefore.set(
        row.exerciseId,
        Math.max(bestBefore.get(row.exerciseId) ?? Number.NEGATIVE_INFINITY, Number(row.e1rm)),
      );
    }

    let count = 0;
    for (const row of current) {
      const before = bestBefore.get(row.exerciseId);
      if (before !== undefined && Number(row.e1rm) > before) count += 1;
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
    weekly_rhythm: [],
    primary_e1rm: null,
  };
}

/** 프로그램 계획에서 나온 세션인가(즉석 세션 F8-1 은 아니다). */
function isPlanned(session: SessionRow): boolean {
  return session.origin === "planned";
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
 *
 * "계획된 날"은 **origin=planned 세션이 있는 날**이다. 즉석 세션(F8-1)은 계획이 아니므로 미완료로
 * 남아도 끊지 않는다 — 계획에 없던 운동을 더 하려 한 시도가 스트릭을 깨면 앱이 사용자를 처벌한다(D-1).
 * 완료한 즉석 세션은 그날을 운동일로 세므로 스트릭이 늘어난다.
 */
function streakDays(sessions: SessionRow[], today: Date): number {
  const earliest = sessions[0]?.scheduledDate;
  if (earliest === undefined) return 0;

  const completed = new Set(
    sessions
      .filter((session) => session.status === "completed")
      .map((s) => isoDate(s.scheduledDate)),
  );
  const planned = new Set(
    sessions.filter(isPlanned).map((session) => isoDate(session.scheduledDate)),
  );

  let cursor = completed.has(isoDate(today)) ? today : addDays(today, -1);
  let streak = 0;
  while (cursor.getTime() >= earliest.getTime()) {
    const day = isoDate(cursor);
    if (completed.has(day)) streak += 1;
    else if (planned.has(day)) break;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * 이번 주(UTC 월~일) 완료 세션 / 예정 세션. 이번 주 계획이 0 이면 0 이다(UX_STATES S3 빈 상태 ③).
 * 이 값은 **계획 준수율**이라 즉석 세션은 분모에도 분자에도 넣지 않는다: 분모만 늘리면 즉석 세션을
 * 만든 것 자체가 지표를 깎고(D-1 이중 처벌), 분자에 넣으면 계획을 다 지킨 주에 100% 를 넘는다.
 */
function weeklyCompletionRate(sessions: SessionRow[], today: Date): number {
  const monday = mondayOfWeek(today).getTime();
  const nextMonday = monday + 7 * DAY_MS;
  const week = sessions.filter(
    (session) =>
      isPlanned(session) &&
      session.scheduledDate.getTime() >= monday &&
      session.scheduledDate.getTime() < nextMonday,
  );
  if (week.length === 0) return 0;
  const done = week.filter((session) => session.status === "completed").length;
  return round2(done / week.length);
}

function mondayOfWeek(date: Date): Date {
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
