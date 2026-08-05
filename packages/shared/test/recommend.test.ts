import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import type { RecommendationInput } from "../src/types";

/**
 * 골든(계약) 케이스는 test/golden.test.ts가 담당한다.
 * 여기엔 골든이 고정하지 못하는 규칙(clamp·반복 증가·confidence 등급)만 둔다.
 */

const base: RecommendationInput = {
  goal: "hypertrophy",
  exercise: { type: "compound", region: "upper", step_kg: 2.5 },
  target: { reps_low: 8, reps_high: 12, rir: 2 },
  last_sets: [{ w: 60, reps: 12, rir: 2 }],
  rules_version: "2026.07.1",
};

describe("recommendNextSet", () => {
  it("추천 무게는 step_kg의 배수다", () => {
    const out = recommendNextSet(base);
    // 가중 종목이므로 weight·step_kg 는 non-null (맨몸은 별도 describe).
    expect(Number.isInteger(out.weight! / base.exercise.step_kg!)).toBe(true);
  });

  it("입력의 rules_version을 그대로 출력에 담는다", () => {
    const out = recommendNextSet({ ...base, rules_version: "2026.07.1" });
    expect(out.rules_version).toBe("2026.07.1");
  });

  it("target.reps_high < reps_low 이면 INVALID_INPUT", () => {
    const out = recommendNextSet({ ...base, target: { reps_low: 12, reps_high: 8, rir: 2 } });
    expect(out.reason_code).toBe("INVALID_INPUT");
  });
});

