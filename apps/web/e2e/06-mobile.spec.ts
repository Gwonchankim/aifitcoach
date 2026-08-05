/**
 * 항목 7: 모바일 뷰포트(390x844) 실측.
 * - 탭 타깃 실제 렌더 크기(44px / 완료 체크·휴식 종료 72px 기준 확인)
 * - 주 액션이 하단 엄지 반경(세로 65~100%)에 있는지
 * - 가로 스크롤 발생 여부
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openSession, seedProgram, shot, todaySession } from "./helpers";

const metrics: Record<string, unknown>[] = [];

let sessionId: string;

test.beforeAll(async ({ request }) => {
  await seedProgram(request);
  sessionId = await todaySession(request);
});

// 프로젝트(브라우저)별로 따로 남긴다 — 뷰포트가 달라 덮어쓰면 안 된다.
test.afterAll(({ browserName }, testInfo) => {
  const file = path.resolve(process.cwd(), `e2e/mobile-metrics.${testInfo.project.name}.json`);
  fs.writeFileSync(file, JSON.stringify({ browserName, screens: metrics }, null, 2));
});

async function box(locator: Locator, label: string) {
  const value = await locator.boundingBox();
  expect(value, `${label} 이 보여야 한다`).not.toBeNull();
  return { label, width: Math.round(value!.width), height: Math.round(value!.height), y: value!.y };
}

async function hasHorizontalScroll(
  page: Page,
): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test("루틴 화면: 탭 타깃 실측 + 가로 스크롤 없음", async ({ page }) => {
  await openSession(page, sessionId);

  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");

  const measured = [
    await box(check, "세트 완료 체크"),
    await box(page.getByLabel(`${name} 1세트 무게, 킬로그램`), "무게 입력"),
    await box(page.getByLabel("RIR 2").first().locator(".."), "RIR 칩"),
    await box(page.getByRole("button", { name: `${name} 루틴 편집` }), "루틴 편집"),
    await box(page.getByRole("button", { name: "운동 추가" }), "운동 추가"),
    await box(page.getByRole("button", { name: "운동 종료" }), "운동 종료(하단 고정)"),
  ];
  const scroll = await hasHorizontalScroll(page);
  metrics.push({ screen: "S4-routine", viewport: page.viewportSize(), targets: measured, scroll });

  for (const target of measured) {
    expect(
      Math.min(target.width, target.height),
      `${target.label} 탭 타깃 44px 이상 (실측 ${target.width}x${target.height})`,
    ).toBeGreaterThanOrEqual(44);
  }
  // 완료 체크는 한손 조작 대상 — 48px 이상(UX_STATES §7.6)
  expect(Math.min(measured[0].width, measured[0].height)).toBeGreaterThanOrEqual(48);
  // [운동 종료] 는 하단 고정 바 → 엄지 반경(세로 65% 아래)
  expect(measured[5].y, "[운동 종료] 는 하단 35% 안에 있어야 한다(AC-H-1)").toBeGreaterThan(
    844 * 0.65,
  );
  expect(scroll.scrollWidth, "가로 스크롤이 없어야 한다").toBeLessThanOrEqual(scroll.clientWidth);
  await shot(page, "50-mobile-routine");
});

test("타이머 시트: +시간 버튼·[휴식 종료] 크기와 위치", async ({ page }) => {
  await openSession(page, sessionId);
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();

  const dialog = page.getByRole("dialog", { name: /후 휴식/ });
  await expect(dialog).toBeVisible();

  const measured = [
    await box(dialog.getByRole("button", { name: "휴식 5초 추가" }), "+5초"),
    await box(dialog.getByRole("button", { name: "휴식 10초 추가" }), "+10초"),
    await box(dialog.getByRole("button", { name: "휴식 30초 추가" }), "+30초"),
    await box(dialog.getByRole("button", { name: "휴식 1분 추가" }), "+1분"),
    await box(dialog.getByRole("button", { name: "휴식 종료" }), "휴식 종료"),
  ];
  const scroll = await hasHorizontalScroll(page);
  const viewport = page.viewportSize()!;
  metrics.push({ screen: "S4-rest-timer", viewport, targets: measured, scroll });

  for (const target of measured) {
    expect(
      Math.min(target.width, target.height),
      `${target.label} 44px 이상 (실측 ${target.width}x${target.height})`,
    ).toBeGreaterThanOrEqual(44);
  }
  for (const target of measured) {
    expect(target.y, `${target.label} 은 엄지 반경(하단 35%)에 있어야 한다`).toBeGreaterThan(
      viewport.height * 0.65,
    );
  }
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
  await shot(page, "51-mobile-timer");
});

test("온보딩·대시보드·프로그램에 가로 스크롤이 없다", async ({ page }) => {
  for (const [name, url] of [
    ["dashboard", "/"],
    ["program", "/program"],
    ["onboarding", "/onboarding"],
  ] as const) {
    await page.goto(url);
    await expect(page.locator("h1").first()).toBeVisible();
    const scroll = await hasHorizontalScroll(page);
    metrics.push({ screen: name, viewport: page.viewportSize(), scroll });
    expect(scroll.scrollWidth, `${name} 가로 스크롤`).toBeLessThanOrEqual(scroll.clientWidth);
  }
});
