/**
 * STEP 6 loss-zero browser contract.  These scenarios deliberately use the real API and
 * the browser's IndexedDB; setup creates only planned sets through public APIs.
 */
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, openSession, seedExternalLoadProgram, todaySession } from "./helpers";

test.describe.configure({ mode: "serial" });

type Dashboard = {
  today: { done_summary: { sets_completed: number; total_volume: number } | null };
};

async function firstExercise(page: Page): Promise<string> {
  const label = await page
    .getByRole("button", { name: /1세트 완료 처리$/ })
    .first()
    .getAttribute("aria-label");
  expect(label).toMatch(/ 1세트 완료 처리$/);
  return label!.replace(/ 1세트 완료 처리$/, "");
}

async function warmOfflineShell(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        }),
      );
    }
  });
}

async function completeWeightedSet(
  page: Page,
  name: string,
  setNo: number,
  weight: number,
  reps: number,
) {
  const weightInput = page.getByLabel(`${name} ${setNo}세트 무게, 킬로그램`);
  const repsInput = page.getByLabel(`${name} ${setNo}세트 횟수, 회`);
  await weightInput.fill(String(weight));
  await expect(weightInput).toHaveValue(String(weight));
  await repsInput.fill(String(reps));
  await expect(repsInput).toHaveValue(String(reps));
  await expect(weightInput).toHaveValue(String(weight));
  await page.getByRole("button", { name: `${name} ${setNo}세트 완료 처리` }).click();
  const rest = page.getByRole("dialog", { name: new RegExp(`${name} ${setNo}세트 후 휴식`) });
  await expect(rest).toBeVisible();
  await rest.getByRole("button", { name: "휴식 종료" }).click();
  // **닫힌 것을 확인하고 넘어간다.** 화면이 닫혔다는 것은 저장분도 지워졌다는 뜻이다 —
  // 그 전에 다음 세트로 넘어가면, 새로고침 때 되살아난 타이머가 오버레이로 화면을 가린다.
  await expect(rest).toBeHidden();
}

async function finish(page: Page) {
  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료$/ })
    .click();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
}

