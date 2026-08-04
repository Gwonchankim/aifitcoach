import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { AddExerciseDto } from "./dto/add-exercise.dto";
import { CompleteSessionDto } from "./dto/complete-session.dto";
import { SwapExerciseDto } from "./dto/swap-exercise.dto";

@Controller("sessions")
export class SessionsController {
  /** GET /sessions/{sessionId} — 세션 + 계획세트(추천값 포함) 조회 */
  @Get(":sessionId")
  detail(@Param("sessionId") _sessionId: string): never {
    return notImplemented();
  }

  /** POST /sessions/{sessionId}/complete — 세션 완료(피드백) → 추천 재계산 트리거 */
  @Post(":sessionId/complete")
  complete(@Param("sessionId") _sessionId: string, @Body() _body: CompleteSessionDto): never {
    return notImplemented();
  }

  /** POST /sessions/{sessionId}/exercises — 오늘 루틴에 운동 추가(부위별 선택) */
  @Post(":sessionId/exercises")
  addExercise(@Param("sessionId") _sessionId: string, @Body() _body: AddExerciseDto): never {
    return notImplemented();
  }

  /** DELETE /sessions/{sessionId}/exercises/{plannedExerciseId} — 오늘 루틴에서 운동 삭제 */
  @Delete(":sessionId/exercises/:plannedExerciseId")
  removeExercise(
    @Param("sessionId") _sessionId: string,
    @Param("plannedExerciseId") _plannedExerciseId: string,
  ): never {
    return notImplemented();
  }

  /** POST /sessions/{sessionId}/exercises/{plannedExerciseId}/swap — 오늘 루틴의 운동 교체 */
  @Post(":sessionId/exercises/:plannedExerciseId/swap")
  swapExercise(
    @Param("sessionId") _sessionId: string,
    @Param("plannedExerciseId") _plannedExerciseId: string,
    @Body() _body: SwapExerciseDto,
  ): never {
    return notImplemented();
  }
}
