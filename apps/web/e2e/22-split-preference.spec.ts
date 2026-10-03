import type { APIRequestContext, Page } from "@playwright/test";
import { parseCardioSnapshot } from "shared";
import { test, expect } from "./fixtures";
import { API_V1 } from "./helpers";
import { openApiOfflinePage, readRelaunchState } from "./support/api-offline-relaunch";
import {
  splitDatabaseSnapshot,
  type ObservedProgram,
  type SplitSnapshot,
  type TemplateSlot,
} from "./support/split-preference-observation";

type Program = {
  program_id: string;
  rules_version: string;
  split_preference_snapshot: SplitSnapshot;
  sessions: TemplateSlot[];
};
const equipment = [
  "barbell",
  "dumbbell",
  "machine",
  "cable",
  "bodyweight",
  "ez_bar",
  "stationary_bike",
];
const generateInput = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
  equipment,
  pain_areas: [],
};

async function profilePreference(page: Page, value: "상체 우선" | "하체 우선" | null) {
  await page.goto("/profile");
  await expect(page.getByRole("group", { name: "운동 분할 선호" })).toBeVisible();
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/me") && response.request().method() === "PATCH",
  );
  if (value === null) {
    await page.getByRole("button", { name: "선호 지우기", exact: true }).click();
  } else {
    await page.getByRole("radio", { name: value, exact: true }).check();
    await page.getByRole("button", { name: "선호 저장", exact: true }).click();
  }
  const response = await pending;
  expect(response.status()).toBe(200);
  const expected =
    value === null ? null : value === "상체 우선" ? "upper_priority" : "lower_priority";
  expect(response.request().postDataJSON()).toEqual({ split_preference: expected });
  expect(await response.json()).toMatchObject({
    split_preference: expected,
    split_preference_supported: true,
  });
  await page.reload();
  await expect(page.getByRole("radio", { name: value ?? "선호 없음", exact: true })).toBeChecked();
}

async function onboardingDays(page: Page, days: 4 | 5) {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "기본 정보를 알려 주세요" })).toBeVisible();
  await page.getByRole("button", { name: "남성", exact: true }).click();
  await page.getByLabel("출생연도").fill("1993");
  await page.getByLabel("키 (cm)").fill("175");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("button", { name: /근비대/ }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("button", { name: `주 ${days}일`, exact: true }).click();
}

