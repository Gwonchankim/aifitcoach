import { IsNotEmpty, IsOptional, IsString } from "class-validator";

/** openapi: SocialLoginRequest */
export class SocialLoginDto {
  @IsString()
  @IsNotEmpty()
  id_token!: string;

  @IsOptional()
  @IsString()
  device_id?: string | null;
}
