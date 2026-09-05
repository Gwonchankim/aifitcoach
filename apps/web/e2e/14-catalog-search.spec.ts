/** Sprint02: real picker/canonical mutations and fresh-context catalog cache boundaries. */
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, addExercise, openSession, seedProgram, todaySession } from "./helpers";
import type { Exercise, Session } from "../lib/api";

test.describe.configure({ mode: "serial" });
const CATALOG_COUNT = 109;
const newIds = ["e_low_row_machine", "e_high_row_machine", "e_incline_chest_press_machine"];
const searches = [
  ["e_low_row_machine", " LOW ROW MACHINE "],
  ["e_high_row_machine", "하이로우머신"],
  ["e_incline_chest_press_machine", "Incline Chest Press Machine"],
  ["e_chest_press_machine", "머신 벤치 프레스"],
  ["e_machine_row", "시티드 머신 로우"],
];
async function allExercises(request: APIRequestContext) {
  const items: Exercise[] = [];
  let cursor: string | null = null;
  do {
    const response = await request.get(`${API_V1}/exercises`, { params: cursor ? { cursor } : {} });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Exercise[]; next_cursor?: string | null };
    expect(body.items.length).toBeLessThanOrEqual(20);
    items.push(...body.items);
    cursor = body.next_cursor ?? null;
  } while (cursor);
  expect(items).toHaveLength(CATALOG_COUNT);
  expect(new Set(items.map((item) => item.id)).size).toBe(CATALOG_COUNT);
  return items;
}
async function localSnapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("afc-session-v1");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = (name: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const [catalogs, drafts, outbox, sessions, routines] = await Promise.all(
      ["catalogs", "drafts", "outbox", "sessions", "routines"].map(read),
    );
    db.close();
    return {
      catalogs: catalogs as { catalog: Exercise[]; updated_at: string }[],
      drafts,
      outbox,
      sessions,
      routines,
    };
  });
}
async function openPicker(page: Page) {
  await page.getByRole("button", { name: "운동 추가", exact: true }).click();
  return page.getByRole("dialog", { name: "운동 추가", exact: true });
}
async function checkSearches(page: Page, catalog: Exercise[]) {
  const picker = await openPicker(page);
  for (const [id, query] of searches) {
    const exercise = catalog.find((item) => item.id === id)!;
    await picker.getByRole("searchbox", { name: "운동 검색" }).fill(query);
    await expect(
      picker.getByRole("button", { name: `${exercise.name_ko} 머신`, exact: true }).or(
        picker.getByRole("button", {
          name: `${exercise.name_ko} 머신 이미 루틴에 있어요`,
          exact: true,
        }),
      ),
    ).toHaveCount(1);
  }
  await picker.getByRole("button", { name: "닫기", exact: true }).click();
}

for (const [id, query] of searches) {
  test(`search selects canonical ${id} through sync API and keeps its name after reload`, async ({
    page,
    request,
  }, testInfo) => {
    const catalog = await allExercises(request);
    const exercise = catalog.find((item) => item.id === id)!;
    // Bodyweight-only generation leaves the five machine targets available for explicit add.
    await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
    const sessionId = await todaySession(request);
    await openSession(page, sessionId);
    const picker = await openPicker(page);
    await expect(picker.getByRole("tab", { name: "가슴" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await picker.getByRole("searchbox", { name: "운동 검색" }).fill(query);
    const sync = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/sync") &&
        response.request().method() === "POST" &&
        JSON.stringify(response.request().postDataJSON()).includes(id),
    );
    await picker.getByRole("button", { name: `${exercise.name_ko} 머신`, exact: true }).click();
    expect((await sync).status()).toBe(200);
    await expect(picker).toBeHidden();
    await expect(page.getByRole("heading", { name: exercise.name_ko, exact: true })).toBeVisible();
    let persisted: Session | undefined;
    await expect
      .poll(async () => {
        persisted = (await (
          await request.get(`${API_V1}/sessions/${sessionId}`)
        ).json()) as Session;
        return persisted.planned_sets.filter((row) => row.exercise_id === id).length;
      })
      .toBeGreaterThan(0);
    const rows = persisted!.planned_sets.filter((row) => row.exercise_id === id);
    await testInfo.attach("canonical-planned-rows", {
      body: JSON.stringify(rows),
      contentType: "application/json",
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: exercise.name_ko, exact: true })).toBeVisible();
    const reopened = await openPicker(page);
    await expect(reopened.getByRole("searchbox", { name: "운동 검색" })).toHaveValue("");
    await reopened.getByRole("searchbox", { name: "운동 검색" }).fill(query);
    await expect(
      reopened.getByRole("button", {
        name: `${exercise.name_ko} 머신 이미 루틴에 있어요`,
        exact: true,
      }),
    ).toBeDisabled();
  });
}

for (const width of [360, 390, 430]) {
  test(`search keyboard, clear/reopen, no overflow and axe at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
    await openSession(page, await todaySession(request));
    const trigger = page.getByRole("button", { name: "운동 추가", exact: true });
    const picker = await openPicker(page);
    await expect(picker.getByRole("tab", { name: "가슴" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("tab", { name: "등" })).toBeFocused();
    const search = picker.getByRole("searchbox", { name: "운동 검색" });
    await search.fill("시티드 머신 로우");
    await expect(picker.getByText("전체 부위에서 검색해요.")).toBeVisible();
    await expect(picker.getByRole("button", { name: "머신 로우 머신", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "검색어 지우기" }).click();
    await expect(search).toBeFocused();
    await search.fill("존재하지 않는 검색어");
    await expect(
      picker.getByText("검색 결과가 없어요. 다른 이름으로 검색해 보세요."),
    ).toBeVisible();
    await search.fill("머신");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    await testInfo.attach(`axe-${width}`, {
      body: JSON.stringify(axe.violations),
      contentType: "application/json",
    });
    expect(axe.violations).toEqual([]);
    await testInfo.attach(`search-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(search).toHaveValue("");
  });
}

