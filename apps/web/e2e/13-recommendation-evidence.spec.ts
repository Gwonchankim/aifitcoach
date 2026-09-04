/**
 * 추천 엔진이 **브라우저 화면까지 도달하는지**에 대한 증거.
 *
 * 지금까지 이 체인은 서버 통합 테스트(`apps/api/test/sessions.spec.ts`)에만 있었고, 브라우저
 * 스위트는 **전부 첫 세션(BASELINE)에서 시작**했다 — `02` 는 "첫 세션이라 추천 무게가 아직
 * 없어요" 를, `07` 은 "무게 미정은 프리필이 없다" 를 본다. 즉 **핵심 IP 인 추천 값이 실제로
 * 입력칸에 꽂히는 것을 브라우저에서 밟은 스펙이 하나도 없었다.**
 *
 * 그래서 여기서는 실제 endpoint 로 같은 운동의 완료 이력을 쌓아 다음을 한 줄기로 고정한다:
 *
 *   세트 기록 → 세션 종료 → history selector → 엔진 값·reason → planned row 저장
 *   → `GET /sessions` (display gate) → 입력칸 prefill · 근거 문구
 *
 * ## 무엇을 하지 않는가
 *
 * - **추천 결과를 DB 에 심지 않는다.** 계산은 전부 서버가 한다. 준비 작업(`/sync`·`/complete`·
 *   `/programs/generate`)은 실제 endpoint 이고, 마지막 한 바퀴는 브라우저로 직접 밟는다.
 * - **응답을 mock 하지 않는다.** route interception 이 하나도 없다.
 * - 기대값을 서버 응답에서 베껴 오지 않는다. `stepUp`/`stepDown` 그리드를 **테스트가 따로 계산**해
 *   숫자를 못박는다 — 응답을 그대로 기대값으로 쓰면 엔진이 무엇을 내도 통과한다.
 *
 * ## 격리
 *
 * Playwright 가 띄우는 API 는 전용 DB(`<db>_e2e`)와 **실행마다 새로 만드는 `DEV_USER_ID`**
 * (`playwright.config.ts` 의 `randomUUID()`)를 쓴다. 소유자 실데이터·스테이징 IDB 는 건드리지 않는다.
 *
 * 두 방향(증량/감량)은 **서로 다른 종목**에 심는다. 엔진은 종목별 수행 이력으로만 계산하므로
 * 한 세션 안에서 같이 진행해도 섞이지 않는다 — 그리고 이 스펙은 섞이지 않는다는 것 자체를 단언한다.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, openSession, seedProgram, todaySession } from "./helpers";
import { TEST_NOW } from "./test-today";

const JSON_HEADERS = { "Content-Type": "application/json", "X-CSRF-Token": "dev" };

type ApiPlannedSet = {
  id: string;
  exercise_id: string;
  set_no: number;
  target_reps_low: number | null;
  target_reps_high: number | null;
  target_rir: number | null;
  recommended_weight: number | null;
  recommended_reps: number | null;
  reason_code: string | null;
  recommendation_gate: string;
  load_kind: string;
  performed_set: {
    actual_weight: number | null;
    actual_reps: number | null;
    actual_rir: number | null;
    completed: boolean;
  } | null;
};

type ApiSession = { id: string; status: string; planned_sets: ApiPlannedSet[] };

async function sessionOf(request: APIRequestContext, id: string): Promise<ApiSession> {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  expect(response.status(), "세션 조회").toBe(200);
  return (await response.json()) as ApiSession;
}

async function stepKgOf(request: APIRequestContext, exerciseId: string): Promise<number> {
  const response = await request.get(`${API_V1}/exercises/${exerciseId}`);
  expect(response.status(), `${exerciseId} 카탈로그`).toBe(200);
  const body = (await response.json()) as { step_kg: number | null };
  expect(body.step_kg, `${exerciseId} 는 외부 부하 종목이어야 한다`).not.toBeNull();
  return Number(body.step_kg);
}

/**
 * 엔진의 증량/감량 그리드(`packages/shared/src/recommend.ts`)를 **테스트가 독립적으로** 다시 센다.
 * 서버가 준 값을 그대로 기대값에 넣으면 어떤 값이 와도 통과한다.
 */
