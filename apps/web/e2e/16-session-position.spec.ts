/** Ticket03 actual wiring. No append API, storage transplantation, or test-owned database writes. */
import AxeBuilder from "@axe-core/playwright";
import {
  chromium,
  type APIRequestContext,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Page,
  type Route,
  type Response,
  type TestInfo,
  type Worker,
} from "@playwright/test";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as realDelay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { API_V1, WEB_ORIGIN, openSession, seedExternalLoadProgram, todaySession } from "./helpers";
import { TEST_NOW } from "./test-today";
import { warmSessionDocument } from "./support/warm-session-document";
import { launchOwnedPersistentBrowser } from "./support/owned-persistent-browser";
import {
  assertPositionRun,
  committedParity,
  draftFor,
  freshPositionProfile,
  ownPositionContext,
  positionObservation,
} from "./support/session-position-observation";

type Planned = {
  id: string;
  exercise_id: string;
  set_no: number;
  load_kind: string;
  performed_set?: {
    completed: boolean;
    actual_weight: number | null;
    actual_reps: number | null;
  } | null;
};
type Session = { id: string; planned_sets: Planned[]; status: string };

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, context }) => {
  await assertPositionRun(request);
  ownPositionContext(context);
});

async function session(request: APIRequestContext, id: string): Promise<Session> {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Session>;
}

async function setup(request: APIRequestContext) {
  await seedExternalLoadProgram(request);
  const id = await todaySession(request);
  const value = await session(request, id);
  // Select a real external-load row well below the first card: scrolling to the first row cannot pass.
  const candidates = value.planned_sets.filter((set) => set.load_kind === "external");
  expect(candidates.length).toBeGreaterThan(3);
  return { id, value, target: candidates.at(-2)! };
}

function row(page: Page, id: string) {
  return page.locator(`[data-set-check="${id}"]`).locator("xpath=ancestor::li[1]");
}
function weight(page: Page, id: string) {
  return page.locator(`[id="set-${id}-weight"]`);
}

async function positionAt(page: Page, id: string, target: Planned, expanded = false) {
  await expect
    .poll(async () => (await positionObservation(page, id)).position)
    .toMatchObject({ exercise_id: target.exercise_id, planned_set_id: target.id, expanded });
  expect((await positionObservation(page, id)).positionRecord).toMatchObject({
    v: 1,
    session_id: id,
  });
  return positionObservation(page, id);
}

async function evidence(info: TestInfo, name: string, value: unknown) {
  await info.attach(`${name}.json`, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

async function assertSummary(page: Page, count: number, externalVolume: number) {
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await expect(
    page.getByText(`오늘 ${count}세트, ${externalVolume}kg 들었어요.`, { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("완료 세트", { exact: true })
      .locator("..")
      .getByText(`${count}세트`, { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("총 볼륨", { exact: true })
      .locator("..")
      .getByText(`${externalVolume}kg`, { exact: true }),
  ).toBeVisible();
}

/** Observe native calls without issuing writes, changing their arguments, or retaining health values. */
async function observeSummaryWrites(context: BrowserContext) {
  await context.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, "__afcSummaryWrites", { value: writes });
    for (const method of ["add", "put", "delete", "clear"] as const) {
      const original = IDBObjectStore.prototype[method];
      Object.defineProperty(IDBObjectStore.prototype, method, {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore, ...args: unknown[]) {
          if (
            this.transaction.db.name === "afc-session-v1" &&
            ["drafts", "outbox"].includes(this.name)
          )
            writes.push(`${this.name}.${method}`);
          return Reflect.apply(original, this, args);
        },
      });
    }
  });
}

async function summaryWrites(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __afcSummaryWrites: string[] }).__afcSummaryWrites,
  );
}

