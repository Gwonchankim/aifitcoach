/**
 * BUG-10 fact window (ADR-86): 기록(값·체크·종료) 쓰기는 **UTC 오늘 + 직전 UTC 하루**만 열린다.
 * UTC 자정 = KST 09:00 이라 KST 08:30 에 시작한 운동이 09:30 에 끝나면 날짜 경계를 넘는다.
 *
 * 서버와 브라우저의 "오늘"을 **한 타임라인으로 함께** 옮긴다. 서버는 테스트 전용 bootstrap 의 제어
 * 라우트(apps/api/test/support/fact-window-e2e-server.ts), 브라우저는 context.clock 이다.
 * 앱 코드에 테스트 시드는 없다. playwright.fact-window.config.ts 로만 실행된다(기본 설정은 무시).
 */
import { randomUUID } from "node:crypto";
import { type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API, API_V1, openSession, seedExternalLoadProgram, shot, todaySession } from "./helpers";
import { assistanceDatabaseSnapshot } from "./support/assistance-observation";
import { TEST_TODAY } from "./test-today";

test.describe.configure({ mode: "serial" });

const day = (offset: number) => {
  const date = new Date(`${TEST_TODAY}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
/** 세션의 날(금). D1 은 직전 하루가 되는 날(토), D2 는 이틀 뒤(일, 기간 경과). */
const [D0, D1, D2] = [day(0), day(1), day(2)];
const COPY = {
  previousCompleted: "지난 날짜에는 운동을 빼거나 바꿀 수 없어요. 기록 값은 고칠 수 있어요.",
  expired: "이 기록은 편집할 수 있는 기간이 지났어요.",
  reflectsOn: (date: string) =>
    `이 기록은 ${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 운동에 반영돼요.`,
};
const CSRF = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };

type WireMutation = {
  client_id: string;
  entity: string;
  entity_id: string;
  op: string;
  updated_at: string;
  payload?: Record<string, unknown>;
};
type Exchange = {
  mutations: WireMutation[];
  applied: string[];
  conflicts: { client_id: string; entity_id: string; reason: string }[];
};
type PerformedSummary = {
  actual_weight: number | null;
  actual_reps: number | null;
  completed: boolean;
  performed_at: string;
};
type ServerSession = {
  id: string;
  scheduled_date: string;
  status: string;
  planned_sets: { id: string; performed_set: PerformedSummary | null }[];
};
type DbSession = {
  id: string;
  scheduledDate: string;
  status: string;
  completedAt: string | null;
  plannedSets: {
    id: string;
    performedSets: {
      clientId: string;
      performedAt: string;
      updatedAt: string;
      actualWeight: number | null;
      actualReps: number | null;
    }[];
  }[];
};

/** 화면의 알림. Next 의 route announcer 도 role=alert 라(본문 밖) main 안에서만 찾는다. */
const screenAlert = (page: Page) => page.getByRole("main").getByRole("alert");

/** 서버의 UTC "오늘"을 옮긴다(이 실행의 랜덤 토큰이 있어야 열리는 테스트 전용 라우트). */
async function setServerToday(request: APIRequestContext, today: string) {
  const token = process.env.AFC_E2E_CONTROL_TOKEN;
  if (!token) throw new Error("24-fact-window runs only with playwright.fact-window.config.ts");
  const response = await request.post(`${API}/__e2e/today`, {
    headers: { "x-afc-e2e-control": token },
    data: { today },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ today });
}

/** 같은 순간으로 서버의 UTC 오늘과 브라우저 시계를 함께 옮긴다. */
async function moveTo(request: APIRequestContext, context: BrowserContext, instant: string) {
  await setServerToday(request, instant.slice(0, 10));
  await context.clock.setSystemTime(new Date(instant));
}

/** 이 페이지가 보낸 /sync 요청과 그 응답을 전부 모은다. */
function recordSync(page: Page): Exchange[] {
  const log: Exchange[] = [];
  page.on("response", async (response) => {
    const sent = response.request();
    if (sent.method() !== "POST" || response.url() !== `${API_V1}/sync`) return;
    const body = (await response.json().catch(() => null)) as Omit<Exchange, "mutations"> | null;
    if (!body) return;
    const { mutations = [] } = (sent.postDataJSON() ?? {}) as { mutations?: WireMutation[] };
    log.push({ mutations, applied: body.applied, conflicts: body.conflicts });
  });
  return log;
}

/** 보낸 mutation 은 전부 어딘가에서 적용됐고 거부는 하나도 없다. */
function expectAllApplied(log: Exchange[]) {
  const sent = [...new Set(log.flatMap((exchange) => exchange.mutations.map((m) => m.client_id)))];
  expect(sent.length).toBeGreaterThan(0);
  expect(log.flatMap((exchange) => exchange.conflicts)).toEqual([]);
  const applied = new Set(log.flatMap((exchange) => exchange.applied));
  expect(sent.filter((id) => !applied.has(id))).toEqual([]);
}

async function serverSession(request: APIRequestContext, id: string): Promise<ServerSession> {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ServerSession;
}

async function serverSet(request: APIRequestContext, sessionId: string, plannedSetId: string) {
  const session = await serverSession(request, sessionId);
  return session.planned_sets.find((set) => set.id === plannedSetId)?.performed_set ?? null;
}

async function dbSession(sessionId: string): Promise<DbSession> {
  const [row] = (await assistanceDatabaseSnapshot([sessionId])) as DbSession[];
  return row;
}

/** 무게 입력이 있는 첫 운동(맨몸·시간 종목은 건너뛴다). */
async function weightedExercise(page: Page): Promise<string> {
  const checks = page.getByRole("button", { name: / 1세트 완료 처리$/ });
  for (let index = 0; index < (await checks.count()); index++) {
    const label = (await checks.nth(index).getAttribute("aria-label")) ?? "";
    const name = label.replace(/ 1세트 완료 처리$/, "");
    if (await page.getByLabel(`${name} 1세트 무게, 킬로그램`).count()) return name;
  }
  throw new Error("오늘 세션에 무게 입력이 있는 운동이 없다");
}

/** 화면의 세트 행이 가리키는 planned set id(완료 체크 버튼의 data-set-check). */
async function plannedSetId(page: Page, name: string, setNo: number): Promise<string> {
  const check = page.getByRole("button", { name: `${name} ${setNo}세트 완료 처리` });
  const id = await check.getAttribute("data-set-check");
  expect(id, `${name} ${setNo}세트 planned set id`).toBeTruthy();
  return id!;
}

async function completeWeightedSet(
  page: Page,
  name: string,
  setNo: number,
  weight: number,
  reps: number,
) {
  await page.getByLabel(`${name} ${setNo}세트 무게, 킬로그램`).fill(String(weight));
  await page.getByLabel(`${name} ${setNo}세트 횟수, 회`).fill(String(reps));
  await page.getByRole("button", { name: `${name} ${setNo}세트 완료 처리` }).click();
  const rest = page.getByRole("dialog", { name: new RegExp(`${name} ${setNo}세트 후 휴식`) });
  await expect(rest).toBeVisible();
  await rest.getByRole("button", { name: "휴식 종료" }).click();
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

async function postSync(request: APIRequestContext, mutations: WireMutation[]) {
  const response = await request.post(`${API_V1}/sync`, { headers: CSRF, data: { mutations } });
  expect(response.status()).toBe(200);
  return (await response.json()) as Omit<Exchange, "mutations">;
}

test.beforeEach(async ({ request }) => setServerToday(request, D0));
test.afterEach(async ({ request }) => setServerToday(request, D0));

test("D6·D8 online: KST 08:30→09:30 crosses UTC midnight; the previous day stays editable and keeps its date", async ({
  page,
  context,
  request,
}) => {
  // KST D1 08:30 = UTC D0 23:30. 5일 분할이라 D0(금)·D1(토) 둘 다 운동일이다.
  await moveTo(request, context, `${D0}T23:30:00.000Z`);
  await seedExternalLoadProgram(request, { days_per_week: 5 });
  const sessionId = await todaySession(request);
  const sync = recordSync(page);
  await openSession(page, sessionId);
  const name = await weightedExercise(page);
  const [first, second] = [await plannedSetId(page, name, 1), await plannedSetId(page, name, 2)];

  await completeWeightedSet(page, name, 1, 50, 8);
  await expect.poll(async () => (await serverSet(request, sessionId, first))?.actual_reps).toBe(8);

  // UTC 자정(KST 09:00)을 넘는다. 같은 화면 그대로 이어 간다 — '어제'라는 이유로 막히지 않는다.
  await moveTo(request, context, `${D1}T00:30:00.000Z`);
  await completeWeightedSet(page, name, 2, 50, 10);
  await page.getByRole("button", { name: new RegExp(`^${name} 1세트 기록,`) }).click();
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("55");
  await expect
    .poll(async () => (await serverSet(request, sessionId, first))?.actual_weight)
    .toBe(55);
  await finish(page);
  await expect(page.getByText("오늘 2세트, 940kg 들었어요.")).toBeVisible();
  await expect.poll(async () => (await serverSession(request, sessionId)).status).toBe("completed");
  const finished = await dbSession(sessionId);
  expect(finished.scheduledDate.slice(0, 10)).toBe(D0);
  expect(finished.completedAt).not.toBeNull();
  const firstSaved = finished.plannedSets.find((set) => set.id === first)!.performedSets[0];
  const secondSaved = finished.plannedSets.find((set) => set.id === second)!.performedSets[0];
  // 첫 저장 시각이 기록 시각이다 — 경계를 넘긴 뒤의 값 수정(50→55)은 시각을 옮기지 않는다(M).
  expect(firstSaved.performedAt < `${D1}T00:00:00.000Z`).toBe(true);
  expect(firstSaved.updatedAt >= `${D1}T00:00:00.000Z`).toBe(true);

  // 재진입도 직전 날짜 창 안이다: 요약 + [기록 더하거나 고치기].
  await page.reload();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await shot(page, "fw-01-previous-day-summary-kst-0930");

  // ---- E1 체인: 버튼이 보인다 → 실제로 고친다 → 저장된 날짜가 그 날로 남는다 ----
  await page.getByRole("button", { name: "기록 더하거나 고치기" }).click();
  await expect(page.getByText(COPY.previousCompleted)).toBeVisible();
  await expect(page.getByText(COPY.reflectsOn(D0))).toBeVisible();
  await expect(page.getByRole("button", { name: "운동 추가" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${name} 메뉴` })).toHaveCount(0);
  await shot(page, "fw-02-previous-day-edit-banner");
  await page.getByRole("button", { name: new RegExp(`^${name} 2세트 기록,`) }).click();
  await page.getByLabel(`${name} 2세트 횟수, 회`).fill("11");
  await expect
    .poll(async () => (await serverSet(request, sessionId, second))?.actual_reps)
    .toBe(11);
  await page.getByRole("button", { name: "수정 마치기" }).click();
  const sheet = page.getByRole("dialog", { name: "수정 마치기" });
  await expect(sheet.getByText(COPY.reflectsOn(D0))).toBeVisible();
  await expect(sheet.getByText("오늘 기록에 반영", { exact: false })).toHaveCount(0);
  await sheet.getByRole("button", { name: "기록 반영" }).click();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();

  const edited = await dbSession(sessionId);
  expect(edited.scheduledDate.slice(0, 10)).toBe(D0); // 오늘(D1)로 옮겨지지 않는다
  expect(edited.completedAt).toBe(finished.completedAt); // 최초 종료 시각 보존
  const secondEdited = edited.plannedSets.find((set) => set.id === second)!.performedSets[0];
  expect(secondEdited.actualReps).toBe(11);
  expect(secondEdited.clientId).toBe(secondSaved.clientId);
  expect(secondEdited.performedAt).toBe(secondSaved.performedAt);
  expect(secondEdited.updatedAt > secondSaved.updatedAt).toBe(true);
  // 오늘(D1)의 세션은 그대로다 — 어제 고친 기록이 오늘로 오지 않는다.
  const todayId = await todaySession(request);
  expect(todayId).not.toBe(sessionId);
  const today = await serverSession(request, todayId);
  expect(today.scheduled_date).toBe(D1);
  expect(today.status).toBe("scheduled");
  expect(today.planned_sets.filter((set) => set.performed_set)).toEqual([]);
  expectAllApplied(sync);

  // ---- 다음 경계: 이제 이틀 전 → 신규 사실은 막히고, exact replay 는 ACK 다 ----
  await moveTo(request, context, `${D2}T00:30:00.000Z`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await expect(page.getByText(COPY.expired)).toBeVisible();
  await expect(page.getByRole("button", { name: "기록 더하거나 고치기" })).toHaveCount(0);
  await expect(page.getByText("기록 값은 고칠 수 있어요", { exact: false })).toHaveCount(0);
  await shot(page, "fw-03-older-summary-expired");

  const lastEdit = sync
    .flatMap((exchange) => exchange.mutations)
    .filter((mutation) => mutation.entity === "performed_set" && mutation.entity_id === second)
    .at(-1)!;
  const replay = await postSync(request, [lastEdit]);
  expect(replay.applied).toEqual([lastEdit.client_id]);
  expect(replay.conflicts).toEqual([]);
  const fresh = {
    ...lastEdit,
    client_id: randomUUID(),
    updated_at: `${D2}T00:31:00.000Z`,
    payload: { ...lastEdit.payload, actual_reps: 12 },
  };
  const refused = await postSync(request, [fresh]);
  expect(refused.applied).toEqual([]);
  expect(refused.conflicts).toEqual([
    { client_id: fresh.client_id, entity_id: second, reason: "conflict" },
  ]);
  const after = await dbSession(sessionId);
  expect(after.plannedSets.find((set) => set.id === second)!.performedSets[0]).toEqual(
    secondEdited,
  );
  expect(after.completedAt).toBe(finished.completedAt);
});

