import { Module } from "@nestjs/common";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { PlannedSetFactory } from "./planned-set.factory";
import { ProgramsController } from "./programs.controller";
import { ProgramsService } from "./programs.service";

@Module({
  imports: [RecommendationModule],
  controllers: [ProgramsController],
  providers: [ProgramsService, PlannedSetFactory],
  exports: [PlannedSetFactory],
})
export class ProgramsModule {}
