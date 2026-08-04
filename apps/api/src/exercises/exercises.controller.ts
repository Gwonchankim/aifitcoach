import { Controller, Get, Param, Query } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { ListExercisesQueryDto } from "./dto/list-exercises.query.dto";

@Controller("exercises")
export class ExercisesController {
  /** GET /exercises — 운동 카탈로그 조회(필터) */
  @Get()
  list(@Query() _query: ListExercisesQueryDto): never {
    return notImplemented();
  }

  /** GET /exercises/{exerciseId} — 운동 상세 */
  @Get(":exerciseId")
  detail(@Param("exerciseId") _exerciseId: string): never {
    return notImplemented();
  }
}
