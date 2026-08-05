import { Controller, Get, Param, Query } from "@nestjs/common";
import { ListExercisesQueryDto } from "./dto/list-exercises.query.dto";
import { ExerciseListResponse, ExerciseResponse, ExercisesService } from "./exercises.service";

@Controller("exercises")
export class ExercisesController {
  constructor(private readonly exercises: ExercisesService) {}

  /** GET /exercises — 운동 카탈로그 조회(필터). 참조 데이터라 사용자 스코프가 없다. */
  @Get()
  list(@Query() query: ListExercisesQueryDto): Promise<ExerciseListResponse> {
    return this.exercises.list(query);
  }

  /** GET /exercises/{exerciseId} — 운동 상세 */
  @Get(":exerciseId")
  detail(@Param("exerciseId") exerciseId: string): Promise<ExerciseResponse> {
    return this.exercises.detail(exerciseId);
  }
}
