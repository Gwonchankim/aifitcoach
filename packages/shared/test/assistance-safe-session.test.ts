import { describe, expect, it } from "vitest";
import {
  assistanceSessionVerdict,
  classifySessionRow,
  isAssistanceSafeSession,
  type AssistanceSessionRow,
} from "../src/assistance-safety";

/**
 * F-4a — safe predicate 2분기.
 *
 * **하나의 규칙으로 뭉치면 안 된다.** assistance-capable bundle 을 모든 행에 요구하면
 * 이미 수행된 legacy `.08.1` 행까지 `.08.2` 를 요구하게 되어 그 세션은 **영원히 unsafe** 가 된다.
 * 수행 기록은 사실이라 버전을 올릴 수 없다.
 */

const EXTERNAL: AssistanceSessionRow = {
  load_semantics: "external_load",
  load_kind: "external",
  assistance_provenance: null,
  rules_version: "2026.08.1",
  recommendation_state: "ready",
  reason_code: "WEIGHT_UP_REP_TARGET_MET",
  recommended_weight: 40,
  has_server_applied_performed_fact: false,
};

/** 미수행 remediation 행 — 캘리브레이션 상태. */
const REMEDIATED: AssistanceSessionRow = {
  load_semantics: "assistance",
  load_kind: "assistance",
  assistance_provenance: "remediated",
  rules_version: "2026.08.2",
  recommendation_state: "load_calibration_needed",
  reason_code: "ASSISTANCE_CALIBRATION_NEEDED",
  recommended_weight: null,
  has_server_applied_performed_fact: false,
};

/** 미수행 native 행 — 진행 상태. */
const READY: AssistanceSessionRow = {
  load_semantics: "assistance",
  load_kind: "assistance",
  assistance_provenance: "native",
  rules_version: "2026.08.2",
  recommendation_state: "ready",
  reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
  recommended_weight: 17.5,
  has_server_applied_performed_fact: false,
};

/** 이미 수행된 `.08.1` 행 — 사실이라 버전을 올리지 않는다. */
const LEGACY_PERFORMED: AssistanceSessionRow = {
  load_semantics: "assistance",
  load_kind: "assistance",
  assistance_provenance: "legacy_performed",
  rules_version: "2026.08.1",
  recommendation_state: "ready",
  reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
  recommended_weight: 20,
  has_server_applied_performed_fact: true,
};

describe("classifySessionRow", () => {
  it("server-applied performed fact 유무 하나로 갈린다", () => {
    expect(classifySessionRow({ ...READY, has_server_applied_performed_fact: false })).toBe(
      "unperformed_remediation",
    );
    expect(classifySessionRow({ ...READY, has_server_applied_performed_fact: true })).toBe(
      "legacy_performed",
    );
  });
});

describe("isAssistanceSafeSession — 기본", () => {
  it("어시스트 행이 하나도 없으면 safe", () => {
    expect(isAssistanceSafeSession([EXTERNAL, EXTERNAL])).toBe(true);
    expect(isAssistanceSafeSession([])).toBe(true);
  });

  it("non-assisted 행에 provenance 가 채워져 있으면 unsafe — 기본값을 발명한 서버다", () => {
    expect(isAssistanceSafeSession([{ ...EXTERNAL, assistance_provenance: "native" }])).toBe(false);
  });

  it("정상 remediation · native · legacy 행은 safe", () => {
    expect(isAssistanceSafeSession([REMEDIATED, READY, LEGACY_PERFORMED, EXTERNAL])).toBe(true);
  });
});

describe("(1) 미수행 remediation 분기", () => {
  it("`.08.1` 이면 unsafe — remediation 이 아직 안 왔다", () => {
    const verdict = assistanceSessionVerdict([{ ...REMEDIATED, rules_version: "2026.08.1" }]);
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons.join()).toMatch(/assistance 를 모르는 bundle/);
  });

  it("unknown rules_version 은 fail closed", () => {
    expect(isAssistanceSafeSession([{ ...REMEDIATED, rules_version: "9999.99.9" }])).toBe(false);
  });

  it("generic 가중 reason 은 unsafe — 구버전 서버의 처방이다", () => {
    for (const reason of [
      "WEIGHT_UP_REP_TARGET_MET",
      "RIR_TOO_EASY_INCREASE",
      "RIR_TOO_HARD_REDUCE",
      "TOO_HARD",
      "LOAD_CALIBRATION_NEEDED",
      "BASELINE",
    ]) {
      expect(`${reason}:${isAssistanceSafeSession([{ ...READY, reason_code: reason }])}`).toBe(
        `${reason}:false`,
      );
    }
  });

  it("BASELINE + 0kg 은 unsafe — 어시스트에서 0 은 도움 0(맨몸)이다", () => {
    expect(
      isAssistanceSafeSession([{ ...READY, reason_code: "BASELINE", recommended_weight: 0 }]),
    ).toBe(false);
  });

  it("캘리브레이션 상태는 무게 null + 캘리브레이션 reason 이어야 한다", () => {
    expect(isAssistanceSafeSession([{ ...REMEDIATED, recommended_weight: 12.5 }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...REMEDIATED, reason_code: "ADD_ONE_REP" }])).toBe(false);
  });

  it("ready 는 양수 도움값 + 어시스트/중립 reason 이어야 한다", () => {
    expect(isAssistanceSafeSession([{ ...READY, recommended_weight: 0 }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...READY, recommended_weight: null }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...READY, recommended_weight: -2.5 }])).toBe(false);
    // 중립 코드는 허용한다 — 어느 축에도 속하지 않는다.
    expect(isAssistanceSafeSession([{ ...READY, reason_code: "ADD_ONE_REP" }])).toBe(true);
    expect(isAssistanceSafeSession([{ ...READY, reason_code: "HOLD_RIR_LOW" }])).toBe(true);
  });

  it("load_kind 가 assistance 가 아니면 unsafe", () => {
    expect(isAssistanceSafeSession([{ ...READY, load_kind: "external" }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...READY, load_kind: null }])).toBe(false);
  });

  it("provenance 가 없으면 unsafe", () => {
    expect(isAssistanceSafeSession([{ ...READY, assistance_provenance: null }])).toBe(false);
  });

  it("state 가 없으면 unsafe — 판정을 생략하지 않는다", () => {
    expect(isAssistanceSafeSession([{ ...READY, recommendation_state: null }])).toBe(false);
  });

  /**
   * 표시 게이트(D-39)가 처방을 통째로 가린 모양이다. **그렇다고 안전해지지 않는다** —
   * 게이트가 열리는 순간 원래 값이 그대로 드러난다. 판정은 gate 적용 **전** raw 행으로 한다.
   */
  it("처방이 전부 null 이어도 safe 가 아니다 — gate 는 안전 판정 축이 아니다", () => {
    expect(
      isAssistanceSafeSession([
        { ...READY, recommendation_state: null, reason_code: null, recommended_weight: null },
      ]),
    ).toBe(false);
  });
});

