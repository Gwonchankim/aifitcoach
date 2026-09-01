import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import { RULES_BUNDLE_V1, RULES_BUNDLE_V1_ASSIST } from "../src/rules-version";
import type { RecommendationInput } from "../src/types";

/**
 * F-2 어시스트 엔진 계약. golden 이 덮지 않는 축(`recommended_action`, generic 금지, 회귀)을 본다.
 *
 * safety matrix 5축 중 **`reason`·`state`·`weight`·`action` 4축이 이 티켓 범위**다.
 * 다섯째 축인 **확정 render copy 는 web 소유**(`f-web-dexie-v4`)라 여기서 만들지 않는다 —
 * 이 티켓은 Dexie·UI 를 건드리지 않는다.
 */

const ASSISTED = {
  type: "compound",
  region: "upper",
  step_kg: 2.5,
  load_semantics: "assistance",
} as const;
const TARGET = { reps_low: 8, reps_high: 12, rir: 2 };

function ask(over: Partial<RecommendationInput>): ReturnType<typeof recommendNextSet> {
  return recommendNextSet({
    goal: "hypertrophy",
    exercise: ASSISTED,
    target: TARGET,
    last_sets: [{ w: 20, reps: 10, rir: 2 }],
    assistance: { has_valid_positive_assistance: true },
    rules_version: RULES_BUNDLE_V1_ASSIST,
    ...over,
  } as RecommendationInput);
}

const ASSISTANCE_REASONS = [
  "ASSISTANCE_CALIBRATION_NEEDED",
  "ASSISTANCE_DOWN_REP_TARGET_MET",
  "ASSISTANCE_DOWN_RIR_EASY",
  "ASSISTANCE_UP_RIR_HARD",
  "ASSISTANCE_UP_TOO_HARD",
  "ASSISTANCE_MINIMUM_REACHED",
];
const GENERIC_WEIGHTED_REASONS = [
  "WEIGHT_UP_REP_TARGET_MET",
  "RIR_TOO_EASY_INCREASE",
  "RIR_TOO_HARD_REDUCE",
  "BASELINE",
  "LOAD_CALIBRATION_NEEDED",
];

describe("safety matrix — pain (축 4종)", () => {
  const r = ask({ safety: { pain_score: 4 } });

  it("reason 축", () => expect(r.reason_code).toBe("SUBSTITUTE_PAIN"));
  it("state 축", () => expect(r.recommendation_state).toBe("substitution_required"));
  it("weight 축 — 도움 kg 을 숨긴다", () => expect(r.weight).toBeNull());
  it("action 축 — safety 에서는 항상 null", () => expect(r.recommended_action).toBeNull());
  it("load_kind 는 assistance 를 유지한다", () => expect(r.load_kind).toBe("assistance"));
});

describe("safety matrix — invalid (축 4종)", () => {
  const r = ask({ exercise: { ...ASSISTED, step_kg: 0 } });

  it("reason 축", () => expect(r.reason_code).toBe("INVALID_INPUT"));
  it("state 축", () => expect(r.recommendation_state).toBe("unavailable"));
  it("weight 축", () => expect(r.weight).toBeNull());
  it("action 축", () => expect(r.recommended_action).toBeNull());
});

describe("safety matrix — latest decrypt 실패도 unavailable 이다", () => {
  it("복호화 실패는 '통증 없음'이 아니다", () => {
    const r = ask({ safety: { pain_failure_code: "decrypt_failed" } });
    expect({ reason: r.reason_code, state: r.recommendation_state, weight: r.weight }).toEqual({
      reason: "INVALID_INPUT",
      state: "unavailable",
      weight: null,
    });
  });
});

describe("최소 경계", () => {
  const r = ask({ last_sets: [{ w: 2.5, reps: 12 }] });

  it("0·음수를 만들지 않고 유지한다", () => expect(r.weight).toBe(2.5));
  it("reason 은 최소 경계다", () => expect(r.reason_code).toBe("ASSISTANCE_MINIMUM_REACHED"));
  it("전환은 제안만 한다 — 자동으로 바꾸지 않는다", () => {
    expect(r.recommended_action).toEqual({
      kind: "suggest_exercise_swap",
      exercise_id: "e_pullup",
    });
  });
  it("state 는 ready 다 — 정상 처방이다", () => expect(r.recommendation_state).toBe("ready"));

  it("한 스텝 더 줄일 수 있으면 최소 경계가 아니다", () => {
    const next = ask({ last_sets: [{ w: 5, reps: 12 }] });
    expect(next.reason_code).toBe("ASSISTANCE_DOWN_REP_TARGET_MET");
    expect(next.weight).toBe(2.5);
    expect(next.recommended_action).toBeUndefined();
  });
});

describe("generic sign flip 금지", () => {
  const scenarios: Array<[string, Partial<RecommendationInput>]> = [
    ["상단 도달", { last_sets: [{ w: 20, reps: 12 }] }],
    ["RIR 쉬움", { calibration: { rir_bias: 0 }, last_sets: [{ w: 20, reps: 10, rir: 4 }] }],
    ["RIR 힘듦", { calibration: { rir_bias: 0 }, last_sets: [{ w: 20, reps: 8, rir: 0 }] }],
    ["하단 미달", { last_sets: [{ w: 20, reps: 6 }] }],
    ["무이력", { last_sets: [], assistance: { has_valid_positive_assistance: false } }],
  ];

  it.each(scenarios)("%s 에서 generic weighted reason 이 나오지 않는다", (_label, over) => {
    expect(GENERIC_WEIGHTED_REASONS).not.toContain(ask(over).reason_code);
  });

  it("두 safety state 에서 assistance 방향 코드가 나오지 않는다", () => {
    expect(ASSISTANCE_REASONS).not.toContain(ask({ safety: { pain_score: 5 } }).reason_code);
    expect(ASSISTANCE_REASONS).not.toContain(
      ask({ exercise: { ...ASSISTED, step_kg: 0 } }).reason_code,
    );
  });

  it("어떤 경로도 0 이나 음수 도움을 추천하지 않는다", () => {
    for (const [, over] of scenarios) {
      const w = ask(over).weight;
      if (w !== null) expect(w).toBeGreaterThan(0);
    }
  });
});

describe("lifetime graduation evidence 는 최신 세션으로 퇴행하지 않는다", () => {
  it("최신이 통증이어도 과거 valid positive 는 지워지지 않는다", () => {
    const painful = ask({ safety: { pain_score: 5 } });
    expect(painful.reason_code).toBe("SUBSTITUTE_PAIN");
    // 통증이 가시면 캘리브레이션으로 되돌아가지 않고 바로 진행한다.
    const recovered = ask({ last_sets: [{ w: 20, reps: 12 }] });
    expect(recovered.reason_code).toBe("ASSISTANCE_DOWN_REP_TARGET_MET");
  });

  it("최신 세션이 비어도 lifetime evidence 가 있으면 캘리브레이션이 아니다", () => {
    // 최근 완료 세션이 없더라도 graduation 은 lifetime 질의 결과다.
    expect(ask({ last_sets: [] }).reason_code).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
  });
});

describe("활성 2026.08.1 의미 불변", () => {
  it("legacy 는 같은 입력을 일반 가중 운동으로 해석한다", () => {
    const legacy = recommendNextSet({
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: TARGET,
      last_sets: [{ w: 20, reps: 12 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1,
    } as RecommendationInput);
    expect(legacy.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
    expect(legacy.weight).toBe(22.5);
    expect(legacy.load_kind).toBe("external");
  });
});
