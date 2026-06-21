import { Logger } from "@nestjs/common";
import type { HubClient } from "prizma-contracts";
import type { PublishOptions } from "prizma-contracts";
import type { EventType } from "prizma-contracts";

/**
 * HubRetryService — wraps HubClient with resilience: reintentos exponenciales,
 * timeout garantizado y mejor logging.
 *
 * Motivo: el HubClient base (prizma-contracts) usa fetch() sin reintentos ni timeout.
 * Eventos críticos (order.paid → factura/entrega) que fallan por red blip se pierden.
 *
 * Estrategia:
 *  - Reintentos con backoff exponencial (2s, 4s, 8s, …)
 *  - Timeout total ≤ 30s (incluye todos los reintentos)
 *  - Logging detallado de cada intento y fallo
 *  - Non-blocking/fault-tolerant: nunca throws, solo retorna false + warn
 *
 * La respuesta es idéntica a HubClient.publish: boolean.
 */
export class HubRetryService {
  private readonly logger = new Logger(HubRetryService.name);
  private readonly maxRetries = 3;
  private readonly timeoutMs = 30000;
  private readonly initialBackoffMs = 2000;

  constructor(private readonly hubClient: HubClient) {}

  /**
   * Publica un evento con reintentos exponenciales.
   *
   * @param eventType El tipo de evento canónico (ej. "pedido.pagado")
   * @param data Payload del evento
   * @param opts Opciones: priority, idempotencyKey
   * @returns true si el hub aceptó; false si falló (después de reintentos)
   */
  async publishWithRetry(
    eventType: EventType | string,
    data: Record<string, unknown>,
    opts: PublishOptions = {},
  ): Promise<boolean> {
    const idempotencyKey = opts.idempotencyKey || `${Date.now()}-${Math.random()}`;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const elapsedMs = Date.now() - startTime;

      // Defensiva: si ya consumimos el timeout total, rechazar sin reintentar.
      if (elapsedMs >= this.timeoutMs) {
        this.logger.warn(
          `⏱️ [${eventType}/${idempotencyKey}] Timeout global (${elapsedMs}ms) tras ${attempt} intentos; abandonando.`,
        );
        return false;
      }

      try {
        const timeoutRemaining = this.timeoutMs - elapsedMs;
        const attemptNumber = attempt + 1;

        // Intenta publicar.
        this.logger.debug(
          `[${eventType}/${idempotencyKey}] Intento ${attemptNumber}/${this.maxRetries + 1} (timeout=${timeoutRemaining}ms)`,
        );

        const result = await Promise.race([
          this.hubClient.publish(eventType, data, {
            ...opts,
            idempotencyKey,
          }),
          this.delayMs(timeoutRemaining).then(() => {
            throw new Error(`Timeout en intento ${attemptNumber}`);
          }),
        ]);

        if (result) {
          this.logger.log(
            `✅ [${eventType}/${idempotencyKey}] Publicado exitosamente en intento ${attemptNumber}.`,
          );
          return true;
        }

        // El hub rechazó el evento (false retornado por HubClient).
        // Esto puede significar: red, autenticación, o validación.
        // Reintentar solo es seguro para fallos transitorios (red); errores de validación
        // no mejoran con reintentos. Sin embargo, conservamos la estrategia agresiva:
        // si el primer intento falló, probablemente fue un blip de red.
        this.logger.warn(
          `⚠️ [${eventType}/${idempotencyKey}] Intento ${attemptNumber} retornó false (hub rechazó o hub unreachable).`,
        );
      } catch (error: any) {
        this.logger.warn(
          `⚠️ [${eventType}/${idempotencyKey}] Intento ${attempt + 1} lanzó excepción: ${error?.message}`,
        );
      }

      // Si no es el último intento, esperar backoff exponencial antes de reintentar.
      if (attempt < this.maxRetries) {
        const backoffMs = this.initialBackoffMs * Math.pow(2, attempt); // 2s, 4s, 8s, …
        const actualBackoffMs = Math.min(backoffMs, this.timeoutMs - (Date.now() - startTime));

        if (actualBackoffMs > 0) {
          this.logger.debug(
            `⏳ [${eventType}/${idempotencyKey}] Esperando ${actualBackoffMs}ms antes del intento ${attempt + 2}.`,
          );
          await this.delayMs(actualBackoffMs);
        }
      }
    }

    // Agotados los reintentos.
    const totalElapsedMs = Date.now() - startTime;
    this.logger.error(
      `❌ [${eventType}/${idempotencyKey}] Falló tras ${this.maxRetries + 1} intentos (${totalElapsedMs}ms). Evento perdido.`,
    );
    return false;
  }

  /** Delay helper con promise. */
  private delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
