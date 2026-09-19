import { createRequire } from "node:module";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect } from "../fixtures";
import { API_V1, seedProgram } from "../helpers";
type FixtureModule = typeof import("../../../api/test/support/week-swap-e2e-fixture");
export async function prepareWeekSwap(request: APIRequestContext) {
  const me = await request.get(`${API_V1}/me`);
  expect(me.status()).toBe(200);
  const owner = (await me.json()).id;
  expect(owner).toBe(process.env.E2E_DEV_USER_ID);
  const requireApi = createRequire(path.resolve(process.cwd(), "../api/package.json"));
  const fixture = requireApi("./test/support/week-swap-e2e-fixture.ts") as FixtureModule;
  await fixture.resetWeekSwapE2eOwner({ expectedOwnerId: owner });
  await seedProgram(request, { days_per_week: 6, pain_areas: [] });
}
