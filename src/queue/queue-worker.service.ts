import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { EventEnvelope } from "prizma-contracts";
import { QueueService } from "./queue.service";
import { ConnectorOrchestratorService } from "../connectors/connector-orchestrator.service";
import { EventRouterService } from "../connectors/event-router.service";
import { HermesOrder } from "../connectors/logos/logos-connector.service";
import { PrizmaService } from "../prizma/prizma.service";
import { PaymentProcessorService } from "../payments/payment-processor.service";

@Injectable()
export class QueueWorkerService implements OnModuleInit {
  private readonly logger = new Logger(QueueWorkerService.name);
  private isProcessing = false;

  constructor(
    private queueService: QueueService,
    private orchestrator: ConnectorOrchestratorService,
    private eventRouter: EventRouterService,
    private prizma: PrizmaService,
    private paymentProcessor: PaymentProcessorService,
  ) {}

  async onModuleInit() {
    this.startProcessing();
  }

  /**
   * Inicia el procesamiento continuo de eventos de la cola
   */
  private async startProcessing() {
    // Wait for Redis to finish its initial handshake before issuing BRPOP, so
    // the worker doesn't error out on startup while the connection is opening.
    const ready = await this.queueService.waitUntilReady();
    if (!ready) {
      this.logger.warn(
        "⚠️ Redis no estuvo listo en el timeout inicial; el worker arranca igual y reintentará por tick.",
      );
    }
    this.logger.log("🚀 Worker iniciado, procesando eventos de cola");

    while (true) {
      try {
        if (!this.isProcessing) {
          this.isProcessing = true;

          // Drain priority lanes first (critical→high→normal→low→legacy).
          const events = await this.queueService.getNextByPriority(5);

          for (const event of events) {
            await this.dispatch(event);
          }

          this.isProcessing = false;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.error("Error en worker:", error);
        this.isProcessing = false;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Decides whether a dequeued item is:
   * 1. A canonical prizma-contracts envelope
   *    (route via EventRouterService → destination connectors)
   * 2. A Mercado Pago webhook
   *    (route via PaymentProcessorService for async fan-out)
   * 3. A legacy Hermes webhook payload
   *    (route via the existing Logos orchestrator).
   */
  private async dispatch(event: any) {
    const envelope: EventEnvelope | undefined = event?.data?.envelope;
    // Distributed lock around the fan-out so that, with >1 replica, the SAME
    // logical event is not routed concurrently (BRPOP already prevents popping
    // the same item twice, but a re-enqueued item could be raced). The lock key
    // is the stable idempotency identity; if not acquired, another replica owns
    // it — skip without acking so the owner finishes.
    const lockKey = this.lockKeyFor(event, envelope);
    if (lockKey) {
      const acquired = await this.queueService.tryAcquireLock(lockKey, 60);
      if (!acquired) {
        this.logger.debug(
          `🔒 Evento ${lockKey} ya en proceso por otra réplica; se omite.`,
        );
        return;
      }
    }

    try {
      if (envelope && envelope.eventType) {
        await this.processCanonicalEvent(event, envelope);
      } else if (event.type === "mp.webhook") {
        await this.processMercadoPagoWebhook(event);
      } else {
        await this.processEvent(event);
      }
    } finally {
      if (lockKey) await this.queueService.releaseLock(lockKey);
    }
  }

  /** Stable lock identity per event (idempotencyKey / mpId / legacy event id). */
  private lockKeyFor(event: any, envelope?: EventEnvelope): string | null {
    if (envelope?.eventType) {
      return `evt:${event?.data?.idempotencyKey || envelope.idempotencyKey || envelope.eventId}`;
    }
    if (event?.type === "mp.webhook") {
      const mpId =
        event?.data?.mpWebhook?.data?.id ??
        event?.data?.mpWebhook?._query?.["data.id"] ??
        event?.id;
      return `mp:${mpId}`;
    }
    return event?.id ? `legacy:${event.id}` : null;
  }

  /**
   * Canonical fan-out: route the envelope to every destination connector per
   * ARCHITECTURE.md §4. Fault-tolerant — EventRouterService never throws and
   * each connector swallows transport errors, so a dead destination does not
   * fail the whole event.
   *
   * Reintentos: máx. 3 reintentoscon backoff implícito (100ms × 10 worker ticks).
   * Deadletter: si retryCount >= 3, log como ERROR y descartar (avoid infinite loops).
   */
  private async processCanonicalEvent(event: any, envelope: EventEnvelope) {
    try {
      this.logger.log(
        `🎯 Routing canonical event ${envelope.eventType} (id=${envelope.eventId}, prio=${event.priority}, retry=${event.retryCount || 0}/3)`,
      );
      const results = await this.eventRouter.route(envelope);
      await this.queueService.markAsProcessed(event.id);
      const failed = results.filter((r) => !r.ok && !r.skipped).length;
      if (failed > 0) {
        this.logger.warn(
          `⚠️ ${envelope.eventType}: ${failed} destino(s) fallaron (no se reintenta el evento completo; cada destino es idempotente).`,
        );
      }
    } catch (error) {
      // Defensive: route() is already non-throwing, but guard the loop anyway.
      const retryCount = (event.retryCount || 0);
      const maxRetries = 3;

      this.logger.error(
        `❌ Error ruteando evento canónico ${envelope.eventType} (id=${envelope.eventId}, intento ${retryCount + 1}/${maxRetries + 1}):`,
        error,
      );

      if (retryCount < maxRetries) {
        await this.queueService.requeuePriorityEvent(event);
        this.logger.warn(
          `🔄 Evento canónico ${envelope.eventType} reencolado (intento ${retryCount + 2}/${maxRetries + 1})`,
        );
      } else {
        // Deadletter: evento irrecuperable tras máx. reintentos.
        await this.queueService.markAsProcessed(event.id);
        this.logger.error(
          `💀 [DEADLETTER] Evento canónico ${envelope.eventType} (id=${envelope.eventId}) descartado tras ${maxRetries + 1} intentos. Data: ${JSON.stringify(envelope.data).substring(0, 200)}`,
        );
      }
    }
  }

  /**
   * Process a Mercado Pago webhook: verify (already done in controller),
   * dedupe by MP resource id, fetch real state from MP, map to contract event,
   * route to product. Fault-tolerant: never throws into the worker loop.
   *
   * Reintentos: máx. 3, solo para fallos transitorios (retryable=true).
   * Deadletter: si error persiste tras 3 reintentos, descartar con log.
   */
  private async processMercadoPagoWebhook(event: any) {
    const retryCount = event.retryCount || 0;
    const maxRetries = 3;

    try {
      const mpPayload = event.data?.mpWebhook;
      if (!mpPayload) {
        this.logger.warn(`💳 Webhook MP sin payload; ignorado (event=${event.id})`);
        await this.queueService.markAsProcessed(event.id);
        return;
      }

      const resourceId = mpPayload?.data?.id ?? mpPayload?._query?.["data.id"] ?? "unknown";
      this.logger.log(
        `💳 Procesando webhook MP (type=${mpPayload?.type}, resource=${resourceId}, intento ${retryCount + 1}/${maxRetries + 1})`,
      );

      const result = await this.paymentProcessor.process(mpPayload);

      if (result.handled) {
        await this.queueService.markAsProcessed(event.id);
        this.logger.log(`✅ Webhook MP procesado exitosamente (resource=${resourceId})`);
      } else if (result.retryable) {
        // Transient failure (e.g. destination product unreachable). The
        // processor did NOT mark the mpId as processed, so re-enqueue to retry.
        // Do NOT markAsProcessed(event.id) here, so the same item can run again.
        if (retryCount < maxRetries) {
          await this.queueService.requeuePriorityEvent(event);
          this.logger.warn(
            `🔄 Webhook MP reencolado por fallo transitorio (${result.reason}, intento ${retryCount + 2}/${maxRetries + 1}, resource=${resourceId})`,
          );
        } else {
          // Deadletter: transient error persisted after max retries; give up.
          await this.queueService.markAsProcessed(event.id);
          this.logger.error(
            `💀 [DEADLETTER] Webhook MP (resource=${resourceId}) descartado tras ${maxRetries + 1} intentos transitorios. Reason: ${result.reason}`,
          );
        }
      } else {
        // Terminal non-handled outcome (duplicate / pending / bad ref / etc.):
        // nothing to retry.
        await this.queueService.markAsProcessed(event.id);
        this.logger.warn(
          `⚠️ Webhook MP (resource=${resourceId}) no procesado (terminal): ${result.reason}`,
        );
      }
    } catch (error) {
      this.logger.error(`❌ Error procesando webhook MP (intento ${retryCount + 1}/${maxRetries + 1}):`, error);

      if (retryCount < maxRetries) {
        await this.queueService.requeuePriorityEvent(event);
        this.logger.warn(
          `🔄 Webhook MP reencolado por excepción (intento ${retryCount + 2}/${maxRetries + 1})`,
        );
      } else {
        // Deadletter: exception persisted after max retries.
        await this.queueService.markAsProcessed(event.id);
        this.logger.error(
          `💀 [DEADLETTER] Webhook MP descartado tras ${maxRetries + 1} intentos por excepción: ${(error as Error)?.message}`,
        );
      }
    }
  }

  /**
   * Procesa un evento individual - Interfaz legacy Hermes.
   *
   * Reintentos: máx. 3, con backoff implícito de 100ms × ticks.
   * Deadletter: si error persiste tras 3 reintentos, descartar.
   */
  private async processEvent(event: any) {
    const retryCount = event.retryCount || 0;
    const maxRetries = 3;

    try {
      const hermesWebhookPayload = event.data;
      const order: HermesOrder = hermesWebhookPayload?.data as HermesOrder;
      const eventType = event.type;
      const userEmail =
        hermesWebhookPayload?.userCredentials?.userEmail ||
        "admin@hermes-system.com";

      this.logger.log(
        `🎯 Procesando evento: ${event.type} desde ${event.source} (intento ${retryCount + 1}/${maxRetries + 1})`,
      );

      // Guard against malformed Hermes payloads: a missing order/store would
      // throw a TypeError below (and each retry would crash before reaching the
      // orchestrator). Skip + ack instead of looping on an unprocessable item.
      const storeId = order?.store?.id;
      if (!order || storeId === undefined || storeId === null) {
        this.logger.warn(
          `⚠️ Evento ${eventType} (${event.id}) sin order/store válido; se omite (no reintentable).`,
        );
        await this.queueService.markAsProcessed(event.id);
        return;
      }

      this.logger.debug(
        `[QueueWorker] Procesando orden ${order.id} de tienda ${storeId} para usuario ${userEmail}`,
      );

      await this.orchestrator.processEvent(
        order,
        eventType,
        userEmail,
        storeId,
      );

      await this.queueService.markAsProcessed(event.id);
      this.logger.log(`✅ Evento ${event.type} procesado exitosamente`);

      // --- Prizma: re-emit the canonical event so the rest of the ecosystem
      // (Mnemosyne CRM, Logos invoicing, Talaria delivery, IRIS WhatsApp —
      // Flow 1/2/5) can react. Nous owns this re-emission (source="hub").
      // Non-blocking & fault-tolerant: HubRetryService with backoff ensures
      // critical events get delivery attempts (never silently lost).
      void this.publishCanonical(eventType, order, event.id);
    } catch (error) {
      this.logger.error(
        `❌ Error procesando evento ${event.type} (intento ${retryCount + 1}/${maxRetries + 1}):`,
        error,
      );

      if (retryCount < maxRetries) {
        await this.queueService.requeueEvent(event);
        this.logger.warn(
          `🔄 Evento ${event.type} reencolado (intento ${retryCount + 2}/${maxRetries + 1})`,
        );
      } else {
        // Deadletter: error persisted after max retries.
        await this.queueService.markAsProcessed(event.id);
        this.logger.error(
          `💀 [DEADLETTER] Evento ${event.type} (id=${event.id}) descartado tras ${maxRetries + 1} intentos. Error: ${(error as Error)?.message}`,
        );
      }
    }
  }

  /**
   * Maps the hub-normalized order event to its canonical prizma-contracts event
   * and re-publishes it with reintentos (HubRetryService).
   *
   * Non-blocking: never throws into the worker loop, but logging indicates if
   * the event was eventually delivered to the hub (via HubRetryService with backoff).
   */
  private async publishCanonical(
    eventType: string,
    order: HermesOrder,
    sourceEventId: string,
  ): Promise<void> {
    try {
      const customer = {
        id: order.customer?.id?.toString() ?? order.user?.id?.toString(),
        name: order.customer?.name ?? order.user?.name,
        phone: order.customer?.phone,
        email: order.customer?.email ?? order.user?.email,
      };
      const items = (order.items || []).map((it: any) => ({
        sku: String(it?.product?.code ?? it?.product?.id ?? it?.id ?? ""),
        name: it?.product?.title,
        qty: Number(it?.quantity ?? it?.qty ?? 1),
        unitPrice: Number(it?.unitPrice ?? it?.price ?? 0),
      }));
      const total = Number(order.amount?.total ?? 0);
      const orderId = String(order.id);
      const store = order.store?.id;
      const idempotencyKey = `hub:${sourceEventId}`;

      let published = false;

      switch (eventType) {
        case "order.paid":
          published = await this.prizma.publishOrderPaid(
            { orderId, customer, items, total, store },
            { idempotencyKey, priority: "high" },
          );
          break;
        case "order.pending":
          published = await this.prizma.publishOrderPendingApproval(
            { orderId, customer, total, store },
            { idempotencyKey },
          );
          break;
        // Other normalized order states (shipped/delivered/canceled/updated)
        // are not part of a canonical Prizma event yet — intentionally skipped.
        default:
          this.logger.debug(
            `[Prizam] No canonical event mapped for "${eventType}" (order ${orderId}); skip.`,
          );
          return;
      }

      if (!published) {
        this.logger.warn(
          `[Prizam] publishCanonical: "${eventType}" (order=${orderId}, idem=${idempotencyKey}) falló tras reintentos — evento NO entregado al hub.`,
        );
      }
    } catch (err: any) {
      // Defensive only: PrizmaService is already non-throwing, but the payload
      // mapping above must never break the worker.
      this.logger.warn(
        `[Prizam] publishCanonical failed (payload mapping): ${err?.message}`,
      );
    }
  }
}
