/**
 * 세트 렌더링 엣지 케이스 계약(UX_STATES §5). 릴리스 차단 기준 AC-E-1/3/4/5 를 고정한다.
 */
import { describe, expect, it } from "vitest";
import type { PlannedSet } from "../lib/api";
import {
  asksRir,
  formatKg,
  hasWeightInput,
  missingField,
  reasonLabel,
  resolveValues,
  setKind,
  setPrefill,
  targetLabel,
  weightBadge,
} from "../components/session/set-rules";

function plannedSet(overrides: Partial<PlannedSet> = {}): PlannedSet {
  return {
    id: "ps_1",
    source_revision: "fixture-set-rules-ps-1",
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
    ...overrides,
    load_kind: "external",
    recommendation_state: "ready",
    assistance_provenance: null,
    recommended_action: null,
    assistance_safety_status: null,
    recommendation_gate: overrides.recommendation_gate ?? "ready",
    performed_set: overrides.performed_set ?? null,
  };
}

describe("setKind (판별 순서 §5.1)", () => {
  it("metric=time 이 무게 판별보다 먼저다", () => {
    const set = plannedSet({ recommended_weight: null, target_time_low_sec: 40 });
    expect(setKind(set, "time")).toBe("time");
  });

  it("카탈로그를 못 받았으면 target_time_low_sec 로 시간 종목을 판별한다", () => {
    const set = plannedSet({
      recommended_weight: null,
      recommended_reps: null,
      target_reps_low: null,
      target_reps_high: null,
      target_time_low_sec: 40,
      target_time_high_sec: 60,
    });
    expect(setKind(set)).toBe("time");
  });

  it("자체중량은 canonical step=null로 판별한다", () => {
    expect(setKind(plannedSet({ recommended_weight: null }), "reps", null)).toBe("bodyweight");
  });

  it("서버 gate로 추천이 null이어도 카탈로그 step이 있으면 무게 입력 운동이다", () => {
    expect(setKind(plannedSet({ recommended_weight: null }), "reps", 2.5)).toBe("unknown_weight");
  });

  it("카탈로그 step=null인 실제 자체중량은 gate와 무관하게 자체중량이다", () => {
    expect(setKind(plannedSet({ recommended_weight: null }), "reps", null)).toBe("bodyweight");
  });

  it("recommended_weight 0 은 무게 미정이다(0kg 이 아니다)", () => {
    const baseline = plannedSet({ recommended_weight: 0, reason_code: "BASELINE" });
    expect(setKind(baseline, "reps")).toBe("unknown_weight");
    // reason_code 가 무엇이든 0 은 절대 "0kg" 으로 그리지 않는다.
    expect(setKind(plannedSet({ recommended_weight: 0, reason_code: "TOO_HARD" }), "reps")).toBe(
      "unknown_weight",
    );
  });

  it("그 외는 일반(가중·반복)이다", () => {
    expect(setKind(plannedSet(), "reps")).toBe("weighted");
  });
});

/**
 * V2-REASON-01 호환 회귀. runtime union 에서 제거한 코드가 저장된 행에 남아 있을 수 있다.
 * 그 코드가 오면 근거 영역을 숨긴다(AC-E-6) — 영문 코드를 노출하지 않는다.
 * 일반 unknown 테스트로 대신하지 않고 **제거한 6종을 직접** 밟는다(map 잔존 회귀를 잡기 위해).
 */
describe("제거된 reason_code 의 렌더 호환", () => {
  const REMOVED = [
    "VOLUME_SPIKE_CAP",
    "DELOAD_SUGGESTED",
    "RIR_ON_TARGET_HOLD",
    "CALIBRATION_NEEDED",
    "CALIBRATION_GRADUATED",
    "CALIBRATION_STALE",
  ];

  it.each(REMOVED)("%s 는 근거 영역을 숨긴다(map 잔존 시 실패)", (code) => {
    expect(reasonLabel(code)).toBeNull();
    expect(reasonLabel(code, "weighted")).toBeNull();
  });

  it("살아 있는 코드는 여전히 문구가 나온다(전부 숨기는 회귀를 막는다)", () => {
    expect(reasonLabel("WEIGHT_UP_REP_TARGET_MET", "weighted")).not.toBeNull();
  });
});

describe("입력칸 구성", () => {
  it("자체중량·시간 종목에는 무게 입력칸이 없다(AC-E-3)", () => {
    expect(hasWeightInput("bodyweight")).toBe(false);
    expect(hasWeightInput("time")).toBe(false);
    expect(hasWeightInput("unknown_weight")).toBe(true);
    expect(hasWeightInput("weighted")).toBe(true);
  });

  it("시간 종목에는 RIR 을 묻지 않는다(AC-E-4)", () => {
    expect(asksRir("time")).toBe(false);
    expect(asksRir("bodyweight")).toBe(true);
  });

  it("무게 배지는 자체중량·무게 미정에만 있고 문구에 0 이 없다(AC-E-1)", () => {
    expect(weightBadge("bodyweight")?.text).toBe("자체중량");
    expect(weightBadge("unknown_weight")?.text).toBe("무게 미정");
    expect(weightBadge("weighted")).toBeNull();
    expect(weightBadge("unknown_weight")?.text).not.toContain("0");
  });
});

