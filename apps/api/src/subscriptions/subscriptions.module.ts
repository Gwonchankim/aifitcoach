import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { SubscriptionsController } from "./subscriptions.controller";
import { WebhooksController } from "./webhooks.controller";

@Module({ controllers: [BillingController, SubscriptionsController, WebhooksController] })
export class SubscriptionsModule {}
