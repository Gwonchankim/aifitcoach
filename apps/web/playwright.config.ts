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

/**
 * 테스트의 고정 "오늘" — ADR-50. **API 프로세스의 `AFC_TEST_TODAY` 와 반드시 같아야 한다.**
 * 다르면 서버가 만든 `scheduled_date` 와 브라우저의 오늘이 어긋나 F6-1(당일 수정) 판정이 뒤집힌다.
 *
 * 금요일인 이유: 스위트가 쓰는 `days_per_week`(3·4·6) 가 **전부 운동일**인 요일이 MON 과 FRI 뿐이고,
 * "내일은 휴식"을 기대하는 화면이 있어 다음 날(SAT)이 휴식이어야 한다 → FRI.
 * 고정하지 않으면 일요일에는 어떤 분할에서도 오늘 세션이 없어 스위트가 통째로 죽는다(실측).
 */
const TEST_TODAY = process.env.AFC_TEST_TODAY ?? "2026-08-14";

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
    env: { NEXT_PUBLIC_API_BASE_URL: API_BASE, NEXT_PUBLIC_AFC_TEST_TODAY: TEST_TODAY },
  },
});
