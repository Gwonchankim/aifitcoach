import { Module } from "@nestjs/common";
import { ProgramsModule } from "../programs/programs.module";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { SessionsModule } from "../sessions/sessions.module";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { SessionDependencyService } from "./session-dependency";

@Module({
  imports: [ProgramsModule, RecommendationModule, SessionsModule],
  controllers: [SyncController],
  providers: [SyncService, SessionDependencyService],
})
export class SyncModule {}
