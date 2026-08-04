import { Controller, Get } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";

@Controller("subscriptions")
export class SubscriptionsController {
  /** GET /subscriptions/status — 구독/엔타이틀먼트 상태 조회 */
  @Get("status")
  status(): never {
    return notImplemented();
  }
}
