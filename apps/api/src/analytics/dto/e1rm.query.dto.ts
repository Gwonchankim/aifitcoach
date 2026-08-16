import { IsISO8601, IsNotEmpty, IsOptional, IsString } from "class-validator";

/** openapi: GET /analytics/e1rm query parameters */
export class E1rmQueryDto {
  @IsString()
  @IsNotEmpty()
  exercise_id!: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
