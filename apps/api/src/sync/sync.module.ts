import { Module } from "@nestjs/common";
import { ProgramsModule } from "../programs/programs.module";
import { SessionsModule } from "../sessions/sessions.module";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";

@Module({
  imports: [ProgramsModule, SessionsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
