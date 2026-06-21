import { Injectable, Logger } from "@nestjs/common";
import {
  LogosConnectorService,
  HermesOrder,
} from "./logos/logos-connector.service";
import { PluginsService } from "../plugins/plugins.service";

@Injectable()
export class ConnectorOrchestratorService {
  private readonly logger = new Logger(ConnectorOrchestratorService.name);

  constructor(
    private logosConnector: LogosConnectorService,
    private pluginsService: PluginsService,
  ) {}

  private async getLogosConfig(userEmail: string, storeId: string) {
    try {
      const user = await this.pluginsService.findUserByEmail(userEmail);
      if (!user) return {} as any;
      const creds = await this.pluginsService.getUserCredentials(user.id);
      const allCreds = (creds?.credentials || {})["logos"] || {};
      const candidateKeys = [
        `hermes-store-${storeId}`,
        storeId,
        "default",
      ].filter(Boolean) as string[];

      for (const key of candidateKeys) {
        const sub = (allCreds as any)[key];
        if (sub && typeof sub === "object") {
          return sub;
        }
      }

      return allCreds || {};
    } catch (e: any) {
      this.logger.warn(`No se pudo resolver config logos: ${e && e.message}`);
      return {} as any;
    }
  }

  public async processEvent(
    order: HermesOrder,
    eventType: string,
    userEmail: string,
    storeId: string,
  ): Promise<void> {
    this.logger.log(
      `🎯 Procesando evento: ${eventType} - Pedido ${order.id} - Tienda ${storeId}`,
    );
    try {
      const logosCfg = await this.getLogosConfig(userEmail, storeId);
      const single: string | undefined =
        (logosCfg && (logosCfg as any).triggerEvent) ||
        (logosCfg && (logosCfg as any).config && (logosCfg as any).config.triggerEvent);
      const arr: string[] | undefined =
        (Array.isArray((logosCfg as any)?.triggerEvents) && (logosCfg as any).triggerEvents) ||
        (Array.isArray((logosCfg as any)?.config?.triggerEvents) && (logosCfg as any).config.triggerEvents) ||
        undefined;

      const effectiveTriggerRaw = (typeof single === 'string' && single.trim())
        ? single.trim()
        : (Array.isArray(arr) && arr.find((v) => typeof v === 'string')) || 'order.paid';

      const normalize = (evt?: string): string => {
        if (!evt) return "";
        const e = String(evt).toLowerCase().trim();
        const map: Record<string, string> = {
          "order.paid": "order.paid",
          "order.pending": "order.pending",
          "order.shipped": "order.shipped",
          "order.sent": "order.shipped",
          "order.delivered": "order.delivered",
          "order.canceled": "order.canceled",
          "order.cancelled": "order.canceled",
          "order.updated": "order.updated",
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
        };
        if (e.startsWith("pedido.") || e.startsWith("orden.") || e.startsWith("cliente.")) {
          this.logger.warn(
            `Evento no estándar (ES) recibido: "${evt}". El backend espera eventos en inglés. Ajusta el emisor a nombres EN (p.ej., order.paid).`,
          );
        }
        return map[e] || e;
      };

      const statusToEvent = (st?: HermesOrder["status"]): string => {
        const s = String(st || "").toLowerCase().trim();
        const map: Record<string, string> = {
          "paid": "order.paid",
          "pagado": "order.paid",
          "pending": "order.pending",
          "pendiente": "order.pending",
          "shipped": "order.shipped",
          "enviado": "order.shipped",
          "despachado": "order.shipped",
          "delivered": "order.delivered",
          "entregado": "order.delivered",
          "canceled": "order.canceled",
          "cancelled": "order.canceled",
          "cancelado": "order.canceled",
        };
        return map[s] || "order.pending";
      };

      const incomingNormalized = normalize(eventType);
      const derivedFromStatus = statusToEvent(order?.status);
      const effectiveIncoming = incomingNormalized === "order.updated"
        ? normalize(derivedFromStatus)
        : incomingNormalized;
      const effectiveTrigger = normalize(effectiveTriggerRaw);

      this.logger.log(
        `Trigger efectivo para tienda ${storeId}: ${effectiveTrigger} (raw=${effectiveTriggerRaw}) | evento entrante: ${incomingNormalized} (raw=${eventType}) | derivado: ${effectiveIncoming} (desde status=${order?.status})`,
      );

      const orderEvents = new Set([
        "order.updated",
        "order.paid",
        "order.pending",
        "order.shipped",
        "order.delivered",
        "order.canceled",
      ]);

      const matchesByEvent = effectiveIncoming === effectiveTrigger;
      const matchesByStatus = orderEvents.has(incomingNormalized) && derivedFromStatus === effectiveTrigger;

      if (!matchesByEvent && !matchesByStatus) {
        this.logger.log(
          `ℹ️ Evento ${effectiveIncoming} no configurado para facturar (trigger configurado: ${effectiveTrigger}). Estado actual derivado: ${derivedFromStatus}`,
        );
        return;
      }

      const resp = await this.logosConnector.enviarFactura(
        order,
        userEmail,
        storeId,
        effectiveIncoming,
        logosCfg,
      );
      if (resp?.skipped) {
        this.logger.warn(
          `⏭️ Envío omitido para pedido ${order.id} (reason=${resp?.reason})`,
        );
      } else {
        this.logger.log(`✅ Factura enviada para pedido ${order.id}`);
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Error procesando evento ${eventType}:`,
        error?.message,
      );
      throw error;
    }
  }
}
