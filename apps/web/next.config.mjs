import withSerwistInit from "@serwist/next";

/* global process */

/**
 * 실기기(HTTPS) 검증용 API 프록시 — ADR-43.
 *
 * 폰에서 `https://<PC-IP>:3000` 으로 접속하면 두 가지가 깨진다:
 *  1) 혼합 콘텐츠 — HTTPS 페이지가 `http://…:3001` 을 부르면 브라우저가 차단한다.
 *  2) `localhost` 는 폰 자신을 가리켜 API 를 찾지 못한다.
 * 그래서 `pnpm --filter web dev:lan`(scripts/dev-lan.mjs)은 `NEXT_PUBLIC_API_BASE_URL=/api/v1` 로 띄워
 * 브라우저가 **같은 출처의 `/api/v1/*` 만** 부르게 하고, 아래 rewrites 가 서버사이드에서
 * `http://localhost:3001/v1/*` 로 넘긴다. same-origin 이라 CORS 도 타지 않는다.
 *
 * Vercel 운영도 같은 `/api/v1` rewrite를 사용한다. `API_PROXY_ORIGIN`만 Cloud Run URL로 주입하면
 * 쿠키는 Vercel 호스트 전용으로 유지되고 Cloud Run은 프록시 뒤 API만 처리한다(ADR-67).
 * 평소 `next dev`(http://localhost:3000)는 종전대로 `http://localhost:3001/v1` 직통이라 동작이 바뀌지 않는다
 * — E2E 의 CORS 회귀 스펙(00-api-cors)이 교차 출처를 전제로 한다.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const origin = (process.env.API_PROXY_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
    return [{ source: "/api/v1/:path*", destination: `${origin}/v1/:path*` }];
  },
};

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  register: true,
  cacheOnNavigation: false,
  reloadOnOnline: false,
  // Next 해시 자산은 앱 셸 precache에 넣되 폰트는 기존 afc-fonts-v1 CacheFirst가 계속 소유한다.
  globPublicPatterns: [],
  exclude: [/\.woff2?$/i],
});

export default withSerwist(nextConfig);
