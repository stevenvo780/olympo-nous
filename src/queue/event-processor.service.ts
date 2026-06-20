import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  EventEnvelopeSchema,
  validateEvent,
  verifyRawBody,
  verifyEnvelope,
  verifySignature,
  type EventEnvelope,
} from "prizma-contracts";
import { QueueService } from "./queue.service";

export interface IngestResult {
  accepted: boolean;
  duplicate?: boolean;
  eventId: string;
  eventType: string;
  priority: EventEnvelope["priority"];
  idempotencyKey: string;
}

/**
 * EventProcessorService — inbound pipeline for canonical events arriving at
 * `POST /webhooks/nous`.
 *
 * Steps (ARCHITECTURE.md §4 envelope contract):
 *   1. Verify the HMAC-SHA256 signature on the RAW body BEFORE parsing
 *      (`verifyRawBody` on raw bytes, header `x-prizma-signature`).
 *      This ensures Zod's .default() fields don't break the signature later.
 *   2. Parse + structurally validate the EventEnvelope (Zod) on verified bytes.
 *   3. Validate the event-specific payload with `validateEvent`.
 *   4. Idempotency: dedupe by idempotencyKey (Redis), so a re-delivered event is
 *      accepted but not re-enqueued.
 *   5. Enqueue by priority for the worker to fan-out to destination connectors.
 */
@Injectable()
export class EventProcessorService {
  private readonly logger = new Logger(EventProcessorService.name);
  private readonly secret =
    process.env.PRIZMA_NOUS_SECRET ||
    process.env.PRIZMA_HUB_SECRET ||
    process.env.HUB_CENTRAL_SECRET ||
    process.env.NOUS_SECRET ||
    process.env.NOUS_HUB_SECRET ||
    process.env.CAUCE_HUB_SECRET ||
    undefined;

  constructor(private readonly queueService: QueueService) {}

  /**
   * Ingest a raw envelope from the nous webhook. Returns an IngestResult.
   * Throws BadRequestException on malformed envelope / bad signature / invalid
   * payload (the controller maps that to a 400).
   *
   * CRITICAL ORDER: verify(rawBody) → parse(json) → defaults safe
   *   1. Verify the raw body's signature BEFORE parsing, so Zod's .default()
   *      fields don't break the HMAC (different serialization after defaults).
   *   2. Parse the verified envelope with Zod.
   *   3. Validate event-specific payload.
   */
  async ingest(
    rawBody: string | Buffer | unknown,
    signatureHeader?: string,
  ): Promise<IngestResult> {
    // 1) HMAC verification first (BEFORE parsing) — FAIL-CLOSED.
    //    - In production a hub secret is MANDATORY: with no secret configured the
    //      hub would accept arbitrary unsigned events (order.paid, credit.approved,
    //      payment.received, …) and trigger real billing/delivery. Reject instead.
    //    - When a secret IS configured we ALWAYS require a present + valid
    //      signature on the ENTIRE envelope (metadata + data), not just data.
    if (!this.secret) {
      if (process.env.NODE_ENV === "production") {
        this.logger.error(
          "🔒 Sin secreto de hub en producción: se rechaza el evento (fail-closed). " +
            "Configura PRIZMA_NOUS_SECRET.",
        );
        throw new BadRequestException(
          "Hub secret not configured: refusing to process unsigned events",
        );
      }
      this.logger.warn(
        "⚠️ Sin secreto de hub configurado (NODE_ENV!=production): se omite verificación de firma SOLO en dev.",
      );
    } else {
      // Validate that rawBody is string/Buffer (has exact bytes to verify)
      if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) {
        this.logger.warn(
          `rawBody debe ser string o Buffer para verificación HMAC; recibido: ${typeof rawBody}`,
        );
        throw new BadRequestException(
          "rawBody must be string or Buffer for HMAC verification",
        );
      }

      if (!signatureHeader) {
        this.logger.warn(
          `Evento sin firma en header x-prizma-signature — rechazado (se requiere firma).`,
        );
        throw new BadRequestException("Missing x-prizma-signature header");
      }

      try {
        // Verify the raw body (throws on signature failure)
        verifyRawBody(rawBody, signatureHeader, this.secret);
        this.logger.debug(`✅ Firma HMAC verificada para envelope de rawBody`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Firma HMAC inválida: ${msg}`);
        throw new BadRequestException(`Invalid HMAC signature: ${msg}`);
      }
    }

    // 2) Parse + structural validation (now safe — signature already verified).
    const bodyStr = typeof rawBody === "string" ? rawBody : (rawBody as Buffer).toString("utf-8");
    let parsed;
    try {
      parsed = EventEnvelopeSchema.safeParse(JSON.parse(bodyStr));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Envelope inválido: ${msg}`);
      throw new BadRequestException(`Invalid event envelope: ${msg}`);
    }
    if (!parsed.success) {
      this.logger.warn(`Envelope inválido: ${parsed.error.message}`);
      throw new BadRequestException(`Invalid event envelope: ${parsed.error.message}`);
    }
    const env: EventEnvelope = parsed.data;

    // 3) Payload contract validation.
    const check = validateEvent(env);
    if (!check.ok) {
      const reason = "error" in check ? check.error : "unknown";
      this.logger.warn(
        `Payload de "${env.eventType}" no pasó validación de contrato: ${reason}`,
      );
      throw new BadRequestException(`Invalid event payload: ${reason}`);
    }

    // 4) Idempotency dedupe.
    const idempotencyKey = env.idempotencyKey || env.eventId;
    const dedupeKey = `idem:${idempotencyKey}`;
    const already = await this.queueService.isEventProcessed(dedupeKey);
    if (already) {
      this.logger.log(
        `↩️ Evento duplicado (idem=${idempotencyKey}) — aceptado sin reencolar.`,
      );
      return {
        accepted: true,
        duplicate: true,
        eventId: env.eventId,
        eventType: env.eventType,
        priority: env.priority,
        idempotencyKey,
      };
    }
    // Reserve the idempotency key up-front so concurrent re-deliveries collapse.
    await this.queueService.markAsProcessed(dedupeKey);

    // 5) Enqueue by priority.
    await this.queueService.addToPriorityQueue(
      {
        id: env.eventId,
        type: env.eventType,
        source: env.source,
        // carry the full canonical envelope so the worker can route it as-is.
        data: { envelope: env, idempotencyKey },
      },
      env.priority,
    );

    this.logger.log(
      `✅ Evento canónico aceptado: ${env.eventType} (id=${env.eventId}, prio=${env.priority}, idem=${idempotencyKey})`,
    );

    return {
      accepted: true,
      eventId: env.eventId,
      eventType: env.eventType,
      priority: env.priority,
      idempotencyKey,
    };
  }
}
