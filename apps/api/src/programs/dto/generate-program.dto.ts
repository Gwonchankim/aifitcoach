import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { PAIN_AREAS } from "../program-rules";

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

  /**
   * 안전 입력이라 모르는 값을 통과시키지 않는다(openapi enum = SAFETY_PAIN_MAPPING.md 8개 부위).
   * 오타·대소문자·한글이 조용히 무시되면 통증 필터가 "적용된 척"만 한다 → 400.
   */
  @IsOptional()
  @IsArray()
  @IsIn(PAIN_AREAS, { each: true })
  pain_areas?: string[];
}
