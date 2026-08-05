/**
 * CORS 는 인증 이음새와 한 몸이라 configureApp(app.setup.ts) 한 곳에서만 켠다.
 *
 * 브라우저가 httpOnly 세션 쿠키를 실어 보내려면(`credentials: include`) 서버가
 * `Access-Control-Allow-Credentials: true` 를 줘야 하고, 그때 `Access-Control-Allow-Origin: *` 은
 * 브라우저가 거부한다 → **명시적 허용목록**만 쓴다(SECURITY_PIPA.md).
 */
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

/** openapi 가 실제로 쓰는 메서드만(+ 프리플라이트). PUT 은 계약에 없다. */
const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];

/** 변경 요청은 CSRF 토큰 헤더가 필수다(openapi securitySchemes: csrfToken). */
const ALLOWED_HEADERS = ["Content-Type", "X-CSRF-Token"];

/** WEB_ORIGIN: 쉼표로 여러 개(프리뷰 URL 등). 기본값은 로컬 프론트. */
export function allowedOrigins(): string[] {
  const raw = process.env.WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN;
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error("WEB_ORIGIN 이 비어 있다. 허용할 웹 origin 을 하나 이상 지정하라.");
  }
  if (origins.includes("*")) {
    throw new Error(
      "WEB_ORIGIN 에 `*` 는 쓸 수 없다. 쿠키 세션(credentials)을 쓰는 API 라 origin 을 명시해야 한다(SECURITY_PIPA.md).",
    );
  }
  return origins;
}

export function corsOptions(): CorsOptions {
  return {
    origin: allowedOrigins(),
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    maxAge: 600,
  };
}
