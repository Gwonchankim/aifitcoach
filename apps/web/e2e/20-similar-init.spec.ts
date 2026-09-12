import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext } from "@playwright/test";
import type { Session } from "../lib/api";
import { expect, test } from "./fixtures";
import { API_V1, openSession, seedProgram, todaySession } from "./helpers";
import { TEST_NOW } from "./test-today";

const headers = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };
const source = "e_bench_press";
const target = "e_incline_bench_press";

async function session(request: APIRequestContext, id: string): Promise<Session> {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  expect(response.status()).toBe(200);
  return response.json();
}

// Real endpoint setup: record performed facts, never inject recommendation output.
test("참고값 → 실제 수행 → 다음 세션 실측 추천", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const catalog: { id: string; name_ko: string; step_kg: number | null }[] = [];
  let cursor: string | undefined;
  do {
    const response = await request.get(`${API_V1}/exercises`, { params: cursor ? { cursor } : {} });
    expect(response.status()).toBe(200);
    const body = await response.json();
    catalog.push(...body.items);
    cursor = body.next_cursor;
  } while (cursor);
  const only = async (exerciseId: string) => {
    await seedProgram(request, {
      goal: "hypertrophy",
      days_per_week: 3,
      minutes_per_day: 30,
      pain_areas: [],
      avoid_exercises: catalog.filter((e) => e.id !== exerciseId).map((e) => e.id),
    });
    return session(request, await todaySession(request));
  };
  const first = await only(source);
  const sourceSets = first.planned_sets.filter((s) => s.exercise_id === source);
  expect(sourceSets).toHaveLength(3);
  expect(sourceSets[0].recommendation_gate).toBe("no_history");
  const recorded = await request.post(`${API_V1}/sync`, {
    headers,
    data: {
      mutations: sourceSets.map((set) => ({
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: set.id,
        op: "upsert",
        updated_at: TEST_NOW,
        payload: { actual_weight: 60, actual_reps: 10, actual_rir: 2, completed: true },
      })),
    },
  });
  expect(recorded.status()).toBe(200);
  const completed = await request.post(`${API_V1}/sessions/${first.id}/complete`, {
    headers,
    data: {},
  });
  expect(completed.status()).toBe(200);
  for (const set of (await session(request, first.id)).planned_sets) {
    expect(set.performed_set).toMatchObject({
      actual_weight: 60,
      actual_reps: 10,
      actual_rir: 2,
      completed: true,
    });
  }

  const second = await only(target);
  const sets = second.planned_sets.filter((s) => s.exercise_id === target);
  expect(sets).toHaveLength(3);
  expect([sets[0].target_reps_low, sets[0].target_reps_high, sets[0].target_rir]).toEqual([
    6, 12, 2,
  ]);
  const step = catalog.find((e) => e.id === target)!.step_kg;
  expect(step).toBe(2.5);
  // Independent arithmetic from exact performed facts and asserted generated target.
  const e1rm = 60 * (1 + (10 + 2) / 30);
  const weight = Math.floor(((e1rm * 0.8) / (1 + (12 + 2) / 30) + 1e-9) / step!) * step!;
  expect(weight).toBe(45);
  for (const set of sets)
    expect(set).toMatchObject({
      recommended_weight: weight,
      recommended_reps: 6,
      reason_code: "SIMILAR_INIT",
      recommendation_state: "ready",
      recommendation_gate: "no_history",
      confidence: null,
    });
  const name = catalog.find((e) => e.id === target)!.name_ko;
  await openSession(page, second.id);
  const card = page.getByRole("heading", { name, exact: true }).locator("xpath=../..");
  await expect(card.getByLabel("유사 운동 기록 기반 참고값")).toHaveText("참고값");
  await expect(card.getByLabel("유사 운동 기록 기반 참고값")).toHaveCount(1);
  await expect(
    card.getByText("비슷한 종목 기록으로 잡은 참고값이에요", { exact: true }),
  ).toBeVisible();
  const helper = card.locator("p").filter({
    hasText: "비슷한 종목 기록으로 잡은 값이에요. 다음 세션부터 실제 기록으로 조정돼요.",
  });
  await expect(helper).toHaveCount(1);
  await expect(helper).toBeVisible();
  await expect(card.getByRole("button", { name: "참고값으로 시작" })).toHaveCount(0);
  await expect(
    card.getByText(catalog.find((e) => e.id === source)!.name_ko, { exact: true }),
  ).toHaveCount(0);
  for (const set of sets) {
    await expect(page.getByLabel(`${name} ${set.set_no}세트 무게, 킬로그램`)).toHaveValue("45");
    await expect(page.getByLabel(`${name} ${set.set_no}세트 횟수, 회`)).toHaveValue("6");
  }
  const axe = await new AxeBuilder({ page }).analyze();
  await testInfo.attach("similar-init-axe", {
    body: JSON.stringify(axe),
    contentType: "application/json",
  });
  expect(axe.violations).toEqual([]);
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  const rowHeight = (await card.getByRole("listitem").first().boundingBox())!.height;
  expect(rowHeight).toBeLessThanOrEqual(96);
  await testInfo.attach("similar-init-density", {
    body: JSON.stringify({
      ...dimensions,
      rowHeight,
      cardHeight: (await card.boundingBox())!.height,
    }),
    contentType: "application/json",
  });
  await testInfo.attach("similar-init-card", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  for (const set of sets) {
    await page.getByLabel(`${name} ${set.set_no}세트 남은 반복 수(RIR), 0~6, 선택 입력`).fill("2");
    await page.getByRole("button", { name: `${name} ${set.set_no}세트 완료 처리` }).click();
    const timer = page.getByRole("dialog", {
      name: new RegExp(`${name} ${set.set_no}세트 후 휴식`),
    });
    await expect(timer).toBeVisible();
    await timer.getByRole("button", { name: "휴식 종료" }).click();
    await expect(timer).toBeHidden();
  }
  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료$/ })
    .click();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  for (const set of (await session(request, second.id)).planned_sets)
    expect(set.performed_set).toMatchObject({
      actual_weight: 45,
      actual_reps: 6,
      actual_rir: 2,
      completed: true,
    });
  const third = await only(target);
  for (const set of third.planned_sets) {
    expect(set.reason_code).not.toBe("SIMILAR_INIT");
    expect(set).toMatchObject({
      reason_code: "ADD_ONE_REP",
      recommended_weight: 45,
      recommended_reps: 7,
    });
  }
  await openSession(page, third.id);
  await expect(page.getByLabel("유사 운동 기록 기반 참고값")).toHaveCount(0);
  await expect(page.getByLabel(`${name} 1세트 횟수, 회`)).toHaveValue("7");
});
