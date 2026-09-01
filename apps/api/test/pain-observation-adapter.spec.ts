import { encryptField, encryptNumber } from "../src/common/crypto/field-encryption";
import {
  mergePainObservations,
  readPainObservation,
} from "../src/recommendation/pain-observation.adapter";
import { safetyInputFor, toHistory } from "../src/recommendation/recommendation.service";

/**
 * F fixup-code-review-01 항목 4 — **암호문을 아는 유일한 경계**의 6분기.
 * DB 를 쓰지 않는 순수 단위 테스트다(Docker 불필요).
 */

const VALID = encryptNumber(3) as string;

/** GCM 인증만 깨진 암호문 — 형식은 맞고 tag 가 다르다. */
function tamper(stored: string): string {
  const [version, iv, tag, ct] = stored.split(":");
  const flipped = Buffer.from(tag as string, "base64");
  flipped[0] = flipped[0]! ^ 0xff;
  return [version, iv, flipped.toString("base64"), ct].join(":");
}

describe("readPainObservation — 6분기", () => {
  it("① null → missing", () => {
    expect(readPainObservation(null)).toEqual({ kind: "missing" });
  });

  it("② 정상 암호문 → value", () => {
    expect(readPainObservation(VALID)).toEqual({ kind: "value", value: 3 });
  });

  it("③ 형식 오류 → invalid/decrypt_failed (throw 하지 않는다)", () => {
    expect(readPainObservation("not-an-encrypted-field")).toEqual({
      kind: "invalid",
      failure_code: "decrypt_failed",
    });
  });

  it("④ 인증 실패(변조) → invalid/auth_failed", () => {
    expect(readPainObservation(tamper(VALID))).toEqual({
      kind: "invalid",
      failure_code: "auth_failed",
    });
  });

  it("⑤ 복호화는 되지만 숫자가 아님 → invalid/nonnumeric", () => {
    // 평문이 "abc" 인 암호문을 만든다 — encryptNumber 는 숫자만 받으므로 encryptField 를 쓴다.
    expect(readPainObservation(encryptField("abc"))).toEqual({
      kind: "invalid",
      failure_code: "nonnumeric",
    });
  });

  it("⑥ 민감정보를 로그·에러에 남기지 않는다", () => {
    const spies = [
      jest.spyOn(console, "error").mockImplementation(() => undefined),
      jest.spyOn(console, "warn").mockImplementation(() => undefined),
      jest.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    try {
      readPainObservation(tamper(VALID));
      readPainObservation("v1:zz:zz:zz");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // 반환값 어디에도 암호문·평문이 실리지 않는다.
    expect(JSON.stringify(readPainObservation(tamper(VALID)))).not.toContain("v1:");
  });
});

describe("mergePainObservations — 못 읽은 행이 하나라도 있으면 invalid", () => {
  it("invalid 가 값보다 우선한다", () => {
    expect(
      mergePainObservations([
        { kind: "value", value: 1 },
        { kind: "invalid", failure_code: "auth_failed" },
      ]),
    ).toEqual({ kind: "invalid", failure_code: "auth_failed" });
  });

  it("전부 missing 이면 missing", () => {
    expect(mergePainObservations([{ kind: "missing" }, { kind: "missing" }])).toEqual({
      kind: "missing",
    });
  });

  it("값이 여럿이면 가장 높은 통증을 쓴다(보수적)", () => {
    expect(
      mergePainObservations([
        { kind: "value", value: 1 },
        { kind: "value", value: 5 },
      ]),
    ).toEqual({ kind: "value", value: 5 });
  });
});

describe("toHistory — 손상된 행이 요청을 500 으로 만들지 않는다", () => {
  const row = (painScore: string | null) => ({
    actualWeight: null,
    actualReps: 10,
    actualRir: 2,
    actualTimeSec: null,
    painScore,
  });

  it("corrupt latest 는 throw 대신 invalid 로 전달된다", () => {
    expect(() => toHistory([row("broken")])).not.toThrow();
    expect(toHistory([row("broken")]).pain).toEqual({
      kind: "invalid",
      failure_code: "decrypt_failed",
    });
  });

  it("정상 행은 값으로 전달된다", () => {
    expect(toHistory([row(VALID)]).pain).toEqual({ kind: "value", value: 3 });
  });

  it("통증이 없으면 pain 자체가 없다", () => {
    expect(toHistory([row(null)]).pain).toBeUndefined();
  });
});

describe("safetyInputFor — 어느 종목이든 같은 fail-closed 의미", () => {
  it("missing 은 안전 입력을 만들지 않는다", () => {
    expect(safetyInputFor({ kind: "missing" })).toEqual({});
    expect(safetyInputFor(undefined)).toEqual({});
  });

  it("value 는 pain_score 로 간다", () => {
    expect(safetyInputFor({ kind: "value", value: 4 })).toEqual({ safety: { pain_score: 4 } });
  });

  it("invalid 는 failure code 로 간다 — 0 으로 뭉개지 않는다", () => {
    expect(safetyInputFor({ kind: "invalid", failure_code: "nonnumeric" })).toEqual({
      safety: { pain_failure_code: "nonnumeric" },
    });
  });
});
