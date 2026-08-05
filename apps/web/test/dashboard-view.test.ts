import { describe, expect, it } from "vitest";
import type { DashboardSummary } from "../lib/api";
import { buildDashboardView } from "../components/dashboard/dashboard-view";

function summary(patch: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    date: "2026-08-05",
    today: { status: "workout", session_id: "s_1", routine_summary: null, done_summary: null },
    tomorrow: { status: "rest", routine_summary: null },
    streak_days: 3,
    weekly_completion_rate: 0.5,
    ...patch,
  } as DashboardSummary;
}

describe("오늘 카드", () => {
  it("미수행이면 오늘 루틴 요약과 [운동 시작]을 보여준다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "workout",
          session_id: "s_42",
          routine_summary: { exercise_count: 5, focus: "upper" },
          done_summary: null,
        },
      }),
    );

    expect(view.today.message).toBe("오늘은 상체 운동 5개예요.");
    expect(view.today.primary).toEqual({ label: "운동 시작", href: "/session/s_42" });
  });

  it("휴식일이면 진입 액션이 없고 내일 루틴 보기만 남는다", () => {
    const view = buildDashboardView(
      summary({
        today: { status: "rest", session_id: null, routine_summary: null, done_summary: null },
      }),
    );

    expect(view.today.message).toBe("오늘은 휴식이에요. 잘 쉬는 것도 훈련이에요.");
    expect(view.today.primary).toBeNull();
    expect(view.today.secondary).toEqual({ label: "내일 루틴 보기", href: "/program" });
  });

  it("수행함이면 기록 요약을 보여주고 [운동 시작]이 없다 (AC-S3-1)", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: null,
          done_summary: { total_volume: 3450.5, sets_completed: 12, pr_count: 2 },
        },
      }),
    );

    expect(view.today.message).toBe("오늘 운동 완료! 총 3,450.5kg · 12세트");
    expect(view.today.notes).toEqual(["개인 기록 2개를 새로 세웠어요."]);
    expect(view.today.primary).toEqual({ label: "기록 보기", href: "/session/s_9" });
    expect(view.today.primary?.label).not.toBe("운동 시작");
  });

  it("수행함 분기는 routine_summary 가 아니라 status 로 한다", () => {
    // 서버는 done 일 때도 routine_summary 를 채워 보낸다.
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: { exercise_count: 5, focus: "upper" },
          done_summary: { total_volume: 1200, sets_completed: 8, pr_count: 0 },
        },
      }),
    );

    expect(view.today.status).toBe("done");
    expect(view.today.heading).toBe("오늘 수행한 운동");
    expect(view.today.message).toBe("오늘 운동 완료! 총 1,200kg · 8세트");
  });

  it("PR 이 0개면 보조 문구를 만들지 않는다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: null,
          done_summary: { total_volume: 1200, sets_completed: 8, pr_count: 0 },
        },
      }),
    );

    expect(view.today.notes).toEqual([]);
    expect(view.today.message).toBe("오늘 운동 완료! 총 1,200kg · 8세트");
  });

  it("맨몸만 한 날(볼륨 0, 세트 있음)은 0kg 을 쓰지 않고 이유를 덧붙인다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: { exercise_count: 3, focus: "upper" },
          done_summary: { total_volume: 0, sets_completed: 9, pr_count: 0 },
        },
      }),
    );

    expect(view.today.message).toBe("오늘 운동 완료! 9세트를 마쳤어요.");
    expect(view.today.message).not.toContain("0kg");
    expect(view.today.notes).toEqual(["맨몸으로 하는 운동은 무게 합계에 넣지 않아요."]);
  });

  it("완료 세트가 0개면 수치를 만들지 않는다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: { exercise_count: 3, focus: "upper" },
          done_summary: { total_volume: 0, sets_completed: 0, pr_count: 0 },
        },
      }),
    );

    expect(view.today.message).toBe("오늘 운동을 마쳤어요. 기록한 세트는 없어요.");
    expect(view.today.notes).toEqual([]);
  });

  /*
    요약 화면은 "오늘 2세트, 980kg" 인데 대시보드가 "기록한 세트는 없어요" 라고 말하면
    두 화면이 서로를 부정한다. 서버 수행 기록이 아직 없을 뿐이므로 **없다고 단정하지 않는다**.
  */
  it("서버 기록이 0인데 이 기기에 완료 세트가 있으면 없다고 단정하지 않는다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: { exercise_count: 3, focus: "upper" },
          done_summary: { total_volume: 0, sets_completed: 0, pr_count: 0 },
        },
      }),
      2,
    );

    expect(view.today.message).toBe(
      "오늘 2세트를 기록했어요. 이 기기에만 있는 기록이라 연결되면 요약에 반영돼요.",
    );
    expect(view.today.message).not.toContain("기록한 세트는 없어요");
    expect(view.today.notes).toEqual([]);
  });

  it("서버 기록이 있으면 로컬 값과 무관하게 서버 요약을 그대로 보여준다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "done",
          session_id: "s_9",
          routine_summary: null,
          done_summary: { total_volume: 1200, sets_completed: 8, pr_count: 0 },
        },
      }),
      2,
    );

    expect(view.today.message).toBe("오늘 운동 완료! 총 1,200kg · 8세트");
  });

  it("세션 id 가 없으면 진입 링크를 만들지 않는다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "workout",
          session_id: null,
          routine_summary: { exercise_count: 4, focus: "push" },
          done_summary: null,
        },
      }),
    );

    expect(view.today.primary).toBeNull();
  });

  it("모르는 focus 값은 문장에서 통째로 빠진다", () => {
    const view = buildDashboardView(
      summary({
        today: {
          status: "workout",
          session_id: "s_1",
          routine_summary: { exercise_count: 3, focus: "mystery" },
          done_summary: null,
        },
      }),
    );

    expect(view.today.message).toBe("오늘은 운동 3개예요.");
    expect(view.today.message).not.toContain("mystery");
  });
});

