/**
 * F1 완료 체크의 **성공 경로**를 종목 3종(무게 미정 · 맨몸 · 시간) 각각에서 끝까지 단언한다.
 *
 * 기존 스펙(02)은 무게 미정 세트에서 "빈 값이면 막힌다"(AC-E-2)만 봤고, 맨몸·시간 종목은
 * **렌더만** 확인한 뒤 완료시키지 않았다 → 세트 기록 자체가 죽는 회귀를 못 잡았다.
 * 여기서는 입력 → 체크 → ① 휴식 타이머 팝업 ② 카운터 증가 ③ 종료 시트 세트 수 ④ 요약 세트 수
 * 를 한 줄기로 확인한다.
 *
 * 그리고 마지막 테스트는 **실기기 재현**이다: 폰에서 `http://192.168.x.x:3000` 으로 열면
 * secure context 가 아니라서 `crypto.randomUUID` 가 없다. localhost 는 항상 secure context 라
 * 브라우저 테스트조차 그 환경을 만나지 못한다 → 초기 스크립트로 그 조건을 만들어 고정한다.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addExercise, openSession, seedProgram, shot, todaySession } from "./helpers";

const PULLUP = "e_pullup"; // 맨몸(reps)
const PLANK = "e_plank"; // 시간(time)
const CALF_RAISE = "e_calf_raise"; // 앞선 스펙의 상체 기록과 격리된 무게 미정(reps)

/**
 * 세트 행(<li>) 하나를 완료 체크 버튼의 접근 이름으로 잡는다.
 * 체크하면 이름이 "완료 처리" → "완료 취소" 로 바뀌므로 둘 다 받는다(완료 전후로 같은 행을 가리킨다).
 */
function setRow(page: Page, exerciseName: string, setNo: number) {
  return page.locator("li").filter({
    has: page.getByRole("button", {
      name: new RegExp(`^${exerciseName} ${setNo}세트 완료 (처리|취소)$`),
    }),
  });
}

/** 운동 카드(M-UIb 헤더 행을 감싼 제목 h2 의 조부모가 카드다). */
function card(page: Page, exerciseName: string) {
  return page.getByRole("heading", { name: exerciseName, exact: true }).locator("xpath=../..");
}

/** 화면 상단 진행 카운터의 "N세트 완료". */
async function completedCount(page: Page): Promise<number> {
  const text = await page.locator("header p").first().innerText();
  const match = /(\d+)세트 완료/.exec(text);
  expect(match, `진행 카운터를 못 읽었다: ${text}`).not.toBeNull();
  return Number(match![1]);
}

/** 오늘 루틴의 첫 운동 이름(BASELINE = 무게 미정 종목). */
async function firstExerciseName(page: Page): Promise<string> {
  const label =
    (await page
      .getByRole("button", { name: /1세트 완료 처리$/ })
      .first()
      .getAttribute("aria-label")) ?? "";
  return label.replace(/ 1세트 완료 처리$/, "");
}

/**
 * 완료 체크 → 휴식 타이머가 **실제로 보이는지** 확인하고 닫는다.
 * 카운터가 정확히 1 늘어나는 것까지 여기서 본다(체크가 조용히 씹히면 여기서 깨진다).
 */
async function checkAndExpectRest(
  page: Page,
  exerciseName: string,
  setNo: number,
  /** 타이머가 떠 있는 그 순간을 남길 스크린샷 이름(선택). */
  shotName?: string,
): Promise<void> {
  const before = await completedCount(page);
  await page.getByRole("button", { name: `${exerciseName} ${setNo}세트 완료 처리` }).click();

  const timer = page.getByRole("dialog", {
    name: new RegExp(`${exerciseName} ${setNo}세트 후 휴식`),
  });
  await expect(timer, "완료 체크 → 휴식 타이머 팝업(F2)").toBeVisible();
  await expect(timer.getByRole("timer")).toHaveText(/^\d+:\d{2}$/);
  if (shotName) await shot(page, shotName);
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();

  await expect(setRow(page, exerciseName, setNo).getByText("✓ 완료")).toBeVisible();
  expect(await completedCount(page), "완료 카운터가 1 늘어야 한다").toBe(before + 1);
}

