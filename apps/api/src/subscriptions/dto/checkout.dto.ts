import { IsIn, IsOptional, IsString } from "class-validator";

const PRODUCT_IDS = ["pro_monthly", "pro_yearly"] as const;

/** openapi: CheckoutRequest */
export class CheckoutDto {
  @IsIn(PRODUCT_IDS)
  product_id!: (typeof PRODUCT_IDS)[number];

  @IsOptional()
  @IsString()
  success_url?: string;

  @IsOptional()
  @IsString()
  fail_url?: string;
}
