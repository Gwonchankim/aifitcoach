import { describe, expect, it } from "vitest";
import goldenJson from "../../../docs/specs/golden_tests.json";
import { recommendNextSet } from "../src/recommend";
import type { ReasonCode, RecommendationInput } from "../src/types";

/**
 * 추천 엔진 계약 테스트. docs/specs/golden_tests.json을 직접 로드해 케이스별로 실행한다.
 * 비교 규칙은 docs/GOLDEN_TESTS.md를 따른다. 케이스를 이 파일에 복사하지 말 것.
 */

interface GoldenCase {
  id: string;
  input: Omit<RecommendationInput, "rules_version">;
  expect: {
    /** null = 자체중량(맨몸)·시간 종목 — 추가 부하 없음. */
    weight?: number | null;
    reps_low?: number;
    reps_high?: number;
    time_low_sec?: number;
    time_high_sec?: number;
    reason_code?: ReasonCode;
    reason_code_in?: ReasonCode[];
    e1rm?: number;
    e1rm_tolerance?: number;
    confidence_max?: number;
    suggest_substitution?: boolean;
  };
}

const golden = goldenJson as unknown as {
  rules_version: string;
  defaults: { e1rm_tolerance: number };
  cases: GoldenCase[];
};

/** 러너가 검증할 줄 아는 expect 키. 계약 파일에 새 키가 생기면 조용히 넘어가지 않고 실패한다. */
const KNOWN_EXPECT_KEYS = [
  "weight",
  "reps_low",
  "reps_high",
  "time_low_sec",
  "time_high_sec",
  "reason_code",
  "reason_code_in",
  "e1rm",
  "e1rm_tolerance",
  "confidence_max",
  "suggest_substitution",
  "note",
];

function unknownExpectKeys(expected: object): string[] {
  return Object.keys(expected).filter((k) => !KNOWN_EXPECT_KEYS.includes(k));
}

describe("golden_tests.json", () => {
  it("계약 파일이 케이스를 담고 있다", () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  it("미지의 expect 키 감지기가 실제로 동작한다", () => {
    expect(unknownExpectKeys({ weight: 60, note: "x" })).toEqual([]);
    expect(unknownExpectKeys({ weight: 60, sets_max: 4 })).toEqual(["sets_max"]);
  });

  for (const c of golden.cases) {
    it(c.id, () => {
      // 러너가 모르는 키가 계약에 추가되면 조용히 통과시키지 않는다.
      expect(unknownExpectKeys(c.expect)).toEqual([]);

      const out = recommendNextSet({ ...c.input, rules_version: golden.rules_version });

      expect(out.rules_version).toBe(golden.rules_version);

      if (c.expect.weight !== undefined) expect(out.weight).toBe(c.expect.weight);
      if (c.expect.reps_low !== undefined) expect(out.reps_low).toBe(c.expect.reps_low);
      if (c.expect.reps_high !== undefined) expect(out.reps_high).toBe(c.expect.reps_high);
      if (c.expect.time_low_sec !== undefined) expect(out.time_low_sec).toBe(c.expect.time_low_sec);
      if (c.expect.time_high_sec !== undefined) {
        expect(out.time_high_sec).toBe(c.expect.time_high_sec);
      }
      if (c.expect.reason_code !== undefined) expect(out.reason_code).toBe(c.expect.reason_code);
      if (c.expect.reason_code_in !== undefined) {
        expect(c.expect.reason_code_in).toContain(out.reason_code);
      }
      if (c.expect.e1rm !== undefined) {
        const tol = c.expect.e1rm_tolerance ?? golden.defaults.e1rm_tolerance;
        expect(out.e1rm).toBeDefined();
        expect(Math.abs((out.e1rm as number) - c.expect.e1rm)).toBeLessThanOrEqual(tol);
      }
      if (c.expect.confidence_max !== undefined) {
        expect(out.confidence).toBeLessThanOrEqual(c.expect.confidence_max);
      }
      if (c.expect.suggest_substitution !== undefined) {
        expect(out.suggest_substitution).toBe(c.expect.suggest_substitution);
      }
    });
  }
});

describe("결정론", () => {
  it("같은 입력을 100회 실행해도 출력이 동일하다", () => {
    const input: RecommendationInput = {
      ...golden.cases[0]!.input,
      rules_version: golden.rules_version,
    };
    const first = JSON.stringify(recommendNextSet(input));
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(recommendNextSet(input))).toBe(first);
    }
  });

  it("모든 골든 케이스가 입력 객체를 변형하지 않는다", () => {
    for (const c of golden.cases) {
      const input: RecommendationInput = { ...c.input, rules_version: golden.rules_version };
      const snapshot = JSON.stringify(input);
      recommendNextSet(input);
      expect(JSON.stringify(input), c.id).toBe(snapshot);
    }
  });

  it("입력 객체를 변형하지 않는다", () => {
    const input: RecommendationInput = {
      goal: "hypertrophy",
      exercise: { type: "compound", region: "upper", step_kg: 2.5 },
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      last_sets: [{ w: 60, reps: 12, rir: 2 }],
      rules_version: "2026.07.1",
    };
    const snapshot = JSON.stringify(input);
    recommendNextSet(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
