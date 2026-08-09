/**
 * 서버와 브라우저가 **같은 "오늘"** 을 본다는 것을 고정한다(ADR-50).
 *
 * 이게 어긋나면 F6-1(종료 후 당일 수정) 판정이 조용히 뒤집힌다 — 서버가 만든 `scheduled_date` 는
 * 고정 날짜인데 브라우저는 실제 날짜를 보면, 화면은 "다른 날 세션"으로 판단하고 서버는 200 을 준다.
 * 화면이 멀쩡해 보여서 사람이 못 잡는 종류다. 두 값이 같은지 여기서 직접 확인한다.
 *
 * 날짜를 고정하는 이유(요일 배정의 구조적 공백): 일요일은 어떤 `days_per_week` 에서도 운동일이 될 수 없고,
 * 월요일은 어떤 값에서도 휴식일이 될 수 없다. 고정 전 일요일 실측: 53개 중 17 failed / 22 미실행.
 */
import { expect, test } from "./fixtures";
import { API_V1 } from "./helpers";
import { TEST_TODAY } from "./test-today";

test("서버의 오늘 = 브라우저의 오늘 = 고정 날짜", async ({ page, request }) => {
  const response = await request.get(`${API_V1}/dashboard`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { date: string };

  expect(body.date, "API 가 고정 날짜를 보지 않는다 — AFC_TEST_TODAY 가 안 먹었다").toBe(
    TEST_TODAY,
  );

  await page.goto("/");
  const browserToday = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  expect(
    browserToday,
    "브라우저가 고정 날짜를 보지 않는다 — e2e/fixtures.ts 시계가 안 먹었다",
  ).toBe(TEST_TODAY);

  expect(browserToday, "서버와 브라우저의 오늘이 다르다").toBe(body.date);
});
