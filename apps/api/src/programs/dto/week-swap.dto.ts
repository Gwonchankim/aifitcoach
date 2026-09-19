import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class WeekSwapDto {
  @IsUUID() client_id!: string;
  @IsUUID() today_session_id!: string;
  @IsUUID() target_session_id!: string;
  @IsString() @IsNotEmpty() today_revision!: string;
  @IsString() @IsNotEmpty() target_revision!: string;
}
