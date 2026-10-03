import { test, expect } from "./fixtures";
import { API_V1, seedProgram, todaySession } from "./helpers";
import { parseCardioSnapshot } from "shared";
import { openApiOfflinePage, readRelaunchState } from "./support/api-offline-relaunch";

test("real reserved POST preserves cardio through lazy GET, reload and offline reading", async ({
  page,
  request,
  context,
  browserName,
}) => {
  await seedProgram(request, {
    goal: "hypertrophy",
    days_per_week: 4,
    minutes_per_day: 60,
    pain_areas: [],
    equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "stationary_bike"],
  });
  const response = await request.get(`${API_V1}/programs/current`);
  expect(response.status()).toBe(200);
  const program = await response.json();
  expect(program.rules_version).toBe("2026.09.1");
  const source = program.sessions
    .flatMap((slot: { exercises: unknown[] }) => slot.exercises)
    .map(parseCardioSnapshot)
    .filter(Boolean);
  expect(source).toHaveLength(1);
  expect(source[0]).toMatchObject({
    source_day: "FRI",
    source_ordinal: 4,
    duration_sec: 600,
    intensity_seconds: { moderate: 600, high: 0, recovery: 0 },
  });
  const sessionId = await todaySession(request);
  const sessionResponse = await request.get(`${API_V1}/sessions/${sessionId}`);
  expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json();
  expect(session.planned_sets.map(parseCardioSnapshot).filter(Boolean)).toEqual(source);
  await page.goto("/program");
  await expect(page.getByTestId("cardio-prescription").first()).toBeVisible();
  await page.goto(`/session/${sessionId}`);
  const card = page.getByTestId("cardio-prescription");
  await expect(card).toBeVisible();
  await expect(card).toContainText("10");
  await expect(card).toContainText("5");
  await expect(card.locator("input,button")).toHaveCount(0);
  await page.reload();
  await expect(card).toBeVisible();
  const onlineText = await card.innerText();
  await context.setOffline(true);
  // Same platform boundary as 09-offline-sync.spec.ts:178: WebKit raises an internal
  // error for offline reload. Reuse its fresh-page API-offline recovery, with no SW.
  if (browserName === "webkit") {
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    });
    const beforeClose = await readRelaunchState(page, sessionId);
    expect(beforeClose.serviceWorker.registrations).toEqual([]);
    await page.close();
    const { resumed, blockedApi, successfulApi } = await openApiOfflinePage(context);
    try {
      await resumed.goto(`/session/${sessionId}`);
      await expect
        .poll(() => blockedApi)
        .toContainEqual({
          method: "GET",
          url: `${API_V1}/sessions/${sessionId}`,
        });
      const offlineCard = resumed.getByTestId("cardio-prescription");
      await expect(offlineCard).toBeVisible();
      expect(await offlineCard.innerText()).toBe(onlineText);
      const recovered = await readRelaunchState(resumed, sessionId);
      expect(recovered.sessions).toHaveLength(1);
      const mirrored = recovered.sessions[0].session as { planned_sets: unknown[] };
      expect(mirrored.planned_sets.map(parseCardioSnapshot).filter(Boolean)).toEqual(source);
      expect(recovered.serviceWorker.registrations).toEqual([]);
      expect(recovered.serviceWorker.controller).toBeNull();
      expect(successfulApi).toEqual([]);
      await test.info().attach("cardio-api-offline-recovery", {
        body: JSON.stringify({ beforeClose, recovered, blockedApi, successfulApi }, null, 2),
        contentType: "application/json",
      });
    } finally {
      await resumed.close();
      await context.unroute("**/v1/**");
    }
  } else {
    await page.reload();
    await expect(card).toBeVisible();
    expect(await card.innerText()).toBe(onlineText);
    await context.setOffline(false);
  }
});

test("reserved generation rejects unknown pain and absent bike without replacing the current program", async ({
  request,
}) => {
  await seedProgram(request, {
    goal: "hypertrophy",
    days_per_week: 2,
    pain_areas: [],
    equipment: ["barbell", "dumbbell", "bodyweight"],
  });
  const before = await (await request.get(`${API_V1}/programs/current`)).json();
  for (const data of [
    {
      goal: "diet",
      days_per_week: 4,
      minutes_per_day: 60,
      experience_level: "intermediate",
      equipment: ["stationary_bike"],
    },
    {
      goal: "diet",
      days_per_week: 4,
      minutes_per_day: 60,
      experience_level: "intermediate",
      equipment: ["machine"],
      pain_areas: [],
    },
  ]) {
    const response = await request.post(`${API_V1}/programs/generate`, {
      headers: { "X-CSRF-Token": "dev" },
      data,
    });
    expect(response.status()).toBe(400);
    const after = await (await request.get(`${API_V1}/programs/current`)).json();
    expect(after).toEqual(before);
  }
});
