import { describe, expect, it } from "vitest";
import {
  PAIN_STOP_THRESHOLD,
  normalizePain,
  resolveSafetyOutcome,
  type PainObservation,
} from "../src/safety";

/**
 * F-1 shared safety primitives (V2-F 티켓 substep 2).
 *
 * **복호화는 여기 없다.** `shared` 는 브라우저 번들에도 들어가므로
 * `v1:iv:tag:ciphertext` parser 와 키는 API encryption adapter 단독 소유다.
 * 이 모듈은 adapter 가 정규화해 넘긴 tagged 값만 소비한다.
 */

describe("F-1 normalizePain — tagged 정규화", () => {
  it("safety 자체가 없으면 missing 이다", () => {
    expect(normalizePain(undefined)).toEqual({ kind: "missing" });
  });

  it("pain_score 가 없으면 missing 이다 (nullable 컬럼)", () => {
    expect(normalizePain({})).toEqual({ kind: "missing" });
  });

  it("숫자면 value 다", () => {
    expect(normalizePain({ pain_score: 3 })).toEqual({ kind: "value", value: 3 });
  });

  it("adapter 가 실패를 알려주면 그대로 invalid 로 옮긴다", () => {
    expect(normalizePain({ pain_failure_code: "decrypt_failed" })).toEqual({
      kind: "invalid",
      failure_code: "decrypt_failed",
    });
  });

  it("실패 코드가 값보다 우선한다 — 못 믿을 값을 숫자로 읽지 않는다", () => {
    expect(normalizePain({ pain_score: 0, pain_failure_code: "auth_failed" })).toEqual({
      kind: "invalid",
      failure_code: "auth_failed",
    });
  });

  it("nonnumeric legacy 값은 invalid 다", () => {
    expect(normalizePain({ pain_score: Number.NaN })).toEqual({
      kind: "invalid",
      failure_code: "nonnumeric",
    });
  });
});

describe("F-1 resolveSafetyOutcome — state precedence", () => {
  const cases: Array<[PainObservation, string]> = [
    [{ kind: "missing" }, "proceed"],
    [{ kind: "value", value: 0 }, "proceed"],
    [{ kind: "value", value: PAIN_STOP_THRESHOLD - 1 }, "proceed"],
    [{ kind: "value", value: PAIN_STOP_THRESHOLD }, "substitution_required"],
    [{ kind: "value", value: 10 }, "substitution_required"],
    [{ kind: "invalid", failure_code: "decrypt_failed" }, "unavailable"],
    [{ kind: "invalid", failure_code: "auth_failed" }, "unavailable"],
    [{ kind: "invalid", failure_code: "nonnumeric" }, "unavailable"],
  ];

  it.each(cases)("%o → %s", (observation, expected) => {
    expect(resolveSafetyOutcome(observation)).toBe(expected);
  });

  it("통증 임계는 4 다 — 이 티켓에서 바꾸지 않는다", () => {
    expect(PAIN_STOP_THRESHOLD).toBe(4);
  });

  it("경계 바로 아래는 진행이다", () => {
    expect(resolveSafetyOutcome({ kind: "value", value: 3.999 })).toBe("proceed");
  });
});

describe("F-1 경계 — shared 에 암호 관련 코드가 없다", () => {
  it("normalizePain 은 암호문 문자열을 해석하지 않는다", () => {
    // adapter 를 건너뛰고 암호문을 그대로 넣으면 숫자가 아니므로 invalid 로 fail-closed 된다.
    expect(normalizePain({ pain_score: "v1:iv:tag:ct" as unknown as number })).toEqual({
      kind: "invalid",
      failure_code: "nonnumeric",
    });
  });
});
