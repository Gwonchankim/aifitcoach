import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import { RULES_BUNDLE_V1, RULES_BUNDLE_V1_ASSIST } from "../src/rules-version";
import type { PerformedSet, RecommendationInput } from "../src/types";

/**
 * F fixup-code-review-02 항목 1.
 *
 * 어시스트는 **최신 세션 raw 를 all-or-nothing 으로 본다.** generic 은 이상한 세트를
 * 걸러내고 나머지로 계산해도 되지만, 어시스트에서 그러면 **한 세트만 살아남아 "상단 도달"**
 * 로 읽혀 도움이 줄어든다 — 못 믿을 세션에서 처방을 만들어내는 셈이다.
 */

const ASSISTED = {
  type: "compound",
  region: "upper",
  step_kg: 2.5,
  load_semantics: "assistance",
} as const;
const GENERIC = { type: "compound", region: "upper", step_kg: 2.5 } as const;
const BODYWEIGHT = { type: "compound", region: "upper", step_kg: null, metric: "reps" } as const;
const TIME = { type: "isolation", region: "core", step_kg: null, metric: "time" } as const;
const TARGET = { reps_low: 8, reps_high: 12, rir: 2 };

function assisted(sets: PerformedSet[]): ReturnType<typeof recommendNextSet> {
  return recommendNextSet({
    goal: "hypertrophy",
    exercise: ASSISTED,
    target: TARGET,
    last_sets: sets,
    assistance: { has_valid_positive_assistance: true },
    rules_version: RULES_BUNDLE_V1_ASSIST,
  } as RecommendationInput);
}

const FAIL_CLOSED = {
  state: "unavailable",
  reason: "INVALID_INPUT",
  weight: null,
  action: null,
};

function shape(r: ReturnType<typeof recommendNextSet>) {
  return {
    state: r.recommendation_state,
    reason: r.reason_code,
    weight: r.weight,
    action: r.recommended_action ?? null,
  };
}

describe("fixup2-1 · 최신 세션에 못 믿을 세트가 하나라도 있으면 전부 무효다", () => {
  const bad: Array<[string, PerformedSet[]]> = [
    ["무게 누락", [{ reps: 10, rir: 2 }]],
    ["무게 0", [{ w: 0, reps: 10, rir: 2 }]],
    ["무게 음수", [{ w: -2.5, reps: 10, rir: 2 }]],
    ["무게 NaN", [{ w: Number.NaN, reps: 10, rir: 2 }]],
    ["무게 Infinity", [{ w: Number.POSITIVE_INFINITY, reps: 10, rir: 2 }]],
    ["반복 0", [{ w: 20, reps: 0, rir: 2 }]],
    ["반복 음수", [{ w: 20, reps: -3, rir: 2 }]],
    ["반복 NaN", [{ w: 20, reps: Number.NaN, rir: 2 }]],
    ["반복 소수", [{ w: 20, reps: 10.5, rir: 2 }]],
    ["반복 누락", [{ w: 20, rir: 2 }]],
    ["RIR NaN", [{ w: 20, reps: 10, rir: Number.NaN }]],
    ["RIR Infinity", [{ w: 20, reps: 10, rir: Number.POSITIVE_INFINITY }]],
    ["RIR 음수", [{ w: 20, reps: 10, rir: -1 }]],
    ["RIR 범위 밖", [{ w: 20, reps: 10, rir: 11 }]],
  ];

  it.each(bad)("%s → unavailable / INVALID_INPUT / null / null", (_label, sets) => {
    expect(shape(assisted(sets))).toEqual(FAIL_CLOSED);
  });
});

describe("fixup2-1 · 혼합 세션은 양방향 모두 무효다", () => {
  it("invalid → valid 순서", () => {
    expect(
      shape(
        assisted([
          { w: 0, reps: 10, rir: 2 },
          { w: 20, reps: 12, rir: 2 },
        ]),
      ),
    ).toEqual(FAIL_CLOSED);
  });

  it("valid → invalid 순서", () => {
    expect(
      shape(
        assisted([
          { w: 20, reps: 12, rir: 2 },
          { w: 0, reps: 10, rir: 2 },
        ]),
      ),
    ).toEqual(FAIL_CLOSED);
  });

  /**
   * **순서가 실제로 중요한 케이스다.**
   * 아래 무효 세트들은 `toWorkingSets` 가 **통째로 버린다**. 걸러낸 뒤에 검증하면
   * 정상 세트만 남아 validator 를 통과하고 처방이 나온다 — 그래서 검증은
   * `toWorkingSets` **호출보다 앞**에 있어야 한다.
   */
  const droppedByFilter: Array<[string, PerformedSet[]]> = [
    [
      "반복 0(필터가 버림) + 정상",
      [
        { w: 20, reps: 0, rir: 2 },
        { w: 20, reps: 12, rir: 2 },
      ],
    ],
    [
      "정상 + 반복 0(필터가 버림)",
      [
        { w: 20, reps: 12, rir: 2 },
        { w: 20, reps: 0, rir: 2 },
      ],
    ],
    [
      "무게 음수(필터가 버림) + 정상",
      [
        { w: -5, reps: 10, rir: 2 },
        { w: 20, reps: 12, rir: 2 },
      ],
    ],
    [
      "무게 NaN(필터가 버림) + 정상",
      [
        { w: Number.NaN, reps: 10, rir: 2 },
        { w: 20, reps: 12, rir: 2 },
      ],
    ],
    [
      "반복 누락(필터가 버림) + 정상",
      [
        { w: 20, rir: 2 },
        { w: 20, reps: 12, rir: 2 },
      ],
    ],
  ];

  it.each(droppedByFilter)("%s → 여전히 무효다(필터 후 판정이면 통과해버린다)", (_label, sets) => {
    expect(shape(assisted(sets))).toEqual(FAIL_CLOSED);
  });

  it("살아남은 세트로 '상단 도달'을 만들어내지 않는다", () => {
    // 걸러내기 방식이면 valid 한 세트 하나만 남아 hitTop → 도움 감소가 된다.
    const r = assisted([
      { w: 20, reps: 12, rir: 2 },
      { reps: 3, rir: 2 },
    ]);
    expect(r.reason_code).not.toBe("ASSISTANCE_DOWN_REP_TARGET_MET");
    expect(r.weight).toBeNull();
  });
});

