import { describe, expect, it } from "vitest";
import type { CompletionAnalytics, Program } from "../lib/api";
import {
  completedSessionCount,
  currentLifecycleWeek,
  lifecyclePercent,
  lifecycleTitle,
} from "../app/program/program-view";

const completion: CompletionAnalytics = {
  program_id: "p1",
  started_at: "2026-08-03",
  total_weeks: 12,
  current_week: 3,
  weeks: [
    { week_start: "2026-08-03", week_number: 1, completed: 2, planned: 3, rate: 2 / 3, days: [] },
    { week_start: "2026-08-17", week_number: 3, completed: 1, planned: 3, rate: 1 / 3, days: [] },
    { week_start: "2026-08-24", week_number: 4, completed: 0, planned: 3, rate: 0, days: [] },
  ],
};

describe("lazy 12-week lifecycle view", () => {
  it("저장 행 수가 아니라 lifecycle 메타로 주차와 진행률을 표시한다", () => {
    const program = { goal: "hypertrophy", split_type: "upper_lower" } as Program;
    expect(lifecycleTitle(program, completion)).toBe("근비대 상·하체 분할 · 12주 중 3주차");
    expect(lifecyclePercent(completion)).toBe(25);
  });

  it("실제로 반환된 주 중 current_week만 고르고 미래는 예정 상태로 남긴다", () => {
    expect(currentLifecycleWeek(completion)?.week_number).toBe(3);
    expect(completion.weeks.at(-1)?.week_number).toBe(4);
  });

  it("완료 수는 API 주별 completed를 더하며 예정 세션을 완료로 세지 않는다", () => {
    expect(completedSessionCount(completion)).toBe(3);
  });
});