const stepUp = (weight: number, step: number) =>
  Math.round((Math.floor(weight / step) + 1) * step * 100) / 100;
const stepDown = (weight: number, step: number) =>
  Math.max(0, Math.round((Math.ceil(weight / step) - 1) * step * 100) / 100);

type SetInput = { weight: number; reps: number; rir: number };

/** 실제 `/sync` 로 수행 사실을 올린다 — 계산 결과가 아니라 **사용자가 한 일**만 보낸다. */
async function pushPerformed(
  request: APIRequestContext,
  sets: ApiPlannedSet[],
  input: SetInput,
): Promise<void> {
  const response = await request.post(`${API_V1}/sync`, {
    headers: JSON_HEADERS,
    data: {
      mutations: sets.map((set) => ({
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: set.id,
        op: "upsert",
        updated_at: TEST_NOW,
        payload: {
          actual_weight: input.weight,
          actual_reps: input.reps,
          actual_rir: input.rir,
          completed: true,
        },
      })),
    },
  });
  expect(response.status(), "수행 기록 동기화").toBe(200);
}

type CompleteBody = {
  next_recommendations: {
    exercise_id: string;
    sample_session_count: number;
    gate_state: string;
    recommendation: { weight: number | null; reason_code: string } | null;
  }[];
};

async function completeSession(request: APIRequestContext, id: string): Promise<CompleteBody> {
  const response = await request.post(`${API_V1}/sessions/${id}/complete`, {
    headers: JSON_HEADERS,
    data: {},
  });
  expect(response.status(), "세션 종료").toBe(200);
  return (await response.json()) as CompleteBody;
}

const setsFor = (session: ApiSession, exerciseId: string) =>
  session.planned_sets.filter((set) => set.exercise_id === exerciseId);

/**
 * 오늘 루틴을 새로 만들고, 이 스펙이 쓰는 종목을 **명시적으로 붙인 뒤** 세션을 돌려준다.
 *
 * 왜 루틴이 고른 종목을 그냥 안 쓰나: 이 스위트는 실행 하나가 사용자 하나를 공유한다
 * (`playwright.config.ts` 의 run-scoped `DEV_USER_ID`). 앞선 스펙들이 이미 같은 루틴 종목으로
 * 세션을 여러 번 끝내 두므로, 스펙 12 가 도달했을 때 그 종목은 **이미 gate 가 열려 있다**
 * (실측: 전체 스위트에서 `ADD_ONE_REP` / `ready` 로 시작했다). 그러면 "이력이 없을 때 가려진다"를
 * 관측할 수 없다. 그래서 **아무도 손대지 않은 종목을 런타임에 고른다** — 실행 순서에 기대지 않는다.
 */
async function freshSession(request: APIRequestContext, attach: string[]): Promise<ApiSession> {
  await seedProgram(request);
  const sessionId = await todaySession(request);
  for (const exerciseId of attach) {
    const response = await request.post(`${API_V1}/sessions/${sessionId}/exercises`, {
      headers: JSON_HEADERS,
      data: { exercise_id: exerciseId },
    });
    expect(response.status(), `${exerciseId} 추가`).toBe(200);
  }
  return sessionOf(request, sessionId);
}

/**
 * 완료 이력이 **아직 0인** 외부 부하(반복) 종목 두 개를 고른다.
 *
 * 판정 기준은 서버가 준 `recommendation_gate === "no_history"` 다 — 이 스펙이 "가려진 상태"를
 * 관측하려면 그 상태에서 출발해야 하고, 그걸 추측이 아니라 서버에 물어서 정한다.
 */
