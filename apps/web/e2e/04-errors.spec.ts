/**
 * 항목 4: 에러 경로에서 **사용자에게 실제로 뜨는 화면**을 확인한다.
 * 에러코드(`CONFLICT` 등)·영문 원문·서버 해라체 메시지가 노출되면 결함이다.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, openSession, seedProgram, shot, todaySession } from "./helpers";
import { TEST_TODAY } from "./test-today";

/** 화면 어디에도 개발자용 원문이 없어야 한다. */
async function assertNoRawServerText(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/VALIDATION_ERROR|NOT_FOUND|CONFLICT|INTERNAL_ERROR|NOT_IMPLEMENTED/);
  expect(body).not.toMatch(/e_[a-z_]+/);
  expect(body).not.toMatch(/must not be|must be one of|Cannot (GET|POST)/);
  // 서버 메시지는 해라체다("…없다.", "…이다."). 사용자 문구는 존댓말만 쓴다.
  expect(body).not.toMatch(/찾을 수 없다|포함된 운동입니다|운동이 없다/);
}

test.describe("404", () => {
  test("없는 세션 id 로 진입하면 안내 + [다시 불러오기] 가 보인다(E-6)", async ({ page }) => {
    await page.goto("/session/11111111-1111-4111-8111-111111111111");
    await expect(
      page.getByText("오늘 운동을 찾을 수 없어요. 대시보드에서 다시 시작해 주세요."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 불러오기" })).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "30-error-404-session");
  });

  test("계획이 없으면 /program 은 빈 상태로 안내한다(E-5)", async ({ page }) => {
    await page.route("**/v1/programs/current", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "NOT_FOUND", message: "생성된 프로그램이 없다." } }),
      }),
    );
    await page.goto("/program");
    await expect(page.getByText("아직 운동 계획이 없어요.")).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "31-error-404-program");
  });
});

test.describe("400", () => {
  test("EZ바만 골라 계획을 만들면 장비 안내 배너가 뜬다(E-3, 실제 클릭)", async ({ page }) => {
    await page.goto("/onboarding");
    for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "다음" }).click();

    // 6/7 장비: 기본 전체 선택 → EZ바만 남긴다
    await expect(
      page.getByRole("heading", { name: "쓸 수 있는 장비를 골라 주세요" }),
    ).toBeVisible();
    for (const label of ["바벨", "덤벨", "머신", "케이블", "맨몸"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
    }
    await page.getByRole("button", { name: "다음" }).click();
    await page.getByRole("button", { name: "계획 만들기" }).click();

    await expect(
      page.getByText("지금 고른 장비로는 계획을 만들기 어려워요. 장비를 하나 더 선택해 주세요."),
    ).toBeVisible();
    // 입력값이 보존되고 화면은 마지막 스텝에 머문다
    await expect(
      page.getByRole("heading", { name: "운동할 때 불편한 곳이 있나요?" }),
    ).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "32-error-400-generate");
  });
});

