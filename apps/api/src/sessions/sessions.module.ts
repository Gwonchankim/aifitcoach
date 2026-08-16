import { Module } from "@nestjs/common";
import { ProgramsModule } from "../programs/programs.module";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

@Module({
  imports: [ProgramsModule, RecommendationModule, AnalyticsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