test("D6 offline-first: every first write leaves the device only after UTC midnight and is accepted", async ({
  page,
  context,
  request,
}) => {
  await moveTo(request, context, `${D0}T23:30:00.000Z`);
  await seedExternalLoadProgram(request, { days_per_week: 5 });
  const sessionId = await todaySession(request);
  const sync = recordSync(page);
  await openSession(page, sessionId);
  const name = await weightedExercise(page);
  const [first, second] = [await plannedSetId(page, name, 1), await plannedSetId(page, name, 2)];

  await context.setOffline(true);
  await completeWeightedSet(page, name, 1, 50, 8);
  await moveTo(request, context, `${D1}T00:30:00.000Z`);
  await completeWeightedSet(page, name, 2, 50, 10);
  await finish(page);
  // 서버는 이 운동이 시작된 줄도 모른다(시작 신호 없음) — 그래도 날짜 창으로 허용돼야 한다.
  const before = await serverSession(request, sessionId);
  expect(before.status).toBe("scheduled");
  expect(before.planned_sets.filter((set) => set.performed_set)).toEqual([]);
  // 연결 전에는 쓰기가 하나도 나가지 않았다(진입 때의 빈 pull 만 있었다).
  expect(sync.flatMap((exchange) => exchange.mutations)).toEqual([]);

  await context.setOffline(false);
  await expect.poll(async () => (await serverSession(request, sessionId)).status).toBe("completed");
  await expect.poll(async () => (await serverSet(request, sessionId, first))?.actual_reps).toBe(8);
  expect((await serverSet(request, sessionId, second))?.actual_reps).toBe(10);
  expectAllApplied(sync);
  const saved = await dbSession(sessionId);
  expect(saved.scheduledDate.slice(0, 10)).toBe(D0);
  await expect(screenAlert(page)).toHaveCount(0);
});

