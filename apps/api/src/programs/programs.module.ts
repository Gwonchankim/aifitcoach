import { Module } from "@nestjs/common";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { PlannedSetFactory } from "./planned-set.factory";
import { ProgramsController } from "./programs.controller";
import { ProgramsService } from "./programs.service";
import { WeekSwapsService } from "./week-swaps.service";

@Module({
  imports: [RecommendationModule],
  controllers: [ProgramsController],
  providers: [ProgramsService, PlannedSetFactory, WeekSwapsService],
  exports: [PlannedSetFactory, ProgramsService],
})
export class ProgramsModule {}
