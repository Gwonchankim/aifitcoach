import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";
import { AuthService, type AuthResult, type IssuedSession } from "./auth.service";
import { CurrentSession } from "./current-session.decorator";
import { OwnerBootstrapDto, OwnerLoginDto } from "./dto/owner-auth.dto";

const SESSION_COOKIE = "sid";
const CSRF_COOKIE = "csrf";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

type CookieResponse = {
  cookie(name: string, value: string, options: ReturnType<typeof sessionCookieOptions>): unknown;
  clearCookie(name: string, options: ReturnType<typeof sessionCookieOptions>): unknown;
};

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

function csrfCookieOptions() {
  return { ...sessionCookieOptions(), httpOnly: false };
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private writeSession(response: CookieResponse, issued: IssuedSession): void {
    response.cookie(SESSION_COOKIE, issued.sessionToken, sessionCookieOptions());
    // Double-submit CSRF cookie: JS reads only this value, never sid. Same-origin rewrite keeps it host-only.
    response.cookie(CSRF_COOKIE, issued.csrfToken, csrfCookieOptions());
  }

  private writeSessionToken(response: CookieResponse, sessionToken: string): void {
    response.cookie(SESSION_COOKIE, sessionToken, sessionCookieOptions());
  }

  private body(result: AuthResult): Omit<AuthResult, "session"> {
    return { csrf_token: result.csrf_token, user: result.user };
  }

  /** 최초 1회: 프로필·동의·admin을 만들고 세션을 발급한다. */
  @Post("owner/bootstrap")
  async bootstrap(
    @Body() body: OwnerBootstrapDto,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<Omit<AuthResult, "session">> {
    const result = await this.auth.bootstrap(body.profile, body.consents, body.owner_code);
    this.writeSession(response, result.session);
    return this.body(result);
  }

  /** 쿠키 삭제/기기 변경 뒤의 단일 소유자 재로그인. */
  @Post("owner/login")
  @HttpCode(200)
  async login(
    @Body() body: OwnerLoginDto,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<Omit<AuthResult, "session">> {
    const result = await this.auth.login(body.owner_code);
    this.writeSession(response, result.session);
    return this.body(result);
  }

  /** refresh는 sid만 회전한다. CSRF 토큰은 유지되므로 204 응답 뒤에도 클라이언트 상태가 유효하다. */
  @Post("refresh")
  @HttpCode(204)
  async refresh(
    @CurrentSession() sessionId: string,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    this.writeSessionToken(response, await this.auth.rotateSession(sessionId));
  }

  /** 로그아웃은 서버 세션을 즉시 revoke하고 host-only sid를 지운다. */
  @Post("logout")
  @HttpCode(204)
  async logout(
    @CurrentSession() sessionId: string,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.auth.revokeSession(sessionId);
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    response.clearCookie(CSRF_COOKIE, csrfCookieOptions());
  }
}
