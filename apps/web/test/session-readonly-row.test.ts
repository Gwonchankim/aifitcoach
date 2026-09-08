/**
 * AC-S4-3: 완료된 세션에서는 편집·체크 UI 가 **DOM 에 없다**(숨김·disabled 가 아니라 미렌더).
 * 렌더 결과 문자열로 확인한다(jsdom 없이 react-dom/server 로 충분하다).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlannedSet } from "../lib/api";
import { SetRow } from "../components/session/SetRow";
import type { SetDraft } from "../components/session/session-store";

const SET: PlannedSet = {
  id: "ps_1",
  source_revision: "fixture-readonly-ps-1",
  correlation_id: null,
  append_eligibility: null,
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
  load_kind: "external",
  recommendation_state: "ready",
  assistance_provenance: null,
  recommended_action: null,
  assistance_safety_status: null,
  recommendation_gate: "ready",
  performed_set: null,
};

function draft(overrides: Partial<SetDraft> = {}): SetDraft {
  return {
    planned_set_id: SET.id,
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

function render(props: { readOnly: boolean; draft?: SetDraft }) {
  return renderToStaticMarkup(
    createElement(SetRow, {
      set: SET,
      kind: "weighted" as const,
      exerciseName: "벤치프레스",
      draft: props.draft,
      fallbackWeight: null,
      previous: null,
      readOnly: props.readOnly,
      expanded: false,
      onToggleExpand: () => {},
      onComplete: () => {},
      onEdit: () => {},
      onUncomplete: () => {},
    }),
  );
}

/** AC-SET-9: 다른 날짜의 완료 세션에서 축약 행은 버튼이 아니다. */
const buttonCount = (html: string) => (html.match(/<button/g) ?? []).length;

const inputCount = (html: string) => (html.match(/<input/g) ?? []).length;
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");

describe("완료된 세션(읽기 전용) 세트 행", () => {
  it("입력칸을 렌더하지 않는다(disabled 로 남기지 않는다)", () => {
    const html = render({ readOnly: true, draft: draft() });

    expect(inputCount(html)).toBe(0);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("완료 처리");
  });

  it("기록이 있으면 마지막 기록값을 요약행으로 보여준다", () => {
    const html = render({ readOnly: true, draft: draft() });
    expect(visibleText(html)).toContain("기록 62.5kg × 9회");
    expect(html).toContain('<span class="font-mono tabular-nums">62.5</span>kg');
  });

  it("기록이 없으면 종료 상태를 문구로 알린다(미시작 운동처럼 보이지 않게)", () => {
    const html = render({ readOnly: true });

    expect(inputCount(html)).toBe(0);
    expect(html).toContain("종료한 운동이라 입력할 수 없어요.");
  });

  it("진행 중인 세션에서는 입력칸이 그대로 있다", () => {
    expect(inputCount(render({ readOnly: false }))).toBeGreaterThan(0);
  });

  it("축약 행이 버튼이 아니다 — 펼칠 수 없다(AC-SET-9)", () => {
    expect(buttonCount(render({ readOnly: true, draft: draft() }))).toBe(0);
  });
});