test.describe("409", () => {
  test.beforeEach(async ({ request }) => {
    await seedProgram(request);
  });

  test("이미 루틴에 있는 운동은 추가 팝업에서 선택 자체가 막힌다(§3.3 예방)", async ({
    page,
    request,
  }) => {
    const sessionId = await todaySession(request);
    await openSession(page, sessionId);

    const firstName = (
      (await page
        .getByRole("button", { name: /1세트 완료 처리$/ })
        .first()
        .getAttribute("aria-label")) ?? ""
    ).replace(/ 1세트 완료 처리$/, "");

    await page.getByRole("button", { name: "운동 추가" }).click();
    const picker = page.getByRole("dialog", { name: "운동 추가" });
    // 오늘 루틴에 있는 종목의 탭을 찾아 순회한다.
    for (const region of ["가슴", "등", "어깨", "팔", "하체", "코어"]) {
      await picker.getByRole("tab", { name: region }).click();
      const already = picker.getByRole("button", { name: new RegExp(firstName) });
      if ((await already.count()) > 0) {
        await expect(already.first()).toBeDisabled();
        await expect(picker.getByText("이미 루틴에 있어요").first()).toBeVisible();
        await shot(page, "33-conflict-prevented-duplicate");
        return;
      }
    }
    throw new Error("루틴에 있는 종목을 추가 팝업에서 찾지 못했다");
  });

  test("서버가 실제로 409 를 주면 팝업 안에 안내가 뜬다(중복 종목)", async ({ page, request }) => {
    const sessionId = await todaySession(request);

    await openSession(page, sessionId);

    // UI 가 막고 있으므로, outbox sync의 루틴 mutation만 서버 conflict로 응답한다.
    await page.route("**/v1/sync", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as {
        mutations: { client_id: string; entity: string; entity_id: string }[];
      };
      const routine = body.mutations.find((mutation) => mutation.entity === "session_routine");
      if (!routine) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          applied: [],
          conflicts: [
            { client_id: routine.client_id, entity_id: routine.entity_id, reason: "conflict" },
          ],
          changes: [],
          planned_set_mappings: [],
          next_cursor: "v1.test",
        }),
      });
    });

    await page.getByRole("button", { name: "운동 추가" }).click();
    const picker = page.getByRole("dialog", { name: "운동 추가" });
    await picker.getByRole("tab", { name: "코어" }).click();
    await picker.getByRole("button", { name: /플랭크/ }).click();

    await expect(picker.getByText("이미 오늘 루틴에 있는 운동이에요.")).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "34-conflict-409-duplicate");
  });

  /**
   * F6-1 이후 **당일** 세션은 종료돼도 편집이 열려 있다(서버도 200 을 준다).
   * 예전에는 이 상황을 409 로 막았다 — 그 문구가 다시 나오면 회귀다.
   */
  test("다른 곳에서 오늘 세션이 종료돼도 계속 편집할 수 있다(F6-1)", async ({ page, request }) => {
    const sessionId = await todaySession(request);
    await openSession(page, sessionId);

    // 화면을 띄운 뒤 서버에서 세션을 종료한다(다른 기기에서 종료한 상황).
    const done = await request.post(`${API_V1}/sessions/${sessionId}/complete`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
      data: {},
    });
    expect(done.status()).toBe(200);

    await page.getByRole("button", { name: "운동 추가" }).click();
    const picker = page.getByRole("dialog", { name: "운동 추가" });
    await picker.getByRole("tab", { name: "코어" }).click();
    await picker.getByRole("button", { name: /플랭크/ }).click();

    await expect(picker).toBeHidden();
    await expect(page.getByRole("heading", { name: "플랭크" })).toBeVisible();
    await expect(page.getByText("지난 운동 기록은 바꿀 수 없어요.", { exact: false })).toHaveCount(
      0,
    );
    // 종료한 운동을 고치는 중이라는 맥락이 화면에 남는다.
    await expect(
      page.getByText("이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요."),
    ).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "35-same-day-edit-after-remote-complete");
  });

  /**
   * 반대쪽: **다른 날짜**의 종료된 세션은 읽기 전용이다(서버가 409 로 막는 구간).
   * 지난 세션 id 를 얻을 계약 경로가 없어(대시보드는 오늘만 준다) 응답을 대역으로 세운다.
   */
  test("다른 날짜의 종료된 세션은 읽기 전용이다(F6-1)", async ({ page, request }) => {
    const sessionId = await todaySession(request);
    const session = await (await request.get(`${API_V1}/sessions/${sessionId}`)).json();
    const yesterday = new Date(`${TEST_TODAY}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    await page.route(`**/v1/sessions/${sessionId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...session,
          status: "completed",
          scheduled_date: yesterday.toISOString().slice(0, 10),
        }),
      }),
    );

    await page.goto(`/session/${sessionId}`);
    await expect(page.getByText("이미 종료한 운동이에요.")).toBeVisible();
    await expect(page.getByText("오늘 안에는 기록을 더하거나 고칠 수 있어요.")).toHaveCount(0);
    // 편집·기록 UI 는 DOM 에 없다(AC-S4-3).
    await expect(page.getByRole("button", { name: "운동 추가" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /완료 처리$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /운동 종료|수정 마치기/ })).toHaveCount(0);
    await shot(page, "35b-past-session-read-only");
  });
});

