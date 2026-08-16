import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { AnalyticsService } from "./analytics.service";
import { CompletionQueryDto } from "./dto/completion.query.dto";
import { E1rmQueryDto } from "./dto/e1rm.query.dto";
import { VolumeQueryDto } from "./dto/volume.query.dto";

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** GET /analytics/e1rm — 운동별 e1RM 추세 */
  @Get("e1rm")
  e1rm(@CurrentUser() userId: string, @Query() query: E1rmQueryDto) {
    return this.analytics.e1rm(userId, query);
  }

  /** GET /analytics/volume — 근육군별 주간 볼륨(hard sets) */
  @Get("volume")
  volume(@CurrentUser() userId: string, @Query() query: VolumeQueryDto) {
    return this.analytics.volume(userId, query);
  }

  /** GET /analytics/completion — 주간 운동 완료율 */
  @Get("completion")
  completion(@CurrentUser() userId: string, @Query() query: CompletionQueryDto) {
    return this.analytics.completion(userId, query);
  }
}
