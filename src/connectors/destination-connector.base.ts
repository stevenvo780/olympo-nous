import { Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { signPayload, type ServiceSource } from "prizma-contracts";

export interface ConnectorResult {
  service: ServiceSource;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  data?: any;
}

/**
 * Base class for every destination connector (one per target service).
 *
 * Encapsulates the cross-cutting concerns required by ARCHITECTURE.md §2:
 *  - Fault tolerance: a failed/unreachable destination NEVER throws. Every call
 *    resolves to a {@link ConnectorResult} so the router can fan-out to the
 *    remaining destinations regardless of any single failure.
 *  - Idempotency: the canonical `idempotencyKey` is forwarded as the
 *    `x-idempotency-key` header so destinations can dedupe (and we also dedupe
 *    centrally in the router via Redis).
  *  - Signing: when a Nous/Hub secret is set, every outbound body is HMAC-signed
 *    with `x-prizma-signature`, matching the inbound verification on the hub.
 */
export abstract class DestinationConnectorBase {
  protected abstract readonly service: ServiceSource;
  protected readonly logger: Logger;
  private readonly secret?: string;

  constructor(
    protected readonly http: HttpService,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
    this.secret =
      process.env.PRIZMA_NOUS_SECRET ||
      process.env.PRIZMA_HUB_SECRET ||
      process.env.HUB_CENTRAL_SECRET ||
      process.env.NOUS_SECRET ||
      process.env.NOUS_HUB_SECRET ||
      process.env.CAUCE_HUB_SECRET ||
      undefined;
  }

  /** Resolve the destination base URL from env or the prizma-contracts default. */
  protected abstract baseUrl(): string;

  /**
   * Fault-tolerant PATCH to a destination service path.
   * Returns a {@link ConnectorResult}; it resolves (never rejects) on any error.
   */
  protected async patch(
    path: string,
    body: unknown,
    idempotencyKey?: string,
    headers: Record<string, string> = {},
  ): Promise<ConnectorResult> {
    const base = this.baseUrl();
    if (!base) {
      this.logger.warn(
        `[${this.service}] base URL no resuelta; omitiendo PATCH ${path} (skipped)`,
      );
      return { service: this.service, ok: false, skipped: true, reason: "missing_service_url" };
    }

    const url = `${base.replace(/\/$/, "")}${path}`;
    const finalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      ...(this.secret ? { "x-prizma-signature": signPayload(body, this.secret) } : {}),
      ...headers,
    };

    try {
      const res = await firstValueFrom(
        this.http.patch(url, body, { headers: finalHeaders, timeout: 15000 }),
      );
      this.logger.log(
        `[${this.service}] PATCH ${path} ok (status=${(res as any)?.status})`,
      );
      return {
        service: this.service,
        ok: true,
        status: (res as any)?.status,
        data: (res as any)?.data,
      };
    } catch (err: any) {
      this.logger.warn(
        `[${this.service}] PATCH ${path} falló (no-fatal): ${err?.response?.status || ""} ${err?.message}`,
      );
      return {
        service: this.service,
        ok: false,
        status: err?.response?.status,
        reason: err?.message,
        data: err?.response?.data,
      };
    }
  }

  /**
   * Fault-tolerant POST to a destination service path.
   * Returns a {@link ConnectorResult}; it resolves (never rejects) on any error.
   */
  protected async post(
    path: string,
    body: unknown,
    idempotencyKey?: string,
    headers: Record<string, string> = {},
  ): Promise<ConnectorResult> {
    const base = this.baseUrl();
    if (!base) {
      this.logger.warn(
        `[${this.service}] base URL no resuelta; omitiendo POST ${path} (skipped)`,
      );
      return { service: this.service, ok: false, skipped: true, reason: "missing_service_url" };
    }

    const url = `${base.replace(/\/$/, "")}${path}`;
    const finalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      ...(this.secret ? { "x-prizma-signature": signPayload(body, this.secret) } : {}),
      ...headers,
    };

    try {
      const res = await firstValueFrom(
        this.http.post(url, body, { headers: finalHeaders, timeout: 15000 }),
      );
      this.logger.log(
        `[${this.service}] POST ${path} ok (status=${(res as any)?.status})`,
      );
      return {
        service: this.service,
        ok: true,
        status: (res as any)?.status,
        data: (res as any)?.data,
      };
    } catch (err: any) {
      // Fault tolerant: log & return, never throw — a dead destination must not
      // break the fan-out to the rest (ARCHITECTURE.md §2.2).
      this.logger.warn(
        `[${this.service}] POST ${path} falló (no-fatal): ${err?.response?.status || ""} ${err?.message}`,
      );
      return {
        service: this.service,
        ok: false,
        status: err?.response?.status,
        reason: err?.message,
        data: err?.response?.data,
      };
    }
  }
}
