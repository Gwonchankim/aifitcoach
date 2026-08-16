import { Module } from "@nestjs/common";
import { ProgramsModule } from "../programs/programs.module";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { AggregationProjector } from "./aggregation.projector";

@Module({
  imports: [ProgramsModule, RecommendationModule],
  controllers: [AnalyticsController, DashboardController],
  providers: [AnalyticsService, DashboardService, AggregationProjector],
  exports: [AggregationProjector, AnalyticsService],
})
export class AnalyticsModule {}
