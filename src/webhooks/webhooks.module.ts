import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { ConnectorsModule } from "../connectors/connectors.module";
import { PluginsModule } from "../plugins/plugins.module";
import { QueueModule } from "../queue/queue.module";
import { PaymentsModule } from "../payments/payments.module";

@Module({
  imports: [ConnectorsModule, PluginsModule, QueueModule, PaymentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
