import { ExecutionContext, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import type { RequestWithUser } from "./request-user";

/** 세션을 요구하는 refresh/logout 전용. 일반 리소스는 CurrentUser만 쓴다. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const { authSessionId } = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!authSessionId) {
      throw new UnauthorizedException("유효한 세션이 필요하다.");
    }
    return authSessionId;
  },
);
