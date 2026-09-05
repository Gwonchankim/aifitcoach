import { describe, expect, it } from "vitest";
import goldenJson from "../../../docs/specs/golden_tests.json";
import { recommendNextSet } from "../src/recommend";
import type {
  LoadKind,
  ReasonCode,
  RecommendationInput,
  RecommendationState,
  RecommendedAction,
} from "../src/types";

/**
 * 추천 엔진 계약 테스트. docs/specs/golden_tests.json을 직접 로드해 케이스별로 실행한다.
 * 비교 규칙은 docs/GOLDEN_TESTS.md를 따른다. 케이스를 이 파일에 복사하지 말 것.
 */

interface GoldenCase {
  id: string;
  /** 없으면 root rules_version. 있으면 그 버전으로 실행한다(dual-version harness, §4.1). */
  rules_version?: string;
  input: Omit<RecommendationInput, "rules_version">;
  expect: {
    /** null = 자체중량(맨몸)·시간 종목, 또는 V2 external 캘리브레이션 필요 — 추가 부하 없음. */
    weight?: number | null;
    reps_low?: number;
    reps_high?: number;
    time_low_sec?: number;
    time_high_sec?: number;
    reason_code?: ReasonCode;
    reason_code_in?: ReasonCode[];
    load_kind?: LoadKind;
    recommendation_state?: RecommendationState;
    e1rm?: number;
    e1rm_tolerance?: number;
    /** 정확값. calibration 상태의 exact 0 처럼 상한만으로는 못 잡는 계약에 쓴다. */
    confidence?: number;
    confidence_max?: number;
    suggest_substitution?: boolean;
    recommended_action?: RecommendedAction | null;
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
  "load_kind",
  "recommendation_state",
  "e1rm",
  "e1rm_tolerance",
  "confidence",
  "confidence_max",
  "suggest_substitution",
  "recommended_action",
  "note",
];

/** 케이스가 실행될 버전. 케이스 override > root 기본값. */
function versionFor(c: GoldenCase): string {
  return c.rules_version ?? golden.rules_version;
}

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

  it("두 rules_version 을 모두 실행한다", () => {
    // 한 버전만 돌면 병행 지원 계약이 검증되지 않는다(§4.1).
    const versions = new Set(golden.cases.map(versionFor));
    expect(versions.has("2026.08.1")).toBe(true);
    expect(versions.has("2026.09.0")).toBe(true);
  });

  for (const c of golden.cases) {
    const version = versionFor(c);
    it(`${c.id} (${version})`, () => {
      // 러너가 모르는 키가 계약에 추가되면 조용히 통과시키지 않는다.
      expect(unknownExpectKeys(c.expect)).toEqual([]);

      const out = recommendNextSet({ ...c.input, rules_version: version });

      expect(out.rules_version).toBe(version);
      // 두 필드는 모든 경로에서 required다 — 특정 케이스가 기대를 적지 않아도 존재는 검증한다.
      expect(out.load_kind, `${c.id} load_kind`).toBeDefined();
      expect(out.recommendation_state, `${c.id} recommendation_state`).toBeDefined();

      if (c.expect.weight !== undefined) expect(out.weight).toBe(c.expect.weight);
      if (c.expect.recommended_action !== undefined)
        expect(out.recommended_action).toEqual(c.expect.recommended_action);
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
      if (c.expect.load_kind !== undefined) expect(out.load_kind).toBe(c.expect.load_kind);
      if (c.expect.recommendation_state !== undefined) {
        expect(out.recommendation_state).toBe(c.expect.recommendation_state);
      }
      if (c.expect.e1rm !== undefined) {
        const tol = c.expect.e1rm_tolerance ?? golden.defaults.e1rm_tolerance;
        expect(out.e1rm).toBeDefined();
        expect(Math.abs((out.e1rm as number) - c.expect.e1rm)).toBeLessThanOrEqual(tol);
      }
      if (c.expect.confidence !== undefined) expect(out.confidence).toBe(c.expect.confidence);
      if (c.expect.confidence_max !== undefined) {
        expect(out.confidence).toBeLessThanOrEqual(c.expect.confidence_max);
      }
      // 어떤 경로도 음수 신뢰도를 내지 않는다.
      expect(out.confidence).toBeGreaterThanOrEqual(0);
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
      const input: RecommendationInput = { ...c.input, rules_version: versionFor(c) };
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
      rules_version: golden.rules_version,
    };
    const snapshot = JSON.stringify(input);
    recommendNextSet(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
