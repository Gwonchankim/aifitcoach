import { IsIn } from "class-validator";
import { BODY_PARTS } from "../../programs/program-rules";

/**
 * openapi: CreateAdHocSessionRequest
 * enum 밖의 부위는 400 이다 — 조용히 통과시키면 사용자가 고르지 않은 부위의 루틴이 만들어진다.
 */
export class CreateAdHocSessionDto {
  @IsIn(BODY_PARTS)
  body_part!: string;
}
