/**
 * 2026-08-05 확정 스펙 3건을 브라우저에서 끝까지 확인한다.
 *   F1-1 RIR 단일 입력칸(직접 입력 + 같은 칸 목록 선택, 미입력 허용, 0~6)
 *   F8-1 휴식일에도 운동하기(부위 선택 → 즉석 세션)
 *   F6-1 종료 후 당일 기록 추가·수정(재개/편집 모드)
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { API_V1, openSession, seedExternalLoadProgram, shot, todaySession } from "./helpers";

/** 주당 일수별 운동 요일(apps/api programs/program-rules.ts 와 같은 표). */
const DAY_PATTERN: Record<number, string[]> = {
  2: ["MON", "THU"],
  3: ["MON", "WED", "FRI"],
  4: ["MON", "TUE", "THU", "FRI"],
  5: ["MON", "TUE", "WED", "FRI", "SAT"],
  6: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** 오늘(서버와 같은 UTC 기준)이 휴식일이 되는 주당 일수. 없으면 null(= 월요일). */
function restDayProgramDays(now = new Date()): number | null {
  const today = WEEKDAYS[now.getUTCDay()];
  return [2, 3, 4, 5, 6].find((days) => !DAY_PATTERN[days].includes(today)) ?? null;
}

/** 세션 화면에서 요청 본문을 전부 모은다(무엇이 서버로 나갔는지 단언하기 위해). */
function recordRequestBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (request) => {
    const data = request.postData();
    if (data && request.url().includes("/v1/")) {
      bodies.push(`${request.method()} ${request.url()} ${data}`);
    }
  });
  return bodies;
}

async function firstExerciseName(page: Page): Promise<string> {
  const label =
    (await page
      .getByRole("button", { name: /1세트 완료 처리$/ })
      .first()
      .getAttribute("aria-label")) ?? "";
  return label.replace(/ 1세트 완료 처리$/, "");
}

/** 완료 체크 → 휴식 타이머를 닫는다. */
async function completeSet(page: Page, exerciseName: string, setNo: number): Promise<void> {
  await page.getByRole("button", { name: `${exerciseName} ${setNo}세트 완료 처리` }).click();
  const timer = page.getByRole("dialog", {
    name: new RegExp(`${exerciseName} ${setNo}세트 후 휴식`),
  });
  await expect(timer).toBeVisible();
  await timer.getByRole("button", { name: "휴식 종료" }).click();
  await expect(timer).toBeHidden();
}

// ---------------------------------------------------------------------------
// F1-1 RIR
// ---------------------------------------------------------------------------

