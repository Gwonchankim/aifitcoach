/**
 * F-4b — 어시스트 렌더링과 §F safety copy.
 *
 * 어시스트 숫자는 **기계가 덜어주는 kg** 이다. generic weighted 문구를 그대로 쓰면
 * "20kg 로 올렸어요" 가 되어 사용자가 **정반대로** 읽는다. 그래서 표시는 `도움 20kg` 이고
 * 두 safety state 에서는 prefill 과 증감 copy 를 **숨긴다**.
 *
 * copy 는 governing artifact 의 확정 문구다 — 한 글자도 다르면 계약 위반이다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetRow } from "../components/session/SetRow";
import type { PlannedSet } from "../lib/api";
import {
  ASSISTANCE_INVALID_COPY,
  ASSISTANCE_PAIN_COPY,
  assistanceAction,
  assistanceBadge,
  assistanceSafetyCopy,
  isAssistanceSet,
  nonNegativeWeight,
  setKind,
  setPrefill,
  reasonLabel,
} from "../components/session/set-rules";

function assisted(overrides: Partial<PlannedSet> = {}): PlannedSet {
  return {
    id: "ps-1",
    exercise_id: "e_assisted_pullup",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 20,
    recommended_reps: 8,
    reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.2",
    load_kind: "assistance",
    recommendation_state: "ready",
    assistance_provenance: "native",
    recommended_action: null,
    assistance_safety_status: "safe",
    recommendation_gate: "ready",
    performed_set: null,
    ...overrides,
  } as PlannedSet;
}

const PAIN = assisted({
  recommendation_state: "substitution_required",
  reason_code: "SUBSTITUTE_PAIN",
  recommended_weight: null,
  recommended_action: null,
});
const INVALID = assisted({
  recommendation_state: "unavailable",
  reason_code: "INVALID_INPUT",
  recommended_weight: null,
  recommended_action: null,
});

/**
 * **fail-closed 소비 fixture.** 서버 계약상 안전 상태의 weight·action 은 null 이지만,
 * 구버전·롤링 배포 서버는 값을 실어 보낼 수 있다. 클라이언트는 그 값을 쓰면 안 된다 —
 * weight 가 null 인 행만 쓰면 "숨김"이 kind 판정의 부수효과일 뿐 검증된 규칙이 아니다.
 */
const PAIN_WITH_WEIGHT = assisted({
  recommendation_state: "substitution_required",
  reason_code: "SUBSTITUTE_PAIN",
  recommended_weight: 20,
  recommended_action: { kind: "suggest_exercise_swap", exercise_id: "e_pullup" },
});
const INVALID_WITH_WEIGHT = assisted({
  recommendation_state: "unavailable",
  reason_code: "INVALID_INPUT",
  recommended_weight: 20,
});

describe("어시스트 인지 표시", () => {
  it("도움 20kg 으로 표시한다 — 부하가 아니다", () => {
    expect(assistanceBadge(assisted())).toEqual({
      text: "도움 20kg",
      label: "기계가 덜어주는 무게 20킬로그램",
    });
  });

  it("소수점은 한 자리로 접는다", () => {
    expect(assistanceBadge(assisted({ recommended_weight: 22.5 }))?.text).toBe("도움 22.5kg");
  });

  it("음수는 표시하지 않는다 — 도움이 음수라는 것은 있을 수 없다", () => {
    expect(assistanceBadge(assisted({ recommended_weight: -5 }))).toBeNull();
  });

  it("0 도 표시하지 않는다 — 0 도움은 맨몸이라 어시스트 처방이 아니다", () => {
    expect(assistanceBadge(assisted({ recommended_weight: 0 }))).toBeNull();
  });

  it("어시스트가 아닌 행에는 도움 배지가 없다", () => {
    expect(assistanceBadge(assisted({ load_kind: "external" }))).toBeNull();
  });

  it("load_kind 로 어시스트를 판별한다", () => {
    expect(isAssistanceSet(assisted())).toBe(true);
    expect(isAssistanceSet(assisted({ load_kind: "external" }))).toBe(false);
  });
});

