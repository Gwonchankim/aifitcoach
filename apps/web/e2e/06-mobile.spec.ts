/**
 * 항목 7: 모바일 뷰포트(390x844) 실측.
 * - 탭 타깃 실제 렌더 크기(44px / 완료 체크·휴식 종료 72px 기준 확인)
 * - 주 액션이 하단 엄지 반경(세로 65~100%)에 있는지
 * - 가로 스크롤 발생 여부
 */
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
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
    await box(page.getByLabel(`${name} 1세트 횟수, 회`), "횟수 입력"),
    await box(page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`), "RIR 입력"),
    await box(page.getByRole("button", { name: `${name} 교체` }), "교체"),
    await box(page.getByRole("button", { name: new RegExp(`^${name} 삭제`) }), "삭제(휴지통)"),
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
  expect(measured.at(-1)!.y, "[운동 종료] 는 하단 35% 안에 있어야 한다(AC-H-1)").toBeGreaterThan(
    844 * 0.65,
  );
  expect(scroll.scrollWidth, "가로 스크롤이 없어야 한다").toBeLessThanOrEqual(scroll.clientWidth);
  await shot(page, "50-mobile-routine");
});

/**
 * RIR 목록을 **탭으로** 여는 경로(F1-1 / UX_STATES §2.4.2).
 *
 * `<input list>` + `<datalist>` 는 iOS Safari 에서 키보드 위 제안 줄이라 **탭으로 목록을 열 방법이 없다**
 * → 셰브론 + 하단 시트로 확정됐다. 이 테스트는 webkit(iPhone) 프로젝트에서도 돌아
 * "한 손으로 고를 수 있다"를 실제 렌더 엔진에서 확인한다.
 */
test("RIR: 셰브론을 탭해 시트에서 고른다(iOS 경로, AC-RIR-5)", async ({ page }) => {
  await openSession(page, sessionId);
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");

  const rir = page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`);
  await expect(rir).toHaveValue("");

  const chevron = page.getByRole("button", { name: `${name} 1세트 RIR 고르기` });
  await expect(chevron).toHaveAttribute("tabindex", "-1"); // AC-RIR-7
  const chevronBox = await box(chevron, "RIR 고르기 셰브론");

  await chevron.tap();
  const sheet = page.getByRole("dialog", { name: "RIR 고르기" });
  await expect(sheet).toBeVisible();

  const chip = sheet.getByRole("button", { name: "3" });
  const chipBox = await box(chip, "RIR 칩");
  await chip.tap();

  await expect(sheet).toBeHidden();
  await expect(rir).toHaveValue("3");
  await expect(rir).toBeFocused();

  // 다시 '모름'으로 되돌릴 수 있다(칸을 비우는 것과 같은 결과).
  await chevron.tap();
  await sheet.getByRole("button", { name: "모름" }).tap();
  await expect(rir).toHaveValue("");

  metrics.push({
    screen: "S4-rir-sheet",
    viewport: page.viewportSize(),
    targets: [chevronBox, chipBox],
  });
  // 시트 칩은 한 손으로 누르는 선택지라 44px, 셰브론은 칸 안쪽이라 WCAG 2.5.8 하한 24px 을 지킨다.
  expect(Math.min(chipBox.width, chipBox.height)).toBeGreaterThanOrEqual(44);
  expect(Math.min(chevronBox.width, chevronBox.height)).toBeGreaterThanOrEqual(24);
  await shot(page, `52-rir-sheet-${test.info().project.name}`);
});

/**
 * 세로 스크롤 총량 회귀 가드.
 * 로깅 화면은 세트 행이 15개까지 쌓인다 — 행 하나가 24px 자라면 화면 전체가 360px 길어진다.
 * 한 번 줄인 밀도(5,064 → 3,208 → 3,178 → F1-0 세트 행 재설계 후 2,7xx)를 다시 늘리지 않게 고정한다.
 * 상한은 재설계 후 실측(세트당 180px)에 여유 10px 을 둔 **190px** 이다(AC-SET-10).
 * 행 높이 상한: 미완료 2줄 96px(AC-SET-1) / 완료 1줄 64px(AC-SET-5).
 */
