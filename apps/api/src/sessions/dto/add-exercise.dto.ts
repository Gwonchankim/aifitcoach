import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

/** 운동 1개에 만들 수 있는 세트 수 = openapi AddExerciseRequest.sets 의 minimum/maximum:
 *  0/음수는 세트 없는 유령 운동을, 큰 값은 요청 1번으로 무제한 행 생성을 만든다(STEP 4 평가 I-14).
 *  상한 10 = program-rules 의 최대 기본 세트수(스트렝스 복합 5)의 두 배. */
const MIN_SETS = 1;
const MAX_SETS = 10;

/** openapi: AddExerciseRequest */
export class AddExerciseDto {
  @IsString()
  @IsNotEmpty()
  exercise_id!: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_SETS)
  @Max(MAX_SETS)
  sets?: number | null;

  @IsOptional()
  @IsInt()
  position?: number | null;
}
