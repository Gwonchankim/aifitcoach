import type { CompletionAnalytics, Program } from "../../lib/api";
import { goalLabel, splitLabel } from "../../lib/program-labels";

export function lifecycleTitle(
  program: Program | undefined,
  completion: CompletionAnalytics,
): string {
  const goal = program ? goalLabel(program.goal) : null;
  const split = program ? splitLabel(program.split_type) : null;
  const name = [goal, split].filter(Boolean).join(" ") || "운동 프로그램";
  return `${name} · ${completion.total_weeks}주 중 ${completion.current_week}주차`;
}

export function lifecyclePercent(completion: CompletionAnalytics): number {
  return Math.round((completion.current_week / completion.total_weeks) * 100);
}

export function completedSessionCount(completion: CompletionAnalytics): number {
  return completion.weeks.reduce((sum, week) => sum + week.completed, 0);
}

export function currentLifecycleWeek(completion: CompletionAnalytics) {
  return (
    completion.weeks.find((week) => week.week_number === completion.current_week) ??
    completion.weeks[0] ??
    null
  );
}
