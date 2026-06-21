import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { serviceUrl, type ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../destination-connector.base";

/**
 * Pistis (credit / portfolio) destination connector.
 *
 * ⚠️  Revisión 2026-06-19: Pistis (fiar-api) no expone actualmente endpoints
 *     públicos para CREDIT_CHECK, CREDIT_APPROVED, ni PAYMENT_RECEIVED.
 *     El `ClientController` tiene operaciones CRUD básicas en `/clients`
 *     y `/clients/:id/balance`, pero están protegidas por FirebaseAuthGuard
 *     y no reciben webhooks del Hub.
 *
 *     Este conector existe como placeholder. Todos los métodos retornan
 *     `{ skipped: true, reason: "endpoint_not_available" }` para mantener
 *     la tolerancia a fallos del fan-out (ARCHITECTURE.md §2.2).
 */
@Injectable()
export class PistisConnectorService extends DestinationConnectorBase {
  protected readonly service: ServiceSource = "pistis";

  constructor(http: HttpService) {
    super(http, PistisConnectorService.name);
  }

  protected baseUrl(): string {
    return process.env.FIAR_API_URL || serviceUrl("pistis");
  }

  /** credit.check — endpoint no disponible en Pistis. Skipped. */
  async creditCheck(
    _data: Record<string, any>,
    _idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    this.logger.log("[pistis] credit.check: endpoint no disponible (skipped)");
    return {
      service: this.service,
      ok: false,
      skipped: true,
      reason: "endpoint_not_available: credit.check not exposed by Pistis",
    };
  }

  /** credit.approved — endpoint no disponible en Pistis. Skipped. */
  async creditApproved(
    _data: Record<string, any>,
    _idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    this.logger.log("[pistis] credit.approved: endpoint no disponible (skipped)");
    return {
      service: this.service,
      ok: false,
      skipped: true,
      reason: "endpoint_not_available: credit.approved not exposed by Pistis",
    };
  }

  /** payment.received — endpoint no disponible en Pistis. Skipped. */
  async paymentReceived(
    _data: Record<string, any>,
    _idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    this.logger.log("[pistis] payment.received: endpoint no disponible (skipped)");
    return {
      service: this.service,
      ok: false,
      skipped: true,
      reason: "endpoint_not_available: payment.received not exposed by Pistis",
    };
  }
}
