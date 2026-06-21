import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { PluginsService } from "../../plugins/plugins.service";
import { randomUUID } from "crypto";

export interface HermesOrder {
  id: number;
  status: "pending" | "paid" | "shipped" | "delivered" | "canceled";
  paymentMethod?: "cash" | "bank_transfer" | "wompi" | "credit" | "bold" | string;
  creditDays?: number;
  user?: {
    id: number;
    email: string;
    name?: string;
    documentNumber?: string;
  };
  customer?: {
    id?: number;
    name?: string;
    email?: string;
    phone?: string;
    documentNumber?: string;
  };
  store: {
    id: string;
    name: string;
    description?: string;
    owner?: {
      email: string;
      sigoApiKey?: string;
      sigoUsername?: string;
    };
  };
  items: HermesOrderItem[];
  amount: {
    discountTotal: number;
    taxTotal: number;
    delivery: number;
    total: number;
  };
  shippingAddress?: {
    address: string;
    apartment?: string;
    buildingName?: string;
    city: string;
    department: string;
    country: string;
    reference?: string;
  };
  customAnswers: Array<{
    question: string;
    answer: string;
  }>;
  deliveryZone?: {
    id: number;
    zone: string;
    price: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HermesOrderItem {
  id: number;
  product: {
    id: number;
    title: string;
    description?: string;
    code?: string;
    sku?: string;
    basePrice: number | string;
    enabled: boolean;
  };
  quantity: number;
  unitPrice: number | string;
  finalPrice: number | string;
}

// Formato que espera el API de Sigo
export interface SigoInvoiceData {
  date?: string;
  customer: {
    identification: string;
    branch_office?: number;
  };
  customerData?: {
    tipoDocumento: "RUC" | "DNI" | "CE" | "NIT" | "CC";
    numeroDocumento: string;
    razonSocial: string;
    email?: string;
    telefono?: string;
    direccion?: string;
    ciudad?: string;
    departamento?: string;
    activo?: boolean;
  };
  items: Array<{
    code: string;
    description: string;
    quantity: number;
    price: number;
    discount?: number;
    taxes?: Array<{ id: number }>;
  }>;
  payments?: Array<{
    id: number;
    value: number;
    due_date: string;
  }>;
  observations?: string;
}

function extractNotes(order: HermesOrder): string | undefined {
  try {
    const ans = Array.isArray(order.customAnswers) ? order.customAnswers : [];
    const hit = ans.find((a) => {
      const q = (a?.question || "").toLowerCase();
      return q.includes("nota") || q.includes("observ") || q.includes("coment");
    });
    return hit?.answer?.toString()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// Conversión simple Hermes → Sigo (con configuración opcional)
export const convertHermesOrderToSigoInvoice = (
  order: HermesOrder,
  cfg?: any,
  eventType?: string,
): SigoInvoiceData => {
  // Only use documentNumber if available, otherwise use default document
  const documentNumber =
    order.customer?.documentNumber || order.user?.documentNumber;
  const identification = documentNumber || "222222222222";

  // Create customerData if we have document number to ensure customer creation
  const customerData = documentNumber
    ? {
      tipoDocumento: "CC" as const,
      numeroDocumento: documentNumber,
      razonSocial:
        order.customer?.name || order.user?.name || "Cliente Sin Nombre",
      email: order.customer?.email || order.user?.email,
      telefono: order.customer?.phone,
      direccion: order.shippingAddress
        ? `${order.shippingAddress.address}, ${order.shippingAddress.city}, ${order.shippingAddress.department}`
        : undefined,
      ciudad: order.shippingAddress?.city,
      departamento: order.shippingAddress?.department,
    }
    : undefined;

  const today = new Date();
  const date = today.toISOString().split("T")[0];

  // Taxes mapping (default)
  const defaultTaxId: number | undefined =
    cfg?.taxId || cfg?.tax_id || cfg?.taxes?.defaultId || undefined;

  // Notas
  const userNotes = extractNotes(order);

  const base: SigoInvoiceData = {
    date,
    customer: {
      identification: identification,
      branch_office: 0,
    },
    customerData,
    items: order.items.map((item) => ({
      code: item.product.code || item.product.sku || `HERMES-${item.product.id}`,
      description: item.product.title,
      quantity: item.quantity,
      price: parseFloat(item.finalPrice.toString()),
      discount: 0,
      ...(defaultTaxId ? { taxes: [{ id: Number(defaultTaxId) }] } : {}),
    })),
    observations:
      `Factura Hermes - Pedido #${order.id} - Tienda: ${order.store.name}` +
      (userNotes ? `\nNotas: ${userNotes}` : ""),
  };

  // Payments mapping (opcional)
  try {
    const total = Number(order?.amount?.total || 0);
    const pm =
      (cfg && (cfg as any).paymentMapping) ||
      (cfg && (cfg as any).payments) ||
      (cfg && (cfg as any).config && (cfg as any).config.paymentMapping) ||
      (cfg && (cfg as any).config && (cfg as any).config.payments) ||
      {};

    // Tomar método de pago nativo si viene: order.paymentMethod (no tipado en la interfaz pero llega desde Hermes)
    const rawPaymentMethod: string | undefined = (order as any)?.paymentMethod;

    // Selección de key de método por evento
    const eventMap = pm?.eventMap || {};
    const defaultKey: string = pm?.defaultKey || pm?.default || "cash";
    let keyForEvent: string = eventMap?.[eventType || ""] || defaultKey;

    // Si existe un mapping directo por nombre del método de pago, usarlo
    // Ej: pm.types = { cash: { id: 1 }, bank_transfer: { id: 2 } }
    if (rawPaymentMethod) {
      const types = pm?.types || pm;
      if (types?.[rawPaymentMethod]) {
        keyForEvent = rawPaymentMethod;
      } else if (pm?.aliases) {
        // aliases: { efectivo: ['cash','efectivo','contado'] }
        const aliasHit = Object.entries(pm.aliases).find(
          ([/*canonical*/ _c, arr]: any) =>
            Array.isArray(arr) && arr.includes(rawPaymentMethod),
        );
        if (aliasHit) keyForEvent = aliasHit[0];
      }
    }

    // Soportar tanto { efectivo: 1 } como { types: { efectivo: { id: 1, days: 0 } } }
    const types = pm?.types || pm;
    const entry = types?.[keyForEvent];
    const id: number | undefined =
      (typeof entry === "number" ? entry : entry?.id) || undefined;
    // Prioridad de días: si la orden trae creditDays, usarlo; luego entry.days; luego config global
    const daysFromOrder = (order as any)?.creditDays;
    let daysCfg: any = 0;
    if (typeof entry === "object" && entry?.days != null) {
      daysCfg = entry.days;
    } else if ((keyForEvent || "").toLowerCase() === "credit") {
      daysCfg = pm?.creditDays || pm?.diasCredito || 0;
    } else {
      daysCfg = 0;
    }
    const days: number = Number((daysFromOrder ?? daysCfg ?? 0) || 0);

    if (id && total > 0) {
      base.payments = [
        {
          id: Number(id),
          value: total,
          due_date: days > 0 ? addDays(today, days) : date,
        },
      ];
    }
  } catch { }

  return base;
};

function genCorrelationId(): string {
  try {
    return randomUUID();
  } catch {
    // UUID v4 fallback
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

@Injectable()
export class LogosConnectorService {
  private readonly logger = new Logger(LogosConnectorService.name);
  private readonly logosUrl: string;

  constructor(
    private httpService: HttpService,
    private pluginsService: PluginsService,
  ) {
    this.logosUrl = process.env.LOGOS_API_URL || "";
    if (!this.logosUrl) {
      // No es fatal: el envío será opcional y se marcará como 'skipped'
      this.logger.warn(
        "⚠️ LOGOS_API_URL no está definida. El envío a Logos será omitido (skipped)",
      );
    }
  }

  async enviarFactura(
    order: HermesOrder,
    userEmail: string,
    storeId: string,
    eventType?: string,
    cfg?: any,
  ): Promise<any> {
    const correlationId = genCorrelationId();
    try {
      this.logger.log("Enviando factura a Logos", {
        orderId: order?.id,
        storeId,
        correlationId,
        items: Array.isArray(order?.items) ? order.items.length : 0,
        hasDoc: !!(
          order?.customer?.documentNumber || order?.user?.documentNumber
        ),
        eventType,
      });

      if (!this.logosUrl) {
        this.logger.warn("URL de Logos no configurada, omitiendo envío (skipped)");
        return {
          attempted: false,
          skipped: true,
          reason: "missing_service_url",
          correlationId,
        };
      }

      // Buscar usuario por el storeId (el owner de la tienda)
      let user = await this.pluginsService.findUserByEmail(userEmail);

      // Si no encuentra por userEmail, buscar por el owner de la tienda
      if (!user && order.store.owner?.email) {
        user = await this.pluginsService.findUserByEmail(
          order.store.owner.email,
        );
      }

      if (!user) {
        this.logger.warn(
          `Usuario no encontrado (email: ${userEmail} / owner: ${order.store.owner?.email}), omitiendo envío`,
        );
        return {
          attempted: false,
          skipped: true,
          reason: "user_not_found",
          correlationId,
        };
      }

      // Buscar credenciales del plugin en el Hub
      const userCredentials = await this.pluginsService.getUserCredentials(
        user.id,
      );

      const allCreds = userCredentials.credentials["logos"] || {};
      let sigoCredentials: any = allCreds;
      let selectedSubKey: string | undefined;

      if (!allCreds?.apiKey || !allCreds?.username) {
        const candidateKeys = [
          `hermes-store-${storeId}`,
          storeId,
          order.store?.name,
          "default",
        ].filter(Boolean) as string[];

        for (const key of candidateKeys) {
          const sub = (allCreds as any)[key];
          if (sub?.apiKey && sub?.username) {
            sigoCredentials = sub;
            selectedSubKey = key;
            break;
          }
        }
      }

      if (!sigoCredentials?.apiKey || !sigoCredentials?.username) {
        this.logger.warn(
          `Credenciales no encontradas para tienda ${storeId}, omitiendo envío`,
        );
        return {
          attempted: false,
          skipped: true,
          reason: "missing_credentials",
          correlationId,
        };
      }

      // Construir una configuración efectiva que incluya el mapeo de pagos desde la subconfig de la tienda y/o nivel superior
      const pickPayments = (o: any) =>
        (o && ((o as any).paymentMapping || (o as any).payments ||
          ((o as any).config && ((o as any).config.paymentMapping || (o as any).config.payments)))) || undefined;

      const storeKey = `hermes-store-${storeId}`;
      const candidates: Array<{ key: string; obj: any }> = [
        { key: "cfg-arg", obj: cfg },
        selectedSubKey ? { key: `sub:${selectedSubKey}`, obj: (allCreds as any)[selectedSubKey!] } : { key: "sub:<none>", obj: undefined },
        { key: `sub:${storeKey}`, obj: (allCreds as any)[storeKey] },
        { key: `sub:${storeId}`, obj: (allCreds as any)[storeId] },
        { key: "allCreds.config", obj: (allCreds as any)?.config },
        { key: "allCreds", obj: allCreds },
      ];

      let paymentsCfg: any | undefined;
      let paymentsSourceKey: string | undefined;
      for (const c of candidates) {
        const pm = pickPayments(c.obj);
        if (pm) {
          paymentsCfg = pm;
          paymentsSourceKey = c.key;
          break;
        }
      }

      const effectiveCfg: any = { ...(cfg || {}) };
      if (paymentsCfg) {
        effectiveCfg.config = { ...(effectiveCfg.config || {}), payments: paymentsCfg };
        if (!effectiveCfg.payments && !effectiveCfg.paymentMapping) {
          effectiveCfg.payments = paymentsCfg;
        }
      }

      const sigoInvoiceData = convertHermesOrderToSigoInvoice(
        order,
        effectiveCfg,
        eventType,
      );

      // LOG: Debug del payload que se envía a Logos
      this.logger.debug(`[Logos] Payload completo para orden ${order.id}:`, JSON.stringify(sigoInvoiceData, null, 2));

      const signatureHeader = process.env.LOGOS_HUB_WEBHOOK_SECRET;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-email": String(sigoCredentials.username),
        "x-api-key": String(sigoCredentials.apiKey),
      };
      if (signatureHeader) headers["x-hub-signature"] = signatureHeader;

      // Enviar a API de Sigo
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.logosUrl}/api/invoices`,
          sigoInvoiceData,
          {
            headers,
            timeout: 15000,
          },
        ),
      );

      this.logger.log("Respuesta de Logos", {
        orderId: order.id,
        correlationId,
        status: (response as any)?.status,
        success: (response as any)?.data?.success,
      });

      return {
        attempted: true,
        skipped: false,
        correlationId,
        data: response.data,
      };
    } catch (error: any) {
      this.logger.error(
        `Error enviando factura pedido ${order?.id}`,
        (error && (error as any).message) || String(error),
      );
      this.logger.error("Error detalle Logos", {
        correlationId,
        status: error?.response?.status,
        data: error?.response?.data?.error || error?.response?.data,
      });
      throw error;
    }
  }
}
