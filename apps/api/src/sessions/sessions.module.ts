import { Module } from "@nestjs/common";
import { ProgramsModule } from "../programs/programs.module";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

@Module({
  imports: [ProgramsModule, RecommendationModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