describe("오프스텝 무게 정규화 (1스텝 상한 보장, ADR-18)", () => {
  // step_kg 5인데 마지막 무게가 그리드에서 벗어난 경우(62.5, 61).
  const lower: RecommendationInput = {
    goal: "hypertrophy",
    exercise: { type: "compound", region: "lower", step_kg: 5 },
    target: { reps_low: 8, reps_high: 12, rir: 2 },
    last_sets: [],
    rules_version: "2026.07.1",
  };
  const atTop = (w: number) => [
    { w, reps: 12, rir: 2 },
    { w, reps: 12, rir: 2 },
  ];

  it("증량: 62.5 → 65 (반올림이면 70, 즉 +7.5kg가 되어 1스텝 초과)", () => {
    const out = recommendNextSet({ ...lower, last_sets: atTop(62.5) });
    expect(out.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
    expect(out.weight).toBe(65);
  });

  it("증량: 61 → 65 (내림 정규화 후 +1스텝)", () => {
    expect(recommendNextSet({ ...lower, last_sets: atTop(61) }).weight).toBe(65);
  });

  it("증량: on-step 60 → 65 (기존 동작 유지)", () => {
    expect(recommendNextSet({ ...lower, last_sets: atTop(60) }).weight).toBe(65);
  });

  it("RIR 증량: 62.5 → 65", () => {
    const out = recommendNextSet({
      ...lower,
      calibration: { rir_bias: 0 },
      last_sets: [
        { w: 62.5, reps: 10, rir: 4 },
        { w: 62.5, reps: 10, rir: 4 },
      ],
    });
    expect(out.reason_code).toBe("RIR_TOO_EASY_INCREASE");
    expect(out.weight).toBe(65);
  });

  it("감량: 61 → 60 (한 칸 아래 그리드. 반올림-후-감량이면 55)", () => {
    const out = recommendNextSet({
      ...lower,
      last_sets: [
        { w: 61, reps: 5, rir: 0 },
        { w: 61, reps: 4, rir: 0 },
      ],
    });
    expect(out.reason_code).toBe("TOO_HARD");
    expect(out.weight).toBe(60);
  });

  it("감량: on-step 60 → 55 (기존 동작 유지)", () => {
    const out = recommendNextSet({
      ...lower,
      last_sets: [
        { w: 60, reps: 5, rir: 0 },
        { w: 60, reps: 4, rir: 0 },
      ],
    });
    expect(out.weight).toBe(55);
  });

  it("유지: 62.5 → 60 (반올림이면 65로 '유지'가 증량이 된다)", () => {
    const out = recommendNextSet({
      ...lower,
      last_sets: [
        { w: 62.5, reps: 10, rir: 0 },
        { w: 62.5, reps: 9, rir: 0 },
      ],
    });
    expect(out.reason_code).toBe("HOLD_RIR_LOW");
    expect(out.weight).toBe(60);
  });

  it("유지(ADD_ONE_REP): 62.5 → 60", () => {
    const out = recommendNextSet({
      ...lower,
      last_sets: [
        { w: 62.5, reps: 10, rir: 2 },
        { w: 62.5, reps: 9, rir: 2 },
      ],
    });
    expect(out.reason_code).toBe("ADD_ONE_REP");
    expect(out.weight).toBe(60);
  });

  it("통증 하향: 61 → 60 (감량-후-반올림이면 55)", () => {
    const out = recommendNextSet({
      ...lower,
      last_sets: [{ w: 61, reps: 8, rir: 2 }],
      safety: { pain_score: 5 },
    });
    expect(out.reason_code).toBe("SUBSTITUTE_PAIN");
    expect(out.weight).toBe(60);
  });

  it("어떤 경로든 추천 무게는 마지막 무게 +1스텝을 넘지 않는다", () => {
    for (const w of [61, 62.5, 60, 63.9]) {
      const out = recommendNextSet({ ...lower, last_sets: atTop(w) });
      expect(out.weight).toBeLessThanOrEqual(w + lower.exercise.step_kg!);
      expect(out.weight).toBeGreaterThan(w);
    }
  });
});

describe("corrected_RIR clamp (e1rm으로 관측)", () => {
  // e1rm = w * (1 + (reps + corrected_RIR)/30), corrected_RIR = clamp(reported + bias, 0, 6)
  const strength: RecommendationInput = {
    goal: "strength",
    exercise: { type: "compound", region: "upper", step_kg: 2.5 },
    target: { reps_low: 3, reps_high: 5, rir: 3 },
    last_sets: [{ w: 100, reps: 5, rir: 2 }],
    rules_version: "2026.07.1",
  };

  it("상한 6: bias +6이면 corrected_RIR은 8이 아니라 6", () => {
    const out = recommendNextSet({ ...strength, calibration: { rir_bias: 6 } });
    // clamp 있음 → 100*(1+11/30)=136.67 / 상한 없으면(8) 143.33
    expect(out.e1rm).toBeCloseTo(136.67, 1);
  });

  it("하한 0: bias -9면 corrected_RIR은 -7이 아니라 0", () => {
    const out = recommendNextSet({ ...strength, calibration: { rir_bias: -9 } });
    // clamp 있음 → 100*(1+5/30)=116.67 / 하한 없으면(-7) 93.33
    expect(out.e1rm).toBeCloseTo(116.67, 1);
  });

  it("범위 안에서는 bias가 그대로 반영된다", () => {
    const out = recommendNextSet({ ...strength, calibration: { rir_bias: 1 } });
    // corrected_RIR = 3 → 100*(1+8/30)=126.67
    expect(out.e1rm).toBeCloseTo(126.67, 1);
  });

  it("음수 bias는 판정에도 반영된다(2 + (-5) → 0 ≤ target.rir - 1)", () => {
    const out = recommendNextSet({
      ...base,
      calibration: { rir_bias: -5 },
      last_sets: [{ w: 60, reps: 10, rir: 2 }],
    });
    expect(out.reason_code).toBe("RIR_TOO_HARD_REDUCE");
  });
});

describe("ADD_ONE_REP의 반복 목표", () => {
  it("가장 낮은 세트 기준 +1 (9/9/8 → 9)", () => {
    const out = recommendNextSet({
      ...base,
      last_sets: [
        { w: 60, reps: 9, rir: 2 },
        { w: 60, reps: 9, rir: 2 },
        { w: 60, reps: 8, rir: 2 },
      ],
    });
    expect(out.reason_code).toBe("ADD_ONE_REP");
    expect(out.weight).toBe(60);
    expect(out.reps_low).toBe(9); // 최대 세트 기준이면 10, +1이 없으면 8
  });

  it("편차가 큰 세트도 최소 세트 기준 +1 (12/10/9 → 10)", () => {
    const out = recommendNextSet({
      ...base,
      last_sets: [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 10, rir: 2 },
        { w: 60, reps: 9, rir: 2 },
      ],
    });
    expect(out.reps_low).toBe(10); // 최대 세트 기준이면 13, +1이 없으면 9
  });
});

