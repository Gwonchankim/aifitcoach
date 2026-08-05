import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { DevUserService } from "./dev-user.service";

@Module({ controllers: [AuthController], providers: [DevUserService] })
export class AuthModule {}
