import { createHash } from "node:crypto";
import type { BrowserContext, Request, Response, Route } from "@playwright/test";
import type { Session, SyncRequest, SyncResponse } from "../../lib/api";
import { expect } from "../fixtures";
import { API_V1 } from "../helpers";
import { appendObservation, originalTransport } from "./session-set-append-observation";

export type LocalAppend = Awaited<ReturnType<typeof appendObservation>>;
export function committedParity(state: LocalAppend) {
  return {
    mirror: state.mirror,
    routines: state.routines,
    append: state.append,
    drafts: state.drafts,
    position: state.position,
    timer: state.timer,
    outbox: state.outbox
      .map(originalTransport)
      .sort((a, b) => a.client_id.localeCompare(b.client_id)),
  };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Wire = {
  kind: "get" | "fresh-get" | "sync";
  requestId: number;
  requestedAt: number;
  requestText: string | null;
  fetched?: { status: number; text: string; base64: string; sha256: string; at: number };
  deliveryCount: number;
  deliveredAt?: number;
  abortedAt?: number;
  requestFailure?: string | null;
  requestFailedAt?: number;
  cancellationVerified?: boolean;
  settledAt?: number;
  browser: { status: number; at: number; base64?: string; sha256?: string; error?: string }[];
  error?: string;
};

/** Narrow SW-blocked transport fault only. Every delivered body is its own route.fetch bytes. */
export async function assistanceTransport(context: BrowserContext, sessionId: string) {
  const pattern = "**/v1/**";
  const records: Wire[] = [];
  const blocked: { url: string; method: string; failed?: string | null }[] = [];
  const blockedResponses: { url: string; status: number }[] = [];
  const blockedRequests = new Map<Request, (typeof blocked)[number]>();
  const owned = new Map<Request, Wire>();
  const pending = new Set<Promise<void>>();
  const receiving = new Set<Promise<void>>();
  const getReady = latch();
  const firstLost = latch();
  const getDelivery = latch();
  const ackDelivery = latch();
  const freshDelivery = latch();
  let phase: "blocked" | "ordered" | "closed" = "blocked";
  let order: "get-first" | "ack-first" = "get-first";
  let ids = new Set<string>();
  let getClaimed = false;
  let freshGetClaimed = false;
  let syncAttempts = 0;

  const onFailed = (request: Request) => {
    const entry = owned.get(request);
    if (entry) {
      entry.requestFailure = request.failure()?.errorText ?? null;
      entry.requestFailedAt = Date.now();
    }
    const blockedEntry = blockedRequests.get(request);
    if (blockedEntry) blockedEntry.failed = request.failure()?.errorText ?? null;
  };
  const onResponse = (response: Response) => {
    if (blockedRequests.has(response.request()))
      blockedResponses.push({ url: response.url(), status: response.status() });
    const entry = owned.get(response.request());
    if (!entry) return;
    const received: Wire["browser"][number] = { status: response.status(), at: Date.now() };
    entry.browser.push(received);
    const work = (async () => {
      try {
        const bytes = await response.body();
        received.base64 = bytes.toString("base64");
        received.sha256 = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        received.error = String(error);
      }
    })();
    receiving.add(work);
    void work.then(() => receiving.delete(work));
  };
  const handler = (route: Route) => {
    const request = route.request();
    if (phase === "blocked") {
      const entry = { url: request.url(), method: request.method() };
      blocked.push(entry);
      blockedRequests.set(request, entry);
      return route.abort();
    }
    if (phase === "closed") return route.continue();
    const isGet =
      request.method() === "GET" &&
      request.url() === `${API_V1}/sessions/${sessionId}` &&
      !getClaimed;
    const isFreshGet =
      order === "ack-first" &&
      getClaimed &&
      !freshGetClaimed &&
      request.method() === "GET" &&
      request.url() === `${API_V1}/sessions/${sessionId}`;
    const text = request.postData();
    const outgoing =
      request.method() === "POST" && request.url() === `${API_V1}/sync`
        ? (JSON.parse(text ?? "{}") as SyncRequest)
        : null;
    const isSync = outgoing?.mutations.some((mutation) => ids.has(mutation.client_id)) === true;
    if (!isGet && !isFreshGet && !isSync) return route.continue();
    if (isGet) getClaimed = true;
    if (isFreshGet) freshGetClaimed = true;
    const attempt = isSync ? ++syncAttempts : 0;
    const entry: Wire = {
      kind: isGet ? "get" : isFreshGet ? "fresh-get" : "sync",
      requestId: records.length + 1,
      requestedAt: Date.now(),
      requestText: text,
      deliveryCount: 0,
      browser: [],
    };
    records.push(entry);
    owned.set(request, entry);
    const work = (async () => {
      try {
        // Capture a genuinely old GET before the first server write, or a current GET after it.
        if (isGet && order === "get-first") await firstLost.promise;
        if (isSync && attempt === 1 && order === "ack-first") await getReady.promise;
        const response = await route.fetch({ timeout: 10_000 });
        const bytes = await response.body();
        entry.fetched = {
          status: response.status(),
          text: bytes.toString("utf8"),
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          at: Date.now(),
        };
        if (isGet) getReady.release();
        if (isSync && attempt === 1) {
          await route.abort("failed");
          entry.abortedAt = Date.now();
          firstLost.release();
          return;
        }
        await (isGet
          ? getDelivery.promise
          : isFreshGet
            ? freshDelivery.promise
            : ackDelivery.promise);
        if (isGet && entry.requestFailure !== undefined) {
          // The app has already canceled this exact request. No test abort or fulfill is issued.
          if (!entry.cancellationVerified)
            entry.error = "Held GET failed without verified post-ACK cancellation";
          entry.settledAt = Date.now();
          return;
        }
        entry.deliveryCount += 1;
        await route.fulfill({ response, body: bytes });
        entry.deliveredAt = Date.now();
      } catch (error) {
        entry.error = String(error);
        getReady.release();
        firstLost.release();
        if (isSync)
          await route.abort().catch((abortError: unknown) => {
            entry.error += `; ${String(abortError)}`;
          });
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work));
    return work;
  };
  context.on("requestfailed", onFailed);
  context.on("response", onResponse);
  await context.route(pattern, handler);
  return {
    records,
    blocked,
    blockedResponses,
    begin(nextOrder: typeof order, clientIds: string[]) {
      order = nextOrder;
      ids = new Set(clientIds);
      phase = "ordered";
    },
    releaseGet: getDelivery.release,
    releaseAck: ackDelivery.release,
    releaseFresh: freshDelivery.release,
    async canceled(entry: Wire, ack: Wire, expectedError: string) {
      expect(entry.kind).toBe("get");
      await expect.poll(() => entry.requestFailure).toBe(expectedError);
      expect(entry.requestFailedAt).toBeGreaterThanOrEqual(ack.browser[0].at);
      expect(entry.fetched?.status).toBe(200);
      expect(entry.browser).toEqual([]);
      expect(entry.deliveryCount).toBe(0);
      expect(entry.abortedAt).toBeUndefined();
      expect(entry.error).toBeUndefined();
      entry.cancellationVerified = true;
      getDelivery.release();
      await expect.poll(() => entry.settledAt).toBeDefined();
    },
    async lost() {
      await expect
        .poll(() => records.find((entry) => entry.kind === "sync")?.requestFailure)
        .toBeTruthy();
      const entry = records.find((item) => item.kind === "sync")!;
      expect(entry.fetched?.status).toBe(200);
      expect(entry.abortedAt).toBeDefined();
      expect(entry.browser).toEqual([]);
      expect(entry.deliveryCount).toBe(0);
      expect(entry.error).toBeUndefined();
      return entry;
    },
    async fetched(kind: Wire["kind"], ordinal = 0) {
      await expect
        .poll(() => records.filter((entry) => entry.kind === kind)[ordinal]?.fetched?.status)
        .toBe(200);
      const entry = records.filter((item) => item.kind === kind)[ordinal];
      expect(entry.error).toBeUndefined();
      expect(entry.deliveryCount).toBe(0);
      return entry;
    },
    async received(entry: Wire) {
      await expect
        .poll(() => entry.browser.filter((item) => item.base64 !== undefined).length)
        .toBe(1);
      expect(entry.deliveryCount).toBe(1);
      expect(entry.browser).toHaveLength(1);
      expect(entry.browser[0]).toMatchObject({
        status: entry.fetched!.status,
        base64: entry.fetched!.base64,
        sha256: entry.fetched!.sha256,
      });
      expect(entry.browser[0].error).toBeUndefined();
    },
    session(entry: Wire) {
      return JSON.parse(entry.fetched!.text) as Session;
    },
    sync(entry: Wire) {
      return JSON.parse(entry.fetched!.text) as SyncResponse;
    },
    outgoing(entry: Wire) {
      return JSON.parse(entry.requestText!) as SyncRequest;
    },
    async close() {
      phase = "closed";
      getReady.release();
      firstLost.release();
      getDelivery.release();
      ackDelivery.release();
      freshDelivery.release();
      const errors: unknown[] = [];
      while (pending.size) await Promise.allSettled([...pending]);
      await context.unroute(pattern, handler).catch((error: unknown) => errors.push(error));
      while (receiving.size) await Promise.allSettled([...receiving]);
      context.off("requestfailed", onFailed);
      context.off("response", onResponse);
      for (const entry of records) {
        if (entry.error) errors.push(entry.error);
        for (const response of entry.browser) if (response.error) errors.push(response.error);
      }
      if (errors.length) throw new Error(errors.map(String).join("; "));
    },
  };
}