test("swap uses the same all-region canonical search and persists the selected replacement", async ({
  page,
  request,
}) => {
  await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
  const sessionId = await todaySession(request);
  await addExercise(request, sessionId, "e_low_row_machine");
  await openSession(page, sessionId);
  await page.getByRole("button", { name: "로우 로우 머신 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "로우 로우 머신 교체", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "로우 로우 머신 교체", exact: true });
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("LOW ROW MACHINE");
  await expect(
    picker.getByRole("button", { name: "로우 로우 머신 머신", exact: true }),
  ).toHaveCount(0);
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("High Row Machine");
  await picker.getByRole("button", { name: "하이 로우 머신 머신", exact: true }).click();
  await expect(picker).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "하이 로우 머신", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "로우 로우 머신", exact: true })).toHaveCount(0);
  const session = (await (await request.get(`${API_V1}/sessions/${sessionId}`)).json()) as Session;
  expect(session.planned_sets.filter((row) => row.exercise_id === "e_low_row_machine")).toEqual([]);
  expect(
    session.planned_sets.filter((row) => row.exercise_id === "e_high_row_machine").length,
  ).toBeGreaterThan(0);
});

test("old106 partial-page failure preserves cache; retry fills109 and warm offline search survives reload @chromium-only", async ({
  page,
  context,
  request,
}, testInfo) => {
  const full = await allExercises(request);
  const old = full.filter((item) => !newIds.includes(item.id));
  expect(old).toHaveLength(106);
  await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
  const sessionId = await todaySession(request);
  // Serve the old response only into this test's fresh browser context, using actual API rows.
  const pageLog: string[] = [];
  await page.route("**/v1/exercises*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    pageLog.push(cursor ?? "first");
    const start = cursor ? old.findIndex((item) => item.id === cursor) + 1 : 0;
    await route.fulfill({
      json: {
        items: old.slice(start, start + 20),
        next_cursor: start + 20 < old.length ? old[start + 19].id : null,
      },
    });
  });
  await openSession(page, sessionId);
  const before = await localSnapshot(page);
  expect(before.catalogs[0].catalog).toEqual(old);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.unroute("**/v1/exercises*");
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
  const oldOfflinePicker = await openPicker(page);
  await oldOfflinePicker.getByRole("searchbox", { name: "운동 검색" }).fill("Low Row Machine");
  await expect(
    oldOfflinePicker.getByText("검색 결과가 없어요. 다른 이름으로 검색해 보세요."),
  ).toBeVisible();
  await oldOfflinePicker.getByRole("searchbox", { name: "운동 검색" }).fill("시티드 머신 로우");
  await expect(
    oldOfflinePicker.getByRole("button", { name: "머신 로우 머신", exact: true }),
  ).toBeVisible();
  expect((await localSnapshot(page)).catalogs).toEqual(before.catalogs);
  await context.setOffline(false);
  await page.unroute("**/v1/exercises*");
  await page.route("**/v1/exercises*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    pageLog.push(`fail-run:${cursor ?? "first"}`);
    if (cursor) await route.abort("failed");
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
  const failed = await localSnapshot(page);
  expect(failed.catalogs).toEqual(before.catalogs);
  expect(failed.drafts).toEqual(before.drafts);
  expect(failed.outbox).toEqual(before.outbox);
  expect(failed.routines).toEqual(before.routines);
  const picker = await openPicker(page);
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("Low Row Machine");
  await expect(picker.getByText("검색 결과가 없어요. 다른 이름으로 검색해 보세요.")).toBeVisible();
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("시티드 머신 로우");
  await expect(picker.getByRole("button", { name: "머신 로우 머신", exact: true })).toBeVisible();
  await page.unroute("**/v1/exercises*");
  await page.reload();
  await expect
    .poll(async () => (await localSnapshot(page)).catalogs[0]?.catalog.length)
    .toBe(CATALOG_COUNT);
  const complete = await localSnapshot(page);
  expect(complete.catalogs[0].catalog.filter((item) => !newIds.includes(item.id))).toEqual(old);
  await checkSearches(page, full);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
  await checkSearches(page, full);
  const offline = await localSnapshot(page);
  expect(offline.catalogs).toEqual(complete.catalogs);
  expect(offline.drafts).toEqual(complete.drafts);
  expect(offline.outbox).toEqual(complete.outbox);
  expect(offline.routines).toEqual(complete.routines);
  await testInfo.attach("catalog-cache-pages", {
    body: JSON.stringify({ pageLog, before, failed, complete, offline }),
    contentType: "application/json",
  });
  await context.setOffline(false);
});