describe("§F safety copy — 확정 문구", () => {
  it("pain >= 4 는 중단·대체 안내다", () => {
    expect(assistanceSafetyCopy(PAIN)).toBe(
      "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.",
    );
    expect(ASSISTANCE_PAIN_COPY).toBe(
      "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.",
    );
  });

  it("invalid / latest 복호화 실패는 재시도 안내다", () => {
    expect(assistanceSafetyCopy(INVALID)).toBe("입력값을 확인한 뒤 다시 시도하세요.");
    expect(ASSISTANCE_INVALID_COPY).toBe("입력값을 확인한 뒤 다시 시도하세요.");
  });

  it("안전 상태가 아니면 safety copy 가 없다", () => {
    expect(assistanceSafetyCopy(assisted())).toBeNull();
  });

  it("어시스트가 아닌 행에는 이 copy 를 쓰지 않는다 — 축이 다르다", () => {
    expect(
      assistanceSafetyCopy(
        assisted({ load_kind: "external", recommendation_state: "unavailable" }),
      ),
    ).toBeNull();
  });
});

describe("두 safety state 에서 축을 숨긴다", () => {
  it.each([
    ["통증", PAIN_WITH_WEIGHT],
    ["입력 오류", INVALID_WITH_WEIGHT],
  ])("%s 상태는 서버가 무게를 실어 보내도 prefill 하지 않는다", (_label, set) => {
    expect(setPrefill(setKind(set, "reps", 2.5), set).weight).toBeNull();
  });

  it.each([
    ["통증", PAIN_WITH_WEIGHT],
    ["입력 오류", INVALID_WITH_WEIGHT],
  ])("%s 상태는 무게가 실려 와도 도움 배지를 숨긴다", (_label, set) => {
    expect(assistanceBadge(set)).toBeNull();
  });

  it("안전 상태에서는 recommended_action 도 쓰지 않는다 — 최소 경계 전용이다", () => {
    expect(assistanceAction(PAIN_WITH_WEIGHT)).toBeNull();
    expect(
      assistanceAction(
        assisted({
          reason_code: "ASSISTANCE_MINIMUM_REACHED",
          recommended_action: { kind: "suggest_exercise_swap", exercise_id: "e_pullup" },
        }),
      ),
    ).toEqual({ kind: "suggest_exercise_swap", exercise_id: "e_pullup" });
  });

  it.each([
    ["통증", PAIN_WITH_WEIGHT],
    ["입력 오류", INVALID_WITH_WEIGHT],
  ])("%s 상태는 증감 copy 를 쓰지 않는다", (_label, set) => {
    // generic weighted 진행 문구가 여기 실리면 "무게를 올렸어요" 가 안전 안내를 덮는다.
    const label = reasonLabel(set.reason_code ?? "", setKind(set, "reps", 2.5), set);
    expect(label).toBe(assistanceSafetyCopy(set));
  });
});

describe("어시스트 진행 문구는 generic weighted 로 되돌아가지 않는다", () => {
  it.each([
    ["ASSISTANCE_DOWN_REP_TARGET_MET", "목표를 채워서 도움을 한 단계 줄여요"],
    ["ASSISTANCE_UP_TOO_HARD", "버거워 보여 도움을 한 단계 늘려요"],
    ["ASSISTANCE_MINIMUM_REACHED", "도움을 더 줄이기 어려워요. 현재 도움 무게를 유지해요"],
    ["ASSISTANCE_CALIBRATION_NEEDED", "기계에서 편한 도움 무게를 직접 정해요"],
  ])("%s 는 도움 축 문구다", (code, expected) => {
    const set = assisted({ reason_code: code });
    expect(reasonLabel(code, setKind(set, "reps", 2.5), set)).toBe(expected);
  });

  it("어시스트 행에 generic weighted 문구가 붙지 않는다", () => {
    const set = assisted({ reason_code: "WEIGHT_UP_REP_TARGET_MET" });
    expect(reasonLabel("WEIGHT_UP_REP_TARGET_MET", setKind(set, "reps", 2.5), set)).toBeNull();
  });

  it("어시스트가 아닌 행의 기존 문구는 그대로다 — 회귀 없음", () => {
    expect(reasonLabel("WEIGHT_UP_REP_TARGET_MET", "weighted")).toBe(
      "지난번 목표 반복을 모두 채워서 무게를 올렸어요",
    );
  });
});