test.describe("F1-1 RIR 입력", () => {
  test("미입력으로 완료하면 요청 어디에도 RIR 이 실리지 않는다", async ({ page, request }) => {
    await seedExternalLoadProgram(request);
    const sessionId = await todaySession(request);
    const bodies = recordRequestBodies(page);

    await openSession(page, sessionId);
    const name = await firstExerciseName(page);

    // 기본값이 "모름"(빈 칸)이다 — 0 이 미리 들어가 있으면 안 된다.
    const rirInput = page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`);
    await expect(rirInput).toHaveValue("");
    // 목표 RIR 이 입력 옆에 함께 보인다(값은 목표·경력에 따라 달라진다).
    await expect(page.getByText(/RIR 목표 \d/).first()).toBeVisible();
    await shot(page, "80-rir-input-empty");

    await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("50");
    await page.getByLabel(`${name} 1세트 횟수, 회`).fill("8");
    await completeSet(page, name, 1);
    await expect(page.getByText(/1세트 완료 · 계획 \d+세트/)).toBeVisible();

    await page.getByRole("button", { name: "운동 종료" }).click();
    await page
      .getByRole("dialog", { name: "운동 종료" })
      .getByRole("button", { name: /종료$/ })
      .click();
    await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();

    // 미입력을 0 으로 바꿔 보내면 엔진이 "RIR 0 = 실패 직전"으로 읽는다 → 어떤 요청에도 없어야 한다.
    const withRir = bodies.filter((body) => /rir/i.test(body));
    expect(withRir, `RIR 이 실린 요청: ${withRir.join(" | ")}`).toEqual([]);
  });

  test("한 칸에서 직접 입력·목록 선택이 되고 0~6 밖 값은 만들어지지 않는다", async ({
    page,
    request,
  }) => {
    await seedExternalLoadProgram(request);
    const sessionId = await todaySession(request);
    await openSession(page, sessionId);
    const name = await firstExerciseName(page);

    const rirInput = page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`);

    // (a) 칸은 하나다 — 입력칸 + 드롭다운 2개로 나누지 않는다(F1-1 2차 개정).
    await expect(rirInput).toHaveCount(1);
    expect(await page.locator("select").count(), "세트 행에 select 가 없다").toBe(0);

    // (b) 숫자 직접 입력.
    await rirInput.fill("3");
    await expect(rirInput).toHaveValue("3");

    /*
      (c) 범위 밖은 **거부**한다(clamp 가 아니다, AC-RIR-2).
      한 자리 값(7·문자)은 여기서 직접 확인하고, 여러 글자(-1·2.5)는 maxlength=1 이라
      애초에 칠 수 없다(문자열 파싱 규칙 자체는 test/session-rir.test.ts 에서 4종 전부 고정한다).
    */
    await expect(rirInput).toHaveAttribute("maxlength", "1");
    for (const rejected of ["7", "9", "a"]) {
      await rirInput.fill(rejected);
      await expect(rirInput, `${rejected} 는 입력 자체가 거부된다`).toHaveValue("3");
    }

    /*
      (d) 목록은 **셰브론 → 하단 시트**로 연다.
      `<datalist>` 는 iOS 에서 탭으로 열 방법이 없어 탈락한 안이다(UX_STATES §2.4.2) → DOM 에 없어야 한다.
    */
    expect(await page.locator("datalist").count(), "datalist 는 쓰지 않는다").toBe(0);

    const chevron = page.getByRole("button", { name: `${name} 1세트 RIR 고르기` });
    await expect(chevron).toHaveAttribute("tabindex", "-1"); // AC-RIR-7
    await expect(chevron).toHaveAttribute("aria-haspopup", "dialog");

    await chevron.click();
    const sheet = page.getByRole("dialog", { name: "RIR 고르기" });
    await expect(sheet).toBeVisible();
    await shot(page, "81-rir-input-selected");

    // 칩은 모름 + 0~6 뿐이다 → 범위 밖 값을 만들 수 없다(§3.3 예방).
    await expect(sheet.getByRole("button", { name: "7" })).toHaveCount(0);
    for (const label of ["모름", "0", "6"]) {
      await expect(sheet.getByRole("button", { name: label })).toBeVisible();
    }

    // (e) 시트에서 '모름'을 고르면 값이 비워지고 포커스가 입력칸으로 돌아온다(AC-RIR-5).
    await sheet.getByRole("button", { name: "모름" }).click();
    await expect(sheet).toBeHidden();
    await expect(rirInput).toHaveValue("");
    await expect(rirInput).toBeFocused();

    /*
      (f) 키보드: 값이 있을 때만 ↑/↓ 로 ±1 하고 0·6 에서 멈춘다. Alt+↓ 는 시트를 연다(AC-RIR-6).
    */
    await page.keyboard.press("ArrowUp");
    await expect(rirInput, "비어 있으면 ↑ 로 0 이 생기지 않는다").toHaveValue("");
    await rirInput.fill("5");
    await page.keyboard.press("ArrowUp");
    await expect(rirInput).toHaveValue("6");
    await page.keyboard.press("ArrowUp");
    await expect(rirInput, "6 에서 멈춘다(순환 금지)").toHaveValue("6");
    await page.keyboard.press("ArrowDown");
    await expect(rirInput).toHaveValue("5");

    await page.keyboard.press("Alt+ArrowDown");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(rirInput).toHaveValue("5");

    // 기록에 실제로 담기는지: 값을 넣고 완료 체크 → 행이 완료로 바뀐다.
    await rirInput.fill("2");
    await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("45");
    await page.getByLabel(`${name} 1세트 횟수, 회`).fill("9");
    await completeSet(page, name, 1);
    await expect(page.getByText("✓ 완료").first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// F1-0 / §2.4.3 완료 세트 축약 행의 디스클로저
// ---------------------------------------------------------------------------

test("완료 행을 펼쳐 값만 고치면 휴식 타이머가 열리지 않는다(AC-SET-6/7/8)", async ({
  page,
  request,
}) => {
  await seedExternalLoadProgram(request, { days_per_week: 3 });
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExerciseName(page);

  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("50");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("8");
  await page.getByLabel(`${name} 1세트 남은 반복 수(RIR), 0~6, 선택 입력`).fill("2");
  await completeSet(page, name, 1);

  await page.getByLabel(`${name} 2세트 무게, 킬로그램`).fill("50");
  await page.getByLabel(`${name} 2세트 횟수, 회`).fill("10");
  await completeSet(page, name, 2);

  // AC-SET-6: 축약 행의 접근 이름이 기록값을 전부 읽는다("완료 취소"만 있으면 값을 알 수 없다).
  const first = page.getByRole("button", { name: new RegExp(`^${name} 1세트 기록,`) });
  await expect(first).toHaveAttribute(
    "aria-label",
    `${name} 1세트 기록, 50킬로그램 8회, RIR 2, 완료. 수정하려면 누르세요`,
  );
  await expect(first).toHaveAttribute("aria-expanded", "false");

  // AC-SET-7: 탭하면 펼쳐져 값을 고칠 수 있고, 완료 상태는 유지된다.
  await first.click();
  const weight = page.getByLabel(`${name} 1세트 무게, 킬로그램`);
  await expect(weight).toHaveValue("50");
  await weight.fill("60");
  await expect(page.getByRole("button", { name: `${name} 1세트 완료 취소` })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // 값만 고칠 때는 타이머를 띄우지 않는다(§2.4.3) — 재체크 경로로 되돌아가면 안 된다.
  await expect(page.getByRole("dialog", { name: /후 휴식/ })).toHaveCount(0);
  await shot(page, "88-completed-row-expanded");

  // AC-SET-8: 다른 행을 펼치면 앞서 펼친 행은 접힌다.
  await page.getByRole("button", { name: new RegExp(`^${name} 2세트 기록,`) }).click();
  await expect(page.getByLabel(`${name} 1세트 무게, 킬로그램`)).toHaveCount(0);
  await expect(first).toBeVisible();

  // 고친 값이 그대로 기록이다: 60×8 + 50×10 = 980kg
  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료$/ })
    .click();
  await expect(page.getByText("오늘 2세트, 980kg 들었어요.")).toBeVisible();
});

// ---------------------------------------------------------------------------
// F8-1 휴식일에도 운동하기
// ---------------------------------------------------------------------------

test.describe("F8-1 휴식일에도 운동하기", () => {
  test("휴식일에서 부위를 골라 즉석 세션을 만들고 그 세션으로 들어간다(실서버)", async ({
    page,
    request,
  }) => {
    const days = restDayProgramDays();
    test.skip(
      days == null,
      "월요일은 어떤 주당 일수(2~6)에도 운동일이라 휴식일 상태를 만들 수 없다",
    );
    await seedExternalLoadProgram(request, { days_per_week: days as number });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "오늘은 휴식" })).toBeVisible();
    await shot(page, "82-rest-day-dashboard");

    await page.getByRole("button", { name: "그래도 운동하기" }).click();
    const sheet = page.getByRole("dialog", { name: "오늘 어디를 할까요?" });
    await expect(sheet).toBeVisible();
    await shot(page, "83-body-part-sheet");

    await sheet.getByRole("button", { name: "가슴" }).click();

    // 만들어진 세션으로 이동한다.
    await expect(page).toHaveURL(/\/session\/\S+$/);
    await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
    await expect(page.getByRole("button", { name: /1세트 완료 처리$/ }).first()).toBeVisible();
    await shot(page, "84-ad-hoc-session");

    // 대시보드로 돌아오면 오늘이 운동일이고, 부위가 **한국어**로 나온다(영문 focus 노출 금지).
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "오늘 수행할 운동" })).toBeVisible();
    await expect(page.getByText(/오늘은 가슴 운동 \d+개예요\./)).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/chest|shoulders|arms|core/);
  });

  test("오늘 세션이 이미 있으면(409) 에러 없이 그 세션으로 이동한다", async ({ page, request }) => {
    await seedExternalLoadProgram(request, { days_per_week: 3 });
    const sessionId = await todaySession(request);

    /*
      오늘이 운동일이라 대시보드는 rest 가 아니다 → [그래도 운동하기] 버튼을 띄우기 위해
      요약 응답만 휴식일로 바꾼다. 즉석 생성 요청은 **실서버**로 나가고 409 를 받는다.
    */
    const summary = await (await request.get(`${API_V1}/dashboard`)).json();
    await page.route("**/v1/dashboard", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...summary,
          today: {
            status: "rest",
            session_id: sessionId,
            routine_summary: null,
            done_summary: null,
          },
        }),
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "그래도 운동하기" }).click();
    await page
      .getByRole("dialog", { name: "오늘 어디를 할까요?" })
      .getByRole("button", { name: "등" })
      .click();

    await expect(page).toHaveURL(`/session/${sessionId}`);
    await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
  });

  test("7일 연속 운동했으면 회복 안내가 보인다(막지는 않는다)", async ({ page, request }) => {
    await seedExternalLoadProgram(request, { days_per_week: 3 });
    const summary = await (await request.get(`${API_V1}/dashboard`)).json();
    await page.route("**/v1/dashboard", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...summary,
          today: { status: "rest", session_id: null, routine_summary: null, done_summary: null },
          streak_days: 8,
        }),
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "그래도 운동하기" }).click();
    const sheet = page.getByRole("dialog", { name: "오늘 어디를 할까요?" });

    await expect(sheet.getByText("8일 연속으로 운동했어요")).toBeVisible();
    await expect(sheet.getByText("일반적인 안내이며 의료적 조언이 아니에요.")).toBeVisible();
    // 안내일 뿐 막지 않는다 — 부위 버튼 6개가 그대로 눌린다.
    for (const part of ["가슴", "등", "어깨", "팔", "하체", "코어"]) {
      await expect(sheet.getByRole("button", { name: part })).toBeEnabled();
    }
    await shot(page, "85-recovery-notice");
  });
});

