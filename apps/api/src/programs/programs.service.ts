import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Exercise, Program } from "@prisma/client";
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

/** 주 단위 템플릿을 실제 날짜로 펼칠 사이클 수. 2주치를 만들어 "다음 세션"이 항상 존재하게 한다. */
const CYCLES = 2;

const DIFFICULTY_RANK = { beginner: 0, intermediate: 1, advanced: 2 } as const;

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

    // equipment/avoid_exercises 로 먼저 거르고, 그 위에 통증 부위 제외(안전)를 얹는다.
    const available = catalog.filter(
      (exercise) =>
        !(dto.avoid_exercises ?? []).includes(exercise.id) &&
        ((dto.equipment ?? []).length === 0 || dto.equipment!.includes(exercise.equipment)),
    );
    const painAreas = dto.pain_areas ?? [];
    const excludedPatterns = excludedPatternsFor(painAreas);
    const excluded = excludedExercises(available, excludedPatterns);
    const allowed = available.filter(
      (exercise) => !excludedPatterns.has(exercise.movementPattern as MovementPattern),
    );
    const options: SelectionOptions = {
      levelRank: DIFFICULTY_RANK[dto.experience_level],
      preferStable: prefersStableEquipment(painAreas),
      // 규칙 1: 제외로 부족하면 같은 근육군의 머신/케이블 종목으로 대체한다.
      substituteMuscles: new Set(excluded.flatMap((item) => muscles(available, item.exercise_id))),
    };

    // focus 별 선택은 결정론적이므로 한 번만 계산해 같은 focus 인 날마다 재사용한다.
    const rowsByFocus = new Map<Focus, PlannedSetRow[]>();
    for (const { focus } of schedule) {
      if (rowsByFocus.has(focus)) continue;
      const exercises = selectExercises(allowed, focus, exerciseCount, options);
      // 통증 제외로 비었다면 에러 대신 축소된(빈) 세션을 만든다(SAFETY_PAIN_MAPPING.md 규칙 2).
      if (exercises.length === 0 && excluded.length === 0) {
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

    const weekStart = mondayOfWeek(new Date());
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
          template: templateFor(schedule, rowsByFocus),
          excludedExercises: excluded,
        },
      });
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        for (const { day, focus } of schedule) {
          const rows = rowsByFocus.get(focus) ?? [];
          const session = await tx.workoutSession.create({
            data: {
              programId: created.id,
              scheduledDate: addDays(weekStart, WEEKDAYS.indexOf(day) + cycle * 7),
              focus,
              status: "scheduled",
            },
          });
          await tx.plannedSet.createMany({
            data: rows.map((row) => ({ ...row, sessionId: session.id })),
          });
        }
      }
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
    return this.toResponse(program);
  }

  /**
   * 프로그램 템플릿은 생성 시점에 고정된 값(programs.template)을 그대로 돌려준다.
   * 세션에서 되읽으면 세션 스코프 편집(F5)이 템플릿을 오염시킨다(STEP 4 평가 I-12).
   */
  private toResponse(program: Program): ProgramResponse {
    return {
      program_id: program.id,
      goal: program.goal,
      split_type: program.splitType,
      rules_version: program.rulesVersion,
      excluded_exercises: program.excludedExercises as unknown as ExcludedExercise[],
      sessions: program.template as unknown as ProgramSessionTemplate[],
    };
  }
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

function muscles(available: Exercise[], exerciseId: string): string[] {
  return available.find((exercise) => exercise.id === exerciseId)?.primaryMuscles ?? [];
}

interface SelectionOptions {
  levelRank: number;
  /** 통증이 보고되면 궤적이 고정된 머신/케이블을 먼저 고른다(규칙 1·4). */
  preferStable: boolean;
  /** 제외된 운동들의 주동근 — 부족분을 같은 근육군으로 메운다(규칙 1). 비어 있으면 대체하지 않는다. */
  substituteMuscles: Set<string>;
}

/**
 * focus 의 동작 패턴 우선순위대로 종목을 하나씩 고른다.
 * 후보(catalog)는 equipment/avoid_exercises/pain_areas 로 이미 걸러진 목록이다.
 * 맨몸(default_step_kg 없음)·시간(metric=time) 종목도 후보에 포함한다 — 엔진이 두 축을 모두 처방한다.
 */
function selectExercises(
  catalog: Exercise[],
  focus: Focus,
  count: number,
  options: SelectionOptions,
): Exercise[] {
  const picked: Exercise[] = [];
  const used = new Set<string>();
  for (const pattern of patternsFor(focus)) {
    if (picked.length >= count) break;
    const [chosen] = catalog
      .filter((exercise) => exercise.movementPattern === pattern && !used.has(exercise.id))
      .sort(comparator(options));
    if (!chosen) continue;
    used.add(chosen.id);
    picked.push(chosen);
  }

  // 규칙 1: 통증 제외로 자리가 비면 같은 근육군의 머신/케이블 종목으로 메운다(안정성 우선).
  if (options.substituteMuscles.size > 0 && picked.length < count) {
    const substitutes = catalog
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
  return picked;
}

function comparator(options: SelectionOptions): (a: Exercise, b: Exercise) => number {
  return (a, b) =>
    (options.preferStable ? stableFirst(a) - stableFirst(b) : 0) ||
    rank(a, options.levelRank) - rank(b, options.levelRank) ||
    a.id.localeCompare(b.id);
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
