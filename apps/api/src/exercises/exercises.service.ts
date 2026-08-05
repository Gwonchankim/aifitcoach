import { Injectable, NotFoundException } from "@nestjs/common";
import { Equipment, MovementPattern, Prisma } from "@prisma/client";
import type { Exercise } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ListExercisesQueryDto } from "./dto/list-exercises.query.dto";

/**
 * openapi: components.schemas.Exercise
 *
 * DB(prisma) 컬럼명과 계약 필드명이 다른 자리 → 매핑은 toExerciseResponse 한 곳에서만 한다.
 *   default_reps_low/high → rep_range_low/high  (계약이 nullable 이 아니라 metric=time 은 키를 뺀다)
 *   media(jsonb)          → media_url(문자열|null)
 * 계약에 없는 컬럼(mechanic·region·secondary_muscles·default_step_kg·unilateral·cues)은 내보내지 않는다.
 */
export interface ExerciseResponse {
  id: string;
  name_ko: string;
  name_en: string;
  movement_pattern: string;
  primary_muscles: string[];
  equipment: string;
  difficulty: string;
  metric: string;
  rep_range_low?: number;
  rep_range_high?: number;
  default_time_low_sec: number | null;
  default_time_high_sec: number | null;
  substitutions: string[];
  media_url: string | null;
}

/** openapi: GET /exercises 200 응답. next_cursor 는 다음 페이지가 있을 때만 넣는다. */
export interface ExerciseListResponse {
  items: ExerciseResponse[];
  next_cursor?: string;
}

/** 카탈로그가 30종이라 2페이지면 전량 순회된다(페이지네이션 경로가 실제로 쓰이는 크기). */
const PAGE_SIZE = 20;

const KNOWN_PATTERNS = new Set<string>(Object.values(MovementPattern));
const KNOWN_EQUIPMENT = new Set<string>(Object.values(Equipment));

@Injectable()
export class ExercisesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 커서는 keyset 방식이다: `id > cursor` 를 id 오름차순으로 읽는다.
   * offset 과 달리 시드가 바뀌어도 페이지 경계가 밀리지 않아 중복·누락이 생기지 않는다.
   * 다음 페이지 유무는 PAGE_SIZE + 1 건을 읽어 판단한다.
   */
  async list(query: ListExercisesQueryDto): Promise<ExerciseListResponse> {
    // 계약상 pattern/equipment 는 자유 문자열이라 enum 밖의 값이 올 수 있다.
    // GET /exercises 에 400 이 선언돼 있지 않으므로 "일치하는 종목 없음"(빈 목록)으로 답한다.
    if (unknownFilter(query)) return { items: [] };

    const rows = await this.prisma.exercise.findMany({
      where: {
        movementPattern: query.pattern as MovementPattern | undefined,
        equipment: query.equipment as Equipment | undefined,
        ...(query.cursor === undefined ? {} : { id: { gt: query.cursor } }),
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE + 1,
    });

    const items = rows.slice(0, PAGE_SIZE).map(toExerciseResponse);
    if (rows.length <= PAGE_SIZE) return { items };
    return { items, next_cursor: items[items.length - 1].id };
  }

  async detail(exerciseId: string): Promise<ExerciseResponse> {
    const exercise = await this.prisma.exercise.findUnique({ where: { id: exerciseId } });
    if (!exercise) {
      throw new NotFoundException("해당 운동을 찾을 수 없다.");
    }
    return toExerciseResponse(exercise);
  }
}

function unknownFilter(query: ListExercisesQueryDto): boolean {
  return (
    (query.pattern !== undefined && !KNOWN_PATTERNS.has(query.pattern)) ||
    (query.equipment !== undefined && !KNOWN_EQUIPMENT.has(query.equipment))
  );
}

function toExerciseResponse(exercise: Exercise): ExerciseResponse {
  return {
    id: exercise.id,
    name_ko: exercise.nameKo,
    name_en: exercise.nameEn,
    movement_pattern: exercise.movementPattern,
    primary_muscles: exercise.primaryMuscles,
    equipment: exercise.equipment,
    difficulty: exercise.difficulty,
    metric: exercise.metric,
    // rep_range_* 는 계약에서 nullable 이 아니다 → 반복 축이 없는 종목(e_plank)은 키 자체를 뺀다.
    ...(exercise.defaultRepsLow === null ? {} : { rep_range_low: exercise.defaultRepsLow }),
    ...(exercise.defaultRepsHigh === null ? {} : { rep_range_high: exercise.defaultRepsHigh }),
    default_time_low_sec: exercise.defaultTimeLowSec,
    default_time_high_sec: exercise.defaultTimeHighSec,
    substitutions: exercise.substitutions,
    media_url: mediaUrl(exercise.media),
  };
}

/** DB media(jsonb `{image_url, video_url}`) → 계약의 단일 media_url. 시연 영상을 우선하고 없으면 이미지. */
function mediaUrl(media: Prisma.JsonValue): string | null {
  if (media === null || typeof media !== "object" || Array.isArray(media)) return null;
  const { video_url, image_url } = media as { video_url?: unknown; image_url?: unknown };
  if (typeof video_url === "string") return video_url;
  if (typeof image_url === "string") return image_url;
  return null;
}
