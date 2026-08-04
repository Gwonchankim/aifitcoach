import { IsISO8601, IsOptional } from "class-validator";

/** openapi: GET /analytics/volume query parameters */
export class VolumeQueryDto {
  @IsOptional()
  @IsISO8601()
  week_start?: string;
}
