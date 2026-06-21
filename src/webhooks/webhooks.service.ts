import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { EVENTS, type EventEnvelope } from "prizma-contracts";
import { PluginsService } from "../plugins/plugins.service";
import { QueueService } from "../queue/queue.service";

interface WebhookContext {
  userId?: string;
  tenantId?: string;
  source: string;
  userCredentials?: any;
}

interface ProcessingResult {
  success: boolean;
  pluginsTriggered: string[];
  events: any[];
  skippedPlugins?: string[];
  errors?: any[];
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private pluginsService: PluginsService,
    private queueService: QueueService,
  ) {}

  async validateSimpleApiKey(providedApiKey: string): Promise<void> {
    const expectedApiKey =
      process.env.PRIZMA_NOUS_SECRET ||
      process.env.PRIZMA_HUB_SECRET ||
      process.env.HUB_CENTRAL_SECRET ||
      process.env.NOUS_SECRET ||
      process.env.NOUS_HUB_SECRET ||
      process.env.CAUCE_HUB_SECRET;

    if (!providedApiKey) {
      this.logger.error("❌ Missing API key in request");
      throw new Error("Missing API key");
    }

    // Fail-closed: never authenticate when no secret is configured.
    if (!expectedApiKey) {
      this.logger.error(
        "🔒 Hub secret no configurado: se rechaza el webhook Hermes (fail-closed).",
      );
      throw new Error("Hub secret not configured");
    }

    // Constant-time comparison to avoid leaking the secret via timing.
    if (!this.safeEqual(providedApiKey, expectedApiKey)) {
      this.logger.error("❌ Invalid API key provided");
      throw new Error("Invalid API key");
    }

    this.logger.log("✅ API key validated successfully");
  }

  /** Length-safe, constant-time string comparison (avoids timing attacks). */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) {
      // Compare against itself to keep the work constant even on length mismatch.
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  async processHermesEvent(
    payload: any,
    context?: WebhookContext,
  ): Promise<ProcessingResult> {
    const rawEventType = payload.event_type || payload.eventType;
    const eventType = this.normalizeEventType(rawEventType);
    this.logger.log(`🎯 Processing Hermes event: ${rawEventType} → ${eventType}`);

    const result: ProcessingResult = {
      success: true,
      pluginsTriggered: [],
      events: [],
      skippedPlugins: [],
      errors: [],
    };

    try {
      let userCredentials = context?.userCredentials;

      if (!userCredentials && payload.data?.store?.owner?.email) {
        const storeOwnerEmail = payload.data.store.owner.email;
        this.logger.debug(
          `🔍 Resolviendo credenciales para store owner: ${storeOwnerEmail}`,
        );

        try {
          const user =
            await this.pluginsService.findUserByEmail(storeOwnerEmail);
          if (user) {
            const credentials = await this.pluginsService.getUserCredentials(
              user.id,
            );
            userCredentials = {
              userId: user.id,
              userEmail: user.email,
              userCredentials: credentials,
            };
            this.logger.debug(
              `✅ Credenciales resueltas para: ${user.email} (${user.id})`,
            );
          } else {
            this.logger.warn(
              `❌ Usuario no encontrado para email: ${storeOwnerEmail}`,
            );
          }
        } catch (error) {
          this.logger.warn(`Error resolviendo credenciales: ${error.message}`);
        }
      }

      // Normaliza status de orden si viene en payload
      try {
        if (payload?.data && typeof payload.data === "object") {
          const st = payload.data.status;
          if (typeof st === "string" && st.trim()) {
            const normStatus = this.normalizeStatus(st);
            if (normStatus !== st) {
              payload.data.status = normStatus;
            }
          }
        }
      } catch {}

      await this.queueService.addToQueue({
        id: `${Date.now()}-${Math.random()}`,
        type: eventType,
        data: { ...payload, userCredentials },
        source: "hermes",
      });

      result.pluginsTriggered.push("queued");

      this.logger.log(
        `✅ Hermes event processed: ${result.pluginsTriggered.length} plugins triggered`,
      );
      return result;
    } catch (error) {
      this.logger.error(`❌ Error processing Hermes event: ${error.message}`);
      result.success = false;
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Map a Talaria (MeraVuelta) delivery confirmation
   * `{ orderId, service, status, timestamp, data }` to a canonical
   * delivery contract envelope so the worker's EventRouterService can propagate
   * it to Hermes (order update) + Iris (customer notification) — Flow 7.
   *
   * Returns null when the status is not mappable (caller just logs + acks).
   */
  buildDeliveryEnvelopeFromConfirmation(payload: any): EventEnvelope | null {
    const orderId = payload?.orderId ? String(payload.orderId) : "";
    if (!orderId) return null;

    const status = this.normalizeDeliveryStatus(payload?.status);
    if (!status) return null;

    const deliveryId = String(
      payload?.deliveryId ?? payload?.data?.deliveryId ?? `talaria:${orderId}`,
    );
    const completed = status === "delivered";
    const eventType = completed
      ? EVENTS.DELIVERY_COMPLETED
      : EVENTS.DELIVERY_STATUS_UPDATE;

    // Both connectors read `data.orderId`; the schema needs deliveryId/status.
    const data: Record<string, any> = completed
      ? {
          deliveryId,
          orderId,
          at: payload?.timestamp || new Date().toISOString(),
        }
      : { deliveryId, orderId, status };

    return {
      eventId: uuidv4(),
      eventType,
      timestamp: new Date().toISOString(),
      source: "talaria",
      data,
      // Stable idempotency key per (order, status) so re-deliveries collapse.
      idempotencyKey: `talaria:confirmation:${orderId}:${status}`,
      priority: "high",
    };
  }

  /** Normalize Talaria delivery status to the contract enum; null if unknown. */
  private normalizeDeliveryStatus(
    st?: string,
  ): "assigned" | "picked_up" | "in_transit" | "delivered" | "failed" | null {
    const s = String(st || "").toLowerCase().trim();
    const map: Record<
      string,
      "assigned" | "picked_up" | "in_transit" | "delivered" | "failed"
    > = {
      assigned: "assigned",
      asignado: "assigned",
      picked_up: "picked_up",
      pickedup: "picked_up",
      recogido: "picked_up",
      in_transit: "in_transit",
      intransit: "in_transit",
      en_transito: "in_transit",
      en_camino: "in_transit",
      delivered: "delivered",
      entregado: "delivered",
      completed: "delivered",
      completado: "delivered",
      failed: "failed",
      fallido: "failed",
      fallida: "failed",
    };
    return map[s] || null;
  }

  private normalizeEventType(evt?: string): string {
    if (!evt) return "";
    const e = String(evt).toLowerCase().trim();
    const map: Record<string, string> = {
      // EN canonicals
      "order.paid": "order.paid",
      "order.pending": "order.pending",
      "order.shipped": "order.shipped",
      "order.sent": "order.shipped",
      "order.delivered": "order.delivered",
      "order.canceled": "order.canceled",
      "order.cancelled": "order.canceled",
      "order.updated": "order.updated",
      "customer.created": "customer.created",
      "customer.updated": "customer.updated",
      // ES → EN
      "pedido.pagado": "order.paid",
      "pedido.pendiente": "order.pending",
      "pedido.enviado": "order.shipped",
      "pedido.despachado": "order.shipped",
      "pedido.entregado": "order.delivered",
      "pedido.cancelado": "order.canceled",
      "pedido.actualizado": "order.updated",
      "orden.pagado": "order.paid",
      "orden.pendiente": "order.pending",
      "orden.enviado": "order.shipped",
      "orden.despachado": "order.shipped",
      "orden.entregado": "order.delivered",
      "orden.cancelado": "order.canceled",
      "orden.actualizado": "order.updated",
      "cliente.creado": "customer.created",
      "cliente.actualizado": "customer.updated",
      // POS / otros
      "pos.sale.created": "pos.sale.created",
      "venta_pos.creada": "pos.sale.created",
    };
    return map[e] || e;
  }

  private normalizeStatus(st?: string): string {
    const s = String(st || "").toLowerCase().trim();
    const map: Record<string, string> = {
      pending: "pending",
      pendiente: "pending",
      paid: "paid",
      pagado: "paid",
      shipped: "shipped",
      enviado: "shipped",
      despachado: "shipped",
      delivered: "delivered",
      entregado: "delivered",
      canceled: "canceled",
      cancelled: "canceled",
      cancelado: "canceled",
    };
    return map[s] || s;
  }
}
