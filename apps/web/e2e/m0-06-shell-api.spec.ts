import { randomUUID } from "node:crypto";
import type { Page, Response } from "@playwright/test";
import { test, expect } from "./fixtures";
import { API_V1, WEB_ORIGIN } from "./helpers";
import { TEST_TODAY } from "./test-today";
import { classifyConsole, profileFromEnv } from "../../../scripts/ci-e2e.manifest.mjs";

const profile = profileFromEnv(process.env);
const base = new URL(profile.apiBase, WEB_ORIGIN).href;
const endpoint = (suffix: string) => `${base}${suffix}`;

function observe(page: Page) {
  const runtime: string[] = [];
  const errors: { url: string; text: string }[] = [];
  const responses: { url: string; method: string; status: number }[] = [];
  page.on("pageerror", (error) => runtime.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push({ url: message.location().url, text: message.text() });
  });
  page.on("response", (response) =>
    responses.push({
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    }),
  );
  return async (expectedUrls: string[]) => {
    expect(runtime, "pageerror/unhandled runtime").toEqual([]);
    const result = classifyConsole(errors, responses, expectedUrls);
    expect(result.unexpected, "unattributable/500/runtime console error").toBe(0);
    await test.info().attach("m0-network-diagnostics", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
  };
}
function waitApi(page: Page, path: string) {
  return page.waitForResponse((r) => r.url() === endpoint(path) && r.request().method() === "GET");
}
async function notFound(response: Response) {
  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(typeof body.error.message).toBe("string");
}
function dashboard(body: Record<string, unknown>) {
  for (const key of [
    "date",
    "today",
    "tomorrow",
    "streak_days",
    "weekly_completion_rate",
    "weekly_rhythm",
    "primary_e1rm",
  ])
    expect(body).toHaveProperty(key);
  expect(body.date).toBe(TEST_TODAY);
  expect(body.today).toEqual({
    status: "rest",
    session_id: null,
    routine_summary: null,
    done_summary: null,
  });
  expect(body.tomorrow).toEqual({ status: "rest", routine_summary: null });
  expect(body.streak_days).toBe(0);
  expect(body.weekly_completion_rate).toBe(0);
  expect(body.weekly_rhythm).toEqual([]);
  expect(body.primary_e1rm).toBeNull();
}

// Both modes are statically declared: discovery never depends on a run's selected mode.
for (const mode of ["direct", "proxy"] as const) {
  test.describe(`M0-06 ${mode}`, () => {
    test.beforeEach(() => {
      expect(profile.mode).toBe(mode);
      expect(API_V1).toBe(`${profile.apiTarget}/v1`);
      expect(WEB_ORIGIN).toBe(profile.webOrigin);
      expect(process.env.E2E_DEV_USER_ID).toMatch(/^[0-9a-f-]{36}$/i);
    });

    test("shell consumes real API contract", async ({ page, request }) => {
      const finish = observe(page);
      const me = waitApi(page, "/me");
      const summary = waitApi(page, "/dashboard");
      await page.goto("/");
      const response = await me;
      expect(response.status()).toBe(200);
      expect((await response.json()).id).toBe(process.env.E2E_DEV_USER_ID);
      const direct = await request.get(`${API_V1}/me`);
      expect(direct.status()).toBe(200);
      expect((await direct.json()).id).toBe(process.env.E2E_DEV_USER_ID);
      const realDashboard = await summary;
      expect(realDashboard.status()).toBe(200);
      dashboard(await realDashboard.json());
      expect(new URL(response.url()).origin).toBe(
        mode === "proxy" ? WEB_ORIGIN : profile.apiTarget,
      );
      await expect(page.getByRole("heading", { name: "오늘", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "주요 탐색" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "아직 운동 계획이 없어요", exact: true }),
      ).toBeVisible();
      await finish([endpoint("/programs/current")]);
    });

    test("fresh principal renders empty program", async ({ page }) => {
      const finish = observe(page);
      const current = waitApi(page, "/programs/current");
      const summary = waitApi(page, "/dashboard");
      await page.goto("/");
      await notFound(await current);
      const response = await summary;
      expect(response.status()).toBe(200);
      dashboard(await response.json());
      await expect(
        page.getByRole("heading", { name: "아직 운동 계획이 없어요", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "계획 만들기", exact: true }).click();
      await expect(page).toHaveURL(`${WEB_ORIGIN}/onboarding`);
      await finish([endpoint("/programs/current")]);
    });

    test("real missing session renders recoverable error", async ({ page }) => {
      const finish = observe(page);
      const path = `/sessions/${randomUUID()}`;
      const missing = waitApi(page, path);
      await page.goto(`/session/${path.split("/").at(-1)}`);
      await notFound(await missing);
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "오늘 운동을 찾을 수 없어요. 대시보드에서 다시 시작해 주세요." }),
      ).toBeVisible();
      const retry = waitApi(page, path);
      await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
      await notFound(await retry);
      await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible();
      expect(await page.locator("body").innerText()).not.toMatch(
        /NOT_FOUND|postgresql:|stack|Cannot GET/,
      );
      await finish([endpoint(path)]);
    });
  });
}
