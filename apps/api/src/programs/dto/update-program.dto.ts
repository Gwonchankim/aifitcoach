import { Type } from "class-transformer";
import { IsArray, IsIn, IsObject, IsOptional, ValidateNested } from "class-validator";

const EDIT_OPS = ["set_count", "swap_exercise", "reorder"] as const;

/** openapi: PATCH /programs/{programId} requestBody.edits[] */
export class ProgramEditDto {
  @IsOptional()
  @IsIn(EDIT_OPS)
  op?: (typeof EDIT_OPS)[number];

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

/** openapi: PATCH /programs/{programId} requestBody */
export class UpdateProgramDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProgramEditDto)
  edits?: ProgramEditDto[];
}