describe("confidence 등급", () => {
  const full = recommendNextSet({ ...base, last_sets: [{ w: 60, reps: 10, rir: 2 }] });
  const missingRir = recommendNextSet({ ...base, last_sets: [{ w: 60, reps: 10 }] });
  const baseline = recommendNextSet({ ...base, last_sets: [] });

  it("RIR 있음 > RIR 결측 > 기록 없음 (단조 감소)", () => {
    expect(full.confidence).toBeGreaterThan(missingRir.confidence);
    expect(missingRir.confidence).toBeGreaterThan(baseline.confidence);
  });

  it("모든 confidence는 (0, 1] 범위다", () => {
    for (const out of [full, missingRir, baseline]) {
      expect(out.confidence).toBeGreaterThan(0);
      expect(out.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("맨몸 종목 (step_kg = null)", () => {
  // 골든(GC-23~26)이 고정하지 못하는 경계·부수 규칙만 둔다.
  const bw: RecommendationInput = {
    goal: "hypertrophy",
    exercise: { type: "compound", region: "upper", step_kg: null, metric: "reps" },
    target: { reps_low: 6, reps_high: 15, rir: 2 },
    last_sets: [{ reps: 15, rir: 2 }],
    rules_version: "2026.07.1",
  };
  const setsOf = (reps: number[], rir?: number) =>
    reps.map((r) => (rir === undefined ? { reps: r } : { reps: r, rir }));

  it("어떤 경로에서도 weight 는 null 이다(자체중량)", () => {
    const paths: RecommendationInput[] = [
      { ...bw, last_sets: setsOf([15, 15], 2) }, // REPS_UP_BODYWEIGHT
      { ...bw, last_sets: setsOf([10, 9], 2) }, // ADD_ONE_REP
      { ...bw, last_sets: setsOf([5, 5], 2) }, // TOO_HARD
      { ...bw, last_sets: setsOf([2, 1], 0) }, // SUBSTITUTE_TOO_HARD_BODYWEIGHT
      { ...bw, last_sets: [] }, // BASELINE
      { ...bw, safety: { pain_score: 5 } }, // SUBSTITUTE_PAIN
    ];
    for (const input of paths) {
      expect(recommendNextSet(input).weight).toBeNull();
    }
  });

  it("상한 직전(19)은 20으로 올린다", () => {
    const out = recommendNextSet({
      ...bw,
      target: { reps_low: 10, reps_high: 19, rir: 2 },
      last_sets: setsOf([19, 19], 2),
    });
    expect(out.reason_code).toBe("REPS_UP_BODYWEIGHT");
    expect(out.reps_high).toBe(20);
  });

  it("상한을 넘겨 올리지 않는다(20 → 20, PROGRESSION_CAP_BODYWEIGHT)", () => {
    const out = recommendNextSet({
      ...bw,
      target: { reps_low: 10, reps_high: 20, rir: 2 },
      last_sets: setsOf([22, 21], 2),
    });
    expect(out.reason_code).toBe("PROGRESSION_CAP_BODYWEIGHT");
    expect(out.reps_high).toBe(20);
  });

  it("2회도 대체 제안 임계에 포함된다(경계: <= 2)", () => {
    const out = recommendNextSet({
      ...bw,
      target: { reps_low: 4, reps_high: 12, rir: 2 },
      last_sets: setsOf([2, 2], 0),
    });
    expect(out.reason_code).toBe("SUBSTITUTE_TOO_HARD_BODYWEIGHT");
    expect(out.suggest_substitution).toBe(true);
  });

  it("하단 미달이지만 3회 이상이면 대체가 아니라 TOO_HARD(범위 유지)", () => {
    const out = recommendNextSet({ ...bw, last_sets: setsOf([4, 3], 1) });
    expect(out.reason_code).toBe("TOO_HARD");
    expect(out.reps_low).toBe(6);
    expect(out.reps_high).toBe(15);
  });

  it("목표 하단이 2 이하면 2회는 미달이 아니므로 대체를 제안하지 않는다", () => {
    const out = recommendNextSet({
      ...bw,
      target: { reps_low: 2, reps_high: 6, rir: 2 },
      last_sets: setsOf([2, 2], 2),
    });
    expect(out.reason_code).toBe("ADD_ONE_REP");
    expect(out.suggest_substitution).toBeUndefined();
  });

  it("반복은 지켰지만 RIR 이 낮으면 HOLD_RIR_LOW(하향할 부하가 없다)", () => {
    const out = recommendNextSet({ ...bw, last_sets: setsOf([10, 10], 0) });
    expect(out.reason_code).toBe("HOLD_RIR_LOW");
    expect(out.weight).toBeNull();
  });

  it("RIR 이 높아도 부하 증량 대신 반복 진행을 쓴다", () => {
    const out = recommendNextSet({
      ...bw,
      calibration: { rir_bias: 0 },
      last_sets: setsOf([10, 10], 4),
    });
    expect(out.reason_code).toBe("ADD_ONE_REP");
  });

  it("외부 부하가 없어 e1rm 을 내지 않는다", () => {
    expect(recommendNextSet({ ...bw, last_sets: setsOf([15, 15], 2) }).e1rm).toBeUndefined();
  });

  it("step_kg = 0 은 맨몸이 아니라 INVALID_INPUT 이다(0 과 null 을 구분한다)", () => {
    const out = recommendNextSet({
      ...bw,
      exercise: { type: "compound", region: "upper", step_kg: 0 },
      last_sets: [{ w: 0, reps: 15, rir: 2 }],
    });
    expect(out.reason_code).toBe("INVALID_INPUT");
  });
});

describe("시간 종목 (metric = time)", () => {
  const plank: RecommendationInput = {
    goal: "hypertrophy",
    exercise: { type: "isolation", region: "core", step_kg: null, metric: "time" },
    target: { time_low_sec: 20, time_high_sec: 60 },
    last_sets: [{ time_sec: 60 }],
    rules_version: "2026.07.1",
  };

  it("상단 60초 미만이면 +5초 상향", () => {
    const out = recommendNextSet({
      ...plank,
      target: { time_low_sec: 20, time_high_sec: 45 },
      last_sets: [{ time_sec: 45 }, { time_sec: 50 }],
    });
    expect(out.reason_code).toBe("TIME_UP");
    expect(out.time_low_sec).toBe(20);
    expect(out.time_high_sec).toBe(50);
  });

  it("한 세트라도 상단에 미달하면 올리지 않는다", () => {
    const out = recommendNextSet({ ...plank, last_sets: [{ time_sec: 60 }, { time_sec: 55 }] });
    expect(out.reason_code).toBe("TIME_HOLD");
    expect(out.time_high_sec).toBe(60);
  });

  it("하단 미달이라도 하단의 절반 이상이면 하향하지 않는다(15 >= 20*0.5)", () => {
    const out = recommendNextSet({ ...plank, last_sets: [{ time_sec: 15 }] });
    expect(out.reason_code).toBe("TIME_HOLD");
    expect(out.time_low_sec).toBe(20);
    expect(out.time_high_sec).toBe(60);
  });

  it("하향은 최소 10초 아래로 내려가지 않는다(12 - 5 = 7 이지만 10)", () => {
    const out = recommendNextSet({
      ...plank,
      target: { time_low_sec: 12, time_high_sec: 30 },
      last_sets: [{ time_sec: 5 }],
    });
    expect(out.reason_code).toBe("TIME_DOWN");
    expect(out.time_low_sec).toBe(10);
    expect(out.time_high_sec).toBe(25);
  });

  it("무게·반복을 처방하지 않는다", () => {
    const out = recommendNextSet(plank);
    expect(out.weight).toBeNull();
    expect(out.reps_low).toBeUndefined();
    expect(out.reps_high).toBeUndefined();
    expect(out.e1rm).toBeUndefined();
  });

  it("RIR 은 적용하지 않는다(보고돼도 판정·confidence 가 변하지 않는다)", () => {
    const withRir = recommendNextSet({
      ...plank,
      calibration: { rir_bias: 0 },
      last_sets: [{ time_sec: 45, rir: 0 }],
    });
    const withoutRir = recommendNextSet({ ...plank, last_sets: [{ time_sec: 45 }] });
    expect(withRir.reason_code).toBe(withoutRir.reason_code);
    expect(withRir.confidence).toBe(withoutRir.confidence);
    // RIR 미수집이 정상이므로 결측 등급이 아니라 기록 있음(full) 등급을 쓴다.
    expect(withoutRir.confidence).toBe(
      recommendNextSet({ ...base, last_sets: [{ w: 60, reps: 10, rir: 2 }] }).confidence,
    );
    expect(withoutRir.confidence).toBeGreaterThan(
      recommendNextSet({ ...base, last_sets: [{ w: 60, reps: 10 }] }).confidence,
    );
  });

  it("기록이 없으면 목표 시간을 그대로 유지한 BASELINE", () => {
    const out = recommendNextSet({ ...plank, last_sets: [] });
    expect(out.reason_code).toBe("BASELINE");
    expect(out.time_low_sec).toBe(20);
    expect(out.time_high_sec).toBe(60);
  });

  it("목표 시간이 없거나 뒤집혀 있으면 INVALID_INPUT", () => {
    expect(recommendNextSet({ ...plank, target: {} }).reason_code).toBe("INVALID_INPUT");
    expect(
      recommendNextSet({ ...plank, target: { time_low_sec: 60, time_high_sec: 20 } }).reason_code,
    ).toBe("INVALID_INPUT");
  });

  it("통증 가드레일이 시간 진행보다 우선한다", () => {
    const out = recommendNextSet({ ...plank, safety: { pain_score: 5 } });
    expect(out.reason_code).toBe("SUBSTITUTE_PAIN");
    expect(out.suggest_substitution).toBe(true);
  });

  it("time_sec 이 0 이하인 세트는 계산에서 제외한다", () => {
    const out = recommendNextSet({ ...plank, last_sets: [{ time_sec: 0 }, { time_sec: 60 }] });
    expect(out.reason_code).toBe("TIME_UP");
  });
});

describe("안전 가드레일", () => {
  it("통증 가드레일은 증량 조건보다 우선한다", () => {
    const out = recommendNextSet({ ...base, safety: { pain_score: 4 } });
    expect(out.reason_code).toBe("SUBSTITUTE_PAIN");
    expect(out.weight).toBeLessThan(60);
  });

  it("pain_score 3은 진행규칙을 막지 않는다", () => {
    const out = recommendNextSet({ ...base, safety: { pain_score: 3 } });
    expect(out.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
  });

  it("통증 경로도 데이터 품질 기반 confidence를 쓴다(RIR 결측 시 하향)", () => {
    const withRir = recommendNextSet({
      ...base,
      last_sets: [{ w: 60, reps: 10, rir: 2 }],
      safety: { pain_score: 4 },
    });
    const withoutRir = recommendNextSet({
      ...base,
      last_sets: [{ w: 60, reps: 10 }],
      safety: { pain_score: 4 },
    });
    expect(withRir.reason_code).toBe("SUBSTITUTE_PAIN");
    expect(withoutRir.reason_code).toBe("SUBSTITUTE_PAIN");
    expect(withoutRir.confidence).toBeLessThan(withRir.confidence);
  });
});
