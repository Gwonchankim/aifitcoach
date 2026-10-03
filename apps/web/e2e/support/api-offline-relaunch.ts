import type { BrowserContext, Page } from "@playwright/test";
import { API_V1 } from "../helpers";

/** Read the existing synthetic session without creating/upgrading or writing any IDB store. */
export async function readRelaunchState(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const controller = navigator.serviceWorker.controller;
    const open = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onupgradeneeded = () => {
        open.transaction?.abort();
        reject(new Error("Expected an existing session database"));
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const stores = ["sessions", "routines", "outbox", "drafts"];
      const transaction = db.transaction(stores, "readonly");
      const [sessions, routines, outbox, drafts] = await Promise.all(
        stores.map(
          (store) =>
            new Promise<Record<string, unknown>[]>((resolve, reject) => {
              const read = transaction.objectStore(store).getAll();
              read.onsuccess = () => resolve(read.result as Record<string, unknown>[]);
              read.onerror = () => reject(read.error);
            }),
        ),
      );
      const belongsToSession = (row: Record<string, unknown>) =>
        row.user_id === "dev-user" && row.session_id === id;
      const sessionDrafts = drafts.filter(belongsToSession);
      return {
        sessionId: id,
        sessions: sessions.filter(belongsToSession),
        routines: routines.filter(belongsToSession),
        // Keep orphan mutations visible even if the matching draft or routine is what was lost.
        outbox: outbox.filter((row) => row.user_id === "dev-user"),
        drafts: sessionDrafts,
        serviceWorker: {
          controller: controller
            ? { scriptURL: controller.scriptURL, state: controller.state }
            : null,
          registrations: registrations.map((registration) => ({
            scope: registration.scope,
            active: registration.active?.scriptURL ?? null,
            waiting: registration.waiting?.scriptURL ?? null,
            installing: registration.installing?.scriptURL ?? null,
          })),
        },
      };
    } finally {
      db.close();
    }
  }, sessionId);
}

export async function openApiOfflinePage(context: BrowserContext) {
  const blockedApi: Array<{ method: string; url: string }> = [];
  const successfulApi: Array<{ method: string; url: string; status: number }> = [];
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    await route.abort("failed");
    blockedApi.push({ method: request.method(), url: request.url() });
  });
  await context.setOffline(false);
  const resumed = await context.newPage();
  // unregister does not prevent this new document from registering again and escaping routing.
  // Only this page's isolated relaunch phase suppresses registration. The reconnect reload below
  // uses the native method again; application SW code and the original page stay unchanged.
  await resumed.addInitScript(() => {
    if (sessionStorage.getItem("e2e-loss0-sw-reconnect") === "1") return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Offline relaunch transport", "NetworkError")),
    });
  });
  resumed.on("response", (response) => {
    if (response.url().startsWith(`${API_V1}/`) && response.status() === 200)
      successfulApi.push({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      });
  });
  return { resumed, blockedApi, successfulApi };
}
