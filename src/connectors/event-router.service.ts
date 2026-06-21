import { Injectable, Logger } from "@nestjs/common";
import { EVENTS, type EventEnvelope } from "prizma-contracts";
import { MnemosyneConnectorService } from "./mnemosyne/mnemosyne-connector.service";
import { LogosEventConnectorService } from "./logos/logos-event-connector.service";
import { TalariaConnectorService } from "./talaria/talaria-connector.service";
import { IrisConnectorService } from "./iris/iris-connector.service";
import { TalantonConnectorService } from "./talanton/talanton-connector.service";
import { HermesConnectorService } from "./hermes/hermes-connector.service";
import { PistisConnectorService } from "./pistis/pistis-connector.service";
import { ConnectorResult } from "./destination-connector.base";

/**
 * EventRouterService — the fan-out core of Nous orchestration.
 *
 * Given a canonical {@link EventEnvelope} (already parsed, signature-verified and
 * schema-validated upstream), it routes the event to every destination connector
 * required by the business flows in ARCHITECTURE.md §4:
 *
 *   ORDER_PAID              → Mnemosyne(CUSTOMER_UPDATE) + Logos(INVOICE_CREATE)
 *                             + Talaria(DELIVERY_CREATE) + IRIS(NOTIFICATION_WHATSAPP)
 *   ORDER_PENDING_APPROVAL  → Talanton (pending approval)
 *   ORDER_APPROVED          → resumes ORDER_PAID fan-out
 *   POS_SALE_CREATED        → Talaria + IRIS + Logos
 *   DELIVERY_STATUS_UPDATE  → Hermes (update order) + IRIS
 *   DELIVERY_COMPLETED      → Hermes (update order) + IRIS
 *   CREDIT_CHECK            → Pistis (skipped) + IRIS notification
 *   CREDIT_APPROVED         → Pistis (skipped) + IRIS notification
 *   PAYMENT_RECEIVED        → Pistis (skipped) + IRIS notification
 *   INVOICE_CREATE          → Logos + Hermes (update order)
 *   INVOICE_SENT            → Hermes (update order) + IRIS notification
 *   INVENTORY_UPDATE        → Hermes + Talanton
 *   INVENTORY_SYNC_FROM_HERMES  → Talanton
 *   INVENTORY_SYNC_FROM_TALANTON → Hermes
 *   INVENTORY_SYNCED        → log (no fan-out)
 *   NOTIFICATION_WHATSAPP   → IRIS (forward)
 *   MESSAGE_SENT            → IRIS (forward)
 *
 * Fault tolerance (§2.2): every connector call is awaited via Promise.allSettled
 * and each connector itself never throws, so one dead destination does not break
 * the rest of the fan-out. Idempotency: the envelope's idempotencyKey is threaded
 * down to every destination call (forwarded as x-idempotency-key); central dedup
 * by idempotencyKey happens in the inbound queue (see EventProcessorService).
 */
@Injectable()
export class EventRouterService {
  private readonly logger = new Logger(EventRouterService.name);

  constructor(
    private readonly mnemosyne: MnemosyneConnectorService,
    private readonly logos: LogosEventConnectorService,
    private readonly talaria: TalariaConnectorService,
    private readonly iris: IrisConnectorService,
    private readonly talanton: TalantonConnectorService,
    private readonly hermes: HermesConnectorService,
    private readonly pistis: PistisConnectorService,
  ) {}

