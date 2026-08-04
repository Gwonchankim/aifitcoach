import { Controller, Get } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";

@Controller("dashboard")
export class DashboardController {
  /** GET /dashboard — 대시보드 요약(오늘/내일 상태 + 지표) */
  @Get()
  summary(): never {
    return notImplemented();
  }
}
