import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

/** The first navigation precedes SW control; a controlled online reload warms this exact route. */
export async function warmSessionDocument(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        });
      });
    }
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cached = await (await caches.open("afc-pages-v1")).match(location.href);
        return (
          cached?.ok === true && cached.headers.get("content-type")?.includes("text/html") === true
        );
      }),
    )
    .toBe(true);
}
