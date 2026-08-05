import { Controller, Get } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { DashboardResponse, DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** GET /dashboard — 대시보드 요약(오늘/내일 상태 + 지표) */
  @Get()
  summary(@CurrentUser() userId: string): Promise<DashboardResponse> {
    return this.dashboard.summary(userId);
  }
}
