/** D01/M2: genuine performed history → minimum calculation → passive canonical suggestion. */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, addExercise, openSession, seedProgram, todaySession } from "./helpers";
import { TEST_NOW } from "./test-today";
import { assistanceDatabaseSnapshot } from "./support/assistance-observation";
import type { Session } from "../lib/api";

test.describe.configure({ mode: "serial" });
const pairs = [
  { id: "e_assisted_pullup", target: "e_pullup", text: "다음 단계로 풀업을 고려해 보세요" },
  { id: "e_assisted_dips", target: "e_dips", text: "다음 단계로 딥스를 고려해 보세요" },
];
const headers = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };
async function getSession(request: APIRequestContext, id: string): Promise<Session> {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Session>;
}
async function fresh(request: APIRequestContext) {
  await seedProgram(request, { equipment: ["bodyweight"], pain_areas: [] });
  const id = await todaySession(request);
  for (const pair of pairs) await addExercise(request, id, pair.id);
  return getSession(request, id);
}
async function outbox(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("afc-session-v1");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const read = db.transaction("outbox").objectStore("outbox").getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
    } finally {
      db.close();
    }
  });
}

test("minimum pullup+dips suggestions survive GET, reload, offline/reload and reconnect without mutations @chromium-only", async ({
  page,
  context,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const sessionIds: string[] = [];
  for (const pair of pairs) {
    const target = await request.get(`${API_V1}/exercises/${pair.target}`);
    expect(target.status()).toBe(200);
    expect((await target.json()).name_ko).toBe(pair.target === "e_pullup" ? "풀업" : "딥스");
  }
  let session = await fresh(request);
  // Exercise-specific history must start at zero: fail rather than assuming previous tests are harmless.
  for (let count = 0; count < 3; count += 1) {
    sessionIds.push(session.id);
    for (const pair of pairs) {
      const rows = session.planned_sets.filter((row) => row.exercise_id === pair.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.recommendation_gate).toBe(count === 0 ? "no_history" : "early");
        expect(row.recommended_weight).toBeNull();
        expect(row.recommended_action).toBeNull();
      }
    }
    await openSession(page, session.id);
    for (const pair of pairs)
      await expect(page.getByText(pair.text, { exact: true })).toHaveCount(0);
    const sync = await request.post(`${API_V1}/sync`, {
      headers,
      data: {
        mutations: session.planned_sets
          .filter((row) => pairs.some((pair) => pair.id === row.exercise_id))
          .map((row) => ({
            client_id: randomUUID(),
            entity: "performed_set",
            entity_id: row.id,
            op: "upsert",
            updated_at: TEST_NOW,
            payload: {
              actual_weight: 2.5,
              actual_reps: row.target_reps_high,
              actual_rir: 2,
              completed: true,
            },
          })),
      },
    });
    expect(sync.status()).toBe(200);
    const complete = await request.post(`${API_V1}/sessions/${session.id}/complete`, {
      headers,
      data: {},
    });
    expect(complete.status()).toBe(200);
    const summary = (await complete.json()) as {
      next_recommendations: {
        exercise_id: string;
        sample_session_count: number;
        gate_state: string;
      }[];
    };
    for (const pair of pairs)
      expect(summary.next_recommendations.find((row) => row.exercise_id === pair.id)).toMatchObject(
        { sample_session_count: count + 1, gate_state: count === 2 ? "ready" : "early" },
      );
    session = await fresh(request);
  }
  sessionIds.push(session.id);
  for (const pair of pairs) {
    const row = session.planned_sets.find((row) => row.exercise_id === pair.id)!;
    expect(row).toMatchObject({
      recommended_weight: 2.5,
      load_kind: "assistance",
      reason_code: "ASSISTANCE_MINIMUM_REACHED",
      recommendation_state: "ready",
      recommendation_gate: "ready",
      assistance_safety_status: "safe",
      recommended_action: { kind: "suggest_exercise_swap", exercise_id: pair.target },
    });
  }
  await openSession(page, session.id);
  const databaseBefore = await assistanceDatabaseSnapshot(sessionIds);
  const outboxBefore = await outbox(page);
  expect(outboxBefore).toEqual([]);
  const mutations: unknown[] = [];
  page.on("request", (event) => {
    if (event.method() === "GET") return;
    if (/\/exercises\/[^/]+\/swap/.test(event.url())) mutations.push({ endpoint: "swap" });
    if (event.url().endsWith("/v1/sync")) {
      const payload = event.postDataJSON() as { mutations?: unknown[] };
      if (payload.mutations?.length) mutations.push(...payload.mutations);
    }
  });
  const assertPassive = async () => {
    for (const pair of pairs) {
      await expect(page.getByText(pair.text, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: pair.text, exact: true })).toHaveCount(0);
    }
    expect(await outbox(page)).toEqual(outboxBefore);
  };
  await assertPassive();
  await testInfo.attach("minimum-online", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  expect(await getSession(request, session.id)).toEqual(session);
  await page.reload();
  await assertPassive();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await assertPassive();
  await context.setOffline(false);
  await page.reload();
  await assertPassive();
  expect(mutations).toEqual([]);
  const databaseAfter = await assistanceDatabaseSnapshot(sessionIds);
  expect(databaseAfter).toEqual(databaseBefore);
  await testInfo.attach("minimum-observation", {
    body: JSON.stringify({
      databaseBefore,
      databaseAfter,
      outboxBefore,
      outboxAfter: await outbox(page),
      mutations,
    }),
    contentType: "application/json",
  });
});

