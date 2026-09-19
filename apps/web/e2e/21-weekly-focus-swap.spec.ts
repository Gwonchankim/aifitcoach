import { test, expect } from "./fixtures";
import { API_V1, seedProgram } from "./helpers";

test("current week CTA swaps actual dates and converges session/dashboard after reload", async ({ page, request }) => {
  await seedProgram(request, { days_per_week: 6, pain_areas: [] });
  const program = await (await request.get(`${API_V1}/programs/current`)).json();
  const before = await (await request.get(`${API_V1}/programs/${program.id}/weeks/current`)).json();
  const candidates = await (await request.get(`${API_V1}/programs/${program.id}/week-swaps/candidates`)).json();
  const target = candidates.candidates.find((item: { eligible: boolean }) => item.eligible);
  expect(target, "fixture must offer a recovery-safe future candidate").toBeTruthy();
  await page.goto("/program");
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "이번 주 일정 바꾸기" });
  await expect(sheet.getByRole("radio", { name: "두 운동일 교환", exact: true })).toBeChecked();
  await sheet.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await sheet.getByRole("button", { name: "교환하기", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${target.session.id}$`));
  const after = await (await request.get(`${API_V1}/programs/${program.id}/weeks/current`)).json();
  expect(after.sessions.map((row: { id: string }) => row.id).sort()).toEqual(before.sessions.map((row: { id: string }) => row.id).sort());
  await page.goto("/");
  await expect(page.locator(`a[href='/session/${target.session.id}']`).first()).toBeVisible();
  await page.reload();
  await expect(page.locator(`a[href='/session/${target.session.id}']`).first()).toBeVisible();
});
