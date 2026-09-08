/**
 * This spec requires a fresh principal per browser project. Spec15 completes sessions
 * for the same assisted exercises, so an integrated run cannot satisfy this precondition.
 * Run this spec in its own fresh-principal phase. Native history opens the display gate only.
 * Historical target sessions remain scheduled; these INSERT fixtures are not public-API creation proof.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import type { E1rmAnalytics, PlannedSet, Session, SyncRequest, SyncResponse } from "../lib/api";
import type { components } from "../lib/api-types";
import { expect, test } from "./fixtures";
import { API_V1, addExercise, openSession, seedExternalLoadProgram, todaySession } from "./helpers";
import { TEST_NOW } from "./test-today";
import { prepareHistoricalSnapshot } from "./support/assistance-historical-setup";
import { assertPositionRun } from "./support/session-position-observation";
import { appendObservation, ownAppendContext } from "./support/session-set-append-observation";

const pairs = ["e_assisted_pullup", "e_assisted_dips"];
const FRESH_PRINCIPAL_REQUIRED =
  "이 스펙은 fresh principal을 전제합니다. spec15가 같은 종목의 완료 세션을 만들므로 통합 실행에서는 성립하지 않습니다. 새 principal의 전용 phase로 실행하세요.";
const headers = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };
type Evidence = Record<string, unknown>;
type Mode = "external" | "remediated";
const row = (page: Page, id: string) => page.locator(`[data-planned-set-id="${id}"]`);
const input = (page: Page, id: string, axis: string) => page.locator(`[id="set-${id}-${axis}"]`);
const fields = [
  "recommended_weight",
  "recommended_reps",
  "reason_code",
  "confidence",
  "recommendation_state",
  "recommended_action",
  "recommendation_gate",
  "load_kind",
  "assistance_provenance",
  "rules_version",
  "assistance_safety_status",
  "target_reps_low",
  "target_reps_high",
  "target_rir",
  "rest_sec",
  "target_time_low_sec",
  "target_time_high_sec",
] as const;
const projected = (set: PlannedSet) => Object.fromEntries(fields.map((key) => [key, set[key]]));
function isAppend(
  mutation: SyncRequest["mutations"][number],
): mutation is components["schemas"]["AppendSetSyncMutation"] {
  return (
    mutation.entity === "session_set" &&
    mutation.op === "upsert" &&
    "source" in mutation.payload &&
    "exercise_id" in mutation.payload &&
    "correlation_id" in mutation.payload
  );
}

async function readSession(
  request: APIRequestContext,
  id: string,
  evidence: Evidence,
  key: string,
) {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  const body = await response.text();
  evidence[key] = { status: response.status(), body };
  expect(response.status()).toBe(200);
  return JSON.parse(body) as Session;
}
async function samples(request: APIRequestContext, count: number, evidence: Evidence, key: string) {
  const observations: unknown[] = [];
  evidence[key] = observations;
  for (const exercise_id of pairs) {
    const response = await request.get(`${API_V1}/analytics/e1rm`, { params: { exercise_id } });
    const body = await response.text();
    observations.push({ exercise_id, status: response.status(), body });
    expect(response.status()).toBe(200);
    const actual = (JSON.parse(body) as E1rmAnalytics).sample_session_count;
    // Initial sample0 precedes fixture INSERTs and all native history preparation.
    if (count === 0 && actual !== 0) throw new Error(FRESH_PRINCIPAL_REQUIRED);
    expect(actual).toBe(count);
  }
}
async function addNativeHistory(
  request: APIRequestContext,
  from: number,
  to: number,
  evidence: Evidence,
) {
  const history: Evidence[] = [];
  evidence.nativeDisplayGateHistory = history;
  for (let count = from; count < to; count++) {
    const item: Evidence = {};
    history.push(item);
    await samples(request, count, item, "beforeCount");
    await seedExternalLoadProgram(request, { pain_areas: [] });
    const id = await todaySession(request);
    item.sessionId = id;
    for (const pair of pairs) await addExercise(request, id, pair);
    const session = await readSession(request, id, item, "nativeSession");
    const native = session.planned_sets.filter((set) => pairs.includes(set.exercise_id));
    expect(native).toHaveLength(6);
    for (const set of native) {
      expect(set.load_kind).toBe("assistance");
      expect(set.assistance_provenance).toBe("native");
      expect(set.performed_set).toBeNull();
    }
    const mutations: SyncRequest["mutations"] = native.map((set) => ({
      client_id: randomUUID(),
      entity: "performed_set",
      entity_id: set.id,
      op: "upsert",
      updated_at: TEST_NOW,
      payload: { actual_weight: 20, actual_reps: 9, actual_rir: 2, completed: true },
    }));
    const response = await request.post(`${API_V1}/sync`, { headers, data: { mutations } });
    const body = await response.text();
    item.sync = { mutations, status: response.status(), body };
    expect(response.status()).toBe(200);
    const ack = JSON.parse(body) as SyncResponse;
    expect(ack.conflicts).toEqual([]);
    expect([...ack.applied].sort()).toEqual(mutations.map((mutation) => mutation.client_id).sort());
    const accepted = await readSession(request, id, item, "acceptedGET");
    for (const mutation of mutations)
      expect(
        accepted.planned_sets.find((set) => set.id === mutation.entity_id)?.performed_set,
      ).toMatchObject(mutation.payload);
    const completed = await request.post(`${API_V1}/sessions/${id}/complete`, {
      headers,
      data: {},
    });
    item.completion = { status: completed.status(), body: await completed.text() };
    expect(completed.status()).toBe(200);
    expect((await readSession(request, id, item, "completedGET")).status).toBe("completed");
    await samples(request, count + 1, item, "afterCount");
  }
  expect(new Set(history.map((item) => item.sessionId)).size).toBe(to - from);
}
function assertWire(set: PlannedSet, mode: Mode, sample: number) {
  expect(projected(set)).toEqual({
    load_kind: mode === "external" ? "external" : "assistance",
    assistance_provenance: mode === "external" ? null : "remediated",
    rules_version: mode === "external" ? "2026.08.1" : "2026.08.2",
    assistance_safety_status: mode === "external" ? null : "safe",
    target_reps_low: 7,
    target_reps_high: 13,
    target_rir: 3,
    rest_sec: 137,
    target_time_low_sec: null,
    target_time_high_sec: null,
    recommendation_gate: sample === 0 ? "no_history" : sample < 3 ? "early" : "ready",
    ...(sample < 3
      ? {
          recommended_weight: null,
          recommended_reps: null,
          reason_code: null,
          confidence: null,
          recommendation_state: null,
          recommended_action: null,
        }
      : mode === "external"
        ? {
            recommended_weight: 56.25,
            recommended_reps: 9,
            reason_code: "ASSISTANCE_MINIMUM_REACHED",
            confidence: 0.63,
            recommendation_state: "ready",
            recommended_action: null,
          }
        : {
            recommended_weight: null,
            recommended_reps: 9,
            reason_code: "ASSISTANCE_CALIBRATION_NEEDED",
            confidence: 0,
            recommendation_state: "load_calibration_needed",
            recommended_action: null,
          }),
  });
  expect(set.performed_set).toBeNull();
}
async function assertInputs(page: Page, set: PlannedSet, mode: Mode, sample: number) {
  await expect(row(page, set.id)).toHaveCount(1);
  await expect(input(page, set.id, "weight")).toHaveAttribute(
    "placeholder",
    mode === "external" ? "무게" : "도움",
  );
  await expect(input(page, set.id, "weight")).toHaveValue(
    mode === "external" && sample === 3 ? "56.25" : "",
  );
  await expect(input(page, set.id, "reps")).toHaveValue(sample === 3 ? "9" : "");
  await expect(page.getByText(/^다음 단계로 .*을?를? 고려해 보세요/)).toHaveCount(0);
}

test.use({ trace: "on" });
test.describe("M4 historical INSERT fixture: display gate only, scheduled target GET/UI/append/reload", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 390, height: 844 } });
  for (const [index, scenario] of (
    [
      { sample: 0, mode: "external", from: 0 },
      { sample: 0, mode: "remediated", from: 0 },
      { sample: 2, mode: "external", from: 0 },
      { sample: 2, mode: "remediated", from: 2 },
      { sample: 3, mode: "external", from: 2 },
      { sample: 3, mode: "remediated", from: 3 },
    ] as const
  ).entries()) {
    test(`H19-0${index + 1} sample${scenario.sample} ${scenario.mode}: exact fixture refusals, GET gate, UI append ACK and reload`, async ({
      page,
      request,
      context,
    }, info) => {
      const evidence: Evidence = {
        scenario,
        boundary:
          "Native completed history is display-gate preparation, not external recommendation evidence. Target never completed.",
      };
      let id: string | undefined;
      let originalError: string | null = null;
      const cleanupErrors: string[] = [];
      try {
        await assertPositionRun(request);
        ownAppendContext(context);
        await addNativeHistory(request, scenario.from, scenario.sample, evidence);
        await samples(request, scenario.sample, evidence, "initialSamples");
        const setup = await prepareHistoricalSnapshot(request, scenario.mode, evidence);
        id = setup.sessionId;
        for (const target of setup.targets) assertWire(target, scenario.mode, scenario.sample);
        await openSession(page, id);
        for (const target of setup.targets)
          await assertInputs(page, target, scenario.mode, scenario.sample);
        const initial = await appendObservation(page, id);
        evidence.initialLocal = initial;
        expect(initial.drafts).toEqual([]);
        expect(initial.outbox).toEqual([]);
        expect(initial.timer).toBeNull();
        const appended: PlannedSet[] = [];
        const originalAppends: SyncRequest["mutations"] = [];
        const deliveries: unknown[] = [];
        evidence.appendDeliveries = deliveries;
        for (const target of setup.targets) {
          expect(target.append_eligibility?.status).toBe("allowed");
          const button = row(page, target.id)
            .locator("xpath=../..")
            .getByRole("button", { name: / 세트 추가$/ });
          await expect(button).toBeEnabled();
          const [response] = await Promise.all([
            page.waitForResponse((response) => {
              if (!response.url().endsWith("/sync") || response.request().method() !== "POST")
                return false;
              const sent = response.request().postDataJSON() as SyncRequest;
              return sent.mutations
                .filter(isAppend)
                .some(
                  (mutation) =>
                    mutation.entity === "session_set" &&
                    mutation.entity_id === id &&
                    mutation.payload.exercise_id === target.exercise_id,
                );
            }),
            button.click(),
          ]);
          const bytes = await response.body();
          const sent = response.request().postDataJSON() as SyncRequest;
          const ack = JSON.parse(bytes.toString()) as SyncResponse;
          deliveries.push({
            requestText: response.request().postData(),
            status: response.status(),
            browserBodyBase64: bytes.toString("base64"),
            ack,
          });
          expect(response.status()).toBe(200);
          expect(ack.conflicts).toEqual([]);
          const mutations = sent.mutations
            .filter(isAppend)
            .filter(
              (mutation) =>
                mutation.entity === "session_set" &&
                mutation.entity_id === id &&
                mutation.payload.exercise_id === target.exercise_id,
            );
          expect(mutations).toHaveLength(1);
          const mutation = mutations[0];
          expect(sent.mutations).toEqual([mutation]);
          originalAppends.push(mutation);
          expect(mutation.payload.source).toEqual({
            source_planned_set_id: target.id,
            source_revision: target.source_revision,
          });
          expect(ack.applied).toContain(mutation.client_id);
          const mappings = ack.planned_set_mappings.filter(
            (mapping) => mapping.correlation_id === mutation.payload.correlation_id,
          );
          expect(mappings).toHaveLength(1);
          const canonical = mappings[0].planned_set_id;
          await expect
            .poll(
              async () => (await appendObservation(page, id!)).position?.position?.planned_set_id,
            )
            .toBe(canonical);
          await expect(input(page, canonical, "weight")).toBeFocused();
          const authority = await readSession(
            request,
            id,
            evidence,
            `appendGET-${target.exercise_id}`,
          );
          const child = authority.planned_sets.find((set) => set.id === canonical)!;
          expect(child).toBeDefined();
          expect(child.exercise_id).toBe(target.exercise_id);
          expect(child.set_no).toBe(2);
          expect(child.correlation_id).toBe(mutation.payload.correlation_id);
          assertWire(child, scenario.mode, scenario.sample);
          await assertInputs(page, child, scenario.mode, scenario.sample);
          appended.push(child);
        }
        await expect.poll(async () => (await appendObservation(page, id!)).outbox.length).toBe(0);
        const committed = await appendObservation(page, id);
        evidence.afterAck = committed;
        expect(committed.drafts).toEqual([]);
        expect(committed.timer).toBeNull();
        expect(committed.append?.entries).toHaveLength(2);
        for (const entry of committed.append!.entries) {
          expect(entry.execution.phase).toBe("applied");
          expect(entry.intent.transport).toEqual(
            originalAppends.find(
              (mutation) => mutation.client_id === entry.intent.transport.client_id,
            ),
          );
        }
        await page.reload();
        for (const set of [...setup.targets, ...appended])
          await assertInputs(page, set, scenario.mode, scenario.sample);
        await expect
          .poll(async () => (await appendObservation(page, id!)).position?.position)
          .toEqual(committed.position?.position);
        const restored = await appendObservation(page, id);
        evidence.restored = restored;
        expect(restored.drafts).toEqual([]);
        expect(restored.outbox).toEqual([]);
        expect(restored.timer).toBeNull();
        expect(restored.append).toEqual(committed.append);
        const final = await readSession(request, id, evidence, "finalGET");
        expect(final.status).toBe("scheduled");
        expect(final.planned_sets.filter((set) => pairs.includes(set.exercise_id))).toHaveLength(4);
        for (const set of final.planned_sets.filter((set) => pairs.includes(set.exercise_id)))
          assertWire(set, scenario.mode, scenario.sample);
        await samples(request, scenario.sample, evidence, "targetDidNotAddHistory");
      } catch (error) {
        originalError = String(error);
        throw error;
      } finally {
        evidence.originalError = originalError;
        evidence.cleanupErrors = cleanupErrors;
        if (id && !page.isClosed()) {
          try {
            evidence.finalLocal = await appendObservation(page, id);
          } catch (error) {
            cleanupErrors.push(`readonly final: ${String(error)}`);
          }
        }
        await info
          .attach("historical-assistance.json", {
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
