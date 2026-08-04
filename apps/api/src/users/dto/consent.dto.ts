import { IsBoolean, IsNotEmpty, IsString } from "class-validator";

/** openapi: Consent (POST /me/consents 는 이 스키마의 배열을 받는다) */
export class ConsentDto {
  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsBoolean()
  granted!: boolean;
}
