import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  EVENTS,
  type PaymentGateway,
  type ParsedWebhook,
} from "prizma-payments";
import { MP_GATEWAY } from "./mp-gateway.provider";
import { MpIdempotencyStore } from "./mp-idempotency.store";
import {
  PaymentsInboundConnector,
  isKnownProduct,
  KNOWN_PRODUCTS,
} from "./payments-inbound.connector";

/**
 * Parsed `externalReference` following the ecosystem convention
 *
 *     <producto>:<kind>:<id...>
 *
 * Examples:  `hermes:order:123`            → product=hermes, kind=order, id=123
 *            `talaria:plan:user:45`        → product=talaria, kind=plan, id="user:45"
 *
 * - `producto` selects the destination product/connector (routing key).
 * - `kind`     is the business resource type (order, plan, …) — opaque to the Hub.
 * - `id`       is everything after the 2nd colon (may itself contain colons).
 */
export interface ParsedExternalReference {
  raw: string;
  product: string;
  kind: string;
  id: string;
}

/**
 * Result of processing one MP webhook. `retryable=true` means the failure is
 * transient (e.g. destination product down / 5xx) and the worker should
 * re-enqueue WITHOUT the idempotency store marking it as done. Absent/false
 * means terminal (handled, or permanently undeliverable) → safe to dedupe.
 */
export interface ProcessResult {
  handled: boolean;
  reason?: string;
  retryable?: boolean;
}

/** Parse `<producto>:<kind>:<id...>`; returns null if it doesn't fit the shape. */
export function parseExternalReference(
  ref: string | undefined,
): ParsedExternalReference | null {
  if (!ref) return null;
  const parts = ref.split(":");
  if (parts.length < 3) return null;
  const [product, kind, ...rest] = parts;
  if (!product || !kind || rest.length === 0) return null;
  return {
    raw: ref,
    product: product.toLowerCase().trim(),
    kind: kind.toLowerCase().trim(),
    id: rest.join(":"),
  };
}

/**
 * PaymentProcessorService — the async heavy lifting for a Mercado Pago webhook.
 *
 * Runs OUTSIDE the HTTP request (the controller already 200-ack'd MP and
 * enqueued the raw notification). For each notification it:
 *   1. idempotency-guards on the MP resource id (`wasAlreadyProcessed`),
 *   2. fetches the real resource state from MP
 *      (`getPayment` / `getPreapproval`),
 *   3. `mapStatus` → normalized status,
 *   4. builds the matching contract event
 *      (`pago.aprobado`/`pago.rechazado` | `suscripcion.activada`/`...cancelada`),
 *   5. routes it to the product's inbound webhook by the `externalReference`
 *      product prefix (reusing {@link PaymentsInboundConnector}).
 *
 * Fault-tolerant: the connector never throws and a missing/unconfigured token
 * is logged, not fatal.
 */
@Injectable()
export class PaymentProcessorService {
  private readonly logger = new Logger(PaymentProcessorService.name);

