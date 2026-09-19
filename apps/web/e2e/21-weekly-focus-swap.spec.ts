import { test, expect } from "./fixtures";
import { API_V1 } from "./helpers";
import { prepareWeekSwap } from "./support/weekly-swap-setup";

test("current week CTA swaps actual dates and converges session/dashboard after reload", async ({
  page,
  request,
}) => {
  await prepareWeekSwap(request);
  const program = await (await request.get(`${API_V1}/programs/current`)).json();
  const before = await (
    await request.get(`${API_V1}/programs/${program.program_id}/weeks/current`)
  ).json();
  const candidates = await (
    await request.get(`${API_V1}/programs/${program.program_id}/week-swaps/candidates`)
  ).json();
  const target = candidates.candidates.find((item: { eligible: boolean }) => item.eligible);
  expect(target, "fixture must offer a recovery-safe future candidate").toBeTruthy();
  await page.goto("/program");
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "이번 주 일정 바꾸기" });
  await expect(sheet.getByRole("radio", { name: "두 운동일 교환", exact: true })).toBeChecked();
  await sheet.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await sheet.getByRole("button", { name: "교환하기", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${target.session.id}$`));
  const after = await (
    await request.get(`${API_V1}/programs/${program.program_id}/weeks/current`)
  ).json();
  expect(after.sessions.map((row: { id: string }) => row.id).sort()).toEqual(
    before.sessions.map((row: { id: string }) => row.id).sort(),
  );
  await page.goto("/");
  await expect(page.locator(`a[href='/session/${target.session.id}']`).first()).toBeVisible();
  await page.reload();
  await expect(page.locator(`a[href='/session/${target.session.id}']`).first()).toBeVisible();
});

test("closing preserves focus, mode resets, and offline never submits a swap", async ({
  page,
  request,
  context,
}) => {
  await prepareWeekSwap(request);
  let posts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/week-swaps$/.test(new URL(req.url()).pathname)) posts++;
  });
  await page.goto("/program");
  const opener = page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true });
  await opener.click();
  await page.getByRole("radio", { name: "오늘만 운동 바꾸기", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole("radio", { name: "두 운동일 교환", exact: true })).toBeChecked();
  await context.setOffline(true);
  await expect(
    page.getByText(
      "인터넷이 연결된 뒤에 일정을 바꿀 수 있어요. 연결 후 후보를 다시 확인해 주세요.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "일정 다시 확인" })).toBeDisabled();
  expect(posts).toBe(0);
  await context.setOffline(false);
});

test("lost successful POST survives reload and result check uses the exact client_id and body", async ({
  page,
  request,
}) => {
  await prepareWeekSwap(request);
  const program = await (await request.get(`${API_V1}/programs/current`)).json();
  const candidates = await (
    await request.get(`${API_V1}/programs/${program.program_id}/week-swaps/candidates`)
  ).json();
  const target = candidates.candidates.find((item: { eligible: boolean }) => item.eligible);
  expect(target, JSON.stringify(candidates)).toBeTruthy();
  const bodies: unknown[] = [];
  await page.route("**/v1/programs/*/week-swaps", async (route) => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (bodies.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.goto("/program");
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await page.getByRole("button", { name: "교환하기", exact: true }).click();
  await expect(page.getByRole("button", { name: "결과 확인", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await expect(page.getByRole("button", { name: "결과 확인", exact: true })).toBeVisible();
  expect(bodies).toHaveLength(1);
  await page.getByRole("button", { name: "결과 확인", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${target.session.id}$`));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
});

test("unknown candidate reason fails closed without falling into one-off", async ({
  page,
  request,
}) => {
  await prepareWeekSwap(request);
  let posts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/week-swaps$/.test(new URL(req.url()).pathname)) posts++;
  });
  await page.route("**/v1/programs/*/week-swaps/candidates", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.today_eligible = false;
    body.today_reason = "append_limit";
    await route.fulfill({ response, json: body });
  });
  await page.goto("/program");
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await expect(
    page.getByText("교환할 수 없는 사유를 확인하지 못했어요. 최신 일정을 다시 확인해 주세요."),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "두 운동일 교환", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "교환하기", exact: true })).toHaveCount(0);
  expect(posts).toBe(0);
});

