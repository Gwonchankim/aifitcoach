import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import { RULES_BUNDLE_V1, RULES_BUNDLE_V1_ASSIST, RULES_BUNDLE_V2 } from "../src/rules-version";
import { REASON_CODES, RESERVED_REASON_CODES } from "../src/types";
import type { ReasonCode, RecommendationInput } from "../src/types";

/**
 * runtime `REASON_CODES` 는 **지금 실제로 반환될 수 있는 값만** 담는다(V2-REASON-01).
 * 실행 경로 없는 코드를 union 에 남기면 모든 소비자가 "가능한 응답"으로 처리해야 하므로
 * 예약이 아니라 부채다. 소스를 정규식으로 파싱하지 않고 **엔진을 실제로 실행해** 관측한다.
 */

const EXTERNAL = { type: "compound", region: "upper", step_kg: 2.5 } as const;
const BODYWEIGHT = { type: "compound", region: "upper", step_kg: null } as const;
const TIME = { type: "isolation", region: "core", step_kg: null, metric: "time" } as const;
const ASSISTED = {
  type: "compound",
  region: "upper",
  step_kg: 2.5,
  load_semantics: "assistance",
} as const;
const REPS_TARGET = { reps_low: 8, reps_high: 12, rir: 2 };

/** 각 시나리오는 결정표의 한 분기를 정확히 밟는다. */
const SCENARIOS: { label: string; input: RecommendationInput }[] = [
  {
    label: "external 상단 도달 → 증량",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 12, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "external 상단 미도달 → 반복 +1",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 10, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "반복은 지켰고 RIR 만 낮음 → 유지",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 10, rir: 0 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "하단 미달 → 감량",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 6, rir: 0 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "V1 external 무이력 → BASELINE(0 sentinel)",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "V2 external 무이력 → 캘리브레이션 필요",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [],
      rules_version: RULES_BUNDLE_V2,
    },
  },
  {
    label: "잘못된 증량 단위 → INVALID_INPUT",
    input: {
      goal: "hypertrophy",
      exercise: { type: "compound", region: "upper", step_kg: 0 },
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 10, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "통증 → 대체 제안",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      last_sets: [{ w: 60, reps: 10, rir: 2 }],
      safety: { pain_score: 5 },
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "calibrated + 여유 많음 → RIR 증량",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      calibration: { rir_bias: 0 },
      last_sets: [{ w: 60, reps: 10, rir: 4 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "calibrated + 과부하 → RIR 감량",
    input: {
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: REPS_TARGET,
      calibration: { rir_bias: 0 },
      last_sets: [{ w: 60, reps: 10, rir: 0 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "맨몸 상단 도달 → 반복 상단 +1",
    input: {
      goal: "hypertrophy",
      exercise: BODYWEIGHT,
      target: { reps_low: 6, reps_high: 12, rir: 2 },
      last_sets: [{ reps: 12, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "맨몸 반복 상한 도달 → 난도 상향 제안",
    input: {
      goal: "hypertrophy",
      exercise: BODYWEIGHT,
      target: { reps_low: 10, reps_high: 20, rir: 2 },
      last_sets: [{ reps: 20, rir: 2 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "맨몸 2회 이하 → 보조 종목 제안",
    input: {
      goal: "hypertrophy",
      exercise: BODYWEIGHT,
      target: { reps_low: 4, reps_high: 12, rir: 2 },
      last_sets: [{ reps: 2, rir: 0 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "시간 상단 도달 → 시간 증가",
    input: {
      goal: "hypertrophy",
      exercise: TIME,
      target: { time_low_sec: 20, time_high_sec: 60 },
      last_sets: [{ time_sec: 60 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "시간 범위 안 → 유지",
    input: {
      goal: "hypertrophy",
      exercise: TIME,
      target: { time_low_sec: 20, time_high_sec: 60 },
      last_sets: [{ time_sec: 40 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  {
    label: "시간 하단 크게 미달 → 시간 감소",
    input: {
      goal: "hypertrophy",
      exercise: TIME,
      target: { time_low_sec: 30, time_high_sec: 60 },
      last_sets: [{ time_sec: 12 }],
      rules_version: RULES_BUNDLE_V1,
    },
  },
  // --- 어시스트 전용(2026.08.2+). 부호가 반대라 generic 코드를 재사용하지 않는다. ---
  {
    label: "어시스트 무이력 → 캘리브레이션 필요",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      last_sets: [],
      assistance: { has_valid_positive_assistance: false },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
  {
    label: "어시스트 상단 도달 → 도움 감소",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      last_sets: [{ w: 20, reps: 12 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
  {
    label: "어시스트 RIR 쉬움 → 도움 감소",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      calibration: { rir_bias: 0 },
      last_sets: [{ w: 20, reps: 10, rir: 4 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
  {
    label: "어시스트 RIR 힘듦 → 도움 증가",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      calibration: { rir_bias: 0 },
      last_sets: [{ w: 20, reps: 8, rir: 0 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
  {
    label: "어시스트 하단 미달 → 도움 증가",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      last_sets: [{ w: 20, reps: 6 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
  {
    label: "어시스트 최소 경계 → 유지 + 전환 제안",
    input: {
      goal: "hypertrophy",
      exercise: ASSISTED,
      target: REPS_TARGET,
      last_sets: [{ w: 2.5, reps: 12 }],
      assistance: { has_valid_positive_assistance: true },
      rules_version: RULES_BUNDLE_V1_ASSIST,
    },
  },
];

function observedReasonCodes(): Set<ReasonCode> {
  return new Set(SCENARIOS.map((s) => recommendNextSet(s.input).reason_code));
}

describe("runtime REASON_CODES 는 실제 emit 집합과 정확히 같다", () => {
  it("시나리오 matrix 가 union 의 모든 코드를 최소 1회 emit 한다", () => {
    const observed = observedReasonCodes();
    const missing = REASON_CODES.filter((c) => !observed.has(c));
    // union 에 있는데 어떤 경로로도 나오지 않는 코드 = 죽은 코드다.
    expect(missing, `emit 경로가 없는 코드: ${missing.join(", ")}`).toEqual([]);
  });

  it("matrix 가 union 밖의 코드를 만들지 않는다", () => {
    const extra = [...observedReasonCodes()].filter(
      (c) => !(REASON_CODES as readonly string[]).includes(c),
    );
    expect(extra, `union 에 없는 코드가 나왔다: ${extra.join(", ")}`).toEqual([]);
  });

  it("두 집합이 exact 하게 같다", () => {
    const observed = [...observedReasonCodes()].sort();
    expect(observed).toEqual([...REASON_CODES].sort());
  });

  it("각 시나리오가 실제로 서로 다른 분기를 밟는다(matrix 자체의 건전성)", () => {
    // 시나리오 수보다 관측 코드 수가 크게 적으면 matrix 가 분기를 덮지 못한 것이다.
    expect(observedReasonCodes().size).toBe(REASON_CODES.length);
  });
});

describe("RESERVED_REASON_CODES 계약", () => {
  it("예약 코드는 runtime union 과 겹치지 않는다(disjoint)", () => {
    const runtime = new Set<string>(REASON_CODES);
    const overlap = RESERVED_REASON_CODES.filter((c) => runtime.has(c));
    expect(overlap, `예약 코드가 runtime union 에도 있다: ${overlap.join(", ")}`).toEqual([]);
  });

  it("예약 목록이 정확히 4종이다", () => {
    expect([...RESERVED_REASON_CODES].sort()).toEqual([
      "CALIBRATION_STALE",
      "DELOAD_SUGGESTED",
      "SIMILAR_INIT",
      "VOLUME_SPIKE_CAP",
    ]);
  });

  it("예약 코드는 어떤 시나리오에서도 emit 되지 않는다", () => {
    const observed = observedReasonCodes() as Set<string>;
    for (const reserved of RESERVED_REASON_CODES) {
      expect(observed.has(reserved), reserved).toBe(false);
    }
  });
});
