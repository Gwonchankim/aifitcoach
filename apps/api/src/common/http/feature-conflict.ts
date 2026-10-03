import { ConflictException } from "@nestjs/common";

/** Reserved feature taxonomy; internal causes never contain patient input. */
export class FeatureConflictException extends ConflictException {
  constructor(readonly reason: "insufficient_time_for_mixed_focus" | "cardio_preservation_failed") {
    super({
      code: "CONFLICT",
      message:
        reason === "insufficient_time_for_mixed_focus"
          ? "선택한 시간에 필수 운동을 모두 배정할 수 없습니다."
          : "유산소 처방을 안전하게 보존할 수 없습니다.",
      details: { reason },
    });
  }
}
