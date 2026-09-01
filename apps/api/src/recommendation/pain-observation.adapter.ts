import type { PainObservation } from "shared";
import { FieldDecryptionError, decryptNumber } from "../common/crypto/field-encryption";

/**
 * **암호문을 아는 유일한 경계**(F-1). `packages/shared` 는 브라우저 번들에도 들어가므로
 * `v1:iv:tag:ciphertext` parser 와 키는 여기서만 다루고, 밖으로는 tagged 값만 내보낸다.
 *
 * 손상된 행 하나가 요청 전체를 500 으로 만들지 않는다 — 못 읽었다는 **사실**을 값으로 옮긴다.
 * 그 뒤 판정(진행/중단/불가)은 shared 의 `resolveSafetyOutcome` 한 곳이 한다.
 */
export function readPainObservation(stored: string | null): PainObservation {
  if (stored === null) return { kind: "missing" };
  try {
    const value = decryptNumber(stored);
    return value === null ? { kind: "missing" } : { kind: "value", value };
  } catch (error) {
    // 문구가 아니라 코드로 분기한다. 알 수 없는 실패도 열어두지 않고 fail-closed.
    const code = error instanceof FieldDecryptionError ? error.code : "format";
    return {
      kind: "invalid",
      failure_code:
        code === "auth" ? "auth_failed" : code === "nonnumeric" ? "nonnumeric" : "decrypt_failed",
    };
  }
}

/**
 * 최신 세션의 여러 행을 하나로 합친다.
 * **못 읽은 행이 하나라도 있으면 invalid** 다 — 읽힌 것만 골라 "괜찮다"고 말하지 않는다.
 * 그 외에는 가장 높은 통증 값을 쓴다(보수적).
 */
export function mergePainObservations(observations: PainObservation[]): PainObservation {
  const invalid = observations.find((o) => o.kind === "invalid");
  if (invalid !== undefined) return invalid;
  const values = observations.flatMap((o) => (o.kind === "value" ? [o.value] : []));
  return values.length === 0 ? { kind: "missing" } : { kind: "value", value: Math.max(...values) };
}