describe("음수 무게는 값으로 인정하지 않는다", () => {
  it("음수는 null 이 된다 — 저장 경로에 들어가지 않는다", () => {
    expect(nonNegativeWeight(-5)).toBeNull();
    expect(nonNegativeWeight(-0.5)).toBeNull();
  });

  it("0 과 양수는 그대로 통과한다 — 0kg 기록 자체는 막지 않는다", () => {
    expect(nonNegativeWeight(0)).toBe(0);
    expect(nonNegativeWeight(22.5)).toBe(22.5);
    expect(nonNegativeWeight(null)).toBeNull();
  });
});

/**
 * **실제 SetRow 렌더 축.** 카드 배지만 `도움` 이고 목표·입력칸이 `추천 20kg`·`무게` 면
 * 같은 숫자가 한 화면에서 부하로도, 도움으로도 읽힌다. 축은 전부 같은 방향이어야 한다.
 */
describe("SetRow — 도움 축이 visible·accessible 전체에서 일관된다", () => {
  const ASSISTED_SET = assisted({ recommended_weight: 20, recommended_reps: 9 });

  function renderRow(set: PlannedSet, kind: "weighted" | "unknown_weight" = "weighted") {
    return renderToStaticMarkup(
      createElement(SetRow, {
        set,
        kind,
        exerciseName: "어시스트 풀업",
        fallbackWeight: null,
        previous: null,
        readOnly: false,
        expanded: false,
        onToggleExpand: () => {},
        onComplete: () => {},
        onEdit: () => {},
        onUncomplete: () => {},
      }),
    );
  }

  const visible = (html: string) => html.replace(/<[^>]*>/g, "");

  it("목표 줄이 `추천 20kg` 이 아니라 `도움 20kg` 이다", () => {
    const text = visible(renderRow(ASSISTED_SET));
    expect(text).toContain("도움 20kg");
    expect(text).not.toContain("추천 20kg");
  });

  it("무게 입력칸의 accessible label 이 도움 축이다", () => {
    const html = renderRow(ASSISTED_SET);
    // 스크린리더에는 이 label 이 축을 아는 유일한 단서다.
    expect(html).toContain("1세트 도움, 킬로그램");
    expect(html).not.toContain("1세트 무게, 킬로그램");
  });

  it("placeholder 도 도움 축이다", () => {
    const html = renderRow(ASSISTED_SET);
    expect(html).toContain('placeholder="도움"');
    expect(html).not.toContain('placeholder="무게"');
  });

  it("어시스트가 아닌 행은 기존 문구 그대로다 — 회귀 없음", () => {
    const plain = assisted({ load_kind: "external", assistance_provenance: null });
    const html = renderRow(plain);
    expect(visible(html)).toContain("추천 20kg");
    expect(html).toContain('placeholder="무게"');
    expect(html).not.toContain("도움");
  });

  it("안전 상태에서는 도움 목표도 숨긴다 — 처방 축 전체가 가려진다", () => {
    const text = visible(renderRow(PAIN_WITH_WEIGHT, "unknown_weight"));
    expect(text).not.toContain("도움 20kg");
    expect(text).not.toContain("추천 20kg");
  });
});
