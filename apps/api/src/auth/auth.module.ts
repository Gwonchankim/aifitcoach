import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { DevUserService } from "./dev-user.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, DevUserService],
  exports: [AuthService],
})
export class AuthModule {}
