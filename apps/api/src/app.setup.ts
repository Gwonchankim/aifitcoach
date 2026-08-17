import { Logger, type INestApplication } from "@nestjs/common";
import { authenticationMode } from "./auth/auth-mode";
import { AuthService } from "./auth/auth.service";
import { assertDevUserAuthAllowed, devUserMiddleware } from "./auth/dev-user";
import { sessionAuthMiddleware } from "./auth/session-auth.middleware";
import { TEST_TODAY_ENV, isoDate, testTodayOverride } from "./common/date/utc-day";
import { corsOptions } from "./common/http/cors";

/**
 * openapi 의 servers[].url 은 `/v1` 을 포함하고 paths 키에는 없다 → 전역 prefix 로 계약과 맞춘다.
 * (전역 pipe/filter 는 AppModule 의 APP_PIPE/APP_FILTER 로 등록되므로 여기서는 prefix 만 둔다.)
 *
 * 인증 이음새: 요청에 user_id 를 넣는 미들웨어는 여기 한 곳뿐이다.
 * test/development의 dev-user와 production의 세션 인증이 이 경계를 공유한다.
 * CORS 도 같은 이음새다 — 프론트가 쿠키를 실어 보낼 수 있어야 하므로 여기서 켠다(common/http/cors.ts).
 */
export const API_PREFIX = "v1";

/**
 * 테스트 오버라이드가 켜졌으면 부팅 때 크게 남긴다 — 운영에서 실수로 켜지면 즉시 보여야 한다
 * (사람 결정 2026-08-09). 형식이 틀렸으면 여기서 던져 조용히 무시되지 않게 한다.
 */
function warnOnTestOverrides(): void {
  const today = testTodayOverride();
  if (!today) return;
  new Logger("TestOverrides").warn(
    `${TEST_TODAY_ENV}=${isoDate(today)} — "오늘"이 고정돼 있다. 테스트 전용이며 프로덕션에서는 무시된다.`,
  );
}

export function configureApp(app: INestApplication): INestApplication {
  warnOnTestOverrides();
  app.enableCors(corsOptions());
  app.setGlobalPrefix(API_PREFIX);
  if (authenticationMode() === "dev-user") {
    assertDevUserAuthAllowed();
    app.use(devUserMiddleware);
  } else {
    app.use(sessionAuthMiddleware(app.get(AuthService)));
  }
  return app;
}
