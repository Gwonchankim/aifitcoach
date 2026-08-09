/**
 * 항목 1(뒷부분) + 3: 데일리 루틴 · 세트 완료 · 루틴 편집(추가/교체/삭제) · 운동 종료 · 요약.
 * 종목 타입별 렌더(시간/맨몸/일반)도 여기서 같은 화면에서 확인한다.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, assertNoZeroKg, openSession, seedProgram, shot, todaySession } from "./helpers";

let sessionId: string;

test.beforeAll(async ({ request }) => {
  await seedProgram(request);
  sessionId = await todaySession(request);
});

/** 세트 행(<li>) 하나를 완료 체크 버튼의 접근 이름으로 잡는다. */
function setRow(page: Page, exerciseName: string, setNo: number) {
  return page.locator("li").filter({
    has: page.getByRole("button", {
      name: new RegExp(`^${exerciseName} ${setNo}세트 완료 (처리|취소)$`),
    }),
  });
}

/** 운동 카드. 제목(h2)의 부모가 카드다(F1-0 이후 제목이 카드 직계 자식이다). */
function card(page: Page, exerciseName: string) {
  return page.getByRole("heading", { name: exerciseName, exact: true }).locator("xpath=..");
}

test("루틴 편집(추가) → 3종 종목 렌더 → 교체 → 삭제 → 세트 완료 → 종료 → 요약", async ({
  page,
}) => {
  await openSession(page, sessionId);

  // ---- F5 추가: 코어 탭에서 플랭크(시간 종목) ----
  await page.getByRole("button", { name: "운동 추가" }).click();
  const picker = page.getByRole("dialog", { name: "운동 추가" });
  await expect(picker).toBeVisible();
  await picker.getByRole("tab", { name: "코어" }).click();
  await picker.getByRole("button", { name: /플랭크/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("heading", { name: "플랭크" })).toBeVisible();

  // ---- F5 추가: 등 탭에서 풀업(맨몸 종목) ----
  await page.getByRole("button", { name: "운동 추가" }).click();
  await page.getByRole("dialog", { name: "운동 추가" }).getByRole("tab", { name: "등" }).click();
  await shot(page, "10-picker-add-open");
  await page
    .getByRole("dialog", { name: "운동 추가" })
    .getByRole("button", { name: /^풀업/ })
    .click();
  await expect(page.getByRole("heading", { name: "풀업" })).toBeVisible();

  // ---- 항목 3: 종목 타입별 렌더 ----
  // (a) 일반/무게 미정 — BASELINE 이라 "무게 미정" 배지 + 무게 입력칸이 있고 0kg 은 없다
  await expect(page.getByText("무게 미정").first()).toBeVisible();
  await expect(page.getByText("첫 세션이라 추천 무게가 아직 없어요.").first()).toBeVisible();

  // (b) 맨몸(풀업) — "자체중량" 배지는 **카드에 1번**(F1-0), 무게 입력칸 없음(AC-E-3)
  const pullup = setRow(page, "풀업", 1);
  await expect(card(page, "풀업").getByText("자체중량")).toHaveCount(1);
  expect(await pullup.getByText("자체중량").count()).toBe(0);
  expect(await pullup.getByLabel(/풀업 1세트 무게/).count()).toBe(0);
  await expect(pullup.getByLabel("풀업 1세트 횟수, 회")).toBeVisible();
  // RIR 은 **한 칸**이다(F1-1 2차 개정) — 입력칸 + 드롭다운으로 나누지 않는다.
  await expect(pullup.getByLabel(/풀업 1세트 남은 반복 수\(RIR\), 0~6/)).toBeVisible();
  expect(await pullup.locator("select").count()).toBe(0);

  // (c) 시간(플랭크) — 시간 입력 1칸, 무게·횟수·RIR 없음(AC-E-4)
  const plank = setRow(page, "플랭크", 1);
  await expect(plank.getByLabel("플랭크 1세트 유지 시간, 초")).toBeVisible();
  expect(await plank.getByLabel(/플랭크 1세트 무게/).count()).toBe(0);
  expect(await plank.getByLabel(/플랭크 1세트 횟수/).count()).toBe(0);
  expect(await plank.getByLabel(/남은 반복 수\(RIR\)/).count()).toBe(0);
  await expect(plank.getByText("목표 20~60초")).toBeVisible();

  // (a') "무게 미정" 배지는 카드에 1번만 붙는다(세트마다 반복하지 않는다, AC-SET-2)
  const firstCheckLabel =
    (await page
      .getByRole("button", { name: /1세트 완료 처리$/ })
      .first()
      .getAttribute("aria-label")) ?? "";
  const firstExercise = firstCheckLabel.replace(/ 1세트 완료 처리$/, "");
  await expect(card(page, firstExercise).getByText("무게 미정")).toHaveCount(1);
  expect(await setRow(page, firstExercise, 1).getByText("무게 미정").count()).toBe(0);
  await expect(setRow(page, firstExercise, 1).getByLabel(/1세트 무게, 킬로그램/)).toHaveValue("");

  await assertNoZeroKg(page);
  await page.screenshot({ path: "e2e/screenshots/11-routine-three-kinds.png", fullPage: true });

  // 종목 카드 단위 근접 촬영(전체 페이지 샷은 축소돼 문구를 읽기 어렵다).
  await plank.scrollIntoViewIfNeeded();
  await plank.screenshot({ path: "e2e/screenshots/11a-set-time-plank.png" });
  await pullup.screenshot({ path: "e2e/screenshots/11b-set-bodyweight-pullup.png" });
  await setRow(page, firstExercise, 1).screenshot({
    path: "e2e/screenshots/11c-set-unknown-weight.png",
  });
  // 카드 전체(제목 + 근거 배지). 제목(h2)의 부모가 카드다.
  await card(page, "플랭크").screenshot({ path: "e2e/screenshots/11d-plank-card.png" });
  await card(page, "풀업").screenshot({ path: "e2e/screenshots/11e-pullup-card.png" });

  // ---- F5 교체([교체] = 바로 교체 팝업, 중간 메뉴 없음) ----
  const before = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  await page.getByRole("button", { name: "플랭크 교체" }).click();

  const swapSheet = page.getByRole("dialog", { name: /플랭크 교체/ });
  await expect(swapSheet).toBeVisible();
  await shot(page, "13-picker-swap-open");
  await swapSheet.getByRole("button", { name: /케이블 크런치/ }).click();
  await expect(page.getByRole("heading", { name: "케이블 크런치" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "플랭크" })).toHaveCount(0);

  // ---- F5 삭제(휴지통 → 확인 시트, AC-H-3) ----
  await page.getByRole("button", { name: "케이블 크런치 삭제" }).click();
  const removeSheet = page.getByRole("dialog", { name: /케이블 크런치 빼기/ });
  await expect(removeSheet).toBeVisible();
  await shot(page, "12-exercise-remove-sheet");
  await removeSheet.getByRole("button", { name: "루틴에서 빼기" }).click();
  await expect(page.getByRole("heading", { name: "케이블 크런치" })).toHaveCount(0);
  const after = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  expect(after.length).toBe(before.length - 1);

  // ---- F1 세트 완료 ----
  const firstCheck = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const firstLabel = (await firstCheck.getAttribute("aria-label")) ?? "";
  const exerciseName = firstLabel.replace(/ 1세트 완료 처리$/, "");

  // BASELINE 세트는 무게가 비면 체크가 막힌다(AC-E-2)
  await firstCheck.click();
  await expect(page.getByText("무게를 입력해 주세요.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
  await shot(page, "14-baseline-weight-required");

  await page.getByLabel(`${exerciseName} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${exerciseName} 1세트 횟수, 회`).fill("10");
  // RIR 은 한 칸에 직접 입력한다(F1-1 2차 개정 — 같은 칸의 목록에서 고를 수도 있다).
  await page.getByLabel(`${exerciseName} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`).fill("2");
  await expect(page.getByLabel(/1세트 남은 반복 수\(RIR\), 0~6/).first()).toHaveValue("2");
  await firstCheck.click();

  // F2: 완료 체크 → 휴식 타이머 팝업 자동 오픈
  const timer = page.getByRole("dialog", { name: new RegExp(`${exerciseName} 1세트 후 휴식`) });
  await expect(timer).toBeVisible();
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();

  await expect(page.getByText("✓ 완료").first()).toBeVisible();
  await expect(page.getByText(/1세트 완료 · 계획 \d+세트/)).toBeVisible();
  // 완료 행은 한 줄로 축약된다 — 기록값이 텍스트로 남고 입력칸은 사라진다(F1-0)
  await expect(setRow(page, exerciseName, 1).getByText("40kg × 10회 · RIR 2")).toBeVisible();
  expect(await setRow(page, exerciseName, 1).locator("input").count()).toBe(0);

  // 기록이 있는 운동은 편집이 막힌다(AC-S4-4)
  await expect(page.getByRole("button", { name: `${exerciseName} 교체` })).toBeDisabled();
  // 휴지통은 disabled 가 아니라 aria-disabled 다 — 사유를 알려야 하기 때문이다(AC-DEL-3)
  const trash = page.getByRole("button", { name: new RegExp(`^${exerciseName} 삭제`) });
  await expect(trash).toHaveAttribute("aria-disabled", "true");
  await expect(trash).toHaveAccessibleName(`${exerciseName} 삭제, 기록이 있어 뺄 수 없어요`);
  await expect(page.getByText(/기록이 있는 운동이라 빼거나 바꿀 수 없어요/)).toBeVisible();
  /*
    눌러도 확인 시트가 열리지 않는다(AC-DEL-4).
    force: true 인 이유 — Playwright 는 aria-disabled 를 "not enabled" 로 보고 클릭을 거부한다.
    실제 사용자는 포인터 이벤트가 살아 있어 누를 수 있으므로(그래야 사유를 알려줄 수 있다)
    그 상황을 그대로 재현한다.
  */
  await trash.click({ force: true });
  await expect(page.getByRole("dialog", { name: /빼기/ })).toHaveCount(0);

  // 되돌리기 → 재체크(AC-S4-1)
  await page.getByRole("button", { name: `${exerciseName} 1세트 완료 취소` }).click();
  await expect(page.getByRole("button", { name: `${exerciseName} 교체` })).toBeEnabled();
  await page.getByRole("button", { name: `${exerciseName} 1세트 완료 처리` }).click();
  await page
    .getByRole("dialog", { name: /후 휴식/ })
    .getByRole("button", { name: "휴식 종료" })
    .click();
  await expect(page.getByText(/1세트 완료 · 계획 \d+세트/)).toBeVisible();

  // 2세트 완료 — 앞 세트 무게가 이어져 프리필된다(§5.2)
  await expect(page.getByLabel(`${exerciseName} 2세트 무게, 킬로그램`)).toHaveValue("40");
  await page.getByLabel(`${exerciseName} 2세트 횟수, 회`).fill("9");
  await page.getByRole("button", { name: `${exerciseName} 2세트 완료 처리` }).click();
  await page
    .getByRole("dialog", { name: /후 휴식/ })
    .getByRole("button", { name: "휴식 종료" })
    .click();
  await shot(page, "15-routine-partial-progress");

  // ---- F6 운동 종료 (부분 수행) ----
  await page.getByRole("button", { name: "운동 종료" }).click();
  const finish = page.getByRole("dialog", { name: "운동 종료" });
  await expect(finish).toBeVisible();
  await expect(finish.getByText(/아직 \d+개 세트가 남았어요/)).toBeVisible();
  await finish.getByRole("button", { name: "통증 5점" }).click();
  await expect(
    finish.getByText("일반적인 안내이며 의료적 조언이 아니에요.", { exact: false }),
  ).toBeVisible();
  await shot(page, "16-finish-sheet-pain");
  await finish.getByRole("button", { name: "그래도 종료" }).click();

  // ---- S5 요약 ----
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await expect(page.getByText(/오늘 2세트, [\d.]+kg 들었어요\./)).toBeVisible();
  await assertNoZeroKg(page);
  await page.screenshot({ path: "e2e/screenshots/17-summary.png", fullPage: true });

  // ---- 대시보드가 done 으로 바뀐다(실 데이터) ----
  await page.getByRole("link", { name: "대시보드로" }).click();
  await expect(page.getByRole("heading", { name: "오늘 수행한 운동" })).toBeVisible();
  await expect(page.getByRole("link", { name: "운동 시작" })).toHaveCount(0);
  await shot(page, "18-dashboard-done-real");
});

/**
 * 카탈로그(`GET /exercises`)가 아직 안 왔을 때의 렌더 (UX_STATES §2.4 로딩 = 스켈레톤).
 * 운동 이름은 카탈로그에서만 나오므로, 도착 전에 "운동 1" 같은 **임시 이름을 보여주면 안 된다**
 * (접근 이름에도 그대로 들어가기 때문). 회귀 방지용으로 고정한다.
 */
test("카탈로그 도착 전에는 임시 이름 대신 스켈레톤을 보여준다", async ({ page, request }) => {
  await seedProgram(request);
  const fresh = await todaySession(request);

  // 시간 지연 대신 **게이트**로 막는다. 지연값에 기대면 응답이 먼저 도착해 테스트가 흔들린다.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hits = 0;
  await page.route("**/v1/exercises*", async (route) => {
    hits += 1;
    await gate;
    await route.continue();
  });

  await page.goto(`/session/${fresh}`);
  await expect(page.getByText("운동 목록을 불러오는 중이에요.")).toBeAttached();
  expect(hits, "카탈로그 요청이 실제로 가로채졌는지").toBeGreaterThan(0);

  // 임시 이름("운동 1")이 제목·완료 체크 접근 이름 어디에도 없어야 한다.
  await expect(page.getByRole("heading", { name: /^운동 \d+$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^운동 \d+ .*완료 처리$/ })).toHaveCount(0);
  await shot(page, "60-catalog-pending-skeleton");

  // 카탈로그가 도착하면 진짜 이름이 나온다.
  release();
  await expect(page.getByRole("button", { name: /1세트 완료 처리$/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /^운동 \d+$/ })).toHaveCount(0);
});

/**
 * F6-1 이후 **당일** 종료 세션은 잠기지 않는다(재개/편집 모드).
 * 읽기 전용은 다른 날짜의 종료 세션에만 적용된다(AC-S4-3 → e2e/04-errors.spec.ts).
 */
test("종료한 당일 세션에 다시 들어가면 편집 모드다(F6-1)", async ({ page, request }) => {
  // 이 테스트 전용으로 세션을 만들어 종료한다.
  // (앞 테스트가 프로그램을 다시 만들면 beforeAll 의 세션은 사라질 수 있다.)
  await seedProgram(request);
  const target = await todaySession(request);
  const done = await request.post(`${API_V1}/sessions/${target}/complete`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
    data: {},
  });
  expect(done.status()).toBe(200);

  await page.goto(`/session/${target}`);
  await expect(
    page.getByText("이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요."),
  ).toBeVisible();
  expect(await page.getByRole("button", { name: /완료 처리$/ }).count()).toBeGreaterThan(0);
  expect(await page.getByRole("button", { name: "운동 추가" }).count()).toBe(1);
  // 종료 버튼은 "수정 마치기"로 바뀐다(첫 종료가 아니라는 맥락).
  expect(await page.getByRole("button", { name: "운동 종료" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "수정 마치기" }).count()).toBe(1);
  await shot(page, "19-session-resume-mode");
});
