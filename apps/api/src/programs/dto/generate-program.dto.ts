import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

const GOALS = ["diet", "hypertrophy", "strength"] as const;
const EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;
const MINUTES_PER_DAY = [30, 45, 60, 75, 90] as const;

/** openapi: GenerateProgramRequest */
export class GenerateProgramDto {
  @IsIn(GOALS)
  goal!: (typeof GOALS)[number];

  @IsInt()
  @Min(2)
  @Max(6)
  days_per_week!: number;

  @IsIn(MINUTES_PER_DAY)
  minutes_per_day!: (typeof MINUTES_PER_DAY)[number];

  @IsIn(EXPERIENCE_LEVELS)
  experience_level!: (typeof EXPERIENCE_LEVELS)[number];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  equipment?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  avoid_exercises?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pain_areas?: string[];
}