test("P1: a set logged offline that reaches the server after the window closed is surfaced, not silently dropped", async ({
  page,
  context,
  request,
}) => {
  await moveTo(request, context, `${D0}T23:50:00.000Z`);
  await seedExternalLoadProgram(request, { days_per_week: 5 });
  const sessionId = await todaySession(request);
  const sync = recordSync(page);
  await openSession(page, sessionId);
  const name = await weightedExercise(page);
  const first = await plannedSetId(page, name, 1);

  await context.setOffline(true);
  await completeWeightedSet(page, name, 1, 50, 8);
  // 이틀 뒤에야 연결된다: D0 은 이제 기록 기간이 지난 날이다.
  await moveTo(request, context, `${D2}T00:10:00.000Z`);
  await context.setOffline(false);
  // 사유 다음에 저장되지 않은 것 — 카드에 보이는 그 행(이름·세트 번호)을 그대로 말한다.
  await expect(screenAlert(page)).toHaveText(
    `${COPY.expired} ${name} 1세트 기록은 저장되지 않았어요.`,
  );
  expect(sync.flatMap((exchange) => exchange.conflicts)).toContainEqual({
    client_id: expect.any(String),
    entity_id: first,
    reason: "conflict",
  });
  expect(await serverSet(request, sessionId, first)).toBeNull();
  // 관측(단언 아님): 거부된 로컬 draft 는 이 티켓에서 되돌리지 않는다 — 화면에 남은 모습을 증거로 둔다.
  await test.info().attach("p1-after-refusal", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
