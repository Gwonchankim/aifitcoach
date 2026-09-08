/** First real ticket04 integration candidate. No synthetic ACK, IDB write, or clock jump. */
import { createHash, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  Request,
  Response,
  Route,
  TestInfo,
} from "@playwright/test";
import type { PlannedSet, Session, SyncRequest, SyncResponse } from "../lib/api";
import { expect, test } from "./fixtures";
import { API_V1, WEB_ORIGIN, openSession, seedExternalLoadProgram, todaySession } from "./helpers";
import { assertPositionRun } from "./support/session-position-observation";
import {
  appendObservation,
  ownAppendContext,
  originalTransport,
} from "./support/session-set-append-observation";

const publicFields = [
  "target_reps_low",
  "target_reps_high",
  "target_time_low_sec",
  "target_time_high_sec",
  "target_rir",
  "rest_sec",
  "recommended_weight",
  "recommended_reps",
  "reason_code",
  "confidence",
  "rules_version",
  "load_kind",
  "recommendation_state",
  "assistance_provenance",
  "recommended_action",
  "assistance_safety_status",
  "recommendation_gate",
] as const;
const projected = (row: PlannedSet) =>
  Object.fromEntries(publicFields.map((key) => [key, row[key]]));
const row = (page: Page, id: string) => page.locator(`[data-planned-set-id="${id}"]`);
const input = (page: Page, id: string, axis: string) => page.locator(`[id="set-${id}-${axis}"]`);
const check = (page: Page, id: string) => page.locator(`[data-set-check="${id}"]`);
const appendButton = (page: Page, source: PlannedSet) =>
  row(page, source.id)
    .locator("xpath=../..")
    .getByRole("button", { name: / 세트 추가$/ });

type Evidence = Record<string, unknown>;
async function readSession(
  request: APIRequestContext,
  id: string,
  evidence: Evidence,
  label: string,
) {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  const text = await response.text();
  evidence[label] = { status: response.status(), body: text };
  expect(response.status()).toBe(200);
  return JSON.parse(text) as Session;
}

async function setup(request: APIRequestContext, evidence: Evidence) {
  await seedExternalLoadProgram(request);
  const id = await todaySession(request);
  const session = await readSession(request, id, evidence, "initialGET");
  const sources = session.planned_sets.filter(
    (candidate) =>
      candidate.load_kind === "external" &&
      candidate.append_eligibility?.status === "allowed" &&
      candidate.set_no < 8 &&
      !candidate.performed_set &&
      !session.planned_sets.some(
        (row) => row.exercise_id === candidate.exercise_id && row.set_no > candidate.set_no,
      ),
  );
  expect(
    sources.length,
    "real allowed external maximum rows for append and unrelated removal",
  ).toBeGreaterThanOrEqual(2);
  return { id, session, source: sources[0], removable: sources[1] };
}

/** Fetch real response bytes, then hold their delivery. Every matching response uses the same barrier. */
async function holdSync(context: BrowserContext, matches: (request: SyncRequest) => boolean) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const records: {
    requestText: string;
    request: SyncRequest;
    status?: number;
    responseText?: string;
    responseBase64?: string;
    responseSha256?: string;
    response?: SyncResponse;
    fetchedAt?: number;
    deliveredAt?: number;
    deliveryCount: number;
    browser: {
      status: number;
      base64?: string;
      sha256?: string;
      receivedAt: number;
      error?: string;
    }[];
    error?: string;
  }[] = [];
  const pending = new Set<Promise<void>>();
  const receiving = new Set<Promise<void>>();
  const owned = new Map<Request, (typeof records)[number]>();
  const onResponse = (response: Response) => {
    const record = owned.get(response.request());
    if (!record) return;
    const received: (typeof record.browser)[number] = {
      status: response.status(),
      receivedAt: Date.now(),
    };
    record.browser.push(received);
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
  context.on("response", onResponse);
  const handler = (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const requestText = route.request().postData() ?? "";
    const outgoing = JSON.parse(requestText) as SyncRequest;
    if (!matches(outgoing)) return route.continue();
    const record: (typeof records)[number] = {
      requestText,
      request: outgoing,
      deliveryCount: 0,
      browser: [],
    };
    records.push(record);
    owned.set(route.request(), record);
    const work = (async () => {
      try {
        const response = await route.fetch({ timeout: 10_000 });
        const bytes = await response.body();
        record.status = response.status();
        record.responseText = bytes.toString("utf8");
        record.responseBase64 = bytes.toString("base64");
        record.responseSha256 = createHash("sha256").update(bytes).digest("hex");
        record.response = JSON.parse(record.responseText) as SyncResponse;
        record.fetchedAt = Date.now();
        await barrier;
        record.deliveryCount += 1;
        await route.fulfill({ response, body: bytes });
        record.deliveredAt = Date.now();
      } catch (error) {
        record.error = String(error);
        await route.abort().catch((abortError: unknown) => {
          record.error += `; abort: ${String(abortError)}`;
        });
      }
    })();
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  try {
    await context.route("**/v1/sync", handler);
  } catch (error) {
    context.off("response", onResponse);
    throw error;
  }
  return {
    records,
    release,
    async fetched() {
      await expect
        .poll(() => records.filter((record) => record.fetchedAt !== undefined).length)
        .toBeGreaterThan(0);
      const record = records.find((item) => item.fetchedAt !== undefined)!;
      expect(record.status).toBe(200);
      expect(record.deliveredAt).toBeUndefined();
      expect(record.error).toBeUndefined();
      return record;
    },
    async received(record: (typeof records)[number]) {
      await expect
        .poll(() => record.browser.filter((item) => item.base64 !== undefined).length)
        .toBe(1);
      expect(record.deliveryCount).toBe(1);
      expect(record.browser).toHaveLength(1);
      expect(record.browser[0].status).toBe(record.status);
      expect(record.browser[0].error).toBeUndefined();
      expect(record.browser[0].base64).toBe(record.responseBase64);
      expect(record.browser[0].sha256).toBe(record.responseSha256);
    },
    async close() {
      const errors: unknown[] = [];
      release();
      while (pending.size) await Promise.allSettled([...pending]);
      await context.unroute("**/v1/sync", handler).catch((error: unknown) => errors.push(error));
      while (receiving.size) await Promise.allSettled([...receiving]);
      context.off("response", onResponse);
      for (const record of records) {
        if (record.error) errors.push(record.error);
        for (const received of record.browser) if (received.error) errors.push(received.error);
      }
      if (errors.length) throw new Error(errors.map(String).join("; "));
    },
  };
}

async function observe(page: Page, id: string, evidence: Evidence, label: string) {
  const state = await appendObservation(page, id);
  expect(state.transactionCompleted).toBe(true);
  evidence[label] = state;
  return state;
}
/** Passive pre-removal responses provide sequence evidence without interpreting opaque cursors. */
function observePriorSync(context: BrowserContext) {
  const records: {
    requestText: string;
    status: number;
    receivedAt: number;
    responseText?: string;
    responseBase64?: string;
    responseSha256?: string;
    response?: SyncResponse;
    error?: string;
  }[] = [];
  const pending = new Set<Promise<void>>();
  const listener = (response: Response) => {
    if (response.url() !== `${API_V1}/sync` || response.request().method() !== "POST") return;
    const record: (typeof records)[number] = {
      requestText: response.request().postData() ?? "",
      status: response.status(),
      receivedAt: Date.now(),
    };
    records.push(record);
    const work = (async () => {
      try {
        const bytes = await response.body();
        record.responseText = bytes.toString("utf8");
        record.responseBase64 = bytes.toString("base64");
        record.responseSha256 = createHash("sha256").update(bytes).digest("hex");
        if (record.status === 200)
          record.response = JSON.parse(record.responseText) as SyncResponse;
      } catch (error) {
        record.error = String(error);
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work));
  };
  context.on("response", listener);
  return {
    records,
    async close() {
      context.off("response", listener);
      while (pending.size) await Promise.allSettled([...pending]);
      const errors = records.flatMap((record) => (record.error ? [record.error] : []));
      if (errors.length) throw new Error(errors.join("; "));
    },
  };
}
async function finalEvidence(
  page: Page,
  id: string | undefined,
  info: TestInfo,
  evidence: Evidence,
) {
  evidence.transportBoundary = {
    serviceWorkers: "block",
    existingDocumentOffline: true,
    serviceWorkerOfflineReloadClaim: false,
  };
  if (id) {
    try {
      evidence.finalLocal = await appendObservation(page, id);
    } catch (error) {
      evidence.finalLocalError = String(error);
    }
  }
  await info.attach("append-integration.json", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  });
  if (evidence.finalLocalError) throw new Error(String(evidence.finalLocalError));
}
async function finishEvidence(
  context: BrowserContext,
  page: Page,
  id: string | undefined,
  info: TestInfo,
  evidence: Evidence,
  held: Awaited<ReturnType<typeof holdSync>> | undefined,
  originalError: string | null,
  priorSync?: ReturnType<typeof observePriorSync>,
) {
  const cleanupErrors: string[] = [];
  evidence.originalError = originalError;
  evidence.cleanupErrors = cleanupErrors;
  if (held) await held.close().catch((error: unknown) => cleanupErrors.push(String(error)));
  if (priorSync)
    await priorSync.close().catch((error: unknown) => cleanupErrors.push(String(error)));
  await context.setOffline(false).catch((error: unknown) => cleanupErrors.push(String(error)));
  await finalEvidence(page, id, info, evidence).catch((error: unknown) => {
    cleanupErrors.push(`final evidence: ${String(error)}`);
    // Preserve the original failure even when the attachment sink itself fails.
    console.warn(JSON.stringify(evidence));
  });
  if (originalError === null && cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
}
async function appended(page: Page, id: string, count: number) {
  await expect
    .poll(async () => (await appendObservation(page, id)).append?.entries.length ?? 0)
    .toBe(count);
  return (await appendObservation(page, id)).append!.entries[count - 1];
}
async function loggedActual(page: Page, id: string, plannedId: string) {
  await input(page, plannedId, "weight").fill("47.5");
  await input(page, plannedId, "reps").fill("9");
  await input(page, plannedId, "rir").fill("2");
  await check(page, plannedId).click();
  const rest = page.getByRole("dialog", { name: /세트 후 휴식$/ });
  await expect(rest).toBeVisible();
  await expect
    .poll(
      async () =>
        (await appendObservation(page, id)).drafts.find(
          (draft) => draft.planned_set_id === plannedId,
        )?.completed,
    )
    .toBe(true);
  return rest;
}
const facts = (session: Session) =>
  session.planned_sets.map((row) => ({ id: row.id, performed_set: row.performed_set }));
function assertAccepted(body: SyncResponse, clients: string[]) {
  expect(body.conflicts.filter((conflict) => clients.includes(conflict.client_id))).toEqual([]);
  for (const id of clients) expect(body.applied.filter((item) => item === id)).toHaveLength(1);
}

async function enterFromDashboard(page: Page, id: string) {
  await page.goto("/");
  await page.locator(`a[href="/session/${id}"]`).click();
  await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^운동 \d+$/ })).toHaveCount(0);
}

