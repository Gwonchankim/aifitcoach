import { expect, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const PROGRAM = {
  program_id: "11111111-1111-4111-8111-111111111111",
  goal: "hypertrophy",
  split_type: "upper_lower",
  rules_version: "2026.08.1",
  started_at: "2026-08-03",
  total_weeks: 12,
  current_week: 2,
  status: "active",
  excluded_exercises: [],
  sessions: [
    {
      day: "FRI",
      focus: "upper",
      exercises: [
        {
          exercise_id: "e_bench_press",
          sets: 3,
          reps_low: 8,
          reps_high: 10,
          target_rir: 2,
          rest_sec: 120,
          time_low_sec: null,
          time_high_sec: null,
        },
      ],
    },
  ],
};

const EXERCISES = [
  {
    id: "e_bench_press",
    name_ko: "벤치프레스",
    name_en: "Bench Press",
    movement_pattern: "horizontal_push",
    primary_muscles: ["chest"],
    equipment: "barbell",
    difficulty: "beginner",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: 2.5,
    rep_range_low: 8,
    rep_range_high: 10,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions: ["e_push_up"],
    media_url: null,
  },
  {
    id: "e_push_up",
    name_ko: "푸시업",
    name_en: "Push Up",
    movement_pattern: "horizontal_push",
    primary_muscles: ["chest"],
    equipment: "bodyweight",
    difficulty: "beginner",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: null,
    rep_range_low: 8,
    rep_range_high: 15,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions: [],
    media_url: null,
  },
];

const DAYS = [
  ["2026-08-10", "completed"],
  ["2026-08-11", "rest"],
  ["2026-08-12", "partial"],
  ["2026-08-13", "rest"],
  ["2026-08-14", "in_progress"],
  ["2026-08-15", "scheduled"],
  ["2026-08-16", "rest"],
].map(([date, state]) => ({
  date,
  state,
  session_id: null,
  focus: state === "rest" ? null : "upper",
}));

const COMPLETION = {
  program_id: PROGRAM.program_id,
  started_at: PROGRAM.started_at,
  total_weeks: 12,
  current_week: 2,
  weeks: [
    { week_start: "2026-08-10", week_number: 2, completed: 1, planned: 1, rate: 1, days: DAYS },
    {
      week_start: "2026-08-17",
      week_number: 3,
      completed: 0,
      planned: 1,
      rate: 0,
      days: DAYS.map((day) => ({
        ...day,
        date: day.date.replace("2026-08-1", "2026-08-2"),
        state: day.state === "rest" ? "rest" : "scheduled",
      })),
    },
  ],
};

const VOLUME = {
  goal: "hypertrophy",
  recommendation_range: { min_hard_sets: 10, max_hard_sets: 20 },
  weeks: [
    {
      week_start: "2026-08-10",
      muscles: [
        { muscle: "chest", hard_sets: 12, volume_load: 3200, avg_rir: 2, range_status: "within" },
        { muscle: "lats", hard_sets: 8, volume_load: 2100, avg_rir: 2, range_status: "below" },
      ],
    },
  ],
};

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

type Transport = { down: boolean; completionCalls: number };

async function apiJson(route: Route, body: unknown, transport: Transport) {
  if (transport.down) return route.abort("failed");
  await json(route, body);
}

async function mockM4(
  page: Page,
  dashboardGate: "ready" | "early" = "ready",
  transport: Transport = { down: false, completionCalls: 0 },
) {
  await page.route("**/v1/programs/current", (route) => apiJson(route, PROGRAM, transport));
  await page.route("**/v1/exercises**", (route) =>
    apiJson(route, { items: EXERCISES, next_cursor: null }, transport),
  );
  await page.route("**/v1/dashboard", (route) =>
    apiJson(
      route,
      {
        date: "2026-08-14",
        today: {
          status: "unperformed",
          session_id: "22222222-2222-4222-8222-222222222222",
          routine_summary: { exercise_count: 1, focus: "upper" },
          done_summary: null,
        },
        tomorrow: { status: "rest", routine_summary: null },
        streak_days: 2,
        weekly_completion_rate: 0.5,
        weekly_rhythm: DAYS,
        primary_e1rm:
          dashboardGate === "ready"
            ? {
                exercise_id: "e_bench_press",
                sample_session_count: 3,
                gate_state: "ready",
                latest_e1rm: 78.5,
              }
            : {
                exercise_id: "e_bench_press",
                sample_session_count: 2,
                gate_state: "early",
                latest_e1rm: null,
              },
      },
      transport,
    ),
  );
  await page.route("**/v1/analytics/volume**", (route) => apiJson(route, VOLUME, transport));
  await page.route("**/v1/analytics/completion**", (route) => {
    if (!transport.down) transport.completionCalls += 1;
    return apiJson(route, COMPLETION, transport);
  });
  await page.route("**/v1/analytics/e1rm**", (route) =>
    apiJson(
      route,
      {
        exercise_id: "e_bench_press",
        sample_session_count: 2,
        gate_state: "early",
        observations: [
          { session_id: "s1", date: "2026-08-01" },
          { session_id: "s2", date: "2026-08-08" },
        ],
        // UI가 sample count나 payload 유무를 자체 판정하면 아래 값이 새어 나온다.
        points: [
          {
            session_id: "s1",
            date: "2026-08-01",
            e1rm: 42.5,
            method: "corrected_rir_epley",
            is_pr: false,
          },
        ],
        next_recommendation: {
          exercise_id: "e_bench_press",
          weight: 42.5,
          reps_low: 8,
          reps_high: 10,
          sets: 3,
          reason_code: "UP",
          confidence: null,
          load_kind: "external",
          recommendation_state: "ready",
          recommended_action: null,
          explanation: "42.5kg 추천",
          rules_version: "v1",
        },
      },
      transport,
    ),
  );
}

test("M-4 홈은 16px 프레임·7열/4px 리듬·34/1fr/54px 볼륨과 색 역할을 고정한다", async ({
  page,
}) => {
  await mockM4(page);
  await page.goto("/");
  await expect(page.getByText("78.5kg")).toBeVisible();
  await expect(page.locator('[data-m4-card="rhythm"]')).toBeVisible();
  await expect(page.locator('[data-m4-grid="rhythm"]')).toBeVisible();
  await expect(page.locator('[data-m4-grid="volume-row"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: /운동 시작/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /기록 탭/ })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const screen = document.querySelector("main > div") as HTMLElement;
    const rhythmCard = document.querySelector('[data-m4-card="rhythm"]') as HTMLElement;
    const rhythm = document.querySelector('[data-m4-grid="rhythm"]') as HTMLElement;
    const volumeRow = document.querySelector('[data-m4-grid="volume-row"]') as HTMLElement;
    const action = Array.from(document.querySelectorAll("a")).find((node) =>
      node.textContent?.includes("운동 시작"),
    ) as HTMLElement;
    const info = Array.from(document.querySelectorAll("a")).find((node) =>
      node.textContent?.includes("기록 탭"),
    ) as HTMLElement;
    return {
      screenPadding: getComputedStyle(screen).paddingLeft,
      screenGap: getComputedStyle(screen).rowGap,
      rhythmPadding: getComputedStyle(rhythmCard).paddingLeft,
      rhythmGap: getComputedStyle(rhythm).columnGap,
      rhythmColumns: getComputedStyle(rhythm).gridTemplateColumns.split(" ").length,
      rhythmTargets: Array.from(
        rhythm.querySelectorAll("button"),
        (button) => button.getBoundingClientRect().height,
      ),
      volumeColumns: getComputedStyle(volumeRow).gridTemplateColumns,
      actionBackground: getComputedStyle(action).backgroundColor,
      infoColor: getComputedStyle(info).color,
    };
  });
  expect(metrics).toMatchObject({
    screenPadding: "16px",
    screenGap: "12px",
    rhythmPadding: "11px",
    rhythmGap: "4px",
    rhythmColumns: 7,
    actionBackground: "rgb(21, 26, 33)",
    infoColor: "rgb(27, 79, 196)",
  });
  expect(metrics.volumeColumns).toMatch(/^34px .* 54px$/);
  for (const height of metrics.rhythmTargets) expect(height).toBeGreaterThanOrEqual(44);
});

test("ADR-70 early는 다음 추천과 관측 점을 표시하고 e1RM 선·값을 숨긴다", async ({ page }) => {
  await mockM4(page, "early");
  await page.goto("/history?exercise=e_bench_press");
  const early = page.locator('[data-history-gate="early"]');
  await expect(early).toBeVisible();
  await expect(early.locator('[data-history-visual="observations-only"] i')).toHaveCount(2);
  await expect(page.locator('[data-history-visual="ready-chart"]')).toHaveCount(0);
  await expect(page.locator("polyline")).toHaveCount(0);
  await expect(early.getByText(/42\.5kg/)).toHaveCount(0);
  await expect(page.getByText("42.5kg 추천")).toBeVisible();
  await expect(page.getByText("다음 추천", { exact: true })).toBeVisible();
});

test("주간 프로그램은 6px 진행·44px 이상 날짜 행을 쓰고 결제·미래 mutation을 노출하지 않는다", async ({
  page,
}) => {
  await mockM4(page);
  await page.goto("/program");
  await expect(page.getByRole("heading", { name: "주간 프로그램" })).toBeVisible();
  const progress = page.getByLabel(/프로그램 17% 진행/);
  await expect(progress).toBeVisible();
  const expandable = page.locator('button[aria-expanded="false"]').first();
  await expandable.click();
  await expect(page.getByText(/3세트 · 8–10회 · RIR 2/)).toBeVisible();
  await expect(page.getByText("무료", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /일정 바꾸기|교체|앞당기기/ })).toHaveCount(0);

  const metrics = await page.evaluate(() => {
    const progress = document.querySelector('[aria-label^="프로그램 "]') as HTMLElement;
    const fill = progress.firstElementChild as HTMLElement;
    const rows = Array.from(
      document.querySelectorAll('[data-m4-card="program-days"] > div > button'),
    ) as HTMLElement[];
    return {
      height: progress.getBoundingClientRect().height,
      fill: getComputedStyle(fill).backgroundColor,
      rowHeights: rows.map((row) => row.getBoundingClientRect().height),
    };
  });
  expect(metrics.height).toBe(6);
  expect(metrics.fill).toBe("rgb(27, 79, 196)");
  for (const height of metrics.rowHeights) expect(height).toBeGreaterThanOrEqual(44);
});

test("주간 프로그램은 transport 실패 때만 마지막 completion snapshot을 stale로 복원한다", async ({
  page,
}) => {
  const transport: Transport = { down: false, completionCalls: 0 };
  await mockM4(page, "ready", transport);
  await page.goto("/program");
  await expect(page.getByText("근비대 상·하체 분할 · 12주 중 2주차")).toBeVisible();
  await expect.poll(() => transport.completionCalls).toBeGreaterThanOrEqual(2);

  transport.down = true;
  await page.reload();

  await expect(page.getByRole("status")).toContainText("마지막 동기화");
  await expect(page.getByText("운동 프로그램 · 12주 중 2주차")).toBeVisible();
  await expect(page.getByText("상체", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("인터넷이 연결되면 계획을 보여드릴게요.")).toHaveCount(0);
});
