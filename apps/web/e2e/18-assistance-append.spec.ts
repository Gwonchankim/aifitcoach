/**
 * M4 native assistance only. This spec requires a fresh principal per browser project.
 * Spec15 completes sessions for the same assisted exercises, so an integrated run
 * cannot satisfy this precondition. Run this spec in its own fresh-principal phase.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import type {
  CompletionAnalytics,
  E1rmAnalytics,
  PlannedSet,
  Session,
  SyncRequest,
} from "../lib/api";
import { expect, test } from "./fixtures";
import { API_V1, WEB_ORIGIN, addExercise, openSession, seedProgram, todaySession } from "./helpers";
import { assertPositionRun } from "./support/session-position-observation";
import {
  appendObservation,
  ownAppendContext,
  originalTransport,
} from "./support/session-set-append-observation";
import { assistanceTransport, committedParity } from "./support/assistance-append-observation";

test.use({ trace: "on" });
const pairs = ["e_assisted_pullup", "e_assisted_dips"] as const;
const FRESH_PRINCIPAL_REQUIRED =
  "이 스펙은 fresh principal을 전제합니다. spec15가 같은 종목의 완료 세션을 만들므로 통합 실행에서는 성립하지 않습니다. 새 principal의 전용 phase로 실행하세요.";
const headers = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };
type Evidence = Record<string, unknown>;
const row = (page: Page, id: string) => page.locator(`[data-planned-set-id="${id}"]`);
const input = (page: Page, id: string, axis: string) => page.locator(`[id="set-${id}-${axis}"]`);
const appendButton = (page: Page, source: PlannedSet) =>
  row(page, source.id)
    .locator("xpath=../..")
    .getByRole("button", { name: / 세트 추가$/ });
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
const projected = (set: PlannedSet) =>
  Object.fromEntries(publicFields.map((key) => [key, set[key]]));
const ordered = (mutations: SyncRequest["mutations"]) =>
  [...mutations].sort((a, b) => a.client_id.localeCompare(b.client_id));

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
async function sampleCounts(
  request: APIRequestContext,
  count: number,
  evidence: Evidence,
  label: string,
) {
  const observations: { exercise_id: string; status: number; body: string }[] = [];
  evidence[label] = observations;
  for (const exercise_id of pairs) {
    const response = await request.get(`${API_V1}/analytics/e1rm`, { params: { exercise_id } });
    const text = await response.text();
    observations.push({ exercise_id, status: response.status(), body: text });
    expect(response.status()).toBe(200);
    const body = JSON.parse(text) as E1rmAnalytics;
    expect(body.exercise_id).toBe(exercise_id);
    // The initial sample0 check runs before any program/session preparation.
    if (count === 0 && body.sample_session_count !== 0) throw new Error(FRESH_PRINCIPAL_REQUIRED);
    expect(
      body.sample_session_count,
      "fresh owned principal: no history reset or polluted starting count",
    ).toBe(count);
    expect(body.gate_state).toBe(count === 0 ? "no_history" : count < 3 ? "early" : "ready");
  }
}
function assertPublic(set: PlannedSet, sample: number) {
  expect(set.load_kind).toBe("assistance");
  expect(set.assistance_safety_status).toBe("safe");
  expect(set.assistance_provenance).toBe("native");
  expect(set.recommendation_gate).toBe(
    sample === 0 ? "no_history" : sample < 3 ? "early" : "ready",
  );
  if (sample < 3) {
    expect(set.recommended_weight).toBeNull();
    expect(set.recommended_reps).toBeNull();
    expect(set.recommended_action).toBeNull();
  } else {
    expect(set.recommendation_state).toBe("ready");
    expect(typeof set.recommended_weight).toBe("number");
    expect(typeof set.recommended_reps).toBe("number");
  }
}
async function futureTarget(request: APIRequestContext, session: Session, evidence: Evidence) {
  const response = await request.get(`${API_V1}/analytics/completion`, { params: { weeks: 2 } });
  const text = await response.text();
  evidence.futureCalendar = { status: response.status(), body: text };
  expect(response.status()).toBe(200);
  const calendar = JSON.parse(text) as CompletionAnalytics;
  expect(calendar.program_id).toBe(session.program_id);
  const day = calendar.weeks
    .flatMap((week) => week.days)
    .filter(
      (item) => item.session_id && item.date > session.scheduled_date && item.state === "scheduled",
    )
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  expect(day?.session_id).toBeTruthy();
  for (const pair of pairs) await addExercise(request, day.session_id!, pair);
  const target = await readSession(request, day.session_id!, evidence, "futureUnperformedTarget");
  expect(target.program_id).toBe(session.program_id);
  for (const pair of pairs) {
    const sets = target.planned_sets.filter((set) => set.exercise_id === pair);
    expect(sets).toHaveLength(3);
    for (const set of sets) expect(set.performed_set).toBeNull();
  }
}

const cases = [
  { id: "M18-01", sample: 0, order: "get-first" },
  { id: "M18-02", sample: 1, order: "ack-first" },
  { id: "M18-03", sample: 2, order: "get-first" },
  { id: "M18-04", sample: 3, order: "ack-first" },
  { id: "M18-05", sample: 3, order: "get-first" },
] as const;

test.describe("M4 native pullup+dips: SW-blocked transport, same-context document-online/API-blocked restoration", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ context, request }) => {
    await assertPositionRun(request);
    ownAppendContext(context);
  });
  for (const scenario of cases) {
    const sequence =
      scenario.order === "get-first"
        ? "current GET before retry ACK"
        : "ACK-before-staleGET settlement: canceled superseded GET, fresh authority committed";
    test(`${scenario.id} sample${scenario.sample} offline chain+actual/new-document parity; real response loss and one reconnect: ${sequence}`, async ({
      page: initialPage,
      context,
      request,
      browserName,
    }, info) => {
      let page = initialPage;
      let id: string | undefined;
      let transport: Awaited<ReturnType<typeof assistanceTransport>> | undefined;
      let originalError: string | null = null;
      const cleanupErrors: string[] = [];
      const evidence: Evidence = {
        scenario,
        boundary: {
          serviceWorkers: "block",
          nativePairs: pairs,
          history: "public API only; separate fresh owned phase per project",
          wholeOfflineDocument: false,
          operatingSystemProcess: false,
          reconnectRetryCount: 1,
        },
      };
      try {
        await sampleCounts(request, scenario.sample, evidence, "initialExactSamples");
        await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
        id = await todaySession(request);
        for (const pair of pairs) await addExercise(request, id, pair);
        const initial = await readSession(request, id, evidence, "initialSession");
        const sources = pairs.map((pair) => {
          const cohort = initial.planned_sets.filter((set) => set.exercise_id === pair);
          expect(cohort).toHaveLength(3);
          for (const set of cohort) {
            assertPublic(set, scenario.sample);
            expect(set.performed_set).toBeNull();
            expect(set.append_eligibility).toMatchObject({
              version: 1,
              status: "allowed",
              reason: null,
              source_revision: set.source_revision,
            });
          }
          expect(new Set(cohort.map((set) => set.append_eligibility!.cohort_revision)).size).toBe(
            1,
          );
          return [...cohort].sort((a, b) => b.set_no - a.set_no)[0];
        });
        await openSession(page, id);
        const online = await appendObservation(page, id);
        evidence.initialLocal = online;
        expect(online.outbox).toEqual([]);
        expect(online.drafts).toEqual([]);
        expect(online.timer).toBeNull();
        await context.setOffline(true);
        expect(await page.evaluate(() => navigator.onLine)).toBe(false);
        let count = 0;
        for (const source of sources) {
          for (let child = 0; child < 2; child++) {
            await expect(appendButton(page, source)).toBeEnabled();
            await appendButton(page, source).click();
            count++;
            await expect
              .poll(async () => (await appendObservation(page, id!)).append?.entries.length)
              .toBe(count);
            const snapshot = await appendObservation(page, id);
            const entry = snapshot.append!.entries[count - 1];
            const parent = snapshot.append!.entries[count - 2];
            expect(entry.intent.transport.payload.source).toEqual(
              child === 0
                ? { source_planned_set_id: source.id, source_revision: source.source_revision }
                : { source_correlation_id: parent.provisional.id },
            );
            expect(entry.provisional.set_no).toBe(source.set_no + child + 1);
            expect(projected(entry.provisional as PlannedSet)).toEqual(projected(source));
            assertPublic(entry.provisional as PlannedSet, scenario.sample);
            expect(entry.provisional.performed_set).toBeNull();
            expect(snapshot.drafts).toEqual([]);
            expect(snapshot.timer).toBeNull();
            await expect(input(page, entry.provisional.id, "weight")).toBeFocused();
          }
        }
        const justAppended = await appendObservation(page, id);
        evidence.offlineAppendActualZero = justAppended;
        const children = [justAppended.append!.entries[1], justAppended.append!.entries[3]];
        for (const [index, child] of children.entries()) {
          await input(page, child.provisional.id, "weight").fill("20");
          await expect(input(page, child.provisional.id, "weight")).toHaveValue("20");
          await input(page, child.provisional.id, "reps").fill("9");
          await expect(input(page, child.provisional.id, "reps")).toHaveValue("9");
          await input(page, child.provisional.id, "rir").fill("2");
          await expect(input(page, child.provisional.id, "rir")).toHaveValue("2");
          await expect(input(page, child.provisional.id, "weight")).toHaveValue("20");
          await expect(input(page, child.provisional.id, "reps")).toHaveValue("9");
          await expect(input(page, child.provisional.id, "rir")).toHaveValue("2");
          await page.locator(`[data-set-check="${child.provisional.id}"]`).click();
          await expect(page.getByRole("dialog", { name: /세트 후 휴식$/ })).toBeVisible();
          await expect
            .poll(
              async () =>
                (await appendObservation(page, id!)).drafts.filter((draft) => draft.completed)
                  .length,
            )
            .toBe(index + 1);
          if (index === 0) {
            await page.getByRole("button", { name: "휴식 종료", exact: true }).click();
            await expect(page.getByRole("dialog", { name: /세트 후 휴식$/ })).toHaveCount(0);
            await expect.poll(async () => (await appendObservation(page, id!)).timer).toBeNull();
            // closeRest clears durably, closes the modal, then focuses the next unfinished row.
            // Waiting for that real focus avoids filling a still-inert background input.
            const next = initial.planned_sets.find(
              (set) => set.exercise_id === pairs[1] && set.set_no === 1,
            )!;
            expect(next).toBeDefined();
            const previousIndex = justAppended.visibleRows.findIndex(
              (item) => item.id === child.provisional.id,
            );
            expect(justAppended.visibleRows[previousIndex + 1]?.id).toBe(next.id);
            await expect(input(page, next.id, "weight")).toBeFocused();
            evidence.firstRestClosedAndNaturalFocus = await appendObservation(page, id);
          }
        }
        await expect
          .poll(async () => (await appendObservation(page, id!)).timer?.planned_set_id)
          .toBe(children[1].provisional.id);
        const committed = await appendObservation(page, id);
        evidence.offlineCommitted = committed;
        expect(committed.online).toBe(false);
        expect(committed.outbox).toHaveLength(6);
        expect(committed.drafts).toHaveLength(2);
        const originals = ordered(committed.outbox.map(originalTransport));
        for (const [index, child] of children.entries()) {
          const draft = committed.drafts.find(
            (item) => item.planned_set_id === child.provisional.id,
          )!;
          const actual = committed.outbox.find((item) => item.client_id === draft.client_id)!;
          expect(draft).toMatchObject({
            actual_weight: 20,
            actual_reps: 9,
            actual_rir: 2,
            completed: true,
          });
          expect(actual.entity).toBe("performed_set");
          expect(actual.entity_id).toBe(child.provisional.id);
          expect(actual.updated_at).toBe(draft.updated_at);
          expect(actual.append_dependencies).toEqual({
            session_id: id,
            client_ids: committed
              .append!.entries.slice(index * 2, index * 2 + 2)
              .map((entry) => entry.intent.transport.client_id)
              .sort(),
          });
        }
        expect(committed.position?.position).toEqual({
          exercise_id: pairs[1],
          planned_set_id: children[1].provisional.id,
          expanded: false,
        });
        expect(committed.timer!.ends_at).toBeGreaterThan(committed.observedAt);
        expect(committed.timer!.total_sec).toBe(children[1].provisional.rest_sec);
        expect(await readSession(request, id, evidence, "serverUnaffectedWhileOffline")).toEqual(
          initial,
        );

        transport = await assistanceTransport(context, id);
        evidence.transport = transport.records;
        evidence.blockedApi = transport.blocked;
        evidence.blockedApiResponses = transport.blockedResponses;
        await page.close();
        expect(context.pages()).toEqual([]);
        await context.setOffline(false);
        page = await context.newPage();
        const document = await page.goto(`${WEB_ORIGIN}/session/${id}`);
        evidence.newDocument = {
          status: document?.status(),
          fromServiceWorker: document?.fromServiceWorker(),
          url: page.url(),
        };
        expect(document?.status()).toBe(200);
        expect(document?.fromServiceWorker()).toBe(false);
        await expect
          .poll(
            () =>
              transport!.blocked.filter(
                (entry) => entry.url === `${API_V1}/sessions/${id}` && !!entry.failed,
              ).length,
          )
          .toBeGreaterThan(0);
        await expect(row(page, children[1].provisional.id)).toHaveAttribute(
          "data-session-current",
          "true",
        );
        await expect(page.getByRole("dialog", { name: /세트 후 휴식$/ })).toHaveCount(1);
        const restored = await appendObservation(page, id);
        evidence.restoredBeforeUserInteraction = restored;
        expect(restored.online).toBe(true);
        expect(restored.serviceWorker).toBeNull();
        expect(committedParity(restored)).toEqual(committedParity(committed));
        expect(transport.blockedResponses).toEqual([]);
        for (const draft of restored.drafts) {
          await expect(row(page, draft.planned_set_id)).toContainText("20");
          await expect(row(page, draft.planned_set_id)).toContainText("9");
        }

        transport.begin(
          scenario.order,
          originals.map((item) => item.client_id),
        );
        // Real reload supplies both the app's GET and foreground sync; it does not write test state.
        await page.reload({ waitUntil: "domcontentloaded" });
        const lost = await transport.lost();
        const first = transport.sync(lost);
        expect(first.conflicts).toEqual([]);
        expect([...first.applied].sort()).toEqual(originals.map((item) => item.client_id).sort());
        expect(ordered(transport.outgoing(lost).mutations)).toEqual(originals);
        const heldGet = await transport.fetched("get");
        const fetchedSession = transport.session(heldGet);
        evidence.firstServerAppliedBrowserLost = first;
        evidence.getSettlement =
          scenario.order === "ack-first"
            ? "App cancellation after ACK; no stale browser200 delivery or late snapshot merge claim"
            : "Current GET browser200 delivered before retry ACK";
        if (scenario.order === "ack-first") {
          expect(fetchedSession).toEqual(initial);
          expect(heldGet.fetched!.at).toBeLessThanOrEqual(lost.fetched!.at);
        } else {
          expect(fetchedSession.planned_sets).toHaveLength(initial.planned_sets.length + 4);
          transport.releaseGet();
          await transport.received(heldGet);
          await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
        }
        const beforeRetry = await appendObservation(page, id);
        evidence.serverAppliedButNoAck = beforeRetry;
        expect(ordered(beforeRetry.outbox.map(originalTransport))).toEqual(originals);
        expect(beforeRetry.append!.entries.map((entry) => entry.intent)).toEqual(
          committed.append!.entries.map((entry) => entry.intent),
        );
        expect(
          beforeRetry.append!.entries.every((entry) => entry.execution.phase !== "applied"),
        ).toBe(true);
        const clockBeforeAck = await page.evaluate(() => Date.now());
        // Exactly one additional real disconnect/reconnect retries the intentionally lost response.
        await context.setOffline(true);
        expect(await page.evaluate(() => navigator.onLine)).toBe(false);
        await context.setOffline(false);
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        const retry = await transport.fetched("sync", 1);
        expect(ordered(transport.outgoing(retry).mutations)).toEqual(originals);
        const ack = transport.sync(retry);
        expect(ack.conflicts).toEqual([]);
        expect([...ack.applied].sort()).toEqual(originals.map((item) => item.client_id).sort());
        const mappings = ack.planned_set_mappings.filter((mapping) =>
          committed.append!.entries.some(
            (entry) => entry.provisional.id === mapping.correlation_id,
          ),
        );
        expect(mappings).toHaveLength(4);
        expect(new Set(mappings.map((mapping) => mapping.planned_set_id)).size).toBe(4);
        expect(
          mappings.map((mapping) => [mapping.correlation_id, mapping.planned_set_id]).sort(),
        ).toEqual(
          first.planned_set_mappings
            .map((mapping) => [mapping.correlation_id, mapping.planned_set_id])
            .sort(),
        );
        transport.releaseAck();
        await transport.received(retry);
        await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
        const acked = await appendObservation(page, id);
        evidence.retryAckCommitted = acked;
        if (scenario.order === "ack-first") {
          await transport.canceled(
            heldGet,
            retry,
            browserName === "webkit" ? "Load request cancelled" : "net::ERR_ABORTED",
          );
          const freshGet = await transport.fetched("fresh-get");
          expect(freshGet.requestId).not.toBe(heldGet.requestId);
          expect(freshGet.requestedAt).toBeGreaterThanOrEqual(retry.browser[0].at);
          const freshSession = transport.session(freshGet);
          expect(freshSession.id).toBe(id);
          expect(freshSession.planned_sets).toHaveLength(initial.planned_sets.length + 4);
          for (const mapping of mappings)
            expect(
              freshSession.planned_sets.find((set) => set.id === mapping.planned_set_id)
                ?.correlation_id,
            ).toBe(mapping.correlation_id);
          const beforeFresh = await appendObservation(page, id);
          const freshCommitLower = await page.evaluate(() => Date.now());
          evidence.freshAuthorityCommitBoundary = {
            beforeFresh,
            freshCommitLower,
            requestId: freshGet.requestId,
          };
          transport.releaseFresh();
          await transport.received(freshGet);
          await expect
            .poll(async () => {
              const local = await appendObservation(page, id!);
              return local.sessions[0]?.updated_at;
            })
            .not.toBe(beforeFresh.sessions[0]?.updated_at);
          const freshCommitted = await appendObservation(page, id);
          expect(Date.parse(String(freshCommitted.sessions[0]?.updated_at))).toBeGreaterThanOrEqual(
            freshCommitLower,
          );
          expect(freshCommitted.mirror).toEqual(freshSession);
          evidence.freshAuthorityCommitted = freshCommitted;
          expect(heldGet.browser).toEqual([]);
          expect(heldGet.deliveryCount).toBe(0);
        } else expect(retry.browser[0].at).toBeGreaterThanOrEqual(heldGet.browser[0].at);
        const canonicalLast = mappings.find(
          (mapping) => mapping.correlation_id === children[1].provisional.id,
        )!.planned_set_id;
        await expect(row(page, canonicalLast)).toHaveAttribute("data-session-current", "true");
        const final = await appendObservation(page, id);
        evidence.finalAfterOrderedSettlement = final;
        expect(final.outbox).toEqual([]);
        expect(final.append!.entries.map((entry) => entry.intent)).toEqual(
          committed.append!.entries.map((entry) => entry.intent),
        );
        expect(final.append!.entries.every((entry) => entry.execution.phase === "applied")).toBe(
          true,
        );
        expect(final.position?.position).toEqual({
          ...committed.position!.position,
          planned_set_id: canonicalLast,
        });
        expect(final.timer).toEqual({ ...committed.timer, planned_set_id: canonicalLast });
        expect(final.drafts).toHaveLength(2);
        for (const mapping of mappings) {
          expect(
            final.mirror!.planned_sets.filter((set) => set.id === mapping.planned_set_id),
          ).toHaveLength(1);
          expect(final.mirror!.planned_sets.some((set) => set.id === mapping.correlation_id)).toBe(
            false,
          );
          expect(
            final.mirror!.planned_sets.find((set) => set.id === mapping.planned_set_id)
              ?.correlation_id,
          ).toBe(mapping.correlation_id);
          await expect(row(page, mapping.planned_set_id)).toHaveCount(1);
          const original = committed.append!.entries.find(
            (entry) => entry.provisional.id === mapping.correlation_id,
          )!;
          expect(projected(mapping.planned_set)).toEqual(
            projected(original.provisional as PlannedSet),
          );
          const draft = committed.drafts.find(
            (item) => item.planned_set_id === mapping.correlation_id,
          );
          if (!draft) continue;
          const receivedDraft = final.drafts.find(
            (item) => item.planned_set_id === mapping.planned_set_id,
          )!;
          const pull = ack.changes.filter(
            (change) =>
              change.entity === "performed_set" && change.entity_id === mapping.planned_set_id,
          );
          expect(pull).toHaveLength(1);
          expect(pull[0]).toMatchObject({
            op: "upsert",
            data: { actual_weight: 20, actual_reps: 9, actual_rir: 2, completed: true },
          });
          expect(pull[0].data).not.toHaveProperty("updated_at");
          const appliedAt = Date.parse(receivedDraft.updated_at);
          expect(appliedAt).toBeGreaterThan(Date.parse(draft.updated_at));
          expect(appliedAt).toBeGreaterThanOrEqual(clockBeforeAck);
          expect(appliedAt).toBeLessThanOrEqual(final.observedAt);
          expect(receivedDraft).toMatchObject({
            ...draft,
            planned_set_id: mapping.planned_set_id,
            updated_at: receivedDraft.updated_at,
          });
        }
        expect(final.mirror!.planned_sets).toHaveLength(initial.planned_sets.length + 4);
        const current = await readSession(request, id, evidence, "authoritativeCurrentGET");
        expect(current.planned_sets).toHaveLength(initial.planned_sets.length + 4);
        for (const original of initial.planned_sets) {
          expect(current.planned_sets.filter((set) => set.id === original.id)).toHaveLength(1);
          expect(current.planned_sets.find((set) => set.id === original.id)?.performed_set).toEqual(
            original.performed_set,
          );
        }
        for (const mapping of mappings) {
          const authoritative = current.planned_sets.find(
            (set) => set.id === mapping.planned_set_id,
          )!;
          expect(authoritative.correlation_id).toBe(mapping.correlation_id);
          expect(projected(authoritative)).toEqual(projected(mapping.planned_set));
          const draft = committed.drafts.find(
            (item) => item.planned_set_id === mapping.correlation_id,
          );
          if (draft)
            expect(authoritative.performed_set).toMatchObject({
              actual_weight: 20,
              actual_reps: 9,
              actual_rir: 2,
              completed: true,
              performed_at: draft.updated_at,
            });
          else expect(authoritative.performed_set).toBeNull();
        }
        expect(transport.records.filter((entry) => entry.kind === "sync")).toHaveLength(2);
        expect(lost.browser).toEqual([]);
        expect(lost.deliveryCount).toBe(0);
        expect(retry.deliveryCount).toBe(1);
        await sampleCounts(
          request,
          scenario.sample,
          evidence,
          "actualAloneDoesNotAdvanceCompletedSample",
        );
        if (scenario.sample < 3) {
          await futureTarget(request, initial, evidence);
          const complete = await request.post(`${API_V1}/sessions/${id}/complete`, {
            headers,
            data: {},
          });
          const text = await complete.text();
          evidence.publicCompletion = { status: complete.status(), body: text };
          expect(complete.status()).toBe(200);
          const result = JSON.parse(text) as {
            next_recommendations: {
              exercise_id: string;
              sample_session_count: number;
              gate_state: string;
            }[];
          };
          for (const pair of pairs)
            expect(
              result.next_recommendations.find((entry) => entry.exercise_id === pair),
            ).toMatchObject({
              sample_session_count: scenario.sample + 1,
              gate_state: scenario.sample === 2 ? "ready" : "early",
            });
          await sampleCounts(
            request,
            scenario.sample + 1,
            evidence,
            "onlyThisCompletedSessionAdvancesHistory",
          );
        }
      } catch (error) {
        originalError = String(error);
        throw error;
      } finally {
        evidence.originalError = originalError;
        evidence.cleanupErrors = cleanupErrors;
        if (id && !page.isClosed()) {
          try {
            evidence.finalBeforeCleanup = await appendObservation(page, id);
          } catch (error) {
            cleanupErrors.push(`readonly final: ${String(error)}`);
          }
        }
        if (transport)
          await transport.close().catch((error: unknown) => cleanupErrors.push(String(error)));
        await context
          .setOffline(false)
          .catch((error: unknown) => cleanupErrors.push(String(error)));
        await info
          .attach("native-assistance-append.json", {
            body: Buffer.from(JSON.stringify(evidence, null, 2)),
            contentType: "application/json",
          })
          .catch((error: unknown) => {
            cleanupErrors.push(`attachment: ${String(error)}`);
            console.warn(JSON.stringify(evidence));
          });
      }
      if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
    });
  }
});

// Separate obligations: SW-enabled assistance sample reload; remediated/external-ID snapshots
// (backend136 and pure ingress evidence, not UI/reload proof); broader fault/duplicate delivery matrix.
