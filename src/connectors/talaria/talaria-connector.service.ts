import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Talaria (delivery / logistics) destination connector.
 * Reacts to ORDER_PAID / POS_SALE_CREATED → DELIVERY_CREATE (Flow 1 & 3).
 */
@Injectable()
export class TalariaConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "talaria";

  constructor(http: HttpService) {
    super(http, TalariaConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.MERAVUELTA_API_URL || serviceUrl("talaria");
  }

  /** delivery.create — create a delivery for an order/sale (POST /api/webhooks/deliveries). */
  async deliveryCreate(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/api/webhooks/deliveries", data, idempotencyKey);
  }
}
