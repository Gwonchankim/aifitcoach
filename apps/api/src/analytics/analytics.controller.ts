import { Controller, Get, Query } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { E1rmQueryDto } from "./dto/e1rm.query.dto";
import { VolumeQueryDto } from "./dto/volume.query.dto";

@Controller("analytics")
export class AnalyticsController {
  /** GET /analytics/e1rm — 운동별 e1RM 추세 */
  @Get("e1rm")
  e1rm(@Query() _query: E1rmQueryDto): never {
    return notImplemented();
  }

  /** GET /analytics/volume — 근육군별 주간 볼륨(hard sets) */
  @Get("volume")
  volume(@Query() _query: VolumeQueryDto): never {
    return notImplemented();
  }

  /** GET /analytics/completion — 주간 운동 완료율 */
  @Get("completion")
  completion(): never {
    return notImplemented();
  }
}