async function remountThroughDashboard(page: Page, id: string, evidence: Evidence) {
  const documentBefore = await page.evaluateHandle(() => document);
  try {
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${API_V1}/sessions/${id}` && response.request().method() === "GET",
      ),
      page.locator(`a[href="/session/${id}"]`).click(),
    ]);
    const bytes = await response.body();
    evidence.remountGET = {
      status: response.status(),
      body: bytes.toString("utf8"),
      base64: bytes.toString("base64"),
    };
    expect(response.status()).toBe(200);
    expect(await page.evaluate((before) => document === before, documentBefore)).toBe(true);
    return JSON.parse(bytes.toString("utf8")) as Session;
  } finally {
    await documentBefore.dispose();
  }
}

async function appendAndAwaitAck(page: Page, id: string, source: PlannedSet) {
  await expect(appendButton(page, source)).toBeEnabled();
  await appendButton(page, source).click();
  const a = await appended(page, id, 1);
  await expect
    .poll(async () => (await appendObservation(page, id)).append?.entries[0].execution.phase)
    .toBe("applied");
  const canonical = (await appendObservation(page, id)).append!.entries[0].execution.canonical_id!;
  await expect(row(page, canonical)).toBeVisible();
  return { a, canonical };
}

function exactDeletion(wire: SyncResponse, id: string, removed: PlannedSet[]) {
  const event = wire.changes.find(
    (change) =>
      change.entity === "session_routine" &&
      change.entity_id === id &&
      change.data?.tombstones?.some((item) => item.planned_set_id === removed[0].id),
  );
  expect(event).toBeDefined();
  expect(event!.op).toBe("upsert");
  expect(Object.keys(event!.data!)).toEqual(["tombstones"]);
  const ordered = (items: { planned_set_id: string }[]) =>
    [...items].sort((a, b) => a.planned_set_id.localeCompare(b.planned_set_id));
  expect(ordered(event!.data!.tombstones!)).toEqual(
    ordered(
      removed.map((set) => ({
        planned_set_id: set.id,
        correlation_id: set.correlation_id,
        exercise_id: set.exercise_id,
      })),
    ),
  );
  return event!;
}

async function priorSequenceAt(
  priorSync: ReturnType<typeof observePriorSync>,
  cursor: unknown,
  evidence: Evidence,
) {
  expect(cursor).not.toBeNull();
  const match = () =>
    priorSync.records.find(
      (record) =>
        record.status === 200 &&
        record.response !== undefined &&
        record.response?.next_cursor === cursor &&
        record.response.changes.length > 0,
    );
  await expect.poll(() => match() !== undefined).toBe(true);
  await priorSync.close();
  const response = match()!;
  const upper = response
    .response!.changes.map((change) => BigInt(change.server_seq))
    .reduce((a, b) => (a > b ? a : b));
  evidence.priorCursorWitness = {
    cursor,
    responseIndex: priorSync.records.indexOf(response),
    serverSeqUpper: upper.toString(),
  };
  return upper;
}

// Playwright requires the worker-scoped trace option at file level; this file contains only narrow transport cases.
test.use({ trace: "on" });
test.describe("ticket04 narrow actual transport at 390px (service workers blocked)", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test.beforeEach(async ({ request, context }) => {
    await assertPositionRun(request);
    ownAppendContext(context);
  });

  test("A17-01 real button, immutable source, exact public copy and canonical ACK position", async ({
    page,
    context,
    request,
  }, info) => {
    const evidence: Evidence = {};
    let id: string | undefined;
    let held: Awaited<ReturnType<typeof holdSync>> | undefined;
    let originalError: string | null = null;
    try {
      const prepared = await setup(request, evidence);
      id = prepared.id;
      await openSession(page, id);
      const before = await observe(page, id, evidence, "beforeClick");
      expect(before.drafts).toEqual([]);
      held = await holdSync(context, (body) =>
        body.mutations.some(
          (mutation) => mutation.entity === "session_set" && mutation.entity_id === id,
        ),
      );
      evidence.transport = held.records;
      await expect(appendButton(page, prepared.source)).toBeEnabled();
      await appendButton(page, prepared.source).click();
      const a = await appended(page, id, 1);
      expect(a.intent.transport.payload.source).toEqual({
        source_planned_set_id: prepared.source.id,
        source_revision: prepared.source.source_revision,
      });
      expect(a.provisional.set_no).toBe(prepared.source.set_no + 1);
      expect(projected(a.provisional as PlannedSet)).toEqual(projected(prepared.source));
      expect(a.provisional.performed_set).toBeNull();
      await expect(input(page, a.provisional.id, "weight")).toBeFocused();
      const pending = await observe(page, id, evidence, "pendingACK");
      expect(pending.position?.position).toEqual({
        exercise_id: prepared.source.exercise_id,
        planned_set_id: a.provisional.id,
        expanded: false,
      });
      expect(pending.drafts).toEqual(before.drafts);
      expect(pending.timer).toEqual(before.timer);
      const wire = await held.fetched();
      expect(
        wire.request.mutations.find(
          (mutation) => mutation.client_id === a.intent.transport.client_id,
        ),
      ).toEqual(a.intent.transport);
      assertAccepted(wire.response!, [a.intent.transport.client_id]);
      const mapping = wire.response!.planned_set_mappings.find(
        (item) => item.correlation_id === a.provisional.id,
      )!;
      expect(mapping).toBeDefined();
      expect(mapping.planned_set.performed_set).toBeNull();
      expect(projected(mapping.planned_set)).toEqual(projected(prepared.source));
      held.release();
      await held.received(wire);
      await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
      await expect(row(page, mapping.planned_set_id)).toHaveAttribute(
        "data-session-current",
        "true",
      );
      const after = await observe(page, id, evidence, "afterACK");
      expect(after.position?.position).toEqual({
        exercise_id: prepared.source.exercise_id,
        planned_set_id: mapping.planned_set_id,
        expanded: false,
      });
      expect(after.drafts).toEqual([]);
      expect(after.timer).toBeNull();
      const authoritative = await readSession(request, id, evidence, "authoritativeGET");
      const added = authoritative.planned_sets.find((item) => item.id === mapping.planned_set_id)!;
      expect(added.correlation_id).toBe(a.provisional.id);
      expect(added.set_no).toBe(prepared.source.set_no + 1);
      expect(projected(added)).toEqual(projected(prepared.source));
      expect(added.performed_set).toBeNull();
      expect(facts(authoritative).filter((item) => item.id !== added.id)).toEqual(
        facts(prepared.session),
      );
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      await finishEvidence(context, page, id, info, evidence, held, originalError);
    }
  });

  test("A17-02 offline A to B to actual X to fixed completion C, real held reconnect bytes", async ({
    page,
    context,
    request,
  }, info) => {
    const evidence: Evidence = {};
    let id: string | undefined;
    let held: Awaited<ReturnType<typeof holdSync>> | undefined;
    let originalError: string | null = null;
    try {
      const prepared = await setup(request, evidence);
      id = prepared.id;
      await openSession(page, id);
      await expect(appendButton(page, prepared.source)).toBeEnabled();
      await context.setOffline(true); // Stay in the existing document in both engines.
      await appendButton(page, prepared.source).click();
      const a = await appended(page, id, 1);
      await expect(appendButton(page, prepared.source)).toBeEnabled();
      await appendButton(page, prepared.source).click();
      const b = await appended(page, id, 2);
      expect(b.intent.transport.payload.source).toEqual({
        source_correlation_id: a.provisional.id,
      });
      const rest = await loggedActual(page, id, b.provisional.id);
      const withTimer = await observe(page, id, evidence, "offlineActualAndTimer");
      expect(withTimer.timer).toMatchObject({
        planned_set_id: b.provisional.id,
        total_sec: b.provisional.rest_sec,
      });
      const x = withTimer.outbox.find((mutation) => mutation.entity === "performed_set")!;
      expect(x.append_dependencies).toEqual({
        session_id: id,
        client_ids: [a.intent.transport.client_id, b.intent.transport.client_id].sort(),
      });
      await rest.getByRole("button", { name: "휴식 종료", exact: true }).click();
      await expect(rest).toBeHidden();
      await expect.poll(async () => (await appendObservation(page, id!)).timer).toBeNull();
      await page.getByRole("button", { name: "운동 종료", exact: true }).click();
      const finish = page.getByRole("dialog", { name: "운동 종료", exact: true });
      await finish.getByRole("button", { name: "그래도 종료", exact: true }).click();
      await expect(finish.getByRole("alert")).toBeVisible();
      await expect(finish.getByRole("button", { name: "계속하기", exact: true })).toBeEnabled();
      await finish.getByRole("button", { name: "계속하기", exact: true }).click();
      await row(page, b.provisional.id)
        .getByRole("button", { name: /수정하려면 누르세요$/ })
        .click();
      await expect(input(page, b.provisional.id, "weight")).toHaveValue("47.5");
      await expect(input(page, b.provisional.id, "reps")).toHaveValue("9");
      const pending = await observe(page, id, evidence, "offlineFixedCompletion");
      const c = pending.outbox.find((mutation) => mutation.entity === "session")!;
      expect(c.payload.status).toBe("completed");
      expect(c.append_dependencies).toEqual({
        session_id: id,
        client_ids: [a.intent.transport.client_id, b.intent.transport.client_id].sort(),
        performed_client_ids: [x.client_id],
      });
      expect(pending.outbox).toHaveLength(4);
      expect(pending.timer).toBeNull(); // Explicit user close, not premature completion cleanup.
      held = await holdSync(context, (body) =>
        body.mutations.some((mutation) => mutation.client_id === c.client_id),
      );
      evidence.transport = held.records;
      await context.setOffline(false);
      const wire = await held.fetched();
      for (const original of pending.outbox.map(originalTransport))
        expect(
          wire.request.mutations.find((mutation) => mutation.client_id === original.client_id),
        ).toEqual(original);
      assertAccepted(
        wire.response!,
        pending.outbox.map((mutation) => mutation.client_id),
      );
      const waiting = await observe(page, id, evidence, "serverCommittedButACKHeld");
      expect(waiting.outbox.map(originalTransport)).toEqual(pending.outbox.map(originalTransport));
      expect(waiting.drafts).toEqual(pending.drafts);
      expect(waiting.position).toEqual(pending.position);
      expect(waiting.timer).toEqual(pending.timer);
      await expect(page.getByRole("heading", { name: "수고했어요" })).toHaveCount(0);
      await expect(input(page, b.provisional.id, "weight")).toHaveValue("47.5");
      held.release();
      await held.received(wire);
      await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
      await expect(page.getByText("오늘 1세트, 427.5kg 들었어요.", { exact: true })).toBeVisible();
      await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
      const after = await observe(page, id, evidence, "completedACK");
      expect(after.position?.position).toBeNull();
      expect(after.timer).toBeNull();
      const mapping = wire.response!.planned_set_mappings.find(
        (item) => item.correlation_id === b.provisional.id,
      )!;
      expect(
        after.drafts.find((draft) => draft.planned_set_id === b.provisional.id),
      ).toBeUndefined();
      expect(
        after.drafts.find((draft) => draft.planned_set_id === mapping.planned_set_id),
      ).toMatchObject({
        client_id: x.client_id,
        actual_weight: 47.5,
        actual_reps: 9,
        actual_rir: 2,
        completed: true,
      });
      const authoritative = await readSession(request, id, evidence, "completedGET");
      expect(authoritative.status).toBe("completed");
      expect(
        authoritative.planned_sets.filter((item) => item.performed_set?.completed),
      ).toHaveLength(1);
      expect(
        authoritative.planned_sets.find((item) => item.id === mapping.planned_set_id)
          ?.performed_set,
      ).toMatchObject({ actual_weight: 47.5, actual_reps: 9, actual_rir: 2, completed: true });
      expect(
        authoritative.planned_sets.filter((item) =>
          [a.provisional.id, b.provisional.id].includes(item.correlation_id ?? ""),
        ),
      ).toHaveLength(2);
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      await finishEvidence(context, page, id, info, evidence, held, originalError);
    }
  });

  test("A17-03 a new direct-remove event deletes exact remote rows and preserves unrelated appended actual", async ({
    page,
    context,
    request,
  }, info) => {
    const evidence: Evidence = {};
    let id: string | undefined;
    let held: Awaited<ReturnType<typeof holdSync>> | undefined;
    let originalError: string | null = null;
    const priorSync = observePriorSync(context);
    evidence.priorSyncResponses = priorSync.records;
    try {
      const prepared = await setup(request, evidence);
      id = prepared.id;
      await openSession(page, id);
      await expect(appendButton(page, prepared.source)).toBeEnabled();
      await appendButton(page, prepared.source).click();
      const a = await appended(page, id, 1);
      await expect
        .poll(async () => (await appendObservation(page, id!)).append?.entries[0].execution.phase)
        .toBe("applied");
      const canonical = (await appendObservation(page, id)).append!.entries[0].execution
        .canonical_id!;
      const rest = await loggedActual(page, id, canonical);
      await rest.getByRole("button", { name: "휴식 종료", exact: true }).click();
      await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
      const before = await observe(page, id, evidence, "remoteCursorBeforeRemove");
      expect(before.cursor).not.toBeNull();
      const priorAtCursor = () =>
        priorSync.records.find(
          (record) =>
            record.status === 200 &&
            record.response?.next_cursor === before.cursor &&
            record.response.changes.length > 0,
        );
      await expect.poll(() => priorAtCursor() !== undefined).toBe(true);
      await priorSync.close();
      const prior = priorAtCursor()!;
      expect(prior.response!.next_cursor).toBe(before.cursor);
      const priorSequences = prior.response!.changes.map((change) => BigInt(change.server_seq));
      const priorUpper = priorSequences.reduce((upper, sequence) =>
        sequence > upper ? sequence : upper,
      );
      evidence.priorCursorWitness = {
        responseIndex: priorSync.records.indexOf(prior),
        cursor: before.cursor,
        serverSeqUpper: priorUpper.toString(),
      };
      const serverBefore = await readSession(request, id, evidence, "beforeRemoveGET");
      const kept = serverBefore.planned_sets.find((item) => item.id === canonical)!;
      expect(kept.correlation_id).toBe(a.provisional.id);
      expect(kept.performed_set?.completed).toBe(true);
      const removed = serverBefore.planned_sets.filter(
        (item) => item.exercise_id === prepared.removable.exercise_id,
      );
      await context.setOffline(true);
      const response = await request.delete(
        `${API_V1}/sessions/${id}/exercises/${prepared.removable.exercise_id}`,
        { headers: { "X-CSRF-Token": "dev" } },
      );
      evidence.directRemove = { status: response.status(), body: await response.text() };
      expect(response.status()).toBe(200);
      for (const old of removed) await expect(row(page, old.id)).toBeVisible();
      held = await holdSync(context, (body) => body.since === before.cursor);
      evidence.transport = held.records;
      await context.setOffline(false);
      const wire = await held.fetched();
      expect(wire.request.since).toBe(before.cursor);
      const event = wire.response!.changes.find(
        (change) =>
          change.entity === "session_routine" &&
          change.entity_id === id &&
          change.data?.tombstones?.some((item) => item.planned_set_id === removed[0].id),
      );
      expect(event).toBeDefined();
      expect(event!.op).toBe("upsert");
      expect(Object.keys(event!.data!)).toEqual(["tombstones"]);
      expect(
        [...event!.data!.tombstones!].sort((a, b) =>
          a.planned_set_id.localeCompare(b.planned_set_id),
        ),
      ).toEqual(
        removed
          .map((item) => ({
            planned_set_id: item.id,
            correlation_id: item.correlation_id,
            exercise_id: item.exercise_id,
          }))
          .sort((a, b) => a.planned_set_id.localeCompare(b.planned_set_id)),
      );
      expect(BigInt(event!.server_seq)).toBeGreaterThan(priorUpper);
      let receivedUpper = priorUpper;
      for (const change of wire.response!.changes) {
        const sequence = BigInt(change.server_seq);
        expect(sequence).toBeGreaterThan(receivedUpper);
        receivedUpper = sequence;
      }
      evidence.removalResponseSequenceUpper = receivedUpper.toString();
      expect(wire.response!.next_cursor).not.toBe(before.cursor);
      held.release();
      await held.received(wire);
      for (const old of removed) await expect(row(page, old.id)).toHaveCount(0);
      await expect
        .poll(async () => (await appendObservation(page, id!)).cursor)
        .toBe(wire.response!.next_cursor);
      const after = await observe(page, id, evidence, "remoteDeleteCommitted");
      expect(
        after.mirror!.planned_sets.some((item) => removed.some((old) => old.id === item.id)),
      ).toBe(false);
      expect(after.mirror!.planned_sets.find((item) => item.id === canonical)?.correlation_id).toBe(
        a.provisional.id,
      );
      expect(after.drafts).toEqual(before.drafts);
      expect(after.outbox).toEqual(before.outbox);
      const authoritative = await readSession(request, id, evidence, "afterRemoveGET");
      expect(authoritative.planned_sets.find((item) => item.id === canonical)).toEqual(kept);
      expect(
        authoritative.planned_sets.filter(
          (item) => item.exercise_id === prepared.removable.exercise_id,
        ),
      ).toEqual([]);
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      await finishEvidence(context, page, id, info, evidence, held, originalError, priorSync);
    }
  });
  // The next four cases retain this describe's narrow transport boundary.
  test("A17-04 delayed old deletion preserves same-exercise re-add, new correlation, actual and position", async ({
    page,
    context,
    request,
  }, info) => {
    const evidence: Evidence = {};
    let id: string | undefined;
    let held: Awaited<ReturnType<typeof holdSync>> | undefined;
    let originalError: string | null = null;
    const priorSync = observePriorSync(context);
    evidence.priorSyncResponses = priorSync.records;
    try {
      const prepared = await setup(request, evidence);
      id = prepared.id;
      await enterFromDashboard(page, id);
      const old = await appendAndAwaitAck(page, id, prepared.source);
      const before = await observe(page, id, evidence, "oldAppendACK");
      const priorUpper = await priorSequenceAt(priorSync, before.cursor, evidence);
      const serverBefore = await readSession(request, id, evidence, "beforeRemoveGET");
      const removed = serverBefore.planned_sets.filter(
        (set) => set.exercise_id === prepared.source.exercise_id,
      );
      expect(removed.find((set) => set.id === old.canonical)?.correlation_id).toBe(
        old.a.provisional.id,
      );
      await context.setOffline(true);
      const deletion = await request.delete(
        `${API_V1}/sessions/${id}/exercises/${prepared.source.exercise_id}`,
        { headers: { "X-CSRF-Token": "dev" } },
      );
      evidence.directRemove = { status: deletion.status(), body: await deletion.text() };
      expect(deletion.status()).toBe(200);
      held = await holdSync(context, (body) => body.since === before.cursor);
      evidence.transport = held.records;
      await context.setOffline(false);
      const wire = await held.fetched();
      expect(wire.request.since).toBe(before.cursor);
      expect(BigInt(exactDeletion(wire.response!, id, removed).server_seq)).toBeGreaterThan(
        priorUpper,
      );
      expect(wire.response!.next_cursor).not.toBe(before.cursor);

      const added = await request.post(`${API_V1}/sessions/${id}/exercises`, {
        headers: { "X-CSRF-Token": "dev" },
        data: { exercise_id: prepared.source.exercise_id },
      });
      evidence.realReAdd = { status: added.status(), body: await added.text() };
      expect(added.status()).toBe(200);
      const readded = await readSession(request, id, evidence, "reAddGET");
      const newSource = readded.planned_sets
        .filter((set) => set.exercise_id === prepared.source.exercise_id)
        .sort((a, b) => b.set_no - a.set_no)[0];
      expect(removed.some((set) => set.id === newSource.id)).toBe(false);
      expect(newSource.append_eligibility?.status).toBe("allowed");
      const appendIntent = {
        client_id: randomUUID(),
        exercise_id: newSource.exercise_id,
        correlation_id: randomUUID(),
        source: { source_planned_set_id: newSource.id, source_revision: newSource.source_revision },
      };
      const newAppend = await request.post(`${API_V1}/sessions/${id}/sets`, {
        headers: { "X-CSRF-Token": "dev" },
        data: appendIntent,
      });
      evidence.realNewAppend = {
        request: appendIntent,
        status: newAppend.status(),
        body: await newAppend.text(),
      };
      expect(newAppend.status()).toBe(201);
      const authoritative = await readSession(request, id, evidence, "newCorrelationGET");
      const target = authoritative.planned_sets.find(
        (set) => set.correlation_id === appendIntent.correlation_id,
      )!;
      expect(target).toBeDefined();
      expect(target.set_no).toBe(newSource.set_no + 1);
      expect(target.performed_set).toBeNull();
      const remounted = await remountThroughDashboard(page, id, evidence);
      expect(remounted.planned_sets.find((set) => set.id === target.id)).toEqual(target);
      await expect(row(page, target.id)).toBeVisible();
      const rest = await loggedActual(page, id, target.id);
      await rest.getByRole("button", { name: "휴식 종료", exact: true }).click();
      await row(page, target.id)
        .getByRole("button", { name: /수정하려면 누르세요$/ })
        .click();
      await expect(input(page, target.id, "weight")).toBeFocused();
      const pending = await observe(page, id, evidence, "newActualBeforeOldDeleteDelivery");
      const x = pending.outbox.find(
        (item) => item.entity === "performed_set" && item.entity_id === target.id,
      )!;
      expect(x).toBeDefined();
      expect(pending.position?.position).toEqual({
        exercise_id: target.exercise_id,
        planned_set_id: target.id,
        expanded: true,
      });
      expect(wire.deliveredAt).toBeUndefined();
      held.release();
      await held.received(wire);
      await expect
        .poll(async () => {
          const local = await appendObservation(page, id!);
          return removed.every((set) => local.append?.tombstones.includes(set.id));
        })
        .toBe(true);
      await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
      const after = await observe(page, id, evidence, "oldDeleteThenNewActualACK");
      for (const set of removed) {
        expect(after.append?.tombstones).toContain(set.id);
        await expect(row(page, set.id)).toHaveCount(0);
      }
      expect(after.mirror!.planned_sets.find((set) => set.id === target.id)?.correlation_id).toBe(
        appendIntent.correlation_id,
      );
      expect(after.position?.position).toEqual(pending.position?.position);
      expect(after.drafts.find((draft) => draft.planned_set_id === target.id)).toMatchObject({
        client_id: x.client_id,
        actual_weight: 47.5,
        actual_reps: 9,
        actual_rir: 2,
        completed: true,
      });
      await expect(input(page, target.id, "weight")).toHaveValue("47.5");
      const final = await readSession(request, id, evidence, "afterDelayedDeleteGET");
      expect(final.planned_sets.find((set) => set.id === target.id)).toMatchObject({
        correlation_id: appendIntent.correlation_id,
        performed_set: { actual_weight: 47.5, actual_reps: 9, actual_rir: 2, completed: true },
      });
      expect(final.planned_sets.some((set) => removed.some((oldSet) => oldSet.id === set.id))).toBe(
        false,
      );
      expect(
        facts(final).filter((set) =>
          serverBefore.planned_sets.some(
            (oldSet) => oldSet.exercise_id !== target.exercise_id && oldSet.id === set.id,
          ),
        ),
      ).toEqual(
        facts(serverBefore).filter((set) => !removed.some((oldSet) => oldSet.id === set.id)),
      );
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      await finishEvidence(context, page, id, info, evidence, held, originalError, priorSync);
    }
  });

  test("A17-05 direct swap removes exact old identity without attaching its offline actual to replacement", async ({
    page,
    context,
    request,
  }, info) => {
    const evidence: Evidence = {};
    let id: string | undefined;
    let held: Awaited<ReturnType<typeof holdSync>> | undefined;
    let originalError: string | null = null;
    const priorSync = observePriorSync(context);
    evidence.priorSyncResponses = priorSync.records;
    try {
      const prepared = await setup(request, evidence);
      id = prepared.id;
      await enterFromDashboard(page, id);
      const old = await appendAndAwaitAck(page, id, prepared.source);
      const before = await observe(page, id, evidence, "beforeSwap");
      const priorUpper = await priorSequenceAt(priorSync, before.cursor, evidence);
      const serverBefore = await readSession(request, id, evidence, "beforeSwapGET");
      const removed = serverBefore.planned_sets.filter(
        (set) => set.exercise_id === prepared.source.exercise_id,
      );
      expect(removed.every((set) => set.performed_set === null)).toBe(true);
      const catalogResponse = await request.get(`${API_V1}/exercises?limit=100`);
      evidence.replacementCatalog = {
        status: catalogResponse.status(),
        body: await catalogResponse.text(),
      };
      expect(catalogResponse.status()).toBe(200);
      const catalog = (await catalogResponse.json()) as { items: { id: string; metric: string }[] };
      const replacement = catalog.items.find(
        (exercise) =>
          exercise.metric === "reps" &&
          !exercise.id.includes("assisted") &&
          !serverBefore.planned_sets.some((set) => set.exercise_id === exercise.id),
      )!;
      expect(replacement).toBeDefined();
      await context.setOffline(true);
      const rest = await loggedActual(page, id, old.canonical);
      await rest.getByRole("button", { name: "휴식 종료", exact: true }).click();
      const pending = await observe(page, id, evidence, "offlineOldActual");
      const x = pending.outbox.find((item) => item.entity === "performed_set")!;
      expect(x.append_dependencies?.client_ids).toEqual([old.a.intent.transport.client_id]);
      const swap = await request.post(
        `${API_V1}/sessions/${id}/exercises/${prepared.source.exercise_id}/swap`,
        { headers: { "X-CSRF-Token": "dev" }, data: { to_exercise_id: replacement.id } },
      );
      evidence.directSwap = { status: swap.status(), body: await swap.text() };
      expect(swap.status()).toBe(200);
      const serverAfter = await readSession(request, id, evidence, "afterSwapGET");
      const newRows = serverAfter.planned_sets.filter((set) => set.exercise_id === replacement.id);
      expect(newRows).toHaveLength(removed.length);
      expect(
        newRows.every(
          (set) => set.performed_set === null && !removed.some((oldSet) => oldSet.id === set.id),
        ),
      ).toBe(true);
      held = await holdSync(
        context,
        (body) =>
          body.since === before.cursor &&
          body.mutations.some((item) => item.client_id === x.client_id),
      );
      evidence.transport = held.records;
      await context.setOffline(false);
      const wire = await held.fetched();
      expect(wire.request.since).toBe(before.cursor);
      expect(wire.request.mutations.find((item) => item.client_id === x.client_id)).toEqual(
        originalTransport(x),
      );
      expect(BigInt(exactDeletion(wire.response!, id, removed).server_seq)).toBeGreaterThan(
        priorUpper,
      );
      expect(wire.response!.applied).not.toContain(x.client_id);
      expect(
        wire.response!.conflicts.find((conflict) => conflict.client_id === x.client_id),
      ).toMatchObject({ reason: "append_target_removed", retryable: false });
      held.release();
      await held.received(wire);
      for (const set of removed) await expect(row(page, set.id)).toHaveCount(0);
      await expect
        .poll(async () => (await appendObservation(page, id!)).cursor)
        .toBe(wire.response!.next_cursor);
      const remounted = await remountThroughDashboard(page, id, evidence);
      expect(remounted.planned_sets.filter((set) => set.exercise_id === replacement.id)).toEqual(
        newRows,
      );
      for (const set of newRows) await expect(row(page, set.id)).toBeVisible();
      const after = await observe(page, id, evidence, "replacementAfterExactDelete");
      expect(after.drafts).toEqual(pending.drafts);
      expect(
        originalTransport(after.outbox.find((item) => item.client_id === x.client_id)!),
      ).toEqual(originalTransport(x));
      expect(after.outbox.find((item) => item.client_id === x.client_id)?.sync_status).toBe(
        "blocked",
      );
      for (const set of newRows) {
        expect(after.drafts.some((draft) => draft.planned_set_id === set.id)).toBe(false);
        expect(
          after.mirror!.planned_sets.find((item) => item.id === set.id)?.performed_set,
        ).toBeNull();
      }
      const final = await readSession(request, id, evidence, "finalSwapGET");
      expect(final.planned_sets.filter((set) => set.exercise_id === replacement.id)).toEqual(
        newRows,
      );
      expect(final.planned_sets.some((set) => removed.some((oldSet) => oldSet.id === set.id))).toBe(
        false,
      );
    } catch (error) {
      originalError = String(error);
      throw error;
    } finally {
      await finishEvidence(context, page, id, info, evidence, held, originalError, priorSync);
    }
  });

  for (const [caseId, width] of [
    ["A17-06", 360],
    ["A17-07", 430],
  ] as const) {
    test(`${caseId} ${width}px completed explicit edit appends with keyboard, Escape, axe and exact ACK position`, async ({
      page,
      context,
      request,
    }, info) => {
      const evidence: Evidence = {};
      let id: string | undefined;
      let held: Awaited<ReturnType<typeof holdSync>> | undefined;
      let originalError: string | null = null;
      try {
        await page.setViewportSize({ width, height: 844 });
        const prepared = await setup(request, evidence);
        id = prepared.id;
        await openSession(page, id);
        const rest = await loggedActual(page, id, prepared.source.id);
        await rest.getByRole("button", { name: "휴식 종료", exact: true }).click();
        await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
        await page.getByRole("button", { name: "운동 종료", exact: true }).click();
        await page
          .getByRole("dialog", { name: "운동 종료", exact: true })
          .getByRole("button", { name: "그래도 종료", exact: true })
          .click();
        await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
        const completed = await readSession(request, id, evidence, "completedGET");
        expect(completed.status).toBe("completed");
        expect(
          completed.planned_sets.find((set) => set.id === prepared.source.id)?.performed_set,
        ).toMatchObject({ actual_weight: 47.5, actual_reps: 9, actual_rir: 2, completed: true });
        await page.reload();
        await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
        await expect(page.getByRole("button", { name: / 세트 추가$/ })).toHaveCount(0);
        await page.getByRole("button", { name: "기록 더하거나 고치기", exact: true }).click();
        const trigger = page.getByRole("button", { name: "운동 추가", exact: true });
        await trigger.click();
        const picker = page.getByRole("dialog", { name: "운동 추가", exact: true });
        await expect(picker.getByRole("tab", { name: "가슴", exact: true })).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect(picker.getByRole("tab", { name: "등", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(picker).toBeHidden();
        await expect(trigger).toBeFocused();
        const source = completed.planned_sets.find((set) => set.id === prepared.source.id)!;
        expect(source.append_eligibility?.status).toBe("allowed");
        const before = await observe(page, id, evidence, "explicitEditBeforeAppend");
        held = await holdSync(context, (body) =>
          body.mutations.some((item) => item.entity === "session_set" && item.entity_id === id),
        );
        evidence.transport = held.records;
        // Traverse actual keyboard order from the restored opener, without programmatic focus.
        for (
          let step = 0;
          step < 200 &&
          !(await appendButton(page, source).evaluate(
            (element) => element === document.activeElement,
          ));
          step++
        )
          await page.keyboard.press("Tab");
        await expect(appendButton(page, source)).toBeFocused();
        await page.keyboard.press("Enter");
        const a = await appended(page, id, 1);
        await expect(input(page, a.provisional.id, "weight")).toBeFocused();
        expect(projected(a.provisional as PlannedSet)).toEqual(projected(source));
        expect(a.provisional.performed_set).toBeNull();
        expect(a.intent.transport.payload.source).toEqual({
          source_planned_set_id: source.id,
          source_revision: source.source_revision,
        });
        const wire = await held.fetched();
        assertAccepted(wire.response!, [a.intent.transport.client_id]);
        expect(
          wire.request.mutations.find((item) => item.client_id === a.intent.transport.client_id),
        ).toEqual(a.intent.transport);
        const mapping = wire.response!.planned_set_mappings.find(
          (item) => item.correlation_id === a.provisional.id,
        )!;
        expect(mapping).toBeDefined();
        held.release();
        await held.received(wire);
        await expect(row(page, mapping.planned_set_id)).toHaveAttribute(
          "data-session-current",
          "true",
        );
        const after = await observe(page, id, evidence, "completedEditAppendACK");
        expect(after.position?.position).toEqual({
          exercise_id: source.exercise_id,
          planned_set_id: mapping.planned_set_id,
          expanded: false,
        });
        expect(after.drafts).toEqual(before.drafts);
        expect(after.timer).toBeNull();
        const card = row(page, mapping.planned_set_id).locator("xpath=../..");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
          .analyze();
        evidence.axeViolations = axe.violations;
        await info.attach(`actual-added-card-${width}`, {
          body: await card.screenshot(),
          contentType: "image/png",
        });
        expect(axe.violations).toEqual([]);
        const final = await readSession(request, id, evidence, "completedEditFinalGET");
        expect(final.status).toBe("completed");
        expect(final.planned_sets.find((set) => set.id === mapping.planned_set_id)).toEqual(
          mapping.planned_set,
        );
        expect(facts(final).filter((set) => set.id !== mapping.planned_set_id)).toEqual(
          facts(completed),
        );
      } catch (error) {
        originalError = String(error);
        throw error;
      } finally {
        await finishEvidence(context, page, id, info, evidence, held, originalError);
      }
    });
  }
});

// Remaining obligations: SW-enabled append/offline/reload, assistance samples0/1/2/3 offline/reload,
// retry/GET both orders, broader G/M4/concurrency and actual duplicate delivery (unit proof is separate).

/** Passive observation only: SW-enabled tests never route, fulfill, abort, or replace a response. */
function observeSwSync(context: BrowserContext) {
  const records: {
    requestText: string;
    request: SyncRequest;
    requestWorker: string | null;
    status?: number;
    fromServiceWorker?: boolean;
    responseText?: string;
    responseBase64?: string;
    responseSha256?: string;
    response?: SyncResponse;
    failure?: string | null;
    error?: string;
  }[] = [];
  const identities = new Map<Request, (typeof records)[number]>();
  const pending = new Set<Promise<void>>();
  const ownRequest = (request: Request) => {
    if (request.url() !== `${API_V1}/sync` || request.method() !== "POST") return;
    const existing = identities.get(request);
    if (existing) return existing;
    const requestText = request.postData() ?? "";
    const record: (typeof records)[number] = {
      requestText,
      request: JSON.parse(requestText) as SyncRequest,
      requestWorker: request.serviceWorker()?.url() ?? null,
    };
    identities.set(request, record);
    records.push(record);
    return record;
  };
  const onRequest = (request: Request) => {
    ownRequest(request);
  };
  const onFailed = (request: Request) => {
    const record = ownRequest(request);
    if (record) record.failure = request.failure()?.errorText ?? null;
  };
  const onResponse = (response: Response) => {
    const record = ownRequest(response.request());
    if (!record) return;
    record.status = response.status();
    record.fromServiceWorker = response.fromServiceWorker();
    const work = (async () => {
      try {
        const bytes = await response.body();
        record.responseText = bytes.toString("utf8");
        record.responseBase64 = bytes.toString("base64");
        record.responseSha256 = createHash("sha256").update(bytes).digest("hex");
        if (record.status === 200)
          record.response = JSON.parse(record.responseText) as SyncResponse;
      } catch (error) {
        record.error = String(error);
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work));
  };
  context.on("request", onRequest);
  context.on("requestfailed", onFailed);
  context.on("response", onResponse);
  return {
    records,
    async close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailed);
      context.off("response", onResponse);
      while (pending.size) await Promise.allSettled([...pending]);
      const errors = records.flatMap((record) => (record.error ? [record.error] : []));
      if (errors.length) throw new Error(errors.join("; "));
    },
  };
}

async function swState(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration(location.href);
    const cached = await caches.match(location.href, { cacheName: "afc-pages-v1" });
    return {
      url: location.href,
      online: navigator.onLine,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      controllerState: navigator.serviceWorker.controller?.state ?? null,
      scope: registration?.scope ?? null,
      active: registration?.active?.state ?? null,
      cacheStatus: cached?.status ?? null,
      cacheContentType: cached?.headers.get("content-type") ?? null,
    };
  });
}

async function prepareControlledSession(page: Page, evidence: Evidence) {
  const states: unknown[] = [];
  evidence.swReadiness = states;
  const sample = async (phase: string) => {
    const value = await swState(page);
    states.push({ phase, ...value });
    return value;
  };
  await expect.poll(async () => (await sample("registered")).scope).toBe(`${WEB_ORIGIN}/`);
  await expect.poll(async () => (await sample("active")).active).toBe("activated");
  await expect
    .poll(async () => (await sample("controller")).controller)
    .toBe(`${WEB_ORIGIN}/sw.js`);
  // One controlled online navigation populates the exact document cache, as in09/16.
  // A failed cache check ends this case; there is no second warm or fallback navigation.
  const response = await page.reload();
  evidence.controlledOnlinePreparation = {
    count: 1,
    status: response?.status(),
    fromServiceWorker: response?.fromServiceWorker(),
  };
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const state = await sample("exact-document-cached");
      return (
        state.controller === `${WEB_ORIGIN}/sw.js` &&
        state.controllerState === "activated" &&
        state.cacheStatus === 200 &&
        state.cacheContentType?.includes("text/html") === true
      );
    })
    .toBe(true);
}

function committedSwParity(state: Awaited<ReturnType<typeof appendObservation>>) {
  return {
    mirror: state.mirror,
    routines: state.routines,
    append: state.append,
    drafts: state.drafts,
    outbox: state.outbox
      .map(originalTransport)
      .sort((a, b) => a.client_id.localeCompare(b.client_id)),
    position: state.position,
    timer: state.timer,
  };
}

async function swAppendCase(
  page: Page,
  context: BrowserContext,
  request: APIRequestContext,
  info: TestInfo,
  nativeReload: boolean,
) {
  const evidence: Evidence = {
    boundary: {
      serviceWorkers: "allow",
      routeInterception: 0,
      nativeWholeOfflineReload: nativeReload,
      operatingSystemProcessClaim: false,
    },
  };
  const traffic = observeSwSync(context);
  evidence.passiveSync = traffic.records;
  let id: string | undefined;
  let originalError: string | null = null;
  const errors: string[] = [];
  try {
    const prepared = await setup(request, evidence);
    id = prepared.id;
    await openSession(page, id);
    await prepareControlledSession(page, evidence);
    const warmed = await observe(page, id, evidence, "controlledOnlineLocal");
    expect(warmed.serviceWorker).toBe(`${WEB_ORIGIN}/sw.js`);
    expect(warmed.outbox).toEqual([]);
    expect(warmed.drafts).toEqual([]);
    const source = warmed.mirror!.planned_sets.find((set) => set.id === prepared.source.id)!;
    expect(source.append_eligibility?.status).toBe("allowed");
    await context.setOffline(true);
    await expect(appendButton(page, source)).toBeEnabled();
    await appendButton(page, source).click();
    const a = await appended(page, id, 1);
    await expect(appendButton(page, source)).toBeEnabled();
    await appendButton(page, source).click();
    const b = await appended(page, id, 2);
    expect(a.intent.transport.payload.source).toEqual({
      source_planned_set_id: source.id,
      source_revision: source.source_revision,
    });
    expect(b.intent.transport.payload.source).toEqual({ source_correlation_id: a.provisional.id });
    for (const [index, entry] of [a, b].entries()) {
      expect(entry.provisional.set_no).toBe(source.set_no + index + 1);
      expect(projected(entry.provisional as PlannedSet)).toEqual(projected(source));
      expect(entry.provisional.performed_set).toBeNull();
    }
    await loggedActual(page, id, b.provisional.id);
    await expect
      .poll(async () => {
        const state = await appendObservation(page, id!);
        return (
          state.timer?.planned_set_id === b.provisional.id &&
          state.position?.position?.planned_set_id === b.provisional.id
        );
      })
      .toBe(true);
    const committed = await observe(page, id, evidence, "offlineCommittedBeforeAnyReload");
    expect(committed.online).toBe(false);
    expect(committed.serviceWorker).toBe(`${WEB_ORIGIN}/sw.js`);
    expect(committed.outbox).toHaveLength(3);
    expect(committed.drafts).toHaveLength(1);
    const x = committed.outbox.find((mutation) => mutation.entity === "performed_set")!;
    expect(x.append_dependencies).toEqual({
      session_id: id,
      client_ids: [a.intent.transport.client_id, b.intent.transport.client_id].sort(),
    });
    expect(committed.drafts[0]).toMatchObject({
      planned_set_id: b.provisional.id,
      client_id: x.client_id,
      actual_weight: 47.5,
      actual_reps: 9,
      actual_rir: 2,
      completed: true,
    });
    expect(committed.position?.position).toEqual({
      exercise_id: source.exercise_id,
      planned_set_id: b.provisional.id,
      expanded: false,
    });
    expect(committed.timer?.total_sec).toBe(b.provisional.rest_sec);
    expect(committed.timer!.ends_at).toBeGreaterThan(committed.observedAt);
    const serverBefore = await readSession(
      request,
      id,
      evidence,
      "serverStillUnchangedWhileBrowserOffline",
    );
    expect(serverBefore.planned_sets.map((set) => set.id)).toEqual(
      prepared.session.planned_sets.map((set) => set.id),
    );
    expect(facts(serverBefore)).toEqual(facts(prepared.session));

    if (nativeReload) {
      const response = await page.reload(); // Native whole-offline navigation, no route interception.
      evidence.nativeOfflineReload = {
        status: response?.status(),
        fromServiceWorker: response?.fromServiceWorker(),
        navigationRequest: response?.request().isNavigationRequest(),
        url: response?.url(),
      };
      expect(response?.status()).toBe(200);
      expect(response?.fromServiceWorker()).toBe(true);
      expect(response?.request().isNavigationRequest()).toBe(true);
      expect(response?.url()).toBe(`${WEB_ORIGIN}/session/${id}`);
      await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
    }
    // No user input, focus call, timer action or reconnect is allowed before this durable comparison.
    await expect(page.getByRole("dialog", { name: /세트 후 휴식$/ })).toHaveCount(1);
    await expect(row(page, b.provisional.id)).toHaveAttribute("data-session-current", "true");
    const recovered = await observe(page, id, evidence, "offlineParityBeforeUserInteraction");
    expect(committedSwParity(recovered)).toEqual(committedSwParity(committed));
    expect(recovered.online).toBe(false);
    const sw = await swState(page);
    evidence.offlineControllerAndCache = sw;
    expect(sw.controller).toBe(`${WEB_ORIGIN}/sw.js`);
    expect(sw.cacheStatus).toBe(200);
    expect(sw.cacheContentType).toContain("text/html");
    expect(sw.online).toBe(false);
    const clients = committed.outbox.map((mutation) => mutation.client_id);
    expect(
      traffic.records.some((record) =>
        record.response?.applied.some((client) => clients.includes(client)),
      ),
    ).toBe(false);
    const reconnectBefore = await page.evaluate(() => Date.now());
    evidence.reconnectBefore = reconnectBefore;
    await context.setOffline(false);
    const acknowledged = () =>
      traffic.records.find(
        (record) =>
          record.status === 200 &&
          clients.every((client) => record.response?.applied.includes(client)),
      );
    await expect.poll(() => acknowledged() !== undefined).toBe(true);
    const ack = acknowledged()!;
    assertAccepted(ack.response!, clients);
    for (const original of committed.outbox.map(originalTransport)) {
      const sent = traffic.records
        .flatMap((record) => record.request.mutations)
        .filter((mutation) => mutation.client_id === original.client_id);
      expect(sent.length).toBeGreaterThan(0);
      for (const mutation of sent) expect(mutation).toEqual(original);
    }
    const mappings = ack.response!.planned_set_mappings.filter((mapping) =>
      [a.provisional.id, b.provisional.id].includes(mapping.correlation_id),
    );
    expect(mappings).toHaveLength(2);
    const canonical = mappings.find(
      (mapping) => mapping.correlation_id === b.provisional.id,
    )!.planned_set_id;
    const performedChanges = ack.response!.changes.filter(
      (change) => change.entity === "performed_set" && change.entity_id === canonical,
    );
    expect(performedChanges).toHaveLength(1);
    expect(performedChanges[0]).toMatchObject({
      entity: "performed_set",
      entity_id: canonical,
      op: "upsert",
      data: x.payload,
    });
    expect(performedChanges[0].data).not.toHaveProperty("updated_at");
    await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
    await expect(row(page, canonical)).toHaveAttribute("data-session-current", "true");
    const after = await observe(page, id, evidence, "realAckCommitted");
    expect(after.position?.position).toEqual({
      ...committed.position!.position,
      planned_set_id: canonical,
    });
    expect(after.timer).toEqual({ ...committed.timer, planned_set_id: canonical });
    expect(after.drafts).toHaveLength(1);
    const afterDraft = after.drafts[0];
    const appliedAt = Date.parse(afterDraft.updated_at);
    evidence.ackPullClock = {
      reconnectBefore,
      committedObservationAfter: after.observedAt,
      originalUpdatedAt: committed.drafts[0].updated_at,
      appliedUpdatedAt: afterDraft.updated_at,
      performedChange: performedChanges[0],
    };
    // Mapping keeps T0; the same real ACK's performed pull records browser-local apply time T1.
    expect(Number.isFinite(appliedAt)).toBe(true);
    expect(appliedAt).toBeGreaterThan(Date.parse(committed.drafts[0].updated_at));
    expect(appliedAt).toBeGreaterThanOrEqual(reconnectBefore);
    expect(appliedAt).toBeLessThanOrEqual(after.observedAt);
    expect(afterDraft).toMatchObject({
      ...committed.drafts[0],
      planned_set_id: canonical,
      updated_at: afterDraft.updated_at,
    });
    expect(after.drafts.some((draft) => draft.planned_set_id === b.provisional.id)).toBe(false);
    expect(after.append!.entries.map((entry) => entry.intent)).toEqual(
      committed.append!.entries.map((entry) => entry.intent),
    );
    expect(after.append!.entries.every((entry) => entry.execution.phase === "applied")).toBe(true);
    const authoritative = await readSession(request, id, evidence, "realAckAuthoritativeGET");
    expect(authoritative.planned_sets).toHaveLength(prepared.session.planned_sets.length + 2);
    for (const mapping of mappings)
      expect(
        authoritative.planned_sets.find((set) => set.id === mapping.planned_set_id)?.correlation_id,
      ).toBe(mapping.correlation_id);
    expect(
      authoritative.planned_sets.find((set) => set.id === canonical)?.performed_set,
    ).toMatchObject({
      actual_weight: 47.5,
      actual_reps: 9,
      actual_rir: 2,
      actual_time_sec: committed.drafts[0].actual_time_sec,
      completed: true,
      performed_at: committed.drafts[0].updated_at,
    });
    expect(
      facts(authoritative).filter((set) =>
        prepared.session.planned_sets.some((original) => original.id === set.id),
      ),
    ).toEqual(facts(prepared.session));
    await expect(page.getByRole("dialog", { name: /세트 후 휴식$/ })).toHaveCount(1);
  } catch (error) {
    originalError = String(error);
    throw error;
  } finally {
    evidence.originalError = originalError;
    evidence.cleanupErrors = errors;
    if (id) {
      try {
        evidence.finalLocalBeforeCleanup = await appendObservation(page, id);
      } catch (error) {
        errors.push(`final local: ${String(error)}`);
      }
      try {
        evidence.finalSwBeforeCleanup = await swState(page);
      } catch (error) {
        errors.push(`final SW: ${String(error)}`);
      }
    }
    await traffic.close().catch((error: unknown) => errors.push(String(error)));
    await context.setOffline(false).catch((error: unknown) => errors.push(String(error)));
    await info
      .attach("sw-append-integration.json", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      })
      .catch((error: unknown) => {
        errors.push(`attachment: ${String(error)}`);
        console.warn(JSON.stringify(evidence));
      });
  }
  if (errors.length) throw new Error(errors.join("; "));
}

test.describe("ticket04 G4 SW-enabled append (no route interception)", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  test.beforeEach(async ({ request, context }) => {
    await assertPositionRun(request);
    ownAppendContext(context);
  });
  test("A17-08 SW-enabled existing-document offline append chain and actual survive real reconnect ACK", async ({
    page,
    context,
    request,
  }, info) => {
    await swAppendCase(page, context, request, info, false);
  });
  test("A17-09 @chromium-only SW-enabled native whole-offline reload restores append actual position and timer", async ({
    page,
    context,
    request,
  }, info) => {
    await swAppendCase(page, context, request, info, true);
  });
});
