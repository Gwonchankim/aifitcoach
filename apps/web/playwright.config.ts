import { defineConfig, devices } from "@playwright/test";
import { e2eDatabaseUrl } from "./e2e/db-url";
import { TEST_TODAY } from "./e2e/test-today";

/**
 * STEP 5 브라우저 검증용 Playwright 설정.
 *
 * - **API 를 스스로 띄운다**(웹과 함께 `webServer` 배열). 사람이 미리 `:3001` 을 띄워 둘 필요가 없다 —
 *   안 띄우면 프록시가 500 을 주는데 원인이 화면에 안 보였다(2026-08-08 실측).
 * - API 는 **전용 DB `<db>_e2e`** 를 쓴다. 개발 DB(`afc`)를 오염시키지 않는다(e2e/db-url.ts).
 * - API 포트는 3101 이다. 웹 포트는 **3000 그대로** 둔다 — api 의 CORS 허용목록 기본값이
 *   `http://localhost:3000` 이라 `00-api-cors` 회귀 스펙이 그대로 산다(apps/api common/http/cors.ts).
 * - 웹은 **프로덕션 빌드**(`next build && next start`)로 띄운다 — Lighthouse 수치를 위해서다.
 * - 뷰포트는 iPhone 14 Pro 급 390x844(세로) 고정. 한 손 조작·탭 타깃 검증 기준(UX_STATES §8).
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const API_TARGET = process.env.E2E_API_TARGET ?? `http://localhost:${API_PORT}`;
const API_BASE = process.env.E2E_API_BASE_URL ?? `${API_TARGET}/v1`;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

// 고정 "오늘"은 e2e/test-today.ts 한 곳에서만 정한다(API env 와 브라우저 시계가 같은 값을 봐야 한다).

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
  webServer: [
    {
      /**
       * 마이그레이션·시드를 **기동 명령 안에서** 돌린다. globalSetup 과의 실행 순서에 기대지 않으려는 것 —
       * 테이블이 없으면 DevUserService 의 부팅 시 upsert 가 죽어 포트가 아예 안 열린다.
       * `prisma migrate deploy` 는 DB 가 없으면 만들어 준다(실측).
       */
      command:
        "pnpm --filter api db:migrate && pnpm --filter api db:seed && pnpm --filter api start",
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        PORT: String(API_PORT),
        // 개발 DB 를 건드리지 않는다. 나머지 값(FIELD_ENCRYPTION_KEY 등)은 api 가 루트 .env 에서 읽는다(ADR-36).
        DATABASE_URL: e2eDatabaseUrl(),
        // 브라우저 시계(e2e/fixtures.ts)와 **같은 날짜**여야 한다(ADR-50).
        AFC_TEST_TODAY: TEST_TODAY,
      },
    },
    {
      command: `pnpm build && pnpm start --port ${WEB_PORT}`,
      port: WEB_PORT,
      // 빌드 산출물과 실행 중인 서버가 어긋나면 정적 자원이 400 을 낸다 → 항상 새로 띄운다.
      reuseExistingServer: false,
      timeout: 300_000,
      env: { NEXT_PUBLIC_API_BASE_URL: API_BASE },
    },
  ],
});
