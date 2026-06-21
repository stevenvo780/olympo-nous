import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Talanton POS destination connector.
 * Reacts to ORDER_PENDING_APPROVAL → notify Talanton for in-store approval
 * (Flow 2). Talanton later emits ORDER_APPROVED which resumes Flow 1.
 *
 * NOTE: Talanton has NO global `api` prefix (checked main.ts). Routes are bare.
 * The Nous sink lives at `POST /orders/pending-approval`.
 */
@Injectable()
export class TalantonConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "talanton";

  constructor(http: HttpService) {
    super(http, TalantonConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.SINERGIA_API_URL || serviceUrl("talanton");
  }

  /** pedido.pendiente_aprobacion — enqueue an order awaiting POS approval. */
  async notifyPendingApproval(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/orders/pending-approval", data, idempotencyKey);
  }

  /** inventory.sync — forward inventory update to Talanton POS. */
  async syncInventory(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/inventory/sync-from-hermes", data, idempotencyKey);
  }
}
