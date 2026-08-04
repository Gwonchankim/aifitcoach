import { IsOptional, IsString } from "class-validator";

/** openapi: GET /exercises query parameters */
export class ListExercisesQueryDto {
  @IsOptional()
  @IsString()
  pattern?: string;

  @IsOptional()
  @IsString()
  equipment?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}
