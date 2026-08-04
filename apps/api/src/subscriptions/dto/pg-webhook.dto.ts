import { IsObject, IsOptional, IsString } from "class-validator";

/** openapi: POST /webhooks/pg requestBody (서명 검증은 구현 시 SECURITY_PIPA.md 를 따른다) */
export class PgWebhookDto {
  @IsOptional()
  @IsString()
  event_type?: string;

  @IsOptional()
  @IsString()
  billing_key?: string;

  @IsOptional()
  @IsString()
  signature?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
