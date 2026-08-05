import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({
  controllers: [AnalyticsController, DashboardController],
  providers: [DashboardService],
})
export class AnalyticsModule {}
