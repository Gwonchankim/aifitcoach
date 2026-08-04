import { Module } from "@nestjs/common";
import { ProgramsController } from "./programs.controller";

@Module({ controllers: [ProgramsController] })
export class ProgramsModule {}