test("종목 3종 성공 경로: 입력 → 체크 → 타이머 → 카운터 → 종료 시트 → 요약", async ({
  page,
  request,
}) => {
  await seedProgram(request);
  const sessionId = await todaySession(request);
  await addExercise(request, sessionId, PULLUP);
  await addExercise(request, sessionId, PLANK);
  await addExercise(request, sessionId, CALF_RAISE);

  await openSession(page, sessionId);
  const weighted = "스탠딩 카프 레이즈";
  expect(await completedCount(page)).toBe(0);

  // ---- (a) 무게 미정(BASELINE): 추천 무게가 없어 사용자가 직접 입력한다 ----
  // 실기기 신고와 같은 값(50 / 6 / RIR 1)을 쓴다.
  const weightInput = page.getByLabel(`${weighted} 1세트 무게, 킬로그램`);
  // "무게 미정" 배지는 카드에 1번만 있다(세트마다 반복하지 않는다, F1-0).
  await expect(card(page, weighted).getByText("무게 미정")).toHaveCount(1);
  await expect(weightInput, "무게 미정은 프리필이 없다(0 을 기록하지 않는다)").toHaveValue("");
  await weightInput.fill("50");
  await page.getByLabel(`${weighted} 1세트 횟수, 회`).fill("6");
  // RIR 은 한 칸에 직접 입력한다(F1-1).
  await page.getByLabel(`${weighted} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`).fill("1");

  await checkAndExpectRest(page, weighted, 1, "70a-unknown-weight-rest-timer");
  // 확정된 기록값이 행에 그대로 남는다(완료 행은 입력칸 대신 기록 텍스트다, F1-0).
  await expect(setRow(page, weighted, 1).getByText("50kg × 6회 · RIR 1")).toBeVisible();
  await expect(card(page, weighted).getByText(/^1\/\d+ 세트 완료$/)).toBeVisible();

  // ---- (b) 맨몸(풀업): 무게 칸이 없고 횟수만 기록한다 ----
  const pullupReps = page.getByLabel("풀업 1세트 횟수, 회");
  expect(
    await setRow(page, "풀업", 1)
      .getByLabel(/풀업 1세트 무게/)
      .count(),
  ).toBe(0);
  await pullupReps.fill("8");
  await checkAndExpectRest(page, "풀업", 1);
  await expect(setRow(page, "풀업", 1).getByText("8회")).toBeVisible();
  await expect(card(page, "풀업").getByText(/^1\/\d+ 세트 완료$/)).toBeVisible();

  // ---- (c) 시간(플랭크): 프리필된 목표 시간을 그대로 확정한다 ----
  const plankTime = page.getByLabel("플랭크 1세트 유지 시간, 초");
  await expect(plankTime, "시간 종목은 목표 시간이 프리필된다").not.toHaveValue("");
  const plankSec = await plankTime.inputValue();
  await checkAndExpectRest(page, "플랭크", 1);
  await expect(setRow(page, "플랭크", 1).getByText(`${plankSec}초`)).toBeVisible();
  await expect(card(page, "플랭크").getByText(/^1\/\d+ 세트 완료$/)).toBeVisible();

  await shot(page, "70-three-kinds-completed");

  // ---- 종료 시트에 완료 세트 수가 반영된다 ----
  await page.getByRole("button", { name: "운동 종료" }).click();
  const finish = page.getByRole("dialog", { name: "운동 종료" });
  await expect(finish.getByText("완료한 3개 세트만 기록돼요.", { exact: false })).toBeVisible();
  await shot(page, "71-finish-sheet-3-sets");
  await finish.getByRole("button", { name: "그래도 종료" }).click();

  // ---- 요약의 세트 수·볼륨이 일치한다(맨몸·시간은 볼륨 0, 무게 세트만 50×6) ----
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await expect(page.getByText("오늘 3세트, 300kg 들었어요.")).toBeVisible();
  // 수치 카드(완료 세트)도 같은 수를 말한다.
  const statCard = page.getByText("완료 세트", { exact: true }).locator("xpath=..");
  await expect(statCard).toContainText("3세트");
  await shot(page, "72-summary-3-sets");
});

/**
 * 실기기 blocker 회귀(무게 50 / 횟수 6 / RIR 1 → 체크해도 아무 일도 안 일어남).
 * 원인은 `crypto.randomUUID` 가 secure context 전용이라는 것. 폰에서 사설 IP 로 접속하면 없다.
 */
test("비보안 출처(실기기 http 접속)에서도 완료 체크가 동작한다", async ({ page, request }) => {
  await seedProgram(request);
  const sessionId = await todaySession(request);

  await page.addInitScript(() => {
    delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await openSession(page, sessionId);
  expect(
    await page.evaluate(() => typeof (crypto as { randomUUID?: unknown }).randomUUID),
    "비보안 출처 조건이 실제로 적용됐는지",
  ).toBe("undefined");

  const weighted = await firstExerciseName(page);
  await page.getByLabel(`${weighted} 1세트 무게, 킬로그램`).fill("50");
  await page.getByLabel(`${weighted} 1세트 횟수, 회`).fill("6");
  await page.getByLabel(`${weighted} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`).fill("1");

  await checkAndExpectRest(page, weighted, 1, "73a-insecure-origin-rest-timer");
  expect(pageErrors, "완료 체크에서 예외가 나면 안 된다").toEqual([]);
  await shot(page, "73-insecure-origin-completed");

  await page.getByRole("button", { name: "운동 종료" }).click();
  const finish = page.getByRole("dialog", { name: "운동 종료" });
  await expect(finish.getByText("완료한 1개 세트만 기록돼요.", { exact: false })).toBeVisible();
  await finish.getByRole("button", { name: "그래도 종료" }).click();
  await expect(page.getByText("오늘 1세트, 300kg 들었어요.")).toBeVisible();
});