test.describe("500 / 오프라인", () => {
  test("대시보드 500 은 카드 단위로 격리되고 [다시 시도] 가 보인다(AC-S3-2)", async ({ page }) => {
    await page.route("**/v1/dashboard", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "서버 오류다." } }),
      }),
    );
    await page.goto("/");
    await expect(page.getByText("요약을 지금은 불러올 수 없어요.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "주요 리프트 추세" })).toBeVisible();
    await assertNoRawServerText(page);
    await shot(page, "36-error-500-dashboard");
  });

  test("화면을 띄운 뒤 네트워크가 끊기면 오프라인 문구가 보인다", async ({ page }) => {
    await page.route("**/v1/**", (route) => route.abort("internetdisconnected"));
    await page.goto("/");
    await expect(
      page.getByText(/인터넷이 연결되면 요약을 보여드릴게요\.|인터넷 연결이 불안정해요/),
    ).toBeVisible();
    await shot(page, "37-offline-dashboard");
  });

  test("방문한 Pretendard 슬라이스는 서비스워커에서 오프라인 로드된다", async ({
    page,
    context,
  }) => {
    await page.goto("/");
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

    // 첫 요청은 SW 설치보다 빠를 수 있다. 제어권을 얻은 뒤 한 번 더 렌더해 runtime cache를 채운다.
    await page.reload();
    await page.evaluate(() => document.fonts.ready);

    const cachedPretendardUrl = await page.evaluate(async () => {
      const variableUrls = new Set<string>();
      for (const sheet of document.styleSheets) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          if (!rule.style.getPropertyValue("font-family").includes("Pretendard Variable")) continue;
          const url = rule.cssText.match(/url\(["']?([^"')]+\.woff2)/)?.[1];
          if (url) variableUrls.add(new URL(url, location.href).href);
        }
      }
      const cache = await caches.open("afc-fonts-v1");
      const cached = (await cache.keys()).map((request) => request.url);
      return cached.find((url) => variableUrls.has(url)) ?? null;
    });
    expect(cachedPretendardUrl, "Pretendard 슬라이스가 SW cache에 있어야 한다").not.toBeNull();

    // HTTP 캐시를 지워도 CacheStorage가 남는 조건에서 실제 FontFace 로더가 SW 응답을 받는지 확인한다.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await context.setOffline(true);
    try {
      const probeUrl = `${cachedPretendardUrl}?offline-font-probe=1`;
      const responsePromise = page.waitForResponse((response) => response.url() === probeUrl);
      const status = await page.evaluate(async (url) => {
        const face = new FontFace("Offline Pretendard Probe", `url("${url}") format("woff2")`);
        document.fonts.add(face);
        await face.load();
        return face.status;
      }, probeUrl);
      const response = await responsePromise;
      expect(status).toBe("loaded");
      expect(response.ok()).toBe(true);
      expect(response.fromServiceWorker()).toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });

  test("오프라인에서 새로고침해도 앱 셸이 뜬다(PWA)", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "오늘", exact: true })).toBeVisible();
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
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "오늘", exact: true })).toBeVisible();
    await context.setOffline(false);
  });

  test("오프라인 새로고침은 마지막 서버 대시보드와 동기화 시각을 복원한다", async ({
    page,
    context,
    request,
  }) => {
    await seedProgram(request);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "오늘 수행할 운동" })).toBeVisible();
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

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByText(/오프라인 · 마지막 동기화 .* 기준/)).toBeVisible();
      await expect(page.getByRole("heading", { name: "오늘 수행할 운동" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