describe("missingField (완료 체크 차단 규칙)", () => {
  const empty = { weight: null, reps: null, rir: null, timeSec: null };

  it("무게 미정 세트는 무게가 비면 체크할 수 없다(AC-E-2)", () => {
    expect(missingField("unknown_weight", { ...empty, reps: 9 })).toBe("weight");
    expect(missingField("unknown_weight", { ...empty, reps: 9, weight: 40 })).toBeNull();
  });

  it("시간 종목은 시간 값만으로 체크된다(AC-E-5)", () => {
    expect(missingField("time", { ...empty, timeSec: 45 })).toBeNull();
    expect(missingField("time", empty)).toBe("time");
  });

  it("자체중량은 반복만 있으면 체크된다", () => {
    expect(missingField("bodyweight", { ...empty, reps: 12 })).toBeNull();
    expect(missingField("bodyweight", empty)).toBe("reps");
  });

  it("RIR 은 선택 입력이라 없어도 체크된다", () => {
    expect(
      missingField("weighted", { weight: 62.5, reps: 9, rir: null, timeSec: null }),
    ).toBeNull();
  });
});

describe("값 미입력 → 프리필 확정 (§2.4)", () => {
  const empty = { weight: null, reps: null, rir: null, timeSec: null };

  it("가중 종목의 무게를 지우고 체크하면 추천 무게로 확정된다(볼륨 0 방지)", () => {
    const set = plannedSet(); // recommended_weight 62.5 / recommended_reps 9
    const cleared = { ...empty, reps: 9 };

    const resolved = resolveValues("weighted", cleared, setPrefill("weighted", set));

    expect(resolved.weight).toBe(62.5);
    expect(missingField("weighted", resolved)).toBeNull();
  });

  it("횟수를 지워도 추천 반복으로 확정된다", () => {
    const set = plannedSet();
    const resolved = resolveValues(
      "weighted",
      { ...empty, weight: 60 },
      setPrefill("weighted", set),
    );

    expect(resolved.reps).toBe(9);
  });

  it("추천값이 없는 축은 채우지 못하고 완료 체크가 막힌다", () => {
    // 무게 미정(BASELINE)은 프리필이 없다 → 0 으로 채우지 않는다(AC-E-1/E-2).
    const set = plannedSet({ recommended_weight: 0, reason_code: "BASELINE" });
    const prefill = setPrefill("unknown_weight", set);
    expect(prefill.weight).toBeNull();

    const resolved = resolveValues("unknown_weight", { ...empty, reps: 9 }, prefill);
    expect(missingField("unknown_weight", resolved)).toBe("weight");
  });

  it("가중 종목은 확정 후에도 무게가 비면 기록하지 않고 막는다", () => {
    expect(missingField("weighted", { ...empty, reps: 9 })).toBe("weight");
  });

  it("시간 종목은 목표 하단 시간으로 확정된다", () => {
    const set = plannedSet({ target_time_low_sec: 40, target_time_high_sec: 60 });
    const resolved = resolveValues("time", empty, setPrefill("time", set));

    expect(resolved.timeSec).toBe(40);
    expect(resolved.reps).toBeNull();
    expect(resolved.weight).toBeNull();
  });

  it("자체중량은 무게를 채우지 않는다(actual_weight = null)", () => {
    const set = plannedSet({ recommended_weight: null });
    const resolved = resolveValues(
      "bodyweight",
      { ...empty, reps: 12 },
      setPrefill("bodyweight", set),
    );

    expect(resolved.weight).toBeNull();
    expect(missingField("bodyweight", resolved)).toBeNull();
  });

  it("입력한 값이 있으면 프리필로 덮어쓰지 않는다", () => {
    const set = plannedSet();
    const resolved = resolveValues(
      "weighted",
      { weight: 50, reps: 12, rir: 1, timeSec: null },
      setPrefill("weighted", set),
    );

    expect(resolved).toEqual({ weight: 50, reps: 12, rir: 1, timeSec: null });
  });
});

describe("targetLabel (null 축은 렌더하지 않는다)", () => {
  it("반복 범위·추천 무게를 조합한다", () => {
    expect(targetLabel("weighted", plannedSet())).toBe("목표 8~10회 · 추천 62.5kg");
  });

  it("목표 RIR 은 넣지 않는다(F1-1: RIR 입력칸 옆에 따로 붙어 두 번 나오면 안 된다)", () => {
    expect(targetLabel("weighted", plannedSet({ target_rir: 2 }))).not.toContain("RIR");
  });

  it("무게 미정 세트의 목표에는 무게가 없다", () => {
    const set = plannedSet({ recommended_weight: 0, reason_code: "BASELINE" });
    const label = targetLabel("unknown_weight", set);
    expect(label).toBe("목표 8~10회");
    expect(label).not.toContain("0kg");
  });

  it("null 인 축은 - 이나 0 을 만들지 않는다", () => {
    const set = plannedSet({ target_reps_low: null, target_reps_high: null, target_rir: null });
    expect(targetLabel("bodyweight", set)).toBe("");
  });

  it("시간 종목은 목표 시간만 보여주고 상·하단이 같으면 한 값으로 쓴다", () => {
    const range = plannedSet({ target_time_low_sec: 40, target_time_high_sec: 60 });
    expect(targetLabel("time", range)).toBe("목표 40~60초");
    const collapsed = plannedSet({ target_time_low_sec: 10, target_time_high_sec: 10 });
    expect(targetLabel("time", collapsed)).toBe("목표 10초");
  });
});

describe("reasonLabel (§5.5)", () => {
  it("아는 코드는 한국어 문구로 바꾼다", () => {
    expect(reasonLabel("BASELINE")).toBe("첫 세션이라 무게를 직접 정해요");
  });

  it("모르는 코드·INVALID_INPUT 은 숨긴다(AC-E-6, 영문 코드 노출 금지)", () => {
    expect(reasonLabel("SOMETHING_NEW")).toBeNull();
    expect(reasonLabel("INVALID_INPUT")).toBeNull();
  });
});

describe("formatKg", () => {
  it("정수면 소수점을 생략한다", () => {
    expect(formatKg(60)).toBe("60kg");
    expect(formatKg(62.5)).toBe("62.5kg");
  });
});
