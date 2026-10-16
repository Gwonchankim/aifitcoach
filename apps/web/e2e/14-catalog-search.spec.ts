/** Sprint02: real picker/canonical mutations and fresh-context catalog cache boundaries. */
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, type Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, addExercise, openSession, seedProgram, todaySession } from "./helpers";
import type { Exercise, Session } from "../lib/api";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SetDraft } from "../components/session/session-store";
import { DEV_USER_SCOPE } from "../components/session/session-db";
import { warmSessionDocument } from "./support/warm-session-document";

test.describe.configure({ mode: "serial" });
const CATALOG_COUNT = 111;
const newIds = [
  "e_low_row_machine",
  "e_high_row_machine",
  "e_incline_chest_press_machine",
  "e_assisted_dips",
];
const searches = [
  ["e_low_row_machine", " LOW ROW MACHINE "],
  ["e_high_row_machine", "하이로우머신"],
  ["e_incline_chest_press_machine", "Incline Chest Press Machine"],
  ["e_assisted_dips", "어시스트 딥스 머신"],
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
  expect(items.filter((item) => item.modality === "resistance")).toHaveLength(110);
  expect(items.filter((item) => item.modality !== "resistance")).toEqual([
    expect.objectContaining({
      id: "e_stationary_bike",
      modality: "cardio",
      equipment: "stationary_bike",
      metric: "time",
      cardio_movement_regions: ["lower"],
      prescription_kinds_supported: ["steady_cardio", "interval_cardio"],
      blocked_reported_pain_areas: [
        "knee",
        "lower_back",
        "shoulder",
        "elbow",
        "wrist",
        "hip",
        "neck",
        "ankle",
      ],
    }),
  ]);
  return items;
}
type ReadDraft = SetDraft & { user_id: string; session_id: string };
const draftKey = (row: ReadDraft) =>
  JSON.stringify([row.user_id, row.session_id, row.planned_set_id]);