  /** Route a canonical envelope to its destination connectors. */
  async route(env: EventEnvelope): Promise<ConnectorResult[]> {
    const idem = env.idempotencyKey || env.eventId;
    const data = env.data || {};
    this.logger.log(
      `🧭 Routing "${env.eventType}" (id=${env.eventId}, source=${env.source}, idem=${idem})`,
    );

    let tasks: Promise<ConnectorResult>[] = [];

    switch (env.eventType) {
      // ── Flow 1 (online) & Flow 2 resume (offline approved): full fan-out ──
      case EVENTS.ORDER_PAID: // "pedido.pagado"
      case EVENTS.ORDER_APPROVED: // "pedido.aprobado" → resumes Flow 1
        tasks = [
          this.mnemosyne.customerUpdate(this.toCustomerUpdate(data), idem),
          this.logos.invoiceCreate(this.toInvoiceCreate(data), idem),
          this.talaria.deliveryCreate(this.toDeliveryCreate(data), idem),
          this.iris.notificationWhatsapp(this.toOrderNotification(data), idem),
        ];
        break;

      // ── Flow 2 (offline): wait for Talanton approval ──
      case EVENTS.ORDER_PENDING_APPROVAL: // "pedido.pendiente_aprobacion"
        tasks = [this.talanton.notifyPendingApproval(data, idem)];
        break;

      // ── Flow 3 (in-store sale) ──
      case EVENTS.POS_SALE_CREATED: // "venta_pos.creada"
        tasks = [
          this.talaria.deliveryCreate(this.toDeliveryCreate(data), idem),
          this.iris.notificationWhatsapp(this.toSaleNotification(data), idem),
          this.logos.invoiceCreate(this.toInvoiceCreate(data), idem),
        ];
        break;

      // ── Flow 7 (delivery lifecycle): keep Hermes order in sync + notify customer ──
      case EVENTS.DELIVERY_STATUS_UPDATE: // "delivery.status_update"
      case EVENTS.DELIVERY_COMPLETED: // "delivery.completed"
      case EVENTS.DELIVERY_CREATED: // "delivery.created"
        tasks = [
          this.hermes.updateOrderDelivery(data, idem),
          this.iris.notificationWhatsapp(this.toDeliveryNotification(env.eventType, data), idem),
        ];
        break;

      // ── Flow 5: standalone CRM sync ──
      case EVENTS.CUSTOMER_CREATED: // "cliente.creado"
        tasks = [this.mnemosyne.customerUpdate(this.toCustomerUpdate(data), idem)];
        break;

      // ── Credit events (Pistis) → Pistis (skipped, no endpoint) + IRIS notification ──
      case EVENTS.CREDIT_CHECK: // "credit.check"
        tasks = [
          this.pistis.creditCheck(data, idem),
          this.iris.notificationWhatsapp(this.toCreditNotification("credit_check", data), idem),
        ];
        break;

      case EVENTS.CREDIT_APPROVED: // "credit.approved"
        tasks = [
          this.pistis.creditApproved(data, idem),
          this.iris.notificationWhatsapp(this.toCreditNotification("credit_approved", data), idem),
        ];
        break;

      case EVENTS.PAYMENT_RECEIVED: // "payment.received"
        tasks = [
          this.pistis.paymentReceived(data, idem),
          this.iris.notificationWhatsapp(this.toPaymentNotification(data), idem),
        ];
        break;

      // ── Invoice events → Logos + Hermes ──
      case EVENTS.INVOICE_CREATE: // "invoice.create"
        tasks = [
          this.logos.invoiceCreate(this.toInvoiceCreate(data), idem),
          this.hermes.updateOrderInvoice(data, idem),
        ];
        break;

      case EVENTS.INVOICE_SENT: // "invoice.sent"
        tasks = [
          this.hermes.updateOrderInvoice(data, idem),
          this.iris.notificationWhatsapp(this.toInvoiceSentNotification(data), idem),
        ];
        break;

      // ── Inventory events → Hermes / Talanton cross-sync ──
      case EVENTS.INVENTORY_UPDATE: // "inventory.update"
        tasks = [
          this.hermes.syncInventoryFromTalanton(data, idem),
          this.talanton.syncInventory(data, idem),
        ];
        break;

      case EVENTS.INVENTORY_SYNC_FROM_HERMES: // "inventory.sync_from_hermes"
        tasks = [this.talanton.syncInventory(data, idem)];
        break;

      case EVENTS.INVENTORY_SYNC_FROM_TALANTON: // "inventory.sync_from_talanton"
        tasks = [this.hermes.syncInventoryFromTalanton(data, idem)];
        break;

      case EVENTS.INVENTORY_SYNCED: // "inventory.synced"
        this.logger.log(
          `📦 Inventory synced: ${data.count ?? "?"} items at ${data.at || "unknown"}`,
        );
        return [];

      // ── Notification events → IRIS forward ──
      case EVENTS.NOTIFICATION_WHATSAPP: // "notification.whatsapp"
        tasks = [this.iris.notificationWhatsapp(data, idem)];
        break;

      case EVENTS.MESSAGE_SENT: // "message.sent"
        tasks = [this.iris.sendTemplate(this.toMessageSentPayload(data), idem)];
        break;

      default:
        this.logger.debug(
          `No destination route for "${env.eventType}"; ignoring (open ecosystem).`,
        );
        return [];
    }

    const settled = await Promise.allSettled(tasks);
    const results: ConnectorResult[] = settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { service: "nous", ok: false, reason: (s.reason as Error)?.message },
    );

    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.skipped).map((r) => r.service);
    const skipped = results.filter((r) => r.skipped).map((r) => r.service);
    this.logger.log(
      `🧭 Routed "${env.eventType}": ${okCount}/${results.length} ok` +
        (failed.length ? ` · failed=[${failed.join(",")}]` : "") +
        (skipped.length ? ` · skipped=[${skipped.join(",")}]` : ""),
    );
    return results;
  }

  // ─── payload adapters: canonical event data → per-destination request body ───

  private toCustomerUpdate(data: any): Record<string, any> {
    return {
      customer: data.customer || {},
      source: data.source || "hermes",
      orderId: data.orderId,
    };
  }

  private toInvoiceCreate(data: any): Record<string, any> {
    return {
      orderId: data.orderId ?? data.saleId,
      customer: data.customer || {},
      items: data.items || [],
      total: data.total,
      currency: data.currency || "COP",
      store: data.store,
    };
  }

  /** Adapts to Talaria /api/webhooks/deliveries expected payload. */
  private toDeliveryCreate(data: any): Record<string, any> {
    return {
      orderId: data.orderId ?? data.saleId ?? "",
      orderNumber: String(data.orderId ?? data.saleId ?? data.orderNumber ?? ""),
      status: "paid",
      customerName: data.customer?.name || "Cliente Prizma",
      customerPhone: data.customer?.phone || data.to || "0000000000",
      customerEmail: data.customer?.email || "",
      deliveryAddress:
        data.address ||
        data.shippingAddress?.address ||
        data.customer?.address ||
        "Direccion pendiente",
      city: data.shippingAddress?.city || data.customer?.city || "Bogota",
      department: data.shippingAddress?.department || data.customer?.department || "Cundinamarca",
      orderValue: Number(data.total ?? 0),
      paymentMethod: data.paymentMethod || "online",
      products: Array.isArray(data.items)
        ? data.items.map((i: any) => ({
            name: i.name || i.sku || "",
            quantity: i.qty ?? i.quantity ?? 1,
            unitPrice: i.unitPrice ?? i.price ?? 0,
            totalPrice: (i.qty ?? i.quantity ?? 1) * (i.unitPrice ?? i.price ?? 0),
          }))
        : [],
      deliveryNotes: data.notes || "",
      timestamp: new Date().toISOString(),
    };
  }

  /** Adapts to Iris /api/notifications expected payload. */
  private toOrderNotification(data: any): Record<string, any> {
    return {
      orderId: String(data.orderId ?? ""),
      orderNumber: String(data.orderId ?? data.orderNumber ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: "order_paid",
      orderValue: Number(data.total ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toSaleNotification(data: any): Record<string, any> {
    return {
      orderId: String(data.saleId ?? ""),
      orderNumber: String(data.saleId ?? data.orderNumber ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: "order_paid",
      orderValue: Number(data.total ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toDeliveryNotification(eventType: string, data: any): Record<string, any> {
    const isCompleted = eventType === EVENTS.DELIVERY_COMPLETED;
    return {
      orderId: String(data.orderId ?? ""),
      orderNumber: String(data.orderId ?? data.deliveryId ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: isCompleted ? "order_delivered" : "delivery_created",
      orderValue: Number(data.total ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toCreditNotification(template: string, data: any): Record<string, any> {
    return {
      orderId: String(data.creditId ?? data.customer?.id ?? ""),
      orderNumber: String(data.creditId ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: template,
      orderValue: Number(data.amount ?? data.limit ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toPaymentNotification(data: any): Record<string, any> {
    return {
      orderId: String(data.paymentId ?? data.creditId ?? ""),
      orderNumber: String(data.paymentId ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: "payment_received",
      orderValue: Number(data.amount ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toInvoiceSentNotification(data: any): Record<string, any> {
    return {
      orderId: String(data.orderId ?? ""),
      orderNumber: String(data.orderId ?? ""),
      customerName: data.customer?.name || "",
      customerPhone: data.customer?.phone || data.to || "",
      notificationType: "invoice_sent",
      orderValue: Number(data.total ?? 0),
      timestamp: new Date().toISOString(),
    };
  }

  private toMessageSentPayload(data: any): Record<string, any> {
    return {
      customerId: data.to || "",
      templateType: data.template || "generic",
      variables: data.variables || {},
    };
  }
}
