import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { ProgramsModule } from "../programs/programs.module";

@Module({ imports: [ProgramsModule], controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
