import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

/** openapi: AddExerciseRequest */
export class AddExerciseDto {
  @IsString()
  @IsNotEmpty()
  exercise_id!: string;

  @IsOptional()
  @IsInt()
  sets?: number | null;

  @IsOptional()
  @IsInt()
  position?: number | null;
}