test("a held pre-swap current-week GET cannot restore old dates in program DOM or durable mirror", async ({
  page,
  request,
}) => {
  await prepareWeekSwap(request);
  const program = await (await request.get(`${API_V1}/programs/current`)).json();
  const candidates = await (
    await request.get(`${API_V1}/programs/${program.program_id}/week-swaps/candidates`)
  ).json();
  const target = candidates.candidates.find((item: { eligible: boolean }) => item.eligible);
  expect(target, JSON.stringify(candidates)).toBeTruthy();
  await page.goto("/program");
  await expect(page.locator(`[data-week-session-id='${target.session.id}']`)).toBeVisible();
  let release!: () => void;
  let captured!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let count = 0;
  await page.route("**/v1/programs/*/weeks/current", async (route) => {
    const response = await route.fetch();
    if (++count === 1) {
      captured();
      await holding;
    }
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await capture;
  await page.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await page.getByRole("button", { name: "교환하기", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${target.session.id}$`));
  release();
  await page.goto("/program");
  const latest = await (
    await request.get(`${API_V1}/programs/${program.program_id}/weeks/current`)
  ).json();
  for (const session of latest.sessions)
    await expect(
      page.locator(
        `[data-week-date='${session.scheduled_date}'] [data-week-session-id='${session.id}']`,
      ),
    ).toBeVisible();
  const mirrored = await page.evaluate(async (id) => {
    const opening = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
      opening.onupgradeneeded = () => {
        opening.transaction?.abort();
        reject(new Error("existing DB required"));
      };
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const get = db
          .transaction("readModels")
          .objectStore("readModels")
          .get(["dev-user", `current-week:${id}`]);
        get.onsuccess = () => resolve(get.result.data);
        get.onerror = () => reject(get.error);
      });
    } finally {
      db.close();
    }
  }, program.program_id);
  expect(mirrored).toEqual(latest);
});

test("a saved local draft disables swap without deleting records or entering one-off", async ({
  page,
  request,
}) => {
  await prepareWeekSwap(request);
  const program = await (await request.get(`${API_V1}/programs/current`)).json();
  const candidates = await (
    await request.get(`${API_V1}/programs/${program.program_id}/week-swaps/candidates`)
  ).json();
  const target = candidates.candidates.find((item: { eligible: boolean }) => item.eligible);
  expect(target, JSON.stringify(candidates)).toBeTruthy();
  await page.goto("/program");
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await page.evaluate(async (id) => {
    const opening = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
      opening.onupgradeneeded = () => {
        opening.transaction?.abort();
        reject(new Error("existing owned test DB required"));
      };
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore("drafts").put({
          user_id: "dev-user",
          session_id: id,
          planned_set_id: "local-swap-test-draft",
          client_id: "local-swap-test-intent",
          actual_weight: 20,
          actual_reps: 8,
          actual_rir: 2,
          actual_time_sec: null,
          pain_score: null,
          completed: false,
          updated_at: new Date().toISOString(),
        });
      });
    } finally {
      db.close();
    }
  }, candidates.today_session_id);
  // Native fixture writes bypass Dexie live-query caching. Reload the document to read the durable draft.
  await page.reload();
  await page.getByRole("button", { name: "이번 주 일정 바꾸기", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(target.session.scheduled_date) }).check();
  await expect(
    page.getByText(
      "아직 반영되지 않은 운동 기록이나 변경이 있어요. 반영 상태를 확인한 뒤 다시 시도해 주세요.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "교환하기", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "두 운동일 교환", exact: true })).toBeChecked();
  const actual = await (
    await request.get(`${API_V1}/programs/${program.program_id}/week-swaps/candidates`)
  ).json();
  expect(actual.today_session_id).toBe(candidates.today_session_id);
  const savedDraft = await page.evaluate(async (id) => {
    const opening = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
      opening.onupgradeneeded = () => {
        opening.transaction?.abort();
        reject(new Error("existing owned test DB required"));
      };
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const get = db
          .transaction("drafts")
          .objectStore("drafts")
          .get(["dev-user", id, "local-swap-test-draft"]);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
    } finally {
      db.close();
    }
  }, candidates.today_session_id);
  expect(savedDraft).toMatchObject({
    session_id: candidates.today_session_id,
    planned_set_id: "local-swap-test-draft",
    actual_weight: 20,
    actual_reps: 8,
    completed: false,
  });
});