/** Isolate read projection from the existing, legitimate sync-to-draft materializer. */
async function holdSummarySync(context: BrowserContext) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Set<Promise<void>>();
  const observed = { intercepted: 0, captured200: 0, delivered: 0, aborted: 0 };
  const onResponse = (response: Response) => {
    if (response.url() === `${API_V1}/sync`) observed.delivered += 1;
  };
  context.on("response", onResponse);
  const handler = (route: Route) => {
    const task = (async () => {
      expect(route.request().url()).toBe(`${API_V1}/sync`);
      expect(route.request().method()).toBe("POST");
      observed.intercepted += 1;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      observed.captured200 += 1;
      await held;
      // No fabricated empty/applied response, and no late ACK materialization in the next case.
      await route.abort("aborted");
      observed.aborted += 1;
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  await context.route("**/v1/sync", handler);
  return {
    observed,
    async assertHeld() {
      await expect.poll(() => observed.captured200).toBeGreaterThan(0);
      expect(observed.delivered).toBe(0);
      expect(observed.aborted).toBe(0);
    },
    async close() {
      release();
      // Removing a live handler lets Playwright continue its request. Finish our
      // owned aborts first, including requests intercepted while cleanup drains.
      while (pending.size > 0) await Promise.all([...pending]);
      await context.unroute("**/v1/sync", handler);
      context.off("response", onResponse);
    },
  };
}

function authoritativeSummary(value: Session) {
  const completed = value.planned_sets.filter((set) => set.performed_set?.completed === true);
  return {
    count: completed.length,
    volume: completed.reduce(
      (sum, set) =>
        sum +
        (set.load_kind === "external"
          ? (set.performed_set!.actual_weight ?? 0) * (set.performed_set!.actual_reps ?? 0)
          : 0),
      0,
    ),
  };
}

async function restoredRow(page: Page, target: Planned, expanded: boolean) {
  await expect(row(page, target.id)).toHaveAttribute("data-session-current", "true");
  await expect(row(page, target.id)).toHaveAttribute("data-expanded", String(expanded));
  await expect(row(page, target.id)).toBeInViewport({ ratio: 0.8 });
  await expect(weight(page, target.id)).toBeVisible();
  if (expanded)
    await expect(row(page, target.id).getByRole("button", { name: /기록 접기$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  expect(await page.evaluate(() => document.activeElement instanceof HTMLInputElement)).toBe(false);
}

async function complete(page: Page, target: Planned) {
  await weight(page, target.id).fill("47.5");
  await page.locator(`[id="set-${target.id}-reps"]`).fill("9");
  await page.locator(`[id="set-${target.id}-rir"]`).fill("2");
  await page.locator(`[data-set-check="${target.id}"]`).click();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toBeVisible();
}

async function closeRest(page: Page) {
  await page
    .getByRole("dialog", { name: /후 휴식/ })
    .getByRole("button", { name: "휴식 종료" })
    .click();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
}

async function expandCompleted(page: Page, id: string) {
  await row(page, id)
    .getByRole("button", { name: /기록,.*수정하려면 누르세요$/ })
    .click();
  await expect(weight(page, id)).toBeVisible();
}

async function background40(page: Page, id: string, info: TestInfo, label: string) {
  const before = await positionObservation(page, id);
  let cover: Page | undefined;
  let originalCdp: CDPSession | undefined;
  let coverCdp: CDPSession | undefined;
  let failed = false;
  let result!: Awaited<ReturnType<typeof positionObservation>>;
  const cleanupErrors: unknown[] = [];
  const observations: unknown[] = [];
  const nativeState = (target: Page) =>
    target.evaluate(() => ({
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    }));
  const observe = async (stage: string) => {
    observations.push({
      stage,
      at: Date.now(),
      pages: await Promise.all(
        [
          { name: "original", target: page, cdp: originalCdp },
          { name: "cover", target: cover, cdp: coverCdp },
        ].map(async ({ name, target, cdp }) => ({
          name,
          state: target && (await diagnosticRead(`${name}-state`, () => nativeState(target))),
          window:
            cdp &&
            (await diagnosticRead(`${name}-window`, () => cdp.send("Browser.getWindowForTarget"))),
        })),
      ),
    });
  };
  try {
    cover = await page.context().newPage();
    await cover.goto("about:blank");
    originalCdp = await page.context().newCDPSession(page);
    coverCdp = await page.context().newCDPSession(cover);
    await observe("before-focus-emulation-disabled");
    // Remove Playwright's focused/active override; visibility still comes from actual tab selection.
    await originalCdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await coverCdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await page.bringToFront();
    await observe("original-front-requested");
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await cover.bringToFront();
    await observe("cover-front-requested");
    const coverPage = cover;
    await expect
      .poll(() =>
        Promise.all([
          page.evaluate(() => document.visibilityState),
          coverPage.evaluate(() => document.visibilityState),
        ]),
      )
      .toEqual(["hidden", "visible"]);
    const hiddenAt = Date.now();
    await observe("original-hidden");
    const hiddenBefore = await positionObservation(page, id);
    await realDelay(40_000);
    const hiddenAfter = await positionObservation(page, id);
    const elapsed = Date.now() - hiddenAt;
    expect(elapsed).toBeGreaterThanOrEqual(40_000);
    expect(hiddenAfter.visibility).toBe("hidden");
    expect(committedParity(hiddenAfter)).toEqual(committedParity(before));
    await observe("after-actual-40-seconds");
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await observe("original-front-restored");
    const observed = await positionObservation(page, id);
    await evidence(info, label, { before, hiddenBefore, hiddenAfter, observed, elapsed });
    result = observed;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await observe("finally-before-cleanup");
    const cleanup = await Promise.allSettled([originalCdp?.detach(), coverCdp?.detach()]);
    cleanup.push(
      ...(await Promise.allSettled([
        cover && !cover.isClosed() ? cover.close() : Promise.resolve(),
      ])),
    );
    const attachment = await diagnosticRead("background-native-attachment", () =>
      evidence(info, `${label}-native-visibility`, {
        failed,
        observations,
        cleanup: cleanup.map((result) =>
          result.status === "rejected"
            ? { status: result.status, error: String(result.reason) }
            : result,
        ),
      }),
    );
    if (attachment.status !== "observed") console.warn(attachment);
    for (const settled of cleanup)
      if (settled.status === "rejected") cleanupErrors.push(settled.reason);
  }
  // Reached only after successful assertions; an original error propagates through finally unchanged.
  if (cleanupErrors.length) throw cleanupErrors[0];
  return result;
}

for (const width of [360, 390, 430]) {
  test(`${width}px: active row survives A→B→A/reload; keyboard, overflow and axe`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const a = await setup(request);
    const b = await setup(request);
    await openSession(page, a.id);
    await weight(page, a.target.id).focus();
    // Uncommitted text is intentionally NOT written or claimed to survive a document replacement.
    const before = await positionAt(page, a.id, a.target);
    await openSession(page, b.id);
    await weight(page, b.target.id).focus();
    const bPosition = await positionAt(page, b.id, b.target);
    await openSession(page, a.id);
    await restoredRow(page, a.target, false);
    expect((await positionObservation(page, b.id)).position).toEqual(bPosition.position);
    await page.reload();
    await restoredRow(page, a.target, false);
    expect((await positionObservation(page, a.id)).position).toEqual(before.position);
    // Explicit keyboard interaction is allowed to focus; restoration itself above must not.
    await weight(page, a.target.id).focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(`[id="set-${a.target.id}-reps"]`)).toBeFocused();
    const menuLabel = await page
      .locator(`[data-set-check="${a.target.id}"]`)
      .getAttribute("aria-label");
    const name = menuLabel!.replace(/ \d+세트 완료 처리$/, "");
    const trigger = page.getByRole("button", { name: `${name} 메뉴`, exact: true });
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    await row(page, a.target.id).scrollIntoViewIfNeeded();
    await info.attach(`target-${width}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await evidence(info, "position-route-reload", {
      before,
      after: await positionObservation(page, a.id),
      dimensions,
    });
  });
}

// E2E09:178–179/192–196 records WebKit's full-offline document navigation boundary
// (introduced b3148e5f, retained in 111bd43). The API-blocked new-page cases below are separate.
test("completed expanded row restores offline without copying uncommitted text @chromium-only", async ({
  page,
  request,
  context,
}, info) => {
  const a = await setup(request);
  const b = await setup(request);
  const urls = [a.id, b.id].map((id) => new URL(`/session/${id}`, WEB_ORIGIN).href);
  const observations: unknown[] = [];
  const timeline: unknown[] = [];
  type NativeRequest = import("@playwright/test").Request;
  const requestIds = new WeakMap<NativeRequest, number>();
  let nextRequestId = 0;
  let phase = "online-warm";
  let originalError: string | null = null;
  const recordRequest = (event: string, value: NativeRequest, detail = {}) => {
    if (!urls.includes(value.url())) return;
    if (!requestIds.has(value)) requestIds.set(value, ++nextRequestId);
    timeline.push({
      event,
      phase,
      observedAt: Date.now(),
      requestId: requestIds.get(value),
      url: value.url(),
      method: value.method(),
      resourceType: value.resourceType(),
      navigation: value.isNavigationRequest(),
      ...detail,
    });
  };
  const onRequest = (value: NativeRequest) => recordRequest("request", value);
  const onResponse = (value: Response) =>
    recordRequest("response", value.request(), {
      status: value.status(),
      fromServiceWorker: value.fromServiceWorker(),
    });
  const onRequestFailed = (value: NativeRequest) =>
    recordRequest("requestfailed", value, { failure: value.failure() });
  const observeDocuments = async (label: string) => {
    const result = await diagnosticRead(label, () =>
      page.evaluate(async (exactUrls) => {
        const documents = await Promise.all(
          exactUrls.map(async (requestedUrl) => {
            try {
              const cached = await caches.match(requestedUrl, { cacheName: "afc-pages-v1" });
              return {
                requestedUrl,
                cached: cached
                  ? {
                      status: cached.status,
                      type: cached.type,
                      contentType: cached.headers.get("content-type"),
                      url: cached.url,
                      vary: cached.headers.get("vary"),
                    }
                  : null,
              };
            } catch (error) {
              return { requestedUrl, readError: String(error) };
            }
          }),
        );
        const worker = (value: ServiceWorker | null) =>
          value ? { scriptURL: value.scriptURL, state: value.state } : null;
        const registrations = await navigator.serviceWorker.getRegistrations().then(
          (values) =>
            values.map((value) => ({
              scope: value.scope,
              active: worker(value.active),
              waiting: worker(value.waiting),
              installing: worker(value.installing),
            })),
          (error: unknown) => ({ readError: String(error) }),
        );
        return {
          observedAt: Date.now(),
          documentUrl: location.href,
          online: navigator.onLine,
          controller: worker(navigator.serviceWorker.controller),
          registrations,
          documents,
        };
      }, urls),
    );
    observations.push({
      ...result,
      readError: result.status === "observed" ? null : result,
    });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  try {
    await openSession(page, b.id);
    await warmSessionDocument(page);
    await openSession(page, a.id);
    await warmSessionDocument(page);
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    // This is an actual blocked request, not a synthetic offline event.
    expect(
      await page.evaluate(
        async (url) =>
          fetch(url, { cache: "no-store" }).then(
            () => false,
            () => true,
          ),
        `${API_V1}/me`,
      ),
    ).toBe(true);
    await complete(page, a.target);
    await closeRest(page);
    await expandCompleted(page, a.target.id);
    const before = await positionAt(page, a.id, a.target, true);
    expect(draftFor(before, a.target.id)).toMatchObject({
      actual_weight: 47.5,
      actual_reps: 9,
      actual_rir: 2,
      completed: true,
    });
    expect(before.outbox).toHaveLength(1);
    expect(before.serviceWorker).not.toBeNull();
    expect(before.documentCached).toBe(true);
    phase = "offline-A-to-B";
    await observeDocuments("before-offline-A-to-B");
    await openSession(page, b.id);
    await expect(page.locator(`[data-set-check="${a.target.id}"]`)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
    phase = "offline-B-to-A";
    await openSession(page, a.id);
    await restoredRow(page, a.target, true);
    phase = "offline-A-reload";
    await page.reload();
    await restoredRow(page, a.target, true);
    const after = await positionObservation(page, a.id);
    expect(committedParity(after)).toEqual(committedParity(before));
    await expect(weight(page, a.target.id)).toHaveValue("47.5");
    await expect(page.locator(`[id="set-${a.target.id}-reps"]`)).toHaveValue("9");
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    await info.attach("completed-expanded-restored.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await evidence(info, "offline-expanded", { before, after });
  } catch (error) {
    originalError = String(error);
    throw error;
  } finally {
    try {
      if (originalError !== null) await observeDocuments("failure-finally");
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      await evidence(info, "offline-document-navigation", {
        urls,
        phase,
        originalError,
        observations,
        timeline,
        listenersRemoved: true,
      }).catch((error: unknown) => {
        // Attachment errors must not replace the original navigation/assertion failure.
        console.warn("offline-document-navigation attachment readError", String(error));
      });
    }
  }
});

for (const mode of ["timer", "expanded"] as const) {
  test(`API-blocked same-context new page restores committed ${mode} position`, async ({
    page,
    context,
    request,
  }, info) => {
    const a = await setup(request);
    const apiUrl = new URL(API_V1);
    const isApi = (url: URL) =>
      url.origin === apiUrl.origin && url.pathname.startsWith(`${apiUrl.pathname}/`);
    const blockedApi: Array<{ method: string; url: string }> = [];
    const successfulApi: Array<{ method: string; url: string; status: number }> = [];
    const transitions: unknown[] = [];
    const pending = new Set<Promise<void>>();
    const cleanupErrors: unknown[] = [];
    const routeErrors: string[] = [];
    let resumed: Page | undefined;
    let routeInstalled = false;
    let originalError: string | null = null;
    let timerCommitted: Awaited<ReturnType<typeof positionObservation>> | undefined;
    let beforeClose: typeof timerCommitted;
    let restored: typeof timerCommitted;
    const onResponse = (response: Response) => {
      if (isApi(new URL(response.url())) && response.status() >= 200 && response.status() < 300)
        successfulApi.push({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
        });
    };
    const abortApi = (route: Route) => {
      const task = route
        .abort("failed")
        .then(() => {
          blockedApi.push({ method: route.request().method(), url: route.request().url() });
        })
        .catch((error: unknown) => {
          routeErrors.push(String(error));
        });
      pending.add(task);
      return task.finally(() => pending.delete(task));
    };
    const workerState = (target: Page) =>
      target.evaluate(async () => ({
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        registrations: (await navigator.serviceWorker.getRegistrations()).map(
          (value) => value.scope,
        ),
      }));
    try {
      expect(context.pages()).toEqual([page]);
      await openSession(page, a.id);
      await warmSessionDocument(page);
      await context.setOffline(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      expect(
        await page.evaluate(
          async (url) =>
            fetch(url, { cache: "no-store" }).then(
              () => false,
              () => true,
            ),
          `${API_V1}/me`,
        ),
      ).toBe(true);
      await complete(page, a.target);
      await expect.poll(async () => (await positionObservation(page, a.id)).timer).not.toBeNull();
      timerCommitted = await positionAt(page, a.id, a.target);
      expect(timerCommitted.transactionCompleted).toBe(true);
      expect(timerCommitted.serviceWorker).not.toBeNull();
      expect(timerCommitted.documentCached).toBe(true);
      expect(draftFor(timerCommitted, a.target.id)).toMatchObject({
        actual_weight: 47.5,
        actual_reps: 9,
        actual_rir: 2,
        completed: true,
      });
      expect(draftFor(timerCommitted, a.target.id)?.client_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(timerCommitted.outbox).toHaveLength(1);
      expect(timerCommitted.outbox[0]).toMatchObject({
        client_id: draftFor(timerCommitted, a.target.id)!.client_id,
        entity: "performed_set",
        entity_id: a.target.id,
      });
      const plannedRestSec = (a.target as Planned & { rest_sec: number }).rest_sec;
      expect(plannedRestSec).toBeGreaterThan(0);
      expect(timerCommitted.timer).toMatchObject({
        v: 2,
        planned_set_id: a.target.id,
        total_sec: plannedRestSec,
      });
      expect(Number(timerCommitted.timer!.ends_at)).toBeGreaterThan(timerCommitted.observedAt);
      if (mode === "expanded") {
        await closeRest(page);
        await expandCompleted(page, a.target.id);
        await expect.poll(async () => (await positionObservation(page, a.id)).timer).toBeNull();
      }
      const committed = await positionAt(page, a.id, a.target, mode === "expanded");
      expect(committed.drafts).toEqual(timerCommitted.drafts);
      expect(committed.outbox).toEqual(timerCommitted.outbox);
      // As in E2E09, unregister while fully offline, then close the only live page.
      const unregistered = await page.evaluate(async () => {
        const values = await navigator.serviceWorker.getRegistrations();
        return Promise.all(values.map((value) => value.unregister()));
      });
      expect(unregistered.length).toBeGreaterThan(0);
      expect(unregistered.every(Boolean)).toBe(true);
      const unregisteredState = await workerState(page);
      expect(unregisteredState.registrations).toEqual([]);
      transitions.push({ phase: "unregistered-while-offline", unregistered, unregisteredState });
      beforeClose = await positionObservation(page, a.id);
      expect(committedParity(beforeClose)).toEqual(committedParity(committed));
      await page.close();
      expect(page.isClosed()).toBe(true);
      expect(context.pages()).toEqual([]);
      transitions.push({ phase: "old-page-closed", livePages: context.pages().length });
      context.on("response", onResponse);
      await context.route(isApi, abortApi);
      routeInstalled = true;
      expect(context.pages()).toEqual([]);
      await context.setOffline(false);
      expect(context.pages()).toEqual([]);
      transitions.push({ phase: "document-transport-open-api-blocked", livePages: 0 });
      resumed = await context.newPage();
      expect(resumed.context()).toBe(context);
      expect(resumed).not.toBe(page);
      expect(context.pages()).toEqual([resumed]);
      // Page-local E2E09 transport seam: a new worker must not escape the API route abort.
      // This page is closed after observation; no OS process/context restart is claimed.
      await resumed.addInitScript(() => {
        Object.defineProperty(navigator.serviceWorker, "register", {
          configurable: true,
          value: () =>
            Promise.reject(new DOMException("API-blocked new-page transport", "NetworkError")),
        });
      });
      const documentResponse = await resumed.goto(`/session/${a.id}`);
      expect(documentResponse?.status()).toBe(200);
      expect(documentResponse?.fromServiceWorker()).toBe(false);
      await expect
        .poll(() => blockedApi)
        .toContainEqual({
          method: "GET",
          url: `${API_V1}/sessions/${a.id}`,
        });
      // No click, expand, focus or scroll on the new page can manufacture restoration.
      await expect(row(resumed, a.target.id)).toHaveAttribute("data-session-current", "true");
      await expect(row(resumed, a.target.id)).toHaveAttribute(
        "data-expanded",
        String(mode === "expanded"),
      );
      await expect(resumed.locator(`[data-set-check="${a.target.id}"]`)).toHaveAttribute(
        "aria-label",
        /완료 취소$/,
      );
      if (mode === "timer") {
        await expect(resumed.getByRole("dialog", { name: /후 휴식/ })).toBeVisible();
        await expect(row(resumed, a.target.id)).toContainText("47.5kg × 9회");
      } else {
        await restoredRow(resumed, a.target, true);
        await expect(weight(resumed, a.target.id)).toHaveValue("47.5");
        await expect(resumed.locator(`[id="set-${a.target.id}-reps"]`)).toHaveValue("9");
        await expect(resumed.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
      }
      restored = await positionAt(resumed, a.id, a.target, mode === "expanded");
      expect(restored.transactionCompleted).toBe(true);
      expect(committedParity(restored)).toEqual(committedParity(beforeClose));
      expect(restored.positionRecord).toEqual(beforeClose.positionRecord);
      expect(await workerState(resumed)).toEqual({ controller: null, registrations: [] });
      expect(await resumed.evaluate(() => navigator.onLine)).toBe(true);
      if (mode === "timer") {
        const timerDisplay = await resumed.evaluate(() => ({
          at: Date.now(),
          text: document.querySelector('[role="timer"]')?.textContent ?? null,
        }));
        expect(timerDisplay.text?.trim()).toMatch(/^\d+:\d{2}$/);
        const [minutes, seconds] = timerDisplay.text!.trim().split(":").map(Number);
        const remaining = Math.max(
          0,
          Math.ceil((Number(beforeClose.timer!.ends_at) - timerDisplay.at) / 1000),
        );
        expect(Math.abs(minutes * 60 + seconds - remaining)).toBeLessThanOrEqual(1);
        transitions.push({ phase: "restored-timer-absolute-time", timerDisplay, remaining });
      }
      expect(routeErrors).toEqual([]);
      expect(successfulApi).toEqual([]);
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      const finalObservation =
        resumed && !resumed.isClosed()
          ? await diagnosticRead("new-page-finally", async () => ({
              state: await positionObservation(resumed!, a.id),
              worker: await workerState(resumed!),
            }))
          : { status: "new-page-not-opened" };
      for (const target of [resumed, page]) {
        if (target && !target.isClosed())
          await target.close().catch((error: unknown) => cleanupErrors.push(String(error)));
      }
      await Promise.all([...pending]);
      if (routeInstalled)
        await context
          .unroute(isApi, abortApi)
          .catch((error: unknown) => cleanupErrors.push(String(error)));
      context.off("response", onResponse);
      if (routeErrors.length) cleanupErrors.push(...routeErrors);
      if (successfulApi.length)
        cleanupErrors.push("Unexpected successful authoritative API response");
      await evidence(info, `api-blocked-new-page-${mode}`, {
        boundary:
          "Same context, fresh page/document with document transport open and API aborted; not full-offline SW navigation, storage transplant or OS process restart. Only committed numeric drafts are compared.",
        timerCommitted,
        beforeClose,
        restored,
        finalObservation,
        transitions,
        blockedApi,
        successfulApi,
        originalError,
        cleanupErrors,
        livePagesAfterCleanup: context.pages().length,
        pendingHandlers: pending.size,
      }).catch((error: unknown) => cleanupErrors.push(String(error)));
      if (originalError !== null && cleanupErrors.length) console.warn(cleanupErrors);
    }
    if (cleanupErrors.length)
      throw new Error(`New-page observation/cleanup failed: ${cleanupErrors.join("; ")}`);
  });
}

test("deleted active exercise uses current membership fallback, not old position", async ({
  page,
  request,
}, info) => {
  const a = await setup(request);
  await openSession(page, a.id);
  await weight(page, a.target.id).focus();
  const before = await positionAt(page, a.id, a.target);
  const response = await request.delete(
    `${API_V1}/sessions/${a.id}/exercises/${a.target.exercise_id}`,
    { headers: { "X-CSRF-Token": "dev" } },
  );
  expect(response.status()).toBe(200);
  const authoritative = await session(request, a.id);
  expect(authoritative.planned_sets.some((set) => set.id === a.target.id)).toBe(false);
  await page.reload();
  await expect(page.locator(`[data-set-check="${a.target.id}"]`)).toHaveCount(0);
  await expect(row(page, authoritative.planned_sets[0].id)).toHaveAttribute(
    "data-session-current",
    "true",
  );
  await expect(row(page, authoritative.planned_sets[0].id)).toBeInViewport({ ratio: 0.8 });
  await evidence(info, "deleted-fallback", {
    before,
    after: await positionObservation(page, a.id),
    authoritative,
  });
});

test.describe("summary-only read projection (sync transport held; not an offline/SW claim)", () => {
  test.use({ serviceWorkers: "block" });

  test("successful completion clears position; explicit same-day edit persists new expanded row", async ({
    page,
    request,
    context,
    browser,
  }, info) => {
    const a = await setup(request);
    await openSession(page, a.id);
    await complete(page, a.target);
    await closeRest(page);
    await page.getByRole("button", { name: "운동 종료", exact: true }).click();
    await page
      .getByRole("dialog", { name: "운동 종료" })
      .getByRole("button", { name: /종료$/ })
      .click();
    await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
    await expect.poll(async () => (await positionObservation(page, a.id)).position).toBeNull();
    await expect.poll(async () => (await positionObservation(page, a.id)).outbox).toEqual([]);
    const committed = await session(request, a.id);
    expect(committed.status).toBe("completed");
    expect(authoritativeSummary(committed)).toEqual({ count: 1, volume: 427.5 });
    await assertSummary(page, 1, 427.5);
    const beforeReload = await positionObservation(page, a.id);
    await observeSummaryWrites(context);
    const syncHold = await holdSummarySync(context);
    try {
      await page.reload();
      await assertSummary(page, 1, 427.5);
      await syncHold.assertHeld();
      const afterReload = await positionObservation(page, a.id);
      expect(afterReload.drafts).toEqual(beforeReload.drafts);
      expect(afterReload.outbox).toEqual(beforeReload.outbox);
      expect(await summaryWrites(page)).toEqual([]);

      // Server-only completed summary in a genuinely empty context, without storageState/IDB import.
      const fresh = await browser.newContext({
        baseURL: WEB_ORIGIN,
        locale: "ko-KR",
        serviceWorkers: "block",
      });
      ownPositionContext(fresh);
      const freshHold = await holdSummarySync(fresh);
      try {
        await fresh.clock.install({ time: new Date(TEST_NOW) });
        await fresh.clock.resume();
        await observeSummaryWrites(fresh);
        const freshPage = await fresh.newPage();
        await freshPage.goto("/");
        await freshHold.assertHeld();
        await expect
          .poll(() =>
            freshPage.evaluate(async () =>
              (await indexedDB.databases()).some((db) => db.name === "afc-session-v1"),
            ),
          )
          .toBe(true);
        const before = await positionObservation(freshPage, a.id);
        expect(before.drafts).toEqual([]);
        expect(before.outbox).toEqual([]);
        expect(await summaryWrites(freshPage)).toEqual([]);
        await freshPage.goto(`/session/${a.id}`);
        await assertSummary(freshPage, 1, 427.5);
        const after = await positionObservation(freshPage, a.id);
        expect(after.drafts).toEqual(before.drafts);
        expect(after.outbox).toEqual(before.outbox);
        expect(await summaryWrites(freshPage)).toEqual([]);
        await freshPage.reload();
        await assertSummary(freshPage, 1, 427.5);
        const reloaded = await positionObservation(freshPage, a.id);
        expect(reloaded.drafts).toEqual([]);
        expect(reloaded.outbox).toEqual([]);
        expect(await summaryWrites(freshPage)).toEqual([]);
        await evidence(info, "completed-server-only-summary", {
          committed,
          before,
          after,
          reloaded,
          writeCalls: await summaryWrites(freshPage),
          syncHold: freshHold.observed,
        });
      } finally {
        try {
          await freshHold.close();
        } finally {
          await fresh.close();
        }
      }

      await page.getByRole("button", { name: "기록 더하거나 고치기" }).click();
      await expandCompleted(page, a.target.id);
      const edited = await positionAt(page, a.id, a.target, true);
      await page.reload();
      await assertSummary(page, 1, 427.5);
      expect((await positionObservation(page, a.id)).drafts).toEqual(edited.drafts);
      expect((await positionObservation(page, a.id)).outbox).toEqual(edited.outbox);
      expect(await summaryWrites(page)).toEqual([]);
      await page.getByRole("button", { name: "기록 더하거나 고치기" }).click();
      await restoredRow(page, a.target, true);
      expect((await positionObservation(page, a.id)).position).toEqual(edited.position);
      await evidence(info, "completed-explicit-edit", {
        edited,
        beforeReload,
        afterReload,
        committed,
      });
    } finally {
      await syncHold.close();
    }
  });

  test("no saved target and all server sets completed falls back to summary", async ({
    page,
    request,
    context,
  }, info) => {
    const a = await setup(request);
    const mutations = a.value.planned_sets.map((set) => ({
      client_id: randomUUID(),
      entity: "performed_set",
      entity_id: set.id,
      op: "upsert",
      updated_at: TEST_NOW,
      payload: {
        actual_weight: set.load_kind === "external" ? 20 : null,
        actual_reps: set.load_kind === "not_applicable" ? null : 10,
        actual_time_sec: set.load_kind === "not_applicable" ? 30 : null,
        actual_rir: null,
        completed: true,
      },
    }));
    const response = await request.post(`${API_V1}/sync`, {
      headers: { "X-CSRF-Token": "dev" },
      data: { mutations },
    });
    expect(response.status()).toBe(200);
    const result = (await response.json()) as { applied: string[]; conflicts: unknown[] };
    expect(result.conflicts).toEqual([]);
    expect(new Set(result.applied)).toEqual(
      new Set(mutations.map((mutation) => mutation.client_id)),
    );
    const committed = await session(request, a.id);
    const expected = {
      count: mutations.length,
      volume: mutations.reduce(
        (sum, mutation) =>
          sum + (mutation.payload.actual_weight ?? 0) * (mutation.payload.actual_reps ?? 0),
        0,
      ),
    };
    expect(authoritativeSummary(committed)).toEqual(expected);
    expect(expected.volume).toBeGreaterThan(0);
    await observeSummaryWrites(context);
    const syncHold = await holdSummarySync(context);
    try {
      await page.goto("/");
      await syncHold.assertHeld();
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await indexedDB.databases()).some((db) => db.name === "afc-session-v1"),
          ),
        )
        .toBe(true);
      const before = await positionObservation(page, a.id);
      expect(before.drafts).toEqual([]);
      expect(before.outbox).toEqual([]);
      expect(await summaryWrites(page)).toEqual([]);
      await page.goto(`/session/${a.id}`);
      await assertSummary(page, expected.count, expected.volume);
      await expect(page.locator("[data-session-current=true]")).toHaveCount(0);
      const after = await positionObservation(page, a.id);
      expect(after.drafts).toEqual(before.drafts);
      expect(after.outbox).toEqual(before.outbox);
      expect(await summaryWrites(page)).toEqual([]);
      await page.reload();
      await assertSummary(page, expected.count, expected.volume);
      const reloaded = await positionObservation(page, a.id);
      expect(reloaded.drafts).toEqual([]);
      expect(reloaded.outbox).toEqual([]);
      expect(await summaryWrites(page)).toEqual([]);
      await evidence(info, "all-completed-fallback", {
        source: committed,
        expected,
        before,
        after,
        reloaded,
        writeCalls: await summaryWrites(page),
        syncHold: syncHold.observed,
      });
    } finally {
      await syncHold.close();
    }
  });
});

/** Diagnostic failures are data, never replacements for the readiness assertion or cleanup. */
async function diagnosticRead(label: string, read: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .then(
          (value) => ({ label, status: "observed", value }),
          (error: unknown) => ({ label, status: "error", error: String(error) }),
        ),
      new Promise<{ label: string; status: string }>((resolve) => {
        timer = setTimeout(() => resolve({ label, status: "observation-timeout" }), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function persistentWorkerDiagnostics(page: Page, info: TestInfo) {
  const context = page.context();
  const cdp = await context.newCDPSession(page);
  const events: unknown[] = [];
  const record = (kind: string, value: unknown) => {
    events.push({ kind, observedAt: Date.now(), value });
  };
  const onVersion = (value: unknown) => record("workerVersionUpdated", value);
  const onError = (value: unknown) => record("workerErrorReported", value);
  const workers = new Map<Worker, (message: ConsoleMessage) => void>();
  const onWorker = (worker: Worker) => {
    const listener = (message: ConsoleMessage) =>
      record("worker-console", {
        url: worker.url(),
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    workers.set(worker, listener);
    worker.on("console", listener);
    record("worker-created", { url: worker.url() });
  };
  cdp.on("ServiceWorker.workerVersionUpdated", onVersion);
  cdp.on("ServiceWorker.workerErrorReported", onError);
  context.on("serviceworker", onWorker);
  await cdp.send("ServiceWorker.enable");
  return {
    async watchInstalling() {
      record(
        "installing-listener",
        await diagnosticRead("installing-listener", () =>
          page.evaluate(async () => {
            const observed: { state: string; url: string; observedAt: number }[] = [];
            (window as unknown as { __afcWorkerStates: typeof observed }).__afcWorkerStates =
              observed;
            const registration = await navigator.serviceWorker.getRegistration(location.href);
            const watched = new WeakSet<ServiceWorker>();
            const watch = () => {
              const worker = registration?.installing;
              if (!worker || watched.has(worker)) return;
              watched.add(worker);
              const sample = () =>
                observed.push({
                  state: worker.state,
                  url: worker.scriptURL,
                  observedAt: Date.now(),
                });
              worker.addEventListener("statechange", sample);
              sample();
            };
            registration?.addEventListener("updatefound", watch);
            watch();
            return { registered: Boolean(registration), observed };
          }),
        ),
      );
    },
    async finish(failed: boolean) {
      const reads = await Promise.all([
        diagnosticRead("worker-statechanges", () =>
          page.evaluate(
            () => (window as unknown as { __afcWorkerStates?: unknown[] }).__afcWorkerStates ?? [],
          ),
        ),
        ...(failed
          ? [
              diagnosticRead("cache-names", () =>
                cdp.send("CacheStorage.requestCacheNames", { securityOrigin: WEB_ORIGIN }),
              ),
              diagnosticRead("database-names", () =>
                cdp.send("IndexedDB.requestDatabaseNames", { securityOrigin: WEB_ORIGIN }),
              ),
            ]
          : []),
      ]);
      context.off("serviceworker", onWorker);
      for (const [worker, listener] of workers) worker.off("console", listener);
      cdp.off("ServiceWorker.workerVersionUpdated", onVersion);
      cdp.off("ServiceWorker.workerErrorReported", onError);
      const detached = await diagnosticRead("cdp-detach", () => cdp.detach());
      const attached = await diagnosticRead("diagnostic-attachment", () =>
        evidence(info, "persistent-worker-diagnostics", { failed, events, reads, detached }),
      );
      if (attached.status !== "observed")
        console.warn("Persistent diagnostic attachment failed", attached);
    },
  };
}

async function warmPersistentSession(page: Page, info: TestInfo) {
  let stage = "registration";
  let warmed = false;
  const observations: unknown[] = [];
  const observe = async () => {
    const value = await page.evaluate(async (phase) => {
      const registration = await navigator.serviceWorker.getRegistration(location.href);
      return {
        url: location.href,
        visibility: document.visibilityState,
        scope: registration?.scope ?? null,
        installing: registration?.installing?.state ?? null,
        waiting: registration?.waiting?.state ?? null,
        active: registration?.active?.state ?? null,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        workerStatechanges:
          (window as unknown as { __afcWorkerStates?: unknown[] }).__afcWorkerStates ?? [],
        databases:
          phase === "indexeddb" || phase === "controlled-online-warm"
            ? (await indexedDB.databases()).map((db) => db.name)
            : null,
        documentCached:
          phase === "controlled-online-warm"
            ? (await caches.match(location.href, { cacheName: "afc-pages-v1" }))?.ok === true
            : null,
      };
    }, stage);
    observations.push({ stage, observedAt: Date.now(), ...value });
    return value;
  };
  try {
    // Each read-only stage uses the existing expect budget; no indefinite ready promise.
    await expect.poll(async () => (await observe()).scope).toBe(`${WEB_ORIGIN}/`);
    stage = "active";
    await expect.poll(async () => (await observe()).active).toBe("activated");
    stage = "controller";
    await expect.poll(async () => (await observe()).controller).toBe(`${WEB_ORIGIN}/sw.js`);
    stage = "indexeddb";
    await expect.poll(async () => (await observe()).databases).toContain("afc-session-v1");
    stage = "controlled-online-warm";
    await warmSessionDocument(page);
    const after = await observe();
    expect(after.controller).toBe(`${WEB_ORIGIN}/sw.js`);
    expect(after.documentCached).toBe(true);
    warmed = true;
  } finally {
    // Keep the last completed reads even when readiness fails; do not create/reset any store.
    await evidence(info, "persistent-storage-readiness", { stage, warmed, observations });
  }
}

test("@chromium-only owned persistent process: real 40s hidden, durable timer/actual/position, empty context", async ({
  request,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "@chromium-only: persistent Chromium process and real headed visibility",
  );
  // Three real 40s visibility cases (active, timer, expanded) plus three owned process launches.
  // This case budget does not change any assertion timeout, clock speed, global timeout or retry.
  test.setTimeout(240_000);
  const root = process.env.AFC_POSITION_PROFILE_ROOT;
  if (!root)
    throw new Error("AFC_POSITION_PROFILE_ROOT must identify a fresh owned output directory.");
  const a = await setup(request);
  const profile = await freshPositionProfile(root);
  const started = Date.now();
  const launches: { pid: number; launchedAt: number; closedAt?: number }[] = [];
  let owned: Awaited<ReturnType<typeof launchOwnedPersistentBrowser>> | undefined;
  const pageSessions: CDPSession[] = [];
  const closeOwned = async (failureCleanup = false) => {
    if (!owned) return;
    try {
      await owned.close(failureCleanup);
    } finally {
      const launch = launches.find((item) => item.pid === owned!.pid);
      if (owned.hasExited() && launch) launch.closedAt ??= Date.now();
      // The browser has already exited or its closure failed; never use these sessions for new pages.
      pageSessions.length = 0;
    }
  };
  const openLocalSession = async (page: Page) => {
    // connectOverCDP's existing default context has no baseURL option. Preserve openSession's checks.
    await page.goto(`${WEB_ORIGIN}/session/${a.id}`);
    await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
    await expect(page.getByRole("button", { name: /1세트 완료 처리$/ }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^운동 \d+$/ })).toHaveCount(0);
  };
  const open = async () => {
    owned = await launchOwnedPersistentBrowser(profile, info);
    const { context, pid } = owned;
    try {
      expect(launches.some((item) => item.pid === pid)).toBe(false);
      launches.push({ pid, launchedAt: Date.now() });
      ownPositionContext(context);
      expect(context.pages()).toHaveLength(1);
      const page = context.pages()[0];
      // Preserve persistent05's effective runner-merged options before any application navigation.
      // Keep this owned CDP session alive: detaching would remove its device/locale overrides.
      const pageCdp = await context.newCDPSession(page);
      pageSessions.push(pageCdp);
      await pageCdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await pageCdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await pageCdp.send("Emulation.setLocaleOverride", { locale: "ko-KR" });
      await pageCdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Seoul" });
      const userAgent = await page.evaluate(() => navigator.userAgent);
      await pageCdp.send("Network.setUserAgentOverride", { userAgent, acceptLanguage: "ko-KR" });
      await page.emulateMedia({ colorScheme: "light" });
      // Date offset only. Across launches keep actual elapsed time, never restart the timer's clock.
      await context.clock.install({
        time: new Date(new Date(TEST_NOW).getTime() + Date.now() - started),
      });
      await context.clock.resume();
      const options = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        touch: navigator.maxTouchPoints > 0,
        light: matchMedia("(prefers-color-scheme: light)").matches,
      }));
      await evidence(info, `owned-browser-${pid}-effective-options`, options);
      const { dpr, ...exactOptions } = options;
      expect(exactOptions).toEqual({
        width: 390,
        height: 844,
        language: "ko-KR",
        timezone: "Asia/Seoul",
        touch: true,
        light: true,
      });
      // Preserve the raw DPR above; Chromium may expose a small floating-point representation error.
      expect(Math.abs(dpr - 2)).toBeLessThanOrEqual(5e-7);
      return context;
    } catch (error) {
      await closeOwned(true).catch((cleanupError: unknown) => console.warn(String(cleanupError)));
      throw error;
    }
  };
  let context = await open().catch(async (error: unknown) => {
    await profile.clean().catch((cleanupError: unknown) => console.warn(String(cleanupError)));
    throw error;
  });
  let completed = false;
  const finalCleanupErrors: unknown[] = [];
  try {
    let page = context.pages()[0];
    const diagnostics = await persistentWorkerDiagnostics(page, info);
    let warmed = false;
    try {
      await openLocalSession(page);
      await diagnostics.watchInstalling();
      await warmPersistentSession(page, info);
      warmed = true;
    } finally {
      await diagnostics.finish(!warmed);
    }
    await context.setOffline(true);
    type InitialFocusProbe = { record: (phase: string) => void; close: () => unknown };
    const focusCleanupErrors: unknown[] = [];
    try {
      await page.evaluate(() => {
        const samples: unknown[] = [];
        const record = (phase: string, event?: Event) =>
          samples.push({
            phase,
            at: Date.now(),
            event: event?.type ?? null,
            targetId: event?.target instanceof Element ? event.target.id : null,
            isTrusted: event?.isTrusted ?? null,
            activeId: document.activeElement?.id ?? null,
            hasFocus: document.hasFocus(),
            visibility: document.visibilityState,
            currentId:
              document
                .querySelector('[data-session-current="true"]')
                ?.getAttribute("data-planned-set-id") ?? null,
          });
        const listen = (event: Event) => {
          record("native-event", event);
        };
        const probe: InitialFocusProbe = {
          record,
          close: () => {
            try {
              record("finally");
            } finally {
              document.removeEventListener("focus", listen, true);
              document.removeEventListener("focusin", listen, true);
              delete (window as unknown as { __afcInitialFocusProbe?: InitialFocusProbe })
                .__afcInitialFocusProbe;
            }
            return { listenersRemoved: true, samples };
          },
        };
        (
          window as unknown as { __afcInitialFocusProbe: InitialFocusProbe }
        ).__afcInitialFocusProbe = probe;
        document.addEventListener("focus", listen, true);
        document.addEventListener("focusin", listen, true);
        record("before-foreground");
      });
      await page.bringToFront();
      await expect
        .poll(() =>
          page.evaluate(() => ({
            visibility: document.visibilityState,
            hasFocus: document.hasFocus(),
          })),
        )
        .toEqual({ visibility: "visible", hasFocus: true });
      await page.evaluate(() =>
        (
          window as unknown as { __afcInitialFocusProbe: InitialFocusProbe }
        ).__afcInitialFocusProbe.record("foreground-confirmed"),
      );
      await weight(page, a.target.id).focus();
      await page.evaluate(() =>
        (
          window as unknown as { __afcInitialFocusProbe: InitialFocusProbe }
        ).__afcInitialFocusProbe.record("after-locator-focus"),
      );
      await expect(row(page, a.target.id)).toHaveAttribute("data-session-current", "true");
      await positionAt(page, a.id, a.target);
      await page.evaluate(() =>
        (
          window as unknown as { __afcInitialFocusProbe: InitialFocusProbe }
        ).__afcInitialFocusProbe.record("position-committed"),
      );
    } finally {
      const [cleanup] = await Promise.allSettled([
        page.evaluate(() =>
          (
            window as unknown as { __afcInitialFocusProbe?: InitialFocusProbe }
          ).__afcInitialFocusProbe?.close(),
        ),
      ]);
      if (cleanup.status === "rejected") focusCleanupErrors.push(cleanup.reason);
      const attached = await diagnosticRead("initial-focus-attachment", () =>
        evidence(info, "initial-native-focus", {
          target: a.target.id,
          observation:
            cleanup.status === "fulfilled" ? cleanup.value : { error: String(cleanup.reason) },
        }),
      );
      if (attached.status !== "observed") console.warn(attached);
    }
    if (focusCleanupErrors.length) throw focusCleanupErrors[0];
    await background40(page, a.id, info, "active-row-hidden-40s");
    await expect(row(page, a.target.id)).toHaveAttribute("data-session-current", "true");
    await complete(page, a.target);
    await expect.poll(async () => (await positionObservation(page, a.id)).timer).not.toBeNull();
    const before = await positionAt(page, a.id, a.target);
    expect(draftFor(before, a.target.id)?.client_id).toMatch(/^[0-9a-f-]{36}$/i);
    const observed = await background40(page, a.id, info, "timer-hidden-40s");
    const remaining = Math.max(
      0,
      Math.ceil((Number(before.timer!.ends_at) - observed.observedAt) / 1000),
    );
    const timerText = await page.getByRole("timer").innerText();
    const [minutes, seconds] = timerText.trim().split(":").map(Number);
    expect(Math.abs(minutes * 60 + seconds - remaining)).toBeLessThanOrEqual(1);
    await evidence(info, "timer-absolute-elapsed", { before, observed, timerText });
    // A completed readonly observation saw the actual draft, timer and position writes. They are
    // separate product transactions; this does not claim uncommitted-write crash durability.
    expect(observed.transactionCompleted).toBe(true);
    await profile.recordProcess(launches.at(-1)!.pid, "commit-observed");
    await closeOwned();
    context = await open();
    await context.setOffline(true);
    page = context.pages()[0];
    await page.goto(`${WEB_ORIGIN}/session/${a.id}`);
    await expect(page.getByRole("dialog", { name: /후 휴식/ })).toBeVisible();
    const relaunched = await positionObservation(page, a.id);
    expect(committedParity(relaunched)).toEqual(committedParity(before));
    await closeRest(page);
    await expandCompleted(page, a.target.id);
    const expanded = await positionAt(page, a.id, a.target, true);
    await background40(page, a.id, info, "expanded-row-hidden-40s");
    await expect(row(page, a.target.id)).toHaveAttribute("data-expanded", "true");
    await profile.recordProcess(launches.at(-1)!.pid, "commit-observed");
    await closeOwned();
    context = await open();
    await context.setOffline(true);
    page = context.pages()[0];
    await page.goto(`${WEB_ORIGIN}/session/${a.id}`);
    await restoredRow(page, a.target, true);
    expect(committedParity(await positionObservation(page, a.id))).toEqual(
      committedParity(expanded),
    );
    await evidence(info, "persistent-process-relaunch", {
      before,
      relaunched,
      expanded,
      launches,
      manifestPath: profile.manifestPath,
    });
    // A genuinely fresh context has neither local position nor pending actual/timer; no state import.
    const empty = await chromium.launch({ headless: true });
    try {
      const clean = await empty.newContext({
        baseURL: WEB_ORIGIN,
        viewport: { width: 390, height: 844 },
      });
      ownPositionContext(clean);
      await clean.clock.install({ time: new Date(TEST_NOW) });
      await clean.clock.resume();
      const cleanPage = await clean.newPage();
      await openSession(cleanPage, a.id);
      const cold = await positionObservation(cleanPage, a.id);
      expect(cold.position).toBeNull();
      expect(cold.timer).toBeNull();
      expect(cold.drafts).toEqual([]);
      await expect(row(cleanPage, a.value.planned_sets[0].id)).toBeInViewport({ ratio: 0.8 });
      await evidence(info, "empty-context-not-transplanted", cold);
    } finally {
      await empty.close();
    }
    completed = true;
  } finally {
    if (!completed) {
      const inventoryController = new AbortController();
      const inventory = await diagnosticRead("profile-storage-inventory", () =>
        profile.inventory(inventoryController.signal),
      );
      inventoryController.abort();
      const attached = await diagnosticRead("inventory-attachment", () =>
        evidence(info, "persistent-profile-storage-inventory", inventory),
      );
      if (attached.status !== "observed")
        console.warn("Profile inventory attachment failed", attached);
    }
    const cleanup = await Promise.allSettled([closeOwned(!completed)]);
    if (owned?.hasExited()) cleanup.push(...(await Promise.allSettled([profile.clean()])));
    const attached = await diagnosticRead("owned-process-lifecycle-attachment", async () => {
      await evidence(info, "owned-process-lifecycle", launches);
      await evidence(
        info,
        "owned-process-cleanup",
        cleanup.map((result) =>
          result.status === "rejected"
            ? { status: result.status, error: String(result.reason) }
            : result,
        ),
      );
    });
    if (attached.status !== "observed") console.warn(attached);
    if (!completed)
      for (const result of cleanup)
        if (result.status === "rejected") console.warn(String(result.reason));
    // Preserve an original assertion error through cleanup; successful cases must also clean up.
    for (const result of cleanup)
      if (result.status === "rejected") finalCleanupErrors.push(result.reason);
  }
  if (finalCleanupErrors.length) throw finalCleanupErrors[0];
});

test.describe("narrow ACK/GET transport races (separate from actual SW offline cases)", () => {
  test.use({ serviceWorkers: "block" });

  for (const moveBeforeAck of [false, true]) {
    test(`routine ACK remaps committed position/actual/timer; newer input=${moveBeforeAck}`, async ({
      page,
      context,
      request,
    }, info) => {
      const a = await setup(request);
      await openSession(page, a.id);
      await context.setOffline(true);
      await page.getByRole("button", { name: "운동 추가", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "운동 추가" });
      await picker.getByRole("tab", { name: "팔", exact: true }).click();
      await picker.getByRole("button", { name: /^바벨 컬/ }).click();
      const check = page.getByRole("button", { name: "바벨 컬 1세트 완료 처리", exact: true });
      const correlation = await check.getAttribute("data-set-check");
      expect(correlation).toMatch(/^[0-9a-f-]{36}$/i);
      const provisional: Planned = {
        id: correlation!,
        exercise_id: "e_barbell_curl",
        set_no: 1,
        load_kind: "external",
      };
      await complete(page, provisional);
      const pending = await positionAt(page, a.id, provisional);
      expect(pending.timer?.planned_set_id).toBe(correlation);
      const originalDraft = draftFor(pending, correlation!)!;
      expect(originalDraft.client_id).toMatch(/^[0-9a-f-]{36}$/i);

      let release!: () => void;
      let captured!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const received = new Promise<void>((resolve) => {
        captured = resolve;
      });
      let mappings: {
        correlation_id: string;
        planned_set_id: string;
        planned_set: { id: string; exercise_id: string; set_no: number };
      }[] = [];
      let outgoingText: string | null = null;
      let responseText: string | null = null;
      let responseStatus: number | null = null;
      let responseBody: {
        applied: string[];
        planned_set_mappings: typeof mappings;
        changes: { entity: string; entity_id: string; op: string; data: Record<string, unknown> }[];
      } | null = null;
      let releaseBefore: number | null = null;
      let observationAfter: number | null = null;
      let after: Awaited<ReturnType<typeof positionObservation>> | null = null;
      let authoritative: unknown = null;
      let first = true;
      await page.route("**/v1/sync", async (route) => {
        if (!first) {
          await route.continue();
          return;
        }
        first = false;
        outgoingText = route.request().postData();
        const response = await route.fetch(); // real backend commits before its ACK is released
        responseStatus = response.status();
        responseText = await response.text();
        responseBody = JSON.parse(responseText) as NonNullable<typeof responseBody>;
        mappings = responseBody.planned_set_mappings;
        captured();
        await hold;
        await route.fulfill({ response });
      });
      try {
        await context.setOffline(false);
        await received;
        expect(responseStatus).toBe(200);
        const outgoing = JSON.parse(outgoingText!) as {
          mutations: Record<string, unknown>[];
        };
        const originalMutation = pending.outbox.find(
          (mutation) => mutation.client_id === originalDraft.client_id,
        )!;
        expect(originalMutation.payload).toEqual({
          actual_weight: originalDraft.actual_weight,
          actual_reps: originalDraft.actual_reps,
          actual_rir: originalDraft.actual_rir,
          actual_time_sec: originalDraft.actual_time_sec,
          pain_score: originalDraft.pain_score,
          completed: originalDraft.completed,
        });
        expect(
          outgoing.mutations.filter((mutation) => mutation.client_id === originalDraft.client_id),
        ).toEqual([
          {
            client_id: originalDraft.client_id,
            entity: "performed_set",
            entity_id: correlation,
            op: "upsert",
            updated_at: originalDraft.updated_at,
            payload: originalMutation.payload,
          },
        ]);
        const matchingMappings = mappings.filter(
          (mapping) => mapping.correlation_id === correlation,
        );
        expect(matchingMappings).toHaveLength(1);
        const canonical = matchingMappings[0].planned_set_id;
        expect(canonical).toMatch(/^[0-9a-f-]{36}$/i);
        expect(canonical).not.toBe(correlation);
        expect(matchingMappings[0].planned_set).toMatchObject({
          id: canonical,
          exercise_id: provisional.exercise_id,
          set_no: provisional.set_no,
        });
        const actualResponse = responseBody!;
        expect(actualResponse.applied.filter((id) => id === originalDraft.client_id)).toEqual([
          originalDraft.client_id,
        ]);
        const performedChanges = actualResponse.changes.filter(
          (change) => change.entity === "performed_set" && change.entity_id === canonical,
        );
        expect(performedChanges).toHaveLength(1);
        expect(performedChanges[0]).toMatchObject({
          entity: "performed_set",
          entity_id: canonical,
          op: "upsert",
          data: originalMutation.payload,
        });
        // This real response includes a pull, whose local apply time differs from ACK-only remap.
        expect(performedChanges[0].data).not.toHaveProperty("updated_at");
        if (moveBeforeAck) {
          await closeRest(page);
          await weight(page, a.target.id).fill("123.");
          await weight(page, a.target.id).focus();
          await positionAt(page, a.id, a.target);
        }
        releaseBefore = await page.evaluate(() => Date.now());
        release();
        await expect
          .poll(async () =>
            (await positionObservation(page, a.id)).drafts.some(
              (draft) => draft.planned_set_id === canonical,
            ),
          )
          .toBe(true);
        after = await positionObservation(page, a.id);
        observationAfter = await page.evaluate(() => Date.now());
        const afterDraft = draftFor(after, canonical!)!;
        const appliedAt = Date.parse(String(afterDraft.updated_at));
        expect(Number.isFinite(appliedAt)).toBe(true);
        expect(appliedAt).toBeGreaterThan(Date.parse(String(originalDraft.updated_at)));
        expect(appliedAt).toBeGreaterThanOrEqual(releaseBefore);
        expect(appliedAt).toBeLessThanOrEqual(observationAfter);
        expect(draftFor(after, canonical!)).toMatchObject({
          ...originalDraft,
          planned_set_id: canonical,
          // Checked above against actual browser time; every original non-time field stays exact.
          updated_at: afterDraft.updated_at,
        });
        const serverResponse = await request.get(`${API_V1}/sessions/${a.id}`);
        expect(serverResponse.status()).toBe(200);
        authoritative = await serverResponse.json();
        const serverSets = (
          authoritative as {
            planned_sets: { id: string; performed_set: Record<string, unknown> | null }[];
          }
        ).planned_sets.filter((set) => set.id === canonical);
        expect(serverSets).toHaveLength(1);
        expect(serverSets[0].performed_set).toMatchObject({
          actual_weight: originalDraft.actual_weight,
          actual_reps: originalDraft.actual_reps,
          actual_rir: originalDraft.actual_rir,
          actual_time_sec: originalDraft.actual_time_sec,
          completed: originalDraft.completed,
          performed_at: originalDraft.updated_at,
        });
        expect(draftFor(after, correlation!)).toBeUndefined();
        if (moveBeforeAck) {
          await expect(weight(page, a.target.id)).toHaveValue("123.");
          await expect(weight(page, a.target.id)).toBeFocused();
          expect(after.position?.planned_set_id).toBe(a.target.id);
          expect(after.timer).toBeNull();
        } else {
          expect(after.position?.planned_set_id).toBe(canonical);
          expect(after.timer).toMatchObject({
            planned_set_id: canonical,
            ends_at: pending.timer!.ends_at,
            total_sec: pending.timer!.total_sec,
          });
          await expect(row(page, canonical!)).toHaveAttribute("data-session-current", "true");
        }
      } finally {
        release();
        const attached = await diagnosticRead("actual-ACK-remap-attachment", () =>
          evidence(info, "actual-ACK-remap", {
            pending,
            originalDraft,
            outgoingText,
            responseStatus,
            responseText,
            responseBody,
            mappings,
            releaseBefore,
            observationAfter,
            after,
            authoritative,
            moveBeforeAck,
          }),
        );
        if (attached.status !== "observed") console.warn(attached);
      }
    });
  }

  test("late authoritative GET cannot reset a more recent explicit input/focus", async ({
    page,
    request,
  }, info) => {
    const a = await setup(request);
    await page.goto("/");
    const originalDocument = await page.evaluateHandle(() => document);
    const sessionLink = page.locator(`a[href="/session/${a.id}"]`);
    await expect(sessionLink).toHaveCount(1);
    await sessionLink.click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/session/${a.id}`);
    const first = a.value.planned_sets.find((set) => set.load_kind === "external")!;
    await weight(page, first.id).focus();
    const initial = await positionAt(page, a.id, first);
    const initialRow = await row(page, first.id).elementHandle();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exactUrl = `${API_V1}/sessions/${a.id}`;
    const routePattern = `**/v1/sessions/${a.id}`;
    const pending = new Set<Promise<void>>();
    const handlerErrors: unknown[] = [];
    const cleanupErrors: unknown[] = [];
    const transports: {
      phase: "forward-session-mount";
      requestIdentity: string;
      distinctFromDashboard: boolean;
      startedAt: number;
      interceptedAt: number;
      method: string;
      url: string;
      requestBody: string | null;
      capturedAt?: number;
      responseStatus?: number;
      responseBase64?: string;
      fulfilledAt?: number;
    }[] = [];
    const observations: unknown[] = [];
    let dashboardRequest: ReturnType<Route["request"]> | null = null;
    let dashboardBaseline: {
      phase: "back-dashboard";
      requestIdentity: string;
      startedAt: number;
      method: string;
      url: string;
      responseStatus: number;
      responseBase64: string;
      finishedError: string | null;
      bodyCompletedAt: number;
    } | null = null;
    let routeInstalled = false;
    let delivered = 0;
    let failed = false;
    let selected: Awaited<ReturnType<typeof positionObservation>> | null = null;
    let after: Awaited<ReturnType<typeof positionObservation>> | null = null;
    let deliveredBase64: string | null = null;
    const observe = async (stage: string) => {
      observations.push({
        stage,
        atHost: Date.now(),
        state: await page.evaluate(
          (priorDocument) => ({
            sameDocument: document === priorDocument,
            url: location.href,
            focusedId: document.activeElement?.id ?? null,
            focusedInputValue:
              document.activeElement instanceof HTMLInputElement
                ? document.activeElement.value
                : null,
            hasFocus: document.hasFocus(),
            visibility: document.visibilityState,
            currentId:
              document
                .querySelector('[data-session-current="true"]')
                ?.getAttribute("data-planned-set-id") ?? null,
            rows: document.querySelectorAll("[data-planned-set-id]").length,
          }),
          originalDocument,
        ),
      });
    };
    const onResponse = (response: Response) => {
      if (response.url() === exactUrl) delivered += 1;
    };
    const handler = (route: Route) => {
      const task = (async () => {
        const transport: (typeof transports)[number] = {
          phase: "forward-session-mount",
          requestIdentity: `forward-session-${transports.length + 1}`,
          distinctFromDashboard: route.request() !== dashboardRequest,
          startedAt: route.request().timing().startTime,
          interceptedAt: Date.now(),
          method: route.request().method(),
          url: route.request().url(),
          requestBody: route.request().postData(),
        };
        transports.push(transport);
        expect(transport.method).toBe("GET");
        expect(transport.url).toBe(exactUrl);
        expect(transport.distinctFromDashboard).toBe(true);
        const response = await route.fetch({ timeout: 10_000 });
        transport.responseStatus = response.status();
        transport.responseBase64 = (await response.body()).toString("base64");
        expect(response.status()).toBe(200);
        transport.capturedAt = Date.now();
        await hold;
        await route.fulfill({ response });
        transport.fulfilledAt = Date.now();
      })();
      pending.add(task);
      // Surface errors through the assertion/final cleanup, without an unhandled route rejection.
      return task.then(
        () => {
          pending.delete(task);
        },
        (error: unknown) => {
          handlerErrors.push(error);
          pending.delete(task);
        },
      );
    };
    try {
      await observe("initial-session");
      expect(
        await page.evaluate((priorDocument) => document === priorDocument, originalDocument),
      ).toBe(true);
      // networkMode:always disables reconnect refetch. Use the real stale-query mount instead.
      // Dashboard has its own session query at this URL. Let that read finish before arming the hold.
      const dashboardRead = Promise.allSettled([
        page.waitForResponse(
          (response) => response.url() === exactUrl && response.request().method() === "GET",
          { timeout: 10_000 },
        ),
      ]);
      await page.goBack();
      await expect(page).toHaveURL(`${WEB_ORIGIN}/`);
      await expect(sessionLink).toHaveCount(1);
      expect(await initialRow!.evaluate((element) => element.isConnected)).toBe(false);
      await observe("dashboard-after-back");
      expect(
        await page.evaluate((priorDocument) => document === priorDocument, originalDocument),
      ).toBe(true);
      const [baselineResult] = await dashboardRead;
      if (baselineResult.status === "rejected") throw baselineResult.reason;
      const baselineResponse = baselineResult.value;
      dashboardRequest = baselineResponse.request();
      const finishedError = await baselineResponse.finished();
      const baselineBody = await baselineResponse.body();
      dashboardBaseline = {
        phase: "back-dashboard",
        requestIdentity: "back-dashboard-1",
        startedAt: dashboardRequest.timing().startTime,
        method: dashboardRequest.method(),
        url: dashboardRequest.url(),
        responseStatus: baselineResponse.status(),
        responseBase64: baselineBody.toString("base64"),
        finishedError: finishedError === null ? null : String(finishedError),
        bodyCompletedAt: Date.now(),
      };
      expect(dashboardBaseline.responseStatus).toBe(200);
      expect(finishedError).toBeNull();
      expect(JSON.parse(baselineBody.toString()).id).toBe(a.id);
      await observe("dashboard-session-read-completed");
      page.on("response", onResponse);
      await page.route(routePattern, handler);
      routeInstalled = true;
      await page.goForward();
      await expect(page).toHaveURL(`${WEB_ORIGIN}/session/${a.id}`);
      await expect
        .poll(() => {
          if (handlerErrors.length) throw handlerErrors[0];
          return transports.filter((transport) => transport.capturedAt !== undefined).length;
        })
        .toBe(1);
      expect(transports).toHaveLength(1);
      expect(delivered).toBe(0);
      expect(transports[0].fulfilledAt).toBeUndefined();
      await expect(page.locator("[data-planned-set-id]")).toHaveCount(a.value.planned_sets.length);
      await expect(weight(page, a.target.id)).toBeVisible();
      expect(
        await page.evaluate((priorDocument) => document === priorDocument, originalDocument),
      ).toBe(true);
      await observe("remounted-cached-rows-with-real-200-held");
      await weight(page, a.target.id).fill("61.");
      await weight(page, a.target.id).focus();
      selected = await positionAt(page, a.id, a.target);
      await expect(row(page, a.target.id)).toHaveAttribute("data-session-current", "true");
      await observe("newer-input-before-release");
      expect(delivered).toBe(0);
      const response = page.waitForResponse(
        (value) => value.url() === exactUrl && value.status() === 200,
        { timeout: 10_000 },
      );
      release();
      deliveredBase64 = (await (await response).body()).toString("base64");
      expect(deliveredBase64).toBe(transports[0].responseBase64);
      expect(transports).toHaveLength(1);
      expect(delivered).toBe(1);
      await expect(weight(page, a.target.id)).toHaveValue("61.");
      await expect(weight(page, a.target.id)).toBeFocused();
      after = await positionObservation(page, a.id);
      expect(after.position).toEqual(selected.position);
      await observe("after-original-response");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      release();
      while (pending.size > 0) await Promise.allSettled([...pending]);
      cleanupErrors.push(...handlerErrors);
      const cleanup = await Promise.allSettled(
        routeInstalled ? [page.unroute(routePattern, handler)] : [],
      );
      for (const result of cleanup)
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      page.off("response", onResponse);
      const finalObservation = await diagnosticRead("late-GET-final-observation", () =>
        observe("finally"),
      );
      const handles = await Promise.allSettled([originalDocument.dispose(), initialRow?.dispose()]);
      for (const result of handles)
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      const attached = await diagnosticRead("late-GET-new-input-attachment", () =>
        evidence(info, "late-GET-new-input", {
          initial,
          selected,
          after,
          dashboardBaseline,
          routeInstalled,
          transports,
          delivered,
          deliveredBase64,
          observations,
          failed,
          pendingHandlers: pending.size,
          finalObservation,
          cleanupErrors: cleanupErrors.map(String),
        }),
      );
      if (attached.status !== "observed") console.warn(attached);
    }
    if (cleanupErrors.length) throw cleanupErrors[0];
  });
});
