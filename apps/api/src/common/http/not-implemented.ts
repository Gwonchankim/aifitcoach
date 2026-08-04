import { NotImplementedException } from "@nestjs/common";

/**
 * STEP 2 스텁: 라우트·DTO 로 openapi 계약만 고정하고 동작은 이후 STEP 에서 구현한다.
 * ErrorEnvelopeFilter 가 501 + `{ error: { code: "NOT_IMPLEMENTED", ... } }` 로 변환한다.
 */
export function notImplemented(): never {
  throw new NotImplementedException("아직 구현되지 않은 엔드포인트다.");
}
