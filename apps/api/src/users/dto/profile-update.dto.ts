import { IsIn, IsInt, IsNumber, IsOptional } from "class-validator";

const GOALS = ["diet", "hypertrophy", "strength"] as const;
const EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;

/** openapi: ProfileUpdate */
export class ProfileUpdateDto {
  @IsOptional()
  @IsNumber()
  weight_kg?: number;

  @IsOptional()
  @IsNumber()
  body_fat_pct?: number;

  @IsOptional()
  @IsIn(GOALS)
  goal?: (typeof GOALS)[number];

  @IsOptional()
  @IsInt()
  days_per_week?: number;

  @IsOptional()
  @IsInt()
  minutes_per_day?: number;

  @IsOptional()
  @IsIn(EXPERIENCE_LEVELS)
  experience_level?: (typeof EXPERIENCE_LEVELS)[number];
}
