import {
  Controller,
  Post,
  Body,
  Headers,
  Query,
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  HttpCode,
  Inject,
  Logger,
  Req,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Request } from "express";
import type { PaymentGateway } from "prizma-payments";
import { WebhooksService } from "./webhooks.service";
import { EventProcessorService } from "../queue/event-processor.service";
import { MP_GATEWAY } from "../payments/mp-gateway.provider";
import { QueueService } from "../queue/queue.service";

@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly eventProcessor: EventProcessorService,
    @Inject(MP_GATEWAY) private readonly mpGateway: PaymentGateway,
    private readonly queueService: QueueService,
  ) {}

  /**
   * 🌊 Canonical Nous event ingress (Prizma contracts).
   *
   * Receives a signed {@link EventEnvelope} from any service in the ecosystem
   * (this is the exact path the contracts `HubClient` publishes to). It:
   *   1. Captures the raw body from the request (before JSON parsing)
   *   2. Verifies the HMAC-SHA256 signature of the ENTIRE envelope (header `x-prizma-signature`)
   *   3. Parses + validates the envelope (Zod) on the verified body,
   *   4. Validates the event-specific payload (`validateEvent`),
   *   5. Dedupes by idempotencyKey and enqueues by priority for fan-out.
   *
   * Returns 202 Accepted on success; 400 on a malformed/invalid/unsigned event.
   *
   * CRITICAL: The raw body MUST be verified BEFORE parsing, so that Zod's
   * .default() fields don't invalidate the HMAC. This ensures:
   *   - HubClient signs the exact envelope JSON it sends
   *   - Nous verifies the signature on the exact bytes received
   *   - Both match byte-for-byte
   */
  @Post("nous")
  @HttpCode(202)
  async handleNousEvent(
    @Body() envelope: any,
    @Headers("x-prizma-signature") signature?: string,
    @Req() req?: any,
  ): Promise<any> {
    try {
      // Pass raw body and signature to EventProcessorService for proper verification order
      const rawBody = (req as any)?.rawBody || JSON.stringify(envelope);
      const result = await this.eventProcessor.ingest(rawBody, signature);
      this.logger.log(
        `📥 nous: ${result.eventType} (id=${result.eventId})${result.duplicate ? " [duplicate]" : ""}`,
      );
      return { success: true, ...result };
    } catch (error) {
      // BadRequestException → 400 (malformed/invalid/bad signature).
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`❌ Error procesando evento nous: ${error.message}`);
      throw new BadRequestException(error.message);
    }
  }

  @Post("hermes")
  async handleHermesWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
    @Req() _req: Request,
  ): Promise<any> {
    this.logger.log("📥 Webhook recibido de Hermes", {
      eventType: payload.event_type,
      source: headers["x-source"],
    });

    try {
      const apiKey = headers["x-api-key"];
      if (!apiKey) {
        throw new BadRequestException(
          "❌ API Key requerida en header x-api-key",
        );
      }

      await this.webhooksService.validateSimpleApiKey(apiKey);

      const context = {
        tenantId: headers["x-tenant-id"] || "default",
        source: "hermes",
      };

      const result = await this.webhooksService.processHermesEvent(
        payload,
        context,
      );

      this.logger.log("✅ Evento procesado exitosamente", {
        eventType: payload.event_type,
        tenantId: context.tenantId,
        result,
      });

      return {
        success: true,
        message: "Evento procesado correctamente",
        result,
      };
    } catch (error) {
      this.logger.error("❌ Error procesando webhook de Hermes", {
        error: error.message,
        eventType: payload.event_type,
        tenantId: headers["x-tenant-id"],
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 💳 Mercado Pago — webhook ÚNICO del ecosistema (cuenta CENTRAL, App A/B).
   *
   * Una sola URL pública porque la cuenta MP es central; App A (suscripciones) y
   * App B (pedidos) se desambiguan por el `externalReference`
   * (`<producto>:<kind>:<id>`, ver PaymentProcessorService / PAYMENTS_MIGRATION).
   *
   * Flujo:
   *   1. Verifica la firma HMAC `x-signature` con `gateway.verifyWebhook`
   *      ({headers, query, rawBody}, secreto `MP_WEBHOOK_SECRET`). Si es inválida
   *      → 401 + log (fail-closed: sin secreto configurado, todo se rechaza).
   *   2. Responde **200 rápido** (MP exige un ack veloz; reintenta si tarda).
   *   3. El procesamiento pesado (consultar estado real en MP, mapear, emitir el
   *      evento de contrato y enrutar al producto) va ASÍNCRONO: se encola en la
   *      cola Redis existente y lo drena el worker → PaymentProcessorService.
   *
   * Idempotencia: el dedupe real por `mpId` ocurre en el worker
   * (`wasAlreadyProcessed` + MpIdempotencyStore), no aquí, para no bloquear el ack.
   */
  @Post("mercadopago")
  @HttpCode(200)
  async handleMercadoPagoWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, any>,
  ): Promise<{ received: true }> {
    // Raw body (Buffer) is required to reconstruct MP's signed manifest. It is
    // populated because the app is created with `{ rawBody: true }` (see main.ts).
    // A re-serialized `JSON.stringify(body)` would NOT match MP's original bytes
    // (key order/spacing/escapes), so signature verification could never pass.
    // Fail-closed: if the raw buffer is unexpectedly missing, reject instead of
    // verifying against reconstructed (and therefore wrong) bytes.
    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error(
        "🔒 MP webhook sin rawBody — no se puede verificar la firma. ¿Falta `{ rawBody: true }` en main.ts?",
      );
      throw new HttpException(
        "Raw body no disponible: no se puede verificar la firma de Mercado Pago",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const verification = this.mpGateway.verifyWebhook({ headers, query, rawBody });
    if (!verification.valid) {
      const reason = verification.reason || "invalid_signature";
      // Distinguish missing secret (misconfiguration) from bad signature (fraud/error).
      if (reason === "webhook secret no configurado") {
        this.logger.error(
          "🔒 MP secret no inyectado — webhook MP rechazado (503). Configura MP_WEBHOOK_SECRET.",
        );
        throw new HttpException(
          "MP secret no inyectado: servicio no disponible para webhooks MP",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.warn(
        `🔒 Webhook MP con firma inválida — rechazado (401). reason=${reason}`,
      );
      throw new UnauthorizedException("Invalid Mercado Pago signature");
    }

    // Enqueue the raw notification for async processing and ack MP immediately.
    // `data.id` may arrive in the body or the query (`?type=...&data.id=...`).
    const mpResourceId = body?.data?.id ?? query?.["data.id"] ?? query?.id ?? "unknown";
    try {
      await this.queueService.addToPriorityQueue(
        {
          id: `mp:${mpResourceId}:${Date.now()}`,
          type: "mp.webhook",
          source: "hub",
          // The worker recognizes `mpWebhook` and routes it to the processor.
          data: { mpWebhook: { ...body, _query: query } },
        },
        "high",
      );
      this.logger.log(
        `💳 Webhook MP verificado y encolado (type=${body?.type || query?.type}, resource=${mpResourceId}).`,
      );
    } catch (error: any) {
      // Even if enqueue fails we ack 200 so MP doesn't hammer us; the failure is
      // logged for alerting. MP will not re-deliver a 200'd notification.
      this.logger.error(`❌ No se pudo encolar webhook MP: ${error?.message}`);
    }

    return { received: true };
  }

  /**
   * 📦 Confirmation webhook from Talaria (MeraVuelta)
   * Receives async delivery confirmations: { orderId, service, status, timestamp, data }
   */
  @Post("confirmation")
  @HttpCode(200)
  async handleConfirmation(
    @Body() payload: any,
    @Headers("x-api-key") apiKey?: string,
  ): Promise<{ received: true }> {
    try {
      this.logger.log("📬 Confirmación recibida", {
        orderId: payload?.orderId,
        service: payload?.service,
        status: payload?.status,
        timestamp: payload?.timestamp,
      });

      // Auth: this mutates the order lifecycle downstream (Hermes + Iris), so it
      // must be authenticated like the Hermes webhook. Validate the shared hub
      // secret (constant-time, fail-closed) before enqueuing anything.
      if (!apiKey) {
        this.logger.warn("🔒 Confirmación sin x-api-key — rechazada.");
        throw new UnauthorizedException("API Key requerida en header x-api-key");
      }
      await this.webhooksService.validateSimpleApiKey(apiKey);

      const orderId = payload?.orderId ? String(payload.orderId) : "";
      if (!orderId) {
        this.logger.warn("⚠️ Confirmación sin orderId; se ignora.");
        return { received: true };
      }

      // Map Talaria's confirmation to a canonical delivery event and enqueue it
      // so the worker's canonical path (EventRouterService) propagates it to
      // Hermes (order update) + Iris (customer notification) — Flow 7.
      const envelope = this.webhooksService.buildDeliveryEnvelopeFromConfirmation(
        payload,
      );
      if (envelope) {
        await this.queueService.addToPriorityQueue(
          {
            id: envelope.eventId,
            type: envelope.eventType,
            source: "hub",
            data: { envelope, idempotencyKey: envelope.idempotencyKey },
          },
          "high",
        );
        this.logger.log(
          `📦 Confirmación Talaria encolada como ${envelope.eventType} (order=${orderId}).`,
        );
      } else {
        this.logger.warn(
          `⚠️ Confirmación con status no mapeable ("${payload?.status}"); solo registrada.`,
        );
      }

      return { received: true };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(`❌ Error procesando confirmación: ${error?.message}`);
      // Still ack to avoid retries on non-auth errors.
      return { received: true };
    }
  }

  /**
   * 🏥 Health check endpoint
   */
  @Post("health")
  async healthCheck(): Promise<any> {
    return {
      status: "ok",
      service: "Nous Webhooks",
      timestamp: new Date().toISOString(),
    };
  }
}
