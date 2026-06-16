import { Injectable, Logger } from "@nestjs/common";
import {
  HubClient,
  EVENTS,
  validateEvent,
  EventEnvelopeSchema,
  type EventType,
  type PublishOptions,
} from "@olympo/contracts";
import { hubClient } from "./hub-client.provider";

/**
 * OlympoService — thin integration layer over `@olympo/contracts`' HubClient.
 *
 * It exposes one helper per business event that this service is responsible for
 * EMITTING, derived from the flows in ARCHITECTURE.md §4-5. HubCentral is the
 * orchestrator: it RECEIVES every event and re-emits the canonical ones (as
 * `source: "hub"`) so the rest of the ecosystem can react.
 *
 * Every publish is NON-BLOCKING / fault-tolerant: the underlying HubClient
 * swallows transport errors (returns false) so a hub outage never breaks the
 * local flow. Use `await cauce.<helper>(...)` freely — it will never throw.
 */
@Injectable()
export class OlympoService {
  private readonly logger = new Logger(OlympoService.name);
  private readonly hub: HubClient = hubClient;

  /** Expose the canonical catalog for callers that need the raw constants. */
  readonly EVENTS = EVENTS;

  /**
   * Low-level publish. Validates the payload against the canonical Zod schema
   * (best-effort: a validation miss is logged, not thrown) and forwards it to
   * the hub. Returns whether the hub accepted the event.
   */
  async publish(
    eventType: EventType | string,
    data: Record<string, unknown>,
    opts: PublishOptions = {},
  ): Promise<boolean> {
    try {
      const probe = EventEnvelopeSchema.safeParse({
        eventId: "probe",
        eventType,
        timestamp: new Date().toISOString(),
        source: "hub",
        data,
        priority: opts.priority || "normal",
      });
      if (probe.success) {
        const check = validateEvent(probe.data);
        if (!check.ok) {
          const reason = "error" in check ? check.error : "unknown";
          this.logger.warn(
            `Payload for "${eventType}" failed contract validation (publishing anyway): ${reason}`,
          );
        }
      }
    } catch {
      /* validation is best-effort, never blocks publishing */
    }

    return this.hub.publish(eventType, data, opts);
  }

  // --- Graf flows (§4.1, §4.2, §5): e-commerce orders & online customers ---
  /** Flow 1 — online order paid → CRM + invoice + delivery + WhatsApp. */
  publishOrderPaid(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.ORDER_PAID, data, { priority: "high", ...opts });
  }
  /** Flow 2 — offline order awaiting Sinergia approval. */
  publishOrderPendingApproval(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.ORDER_PENDING_APPROVAL, data, opts);
  }
  /** Flow 2 — order approved by Sinergia → resumes Flow 1. */
  publishOrderApproved(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.ORDER_APPROVED, data, opts);
  }
  /** Flow 5 — new customer → ApiSoftia CRM. */
  publishCustomerCreated(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.CUSTOMER_CREATED, data, opts);
  }

  // --- Sinergia POS (§4.3): in-store sales ---
  /** Flow 3 — POS sale → MeraVuelta + EMW + ApiSigo. */
  publishPosSaleCreated(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.POS_SALE_CREATED, data, opts);
  }

  // --- MeraVuelta (§4.7): delivery lifecycle ---
  publishDeliveryCreate(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.DELIVERY_CREATE, data, opts);
  }
  publishDeliveryStatusUpdate(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.DELIVERY_STATUS_UPDATE, data, opts);
  }
  publishDeliveryCompleted(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.DELIVERY_COMPLETED, data, opts);
  }

  // --- Fiar (§4.4): credit & payments ---
  publishCreditCheck(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.CREDIT_CHECK, data, opts);
  }
  publishCreditApproved(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.CREDIT_APPROVED, data, opts);
  }
  publishPaymentReceived(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.PAYMENT_RECEIVED, data, opts);
  }

  // --- EMW (§4.4, §4.1): WhatsApp notifications ---
  publishNotificationWhatsapp(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.NOTIFICATION_WHATSAPP, data, opts);
  }
  publishMessageSent(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.MESSAGE_SENT, data, opts);
  }

  // --- ApiSigo (§4.1, §4.3): e-invoicing ---
  publishInvoiceCreate(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.INVOICE_CREATE, data, opts);
  }
  publishInvoiceSent(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.INVOICE_SENT, data, opts);
  }

  // --- ApiSoftia (§5): CRM sync ---
  publishCustomerUpdate(data: Record<string, unknown>, opts?: PublishOptions) {
    return this.publish(EVENTS.CUSTOMER_UPDATE, data, opts);
  }
}