function assertCatalogReadDrafts(before: ReadDraft[], after: ReadDraft[], served: Session[]) {
  const keys = new Set(before.map(draftKey));
  // Retain every existing row's complete bytes, regardless of its origin.
  expect(after.filter((row) => keys.has(draftKey(row)))).toEqual(before);
  const additional = after.filter((row) => !keys.has(draftKey(row)));
  for (const row of additional) {
    expect(row.user_id).toBe(DEV_USER_SCOPE);
    const candidates = served
      .filter((session) => session.id === row.session_id)
      .flatMap((session) =>
        session.planned_sets
          .filter(
            (set) =>
              set.id === row.planned_set_id && typeof set.performed_set?.completed === "boolean",
          )
          .map((set) => {
            const actual = set.performed_set!;
            return {
              user_id: row.user_id,
              session_id: session.id,
              planned_set_id: set.id,
              actual_weight: actual.actual_weight,
              actual_reps: actual.actual_reps,
              actual_rir: actual.actual_rir,
              actual_time_sec: actual.actual_time_sec,
              completed: actual.completed,
              pain_score: null,
            };
          }),
      );
    // The response is the allowlist; placeholder construction shape is never the classifier.
    // Only these two local metadata keys are absent from the authoritative GET contract.
    const { client_id: _client, updated_at: _time, ...projection } = row;
    expect(Object.keys(projection).sort()).toEqual([
      "actual_reps",
      "actual_rir",
      "actual_time_sec",
      "actual_weight",
      "completed",
      "pain_score",
      "planned_set_id",
      "session_id",
      "user_id",
    ]);
    expect(candidates.some((candidate) => isDeepStrictEqual(candidate, projection))).toBe(true);
  }
  expect(after).toHaveLength(before.length + additional.length);
}
type ReadSession = {
  user_id: string;
  session_id: string;
  session: Session;
  updated_at: string;
};
function assertCatalogReadSessions(before: ReadSession[], after: ReadSession[], served: Session[]) {
  const key = (row: ReadSession) => JSON.stringify([row.user_id, row.session_id]);
  const keys = new Set(before.map(key));
  expect(after.filter((row) => keys.has(key(row)))).toEqual(before);
  const additional = after.filter((row) => !keys.has(key(row)));
  for (const row of additional) {
    expect(row.user_id).toBe(DEV_USER_SCOPE);
    const { updated_at: _time, ...projection } = row;
    expect(Object.keys(projection).sort()).toEqual(["session", "session_id", "user_id"]);
    expect(
      served.some((session) =>
        isDeepStrictEqual({ user_id: DEV_USER_SCOPE, session_id: session.id, session }, projection),
      ),
    ).toBe(true);
  }
  expect(after).toHaveLength(before.length + additional.length);
}
async function localSnapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("afc-session-v1");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const stores = ["catalogs", "drafts", "outbox", "sessions", "routines"];
    const tx = db.transaction(stores, "readonly");
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Catalog observation aborted"));
      tx.onerror = () => reject(tx.error);
    });
    const read = (name: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    try {
      const [[catalogs, drafts, outbox, sessions, routines]] = await Promise.all([
        Promise.all(stores.map(read)),
        completed,
      ]);
      return {
        catalogs: catalogs as { catalog: Exercise[]; updated_at: string }[],
        drafts: drafts as ReadDraft[],
        outbox,
        sessions: sessions as ReadSession[],
        routines,
      };
    } finally {
      db.close();
    }
  });
}
/** Deliver real GETs before fixing a snapshot's authority set; hold later deliveries outside it. */
async function catalogReadWindows(page: Page) {
  const served: Session[] = [];
  const deliveries = new Set<Promise<void>>();
  const handlers = new Set<Promise<void>>();
  let closing = false;
  let barrier: Promise<void> | null = null;
  let resume = () => {};
  const pattern = /\/v1\/sessions\/[^/?]+(?:\?.*)?$/;
  const handler = (route: Route) => {
    const active = (async () => {
      if (closing || route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const session = response.status() === 200 ? ((await response.json()) as Session) : null;
      while (barrier) await barrier;
      const delivery = (async () => {
        await route.fulfill({ response });
        if (session) served.push(session);
      })();
      deliveries.add(delivery);
      try {
        await delivery;
      } finally {
        deliveries.delete(delivery);
      }
    })();
    handlers.add(active);
    return active.finally(() => handlers.delete(active));
  };
  await page.route(pattern, handler);
  return {
    async snapshot() {
      expect(barrier).toBeNull();
      barrier = new Promise<void>((resolve) => {
        resume = resolve;
      });
      try {
        await Promise.all([...deliveries]);
        const authority = served.slice();
        const snapshot = await localSnapshot(page);
        return { snapshot, authority };
      } finally {
        barrier = null;
        resume();
      }
    },
    async close() {
      closing = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Catalog read handler drain timed out; active=${handlers.size}`)),
          30_000,
        );
      });
      try {
        while (handlers.size) await Promise.race([Promise.all([...handlers]), timeout]);
      } finally {
        clearTimeout(timer);
      }
      await page.unroute(pattern, handler);
    },
  };
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
  for (const query of ["고정식 자전거", "Stationary Bike"]) {
    await picker.getByRole("searchbox", { name: "운동 검색" }).fill(query);
    await expect(picker.getByRole("button", { name: /고정식 자전거/ })).toHaveCount(0);
    await expect(picker.getByText(/검색 결과가 없어요/)).toBeVisible();
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
    // Bodyweight-only generation leaves the six machine targets available for explicit add.
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

/** Observe element focus separately from document activation; never move either one. */
async function pickerFocusState(page: Page, stage: string) {
  return page
    .evaluate((label) => {
      const active = document.activeElement;
      return {
        stage: label,
        activeElement: active
          ? { tag: active.tagName, id: active.id, text: active.textContent?.trim().slice(0, 160) }
          : null,
        hasFocus: document.hasFocus(),
        dialogExists: document.getElementById("exercise-picker") !== null,
      };
    }, stage)
    .catch((error: unknown) => ({ stage, readError: String(error) }));
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
    const focusObservations: Array<Awaited<ReturnType<typeof pickerFocusState>>> = [];
    const observeFocus = async (stage: string) => {
      focusObservations.push(await pickerFocusState(page, stage));
    };
    try {
      await observeFocus("before-open-click");
      const picker = await openPicker(page);
      await observeFocus("after-open-click");
      await expect(picker.getByRole("tab", { name: "가슴" })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(picker.getByRole("tab", { name: "등" })).toBeFocused();
      const search = picker.getByRole("searchbox", { name: "운동 검색" });
      await search.fill("시티드 머신 로우");
      await expect(picker.getByText("전체 부위에서 검색해요.")).toBeVisible();
      await expect(
        picker.getByRole("button", { name: "머신 로우 머신", exact: true }),
      ).toBeVisible();
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
      await observeFocus("before-axe");
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      await observeFocus("after-axe");
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
      await observeFocus("after-escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(search).toHaveValue("");
    } finally {
      await observeFocus("finally");
      await testInfo.attach(`picker-focus-${width}`, {
        body: JSON.stringify(focusObservations, null, 2),
        contentType: "application/json",
      });
    }
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

test("old106 partial-page failure preserves cache; retry fills111 and warm offline search survives reload @chromium-only", async ({
  page,
  context,
  request,
}, testInfo) => {
  const served: Session[] = [],
    reads: Promise<void>[] = [];
  const wire: unknown[] = [];
  let nativePerformedPuts = 0;
  await page.exposeFunction("__catalogPerformedPut", (increment: boolean) => {
    if (increment) nativePerformedPuts++;
    return nativePerformedPuts;
  });
  page.on("response", (response) => {
    if (response.request().method() === "GET" && /\/v1\/sessions\/[^/?]+$/.test(response.url()))
      reads.push(
        response
          .json()
          .then((session: Session) => {
            served.push(session);
          })
          .catch(() => undefined),
      );
  });
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/v1/sync")) {
      const body = request.postDataJSON() as { mutations?: { entity: string }[] };
      wire.push(...(body.mutations ?? []).filter((row) => row.entity === "performed_set"));
    } else if (/\/sessions\/[^/]+\/complete$/.test(request.url())) wire.push("complete");
  });
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "outbox" && value?.entity === "performed_set")
        void (
          window as typeof window & {
            __catalogPerformedPut: (increment: boolean) => Promise<number>;
          }
        ).__catalogPerformedPut(true);
      return put.call(this, value, ...args);
    };
  });
  const full = await allExercises(request);
  const old = full.filter((item) => !newIds.includes(item.id) && item.id !== "e_stationary_bike");
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
  await warmSessionDocument(page);
  // Positive control: a real user completion reaches the same native and wire observers.
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = (await check.getAttribute("aria-label"))!.replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(name + " 1세트 횟수, 회", { exact: true }).fill("8");
  await check.click();
  await page.getByRole("button", { name: "휴식 종료", exact: true }).click();
  await expect.poll(async () => (await localSnapshot(page)).outbox.length).toBe(0);
  expect(wire.length).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & { __catalogPerformedPut: (increment: boolean) => Promise<number> }
      ).__catalogPerformedPut(false),
    ),
  ).toBeGreaterThan(0);
  const before = await localSnapshot(page);
  const userRows = before.drafts.filter((row) => row.session_id === sessionId);
  expect(userRows).toHaveLength(1);
  expect(userRows[0]).toMatchObject({ completed: true, actual_reps: 8 });
  expect(before.outbox).toEqual([]);
  assertCatalogReadDrafts(before.drafts, before.drafts, served);
  wire.length = 0;
  nativePerformedPuts = 0;
  // Positive authority control: the following real server write has no local draft yet.
  const serverSession = (await (
    await request.get(API_V1 + "/sessions/" + sessionId)
  ).json()) as Session;
  const serverOnly = serverSession.planned_sets.find(
    (set) => set.id !== userRows[0].planned_set_id,
  )!;
  expect(serverOnly).toBeDefined();
  expect(before.drafts.some((row) => row.planned_set_id === serverOnly.id)).toBe(false);
  const serverClient = randomUUID();
  const externalWrite = await request.post(API_V1 + "/sync", {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
    data: {
      mutations: [
        {
          client_id: serverClient,
          entity: "performed_set",
          entity_id: serverOnly.id,
          op: "upsert",
          updated_at: new Date().toISOString(),
          payload: { actual_weight: 0, actual_reps: 9, actual_rir: 2, completed: true },
        },
      ],
    },
  });
  expect(externalWrite.status()).toBe(200);
  expect((await externalWrite.json()).applied).toEqual([serverClient]);
  expect(before.catalogs[0].catalog).toEqual(old);
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
  await Promise.all(reads);
  assertCatalogReadDrafts(before.drafts, failed.drafts, served);
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
  expect(
    complete.catalogs[0].catalog.filter(
      (item) => !newIds.includes(item.id) && item.id !== "e_stationary_bike",
    ),
  ).toEqual(old);
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
  await Promise.all(reads);
  assertCatalogReadDrafts(complete.drafts, offline.drafts, served);
  assertCatalogReadDrafts(before.drafts, offline.drafts, served);
  expect(
    offline.drafts.filter((row) => userRows.some((user) => draftKey(user) === draftKey(row))),
  ).toEqual(userRows);
  expect(offline.drafts.find((row) => row.planned_set_id === serverOnly.id)).toMatchObject({
    completed: true,
    actual_reps: 9,
  });
  expect(wire).toEqual([]);
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & { __catalogPerformedPut: (increment: boolean) => Promise<number> }
      ).__catalogPerformedPut(false),
    ),
  ).toBe(0);
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
  await warmSessionDocument(page);
  const before = await localSnapshot(page);
  expect(before.catalogs).toEqual([]);
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

test.describe("catalog partial-failure transport", () => {
  test.use({ serviceWorkers: "block" });

  test("catalog-read-helper-calibration accepts native authority rows with synthetic comparison baselines", async ({
    page,
    request,
  }, testInfo) => {
    await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
    const sessionId = await todaySession(request);
    const initialSessionResponse = await request.get(`${API_V1}/sessions/${sessionId}`);
    expect(initialSessionResponse.status()).toBe(200);
    const initialSession = (await initialSessionResponse.json()) as Session;
    const recordedSet = initialSession.planned_sets.find((set) => set.target_reps_low !== null)!;
    expect(recordedSet).toBeDefined();
    expect(recordedSet.performed_set).toBeNull();
    const recordClient = randomUUID();
    const recorded = await request.post(`${API_V1}/sync`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
      data: {
        mutations: [
          {
            client_id: recordClient,
            entity: "performed_set",
            entity_id: recordedSet.id,
            op: "upsert",
            updated_at: new Date().toISOString(),
            payload: { actual_weight: 0, actual_reps: 8, actual_rir: 2, completed: true },
          },
        ],
      },
    });
    expect(recorded.status()).toBe(200);
    expect((await recorded.json()).applied).toEqual([recordClient]);
    const sessionReads = await catalogReadWindows(page);
    try {
      await openSession(page, sessionId);
      await expect
        .poll(async () => {
          const window = await sessionReads.snapshot();
          return window.snapshot.drafts.some(
            (row) =>
              row.session_id === sessionId &&
              row.planned_set_id === recordedSet.id &&
              row.completed,
          );
        })
        .toBe(true);
      const nativeWindow = await sessionReads.snapshot();
      const projection = nativeWindow.snapshot.drafts.filter(
        (row) => row.session_id === sessionId && row.planned_set_id === recordedSet.id,
      );
      const mirror = nativeWindow.snapshot.sessions.filter((row) => row.session_id === sessionId);
      expect(projection).toHaveLength(1);
      expect(mirror).toHaveLength(1);
      expect(nativeWindow.snapshot.outbox).toEqual([]);
      // These empty comparison inputs calibrate the helper's acceptance branch.
      // They are not this runtime's before state or evidence of a product snapshot delta.
      assertCatalogReadDrafts([], projection, nativeWindow.authority);
      assertCatalogReadSessions([], mirror, nativeWindow.authority);
      await testInfo.attach("catalog-read-helper-calibration-counts", {
        body: JSON.stringify({
          nativeDraftRows: projection.length,
          nativeSessionRows: mirror.length,
          servedAuthorityCount: nativeWindow.authority.length,
          syntheticComparisonBaselines: true,
        }),
        contentType: "application/json",
      });
    } finally {
      await sessionReads.close();
    }
  });

  test("cold partial failure has no cache or false empty results; explicit retry preserves query and completes", async ({
    page,
    request,
  }, testInfo) => {
    await allExercises(request);
    const firstPage = await request.get(`${API_V1}/exercises`);
    expect(firstPage.status()).toBe(200);
    const { next_cursor: page2Cursor } = (await firstPage.json()) as { next_cursor: string };
    expect(page2Cursor).toEqual(expect.any(String));
    expect(page2Cursor.length).toBeGreaterThan(0);
    await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
    const sessionId = await todaySession(request);
    const sessionReads = await catalogReadWindows(page);
    let phase: "failure" | "retry" = "failure";
    const routeLog: Array<{ phase: string; cursor: string | null; action: string }> = [];
    const requestFailures: Array<{
      phase: string;
      method: string;
      url: string;
      error: string | null;
    }> = [];
    const catalogResponses: Array<{
      phase: string;
      url: string;
      cursor: string | null;
      status: number;
    }> = [];
    page.on("requestfailed", (failedRequest) => {
      if (!failedRequest.url().startsWith(`${API_V1}/exercises`)) return;
      requestFailures.push({
        phase,
        method: failedRequest.method(),
        url: failedRequest.url(),
        error: failedRequest.failure()?.errorText ?? null,
      });
    });
    page.on("response", (response) => {
      if (!response.url().startsWith(`${API_V1}/exercises`)) return;
      catalogResponses.push({
        phase,
        url: response.url(),
        cursor: new URL(response.url()).searchParams.get("cursor"),
        status: response.status(),
      });
    });
    const successfulFailurePages = () =>
      catalogResponses.filter(
        (response) =>
          response.phase === "failure" && response.cursor !== null && response.status === 200,
      );
    await page.route("**/v1/exercises*", async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor) {
        await route.abort("failed");
        routeLog.push({ phase, cursor, action: "aborted" });
      } else {
        await route.continue();
        routeLog.push({ phase, cursor, action: "continued" });
      }
    });
    try {
      await page.goto(`/session/${sessionId}`);
      await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(() => routeLog)
        .toContainEqual({ phase: "failure", cursor: page2Cursor, action: "aborted" });
      await expect
        .poll(() => requestFailures)
        .toContainEqual(
          expect.objectContaining({
            phase: "failure",
            method: "GET",
            url: `${API_V1}/exercises?cursor=${encodeURIComponent(page2Cursor)}`,
          }),
        );
      expect(successfulFailurePages()).toEqual([]);
      const picker = await openPicker(page);
      await picker.getByRole("searchbox", { name: "운동 검색" }).fill("Low Row Machine");
      await expect(
        picker.getByText("운동 목록을 불러올 수 없어요. 연결 후 다시 시도해 주세요."),
      ).toBeVisible();
      await expect(picker.getByText(/검색 결과가 없어요/)).toHaveCount(0);
      const failedWindow = await sessionReads.snapshot();
      const failed = failedWindow.snapshot;
      expect(failed.catalogs).toEqual([]);
      expect(failed.outbox).toEqual([]);
      expect(failed.drafts.every((row) => row.user_id === DEV_USER_SCOPE)).toBe(true);
      expect(failed.sessions.every((row) => row.user_id === DEV_USER_SCOPE)).toBe(true);
      assertCatalogReadDrafts(failed.drafts, failed.drafts, failedWindow.authority);
      assertCatalogReadSessions(failed.sessions, failed.sessions, failedWindow.authority);
      expect(successfulFailurePages()).toEqual([]);
      phase = "retry";
      await page.unroute("**/v1/exercises*");
      await picker.getByRole("button", { name: "다시 시도", exact: true }).click();
      await expect(picker.getByRole("searchbox", { name: "운동 검색" })).toHaveValue(
        "Low Row Machine",
      );
      await expect(
        picker.getByRole("button", { name: "로우 로우 머신 머신", exact: true }),
      ).toBeVisible();
      const completeWindow = await sessionReads.snapshot();
      const complete = completeWindow.snapshot;
      expect(complete.catalogs[0].catalog).toHaveLength(CATALOG_COUNT);
      assertCatalogReadDrafts(failed.drafts, complete.drafts, completeWindow.authority);
      expect(complete.outbox).toEqual(failed.outbox);
      assertCatalogReadSessions(failed.sessions, complete.sessions, completeWindow.authority);
      expect(complete.routines).toEqual(failed.routines);
      await testInfo.attach("cold-read-window-v3-counts", {
        body: JSON.stringify({
          failedDraftCount: failed.drafts.length,
          completeDraftCount: complete.drafts.length,
          failedSessionCount: failed.sessions.length,
          completeSessionCount: complete.sessions.length,
          failedAuthorityCount: failedWindow.authority.length,
          completeAuthorityCount: completeWindow.authority.length,
          outboxExact: JSON.stringify(failed.outbox) === JSON.stringify(complete.outbox),
          routinesExact: JSON.stringify(failed.routines) === JSON.stringify(complete.routines),
        }),
        contentType: "application/json",
      });
      await testInfo.attach("cold-failure-retry", {
        body: JSON.stringify({ failed, complete }),
        contentType: "application/json",
      });
    } finally {
      const serviceWorker = await page
        .evaluate(async () => ({
          controller: navigator.serviceWorker.controller?.scriptURL ?? null,
          registrations: (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
            scope: registration.scope,
            active: registration.active?.scriptURL ?? null,
            waiting: registration.waiting?.scriptURL ?? null,
            installing: registration.installing?.scriptURL ?? null,
          })),
        }))
        .catch((error: unknown) => ({ readError: String(error) }));
      const local = await localSnapshot(page).catch((error: unknown) => ({
        readError: String(error),
      }));
      await testInfo.attach("cold-partial-transport", {
        body: JSON.stringify(
          { page2Cursor, phase, routeLog, requestFailures, catalogResponses, serviceWorker, local },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await sessionReads.close();
    }
  });
});
