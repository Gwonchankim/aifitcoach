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

/** 전역 pipe/filter 는 provider 로 등록해 테스트 모듈에서도 동일하게 적용되게 한다. */
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
