import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import Redis from "ioredis";
type Priority = "critical" | "high" | "normal" | "low";

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private redis: Redis;
  private isReady = false;
  private readonly queueName = "hub:events";

  /**
   * Priority queues (highest → lowest). Workers drain them in this order, so a
   * `critical` event is always processed before a `normal`/`low` one. The legacy
   * single queue (`hub:events`) is kept as the lowest-priority lane so the
   * existing Graf webhook path keeps working unchanged.
   */
  private readonly priorityQueues: Record<Priority, string> = {
    critical: "hub:events:critical",
    high: "hub:events:high",
    normal: "hub:events:normal",
    low: "hub:events:low",
  };

  constructor() {}

  async onModuleInit() {
    const redisConfig = {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || "6379"),
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
    };

    this.redis = new Redis(redisConfig);

    this.redis.on("connect", () => {
      this.logger.log("Conectado a Redis para colas");
    });

    // `ready` fires once the connection is usable (auth done, SELECT done).
    this.redis.on("ready", () => {
      this.isReady = true;
      this.logger.log("Redis listo para colas");
    });

    this.redis.on("end", () => {
      this.isReady = false;
    });

    this.redis.on("error", (err) => {
      this.isReady = false;
      this.logger.error("Error de Redis:", err);
    });
  }

  /** True once Redis has completed its initial handshake and is usable. */
  isRedisReady(): boolean {
    return this.isReady;
  }

  /** Wait until Redis is ready (used by the worker before it starts BRPOP). */
  async waitUntilReady(timeoutMs = 30000): Promise<boolean> {
    const start = Date.now();
    while (!this.isReady && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.isReady;
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  /**
   * Agrega un evento a la cola de Redis
   */
  async addToQueue(eventData: {
    id: string;
    type: string;
    source: string;
    data: any;
  }): Promise<void> {
    const payload = {
      ...eventData,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    await this.redis.lpush(this.queueName, JSON.stringify(payload));
    this.logger.debug(`Evento agregado a cola: ${eventData.type}`);
  }

  /**
   * Obtiene el próximo evento de la cola Redis
   */
  async getNextEvent(): Promise<any | null> {
    const eventData = await this.redis.rpop(this.queueName);
    if (eventData) {
      try {
        const event = JSON.parse(eventData);
        this.logger.debug(`Evento obtenido de cola: ${event.type}`);
        return event;
      } catch (error) {
        this.logger.error("Error parseando evento de cola:", error);
      }
    }
    return null;
  }

  /**
   * Obtiene eventos con bloqueo
   */
  async getEventsBlocking(timeout: number = 10): Promise<any[]> {
    try {
      const result = await this.redis.brpop(this.queueName, timeout);
      if (result) {
        const [, eventData] = result;
        return [JSON.parse(eventData)];
      }
    } catch (error) {
      this.logger.error("Error en getEventsBlocking:", error);
    }
    return [];
  }

  /**
   * Encola un evento canónico priorizado (orquestación prizma-contracts).
   * `critical`/`high`/`normal`/`low` se atienden en ese orden por el worker.
   */
  async addToPriorityQueue(
    eventData: { id: string; type: string; source: string; data: any },
    priority: Priority = "normal",
  ): Promise<void> {
    const queue = this.priorityQueues[priority] || this.priorityQueues.normal;
    const payload = {
      ...eventData,
      priority,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };
    await this.redis.lpush(queue, JSON.stringify(payload));
    this.logger.debug(`Evento priorizado [${priority}] encolado: ${eventData.type}`);
  }

  /**
   * Obtiene el próximo evento respetando prioridad: critical → high → normal →
   * low → legacy(hub:events). Bloquea hasta `timeout` segundos.
   */
  async getNextByPriority(timeout: number = 5): Promise<any[]> {
    // Don't issue a blocking BRPOP while Redis is still (re)connecting: it would
    // either throw or queue up. Skip this tick and let the worker retry.
    if (!this.isReady) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    }
    try {
      // BRPOP atiende las claves en orden: la primera con datos gana.
      // ioredis' multi-key overload is `brpop(...keys, timeout)`; spreading the
      // lanes keeps it correctly typed (no `as` cast that could mask a signature
      // change). The numeric timeout is the final argument.
      const lanes: string[] = [
        this.priorityQueues.critical,
        this.priorityQueues.high,
        this.priorityQueues.normal,
        this.priorityQueues.low,
        this.queueName, // legacy lane (Graf webhook path)
      ];
      const result = await this.redis.brpop(...lanes, timeout);
      if (result) {
        const [, eventData] = result;
        return [JSON.parse(eventData)];
      }
    } catch (error) {
      this.logger.error("Error en getNextByPriority:", error);
    }
    return [];
  }

  /** Reencola un evento priorizado en su misma lane (reintentos). */
  async requeuePriorityEvent(eventData: any): Promise<void> {
    const priority: Priority = eventData?.priority || "normal";
    const queue = this.priorityQueues[priority] || this.priorityQueues.normal;
    const payload = {
      ...eventData,
      retryCount: (eventData.retryCount || 0) + 1,
      timestamp: new Date().toISOString(),
    };
    await this.redis.lpush(queue, JSON.stringify(payload));
    this.logger.debug(`Evento priorizado ${eventData.id} reencolado [${priority}]`);
  }

  /**
   * Obtiene estadísticas de la cola
   */
  async getQueueStats(): Promise<{ name: string; length: number }> {
    const length = await this.redis.llen(this.queueName);
    return {
      name: this.queueName,
      length,
    };
  }

  /**
   * Limpia la cola
   */
  async clearQueue(): Promise<void> {
    await this.redis.del(this.queueName);
    this.logger.log("Cola limpiada");
  }

  /**
   * Reencola un evento (para reintentos)
   */
  async requeueEvent(eventData: any): Promise<void> {
    const payload = {
      ...eventData,
      retryCount: (eventData.retryCount || 0) + 1,
      timestamp: new Date().toISOString(),
    };

    await this.redis.lpush(this.queueName, JSON.stringify(payload));
    this.logger.debug(`Evento ${eventData.id} reencolado`);
  }

  /**
   * Best-effort distributed lock (SET key value NX EX ttl). Returns true if the
   * caller acquired it. Used by the worker so that, across multiple replicas,
   * the SAME event is not fanned-out concurrently (defense-in-depth on top of
   * the central idempotency + per-destination x-idempotency-key).
   */
  async tryAcquireLock(key: string, ttlSeconds = 60): Promise<boolean> {
    if (!this.isReady) return false;
    try {
      const res = await this.redis.set(
        `hub:lock:${key}`,
        "1",
        "EX",
        ttlSeconds,
        "NX",
      );
      return res === "OK";
    } catch (error) {
      this.logger.error("Error adquiriendo lock:", error);
      // On lock-store failure, allow processing (the idempotency layer still
      // protects correctness); better to process than to silently drop.
      return true;
    }
  }

  /** Release a lock acquired with {@link tryAcquireLock}. */
  async releaseLock(key: string): Promise<void> {
    try {
      await this.redis.del(`hub:lock:${key}`);
    } catch (error) {
      this.logger.error("Error liberando lock:", error);
    }
  }

  /**
   * Marca un evento como procesado
   */
  async markAsProcessed(eventId: string): Promise<void> {
    const processedKey = `hub:processed:${eventId}`;
    await this.redis.set(processedKey, "1", "EX", 86400);

    this.logger.debug(`Evento ${eventId} marcado como procesado`);
  }

  /**
   * Verifica si un evento ya fue procesado
   */
  async isEventProcessed(eventId: string): Promise<boolean> {
    const processedKey = `hub:processed:${eventId}`;
    const exists = await this.redis.exists(processedKey);
    return exists === 1;
  }
}
