import { ExecutionContext, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import type { RequestWithUser } from "./request-user";

/**
 * 컨트롤러가 인증 주체를 얻는 유일한 통로. 지금은 dev-user 미들웨어가 채우고,
 * 인증 도입 후에는 세션 쿠키 가드가 같은 키를 채운다(컨트롤러는 그대로).
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const { userId } = ctx.switchToHttp().getRequest<RequestWithUser>();
  if (!userId) {
    throw new UnauthorizedException("요청에 사용자 컨텍스트가 없다.");
  }
  return userId;
});