describe("fixup4 · 못 믿을 raw + 통증이 겹치면", () => {
  const mixed: PerformedSet[] = [
    { w: 0, reps: 10, rir: 2 },
    { w: 20, reps: 12, rir: 2 },
  ];

  function painful(sets: PerformedSet[]): ReturnType<typeof recommendNextSet> {
    return recommendNextSet({
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: TARGET,
      last_sets: sets,
      safety: { pain_score: 5 },
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    } as RecommendationInput);
  }

  it("통증이 우선한다 — 4축은 그대로다", () => {
    const r = painful(mixed);
    expect(shape(r)).toEqual({
      state: "substitution_required",
      reason: "SUBSTITUTE_PAIN",
      weight: null,
      action: null,
    });
    expect(r.suggest_substitution).toBe(true);
  });

  it("못 믿을 raw 에서 신뢰도를 끌어올리지 않는다 — baseline 이다", () => {
    // 걸러낸 세트로 confidence 를 매기면 "RIR 다 있음 = 0.85" 가 되어
    // 신뢰할 수 없는 세션이 오히려 높은 신뢰도를 받는다.
    expect(painful(mixed).confidence).toBe(0.5);
  });

  it("raw 가 유효하면 통증 경로 신뢰도는 그대로다", () => {
    expect(painful([{ w: 20, reps: 12, rir: 2 }]).confidence).toBe(0.85);
    expect(painful([{ w: 20, reps: 12 }]).confidence).toBe(0.7);
  });

  it("raw 무효 + 통증 없음이면 여전히 fail-closed 다", () => {
    expect(shape(assisted(mixed))).toEqual(FAIL_CLOSED);
  });
});

describe("fixup2-1 · 정상 세션은 그대로 진행한다", () => {
  it("경계값 RIR 0 과 10 은 유효하다", () => {
    expect(assisted([{ w: 20, reps: 12, rir: 0 }]).recommendation_state).not.toBe("unavailable");
    expect(assisted([{ w: 20, reps: 12, rir: 10 }]).recommendation_state).not.toBe("unavailable");
  });

  it("RIR 이 아예 없는 세트는 유효하다 — nullable 이다", () => {
    expect(assisted([{ w: 20, reps: 12 }]).reason_code).toBe("ASSISTANCE_DOWN_REP_TARGET_MET");
  });
});

describe("fixup2-1 · generic·맨몸·시간 필터 의미는 그대로다", () => {
  const base = { goal: "hypertrophy" as const, target: TARGET };

  it("generic 은 reps<=0 세트를 걸러내고 나머지로 계산한다(GC-17 계약)", () => {
    const r = recommendNextSet({
      ...base,
      exercise: GENERIC,
      last_sets: [
        { w: 60, reps: 0, rir: 2 },
        { w: 60, reps: 10, rir: 2 },
      ],
      rules_version: RULES_BUNDLE_V1,
    } as RecommendationInput);
    expect(r.recommendation_state).toBe("ready");
    expect(r.reason_code).toBe("ADD_ONE_REP");
  });

  it("맨몸은 무게가 없어도 정상이다", () => {
    const r = recommendNextSet({
      ...base,
      exercise: BODYWEIGHT,
      target: { reps_low: 6, reps_high: 15, rir: 2 },
      last_sets: [{ reps: 10, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    } as RecommendationInput);
    expect(r.recommendation_state).toBe("ready");
  });

  it("시간 종목은 time_sec<=0 을 걸러내고 나머지로 계산한다", () => {
    const r = recommendNextSet({
      ...base,
      exercise: TIME,
      target: { time_low_sec: 20, time_high_sec: 60 },
      last_sets: [{ time_sec: 0 }, { time_sec: 45 }],
      rules_version: RULES_BUNDLE_V1,
    } as RecommendationInput);
    expect(r.reason_code).toBe("TIME_HOLD");
  });

  it("legacy 2026.08.1 은 어시스트 종목이어도 generic 필터를 쓴다", () => {
    const r = recommendNextSet({
      ...base,
      exercise: ASSISTED,
      last_sets: [
        { w: 60, reps: 0, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
      ],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1,
    } as RecommendationInput);
    expect(r.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
  });
});