async function assertAuthoritativeSummary(
  request: APIRequestContext,
  sets: number,
  volume: number,
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API_V1}/dashboard`);
        expect(response.status()).toBe(200);
        const dashboard = (await response.json()) as Dashboard;
        const summary = dashboard.today.done_summary;
        return summary ? `${summary.sets_completed}/${summary.total_volume}` : "pending";
      },
      { timeout: 25_000 },
    )
    .toBe(`${sets}/${volume}`);
}

test("loss 0: offline add/swap/immediate logging survives reload and a closed tab, then syncs exactly", async ({
  page,
  context,
  request,
  browserName,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  await warmOfflineShell(page);
  // The controlled online navigation warms the real session route; the later reload must not need
  // a network response for either the shell or the mirrored session data.
  await page.reload();
  const name = await firstExercise(page);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${name} [123]세트 완료 처리$`) }),
  ).toHaveCount(3);

  await context.setOffline(true);
  // Offline routine editing is a normal path: add, replace, then record the replacement before
  // any mapping response can arrive. The server must apply both routine snapshots first and map
  // only the surviving provisional sets before the performed mutation.
  await page.getByRole("button", { name: "운동 추가" }).click();
  const addPicker = page.getByRole("dialog", { name: "운동 추가" });
  await addPicker.getByRole("tab", { name: "팔" }).click();
  await addPicker.getByRole("button", { name: /^바벨 컬/ }).click();
  await expect(page.getByRole("heading", { name: "바벨 컬", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "바벨 컬 메뉴" }).click();
  await page.getByRole("menuitem", { name: "바벨 컬 교체" }).click();
  const swapPicker = page.getByRole("dialog", { name: "바벨 컬 교체" });
  await swapPicker.getByRole("button", { name: /^덤벨 컬/ }).click();
  await expect(page.getByRole("heading", { name: "덤벨 컬", exact: true })).toBeVisible();
  await completeWeightedSet(page, "덤벨 컬", 1, 40, 10);
  for (const setNo of [1, 2, 3]) await completeWeightedSet(page, name, setNo, 50, 10);
  // Playwright WebKit itself raises an internal error for offline page.reload(). Chromium
  // owns that exact reload contract; WebKit takes the stronger process-boundary path below.
  if (browserName === "chromium") {
    await page.reload();
    for (const setNo of [1, 2, 3]) {
      await expect(
        page.getByRole("button", { name: `${name} ${setNo}세트 완료 취소` }),
      ).toBeVisible();
    }
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "덤벨 컬 1세트 완료 취소" })).toBeVisible();
  }
  // A fresh tab in the same installed origin models a tab/app process being closed after
  // the IndexedDB commit. It must recover from the cached route without the old JS heap.
  if (browserName === "webkit") {
    // Playwright WebKit cannot navigate a fresh page while the whole context is offline. Remove
    // the worker while this page is still isolated, then reopen with document transport enabled
    // and API transport blocked. With no page alive during the transition, no coordinator can
    // drain the outbox between those two operations.
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    });
  }
  await page.close();
  if (browserName === "webkit") {
    await context.route("**/v1/**", (route) => route.abort("failed"));
    await context.setOffline(false);
  }
  const resumed = await context.newPage();
  await resumed.goto(`/session/${sessionId}`);
  await expect(resumed.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(resumed.getByRole("heading", { name: "덤벨 컬", exact: true })).toBeVisible();
  for (const setNo of [1, 2, 3]) {
    await expect(
      resumed.getByRole("button", { name: `${name} ${setNo}세트 완료 취소` }),
    ).toBeVisible();
  }
  await resumed
    .getByRole("button", { name: `${name} 1세트 기록, 50킬로그램 10회, 완료. 수정하려면 누르세요` })
    .click();
  await expect(resumed.getByLabel(`${name} 1세트 무게, 킬로그램`)).toHaveValue("50");
  await resumed
    .getByRole("button", {
      name: "덤벨 컬 1세트 기록, 40킬로그램 10회, 완료. 수정하려면 누르세요",
    })
    .click();
  await expect(resumed.getByLabel("덤벨 컬 1세트 무게, 킬로그램")).toHaveValue("40");

  if (browserName === "webkit") {
    await context.unroute("**/v1/**");
    // The new page started while API transport was failed. Reload after reconnect wakes a fresh
    // coordinator and is the online half of the WebKit relaunch contract.
    await resumed.reload();
    await expect(resumed.getByRole("heading", { name, exact: true })).toBeVisible();
  } else {
    await context.setOffline(false);
  }
  await resumed.bringToFront();
  await finish(resumed);
  await assertAuthoritativeSummary(request, 4, 1900);
});

/**
 * **닫은 휴식 타이머는 새로고침에서 되살아나지 않는다.**
 *
 * 삭제를 fire-and-forget 으로 두면 사용자가 커밋 전에 새로고침할 때 미완료 삭제가 프로세스와
 * 함께 사라지고, 닫았던 타이머가 다시 열려 기록 편집을 가린다. 독립 재리뷰가 이 경로를 실제
 * Chromium 에서 두 번 연속 재현했다. 여기서는 그 경계를 그대로 밟는다.
 */
test("@chromium-only 휴식을 닫고 곧바로 새로고침해도 타이머가 되살아나지 않는다", async ({
  page,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExercise(page);

  await completeWeightedSet(page, name, 1, 50, 10);
  // 닫자마자 — 지연이나 추가 조작 없이 — 새로고침한다.
  await page.reload();

  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  // 유령 타이머가 없어야 기록 편집을 열 수 있다.
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: `${name} 1세트 기록, 50킬로그램 10회, 완료. 수정하려면 누르세요` })
    .click();
  await expect(page.getByLabel(`${name} 1세트 무게, 킬로그램`)).toHaveValue("50");
});

/**
 * 완료 취소와 세션 종료도 같은 terminal intent 다 — 재진입에서 되살아나면 안 된다.
 */