  constructor(
    @Inject(MP_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly idempotency: MpIdempotencyStore,
    private readonly inbound: PaymentsInboundConnector,
  ) {}

  /**
   * Process one already-verified MP webhook payload. Safe to call from the
   * queue worker. Returns a small result for logging; never throws.
   */
  async process(payload: any): Promise<ProcessResult> {
    let parsed: ParsedWebhook;
    try {
      parsed = this.gateway.parseWebhook(payload);
    } catch (err: any) {
      this.logger.warn(`parseWebhook falló: ${err?.message}`);
      return { handled: false, reason: "unparseable" };
    }

    const { kind, mpId } = parsed;
    if (!mpId) {
      this.logger.warn("Webhook MP sin id de recurso; ignorado.");
      return { handled: false, reason: "no_mp_id" };
    }

    // 1) Idempotency: dedupe by MP resource id.
    //    IMPORTANT: only CHECK here (has). We deliberately do NOT use
    //    `wasAlreadyProcessed`, because that helper marks the id as processed
    //    (add) on first sight — so a transient failure (e.g. getPayment throws)
    //    would permanently swallow the payment on retry. We mark as processed
    //    ONLY after the work reaches a TERMINAL state (see below).
    if (await this.idempotency.has(mpId)) {
      this.logger.log(`↩️ Webhook MP duplicado (mpId=${mpId}); ignorado.`);
      return { handled: false, reason: "duplicate" };
    }

    // 2 + 3) Fetch real state from MP and normalize it.
    let result: ProcessResult;
    try {
      result =
        kind === "payment"
          ? await this.handlePayment(mpId)
          : await this.handleSubscription(mpId);
    } catch (err: any) {
      // Transient failure (MP API error, network, etc.): do NOT mark processed
      // and flag retryable so the queue worker re-enqueues without being deduped.
      this.logger.error(
        `Error procesando webhook MP (kind=${kind}, mpId=${mpId}): ${err?.message}`,
      );
      return { handled: false, reason: "process_error", retryable: true };
    }

    // 4) Mark as processed ONLY for terminal outcomes. A `retryable` result
    //    (e.g. the product webhook was unreachable / returned 5xx) is left
    //    unmarked so the worker retries it; once it succeeds (or is terminally
    //    rejected) it will be deduped.
    if (!result.retryable) {
      await this.idempotency.add(mpId);
    } else {
      this.logger.warn(
        `⏳ Webhook MP (mpId=${mpId}) no marcado como procesado (retryable): ${result.reason}`,
      );
    }
    return result;
  }

  // --- payment (Checkout Pro) → pago.aprobado | pago.rechazado ---
  private async handlePayment(mpId: string): Promise<ProcessResult> {
    const info = await this.gateway.getPayment(mpId);
    const status = this.gateway.mapStatus(info.status);
    const externalReference = info.external_reference;

    if (status === "pendiente") {
      this.logger.log(
        `Pago ${mpId} en estado "${info.status}" (pendiente); sin evento de contrato.`,
      );
      return { handled: false, reason: "pending" };
    }

    const approved = status === "aprobado";
    const eventType = approved ? EVENTS.PAGO_APROBADO : EVENTS.PAGO_RECHAZADO;
    const body = approved
      ? {
          paymentRef: mpId,
          gateway: "mercadopago",
          monto: info.transaction_amount ?? 0,
          moneda: info.currency_id ?? "COP",
          externalReference: externalReference ?? "",
          mpPaymentId: mpId,
          status: info.status,
        }
      : {
          paymentRef: mpId,
          gateway: "mercadopago",
          externalReference: externalReference ?? "",
          motivo: info.status_detail || info.status || "rejected",
        };

    return this.route(externalReference, eventType, body, mpId);
  }

  // --- preapproval (subscription) → suscripcion.activada | ...cancelada ---
  private async handleSubscription(mpId: string): Promise<ProcessResult> {
    const info = await this.gateway.getPreapproval(mpId);
    // MP preapproval statuses: authorized | paused | cancelled | pending.
    const raw = (info.status || "").toLowerCase();
    const externalReference = info.external_reference;

    if (raw === "authorized") {
      const body = {
        subRef: mpId,
        plan: info.reason || "",
        // PreapprovalInfo doesn't carry amount/currency; the product knows the
        // plan price. We send the canonical placeholders the schema expects.
        monto: 0,
        moneda: "COP",
        externalReference: externalReference ?? "",
        mpPreapprovalId: mpId,
      };
      return this.route(externalReference, EVENTS.SUSCRIPCION_ACTIVADA, body, mpId);
    }

    if (raw === "cancelled" || raw === "paused") {
      const body = {
        subRef: mpId,
        externalReference: externalReference ?? "",
        motivo: info.status || "cancelled",
      };
      return this.route(externalReference, EVENTS.SUSCRIPCION_CANCELADA, body, mpId);
    }

    this.logger.log(
      `Suscripción ${mpId} en estado "${info.status}"; sin evento de contrato.`,
    );
    return { handled: false, reason: "no_mapped_status" };
  }

  /**
   * Routing by externalReference: parse `<producto>:<kind>:<id>` and deliver the
   * contract event to that product's inbound webhook via the connector.
   */
  private async route(
    externalReference: string | undefined,
    eventType: string,
    body: Record<string, unknown>,
    mpId: string,
  ): Promise<ProcessResult> {
    const ref = parseExternalReference(externalReference);
    if (!ref) {
      this.logger.warn(
        `externalReference inválido ("${externalReference}") para ${eventType} (mpId=${mpId}). ` +
          `Convención requerida: <producto>:<kind>:<id> (ej. hermes:order:123).`,
      );
      return { handled: false, reason: "bad_external_reference" };
    }
    if (!isKnownProduct(ref.product)) {
      this.logger.warn(
        `Producto "${ref.product}" no enrutable (conocidos: ${KNOWN_PRODUCTS.join(", ")}); ${eventType} no entregado.`,
      );
      return { handled: false, reason: "unknown_product" };
    }

    // Idempotency key threaded to the product so it can dedupe too.
    const idempotencyKey = `mp:${mpId}:${eventType}`;
    const result = await this.inbound.deliver(ref.product, eventType, body, idempotencyKey);
    this.logger.log(
      `💸 ${eventType} → ${ref.product} (${ref.kind}:${ref.id}) ` +
        `[mpId=${mpId}] ${result.ok ? "ok" : `fail(${result.reason || result.status || ""})`}`,
    );
    if (result.ok) {
      return { handled: true };
    }
    // The destination product could not be reached / errored. This is a
    // TRANSIENT delivery failure (an approved payment must reach the product),
    // so flag it retryable: the worker re-enqueues and the idempotency store is
    // NOT marked. A 4xx (other than skipped) is also retried; the product is
    // expected to dedupe via the forwarded x-idempotency-key.
    return {
      handled: false,
      reason: result.reason || (result.status ? `status_${result.status}` : "delivery_failed"),
      retryable: !result.skipped,
    };
  }
}
