import { ConflictException } from "@nestjs/common";

export const WEEK_SWAP_REASONS = [
  "readonly",
  "not_scheduled",
  "performed_history",
  "wrong_week",
  "ambiguous_schedule",
  "stale_revision",
  "recovery_unverifiable",
  "recovery_gap_violation",
  "idempotency_payload_mismatch",
] as const;
export type WeekSwapReason = (typeof WEEK_SWAP_REASONS)[number];
export type WeekSwapCandidateReason = Exclude<
  WeekSwapReason,
  "stale_revision" | "idempotency_payload_mismatch"
>;
export class WeekSwapConflictException extends ConflictException {
  constructor(readonly reason: WeekSwapReason) {
    super("일정 교환 조건을 확인해 주세요.");
  }
}