// ---------------------------------------------------------------------------
// F6-1 종료 후 당일 기록 추가·수정
// ---------------------------------------------------------------------------

test("F6-1 종료한 당일 세션을 다시 열어 세트를 더하고 고친다", async ({ page, request }) => {
  await seedExternalLoadProgram(request, { days_per_week: 3 });
  const sessionId = await todaySession(request);
  await openSession(page, sessionId);
  const name = await firstExerciseName(page);

  // ---- 1세트만 기록하고 종료한다 ----
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("50");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("8");
  await completeSet(page, name, 1);

  await page.getByRole("button", { name: "운동 종료" }).click();
  await page
    .getByRole("dialog", { name: "운동 종료" })
    .getByRole("button", { name: /종료$/ })
    .click();
  await expect(page.getByText("오늘 1세트, 400kg 들었어요.")).toBeVisible();

  // ---- 요약에서 다시 기록으로 돌아간다(재개/편집 모드) ----
  await page.getByRole("button", { name: "기록 더하거나 고치기" }).click();
  await expect(
    page.getByText("이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요."),
  ).toBeVisible();
  await shot(page, "86-resume-mode");

  // ---- 세트 추가(2세트를 더 한다) ----
  await page.getByLabel(`${name} 2세트 무게, 킬로그램`).fill("50");
  await page.getByLabel(`${name} 2세트 횟수, 회`).fill("10");
  await completeSet(page, name, 2);

  // ---- 값 수정(1세트를 60kg 으로 고친다) ----
  await page.getByRole("button", { name: `${name} 1세트 완료 취소` }).click();
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("60");
  await completeSet(page, name, 1);

  // ---- 루틴 편집도 열려 있다(서버 왕복 — 종료된 당일 세션이어도 200) ----
  await page.getByRole("button", { name: "운동 추가" }).click();
  const picker = page.getByRole("dialog", { name: "운동 추가" });
  await picker.getByRole("tab", { name: "코어" }).click();
  await picker.getByRole("button", { name: /플랭크/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("heading", { name: "플랭크" })).toBeVisible();

  // ---- 수정 마치기 → 요약이 고친 값으로 다시 계산된다 ----
  await page.getByRole("button", { name: "수정 마치기" }).click();
  const finish = page.getByRole("dialog", { name: "수정 마치기" });
  await expect(finish.getByText("고친 내용을 오늘 기록에 반영할게요.")).toBeVisible();
  await finish.getByRole("button", { name: "기록 반영" }).click();

  // 60×8 + 50×10 = 980kg, 2세트
  await expect(page.getByRole("heading", { name: "수고했어요" })).toBeVisible();
  await expect(page.getByText("오늘 2세트, 980kg 들었어요.")).toBeVisible();
  await shot(page, "87-resume-summary");

  // ---- 대시보드가 오늘 기록을 다시 받아온다 ----
  await page.getByRole("link", { name: "대시보드로" }).click();
  await expect(page.getByRole("heading", { name: "오늘 수행한 운동" })).toBeVisible();
  await expect(page.getByRole("link", { name: "기록 보기" })).toHaveAttribute(
    "href",
    `/session/${sessionId}`,
  );

  // STEP 6 /sync가 두 performed_set을 서버에 반영했으므로 대시보드도 권위 요약을 그대로 말한다.
  await expect(page.getByText("기록한 세트는 없어요")).toHaveCount(0);
  await expect(page.getByText("오늘 운동 완료! 총 980kg · 2세트")).toBeVisible();
});
