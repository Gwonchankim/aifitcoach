import { Module, ValidationPipe } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { AnalyticsModule } from "./analytics/analytics.module";
import { AuthModule } from "./auth/auth.module";
import { ErrorEnvelopeFilter } from "./common/http/error-envelope.filter";
import { ExercisesModule } from "./exercises/exercises.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProgramsModule } from "./programs/programs.module";
import { RecommendationModule } from "./recommendation/recommendation.module";
import { SessionsModule } from "./sessions/sessions.module";
import { SubscriptionsModule } from "./subscriptions/subscriptions.module";
import { SyncModule } from "./sync/sync.module";
import { UsersModule } from "./users/users.module";

/**
 * API 루트 모듈.
 *
 * 전역 입력 검증과 오류 엔벨로프는 `app.useGlobal*` 가 아니라 **provider(APP_PIPE·APP_FILTER)** 로 둔다 —
 * `Test.createTestingModule({ imports: [AppModule] })` 로 만든 앱에도 그대로 적용돼, 시험이 운영과 같은
 * pipe·filter 를 통과한다(ADR-21).
 *
 * 입력 계약: DTO 에 선언되지 않은 필드는 거부하지 않고 **제거**한다(whitelist, forbidNonWhitelisted 없음).
 * 핸들러는 DTO 클래스 인스턴스로 변환된 값(@Type 변환 포함)을 받는다(transform).
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    ProgramsModule,
    ExercisesModule,
    RecommendationModule,
    SessionsModule,
    SyncModule,
    AnalyticsModule,
    SubscriptionsModule,
  ],
  providers: [
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule {}
