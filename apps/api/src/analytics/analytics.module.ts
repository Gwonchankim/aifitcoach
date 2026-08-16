import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { AggregationProjector } from "./aggregation.projector";

@Module({
  controllers: [AnalyticsController, DashboardController],
  providers: [DashboardService, AggregationProjector],
  exports: [AggregationProjector],
})
export class AnalyticsModule {}
