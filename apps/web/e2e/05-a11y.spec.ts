/**
 * 항목 5: axe 로 주요 화면을 측정한다. **모달이 열린 상태**도 포함한다.
 * 위반이 있으면 규칙 id·요소·심각도를 그대로 출력하고 실패시킨다(약화 금지).
 */
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
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

/**
 * **빈 상태도 스캔한다.** 위 S3 은 beforeAll 이 프로그램을 시드해 둔 뒤라 **채워진** 대시보드만 본다 —
 * M-UIa 가 새로 만든 빈 상태는 지금까지 axe 대상 밖이었다.
 * 완료 세트가 0개인 상태만 스캔하다 완료 행 대비 위반(4.01:1)을 놓친 적이 있다(CLAUDE.md 함정 5).
 */
test("S3 대시보드 · 프로그램 없음(빈 상태)", async ({ page }) => {
  await page.route("**/v1/programs/current", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "NOT_FOUND", message: "생성된 프로그램이 없다." } }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "만들고 나면" })).toBeVisible();
  await scan(page, "S3-dashboard-empty");
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

  // 교체 팝업 열린 상태(F5: [교체] 는 중간 메뉴 없이 바로 연다)
  const swapButton = page.getByRole("button", { name: /교체$/ }).first();
  const swapLabel = (await swapButton.getAttribute("aria-label")) ?? "";
  await swapButton.click();
  await expect(page.getByRole("dialog", { name: swapLabel })).toBeVisible();
  await scan(page, "S4-picker-swap-open");
  await page.keyboard.press("Escape");

  // 삭제 확인 시트 열린 상태(F5 휴지통)
  const trashLabel = swapLabel.replace(/ 교체$/, " 삭제");
  await page.getByRole("button", { name: trashLabel }).click();
  await expect(page.getByRole("dialog", { name: /빼기/ })).toBeVisible();
  await scan(page, "S4-exercise-remove-open");
  await page.keyboard.press("Escape");

  // 타이머 팝업 열린 상태
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");

  // RIR 고르기 시트 열린 상태(M-7). 셰브론은 탭 순서 밖이라 클릭으로만 연다.
  await page.getByRole("button", { name: `${name} 1세트 RIR 고르기` }).click();
  await expect(page.getByRole("dialog", { name: "RIR 고르기" })).toBeVisible();
  await scan(page, "S4-rir-sheet-open");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "RIR 고르기" })).toBeHidden();

  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toBeVisible();
  await scan(page, "S4-rest-timer-open");
  await page.keyboard.press("Escape");

  /*
    **완료 세트가 있는 상태**도 반드시 스캔한다.
    완료 행은 배경·글자색이 통째로 바뀌는 유일한 상태라, 여기를 안 보면 대비 위반이 숨는다
    (예전에 완료 행 opacity-70 으로 4.01:1 위반이 있었는데 스캔 대상이 아니라 안 잡혔다).
  */
  await expect(page.getByRole("button", { name: `${name} 1세트 완료 취소` })).toBeVisible();
  await scan(page, "S4-routine-with-completed-set");

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
  await page.keyboard.press("Tab"); // RIR (F1-1: 한 칸에서 직접 입력 + 목록 선택)
  await expect(page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`)).toBeFocused();
  await page.keyboard.type("2");
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
