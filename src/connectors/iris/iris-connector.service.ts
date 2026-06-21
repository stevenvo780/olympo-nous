import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * IRIS (WhatsApp notifications / campaigns) destination connector.
 * Reacts to ORDER_PAID / POS_SALE_CREATED / DELIVERY_* → NOTIFICATION_WHATSAPP.
 *
 * Real endpoints:
 *   POST /api/notifications — create WhatsApp notification (Hub Central Flujo 1A)
 *   POST /api/templates/send  — send a WhatsApp template
 */
@Injectable()
export class IrisConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "iris";

  constructor(http: HttpService) {
    super(http, IrisConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.EMW_API_URL || serviceUrl("iris");
  }

  /** notification.whatsapp — send a WhatsApp notification (POST /api/notifications). */
  async notificationWhatsapp(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/api/notifications", data, idempotencyKey);
  }

  /** templates.send — send a pre-configured WhatsApp template (POST /api/templates/send). */
  async sendTemplate(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/api/templates/send", data, idempotencyKey);
  }
}