test("cold catalog offline reload shows connection retry instead of empty search @chromium-only", async ({
  page,
  context,
  request,
}, testInfo) => {
  await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
  const sessionId = await todaySession(request);
  await page.route("**/v1/exercises*", (route) => route.abort("failed"));
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const before = await localSnapshot(page);
  expect(before.catalogs).toEqual([]);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const picker = await openPicker(page);
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("시티드 머신 로우");
  await expect(
    picker.getByText("운동 목록을 불러올 수 없어요. 연결 후 다시 시도해 주세요."),
  ).toBeVisible();
  await expect(picker.getByText(/검색 결과가 없어요/)).toHaveCount(0);
  const after = await localSnapshot(page);
  expect(after).toEqual(before);
  await testInfo.attach("cold-offline-reload", {
    body: JSON.stringify({ before, after }),
    contentType: "application/json",
  });
  await context.setOffline(false);
});

test("cold partial failure has no cache or false empty results; explicit retry preserves query and completes", async ({
  page,
  request,
}, testInfo) => {
  await allExercises(request);
  await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
  const sessionId = await todaySession(request);
  await page.route("**/v1/exercises*", (route) =>
    new URL(route.request().url()).searchParams.has("cursor")
      ? route.abort("failed")
      : route.continue(),
  );
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const picker = await openPicker(page);
  await picker.getByRole("searchbox", { name: "운동 검색" }).fill("Low Row Machine");
  await expect(
    picker.getByText("운동 목록을 불러올 수 없어요. 연결 후 다시 시도해 주세요."),
  ).toBeVisible();
  await expect(picker.getByText(/검색 결과가 없어요/)).toHaveCount(0);
  const failed = await localSnapshot(page);
  expect(failed.catalogs).toEqual([]);
  await page.unroute("**/v1/exercises*");
  await picker.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(picker.getByRole("searchbox", { name: "운동 검색" })).toHaveValue("Low Row Machine");
  await expect(
    picker.getByRole("button", { name: "로우 로우 머신 머신", exact: true }),
  ).toBeVisible();
  const complete = await localSnapshot(page);
  expect(complete.catalogs[0].catalog).toHaveLength(CATALOG_COUNT);
  expect(complete.drafts).toEqual(failed.drafts);
  expect(complete.outbox).toEqual(failed.outbox);
  expect(complete.sessions).toEqual(failed.sessions);
  expect(complete.routines).toEqual(failed.routines);
  await testInfo.attach("cold-failure-retry", {
    body: JSON.stringify({ failed, complete }),
    contentType: "application/json",
  });
});
