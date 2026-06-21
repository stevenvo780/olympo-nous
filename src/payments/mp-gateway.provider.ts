import { Logger } from "@nestjs/common";
import { MercadoPagoGateway, type PaymentGateway } from "prizma-payments";

/**
 * DI token for the Mercado Pago payment gateway.
 *
 * We inject the gateway behind the `PaymentGateway` interface (not the concrete
 * class) so tests can swap in a mock and a future provider migration stays a
 * one-line change here.
 */
export const MP_GATEWAY = "MP_GATEWAY" as const;

const logger = new Logger("MercadoPagoGateway");

/**
 * Factory provider for the central Mercado Pago account (Colombia / COP).
 *
 * Secrets are read from env with a safe placeholder (`?? ""`) so the process
 * boots even when MP is not configured yet (e.g. local/dev). The webhook
 * verification path treats a missing/empty secret as an invalid signature, so
 * an unconfigured Hub never silently accepts unverified webhooks.
 *
 *   MP_ACCESS_TOKEN   → query payment / preapproval state from MP.
 *   MP_WEBHOOK_SECRET → verify the `x-signature` HMAC of inbound webhooks.
 *
 * NEVER hardcode these. See `.env.example`.
 */
export const mpGatewayProvider = {
  provide: MP_GATEWAY,
  useFactory: (): PaymentGateway => {
    const accessToken = process.env.MP_ACCESS_TOKEN ?? "";
    const webhookSecret = process.env.MP_WEBHOOK_SECRET ?? "";

    if (!accessToken) {
      logger.warn(
        "MP_ACCESS_TOKEN no configurado: no se podrá consultar el estado real de pagos/suscripciones en Mercado Pago.",
      );
    }
    if (!webhookSecret) {
      logger.warn(
        "MP_WEBHOOK_SECRET no configurado: la verificación de firma rechazará todos los webhooks (fail-closed).",
      );
    }

    return new MercadoPagoGateway({
      accessToken,
      webhookSecret,
      sandbox: process.env.MP_SANDBOX_MODE === "true",
    });
  },
};
