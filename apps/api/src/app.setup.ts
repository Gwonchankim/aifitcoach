import type { INestApplication } from "@nestjs/common";
import { assertDevUserAuthAllowed, devUserMiddleware } from "./auth/dev-user";

/**
 * openapi 의 servers[].url 은 `/v1` 을 포함하고 paths 키에는 없다 → 전역 prefix 로 계약과 맞춘다.
 * (전역 pipe/filter 는 AppModule 의 APP_PIPE/APP_FILTER 로 등록되므로 여기서는 prefix 만 둔다.)
 *
 * 인증 이음새: 요청에 user_id 를 넣는 미들웨어를 여기 한 곳에서만 등록한다(docs/TEST_SCOPE.md).
 * 소셜 OAuth + 쿠키 세션 + CSRF 도입 시 이 한 줄을 세션 가드로 교체한다.
 */
export const API_PREFIX = "v1";

export function configureApp(app: INestApplication): INestApplication {
  assertDevUserAuthAllowed();
  app.setGlobalPrefix(API_PREFIX);
  app.use(devUserMiddleware);
  return app;
}