async function pickUntouched(
  request: APIRequestContext,
  sessionId: string,
  step: number,
  count: number,
): Promise<string[]> {
  const listed = await request.get(`${API_V1}/exercises`);
  expect(listed.status()).toBe(200);
  const catalog = (
    (await listed.json()) as { items: { id: string; metric: string; step_kg: number | null }[] }
  ).items;
  const inSession = new Set(
    (await sessionOf(request, sessionId)).planned_sets.map((s) => s.exercise_id),
  );

  const chosen: string[] = [];
  for (const item of catalog) {
    if (chosen.length === count) break;
    // 외부 부하(반복) + 그리드가 기준 무게를 나누는 종목만. 루틴이 이미 쓴 종목은 건너뛴다.
    if (item.metric !== "reps" || item.step_kg === null || step % Number(item.step_kg) !== 0)
      continue;
    if (inSession.has(item.id)) continue;

    const added = await request.post(`${API_V1}/sessions/${sessionId}/exercises`, {
      headers: JSON_HEADERS,
      data: { exercise_id: item.id },
    });
    if (added.status() !== 200) continue;

    const row = setsFor(await sessionOf(request, sessionId), item.id)[0];
    // 이미 다른 스펙이 완료해 둔 종목이면 gate 가 열려 있다 → 이 스펙의 출발점이 아니다.
    if (row?.load_kind === "external" && row.recommendation_gate === "no_history")
      chosen.push(item.id);
  }
  expect(chosen.length, "이력이 없는 외부 부하 종목 2개를 찾지 못했다").toBe(count);
  return chosen;
}

/* ------------------------------------------------------------------ *
 * 화면 셀렉터 — 기존 스펙(07)의 접근 이름 관례를 그대로 쓴다.
 * ------------------------------------------------------------------ */

const card = (page: Page, name: string) =>
  page.getByRole("heading", { name, exact: true }).locator("xpath=../..");

const weightInput = (page: Page, name: string, setNo: number) =>
  page.getByLabel(`${name} ${setNo}세트 무게, 킬로그램`);

const repsInput = (page: Page, name: string, setNo: number) =>
  page.getByLabel(`${name} ${setNo}세트 횟수, 회`);

const rirInput = (page: Page, name: string, setNo: number) =>
  page.getByLabel(`${name} ${setNo}세트 남은 반복 수(RIR), 0~6, 선택 입력`);

async function nameOf(request: APIRequestContext, exerciseId: string): Promise<string> {
  const response = await request.get(`${API_V1}/exercises/${exerciseId}`);
  return ((await response.json()) as { name_ko: string }).name_ko;
}

/** 완료 체크 후 휴식 타이머를 닫는다(체크가 씹히면 여기서 깨진다). */
async function completeSetInUi(page: Page, name: string, setNo: number): Promise<void> {
  await page.getByRole("button", { name: `${name} ${setNo}세트 완료 처리` }).click();
  const timer = page.getByRole("dialog", { name: new RegExp(`${name} ${setNo}세트 후 휴식`) });
  await expect(timer, "완료 체크 → 휴식 타이머").toBeVisible();
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();
}

/**
 * `set-rules.ts` 의 `REASON_TEXT` 가 화면에 내보내는 문구.
 *
 * **UI 는 reason code 원문을 노출하지 않는다**(AC-E-6). 그래서 "값과 이유가 함께 맞는지" 는
 * API 의 `reason_code` 와 그 코드에 대응하는 **기존 문구**를 화면에서 대조해 확인한다.
 * 새 UI 를 만들지 않는다. 문구가 바뀌면 이 표가 먼저 깨져서 대조가 조용히 무력해지지 않는다.
 */
const REASON_COPY: Record<string, string> = {
  WEIGHT_UP_REP_TARGET_MET: "지난번 목표 반복을 모두 채워서 무게를 올렸어요",
  TOO_HARD: "지난번이 버거워서 무게를 조금 낮췄어요",
  BASELINE: "첫 세션이라 무게를 직접 정해요",
};

test.describe.configure({ mode: "serial" });

