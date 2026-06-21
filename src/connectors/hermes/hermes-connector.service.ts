import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Hermes (e-commerce, SSOT online order) destination connector.
 * Reacts to DELIVERY_STATUS_UPDATE / DELIVERY_COMPLETED → update the order's
 * delivery state in Hermes (Flow 7).
 *
 * Hermes backend has NO global `api` prefix. Routes are bare (e.g. `orders/:id/delivery`).
 */
@Injectable()
export class HermesConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "hermes";

  constructor(http: HttpService) {
    super(http, HermesConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.GRAF_API_URL || serviceUrl("hermes");
  }

  /** delivery.status_update / delivery.completed → patch the order in Hermes (PATCH orders/:id/delivery). */
  async updateOrderDelivery(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    const orderId = data?.orderId ?? data?.order_id ?? "";
    if (!orderId) {
      this.logger.warn("[hermes] updateOrderDelivery: orderId ausente; skipped");
      return { service: this.service, ok: false, skipped: true, reason: "missing_order_id" };
    }
    const path = `/orders/${encodeURIComponent(String(orderId))}/delivery`;
    return this.patch(path, data, idempotencyKey);
  }

  /** inventory.sync_from_talanton → sync inventory from POS sale (POST inventory/sync-from-pos). */
  async syncInventoryFromTalanton(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/inventory/sync-from-pos", data, idempotencyKey);
  }

  /** invoice.sent → update the order with invoice info (PATCH orders/:id). */
  async updateOrderInvoice(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    const orderId = data?.orderId ?? data?.order_id ?? "";
    if (!orderId) {
      this.logger.warn("[hermes] updateOrderInvoice: orderId ausente; skipped");
      return { service: this.service, ok: false, skipped: true, reason: "missing_order_id" };
    }
    const path = `/orders/${encodeURIComponent(String(orderId))}`;
    return this.patch(path, { invoiceId: data.invoiceId, invoicePdfUrl: data.pdfUrl }, idempotencyKey);
  }
}
