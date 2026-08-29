/**
 * 세트 행·운동 카드의 밀도 계약(FEATURES_UX F1-0, F5).
 *
 * 픽셀 높이는 E2E(06-mobile)에서 실측하고, 여기서는 **높이를 만드는 원인**을 고정한다.
 *  - 세트 행은 요소가 2줄뿐이다(입력 줄 + 보조 줄). 배지·직전 기록이 줄을 더 만들지 않는다.
 *  - "무게 미정"·"자체중량" 배지는 세트마다 반복하지 않고 카드에 1번만 나온다(AC-SET-2).
 *  - 완료한 세트는 입력칸이 사라지고 한 줄 기록으로 축약된다(AC-SET-5).
 *  - 휴지통은 기록이 있으면 `aria-disabled` 다 — `disabled` 로 막으면 사유를 알릴 수 없다(AC-DEL-3).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Exercise, PlannedSet } from "../lib/api";
import { ExerciseCard } from "../components/session/ExerciseCard";
import { SetRow, shownWeightText } from "../components/session/SetRow";
import type { SetDraft } from "../components/session/session-store";

const BASE: PlannedSet = {
  id: "ps_1",
  exercise_id: "e_bench_press",
  set_no: 1,
  target_reps_low: 8,
  target_reps_high: 10,
  target_rir: 2,
  rest_sec: 120,
  recommended_weight: 62.5,
  recommended_reps: 9,
  reason_code: "WEIGHT_UP_REP_TARGET_MET",
  confidence: 0.85,
  rules_version: "2026.08.1",
  recommendation_gate: "ready",
  performed_set: null,
};

function draft(overrides: Partial<SetDraft> = {}): SetDraft {
  return {
    planned_set_id: BASE.id,
    actual_weight: 62.5,
    actual_reps: 9,
    actual_rir: 2,
    actual_time_sec: null,
    pain_score: null,
    completed: true,
    client_id: "c_1",
    updated_at: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function row(props: Partial<Parameters<typeof SetRow>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SetRow, {
      set: BASE,
      kind: "weighted" as const,
      exerciseName: "벤치프레스",
      fallbackWeight: null,
      previous: null,
      readOnly: false,
      expanded: false,
      onToggleExpand: () => {},
      onComplete: () => {},
      onEdit: () => {},
      onUncomplete: () => {},
      ...props,
    }),
  );
}

const inputCount = (html: string) => (html.match(/<input/g) ?? []).length;
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");

describe("앞 세트 무게 프리필을 직접 수정할 때", () => {
  it("30을 두 번 지우면 빈 칸이 유지되고 fallback 30이 되살아나지 않는다", () => {
    expect(shownWeightText("", "unknown_weight", 30, false)).toBe("30");
    expect(shownWeightText("3", "unknown_weight", 30, true)).toBe("3");
    expect(shownWeightText("", "unknown_weight", 30, true)).toBe("");
  });

  it("직접 건드리지 않은 다음 세트는 앞 세트 무게를 계속 이어받는다", () => {
    expect(shownWeightText("", "unknown_weight", 30, false)).toBe("30");
    expect(shownWeightText("", "unknown_weight", 40, false)).toBe("40");
  });

  it("무게 입력은 모바일 숫자 키패드를 요청하는 text input이다", () => {
    const html = row({ kind: "unknown_weight", fallbackWeight: 30 });
    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="decimal"');
  });
});

describe("미완료 세트 행 (주 1줄 + 보조 1줄)", () => {
  it("16px·가변 입력 2칸·46px RIR·48px 체크의 5열 그리드를 쓴다", () => {
    const html = row();
    expect(html).toContain("grid-cols-[16px_minmax(0,1fr)_minmax(0,1fr)_46px_48px]");
    expect(html).toContain("gap-x-1.5");
    expect(html).toContain('data-set-check="ps_1"');
    expect(html).toContain("size-12");
    expect(html).not.toContain("size-tap-xl");
  });

  it("무게·횟수·RIR 이 모두 주 줄에 있다", () => {
    const html = row();
    expect(inputCount(html)).toBe(3);
    expect(html).toContain("벤치프레스 1세트 무게, 킬로그램");
    expect(html).toContain("벤치프레스 1세트 횟수, 회");
    expect(html).toContain("벤치프레스 1세트 남은 반복 수(RIR), 0~6, 선택 입력");
  });

  it("접근 이름과 탭 순서는 무게 → 횟수 → RIR → 완료다", () => {
    const html = row();
    const controls = [
      'id="set-ps_1-weight"',
      'id="set-ps_1-reps"',
      'id="set-ps_1-rir"',
      'data-set-check="ps_1"',
    ].map((needle) => html.indexOf(needle));
    expect(controls.every((index) => index >= 0)).toBe(true);
    expect(controls).toEqual([...controls].sort((left, right) => left - right));
  });

  it("목표·직전 기록은 보조 줄 하나로 합친다(전용 줄을 만들지 않는다)", () => {
    const html = row({ previous: draft({ actual_weight: 60, actual_reps: 6 }) });
    expect(html).toContain("목표 8~10회");
    expect(visibleText(html)).toContain("직전 60kg × 6회");
    // 두 정보가 같은 문단 하나에 들어간다(목표 RIR 만 aria-describedby 용 span 을 쓴다).
    const paragraphs = html.match(/<p[^>]*>(?:(?!<\/p>).)*목표 8~10회(?:(?!<\/p>).)*<\/p>/g) ?? [];
    expect(paragraphs.length).toBe(1);
    expect(visibleText(paragraphs[0] ?? "")).toContain("직전 60kg × 6회");
  });

  it("무게 축 배지를 세트마다 반복하지 않는다(카드 상단에 있다)", () => {
    expect(row({ kind: "unknown_weight" })).not.toContain("무게 미정");
    expect(row({ kind: "bodyweight" })).not.toContain("자체중량");
  });

  it("맨몸은 무게 칸이 없고, 시간 종목은 RIR 칸이 없다", () => {
    const bodyweight = row({ kind: "bodyweight" });
    expect(bodyweight).not.toContain("무게, 킬로그램");
    expect(bodyweight).toContain("row-start-1 min-w-0 col-span-2 col-start-2");
    const time = row({ kind: "time" });
    expect(time).not.toContain("남은 반복 수(RIR)");
    expect(inputCount(time)).toBe(1);
    expect(time).toContain("col-span-3 col-start-2 row-start-1");
  });
});

describe("완료 세트 행 (한 줄 축약)", () => {
  it("입력칸 대신 기록값을 텍스트로 보여준다", () => {
    const html = row({ draft: draft() });
    expect(inputCount(html)).toBe(0);
    expect(visibleText(html)).toContain("62.5kg × 9회 · RIR 2");
    expect(html).toContain("✓ 완료");
  });

  it("한글 혼합 기록은 숫자 조각에만 모노 글꼴을 쓴다", () => {
    const html = row({ draft: draft() });
    expect(html).toContain(
      '<span class="font-mono tabular-nums">62.5</span>kg × <span class="font-mono tabular-nums">9</span>회 · RIR <span class="font-mono tabular-nums">2</span>',
    );
    expect(html).not.toContain('class="font-mono tabular-nums">62.5kg');
  });

  it("흐리게(opacity) 처리하지 않는다 — 완료 배경으로 구분한다", () => {
    const html = row({ draft: draft() });
    expect(html).not.toContain("opacity-");
    expect(html).toContain("bg-done");
  });

  it("되돌리기는 같은 자리의 완료 체크 버튼 한 번이다", () => {
    const html = row({ draft: draft() });
    expect(html).toContain("벤치프레스 1세트 완료 취소");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("size-12");
    expect(html).toContain("p-1.5");
    expect(html).toContain('aria-expanded="false"');
  });

  it("목표·직전 같은 보조 정보는 완료 행에서 지운다", () => {
    const html = row({ draft: draft(), previous: draft({ actual_reps: 6 }) });
    expect(html).not.toContain("목표 8~10회");
    expect(html).not.toContain("직전");
  });

  /*
    AC-SET-6: 축약 상태에서도 스크린리더가 기록값 **전부**를 읽어야 한다.
    "{운동} n세트 완료 취소" 만 있으면 무엇이 기록됐는지 알 수 없다.
  */
  it("요약 텍스트가 기록값을 전부 읽는 디스클로저 버튼이다(AC-SET-6)", () => {
    const html = row({ draft: draft() });
    expect(html).toContain(
      'aria-label="벤치프레스 1세트 기록, 62.5킬로그램 9회, RIR 2, 완료. 수정하려면 누르세요"',
    );
    expect(html).toContain('aria-expanded="false"');
  });

  it("RIR 이 없으면 그 조각만 빠진다", () => {
    const html = row({ draft: draft({ actual_rir: null }) });
    expect(html).toContain(
      'aria-label="벤치프레스 1세트 기록, 62.5킬로그램 9회, 완료. 수정하려면 누르세요"',
    );
  });

  it("시간 종목은 시간으로 읽는다", () => {
    const html = row({
      kind: "time",
      exerciseName: "플랭크",
      draft: draft({
        actual_weight: null,
        actual_reps: null,
        actual_rir: null,
        actual_time_sec: 45,
      }),
    });
    expect(html).toContain('aria-label="플랭크 1세트 기록, 45초, 완료. 수정하려면 누르세요"');
  });
});

