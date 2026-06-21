import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Logos (e-invoicing) event-driven destination connector.
 *
 * NOTE: the existing {@link LogosConnectorService} handles the rich, per-store
 * credentialed Hermes→Sigo invoice flow (legacy Hermes webhook path). This connector
 * is the thin, canonical-event entrypoint used by the prizma-contracts router
 * for INVOICE_CREATE coming from ORDER_PAID / POS_SALE_CREATED (Flow 1 & 3).
 */
@Injectable()
export class LogosEventConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "logos";

  constructor(http: HttpService) {
    super(http, LogosEventConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.LOGOS_API_URL || serviceUrl("logos");
  }

  /** invoice.create — request an e-invoice for an order/sale. */
  async invoiceCreate(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/api/invoices/from-event", data, idempotencyKey);
  }
}
