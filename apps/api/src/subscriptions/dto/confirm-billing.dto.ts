import { IsNotEmpty, IsString } from "class-validator";

/** openapi: POST /billing/confirm requestBody */
export class ConfirmBillingDto {
  @IsString()
  @IsNotEmpty()
  billing_key!: string;

  @IsString()
  @IsNotEmpty()
  product_id!: string;
}
