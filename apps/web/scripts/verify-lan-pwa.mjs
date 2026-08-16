/** Verify the running production-LAN PWA with a real Chromium service worker and offline reload. */
/* global process, console, navigator, setTimeout, clearTimeout, document, caches, URL */
import { chromium } from "@playwright/test";

const origin = process.argv[2] ?? "https://192.168.0.174:3000";
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });

try {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "AIFITCOACH" }).waitFor();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("service worker did not take control")),
        15_000,
      );
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);

  const online = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const cacheNames = await caches.keys();
    const pageRequests = await (await caches.open("afc-pages-v1")).keys();
    const fontRequests = await (await caches.open("afc-fonts-v1")).keys();
    return {
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration.active?.state ?? null,
      cacheNames,
      rootCached: pageRequests.some((request) => new URL(request.url).pathname === "/"),
      pageEntries: pageRequests.length,
      fontEntries: fontRequests.length,
    };
  });
  if (!online.controller || online.active !== "activated")
    throw new Error(`service worker is not controlling the page: ${JSON.stringify(online)}`);
  if (!online.rootCached || !online.cacheNames.includes("afc-pages-v1"))
    throw new Error(`app shell cache is incomplete: ${JSON.stringify(online)}`);
  if (!online.cacheNames.includes("afc-fonts-v1") || online.fontEntries === 0)
    throw new Error(`font cache is empty: ${JSON.stringify(online)}`);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "AIFITCOACH" }).waitFor();
  console.log(JSON.stringify({ ...online, offlineReload: "passed" }, null, 2));
} finally {
  await context.setOffline(false).catch(() => undefined);
  await browser.close();
}
