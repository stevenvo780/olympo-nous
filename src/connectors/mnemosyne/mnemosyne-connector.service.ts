import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Mnemosyne (CRM, Soft-ia) destination connector.
 * Reacts to ORDER_PAID / CUSTOMER_CREATED → CUSTOMER_UPDATE (Flow 1 & 5).
 */
@Injectable()
export class MnemosyneConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "mnemosyne";

  constructor(http: HttpService) {
    super(http, MnemosyneConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.MNEMOSYNE_API_URL || serviceUrl("mnemosyne");
  }

  /** customer.update — upsert the customer in the CRM. */
  async customerUpdate(
    data: Record<string, any>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    return this.post("/api/customers/upsert", data, idempotencyKey);
  }
}
