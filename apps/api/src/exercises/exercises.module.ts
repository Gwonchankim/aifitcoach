import { Module } from "@nestjs/common";
import { ExercisesController } from "./exercises.controller";

@Module({ controllers: [ExercisesController] })
export class ExercisesModule {}