/*
  AC-SET-7: 완료 행을 탭하면 **완료 상태를 유지한 채** 펼쳐져 값을 고칠 수 있다.
  완료 해제 → 재체크 경로만 있으면 값만 고쳐도 휴식 타이머가 다시 열린다(§2.4.3 금지).
*/
describe("완료 세트 행 (펼친 상태, AC-SET-7)", () => {
  it("입력칸이 기록값으로 프리필돼 다시 나온다", () => {
    const html = row({ draft: draft(), expanded: true });
    expect(inputCount(html)).toBe(3);
    expect(html).toContain('value="62.5"');
    expect(html).toContain('value="9"');
    expect(html).toContain('value="2"');
  });

  it("미완료 행과 같은 명시적 5열 그리드와 48px 체크를 쓴다", () => {
    const html = row({ draft: draft(), expanded: true });
    expect(html).toContain("grid-cols-[16px_minmax(0,1fr)_minmax(0,1fr)_46px_48px]");
    expect(html).toContain("gap-x-1.5");
    expect(html).toContain("size-12");
  });

  it("완료 상태가 풀리지 않는다(체크 버튼은 '완료 취소' 그대로다)", () => {
    const html = row({ draft: draft(), expanded: true });
    expect(html).toContain("벤치프레스 1세트 완료 취소");
    expect(html).toContain('aria-pressed="true"');
  });

  it("같은 버튼으로 접는다(aria-expanded 가 true 다)", () => {
    const html = row({ draft: draft(), expanded: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("벤치프레스 1세트 기록 접기");
  });

  it("완료되지 않은 세트는 expanded 여부와 무관하게 그대로다", () => {
    expect(row({ expanded: true })).toBe(row({ expanded: false }));
  });
});

describe("운동 카드", () => {
  const exercise: Exercise = {
    id: "e_bench_press",
    name_ko: "벤치프레스",
    name_en: "Bench Press",
    equipment: "barbell",
    primary_muscles: ["chest"],
    movement_pattern: "horizontal_push",
    difficulty: "beginner",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: 2.5,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions: [],
    media_url: null,
  };

  const sets: PlannedSet[] = [1, 2, 3].map((set_no) => ({
    ...BASE,
    id: `ps_${set_no}`,
    set_no,
    recommended_weight: 0,
    reason_code: "BASELINE",
  }));

  const card = (props: Partial<Parameters<typeof ExerciseCard>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ExerciseCard, {
        name: "벤치프레스",
        exercise,
        sets,
        drafts: {},
        readOnly: false,
        lockedReason: null,
        painScore: null,
        expandedSetId: null,
        onToggleExpand: () => {},
        onEdit: () => {},
        onSwap: () => {},
        onRemove: () => {},
        onRemoveBlocked: () => {},
        onReportPain: () => {},
        onComplete: () => {},
        onUncomplete: () => {},
        ...props,
      }),
    );

  it("'무게 미정' 배지는 세트가 3개여도 카드당 1번만 나온다(AC-SET-2)", () => {
    expect((card().match(/무게 미정/g) ?? []).length).toBe(1);
  });

  it("직접 액션 대신 48px 앵커 메뉴 트리거 하나만 둔다", () => {
    const html = card();
    expect(html).toContain('aria-label="벤치프레스 메뉴"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("size-12");
    expect(html).not.toContain("벤치프레스 교체");
    expect(html).not.toContain("벤치프레스 삭제");
  });

  it("기록 잠금 사유는 메뉴 항목이 설명할 수 있도록 id와 함께 남긴다", () => {
    const html = card({ lockedReason: "기록이 있는 운동이라 빼거나 바꿀 수 없어요." });
    expect(html).toContain('id="exercise-e_bench_press-menu-locked-reason"');
    expect(html).toContain("기록이 있는 운동이라 빼거나 바꿀 수 없어요.");
  });

  it("읽기 전용(다른 날짜의 종료된 세션)에는 편집 액션이 DOM 에 없다", () => {
    const html = card({ readOnly: true });
    expect(html).not.toContain("벤치프레스 메뉴");
    expect(html).not.toContain('role="menu"');
  });
});