test("@chromium-only 완료 취소 뒤 새로고침해도 그 세트 타이머가 없다", async ({
  page,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExercise(page);

  await completeWeightedSet(page, name, 1, 50, 10);
  await page.getByRole("button", { name: `${name} 1세트 완료 취소` }).click();
  await expect(page.getByRole("button", { name: `${name} 1세트 완료 처리` })).toBeVisible();
  await page.reload();

  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
});

test("@chromium-only a stale reconnect read cannot overwrite an applied routine mapping", async ({
  page,
  context,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const initialResponse = await request.get(`${API_V1}/sessions/${sessionId}`);
  const initialCount = ((await initialResponse.json()) as { planned_sets: unknown[] }).planned_sets
    .length;

  await context.setOffline(true);
  await page.getByRole("button", { name: "운동 추가" }).click();
  const picker = page.getByRole("dialog", { name: "운동 추가" });
  await picker.getByRole("tab", { name: "팔" }).click();
  await picker.getByRole("button", { name: /^바벨 컬/ }).click();
  await expect(page.getByRole("heading", { name: "바벨 컬", exact: true })).toBeVisible();
  await expect(page.getByText(`계획 ${initialCount + 3}세트`, { exact: false })).toBeVisible();
  await page.close();

  let captureStale!: () => void;
  const staleCaptured = new Promise<void>((resolve) => {
    captureStale = resolve;
  });
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let firstRead = true;
  await context.route(`**/v1/sessions/${sessionId}`, async (route) => {
    if (!firstRead) {
      await route.continue();
      return;
    }
    firstRead = false;
    const staleResponse = await route.fetch();
    captureStale();
    await staleGate;
    await route.fulfill({ response: staleResponse }).catch(() => undefined);
  });

  await context.setOffline(false);
  const resumed = await context.newPage();
  await resumed.goto(`/session/${sessionId}`);
  await staleCaptured;
  await expect
    .poll(async () => {
      const response = await request.get(`${API_V1}/sessions/${sessionId}`);
      return ((await response.json()) as { planned_sets: unknown[] }).planned_sets.length;
    })
    .toBe(initialCount + 3);
  releaseStale();

  await expect(resumed.getByText(`계획 ${initialCount + 3}세트`, { exact: false })).toBeVisible();
  await expect(resumed.getByRole("heading", { name: "바벨 컬", exact: true })).toBeVisible();
});

test("@chromium-only response loss retries one server-received mutation without a duplicate performed set", async ({
  page,
  context,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExercise(page);

  await context.setOffline(true);
  await completeWeightedSet(page, name, 1, 60, 8);

  let serverReceived = false;
  await context.route("**/v1/sync", async (route) => {
    await route.fetch(); // The API response proves the server applied this request before the client loses it.
    serverReceived = true;
    await route.abort("failed");
  });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => serverReceived, { timeout: 25_000 }).toBe(true);
  await context.unroute("**/v1/sync");

  await page.reload(); // foreground start retries the unchanged outbox mutation ID
  await finish(page);
  await assertAuthoritativeSummary(request, 1, 480);
});

test("@chromium-only a re-offline transport interruption preserves the outbox until exact eventual application", async ({
  page,
  context,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExercise(page);

  await context.setOffline(true);
  await completeWeightedSet(page, name, 1, 55, 9);

  let attempts = 0;
  await context.route("**/v1/sync", async (route) => {
    attempts += 1;
    await route.abort("failed");
  });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => attempts, { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
  await context.setOffline(true);
  await context.unroute("**/v1/sync");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.bringToFront();

  await finish(page);
  await assertAuthoritativeSummary(request, 1, 495);
});

test("@chromium-only pull creates a missing local draft and applies a later tombstone", async ({
  page,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  const session = (await (await request.get(`${API_V1}/sessions/${sessionId}`)).json()) as {
    planned_sets: { id: string }[];
  };
  const plannedSetId = session.planned_sets[0].id;
  await openSession(page, sessionId);
  const name = await firstExercise(page);

  const push = async (op: "upsert" | "delete", updatedAt: string) => {
    const response = await request.post(`${API_V1}/sync`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
      data: {
        mutations: [
          {
            client_id: randomUUID(),
            entity: "performed_set",
            entity_id: plannedSetId,
            op,
            updated_at: updatedAt,
            payload:
              op === "delete"
                ? {}
                : { actual_weight: 65, actual_reps: 8, actual_rir: 2, completed: true },
          },
        ],
      },
    });
    expect(response.status()).toBe(200);
  };

  await push("upsert", "2026-08-21T10:00:01.000Z");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: `${name} 1세트 완료 취소` })).toBeVisible();
  await page
    .getByRole("button", {
      name: `${name} 1세트 기록, 65킬로그램 8회, RIR 2, 완료. 수정하려면 누르세요`,
    })
    .click();
  await expect(page.getByLabel(`${name} 1세트 무게, 킬로그램`)).toHaveValue("65");

  await push("delete", "2026-08-21T10:00:02.000Z");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: `${name} 1세트 완료 처리` })).toBeVisible();
});

