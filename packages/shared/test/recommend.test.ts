import { describe, expect, it } from "vitest";
import { recommendNextSet } from "../src/recommend";
import { ROUTINE_RULES_VERSION } from "../src/routine-plan";
import {
  isV2RulesBundle,
  resolveRulesBundle,
  RULES_BUNDLE_V1,
  RULES_BUNDLE_V2,
} from "../src/rules-version";
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
  rules_version: RULES_BUNDLE_V1,
};

describe("recommendNextSet", () => {
  it("추천 무게는 step_kg의 배수다", () => {
    const out = recommendNextSet(base);
    // 가중 종목이므로 weight·step_kg 는 non-null (맨몸은 별도 describe).
    expect(Number.isInteger(out.weight! / base.exercise.step_kg!)).toBe(true);
  });

  it("입력의 rules_version을 그대로 출력에 담는다", () => {
    const out = recommendNextSet({ ...base, rules_version: RULES_BUNDLE_V1 });
    expect(out.rules_version).toBe(RULES_BUNDLE_V1);
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
    rules_version: RULES_BUNDLE_V1,
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
    rules_version: RULES_BUNDLE_V1,
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
    rules_version: RULES_BUNDLE_V1,
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
    rules_version: RULES_BUNDLE_V1,
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

/**
 * rules bundle 분기(docs/PROGRAM_V2_CONTRACT.md §2.6·§4.1).
 * 골든은 지원 버전 2개만 밟는다 — 지원하지 않는 문자열의 동작은 여기서 잠근다.
 */
describe("rules bundle 버전 분기", () => {
  const externalNoHistory: Omit<RecommendationInput, "rules_version"> = {
    goal: "hypertrophy",
    exercise: { type: "compound", region: "upper", step_kg: 2.5 },
    target: { reps_low: 8, reps_high: 12, rir: 2 },
    last_sets: [],
  };

  it("활성 상수는 아직 V1 이다 — activation 티켓 전까지 옮기지 않는다", () => {
    expect(ROUTINE_RULES_VERSION).toBe(RULES_BUNDLE_V1);
    expect(RULES_BUNDLE_V1).toBe("2026.08.1");
    expect(RULES_BUNDLE_V2).toBe("2026.09.0");
  });

  it("V2 판정은 equality 다 — 지원 버전만 resolve 된다", () => {
    expect(resolveRulesBundle(RULES_BUNDLE_V1)).toBe(RULES_BUNDLE_V1);
    expect(resolveRulesBundle(RULES_BUNDLE_V2)).toBe(RULES_BUNDLE_V2);
    expect(isV2RulesBundle(RULES_BUNDLE_V2)).toBe(true);
    expect(isV2RulesBundle(RULES_BUNDLE_V1)).toBe(false);
  });

  it("지원하지 않는 버전은 fail closed — 계산 전에 throw 한다", () => {
    // 이 값들은 사용자 입력이 아니라 내부 배포 오류다. 조용히 V1 로 떨어뜨리면
    // 결과에 잘못된 provenance(rules_version)가 박힌 채 저장된다.
    // `2026.09.1` 은 여기 없다 — supported union 의 네 번째 값이다(F fixup-01).
    for (const version of ["2026.10.0", "2026.09.2", "2026.09.O", "2026.9.0", "2026.07.1", ""]) {
      expect(() => resolveRulesBundle(version), version).toThrow(RangeError);
      expect(() => isV2RulesBundle(version), version).toThrow(RangeError);
      expect(
        () => recommendNextSet({ ...externalNoHistory, rules_version: version }),
        version,
      ).toThrow(RangeError);
    }
  });

  it("throw 는 출력을 만들기 전에 일어난다 — 부분 결과가 저장되지 않는다", () => {
    let out: unknown = "not assigned";
    expect(() => {
      out = recommendNextSet({ ...externalNoHistory, rules_version: "2026.10.0" });
    }).toThrow();
    expect(out).toBe("not assigned");
  });

  it("시간 종목도 같은 지점에서 막힌다(경로별로 갈라지지 않는다)", () => {
    expect(() =>
      recommendNextSet({
        goal: "hypertrophy",
        exercise: { type: "isolation", region: "core", step_kg: null, metric: "time" },
        target: { time_low_sec: 20, time_high_sec: 60 },
        last_sets: [],
        rules_version: "2026.07.1", // 지원 밖 — 상수로 바꾸지 말 것
      }),
    ).toThrow(RangeError);
  });

  it("같은 입력이 버전에 따라 다른 계약을 낸다", () => {
    const v1 = recommendNextSet({ ...externalNoHistory, rules_version: RULES_BUNDLE_V1 });
    const v2 = recommendNextSet({ ...externalNoHistory, rules_version: RULES_BUNDLE_V2 });

    expect(v1.weight).toBe(0);
    expect(v1.reason_code).toBe("BASELINE");
    expect(v2.weight).toBeNull();
    expect(v2.reason_code).toBe("LOAD_CALIBRATION_NEEDED");
    expect(v2.confidence).toBe(0);

    // 표현은 달라도 의미는 같다 — 둘 다 "external 무게가 아직 없다".
    expect(v1.load_kind).toBe("external");
    expect(v2.load_kind).toBe("external");
    expect(v1.recommendation_state).toBe("load_calibration_needed");
    expect(v2.recommendation_state).toBe("load_calibration_needed");
    // 목표 반복은 두 버전 모두 준다.
    expect(v1.reps_low).toBe(8);
    expect(v2.reps_low).toBe(8);
  });

  it("맨몸·시간 종목은 버전 분기의 영향을 받지 않는다", () => {
    const bodyweight = {
      ...externalNoHistory,
      exercise: { type: "compound" as const, region: "upper" as const, step_kg: null },
    };
    for (const version of [RULES_BUNDLE_V1, RULES_BUNDLE_V2]) {
      const out = recommendNextSet({ ...bodyweight, rules_version: version });
      expect(out.reason_code, version).toBe("BASELINE");
      expect(out.load_kind, version).toBe("bodyweight");
      expect(out.recommendation_state, version).toBe("ready");
    }
  });

  it("안전·오류 경로는 ready 로 떨어지지 않는다", () => {
    const withHistory = { ...externalNoHistory, last_sets: [{ w: 60, reps: 10, rir: 2 }] };
    const pain = recommendNextSet({
      ...withHistory,
      safety: { pain_score: 4 },
      rules_version: RULES_BUNDLE_V2,
    });
    const invalid = recommendNextSet({
      ...withHistory,
      exercise: { type: "compound", region: "upper", step_kg: 0 },
      rules_version: RULES_BUNDLE_V2,
    });
    expect(pain.recommendation_state).toBe("substitution_required");
    expect(invalid.recommendation_state).toBe("unavailable");
  });

  it("시간 종목의 안전·오류 경로도 상태를 채운다", () => {
    const time: Omit<RecommendationInput, "rules_version"> = {
      goal: "hypertrophy",
      exercise: { type: "isolation", region: "core", step_kg: null, metric: "time" },
      target: { time_low_sec: 20, time_high_sec: 60 },
      last_sets: [{ time_sec: 30 }],
    };
    const pain = recommendNextSet({
      ...time,
      safety: { pain_score: 5 },
      rules_version: RULES_BUNDLE_V2,
    });
    const invalid = recommendNextSet({
      ...time,
      target: { time_low_sec: 60, time_high_sec: 20 },
      rules_version: RULES_BUNDLE_V2,
    });
    expect(pain.load_kind).toBe("not_applicable");
    expect(pain.recommendation_state).toBe("substitution_required");
    expect(invalid.load_kind).toBe("not_applicable");
    expect(invalid.recommendation_state).toBe("unavailable");
  });
});

/**
 * 0 sentinel 불변식. 웹의 legacy reader 는 어떤 reason 에서도 0 을 "무게 미정"으로 그린다(AC-E-1) —
 * 0kg 을 화면에 쓰거나 기록값으로 프리필하는 것이 언제나 잘못이기 때문이다.
 * 그래서 "새 reason 인데 weight 가 0" 인 잘못된 결과는 렌더러가 아니라 **여기서** 잡아야 한다.
 *
 * 주의: 0 이 BASELINE 에서만 나오는 것은 아니다. `stepDown` 의 바닥이 0 이라 마지막 무게가
 * 1스텝 이하이면 통증·TOO_HARD 감량 경로도 0 에 닿는다(실측). 그래서 불변식은
 * "0 ⇒ BASELINE" 이 아니라 **"LOAD_CALIBRATION_NEEDED ⇒ 0 이 아니다"** 로 잡는다.
 */
describe("V2 캘리브레이션 상태는 0 sentinel 을 쓰지 않는다", () => {
  const exercises: Omit<RecommendationInput, "rules_version">["exercise"][] = [
    { type: "compound", region: "upper", step_kg: 2.5 },
    { type: "isolation", region: "lower", step_kg: 5 },
    { type: "compound", region: "upper", step_kg: null },
    { type: "isolation", region: "core", step_kg: null, metric: "time" },
  ];
  const histories: RecommendationInput["last_sets"][] = [
    [],
    [{ w: 60, reps: 10, rir: 2 }],
    [{ w: 60, reps: 3, rir: 0 }],
    [{ w: 2.5, reps: 1, rir: 0 }],
    [{ time_sec: 30 }],
  ];

  it("어떤 조합에서도 LOAD_CALIBRATION_NEEDED 는 weight 0 을 내지 않는다", () => {
    let seen = 0;
    for (const version of [RULES_BUNDLE_V1, RULES_BUNDLE_V2]) {
      for (const exercise of exercises) {
        for (const last_sets of histories) {
          for (const pain of [undefined, { pain_score: 5 }]) {
            const out = recommendNextSet({
              goal: "hypertrophy",
              exercise,
              target: { reps_low: 8, reps_high: 12, rir: 2, time_low_sec: 20, time_high_sec: 60 },
              last_sets,
              safety: pain,
              rules_version: version,
            });
            const label = `${version} ${JSON.stringify(exercise)} ${JSON.stringify(last_sets)}`;
            if (out.reason_code === "LOAD_CALIBRATION_NEEDED") {
              seen++;
              expect(out.weight, label).toBeNull();
              expect(out.recommendation_state, label).toBe("load_calibration_needed");
            }
            // calibration 상태인데 external 이 아닌 조합이 생기면 파생 규칙이 어긋난 것이다.
            if (out.recommendation_state === "load_calibration_needed") {
              expect(out.load_kind, label).toBe("external");
            }
          }
        }
      }
    }
    // 조합에 V2 external 무이력이 실제로 들어 있어야 위 단언이 의미를 갖는다.
    expect(seen).toBeGreaterThan(0);
  });

  it("V2 external 무이력은 0 을 내지 않는다(sentinel 제거의 핵심)", () => {
    const out = recommendNextSet({
      goal: "hypertrophy",
      exercise: { type: "compound", region: "upper", step_kg: 2.5 },
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      last_sets: [],
      rules_version: RULES_BUNDLE_V2,
    });
    expect(out.weight).not.toBe(0);
    expect(out.weight).toBeNull();
  });
});

/**
 * V2-ENGINE-02 — RIR 보수 경로 **계약 고정**(characterization).
 * 엔진 수식을 바꾸지 않는다. 현행 동작을 못박아 나중에 조용히 무너지지 않게 한다.
 * 그래서 이 블록은 **처음부터 green 이 정상**이고, 실효성은 mutation 으로 증명한다.
 * 계약 원문: docs/PROGRAM_V2_CONTRACT.md §4.2.
 */
describe("RIR 보수 경로 계약 (두 bundle 동일)", () => {
  const BUNDLES = [RULES_BUNDLE_V1, RULES_BUNDLE_V2];
  /** target.rir = 2 → "쉬움" 신호는 rir >= 3. 4 는 여유가 확실한 값. */
  const EASY_RIR = 4;

  function run(over: Partial<RecommendationInput>, version: string) {
    return recommendNextSet({
      goal: "hypertrophy",
      exercise: { type: "compound", region: "upper", step_kg: 2.5 },
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      last_sets: [],
      ...over,
      rules_version: version,
    } as RecommendationInput);
  }
  const sets = (reps: number, rir: number) => [
    { w: 60, reps, rir },
    { w: 60, reps, rir },
    { w: 60, reps, rir },
  ];

  for (const version of BUNDLES) {
    describe(version, () => {
      it("uncalibrated + 상단 미도달 + 높은 RIR → 증량하지 않는다(계약의 핵심)", () => {
        const out = run({ last_sets: sets(10, EASY_RIR) }, version);
        expect(out.reason_code).toBe("ADD_ONE_REP");
        expect(out.weight).toBe(60); // 60 유지 — 62.5 로 오르면 계약 위반
        expect(out.reps_low).toBe(11);
      });

      it("uncalibrated + 상단 도달 → 증량한다. 근거는 RIR 이 아니라 reps 다", () => {
        const out = run({ last_sets: sets(12, EASY_RIR) }, version);
        expect(out.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
        expect(out.weight).toBe(62.5);
      });

      it("RIR 이 높든 on-target 이든 상단 도달이면 같은 이유로 증량한다(RIR 이 근거가 아님을 실증)", () => {
        const easy = run({ last_sets: sets(12, EASY_RIR) }, version);
        const onTarget = run({ last_sets: sets(12, 2) }, version);
        expect(easy.reason_code).toBe(onTarget.reason_code);
        expect(easy.weight).toBe(onTarget.weight);
      });

      it("uncalibrated 라도 낮은 RIR 은 유지 신호로 쓴다(보수 방향은 항상 허용)", () => {
        const out = run({ last_sets: sets(12, 0) }, version);
        expect(out.reason_code).toBe("HOLD_RIR_LOW");
        expect(out.weight).toBe(60); // 상단을 채웠어도 RIR 0 이면 올리지 않는다
      });

      it("uncalibrated 라도 RIR 0 + 하단 미달은 감량한다", () => {
        const out = run({ last_sets: sets(7, 0) }, version);
        expect(out.reason_code).toBe("TOO_HARD");
        expect(out.weight).toBe(57.5);
      });

      it("calibrated 면 같은 입력이 RIR 근거로 증량한다(판별자가 실제로 갈라진다)", () => {
        const uncalibrated = run({ last_sets: sets(10, EASY_RIR) }, version);
        const calibrated = run(
          { last_sets: sets(10, EASY_RIR), calibration: { rir_bias: 0 } },
          version,
        );
        expect(uncalibrated.reason_code).toBe("ADD_ONE_REP");
        expect(uncalibrated.weight).toBe(60);
        expect(calibrated.reason_code).toBe("RIR_TOO_EASY_INCREASE");
        expect(calibrated.weight).toBe(62.5);
      });

      it("calibrated 는 양방향이다 — 낮은 corrected RIR 이면 감량한다", () => {
        const out = run({ last_sets: sets(10, 0), calibration: { rir_bias: 0 } }, version);
        expect(out.reason_code).toBe("RIR_TOO_HARD_REDUCE");
      });
    });
  }

  it("측정 bias 는 판정을 뒤집는다 — GC-22 계약(경험 prior 가 아니라 입력값)", () => {
    // reported RIR 2 는 그대로면 on-target 이지만, 측정 bias +4 면 corrected 6 → 쉬움.
    const noBias = run({ last_sets: sets(10, 2), calibration: { rir_bias: 0 } }, RULES_BUNDLE_V1);
    const measured = run({ last_sets: sets(10, 2), calibration: { rir_bias: 4 } }, RULES_BUNDLE_V1);
    expect(noBias.reason_code).toBe("ADD_ONE_REP");
    expect(measured.reason_code).toBe("RIR_TOO_EASY_INCREASE");
    expect(measured.weight).toBe(62.5);
  });
});
