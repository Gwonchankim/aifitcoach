import { defineConfig, devices } from "@playwright/test";

/**
 * STEP 5 브라우저 검증용 Playwright 설정.
 *
 * - 실서버(apps/api :3001)를 **그대로** 친다(우회 프록시 없음).
 *   웹 포트를 3000 으로 두는 이유: api 의 CORS 허용목록 기본값이 `http://localhost:3000` 이다
 *   (apps/api common/http/cors.ts, .env.example WEB_ORIGIN).
 * - 웹은 **프로덕션 빌드**(`next build && next start`)로 띄운다 — Lighthouse 수치를 위해서다.
 * - 뷰포트는 iPhone 14 Pro 급 390x844(세로) 고정. 한 손 조작·탭 타깃 검증 기준(UX_STATES §8).
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3001/v1";
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "./e2e/.report", open: "never" }]],
  use: {
    baseURL: WEB_ORIGIN,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
      },
    },
    {
      // iOS(WebKit) 렌더 확인용. 모바일 레이아웃 스펙만 돌린다.
      name: "webkit-ios",
      testMatch: /06-mobile\.spec\.ts/,
      use: { ...devices["iPhone 14 Pro"] },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start --port ${WEB_PORT}`,
    port: WEB_PORT,
    // 빌드 산출물과 실행 중인 서버가 어긋나면 정적 자원이 400 을 낸다 → 항상 새로 띄운다.
    reuseExistingServer: false,
    timeout: 300_000,
    env: { NEXT_PUBLIC_API_BASE_URL: API_BASE },
  },
});
