import { Type } from "class-transformer";
import { IsISO8601, IsInt, IsOptional, Max, Min } from "class-validator";

/** openapi: GET /analytics/completion query parameters */
export class CompletionQueryDto {
  @IsOptional()
  @IsISO8601()
  week_start?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  weeks?: number;
}
