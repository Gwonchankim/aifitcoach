import { Body, Controller, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { PgWebhookDto } from "./dto/pg-webhook.dto";

@Controller("webhooks")
export class WebhooksController {
  /** POST /webhooks/pg — PG 웹훅(결제/갱신/해지/환불 상태 동기화) */
  @Post("pg")
  pg(@Body() _body: PgWebhookDto): never {
    return notImplemented();
  }
}
