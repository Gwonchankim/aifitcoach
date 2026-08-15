import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SyncRequestDto } from "./dto/sync-request.dto";
import { SyncService } from "./sync.service";

@Controller("sync")
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post()
  @HttpCode(200)
  sync(@CurrentUser() userId: string, @Body() body: SyncRequestDto) {
    return this.syncService.sync(userId, body);
  }
}
