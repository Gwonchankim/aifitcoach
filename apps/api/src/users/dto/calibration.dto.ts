import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

const METHODS = ["survey", "amrap"] as const;
const PERCEIVED_DIFFICULTIES = ["easy", "moderate", "hard"] as const;

/** openapi: POST /me/calibration requestBody.items[] */
export class CalibrationItemDto {
  @IsOptional()
  @IsString()
  exercise_id?: string;

  @IsOptional()
  @IsIn(PERCEIVED_DIFFICULTIES)
  perceived_difficulty?: (typeof PERCEIVED_DIFFICULTIES)[number];

  @IsOptional()
  @IsNumber()
  amrap_weight?: number | null;

  @IsOptional()
  @IsInt()
  amrap_reps?: number | null;
}

/** openapi: POST /me/calibration requestBody */
export class CalibrationDto {
  @IsOptional()
  @IsIn(METHODS)
  method?: (typeof METHODS)[number];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CalibrationItemDto)
  items?: CalibrationItemDto[];
}
