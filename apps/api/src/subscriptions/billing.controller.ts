import { Body, Controller, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { CheckoutDto } from "./dto/checkout.dto";
import { ConfirmBillingDto } from "./dto/confirm-billing.dto";

@Controller("billing")
export class BillingController {
  /** POST /billing/checkout — 정기결제 시작(빌링키 발급 세션/파라미터 반환) */
  @Post("checkout")
  checkout(@Body() _body: CheckoutDto): never {
    return notImplemented();
  }

  /** POST /billing/confirm — 빌링키 확정 및 첫 결제 처리 → 엔타이틀먼트 부여 */
  @Post("confirm")
  confirm(@Body() _body: ConfirmBillingDto): never {
    return notImplemented();
  }
}