test("루틴 화면 세로 스크롤 총량(밀도 회귀 가드)", async ({ page }) => {
  await openSession(page, sessionId);

  const setCount = await page.getByRole("button", { name: /세트 완료 (처리|취소)$/ }).count();
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  // 세트 행 1개 높이도 함께 남긴다 — 총량이 늘었을 때 행 때문인지 카드 때문인지 바로 갈린다.
  const rows = page.getByRole("listitem").filter({ has: page.getByRole("button") });
  const rowHeight = Math.round((await rows.first().boundingBox())?.height ?? 0);

  // 완료 행은 한 줄로 축약된다 — 그 높이도 같은 화면에서 잰다.
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await check.click();
  const timer = page.getByRole("dialog", { name: /후 휴식/ });
  await expect(timer).toBeVisible();
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();
  const doneRowHeight = Math.round(
    (
      await rows
        .filter({ has: page.getByRole("button", { name: `${name} 1세트 완료 취소` }) })
        .boundingBox()
    )?.height ?? 0,
  );

  metrics.push({ screen: "S4-routine-scroll", setCount, scrollHeight, rowHeight, doneRowHeight });

  // 세트 수는 프로그램 생성 규칙에 달려 있다 — 세트당 평균 높이로 환산해 판정한다.
  const perSet = scrollHeight / setCount;
  expect(setCount, "회귀 가드는 세트가 충분히 쌓인 화면에서만 의미가 있다").toBeGreaterThanOrEqual(
    9,
  );
  expect(perSet, `세트당 평균 세로 높이 (총 ${scrollHeight}px / ${setCount}세트)`).toBeLessThan(
    190,
  );
  expect(rowHeight, "미완료 세트 행은 2줄(AC-SET-1)").toBeLessThanOrEqual(96);
  expect(doneRowHeight, "완료 세트 행은 1줄(AC-SET-5)").toBeLessThanOrEqual(64);
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

/**
 * 온보딩 스텝 버튼 배치(F0-0). "짧으면 따라 올라오고, 길면 고정".
 * 짧은 스텝(주당일수·시간)에서 버튼이 화면 맨 아래로 밀려 **가운데가 통째로 비는** 회귀를 막는다.
 *  - AC-S1-6 버튼 블록 상단 y ≥ 뷰포트 65%(844 → 549)
 *  - AC-S1-7 콘텐츠 끝 ~ 버튼 사이 빈 간격 ≤ 뷰포트 50%
 *  - AC-S1-8 버튼 블록 아래 여백 ≥ 24px (스크롤이 없는 스텝 기준)
 */
test("온보딩 스텝 버튼이 엄지 범위에 오고 가운데가 비지 않는다(F0-0)", async ({ page }) => {
  await page.goto("/onboarding");
  const viewport = page.viewportSize()!;
  const measured: Record<string, unknown>[] = [];

  for (let index = 0; index < 7; index += 1) {
    await expect(page.locator("h1")).toBeVisible();
    const cta = page.getByRole("button", { name: /^(다음|계획 만들기)$/ });
    const bar = (await cta.boundingBox())!;
    const layout = await page.evaluate(() => {
      // 스텝 콘텐츠 영역(제목 다음 형제)의 **실제 내용 끝**을 찾는다(최소 높이가 아니라).
      const wrapper = document.querySelector("h1 ~ div");
      let bottom = 0;
      for (const element of wrapper?.querySelectorAll("*") ?? []) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
      }
      return {
        contentBottom: bottom,
        scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      };
    });

    const row = {
      step: index + 1,
      scrolls: layout.scrolls,
      buttonTop: Math.round(bar.y),
      gapAbove: Math.round(bar.y - layout.contentBottom),
      gapBelow: Math.round(viewport.height - (bar.y + bar.height)),
    };
    measured.push(row);

    expect(row.buttonTop, `${row.step}/7 버튼 상단은 하단 1/3 안(AC-S1-6)`).toBeGreaterThanOrEqual(
      viewport.height * 0.65,
    );
    expect(row.gapAbove, `${row.step}/7 콘텐츠~버튼 빈 간격(AC-S1-7)`).toBeLessThanOrEqual(
      viewport.height * 0.5,
    );
    if (!row.scrolls) {
      expect(row.gapBelow, `${row.step}/7 버튼 아래 여백(AC-S1-8)`).toBeGreaterThanOrEqual(24);
    }
    if (index < 6) await page.getByRole("button", { name: "다음" }).click();
  }

  metrics.push({ screen: "S1-onboarding-actions", viewport, steps: measured });
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

test("Pretendard Variable이 400·500·600·700을 브라우저별로 렌더한다", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:-10000px;top:0;font-family:var(--font-pretendard);font-size:16px";
    probe.innerHTML = [400, 500, 600, 700]
      .map((weight) => `<span style="font-weight:${weight}">한글ABC123</span>`)
      .join("");
    document.body.append(probe);
    await document.fonts.ready;
    const rows = Array.from(probe.children, (node) => {
      const style = getComputedStyle(node);
      return {
        family: style.fontFamily,
        weight: style.fontWeight,
        width: node.getBoundingClientRect().width,
      };
    });
    const loaded = [400, 500, 600, 700].map((weight) =>
      document.fonts.check(`${weight} 16px "Pretendard Variable"`, "한글ABC123"),
    );
    probe.remove();
    return { rows, loaded };
  });

  expect(result.loaded).toEqual([true, true, true, true]);
  expect(result.rows.map((row) => row.weight)).toEqual(["400", "500", "600", "700"]);
  for (const row of result.rows) {
    expect(row.family).toContain("Pretendard Variable");
    expect(row.width).toBeGreaterThan(0);
  }
});
