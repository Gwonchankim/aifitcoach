import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";

/** openapi: POST /webhooks/pg requestBody (서명 검증은 구현 시 SECURITY_PIPA.md 를 따른다) */
export class PgWebhookDto {
  @IsString()
  @IsNotEmpty()
  event_type!: string;

  @IsOptional()
  @IsString()
  billing_key?: string;

  /** 계약상 필수. 서명 없는 웹훅은 파싱 전에 거절된다. */
  @IsString()
  @IsNotEmpty()
  signature!: string;

  @IsObject()
  data!: Record<string, unknown>;
}
