import { Body, Controller, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { SyncRequestDto } from "./dto/sync-request.dto";

@Controller("sync")
export class SyncController {
  /** POST /sync — 오프라인 변경 배치 push + 변경 pull (client_id 멱등, updated_at LWW) */
  @Post()
  sync(@Body() _body: SyncRequestDto): never {
    return notImplemented();
  }
}
