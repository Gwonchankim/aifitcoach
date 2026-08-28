import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Exercise, Program } from "@prisma/client";
import { utcToday } from "../common/date/utc-day";
import { PrismaService } from "../prisma/prisma.service";
import { GenerateProgramDto } from "./dto/generate-program.dto";
import { PlannedSetFactory, PlannedSetRow } from "./planned-set.factory";
import {
  Focus,
  MovementPattern,
  RULES_VERSION,
  ScheduledDay,
  WEEKDAYS,
  excludedPatternsFor,
  exerciseCountFor,
  isStableEquipment,
  patternsFor,
  prefersStableEquipment,
  scheduleFor,
  splitTypeFor,
} from "./program-rules";

/** openapi: components.schemas.Program */
export interface ProgramResponse {
  program_id: string;
  goal: string;
  split_type: string;
  rules_version: string;
  started_at: string;
  total_weeks: number;
  current_week: number;
  status: "active" | "completed";
  /** pain_areas 로 후보에서 뺀 운동과 사유(docs/SAFETY_PAIN_MAPPING.md 규칙 3). */
  excluded_exercises: {
    exercise_id: string;
    pain_area: string;
    movement_pattern: string;
    reason: string;
  }[];
  sessions: {
    day: string;
    focus: string;
    exercises: {
      exercise_id: string;
      sets: number;
      /** metric=time 종목(e_plank)은 반복·RIR 축이 없다 → null + time_*_sec. */
      reps_low: number | null;
      reps_high: number | null;
      target_rir: number | null;
      rest_sec: number;
      time_low_sec: number | null;
      time_high_sec: number | null;
    }[];
  }[];
}

/** 현재 주와 다음 주만 materialize해 추천을 쓸 다음 세션을 확보한다. 12주 전체 생성은 금지한다(D-37). */
const MATERIALIZED_WEEK_WINDOW = 2;

/**
 * excluded_exercises 항목의 "제외한 운동 없음" 표시(exercise_id/movement_pattern).
 * 이 항목은 통증 부위를 기록하기 위한 것이라 API 응답에서는 걸러낸다(toResponse).
 */
const NO_EXCLUSION = "";

/** 난이도 서열(초급 < 중급 < 고급). 즉석 세션도 같은 서열로 종목을 고른다. */
export const DIFFICULTY_RANK = { beginner: 0, intermediate: 1, advanced: 2 } as const;

