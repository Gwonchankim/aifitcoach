import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { DashboardController } from "./dashboard.controller";

@Module({ controllers: [AnalyticsController, DashboardController] })
export class AnalyticsModule {}
