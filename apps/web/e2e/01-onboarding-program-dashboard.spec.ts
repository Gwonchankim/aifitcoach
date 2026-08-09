/**
 * 항목 1(앞부분): 온보딩(pain_areas 칩 포함) → 프로그램 확인 → 대시보드.
 * 전부 실제 클릭이다. 실서버(:3001, CORS 프록시 경유)로 검증한다.
 */
import { expect, test } from "./fixtures";
import { API_V1, shot } from "./helpers";

test.describe("S1 온보딩 → S2 프로그램 → S3 대시보드", () => {
  test("칩 선택으로 7스텝을 통과해 계획을 만들고, 제외 사유까지 확인한다", async ({ page }) => {
    const generateRequests: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/programs/generate") && request.method() === "POST") {
        generateRequests.push(JSON.parse(request.postData() ?? "{}"));
      }
    });

    await page.goto("/onboarding");

    // 1/7 프로필
    await expect(page.getByRole("heading", { name: "기본 정보를 알려 주세요" })).toBeVisible();
    await page.getByRole("button", { name: "남성", exact: true }).click();
    await page.getByLabel("출생연도").fill("1993");
    await page.getByLabel("키 (cm)").fill("175");
    await page.getByRole("button", { name: "다음" }).click();

    // 2/7 목표
    await expect(page.getByRole("heading", { name: "어떤 목표로 운동하세요?" })).toBeVisible();
    await page.getByRole("button", { name: /근비대/ }).click();
    await page.getByRole("button", { name: "다음" }).click();

    // 3/7 주당 일수 — 오늘(수) 이 운동일이 되도록 주 3일
    await page.getByRole("button", { name: "주 3일", exact: true }).click();
    await page.getByRole("button", { name: "다음" }).click();

    // 4/7 1회 시간
    await page.getByRole("button", { name: "60분", exact: true }).click();
    await page.getByRole("button", { name: "다음" }).click();

    // 5/7 경력
    await page.getByRole("button", { name: /중급/ }).click();
    await page.getByRole("button", { name: "다음" }).click();

    // 6/7 장비 (기본 전체 선택 상태 — 그대로 진행)
    await page.getByRole("button", { name: "다음" }).click();

    // 7/7 통증 부위 — 자유 입력 0개(AC-P-1)
    await expect(
      page.getByRole("heading", { name: "운동할 때 불편한 곳이 있나요?" }),
    ).toBeVisible();
    expect(await page.locator("input[type=text], textarea, input:not([type])").count()).toBe(0);

    await page.getByRole("button", { name: "무릎 통증" }).click();
    await page.getByRole("button", { name: "어깨 통증" }).click();
    await expect(page.getByText("2곳 선택됨")).toBeVisible();
    await expect(page.getByText("일반적인 회피 가이드이며 의료적 조언이 아니에요.")).toBeVisible();
    await expect(page.getByText(/전문가와 상담해 주세요/)).toBeVisible();
    await shot(page, "01-onboarding-pain-step");

    // "해당 없음" 과 부위 칩은 동시 선택 불가(AC-P-2)
    await page.getByRole("button", { name: "해당 없음, 불편한 곳 없음" }).click();
    await expect(page.getByText("2곳 선택됨")).toHaveCount(0);
    await page.getByRole("button", { name: "무릎 통증" }).click();
    await expect(page.getByText("1곳 선택됨")).toBeVisible();
    await page.getByRole("button", { name: "어깨 통증" }).click();

    await page.getByRole("button", { name: "계획 만들기" }).click();

    // S2 프로그램 확인
    await expect(page).toHaveURL(/\/program$/);
    await expect(page.getByRole("heading", { name: "내 운동 계획" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "왜 이 루틴인가요" })).toBeVisible();

    // 전송 페이로드가 enum 8종의 부분집합인지(AC-P-3)
    expect(generateRequests).toHaveLength(1);
    const payload = generateRequests[0] as { pain_areas: string[]; days_per_week: number };
    expect(payload.pain_areas.sort()).toEqual(["knee", "shoulder"]);
    expect(payload.days_per_week).toBe(3);

    // 제외 섹션 (AC-S2-2)
    await expect(page.getByRole("heading", { name: /안전을 위해 뺀 운동/ })).toBeVisible();
    await expect(page.getByText("무릎 통증").first()).toBeVisible();
    await shot(page, "02-program-excluded");

    // AC-S2-1: 원문 식별자 노출 금지
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/e_[a-z_]+/);
    expect(body).not.toMatch(/movement_pattern|rules_version|horizontal_push|squat|hinge/);

    // S3 대시보드
    await page.getByRole("link", { name: "대시보드로" }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await expect(page.getByRole("heading", { name: "AIFITCOACH" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "오늘 수행할 운동" })).toBeVisible();
    await expect(page.getByRole("link", { name: "운동 시작" })).toBeVisible();
    await shot(page, "03-dashboard-workout");
  });

  /**
   * 빈 상태는 M-UIa 가 **새로 만든 유일한 화면**인데, 처음에는 제목 한 줄만 단언하고 있었다.
   * "만들고 나면" 3단·`세 세션`·자물쇠 부재를 아무도 지키지 않으면 조용히 사라진다
   * (함정 5: 완료 세트 0개 상태만 스캔하던 axe 와 같은 유형).
   */
  test("계획이 없으면 빈 상태가 '아직 없음 + 언제 생기는지 + 지금 할 수 있는 것'을 말한다", async ({
    page,
  }) => {
    // 실서버에는 프로그램이 있으므로 404 응답만 갈아끼워 빈 상태를 재현한다.
    await page.route("**/v1/programs/current", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "NOT_FOUND", message: "생성된 프로그램이 없다." } }),
      }),
    );
    await page.goto("/");

    // ① 아직 없음
    await expect(page.getByText("아직 운동 계획이 없어요")).toBeVisible();
    // ③ 지금 할 수 있는 것
    await expect(page.getByRole("link", { name: "계획 만들기" })).toBeVisible();

    // ② 언제 생기는지 — 3단 안내
    await expect(page.getByRole("heading", { name: "만들고 나면" })).toBeVisible();
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    for (const line of [
      "요일마다 할 종목과 세트가 이 자리에 뜹니다.",
      "세 세션이 쌓이면 무게 추천과 추정 1RM이 나타납니다.",
      "주간 리듬과 근육군별 볼륨이 여기 아래로 붙습니다.",
    ]) {
      expect(body, `빈 상태 3단 안내: ${line}`).toContain(line);
    }
    // 단위는 **세션**이다(ADR-47). "세 세트"로 새면 게이트 정책 자체가 어긋난다.
    expect(body, "게이트 단위는 세션이다 — '세 세트'가 아니다").not.toContain("세 세트");

    // 게이트는 잠금이 아니다 — 자물쇠·업그레이드 유도를 쓰지 않는다(REDESIGN_IMPACT §5 D-1).
    for (const forbidden of ["잠금", "잠겨", "🔒", "업그레이드", "Pro로", "구독"]) {
      expect(body, `빈 상태에 ${forbidden} 유도가 있으면 안 된다`).not.toContain(forbidden);
    }
    // 백엔드 선행이 필요한 진입로는 넣지 않는다(D-1: 아예 뺀다).
    expect(body, "'한 종목만 기록' 진입로는 UIa 범위가 아니다").not.toContain("한 종목만");

    await shot(page, "04-dashboard-empty-no-program");
  });

  test("오늘 수행 완료(done) 상태에서는 [운동 시작]이 없다(AC-S3-1)", async ({ page, request }) => {
    const live = await (await request.get(`${API_V1}/dashboard`)).json();
    await page.route("**/v1/dashboard", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...live,
          today: {
            ...live.today,
            status: "done",
            session_id: live.today.session_id ?? "00000000-0000-4000-8000-000000000009",
            done_summary: { total_volume: 4820, sets_completed: 12, pr_count: 1 },
          },
        }),
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "오늘 수행한 운동" })).toBeVisible();
    await expect(page.getByRole("link", { name: "운동 시작" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "기록 보기" })).toBeVisible();
    await shot(page, "05-dashboard-done");
  });
});
