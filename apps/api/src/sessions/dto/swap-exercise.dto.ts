import { IsNotEmpty, IsString } from "class-validator";

/** openapi: POST /sessions/{sessionId}/exercises/{plannedExerciseId}/swap requestBody */
export class SwapExerciseDto {
  @IsString()
  @IsNotEmpty()
  to_exercise_id!: string;
}
