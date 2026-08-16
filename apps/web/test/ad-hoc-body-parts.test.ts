/**
 * 즉석 세션(F8-1) 부위 목록 계약.
 *
 * 서버는 즉석 세션의 `focus` 에 부위 문자열 6종을 그대로 넣는다(대시보드 `routine_summary.focus`
 * 에도 나온다). 라벨이 하나라도 빠지면 화면에 `chest` 같은 영문이 노출되거나(AC-S2-1 위반)
 * focusLabel 이 null 을 돌려줘 문장에서 부위가 통째로 사라진다.
 */
import { describe, expect, it } from "vitest";
import {
  BODY_PARTS,
  RECOVERY_STREAK_DAYS,
  needsRecoveryNotice,
} from "../components/dashboard/body-parts";
import { buildDashboardView } from "../components/dashboard/dashboard-view";
import { focusLabel } from "../lib/program-labels";

describe("부위 목록", () => {
  it("계약 enum 6종과 같다", () => {
    expect(BODY_PARTS.map((part) => part.id)).toEqual([
      "chest",
      "back",
      "shoulders",
      "arms",
      "legs",
      "core",
    ]);
  });

  it("모든 부위에 한국어 라벨이 있다", () => {
    for (const part of BODY_PARTS) {
      expect(part.label, `${part.id} 라벨`).toMatch(/^[가-힣]+$/);
    }
  });

  it("focus 라벨 맵에도 6개가 모두 있다(대시보드 요약에 영문이 나오면 안 된다)", () => {
    for (const part of BODY_PARTS) {
      expect(focusLabel(part.id), `focusLabel(${part.id})`).toBe(part.label);
    }
  });

  it("즉석 세션이 만든 오늘 카드 문장에 영문 부위가 남지 않는다", () => {
    const view = buildDashboardView({
      date: "2026-08-05",
      today: {
        status: "unperformed",
        session_id: "s_adhoc",
        routine_summary: { exercise_count: 4, focus: "shoulders" },
        done_summary: null,
      },
      tomorrow: { status: "rest", routine_summary: null },
      streak_days: 3,
      weekly_completion_rate: 0.5,
      weekly_rhythm: [],
      primary_e1rm: null,
    });

    expect(view.today.message).toBe("오늘은 어깨 운동 4개예요.");
    expect(view.today.message).not.toContain("shoulders");
  });
});

describe("회복 안내(F8-1 안전)", () => {
  it("7일 연속부터 안내한다", () => {
    expect(RECOVERY_STREAK_DAYS).toBe(7);
    expect(needsRecoveryNotice(6)).toBe(false);
    expect(needsRecoveryNotice(7)).toBe(true);
    expect(needsRecoveryNotice(12)).toBe(true);
  });
});
