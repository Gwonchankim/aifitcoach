import { ConflictException } from "@nestjs/common";

/** Only this feature's 409 envelope may expose these identity/state reasons. */
export const SESSION_APPEND_REASONS = [
  "readonly",
  "set_cap_reached",
  "set_number_gap",
  "source_changed",
  "source_removed",
  "correlation_mismatch",
  "idempotency_payload_mismatch",
  "append_target_removed",
  "unsafe_assistance_snapshot",
  "unresolved_parent",
] as const;

export type SessionAppendReason = (typeof SESSION_APPEND_REASONS)[number];

export class SessionAppendConflictException extends ConflictException {
  constructor(readonly reason: SessionAppendReason) {
    if (!SESSION_APPEND_REASONS.includes(reason))
      throw new TypeError("Invalid append conflict reason");
    super("세트 추가 조건을 확인해 주세요.");
  }
}