describe("내일 카드", () => {
  it("휴식이면 휴식 문구를 보여준다", () => {
    const view = buildDashboardView(
      summary({ tomorrow: { status: "rest", routine_summary: null } }),
    );
    expect(view.tomorrow.message).toBe("내일은 휴식이에요.");
  });

  it("예정이면 루틴 요약을 보여준다", () => {
    const view = buildDashboardView(
      summary({
        tomorrow: { status: "workout", routine_summary: { exercise_count: 6, focus: "legs" } },
      }),
    );
    expect(view.tomorrow.message).toBe("내일은 하체 운동 6개예요.");
  });
});

describe("지표 카드", () => {
  it("스트릭이 0이어도 숨기지 않고 0으로 표시한다", () => {
    const view = buildDashboardView(summary({ streak_days: 0 }));
    expect(view.streak.value).toBe("0일");
    expect(view.streak.note).toBe("오늘부터 시작해요");
  });

  it("스트릭이 쌓이면 휴식일이 끊지 않는다는 걸 함께 알린다", () => {
    const view = buildDashboardView(summary({ streak_days: 5 }));
    expect(view.streak.label).toBe("연속 운동일");
    expect(view.streak.value).toBe("5일");
    expect(view.streak.note).toBe("휴식일은 끊기지 않아요");
  });

  it("완료율이 0이면 수치 대신 안내를 보여준다", () => {
    const view = buildDashboardView(summary({ weekly_completion_rate: 0 }));
    expect(view.weekly.value).toBeNull();
    expect(view.weekly.note).toBe("이번 주 기록이 아직 없어요.");
  });

  it("완료율은 0~1 비율이므로 백분율로 바꿔 보여준다", () => {
    // 그대로 뿌리면 0.5 가 "0.5%" 가 된다 — 100배 어긋나는 자리다.
    expect(buildDashboardView(summary({ weekly_completion_rate: 0.5 })).weekly.value).toBe("50%");
    expect(buildDashboardView(summary({ weekly_completion_rate: 0.666 })).weekly.value).toBe("67%");
    expect(buildDashboardView(summary({ weekly_completion_rate: 1 })).weekly.value).toBe("100%");
  });
});