test("@chromium-only 완료 이력이 다음 세션의 추천 값·근거로 화면까지 이어진다", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);

  /* --- 1회차: 이력이 없는 종목 두 개에서 출발한다 --- */
  // 그리드 위의 값이라야 "증량/감량"이 정확히 한 스텝이 된다. 카탈로그가 바뀌면 여기서 멈춘다.
  const WEIGHT = 60;

  await seedProgram(request);
  const [upId, downId] = await pickUntouched(request, await todaySession(request), WEIGHT, 2);
  const [upStep, downStep] = [await stepKgOf(request, upId), await stepKgOf(request, downId)];
  const [upName, downName] = [await nameOf(request, upId), await nameOf(request, downId)];

  const first = await freshSession(request, [upId, downId]);
  const upSets = setsFor(first, upId);
  const downSets = setsFor(first, downId);
  const repsHigh = upSets[0].target_reps_high!;
  const repsLow = downSets[0].target_reps_low!;

  // 출발점: 완료 이력이 0 이라 gate 가 값과 이유를 **둘 다** 가린다(reason_code 도 null 이다).
  expect(upSets[0]).toMatchObject({
    recommendation_gate: "no_history",
    recommended_weight: null,
    reason_code: null,
  });

  /** 한 바퀴: 쉬운 완료(목표 반복 모두 채움) + 어려운 완료(하단 -2, RIR 0). */
  const recordBoth = async (session: ApiSession) => {
    await pushPerformed(request, setsFor(session, upId), {
      weight: WEIGHT,
      reps: repsHigh,
      rir: 2,
    });
    await pushPerformed(request, setsFor(session, downId), {
      weight: WEIGHT,
      reps: repsLow - 2,
      rir: 0,
    });
    return completeSession(request, session.id);
  };

  const afterFirst = await recordBoth(first);

  /* --- display gate 미충족: 값은 계산됐지만 화면에 나오지 않는다 --- */
  const gated = afterFirst.next_recommendations.find((r) => r.exercise_id === upId)!;
  expect(gated, "완료 1회 = early gate").toMatchObject({
    sample_session_count: 1,
    gate_state: "early",
    recommendation: null,
  });

  const second = await freshSession(request, [upId, downId]);
  const secondUp = setsFor(second, upId)[0];
  // 계산은 됐다(세션 생성이 이력을 반영한다). 그러나 gate 가 값을 내보내지 않는다.
  expect(secondUp.recommendation_gate).toBe("early");
  expect(secondUp.recommended_weight).toBeNull();
  expect(secondUp.reason_code).toBeNull();

  await openSession(page, second.id);
  // 실제 UI 단언: 프리필도 근거 문구도 없다.
  await expect(weightInput(page, upName, 1)).toHaveValue("");
  await expect(card(page, upName).getByText(REASON_COPY.WEIGHT_UP_REP_TARGET_MET)).toHaveCount(0);
  await expect(page.getByText("첫 세션이라 추천 무게가 아직 없어요.").first()).toBeVisible();

  /* --- 2·3회차로 gate 를 실제 완료 세션으로 연다. 마지막 한 바퀴는 브라우저로 밟는다. --- */
  await recordBoth(second);

  const third = await freshSession(request, [upId, downId]);
  await openSession(page, third.id);

  for (const [name, reps] of [
    [upName, repsHigh],
    [downName, repsLow - 2],
  ] as const) {
    for (const set of setsFor(third, name === upName ? upId : downId)) {
      await weightInput(page, name, set.set_no).fill(String(WEIGHT));
      await repsInput(page, name, set.set_no).fill(String(reps));
      await rirInput(page, name, set.set_no).fill(name === upName ? "2" : "0");
      await completeSetInUi(page, name, set.set_no);
    }
  }

  // 브라우저에서 세션을 종료한다 — 준비가 아니라 이 경로 자체가 증거다.
  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료$/ })
    .click();
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();

  // 브라우저에서 입력한 실제 값이 sync 뒤 서버 DB 기반 세션 응답에 그대로 남아야 한다.
  const storedThird = await sessionOf(request, third.id);
  for (const set of setsFor(storedThird, upId)) {
    expect(set.performed_set).toMatchObject({
      actual_weight: WEIGHT,
      actual_reps: repsHigh,
      actual_rir: 2,
      completed: true,
    });
  }
  for (const set of setsFor(storedThird, downId)) {
    expect(set.performed_set).toMatchObject({
      actual_weight: WEIGHT,
      actual_reps: repsLow - 2,
      actual_rir: 0,
      completed: true,
    });
  }

  /* --- gate 가 열린 뒤: 값과 이유가 함께 화면에 나온다 --- */
  const fourth = await freshSession(request, [upId, downId]);
  const fourthUp = setsFor(fourth, upId)[0];
  const fourthDown = setsFor(fourth, downId)[0];

  const expectedUp = stepUp(WEIGHT, upStep);
  const expectedDown = stepDown(WEIGHT, downStep);
  expect(expectedUp, "증량은 정확히 한 스텝 위여야 한다").toBe(WEIGHT + upStep);
  expect(expectedDown, "감량은 정확히 한 스텝 아래여야 한다").toBe(WEIGHT - downStep);

  // API: 값·이유·gate 가 한 행에서 함께 온다.
  expect(fourthUp).toMatchObject({
    recommendation_gate: "ready",
    recommended_weight: expectedUp,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
  });
  expect(fourthDown).toMatchObject({
    recommendation_gate: "ready",
    recommended_weight: expectedDown,
    reason_code: "TOO_HARD",
  });
  // 두 방향이 섞이지 않는다 — 종목별 이력으로만 계산된다.
  expect(fourthUp.recommended_weight).not.toBe(fourthDown.recommended_weight);

  /* --- 브라우저: 같은 값이 입력칸에, 같은 코드의 기존 문구가 근거 자리에 --- */
  await openSession(page, fourth.id);

  await expect(weightInput(page, upName, 1), "증량 추천이 그대로 프리필된다").toHaveValue(
    String(expectedUp),
  );
  await expect(repsInput(page, upName, 1), "추천 횟수가 그대로 프리필된다").toHaveValue(
    String(fourthUp.recommended_reps),
  );
  await expect(rirInput(page, upName, 1), "실제 RIR 은 수행 전까지 비어 있어야 한다").toHaveValue(
    "",
  );
  await expect(
    card(page, upName).getByText(`RIR 목표 ${fourthUp.target_rir}`).first(),
    "목표 RIR 은 실제 입력값과 분리해 보여야 한다",
  ).toBeVisible();
  await expect(card(page, upName).getByText(REASON_COPY.WEIGHT_UP_REP_TARGET_MET)).toBeVisible();

  await expect(weightInput(page, downName, 1), "감량 추천이 그대로 프리필된다").toHaveValue(
    String(expectedDown),
  );
  await expect(card(page, downName).getByText(REASON_COPY.TOO_HARD)).toBeVisible();

  /* --- 앱 재실행 parity: 캐시가 아니라 서버·저장 행에서 다시 온다 --- */
  await page.context().close();
  const fresh = await freshContext(browser);
  const reopened = fresh.page;
  await openSession(reopened, fourth.id);

  await expect(weightInput(reopened, upName, 1), "새 컨텍스트에서도 같은 값").toHaveValue(
    String(expectedUp),
  );
  await expect(
    card(reopened, upName).getByText(REASON_COPY.WEIGHT_UP_REP_TARGET_MET),
  ).toBeVisible();
  await expect(weightInput(reopened, downName, 1)).toHaveValue(String(expectedDown));
  await expect(card(reopened, downName).getByText(REASON_COPY.TOO_HARD)).toBeVisible();
  await expect(repsInput(reopened, upName, 1)).toHaveValue(String(fourthUp.recommended_reps));
  await expect(rirInput(reopened, upName, 1)).toHaveValue("");
  await fresh.close();
});

/**
 * 완전히 새 브라우저 컨텍스트. `fixtures.ts` 의 시계 이동을 **그대로 다시** 적용한다 —
 * 안 하면 새 컨텍스트만 실제 오늘을 보고 F6-1 판정이 뒤집힌다.
 */
async function freshContext(browser: Browser) {
  const context = await browser.newContext();
  await context.clock.install({ time: new Date(TEST_NOW) });
  await context.clock.resume();
  const page = await context.newPage();
  return { page, close: () => context.close() };
}
