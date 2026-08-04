import { Controller, Get, Param } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";

/**
 * openapi tag 는 exercises 지만, 추천은 별도 도메인 모듈이다(ARCHITECTURE.md 모듈 목록).
 * 경로는 계약 그대로 /exercises/{exerciseId}/recommendation 을 쓴다.
 */
@Controller("exercises")
export class RecommendationController {
  /** GET /exercises/{exerciseId}/recommendation — 특정 운동의 다음 세션 추천(근거 포함) */
  @Get(":exerciseId/recommendation")
  forExercise(@Param("exerciseId") _exerciseId: string): never {
    return notImplemented();
  }
}
