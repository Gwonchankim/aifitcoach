import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { AddExerciseDto } from "./dto/add-exercise.dto";
import { CompleteSessionDto } from "./dto/complete-session.dto";
import { CreateAdHocSessionDto } from "./dto/create-ad-hoc-session.dto";
import { SwapExerciseDto } from "./dto/swap-exercise.dto";
import { CompleteSessionResponse, SessionResponse, SessionsService } from "./sessions.service";

@Controller("sessions")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /**
   * POST /sessions/ad-hoc — 휴식일 즉석 세션 생성(부위 선택, F8-1).
   * `:sessionId` 라우트보다 먼저 선언해 고정 경로가 파라미터에 잡아먹히지 않게 한다.
   */
  @Post("ad-hoc")
  createAdHoc(
    @CurrentUser() userId: string,
    @Body() body: CreateAdHocSessionDto,
  ): Promise<SessionResponse> {
    return this.sessions.createAdHoc(userId, body);
  }

  /** GET /sessions/{sessionId} — 세션 + 계획세트(추천값 포함) 조회 */
  @Get(":sessionId")
  detail(
    @CurrentUser() userId: string,
    @Param("sessionId") sessionId: string,
  ): Promise<SessionResponse> {
    return this.sessions.detail(userId, sessionId);
  }

  /** POST /sessions/{sessionId}/complete — 세션 완료(피드백) → 추천 재계산 트리거 */
  @Post(":sessionId/complete")
  @HttpCode(200)
  complete(
    @CurrentUser() userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: CompleteSessionDto,
  ): Promise<CompleteSessionResponse> {
    return this.sessions.complete(userId, sessionId, body);
  }

  /** POST /sessions/{sessionId}/exercises — 오늘 루틴에 운동 추가(부위별 선택) */
  @Post(":sessionId/exercises")
  @HttpCode(200)
  addExercise(
    @CurrentUser() userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: AddExerciseDto,
  ): Promise<SessionResponse> {
    return this.sessions.addExercise(userId, sessionId, body);
  }

  /**
   * DELETE /sessions/{sessionId}/exercises/{plannedExerciseId} — 오늘 루틴에서 운동 삭제.
   * plannedExerciseId = 세션 안의 운동 식별자 = exercises.id (planned_exercise 엔티티는 없다).
   */
  @Delete(":sessionId/exercises/:plannedExerciseId")
  removeExercise(
    @CurrentUser() userId: string,
    @Param("sessionId") sessionId: string,
    @Param("plannedExerciseId") plannedExerciseId: string,
  ): Promise<SessionResponse> {
    return this.sessions.removeExercise(userId, sessionId, plannedExerciseId);
  }

  /** POST /sessions/{sessionId}/exercises/{plannedExerciseId}/swap — 오늘 루틴의 운동 교체 */
  @Post(":sessionId/exercises/:plannedExerciseId/swap")
  @HttpCode(200)
  swapExercise(
    @CurrentUser() userId: string,
    @Param("sessionId") sessionId: string,
    @Param("plannedExerciseId") plannedExerciseId: string,
    @Body() body: SwapExerciseDto,
  ): Promise<SessionResponse> {
    return this.sessions.swapExercise(userId, sessionId, plannedExerciseId, body);
  }
}
