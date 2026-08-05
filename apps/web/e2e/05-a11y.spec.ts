/**
 * 항목 5: axe 로 주요 화면을 측정한다. **모달이 열린 상태**도 포함한다.
 * 위반이 있으면 규칙 id·요소·심각도를 그대로 출력하고 실패시킨다(약화 금지).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openSession, seedProgram, shot, todaySession } from "./helpers";

/**
 * 결과는 JSONL 로 **한 줄씩 append** 한다.
 * 테스트가 실패하면 Playwright 가 워커를 새로 띄우고 모듈이 다시 로드되므로,
 * 메모리에 모았다가 afterAll 에서 한 번에 쓰면 실패한 화면의 결과가 사라진다.
 */
const RESULTS = path.resolve(process.cwd(), "e2e/axe-results.jsonl");

let sessionId: string;

test.beforeAll(async ({ request }) => {
  await seedProgram(request);
  sessionId = await todaySession(request);
});

async function scan(page: Page, screen: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();

  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
  }));

  fs.appendFileSync(
    RESULTS,
    `${JSON.stringify({ screen, violationCount: violations.length, violations })}\n`,
  );
  console.log(`[axe] ${screen}: 위반 ${violations.length}건`, JSON.stringify(violations, null, 1));
  // soft: 한 화면이 실패해도 나머지 화면(특히 모달 열린 상태)까지 전부 측정한다.
  expect.soft(violations, `${screen} axe 위반`).toEqual([]);
}

test("S1 온보딩 각 스텝", async ({ page }) => {
  await page.goto("/onboarding");
  const titles = [
    "기본 정보를 알려 주세요",
    "어떤 목표로 운동하세요?",
    "일주일에 며칠 운동하세요?",
    "한 번에 얼마나 운동하세요?",
    "운동 경력이 어느 정도인가요?",
    "쓸 수 있는 장비를 골라 주세요",
    "운동할 때 불편한 곳이 있나요?",
  ];
  for (const [index, title] of titles.entries()) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await scan(page, `S1-onboarding-step${index + 1}`);
    if (index < titles.length - 1) await page.getByRole("button", { name: "다음" }).click();
  }
});

test("S2 프로그램 확인", async ({ page }) => {
  await page.goto("/program");
  await expect(page.getByRole("heading", { name: "내 운동 계획" })).toBeVisible();
  await scan(page, "S2-program");
});

test("S3 대시보드", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /오늘/ })).toBeVisible();
  await scan(page, "S3-dashboard");
});

test("S4 루틴 · 타이머 팝업 · 편집 팝업(열린 상태)", async ({ page }) => {
  await openSession(page, sessionId);
  await scan(page, "S4-routine");

  // 추가 팝업 열린 상태
  await page.getByRole("button", { name: "운동 추가" }).click();
  await expect(page.getByRole("dialog", { name: "운동 추가" })).toBeVisible();
  await scan(page, "S4-picker-add-open");
  await page
    .getByRole("dialog", { name: "운동 추가" })
    .getByRole("button", { name: "닫기" })
    .click();

  // 편집 시트 열린 상태
  const editButton = page.getByRole("button", { name: /루틴 편집$/ }).first();
  const editLabel = (await editButton.getAttribute("aria-label")) ?? "";
  await editButton.click();
  await expect(
    page.getByRole("dialog", { name: new RegExp(editLabel.replace(" 루틴 편집", "")) }),
  ).toBeVisible();
  await scan(page, "S4-exercise-menu-open");
  await page.keyboard.press("Escape");

  // 타이머 팝업 열린 상태
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toBeVisible();
  await scan(page, "S4-rest-timer-open");
  await page.keyboard.press("Escape");

  // 운동 종료 확인 시트 열린 상태
  await page.getByRole("button", { name: "운동 종료" }).click();
  await expect(page.getByRole("dialog", { name: "운동 종료" })).toBeVisible();
  await scan(page, "S4-finish-sheet-open");
});

test("S5 요약", async ({ page }) => {
  await openSession(page, sessionId);
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();
  await page
    .getByRole("dialog", { name: /후 휴식/ })
    .getByRole("button", { name: "휴식 종료" })
    .click();

  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료/ })
    .click();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await shot(page, "40-summary-a11y");
  await scan(page, "S5-summary");
});

test("키보드만으로 세트 완료 → 타이머 → 휴식 종료 루프를 완주한다(AC-A-1)", async ({
  page,
  request,
}) => {
  await seedProgram(request);
  const fresh = await todaySession(request);
  await openSession(page, fresh);

  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");

  const weight = page.getByLabel(`${name} 1세트 무게, 킬로그램`);
  await weight.focus();
  await page.keyboard.type("50");
  await page.keyboard.press("Tab"); // 횟수
  await expect(page.getByLabel(`${name} 1세트 횟수, 회`)).toBeFocused();
  await page.keyboard.type("8");
  await page.keyboard.press("Tab"); // RIR 라디오 그룹
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab"); // 완료 체크
  await expect(check).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: /후 휴식/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "휴식 종료" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel(`${name} 2세트 무게, 킬로그램`)).toBeFocused();
});
