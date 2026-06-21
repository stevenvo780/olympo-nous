import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import type { ServiceSource } from "prizma-contracts";
import {
  DestinationConnectorBase,
  ConnectorResult,
} from "../connectors/destination-connector.base";

/**
 * Target product → ecosystem service + base-URL resolution for the payments
 * fan-out. The `<producto>` prefix of a Mercado Pago `externalReference`
 * (`<producto>:<kind>:<id>`) is matched against this table to decide WHERE the
 * resulting `pago.*` / `suscripcion.*` contract event is delivered.
 *
 * Products use the new Prizma names; each maps 1:1 to an existing ecosystem
 * service whose connectors/URLs the Hub already knows (see ARCHITECTURE.md and
 * the `*_API_URL` env vars in `.env.example`). The env override is tried first
 * so dev/test/prod can repoint a product without code changes; the legacy var
 * is kept as a fallback during the rename window.
 */
interface ProductTarget {
  /** Canonical ecosystem service this product is served by. */
  service: ServiceSource;
  /** Resolve the product's public base URL from env (new → legacy fallback). */
  resolveUrl(): string;
}

const PRODUCT_TARGETS: Record<string, ProductTarget> = {
  // Hermes (e-commerce) → Hermes backend. Orders / checkout payments.
  hermes: {
    service: "hermes",
    resolveUrl: () => process.env.HERMES_API_URL || "",
  },
  // Talaria (delivery / SaaS plans) → Talaria API. Plan subscriptions.
  talaria: {
    service: "talaria",
    resolveUrl: () => process.env.TALARIA_API_URL || "",
  },
  // Iris (WhatsApp) → IRIS backend.
  iris: {
    service: "iris",
    resolveUrl: () => process.env.IRIS_API_URL || "",
  },
  // Talanton (POS) → Talanton backend.
  talanton: {
    service: "talanton",
    resolveUrl: () => process.env.TALANTON_API_URL || "",
  },
  // Pistis (credit) → Pistis API.
  pistis: {
    service: "pistis",
    resolveUrl: () => process.env.PISTIS_API_URL || "",
  },
  // Logos (e-invoicing) → Logos.
  logos: {
    service: "logos",
    resolveUrl: () => process.env.LOGOS_API_URL || "",
  },
};

/** True if `product` is a routable product prefix. */
export function isKnownProduct(product: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRODUCT_TARGETS, product);
}

/** The list of routable product prefixes (for logs / docs / validation). */
export const KNOWN_PRODUCTS = Object.keys(PRODUCT_TARGETS);

/**
 * PaymentsInboundConnector — delivers a payment-lifecycle contract event to the
 * inbound webhook of the product that originated the payment.
 *
 * It REUSES {@link DestinationConnectorBase}, exactly like every other Hub
 * connector (Hermes/IRIS/Talaria/...), so it inherits for free:
 *   - fault tolerance (never throws; a dead product does not break the flow),
 *   - HMAC signing (`x-prizma-signature`) with the hub secret,
 *   - idempotency forwarding (`x-idempotency-key`).
 *
 * The destination service is chosen at call time from the `externalReference`
 * product prefix, so this single connector covers every product instead of one
 * class per product.
 */
@Injectable()
export class PaymentsInboundConnector extends DestinationConnectorBase {
  // Default identity for logs/results; the effective destination is per-call.
  protected readonly service: ServiceSource = "nous";
  private currentBaseUrl = "";

  constructor(http: HttpService) {
    super(http, PaymentsInboundConnector.name);
  }

  protected baseUrl(): string {
    return this.currentBaseUrl;
  }

  /**
   * POST the contract event to `<product base>/api/webhooks/payments`.
   *
   * `product` is the prefix parsed from `externalReference`; `eventType` is the
   * contract event (`pago.aprobado` | `pago.rechazado` | `suscripcion.activada`
   * | `suscripcion.cancelada`); `body` is the contract payload (carries
   * `externalReference`). Returns a {@link ConnectorResult} — never throws.
   */
  async deliver(
    product: string,
    eventType: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<ConnectorResult> {
    const target = PRODUCT_TARGETS[product];
    if (!target) {
      this.logger.warn(
        `externalReference con producto desconocido "${product}"; evento ${eventType} no enrutado (skipped).`,
      );
      return { service: "nous", ok: false, skipped: true, reason: "unknown_product" };
    }

    this.currentBaseUrl = target.resolveUrl();
    // The inbound contract webhook of each product. PW3 mounts this when wiring
    // checkouts (see PAYMENTS_MIGRATION.md appendix). The eventType travels in
    // the body and as a header so the product can switch on it cheaply.
    return this.post(
      "/api/webhooks/payments",
      { eventType, ...body },
      idempotencyKey,
      { "x-prizma-event": eventType, "x-prizma-target": target.service },
    );
  }
}
