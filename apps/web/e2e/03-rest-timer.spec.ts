/**
 * 항목 2: 휴식 타이머(F2/F3/F4)를 **실제 시간 경과**로 검증한다.
 * - 카운트다운 숫자 감소
 * - 진행 바 폭 감소: 계산값이 아니라 채움 요소의 실제 렌더 폭(px)을 잰다
 * - +30초 연타 누적 / 상한 / 즉시 종료
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openSession, seedExternalLoadProgram, shot, todaySession } from "./helpers";

let sessionId: string;

// /sync now persists a completed set on the server. Give every timer case a fresh session so
// one case cannot pull the previous case's first-set completion into its new browser context.
test.beforeEach(async ({ request }) => {
  await seedExternalLoadProgram(request);
  sessionId = await todaySession(request);
});

/** 진행 바 채움 요소의 실제 렌더 폭(px). 컴포넌트가 계산한 값이 아니라 DOM 박스다. */
async function barWidthPx(page: Page): Promise<number> {
  // 진행 바는 aria-hidden 안에 있어 a11y 트리에 없다 → CSS 로 잡는다(§4.4).
  const fill = page.locator('[role="dialog"] [role="progressbar"] > div');
  const box = await fill.boundingBox();
  expect(box, "진행 바 채움 요소가 보여야 한다").not.toBeNull();
  return box!.width;
}

function toSec(text: string): number {
  const [min, sec] = text.trim().split(":");
  return Number(min) * 60 + Number(sec);
}

async function remaining(page: Page): Promise<number> {
  return toSec(await page.getByRole("timer").innerText());
}

/** 첫 세트를 채워 완료 체크 → 타이머 팝업을 연다. */
async function openTimer(page: Page): Promise<string> {
  await openSession(page, sessionId);
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();
  await expect(
    page.getByRole("dialog", { name: new RegExp(`${name} 1세트 후 휴식`) }),
  ).toBeVisible();
  return name;
}

test("실제 시간이 지나면 카운트다운과 진행 바 폭이 함께 줄어든다", async ({ page }) => {
  test.setTimeout(120_000);
  await openTimer(page);

  const startSec = await remaining(page);
  const startWidth = await barWidthPx(page);
  expect(startSec).toBeGreaterThan(30);
  await shot(page, "20-timer-before");

  // 실제 10초 경과 (fake timer 없음)
  await page.waitForTimeout(10_000);

  const laterSec = await remaining(page);
  const laterWidth = await barWidthPx(page);
  await shot(page, "21-timer-after-10s");

  expect(startSec - laterSec, "10초 경과 후 남은 시간").toBeGreaterThanOrEqual(9);
  expect(startSec - laterSec).toBeLessThanOrEqual(12);
  expect(laterWidth, "진행 바 폭이 실제로 줄어야 한다").toBeLessThan(startWidth - 5);

  // 표기 규칙(AC-T-1): 분:초, 초는 2자리
  await expect(page.getByRole("timer")).toHaveText(/^\d+:\d{2}$/);
});

test("+30초 3연타는 정확히 90초 누적된다(AC-T-3)", async ({ page }) => {
  await openTimer(page);
  const plus30 = page.getByRole("button", { name: "휴식 30초 추가" });

  const before = await remaining(page);
  const widthBefore = await barWidthPx(page);
  await plus30.click();
  await plus30.click();
  await plus30.click();
  const after = await remaining(page);
  const widthAfter = await barWidthPx(page);

  expect(after - before, "+30초 3연타 누적").toBeGreaterThanOrEqual(89);
  expect(after - before).toBeLessThanOrEqual(91);
  // 총시간이 커졌지만 남은 비율은 위로 점프한다(§4.4)
  expect(widthAfter).toBeGreaterThanOrEqual(widthBefore - 1);
  await shot(page, "22-timer-after-plus30-x3");
});

test("남은 시간 10분 상한에서 +버튼이 비활성되고 안내가 뜬다(AC-T-4)", async ({ page }) => {
  await openTimer(page);
  const plus60 = page.getByRole("button", { name: "휴식 1분 추가" });

  for (let i = 0; i < 9; i += 1) await plus60.click();

  await expect(page.getByRole("timer")).toHaveText("10:00");
  await expect(plus60).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("휴식은 최대 10분까지 늘릴 수 있어요.")).toBeVisible();
  await shot(page, "23-timer-cap");
});

test("[휴식 종료]는 확인 없이 한 번의 탭으로 즉시 닫힌다(AC-T-5)", async ({ page }) => {
  const name = await openTimer(page);
  const dialog = page.getByRole("dialog", { name: new RegExp(`${name} 1세트 후 휴식`) });
  await dialog.getByRole("button", { name: "휴식 종료" }).click();
  await expect(dialog).toBeHidden();
  // 다음 미완료 세트의 첫 입력칸으로 포커스가 이동한다(§7.1)
  await expect(page.getByLabel(`${name} 2세트 무게, 킬로그램`)).toBeFocused();
});

test("Esc 로도 즉시 닫힌다(§4.6)", async ({ page }) => {
  await openTimer(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toBeHidden();
});

test("0초 도달 시 자동으로 닫지 않고 '휴식 완료' 상태가 된다(§4.7, 가상 시계)", async ({
  page,
}) => {
  // 여기만 가상 시계를 쓴다(휴식 120초를 실제로 기다리지 않기 위해).
  await page.clock.install();
  await openTimer(page);
  await page.clock.fastForward("02:05");

  await expect(page.getByRole("timer")).toHaveText("0:00");
  await expect(page.getByText("휴식 완료").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "다음 세트" })).toBeVisible();
  await expect(page.getByRole("button", { name: "휴식 30초 추가" })).toHaveCount(0);
  await shot(page, "24-timer-finished");

  // §4.4 "0 도달 → 폭 0%". CSS transition(150ms)이 끝날 시간을 실제로 준 뒤 잰다.
  await page.clock.runFor(2000);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await shot(page, "25-timer-finished-bar");
  expect(await barWidthPx(page), "0:00 에서 진행 바 폭").toBeLessThan(2);
});
