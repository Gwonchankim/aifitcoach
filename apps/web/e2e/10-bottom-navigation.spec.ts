import { expect, test } from "./fixtures";

const tabs = [
  { label: "오늘", href: "/" },
  { label: "기록", href: "/history" },
  { label: "프로그램", href: "/program" },
  { label: "내 정보", href: "/profile" },
] as const;

test("4탭 하단 IA: 링크·active 상태·390px 폭 예산을 고정한다", async ({ page }) => {
  await page.goto("/history");

  const navigation = page.getByRole("navigation", { name: "주요 탐색" });
  await expect(navigation).toBeVisible();
  const links = navigation.getByRole("link");
  await expect(links).toHaveCount(4);

  for (const tab of tabs) {
    const link = navigation.getByRole("link", { name: tab.label });
    await expect(link).toHaveAttribute("href", tab.href);
  }
  await expect(navigation.getByRole("link", { name: "기록" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const metrics = await navigation.evaluate((element) => {
    const nav = element.getBoundingClientRect();
    const main = document.querySelector("main")!;
    return {
      nav: { width: nav.width, height: nav.height },
      links: Array.from(element.querySelectorAll("a"), (link) => {
        const box = link.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
      mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });

  expect(metrics.nav).toEqual({ width: 390, height: 50 });
  expect(metrics.links.map((link) => link.width)).toEqual([97.5, 97.5, 97.5, 97.5]);
  for (const link of metrics.links) expect(link.height).toBeGreaterThanOrEqual(44);
  expect(metrics.mainPaddingBottom).toBeGreaterThanOrEqual(metrics.nav.height);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});

test("각 탭은 자신의 경로에서 aria-current=page가 된다", async ({ page }) => {
  for (const tab of tabs) {
    await page.goto(tab.href);
    const navigation = page.getByRole("navigation", { name: "주요 탐색" });
    await expect(navigation.getByRole("link", { name: tab.label })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

test("세션과 온보딩에는 공용 하단 내비게이션이 없다", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByRole("navigation", { name: "주요 탐색" })).toHaveCount(0);

  await page.goto("/session/session_1");
  await expect(page.getByRole("navigation", { name: "주요 탐색" })).toHaveCount(0);
});