test("catalog pending/failure and defensive action variants never show a guessed target @chromium-only", async ({
  page,
  request,
}, testInfo) => {
  // The previous scenario establishes genuine minimum/gate-open history. No stored recommendation is patched.
  const session = await fresh(request);
  for (const pair of pairs)
    expect(session.planned_sets.find((row) => row.exercise_id === pair.id)?.reason_code).toBe(
      "ASSISTANCE_MINIMUM_REACHED",
    );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/exercises*", async (route) => {
    await pending;
    await route.abort("failed");
  });
  await page.goto(`/session/${session.id}`);
  await expect(page.getByText("운동 목록을 불러오는 중이에요.")).toBeAttached();
  for (const pair of pairs) await expect(page.getByText(pair.text, { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  for (const pair of pairs) await expect(page.getByText(pair.text, { exact: true })).toHaveCount(0);
  await page.unroute("**/v1/exercises*");
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  for (const pair of pairs) await expect(page.getByText(pair.text, { exact: true })).toBeVisible();
  // Explicit response-boundary defensive fixtures, separate from the unmocked calculation scenario above.
  const variants = [
    { label: "null", patch: { recommended_action: null } },
    {
      label: "unknown-target",
      patch: { recommended_action: { kind: "suggest_exercise_swap", exercise_id: "unknown" } },
    },
    {
      label: "pain",
      patch: {
        recommendation_state: "substitution_required",
        reason_code: "SUBSTITUTE_PAIN",
        recommended_weight: 20,
      },
    },
    {
      label: "invalid",
      patch: {
        recommendation_state: "unavailable",
        reason_code: "INVALID_INPUT",
        recommended_weight: 20,
      },
    },
    {
      label: "gateclosed",
      patch: {
        recommendation_gate: "early",
        reason_code: null,
        recommended_weight: null,
        recommended_reps: null,
      },
    },
  ];
  const databaseBefore = await assistanceDatabaseSnapshot([session.id]);
  for (const variant of variants) {
    await page.route(`**/v1/sessions/${session.id}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Session;
      await route.fulfill({
        response,
        json: {
          ...body,
          planned_sets: body.planned_sets.map((row) =>
            pairs.some((pair) => pair.id === row.exercise_id) ? { ...row, ...variant.patch } : row,
          ),
        },
      });
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "오늘 운동", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "운동 추가", exact: true })).toBeVisible();
    for (const pair of pairs)
      await expect(page.getByText(pair.text, { exact: true })).toHaveCount(0);
    expect(await outbox(page)).toEqual([]);
    await testInfo.attach(`defensive-${variant.label}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.unroute(`**/v1/sessions/${session.id}`);
  }
  expect(await assistanceDatabaseSnapshot([session.id])).toEqual(databaseBefore);
});