test("@chromium-only two tabs resolve the same planned set by later real-clock write and count it once", async ({
  page,
  context,
  request,
}) => {
  await seedExternalLoadProgram(request);
  const sessionId = await todaySession(request);
  const other = await context.newPage();
  await openSession(page, sessionId);
  await openSession(other, sessionId);
  const name = await firstExercise(page);

  await context.setOffline(true);
  await completeWeightedSet(page, name, 1, 50, 10);
  // fixtures resume the clock, so this changes Date.now rather than relying on tied timestamps.
  await page.waitForTimeout(25);
  await completeWeightedSet(other, name, 1, 70, 10);

  await context.setOffline(false);
  await other.evaluate(() => window.dispatchEvent(new Event("online")));
  await other.bringToFront();
  await finish(other);
  await assertAuthoritativeSummary(request, 1, 700);
});

/**
 * **실패 관측성 장치 — 상시 유지한다.**
 *
 * loss-0 은 이 앱의 핵심 계약이라 실패가 한 번 나면 그 실행의 로컬 상태를 반드시 봐야 한다.
 * 실제로 한 번 놓쳤다: WebKit 에서 간헐 실패가 났는데 다음 실행이 `.artifacts` 를 비워
 * trace 가 사라졌고, 그래서 draft 소실인지 ID 불일치인지 hydration timing 인지 가르지 못했다.
 *
 * **이것은 flake 은폐가 아니다.** 재시도하지도, 실패를 통과로 만들지도 않는다 —
 * 실패는 그대로 실패다. 실패했을 때 **무엇을 볼 수 있는지**만 늘린다.
 *
 * 비용 0 보장: `testInfo.status === "failed"` 일 때만 실행되므로 통과 경로에는 어떤 지연도 없다.
 * 지연을 넣으면 그 자체가 race 를 가려 버린다.
 *
 * 데이터 경계: 이 스위트는 **E2E 전용 synthetic 데이터**만 다룬다(공개 API 로 만든 계획 세트).
 * 그래도 담는 값은 손실 판정에 필요한 최소치로 제한한다 — 통증 점수·client id·쿠키·토큰은 넣지 않는다.
 */
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed" || page.isClosed()) return;
  const dump = await page
    .evaluate(async () => {
      const open = indexedDB.open("afc-session-v1");
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const read = (store: string) =>
        new Promise<Record<string, unknown>[]>((resolve) => {
          if (!db.objectStoreNames.contains(store)) return resolve([]);
          const request = db.transaction(store, "readonly").objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
          request.onerror = () => resolve([]);
        });
      const [drafts, outbox, sessions, syncMeta] = await Promise.all([
        read("drafts"),
        read("outbox"),
        read("sessions"),
        read("syncMeta"),
      ]);
      return {
        // ① draft row 가 남아 있는가(소실 여부)
        drafts: drafts.map((row) => ({
          session_id: row.session_id,
          planned_set_id: row.planned_set_id,
          actual_weight: row.actual_weight,
          completed: row.completed,
        })),
        outbox: outbox.map((row) => ({
          entity: row.entity,
          entity_id: row.entity_id,
          op: row.op,
        })),
        // ② 화면 행 id 와 draft 키가 같은가(ID 불일치 여부)
        sessions: sessions.map((row) => ({
          session_id: row.session_id,
          local_ids: row.local_ids ?? null,
          planned_set_ids: Array.isArray((row.session as { planned_sets?: unknown })?.planned_sets)
            ? (row.session as { planned_sets: Record<string, unknown>[] }).planned_sets.map(
                (set) => set.id,
              )
            : null,
        })),
        // ③ remediation marker/candidate 가 실제로 있었는가(durable completion 경로 실행 여부)
        syncMeta: syncMeta.map((row) => ({ key: row.key, value: row.value })),
        inputs: [...document.querySelectorAll("input[id$='-weight']")].map((node) => ({
          id: (node as HTMLInputElement).id,
          value: (node as HTMLInputElement).value,
          label: (node as HTMLInputElement).getAttribute("aria-label") ?? "",
        })),
      };
    })
    .catch((error) => ({ dumpError: String(error) }));
  await testInfo.attach("idb-dump.json", {
    body: JSON.stringify(dump, null, 2),
    contentType: "application/json",
  });
});
