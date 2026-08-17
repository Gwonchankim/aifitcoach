import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import type { RequestWithUser } from "./request-user";

const PUBLIC_MUTATIONS = new Set(["/v1/auth/owner/bootstrap", "/v1/auth/owner/login"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const prefix = `${name}=`;
  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

type SessionRequest = {
  headers: { cookie?: string };
  originalUrl: string;
  method: string;
  header(name: string): string | undefined;
};

type Next = (error?: unknown) => void;

function requestPath(request: SessionRequest): string {
  return request.originalUrl.split("?", 1)[0];
}

/**
 * production의 유일한 "cookie → user_id" 이음새.
 *
 * 공개 bootstrap/login 외의 모든 변경 요청은 유효한 세션의 CSRF 토큰을 요구한다.
 * 세션이 없으면 여기서 "없는 토큰"을 구별하지 않고 CurrentUser/CurrentSession이 401을 낸다.
 */
export function sessionAuthMiddleware(auth: AuthService) {
  return async (request: SessionRequest, _response: unknown, next: Next): Promise<void> => {
    try {
      const sid = cookieValue(request.headers.cookie, "sid");
      const session = sid ? await auth.findActiveSession(sid) : null;
      const context = request as SessionRequest & RequestWithUser;
      if (session) {
        context.userId = session.userId;
        context.authSessionId = session.id;
      }

      const isPublic = PUBLIC_MUTATIONS.has(requestPath(request));
      if (session && !isPublic && !SAFE_METHODS.has(request.method)) {
        const csrf = request.header("X-CSRF-Token");
        if (!csrf || !auth.csrfMatches(session.csrfTokenHash, csrf)) {
          throw new UnauthorizedException("CSRF 토큰이 유효하지 않다.");
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
