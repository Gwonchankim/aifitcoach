import { describe, expect, it } from "vitest";
import { provenanceFor } from "../src/assistance";
import { recommendNextSet } from "../src/recommend";
import {
  RULES_BUNDLE_V1_ASSIST,
  RULES_BUNDLE_V2,
  RULES_BUNDLE_V2_SPLIT,
  SUPPORTED_RULES_BUNDLES,
  isV2RulesBundle,
  resolveRulesBundle,
  supportsAssistance,
} from "../src/rules-version";
import type { PerformedSet, RecommendationInput } from "../src/types";

/**
 * F fixup-code-review-01. 독립 리뷰가 잡은 세 결함을 고정한다.
 * 이 파일이 통과한다고 부모 티켓이 닫히는 것은 아니다 — root gate 는 여전히 Docker 를 기다린다.
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

// ---------------------------------------------------------------- 1) .09.1

describe("fixup-1 · 2026.09.1 은 지원 bundle 이다", () => {
  it("supported union 은 정확히 4값이다", () => {
    expect([...SUPPORTED_RULES_BUNDLES]).toEqual([
      "2026.08.1",
      "2026.08.2",
      "2026.09.0",
      "2026.09.1",
    ]);
  });

  it("resolve 되고 throw 하지 않는다", () => {
    expect(resolveRulesBundle(RULES_BUNDLE_V2_SPLIT)).toBe("2026.09.1");
  });

  it("V2 정책이고 어시스트를 안다", () => {
    expect(isV2RulesBundle(RULES_BUNDLE_V2_SPLIT)).toBe(true);
    expect(supportsAssistance(RULES_BUNDLE_V2_SPLIT)).toBe(true);
  });

  it("provenance 는 native 다", () => {
    expect(
      provenanceFor({ rulesVersion: RULES_BUNDLE_V2_SPLIT, hasServerAppliedPerformedFact: false }),
    ).toBe("native");
  });

  it("unknown 은 여전히 fail closed 다", () => {
    for (const v of ["2026.09.2", "2026.10.0", "2026.9.1", ""]) {
      expect(() => resolveRulesBundle(v), v).toThrow(RangeError);
    }
  });
});

describe("fixup-1 · assistance parity — 세 버전이 같은 결과를 낸다", () => {
  const versions = [RULES_BUNDLE_V1_ASSIST, RULES_BUNDLE_V2, RULES_BUNDLE_V2_SPLIT];
  const scenarios: Array<[string, Partial<RecommendationInput>]> = [
    ["상단 도달", { last_sets: [{ w: 20, reps: 12 }] }],
    ["하단 미달", { last_sets: [{ w: 20, reps: 6 }] }],
    ["RIR 쉬움", { calibration: { rir_bias: 0 }, last_sets: [{ w: 20, reps: 10, rir: 4 }] }],
    ["최소 경계", { last_sets: [{ w: 2.5, reps: 12 }] }],
    ["무이력", { last_sets: [], assistance: { has_valid_positive_assistance: false } }],
    ["통증", { safety: { pain_score: 5 } }],
  ];

  it.each(scenarios)("%s — rules_version 만 다르다", (_label, over) => {
    const [first, ...rest] = versions.map((v) => {
      const { rules_version: _ignored, ...rest2 } = ask({ ...over, rules_version: v });
      return rest2;
    });
    for (const other of rest) expect(other).toEqual(first);
  });
});

// -------------------------------------------------- 2) usable latest 없음

describe("fixup-2 · lifetime evidence 가 있어도 쓸 수 있는 최신 세트가 없으면 unavailable", () => {
  const unusable: Array<[string, PerformedSet[]]> = [
    ["빈 배열", []],
    ["무게 누락", [{ reps: 10 }]],
    ["도움 0", [{ w: 0, reps: 10 }]],
    ["도움 음수", [{ w: -5, reps: 10 }]],
    ["도움 nonfinite", [{ w: Number.NaN, reps: 10 }]],
    ["반복 0", [{ w: 20, reps: 0 }]],
  ];

  it.each(unusable)("%s → unavailable / INVALID_INPUT / null", (_label, sets) => {
    const r = ask({ last_sets: sets });
    expect({
      state: r.recommendation_state,
      reason: r.reason_code,
      weight: r.weight,
      action: r.recommended_action ?? null,
    }).toEqual({
      state: "unavailable",
      reason: "INVALID_INPUT",
      weight: null,
      action: null,
    });
  });

  it("숫자를 발명하지 않는다 — 0kg 도 ready 도 나오지 않는다", () => {
    for (const [, sets] of unusable) {
      const r = ask({ last_sets: sets });
      expect(r.weight).not.toBe(0);
      expect(r.recommendation_state).not.toBe("ready");
    }
  });

  it("캘리브레이션으로 퇴행하지는 않는다 — lifetime evidence 는 남아 있다", () => {
    for (const [, sets] of unusable) {
      expect(ask({ last_sets: sets }).reason_code).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
    }
  });

  it("lifetime evidence 가 없으면 여전히 캘리브레이션이다", () => {
    expect(
      ask({ last_sets: [], assistance: { has_valid_positive_assistance: false } }).reason_code,
    ).toBe("ASSISTANCE_CALIBRATION_NEEDED");
  });
});

// ------------------------------------------------------- 3) corrected RIR

describe("fixup-3 · calibration 이 있으면 corrected RIR 하나로 판정한다", () => {
  it("raw 0 + bias 2 → corrected 2 = on target → 더블 프로그레션", () => {
    const r = ask({
      calibration: { rir_bias: 2 },
      last_sets: [{ w: 20, reps: 10, rir: 0 }],
    });
    expect(r.reason_code).toBe("ADD_ONE_REP");
    expect(r.reps_low).toBe(11);
  });

  it("raw 4 + bias -2 → corrected 2 = on target → 더블 프로그레션", () => {
    const r = ask({
      calibration: { rir_bias: -2 },
      last_sets: [{ w: 20, reps: 10, rir: 4 }],
    });
    expect(r.reason_code).toBe("ADD_ONE_REP");
  });

  it("corrected 가 낮으면 도움 증가다", () => {
    expect(
      ask({ calibration: { rir_bias: 0 }, last_sets: [{ w: 20, reps: 10, rir: 0 }] }).reason_code,
    ).toBe("ASSISTANCE_UP_RIR_HARD");
  });

  it("corrected on-target 이어도 반복 하단 미달이면 여전히 도움 증가다", () => {
    expect(
      ask({ calibration: { rir_bias: 2 }, last_sets: [{ w: 20, reps: 6, rir: 0 }] }).reason_code,
    ).toBe("ASSISTANCE_UP_TOO_HARD");
  });

  it("calibration 이 없으면 raw 로 보수적 유지 — 이 동작은 바뀌지 않는다", () => {
    expect(ask({ last_sets: [{ w: 20, reps: 10, rir: 0 }] }).reason_code).toBe("HOLD_RIR_LOW");
  });
});