@Injectable()
export class ProgramsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plannedSets: PlannedSetFactory,
  ) {}

  async generate(userId: string, dto: GenerateProgramDto): Promise<ProgramResponse> {
    const schedule = scheduleFor(dto.days_per_week);
    const exerciseCount = exerciseCountFor(dto.minutes_per_day);
    const catalog = await this.prisma.exercise.findMany();

    if (catalog.length === 0) {
      throw new ServiceUnavailableException("운동 카탈로그가 준비되지 않았습니다.");
    }

    // equipment/avoid_exercises 로 먼저 거르고, 그 위에 통증 부위 제외(안전)를 얹는다.
    const available = catalog.filter(
      (exercise) =>
        !(dto.avoid_exercises ?? []).includes(exercise.id) &&
        ((dto.equipment ?? []).length === 0 || dto.equipment!.includes(exercise.equipment)),
    );
    const painAreas = dto.pain_areas ?? [];
    const excludedPatterns = excludedPatternsFor(painAreas);
    const removed = excludedExercises(available, excludedPatterns);
    // 저장용: 제외가 0건인 부위(wrist 등)도 항목을 남긴다 — 즉석 세션(F8-1)이 여기서 통증 부위를
    // 되읽어 머신/케이블 우선을 다시 적용한다(D-2). 응답에서는 toResponse 가 걸러낸다.
    const excluded = [...removed, ...painAreasWithoutExclusion(painAreas, removed)];
    const allowed = available.filter(
      (exercise) => !excludedPatterns.has(exercise.movementPattern as MovementPattern),
    );
    const options: SelectionOptions = {
      levelRank: DIFFICULTY_RANK[dto.experience_level],
      preferStable: prefersStableEquipment(painAreas),
      // 규칙 1: 제외로 부족하면 같은 근육군의 머신/케이블 종목으로 대체한다.
      substituteMuscles: new Set(removed.flatMap((item) => muscles(available, item.exercise_id))),
    };

    // focus 별 선택은 결정론적이므로 한 번만 계산해 같은 focus 인 날마다 재사용한다.
    const rowsByFocus = new Map<Focus, PlannedSetRow[]>();
    for (const { focus } of schedule) {
      if (rowsByFocus.has(focus)) continue;
      const exercises = selectExercises(allowed, patternsFor(focus), exerciseCount, options);
      // 통증 제외로 비었다면 에러 대신 축소된(빈) 세션을 만든다(SAFETY_PAIN_MAPPING.md 규칙 2).
      if (exercises.length === 0 && removed.length === 0) {
        throw new BadRequestException(
          `조건(equipment/avoid_exercises)에 맞는 ${focus} 운동이 없다.`,
        );
      }
      const rows: PlannedSetRow[] = [];
      for (const [orderIndex, exercise] of exercises.entries()) {
        rows.push(
          ...(await this.plannedSets.build({ userId, goal: dto.goal, exercise, orderIndex })),
        );
      }
      rowsByFocus.set(focus, rows);
    }

    // "오늘"은 utcToday() 한 곳에서만 온다 — 여기서 new Date() 를 쓰면 테스트의 날짜 고정(ADR-50)이
    // 프로그램 생성에만 안 먹어서 대시보드와 scheduled_date 가 어긋난다.
    const weekStart = mondayOfWeek(utcToday());
    // 프로그램·세션·계획세트는 한 덩어리다. 중간에 실패해 절반만 커밋되면 요일이 비거나 계획세트가 없는
    // 프로그램이 남고, current() 는 그 최신 프로그램을 그대로 돌려준다. 여기 쓰기 앞의 조회(카탈로그·
    // 추천 입력)는 이미 끝났으므로 트랜잭션은 쓰기만 감싼다.
    const program = await this.prisma.$transaction(async (tx) => {
      const created = await tx.program.create({
        data: {
          userId,
          goal: dto.goal,
          daysPerWeek: dto.days_per_week,
          minutesPerDay: dto.minutes_per_day,
          splitType: splitTypeFor(dto.days_per_week),
          rulesVersion: RULES_VERSION,
          startedAt: weekStart,
          totalWeeks: 12,
          status: "active",
          generationInput: {
            goal: dto.goal,
            days_per_week: dto.days_per_week,
            minutes_per_day: dto.minutes_per_day,
            experience_level: dto.experience_level,
            equipment: dto.equipment ?? [],
            avoid_exercises: dto.avoid_exercises ?? [],
            pain_areas: dto.pain_areas ?? [],
          },
          template: templateFor(schedule, rowsByFocus),
          excludedExercises: excluded,
        },
      });
      return created;
    });

    return this.toResponse(program);
  }

  async current(userId: string): Promise<ProgramResponse> {
    const program = await this.prisma.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!program) {
      throw new NotFoundException("생성된 프로그램이 없다.");
    }
    await this.materializeCurrentWindow(userId, program);
    return this.toResponse(program);
  }

  /**
   * Dashboard/analytics가 실제 세션을 읽기 전에 호출하는 lazy 경계. 프로그램 생성 POST는 lifecycle과
   * template만 저장하고 세션을 만들지 않는다. 첫 read에서 현재+다음 주만 생성하므로 미수행 미래 행을
   * 12주치 쌓지 않으면서도 추천 재계산이 쓸 다음 세션은 존재한다.
   */
  async ensureCurrentWindow(userId: string): Promise<Program | null> {
    const program = await this.prisma.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!program) return null;
    await this.materializeCurrentWindow(userId, program);
    return program;
  }

  private async materializeCurrentWindow(userId: string, program: Program): Promise<void> {
    const current = currentWeek(program.startedAt, program.totalWeeks, utcToday());
    const last = Math.min(program.totalWeeks, current + MATERIALIZED_WEEK_WINDOW - 1);
    for (let week = current; week <= last; week += 1) {
      await this.materializeWeek(userId, program, week);
    }
  }

  private async materializeWeek(userId: string, program: Program, week: number): Promise<void> {
    const template = program.template as unknown as ProgramSessionTemplate[];
    const candidates: { date: Date; focus: string; rows: PlannedSetRow[] }[] = [];
    for (const session of template) {
      const day = session.day as (typeof WEEKDAYS)[number];
      const date = addDays(program.startedAt, (week - 1) * 7 + WEEKDAYS.indexOf(day));
      const rows: PlannedSetRow[] = [];
      for (const [orderIndex, planned] of session.exercises.entries()) {
        const exercise = await this.prisma.exercise.findUniqueOrThrow({
          where: { id: planned.exercise_id },
        });
        rows.push(
          ...(await this.plannedSets.build({
            userId,
            goal: program.goal,
            exercise,
            orderIndex,
            sets: planned.sets,
          })),
        );
      }
      candidates.push({ date, focus: session.focus, rows });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM programs WHERE id = ${program.id}::uuid FOR UPDATE`;
      const existing = new Set(
        (
          await tx.workoutSession.findMany({
            where: {
              programId: program.id,
              scheduledDate: { in: candidates.map((item) => item.date) },
            },
            select: { scheduledDate: true },
          })
        ).map((session) => session.scheduledDate.toISOString().slice(0, 10)),
      );
      for (const candidate of candidates) {
        if (existing.has(candidate.date.toISOString().slice(0, 10))) continue;
        const session = await tx.workoutSession.create({
          data: {
            programId: program.id,
            scheduledDate: candidate.date,
            focus: candidate.focus,
            status: "scheduled",
          },
        });
        await tx.plannedSet.createMany({
          data: candidate.rows.map((row) => ({ ...row, sessionId: session.id })),
        });
      }
    });
  }

  /**
   * 프로그램 템플릿은 생성 시점에 고정된 값(programs.template)을 그대로 돌려준다.
   * 세션에서 되읽으면 세션 스코프 편집(F5)이 템플릿을 오염시킨다(STEP 4 평가 I-12).
   *
   * excluded_exercises 는 계약상 "제외된 운동 목록"이므로 통증 부위 기록(NO_EXCLUSION)은 걸러낸다.
   */
  private toResponse(program: Program): ProgramResponse {
    return {
      program_id: program.id,
      goal: program.goal,
      split_type: program.splitType,
      rules_version: program.rulesVersion,
      started_at: program.startedAt.toISOString().slice(0, 10),
      total_weeks: program.totalWeeks,
      current_week: currentWeek(program.startedAt, program.totalWeeks, utcToday()),
      status: lifecycleStatus(program, utcToday()),
      excluded_exercises: (program.excludedExercises as unknown as ExcludedExercise[]).filter(
        (item) => item.exercise_id !== NO_EXCLUSION,
      ),
      sessions: program.template as unknown as ProgramSessionTemplate[],
    };
  }
}

function currentWeek(startedAt: Date, totalWeeks: number, today: Date): number {
  const elapsed = Math.floor(
    (mondayOfWeek(today).getTime() - startedAt.getTime()) / (7 * 86_400_000),
  );
  return Math.min(totalWeeks, Math.max(1, elapsed + 1));
}

function lifecycleStatus(
  program: Pick<Program, "startedAt" | "totalWeeks" | "status">,
  today: Date,
) {
  const elapsedWeeks = Math.floor(
    (mondayOfWeek(today).getTime() - program.startedAt.getTime()) / (7 * 86_400_000),
  );
  return program.status === "completed" || elapsedWeeks >= program.totalWeeks
    ? "completed"
    : "active";
}

type ProgramSessionTemplate = ProgramResponse["sessions"][number];
type ProgramExercise = ProgramSessionTemplate["exercises"][number];
type ExcludedExercise = ProgramResponse["excluded_exercises"][number];

/** 주 1회분 템플릿. 실제 세션들은 이 템플릿을 날짜에 펼친 인스턴스다. */
function templateFor(
  schedule: ScheduledDay[],
  rowsByFocus: Map<Focus, PlannedSetRow[]>,
): ProgramSessionTemplate[] {
  return schedule.map(({ day, focus }) => ({
    day,
    focus,
    exercises: groupByOrder(rowsByFocus.get(focus) ?? []),
  }));
}

type TemplateSetRow = Pick<
  PlannedSetRow,
  | "exerciseId"
  | "orderIndex"
  | "targetRepsLow"
  | "targetRepsHigh"
  | "targetRir"
  | "restSec"
  | "targetTimeLowSec"
  | "targetTimeHighSec"
>;

function groupByOrder(plannedSets: TemplateSetRow[]): ProgramExercise[] {
  const byOrder = new Map<number, ProgramExercise>();
  for (const set of plannedSets) {
    const existing = byOrder.get(set.orderIndex);
    if (existing) {
      existing.sets += 1;
      continue;
    }
    byOrder.set(set.orderIndex, {
      exercise_id: set.exerciseId,
      sets: 1,
      reps_low: set.targetRepsLow ?? null,
      reps_high: set.targetRepsHigh ?? null,
      target_rir: set.targetRir ?? null,
      rest_sec: set.restSec,
      time_low_sec: set.targetTimeLowSec ?? null,
      time_high_sec: set.targetTimeHighSec ?? null,
    });
  }
  return [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, exercise]) => exercise);
}

/** pain_areas 로 후보에서 빠진 운동과 그 근거(SAFETY_PAIN_MAPPING.md 규칙 3). */
function excludedExercises(
  available: Exercise[],
  excludedPatterns: Map<MovementPattern, string>,
): ExcludedExercise[] {
  return available
    .filter((exercise) => excludedPatterns.has(exercise.movementPattern as MovementPattern))
    .map((exercise) => {
      const painArea = excludedPatterns.get(exercise.movementPattern as MovementPattern)!;
      return {
        exercise_id: exercise.id,
        pain_area: painArea,
        movement_pattern: exercise.movementPattern,
        reason:
          `${painArea} 통증으로 ${exercise.movementPattern} 패턴을 제외했다` +
          `(일반적 회피 가이드이며 의료적 조언이 아니다).`,
      };
    })
    .sort((a, b) => a.exercise_id.localeCompare(b.exercise_id));
}

/**
 * 제외된 운동이 **없는** 통증 부위의 기록(저장 전용). `wrist` 는 제외 패턴이 0건이고
 * `neck` 처럼 다른 부위가 이미 같은 패턴을 가져간 경우도 여기 들어온다.
 *
 * 기록을 남기지 않으면 프로그램에 통증 부위가 한 톨도 안 남아, 즉석 세션(F8-1)이 머신/케이블 우선
 * 배려를 잃는다(재평가 D-2). 항목 스키마는 4개 필드가 required 라 계약을 바꾸지 않고 남기려면
 * "제외한 운동 없음"을 값으로 표현해야 한다 → exercise_id·movement_pattern 을 빈 문자열로 둔다.
 */
function painAreasWithoutExclusion(
  painAreas: string[],
  removed: ExcludedExercise[],
): ExcludedExercise[] {
  const covered = new Set(removed.map((item) => item.pain_area));
  return [...new Set(painAreas)]
    .filter((area) => !covered.has(area))
    .sort()
    .map((area) => ({
      exercise_id: NO_EXCLUSION,
      pain_area: area,
      movement_pattern: NO_EXCLUSION,
      reason:
        `${area} 통증으로 제외한 운동은 없다. 대신 머신/케이블처럼 궤적이 고정된 종목을 먼저 고른다` +
        `(일반적 회피 가이드이며 의료적 조언이 아니다).`,
    }));
}

function muscles(available: Exercise[], exerciseId: string): string[] {
  return available.find((exercise) => exercise.id === exerciseId)?.primaryMuscles ?? [];
}

export interface SelectionOptions {
  levelRank: number;
  /** 통증이 보고되면 궤적이 고정된 머신/케이블을 먼저 고른다(규칙 1·4). */
  preferStable: boolean;
  /** 제외된 운동들의 주동근 — 부족분을 같은 근육군으로 메운다(규칙 1). 비어 있으면 대체하지 않는다. */
  substituteMuscles: Set<string>;
}

/**
 * 주어진 동작 패턴 우선순위대로 종목을 하나씩 고른다(프로그램의 focus · 즉석 세션의 body_part 공용).
 * 후보(catalog)는 equipment/avoid_exercises/pain_areas 로 이미 걸러진 목록이다.
 * 맨몸(default_step_kg 없음)·시간(metric=time) 종목도 후보에 포함한다 — 엔진이 두 축을 모두 처방한다.
 */
export function selectExercises(
  catalog: Exercise[],
  patterns: MovementPattern[],
  count: number,
  options: SelectionOptions,
): Exercise[] {
  const eligible = catalog.filter(
    (exercise) => DIFFICULTY_RANK[exercise.difficulty] <= options.levelRank,
  );
  const picked: Exercise[] = [];
  const used = new Set<string>();
  for (const pattern of patterns) {
    const [chosen] = eligible
      .filter((exercise) => exercise.movementPattern === pattern && !used.has(exercise.id))
      .sort(comparator(options));
    if (!chosen) continue;
    used.add(chosen.id);
    picked.push(chosen);
  }

  // 규칙 1: 통증 제외로 자리가 비면 같은 근육군의 머신/케이블 종목으로 메운다(안정성 우선).
  if (options.substituteMuscles.size > 0 && picked.length < count) {
    const substitutes = eligible
      .filter((exercise) => !used.has(exercise.id))
      .sort(
        (a, b) =>
          overlap(b, options.substituteMuscles) - overlap(a, options.substituteMuscles) ||
          stableFirst(a) - stableFirst(b) ||
          comparator(options)(a, b),
      )
      .slice(0, count - picked.length);
    picked.push(...substitutes);
  }
  const patternOrder = new Map(picked.map((exercise, index) => [exercise.id, index]));
  return picked.sort(comparator(options, patternOrder)).slice(0, count);
}

function comparator(
  options: SelectionOptions,
  patternOrder?: ReadonlyMap<string, number>,
): (a: Exercise, b: Exercise) => number {
  return (a, b) =>
    (options.preferStable ? stableFirst(a) - stableFirst(b) : 0) ||
    mechanicFirst(a) - mechanicFirst(b) ||
    (patternOrder ? patternOrder.get(a.id)! - patternOrder.get(b.id)! : 0) ||
    rank(a, options.levelRank) - rank(b, options.levelRank) ||
    a.id.localeCompare(b.id);
}

function mechanicFirst(exercise: Exercise): number {
  return exercise.mechanic === "compound" ? 0 : 1;
}

function stableFirst(exercise: Exercise): number {
  return isStableEquipment(exercise.equipment) ? 0 : 1;
}

function overlap(exercise: Exercise, targetMuscles: Set<string>): number {
  return exercise.primaryMuscles.filter((muscle) => targetMuscles.has(muscle)).length;
}

/** 사용자 수준 이하 난이도를 먼저, 그 안에서는 수준에 가까운(어려운) 쪽을 먼저 고른다. */
function rank(exercise: Exercise, levelRank: number): number {
  const difficulty = DIFFICULTY_RANK[exercise.difficulty];
  return difficulty > levelRank ? 10 + difficulty : -difficulty;
}

/** UTC 기준 이번 주 월요일 00:00. 요일 표기(day)와 scheduled_date 의 요일이 항상 일치한다. */
function mondayOfWeek(now: Date): Date {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const offset = (utc.getUTCDay() + 6) % 7;
  return addDays(utc, -offset);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
