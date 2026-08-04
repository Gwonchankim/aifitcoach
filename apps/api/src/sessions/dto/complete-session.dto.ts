import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

const DIFFICULTIES = ["easy", "moderate", "hard"] as const;
const PUMPS = ["low", "medium", "high"] as const;

/** openapi: POST /sessions/{sessionId}/complete requestBody */
export class CompleteSessionDto {
  @IsOptional()
  @IsIn(DIFFICULTIES)
  difficulty?: (typeof DIFFICULTIES)[number];

  @IsOptional()
  @IsIn(PUMPS)
  pump?: (typeof PUMPS)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  pain?: number;
}
