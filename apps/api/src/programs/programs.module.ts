import { Module } from "@nestjs/common";
import { RecommendationModule } from "../recommendation/recommendation.module";
import { PlannedSetFactory } from "./planned-set.factory";
import { ProgramsController } from "./programs.controller";
import { ProgramsService } from "./programs.service";
import { WeekSwapsService } from "./week-swaps.service";
import { ProgramRulesBundleProvider } from "./program-rules-bundle.provider";

@Module({
  imports: [RecommendationModule],
  controllers: [ProgramsController],
  providers: [ProgramsService, PlannedSetFactory, WeekSwapsService, ProgramRulesBundleProvider],
  exports: [PlannedSetFactory, ProgramsService, ProgramRulesBundleProvider],
})
export class ProgramsModule {}
