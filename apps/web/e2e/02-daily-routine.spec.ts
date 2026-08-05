/**
 * 항목 1(뒷부분) + 3: 데일리 루틴 · 세트 완료 · 루틴 편집(추가/교체/삭제) · 운동 종료 · 요약.
 * 종목 타입별 렌더(시간/맨몸/일반)도 여기서 같은 화면에서 확인한다.
 */
import { expect, test, type Page } from "@playwright/test";
import { API_V1, assertNoZeroKg, openSession, seedProgram, shot, todaySession } from "./helpers";

let sessionId: string;

test.beforeAll(async ({ request }) => {
  await seedProgram(request);
  sessionId = await todaySession(request);
});

/** 세트 행(<li>) 하나를 완료 체크 버튼의 접근 이름으로 잡는다. */
function setRow(page: Page, exerciseName: string, setNo: number) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: `${exerciseName} ${setNo}세트 완료 처리` }) });
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

  // (b) 맨몸(풀업) — "자체중량" 배지, 무게 입력칸 없음(AC-E-3)
  const pullup = setRow(page, "풀업", 1);
  await expect(pullup.getByText("자체중량")).toBeVisible();
  expect(await pullup.getByLabel(/풀업 1세트 무게/).count()).toBe(0);
  await expect(pullup.getByLabel("풀업 1세트 횟수, 회")).toBeVisible();
  await expect(pullup.getByLabel("RIR 2")).toBeVisible();

  // (c) 시간(플랭크) — 시간 입력 1칸, 무게·횟수·RIR 없음(AC-E-4)
  const plank = setRow(page, "플랭크", 1);
  await expect(plank.getByLabel("플랭크 1세트 유지 시간, 초")).toBeVisible();
  expect(await plank.getByLabel(/플랭크 1세트 무게/).count()).toBe(0);
  expect(await plank.getByLabel(/플랭크 1세트 횟수/).count()).toBe(0);
  expect(await plank.getByLabel(/^RIR /).count()).toBe(0);
  await expect(plank.getByText("목표 20~60초")).toBeVisible();

  // (a') 일반/무게 미정 세트에도 배지가 실제로 붙어 있다
  const firstCheckLabel =
    (await page
      .getByRole("button", { name: /1세트 완료 처리$/ })
      .first()
      .getAttribute("aria-label")) ?? "";
  const firstExercise = firstCheckLabel.replace(/ 1세트 완료 처리$/, "");
  await expect(setRow(page, firstExercise, 1).getByText("무게 미정")).toBeVisible();
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
  // 카드 전체(제목 + 근거 배지). h2 → 제목블록 → 헤더행 → 카드.
  const plankCard = page
    .getByRole("heading", { name: "플랭크", exact: true })
    .locator("xpath=../../..");
  await plankCard.screenshot({ path: "e2e/screenshots/11d-plank-card.png" });
  await page
    .getByRole("heading", { name: "풀업", exact: true })
    .locator("xpath=../../..")
    .screenshot({ path: "e2e/screenshots/11e-pullup-card.png" });

  // ---- F5 교체 ----
  const before = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  await page.getByRole("button", { name: "플랭크 루틴 편집" }).click();
  const menu = page.getByRole("dialog", { name: /플랭크 편집/ });
  await expect(menu).toBeVisible();
  await shot(page, "12-exercise-menu");
  await menu.getByRole("button", { name: "다른 운동으로 교체" }).click();

  const swapSheet = page.getByRole("dialog", { name: /플랭크 교체/ });
  await expect(swapSheet).toBeVisible();
  await shot(page, "13-picker-swap-open");
  await swapSheet.getByRole("button", { name: /케이블 크런치/ }).click();
  await expect(page.getByRole("heading", { name: "케이블 크런치" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "플랭크" })).toHaveCount(0);

  // ---- F5 삭제 ----
  await page.getByRole("button", { name: "케이블 크런치 루틴 편집" }).click();
  await page
    .getByRole("dialog", { name: /케이블 크런치 편집/ })
    .getByRole("button", { name: "루틴에서 빼기" })
    .click();
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
  // RIR 은 sr-only 라디오 + 보이는 label 이 탭 타깃이다 → 사용자처럼 label 을 누른다.
  await setRow(page, exerciseName, 1).locator('label:has(input[aria-label="RIR 2"])').click();
  await expect(page.getByLabel("RIR 2").first()).toBeChecked();
  await firstCheck.click();

  // F2: 완료 체크 → 휴식 타이머 팝업 자동 오픈
  const timer = page.getByRole("dialog", { name: new RegExp(`${exerciseName} 1세트 후 휴식`) });
  await expect(timer).toBeVisible();
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();

  await expect(page.getByText("✓ 완료").first()).toBeVisible();
  await expect(page.getByText(/1세트 완료 · 계획 \d+세트/)).toBeVisible();

  // 기록이 있는 운동은 편집이 막힌다(AC-S4-4)
  await expect(page.getByRole("button", { name: `${exerciseName} 루틴 편집` })).toBeDisabled();
  await expect(page.getByText(/기록이 있는 운동이라 빼거나 바꿀 수 없어요/)).toBeVisible();

  // 되돌리기 → 재체크(AC-S4-1)
  await page.getByRole("button", { name: `${exerciseName} 1세트 완료 취소` }).click();
  await expect(page.getByRole("button", { name: `${exerciseName} 루틴 편집` })).toBeEnabled();
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

test("완료된 세션 재진입은 읽기 전용이다(AC-S4-3)", async ({ page, request }) => {
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
  await expect(page.getByText("이미 종료한 운동이에요.")).toBeVisible();
  expect(await page.getByRole("button", { name: /완료 처리$/ }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "운동 종료" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "운동 추가" }).count()).toBe(0);
  await shot(page, "19-session-readonly");
});
