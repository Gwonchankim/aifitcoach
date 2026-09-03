import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eDatabaseEnv } from "./e2e/db-url";
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

/**
 * DB 는 **한 원천**에서 온다. `DATABASE_URL` 만 주면 `db:migrate` 래퍼가 부모의 `DIRECT_URL`
 * (개발 DB)을 먼저 골라 migration 만 딴 데로 간다 — 전용 DB 는 migration 되지 않고, 개발 DB 는
 * 의도 없이 바뀐다. 전용 DB 가 아니면 여기서 던져 **서버가 뜨기 전에** 멈춘다.
 */
const DB_ENV = e2eDatabaseEnv();
// 자격증명은 찍지 않는다. 어디를 보는지만 남긴다.
console.log(`[e2e] database → ${DB_ENV.label}`);

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
      // iOS(WebKit) 렌더와 핵심 오프라인 종료 복구 확인용. 전체 fault matrix는 Chromium이 소유한다.
      name: "webkit-ios",
      testMatch: /(?:06-mobile|09-offline-sync)\.spec\.ts/,
      grepInvert: /@chromium-only/,
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
        /**
         * 개발 DB 를 건드리지 않는다. **두 변수를 같은 값으로 함께 준다** —
         * `db:migrate` 래퍼가 `DIRECT_URL` 을 우선하므로 하나만 주면 migration 이 갈라진다.
         * 나머지 값(FIELD_ENCRYPTION_KEY 등)은 api 가 루트 .env 에서 읽는다(ADR-36).
         */
        DATABASE_URL: DB_ENV.DATABASE_URL,
        DIRECT_URL: DB_ENV.DIRECT_URL,
        // 브라우저 시계(e2e/fixtures.ts)와 **같은 날짜**여야 한다(ADR-50).
        AFC_TEST_TODAY: TEST_TODAY,
        /**
         * 실행 단위 신원. 고정 id 를 쓰면 다른 실행(포트를 바꿔 띄운 두 번째 스위트, 또는 같은
         * `afc_e2e` 를 보는 사람)이 서로의 데이터를 지운다. API 가 부팅 시 이 사용자를 만들어 준다
         * (DevUserService.onModuleInit).
         */
        DEV_USER_ID: process.env.E2E_DEV_USER_ID ?? randomUUID(),
        /**
         * 이 실행의 웹 출처를 허용목록에 넣는다. 루트 `.env` 의 고정값(`http://localhost:3000`)에 기대면
         * 포트를 바꿔 띄운 실행에서 브라우저 fetch 가 통째로 막힌다(실측: `E2E_WEB_PORT=3200` 에서 37건 실패).
         * `00-api-cors` 회귀 스펙은 helpers 의 `WEB_ORIGIN`(같은 포트에서 파생)을 쓰므로 그대로 산다.
         */
        WEB_ORIGIN,
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
