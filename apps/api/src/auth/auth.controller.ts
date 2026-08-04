import { Body, Controller, Param, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { SocialLoginDto } from "./dto/social-login.dto";

@Controller("auth")
export class AuthController {
  /** POST /auth/social/{provider} — 소셜 로그인(웹 OAuth) → 세션 쿠키 발급 */
  @Post("social/:provider")
  socialLogin(@Param("provider") _provider: string, @Body() _body: SocialLoginDto): never {
    return notImplemented();
  }

  /** POST /auth/refresh — 세션 갱신(refresh 회전) */
  @Post("refresh")
  refresh(): never {
    return notImplemented();
  }

  /** POST /auth/logout — 로그아웃(세션 무효화) */
  @Post("logout")
  logout(): never {
    return notImplemented();
  }
}