async function onboardingReview(page: Page, bikeAlreadySelected = false) {
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("button", { name: "60분", exact: true }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("button", { name: /중급/ }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  const bike = page.getByRole("button", { name: "고정식 자전거", exact: true });
  await expect(bike).toHaveAttribute("aria-pressed", String(bikeAlreadySelected));
  if (!bikeAlreadySelected) await bike.click();
  await expect(bike).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  // Real known-no-pain selection; screening/readiness/history are never injected as cleared.
  const noPain = page.getByRole("button", { name: "해당 없음, 불편한 곳 없음", exact: true });
  if ((await noPain.getAttribute("aria-pressed")) !== "true") await noPain.click();
}

async function finishOnboarding(page: Page, bikeAlreadySelected = false) {
  await onboardingReview(page, bikeAlreadySelected);
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/programs/generate") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "계획 만들기", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON() as Record<string, unknown>;
  expect(payload.equipment).toEqual(equipment);
  expect(payload.pain_areas).toEqual([]);
  expect(payload).not.toHaveProperty("rules_version");
  expect(payload).not.toHaveProperty("screening");
  expect(payload).not.toHaveProperty("readiness");
  expect(payload).not.toHaveProperty("history");
  const program = (await response.json()) as Program;
  expect(program.rules_version).toBe("2026.09.1");
  await expect(page).toHaveURL(/\/program$/);
  await expect(page.getByRole("heading", { name: "주간 프로그램", exact: true })).toBeVisible();
  return { payload, program };
}

async function persistedPlan(request: APIRequestContext, program: Program) {
  const current = await request.get(`${API_V1}/programs/current`);
  expect(current.status()).toBe(200);
  expect((await current.json()).sessions).toEqual(program.sessions);
  const database = await splitDatabaseSnapshot(request);
  const stored = database.find((row) => row.id === program.program_id);
  expect(stored).toBeDefined();
  expect(stored!.template).toEqual(program.sessions);
  expect(stored!.generationInput.split_preference_snapshot).toEqual(
    program.split_preference_snapshot,
  );
  // GET/current materializes the second week from the immutable template, without new generation.
  expect(stored!.sessions).toHaveLength(program.sessions.length * 2);
  const again = await request.get(`${API_V1}/programs/current`);
  expect(again.status()).toBe(200);
  expect(await splitDatabaseSnapshot(request)).toEqual(database);
  await test.info().attach("split-template-lazy-database", {
    body: JSON.stringify({ program, stored }, null, 2),
    contentType: "application/json",
  });
  return stored!;
}

function assertFocusPrimaryAndRecovery(stored: ObservedProgram) {
  const offsets: Record<string, number> = {
    MON: 0,
    TUE: 1,
    WED: 2,
    THU: 3,
    FRI: 4,
    SAT: 5,
    SUN: 6,
  };
  for (const slot of stored.template) {
    const session = stored.sessions.find(
      (row) => new Date(row.scheduledDate).getUTCDay() === (offsets[slot.day] + 1) % 7,
    );
    expect(session).toBeDefined();
    expect(session!.focus).toBe(slot.focus);
    const nonCore = session!.plannedSets.filter(
      (row) => row.exercise.modality === "resistance" && row.exercise.region !== "core",
    );
    expect(nonCore.length).toBeGreaterThanOrEqual(2);
    // The first non-core exercise is the primary, including isolation fallback (packer §4.4).
    const primary = nonCore[0];
    expect(primary.exercise.region).toBe(slot.focus);
    expect(
      nonCore.filter((row) => row.exerciseId === primary.exerciseId).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      slot.exercises.find((row) => row.exercise_id === primary.exerciseId)!.sets,
    ).toBeGreaterThanOrEqual(2);
  }
  for (const focus of ["upper", "lower"]) {
    const dates = stored.template
      .filter((slot) => slot.focus === focus)
      .map((slot) => offsets[slot.day]);
    for (let index = 0; index < dates.length; index++) {
      const next = index + 1 < dates.length ? dates[index + 1] : dates[0] + 7;
      expect(
        next - dates[index],
        `${focus} recovery including repeating week boundary`,
      ).toBeGreaterThanOrEqual(2);
    }
  }
}

test("profile_clear_then_generate_uses_balanced", async ({ page, request }) => {
  await profilePreference(page, "하체 우선");
  const beforeClear = await splitDatabaseSnapshot(request);
  await profilePreference(page, null);
  expect(
    await splitDatabaseSnapshot(request),
    "clearing the profile never rewrites older plans",
  ).toEqual(beforeClear);
  await onboardingDays(page, 5);
  await expect(page.getByRole("radio", { name: "선호 없음", exact: true })).toBeChecked();
  const { payload, program } = await finishOnboarding(page);
  expect(payload).not.toHaveProperty("split_preference");
  expect(program.split_preference_snapshot).toEqual({
    requested_preference: null,
    effective_preference: "balanced",
    applicable: true,
    reason: null,
    upper_days: 3,
    lower_days: 2,
  });
  expect(program.sessions.map(({ day, focus }) => [day, focus])).toEqual([
    ["MON", "upper"],
    ["TUE", "lower"],
    ["WED", "upper"],
    ["FRI", "lower"],
    ["SAT", "upper"],
  ]);
  assertFocusPrimaryAndRecovery(await persistedPlan(request, program));
});

test("five_day_lower_priority_persists_real_mixed_plan", async ({ page, request }) => {
  await profilePreference(page, "상체 우선");
  await onboardingDays(page, 5);
  await expect(page.getByRole("radio", { name: "상체 우선", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "하체 우선", exact: true }).check();
  const { payload, program } = await finishOnboarding(page);
  expect(payload.split_preference).toBe("lower_priority");
  expect((await (await request.get(`${API_V1}/me`)).json()).split_preference).toBe(
    "lower_priority",
  );
  expect(program.split_preference_snapshot).toEqual({
    requested_preference: "lower_priority",
    effective_preference: "lower_priority",
    applicable: true,
    reason: null,
    upper_days: 2,
    lower_days: 3,
  });
  expect(program.sessions.map(({ day, focus }) => [day, focus])).toEqual([
    ["MON", "lower"],
    ["TUE", "upper"],
    ["WED", "lower"],
    ["FRI", "upper"],
    ["SAT", "lower"],
  ]);
  const stored = await persistedPlan(request, program);
  assertFocusPrimaryAndRecovery(stored);
  const donor = program.sessions
    .flatMap((slot) => slot.exercises)
    .map(parseCardioSnapshot)
    .filter(Boolean);
  expect(donor).toHaveLength(1);
  expect(donor[0]).toMatchObject({ source_day: "SAT", source_ordinal: 5 });
  await page.reload();
  await expect(page.getByTestId("cardio-prescription")).toHaveCount(1);
  const beforeEdit = await splitDatabaseSnapshot(request);
  await profilePreference(page, "상체 우선");
  expect(
    await splitDatabaseSnapshot(request),
    "profile edit does not retroactively overwrite requested/effective snapshot",
  ).toEqual(beforeEdit);
});

test("four_day_priority_rejects_without_write", async ({ page, request }) => {
  await profilePreference(page, "하체 우선");
  const submitted: unknown[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && outgoing.url().endsWith("/programs/generate"))
      submitted.push(outgoing.postDataJSON());
  });
  await onboardingDays(page, 4);
  await expect(page.getByRole("radio", { name: "상체 우선", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "하체 우선", exact: true })).toBeDisabled();
  await expect(
    page.getByText("주 4일은 상체 2일·하체 2일로 균형 있게 배치해요.", { exact: true }),
  ).toBeVisible();
  await onboardingReview(page);
  await expect(page.getByRole("button", { name: "계획 만들기", exact: true })).toBeDisabled();
  expect(submitted).toEqual([]);
  const before = await splitDatabaseSnapshot(request);
  for (const preference of ["upper_priority", "lower_priority", null]) {
    const response = await request.post(`${API_V1}/programs/generate`, {
      headers: { "X-CSRF-Token": "dev" },
      data: { ...generateInput, split_preference: preference },
    });
    expect(response.status()).toBe(400);
    expect(
      await splitDatabaseSnapshot(request),
      "400 leaves every Program/template/session/planned identity unchanged",
    ).toEqual(before);
  }
  // Real catalogue safety and frozen diet/4d/30m T boundary: never install a precomputed donor.
  for (const [patch, status, reason] of [
    [{ equipment: ["machine"] }, 400, null],
    [{ equipment: ["stationary_bike"] }, 400, null],
    [{ goal: "diet", minutes_per_day: 30 }, 409, "insufficient_time_for_mixed_focus"],
  ] as const) {
    const response = await request.post(`${API_V1}/programs/generate`, {
      headers: { "X-CSRF-Token": "dev" },
      data: { ...generateInput, ...patch, split_preference: "balanced" },
    });
    expect(response.status()).toBe(status);
    if (reason) expect((await response.json()).error.details.reason).toBe(reason);
    expect(await splitDatabaseSnapshot(request)).toEqual(before);
  }
  for (const step of [6, 5, 4, 3]) {
    await page.getByRole("button", { name: "이전", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#step-${step}$`));
  }
  await page.getByRole("radio", { name: "균형 있게", exact: true }).check();
  const { payload, program } = await finishOnboarding(page, true);
  expect(submitted).toHaveLength(1);
  expect(payload.split_preference).toBe("balanced");
  expect(program.split_preference_snapshot).toEqual({
    requested_preference: "balanced",
    effective_preference: "balanced",
    applicable: true,
    reason: "four_day_balanced_only",
    upper_days: 2,
    lower_days: 2,
  });
  expect(program.sessions.map(({ day, focus }) => [day, focus])).toEqual([
    ["MON", "upper"],
    ["TUE", "lower"],
    ["THU", "upper"],
    ["FRI", "lower"],
  ]);
  assertFocusPrimaryAndRecovery(await persistedPlan(request, program));
});

test("mixed_cardio_survives_lazy_reload_and_offline_read", async ({
  page,
  request,
  context,
  browserName,
}) => {
  await profilePreference(page, "하체 우선");
  await onboardingDays(page, 5);
  await expect(page.getByRole("radio", { name: "하체 우선", exact: true })).toBeChecked();
  const { program } = await finishOnboarding(page);
  const stored = await persistedPlan(request, program);
  const slot = program.sessions.find((candidate) =>
    candidate.exercises.some((item) => parseCardioSnapshot(item)),
  );
  expect(slot).toBeDefined();
  const source = slot!.exercises.map(parseCardioSnapshot).filter(Boolean);
  // Pick the lazy second-week Saturday, not the eager first-week rows.
  const session = stored.sessions
    .filter((row) => new Date(row.scheduledDate).getUTCDay() === 6)
    .at(-1)!;
  expect(session).toBeDefined();
  const storedCardio = session.plannedSets.filter(
    (row) => row.prescriptionKind === "steady_cardio" || row.prescriptionKind === "interval_cardio",
  );
  expect(storedCardio).toHaveLength(source.length);
  expect(
    storedCardio.map((row) =>
      parseCardioSnapshot({
        prescription_kind: row.prescriptionKind,
        duration_sec: row.durationSec,
        target_rpe_low: row.targetRpeLow,
        target_rpe_high: row.targetRpeHigh,
        rpe_scale_id: row.rpeScaleId,
        rounds: row.rounds,
        work_sec: row.workSec,
        recovery_sec: row.recoverySec,
        recovery_rpe_low: row.recoveryRpeLow,
        recovery_rpe_high: row.recoveryRpeHigh,
        final_recovery_included: row.finalRecoveryIncluded,
        long_session_flag: row.longSessionFlag,
        progression_axis: row.progressionAxis,
        source_day: row.sourceDay,
        source_ordinal: row.sourceOrdinal,
        intensity_seconds: row.intensitySeconds,
        cardio_fallback: row.cardioFallback,
      }),
    ),
  ).toEqual(source);
  const response = await request.get(`${API_V1}/sessions/${session.id}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).planned_sets.map(parseCardioSnapshot).filter(Boolean)).toEqual(
    source,
  );
  await page.goto(`/session/${session.id}`);
  const card = page.getByTestId("cardio-prescription");
  await expect(card).toBeVisible();
  await expect(card.locator("input,button")).toHaveCount(0);
  const onlineText = await card.innerText();
  await page.reload();
  await expect(card).toBeVisible();
  expect(await card.innerText()).toBe(onlineText);
  await context.setOffline(true);
  // Existing 09:178 WebKit boundary: reuse the approved fresh-page API-offline helper,
  // with document transport only, no registered/controller SW and zero successful API responses.
  if (browserName === "webkit") {
    await page.evaluate(async () => {
      await Promise.all(
        (await navigator.serviceWorker.getRegistrations()).map((registration) =>
          registration.unregister(),
        ),
      );
    });
    expect((await readRelaunchState(page, session.id)).serviceWorker.registrations).toEqual([]);
    await page.close();
    const { resumed, blockedApi, successfulApi } = await openApiOfflinePage(context);
    try {
      await resumed.goto(`/session/${session.id}`);
      await expect
        .poll(() => blockedApi)
        .toContainEqual({ method: "GET", url: `${API_V1}/sessions/${session.id}` });
      await expect(resumed.getByTestId("cardio-prescription")).toBeVisible();
      expect(await resumed.getByTestId("cardio-prescription").innerText()).toBe(onlineText);
      const restored = await readRelaunchState(resumed, session.id);
      expect(restored.sessions).toHaveLength(1);
      const mirrored = restored.sessions[0].session as { planned_sets: unknown[] };
      expect(mirrored.planned_sets.map(parseCardioSnapshot).filter(Boolean)).toEqual(source);
      expect(restored.serviceWorker.registrations).toEqual([]);
      expect(restored.serviceWorker.controller).toBeNull();
      expect(successfulApi).toEqual([]);
      await test.info().attach("split-cardio-offline-exact", {
        body: JSON.stringify({ source, restored, blockedApi, successfulApi }, null, 2),
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
    const restored = await readRelaunchState(page, session.id);
    expect(restored.sessions).toHaveLength(1);
    expect(
      (restored.sessions[0].session as { planned_sets: unknown[] }).planned_sets
        .map(parseCardioSnapshot)
        .filter(Boolean),
    ).toEqual(source);
    await context.setOffline(false);
  }
});
