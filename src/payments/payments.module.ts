import { Module, forwardRef } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { mpGatewayProvider, MP_GATEWAY } from "./mp-gateway.provider";
import { MpIdempotencyStore } from "./mp-idempotency.store";
import { PaymentsInboundConnector } from "./payments-inbound.connector";
import { PaymentProcessorService } from "./payment-processor.service";
import { QueueModule } from "../queue/queue.module";

/**
 * PaymentsModule — Mercado Pago webhook ingestion + fan-out.
 *
 * Wires the single central MP gateway (prizma-payments), a Redis-backed
 * idempotency store (shared with the queue), the per-product inbound connector,
 * and the async processor. The webhook ENDPOINT lives in WebhooksController
 * (alongside /webhooks/nous and /webhooks/hermes) — this module only exports the
 * processor it needs.
 *
 * QueueModule is imported so MpIdempotencyStore can reuse QueueService's Redis
 * dedupe; HttpModule for the connector's outbound POSTs.
 */
@Module({
  // forwardRef: QueueModule imports PaymentsModule (worker → processor) and this
  // module imports QueueModule (idempotency store reuses QueueService).
  imports: [HttpModule, forwardRef(() => QueueModule)],
  providers: [
    mpGatewayProvider,
    MpIdempotencyStore,
    PaymentsInboundConnector,
    PaymentProcessorService,
  ],
  // MP_GATEWAY is exported so WebhooksController (in WebhooksModule, which
  // imports this module) can inject the gateway to verify MP webhook signatures.
  exports: [PaymentProcessorService, MP_GATEWAY],
})
export class PaymentsModule {}
