import type { INestApplication } from "@nestjs/common";

/**
 * openapi 의 servers[].url 은 `/v1` 을 포함하고 paths 키에는 없다 → 전역 prefix 로 계약과 맞춘다.
 * (전역 pipe/filter 는 AppModule 의 APP_PIPE/APP_FILTER 로 등록되므로 여기서는 prefix 만 둔다.)
 */
export const API_PREFIX = "v1";

export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX);
  return app;
}