describe("(2) legacy_performed 분기 — `.08.2` 를 요구하지 않는다", () => {
  it("`.08.1` 그대로여도 safe — 이게 핵심 회귀다", () => {
    expect(isAssistanceSafeSession([LEGACY_PERFORMED])).toBe(true);
  });

  it("하나의 규칙으로 뭉치면 이 세션이 영원히 unsafe 가 된다", () => {
    // 같은 행을 미수행으로만 바꾸면 `.08.1` 이라 unsafe 여야 한다 —
    // 두 분기가 실제로 다른 판정을 낸다는 증거다.
    expect(
      isAssistanceSafeSession([{ ...LEGACY_PERFORMED, has_server_applied_performed_fact: false }]),
    ).toBe(false);
    expect(isAssistanceSafeSession([LEGACY_PERFORMED])).toBe(true);
  });

  it("assistance-aware 렌더링은 여전히 요구한다", () => {
    expect(isAssistanceSafeSession([{ ...LEGACY_PERFORMED, load_kind: "external" }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...LEGACY_PERFORMED, assistance_provenance: null }])).toBe(
      false,
    );
  });
});

describe("safety matrix — 두 분기 공통", () => {
  const cases: Array<[string, AssistanceSessionRow]> = [
    ["미수행", READY],
    ["수행됨", LEGACY_PERFORMED],
  ];

  it.each(cases)("%s: 통증 상태는 SUBSTITUTE_PAIN + 무게/action null", (_label, base) => {
    const pain: AssistanceSessionRow = {
      ...base,
      recommendation_state: "substitution_required",
      reason_code: "SUBSTITUTE_PAIN",
      recommended_weight: null,
      recommended_action: null,
    };
    expect(isAssistanceSafeSession([pain])).toBe(true);
    expect(isAssistanceSafeSession([{ ...pain, recommended_weight: 20 }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...pain, reason_code: "TOO_HARD" }])).toBe(false);
    expect(
      isAssistanceSafeSession([
        { ...pain, recommended_action: { kind: "suggest_exercise_swap", exercise_id: "e_pullup" } },
      ]),
    ).toBe(false);
  });

  it.each(cases)("%s: 입력 오류 상태는 INVALID_INPUT + 무게/action null", (_label, base) => {
    const invalid: AssistanceSessionRow = {
      ...base,
      recommendation_state: "unavailable",
      reason_code: "INVALID_INPUT",
      recommended_weight: null,
      recommended_action: null,
    };
    expect(isAssistanceSafeSession([invalid])).toBe(true);
    expect(isAssistanceSafeSession([{ ...invalid, recommended_weight: 20 }])).toBe(false);
    expect(isAssistanceSafeSession([{ ...invalid, reason_code: "ASSISTANCE_UP_TOO_HARD" }])).toBe(
      false,
    );
  });
});

/**
 * 안전 상태 확정 문구는 **server·shared·API 가 같은 값**을 써야 한다.
 * shared 는 문구를 소유하지 않지만, 이 상수가 세 곳의 대조 기준이다(F-4a).
 */
export const ASSISTANCE_SAFETY_COPY_CONTRACT = {
  substitution_required: "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.",
  unavailable: "입력값을 확인한 뒤 다시 시도하세요.",
} as const;

describe("안전 상태 확정 문구 계약", () => {
  it("통증 문구에 generic '부하를 낮추고' 가 없다", () => {
    expect(ASSISTANCE_SAFETY_COPY_CONTRACT.substitution_required).not.toMatch(/부하를 낮추고/);
    expect(ASSISTANCE_SAFETY_COPY_CONTRACT.substitution_required).toMatch(/대체 운동/);
  });

  it("입력 오류 문구는 진행 방향을 말하지 않는다", () => {
    expect(ASSISTANCE_SAFETY_COPY_CONTRACT.unavailable).not.toMatch(/증량|감량|도움/);
  });
});
