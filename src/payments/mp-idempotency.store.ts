import { Injectable } from "@nestjs/common";
import type { IdempotencyStore } from "prizma-payments";
import { QueueService } from "../queue/queue.service";

/**
 * Redis-backed {@link IdempotencyStore} for Mercado Pago webhook processing.
 *
 * prizma-payments' `wasAlreadyProcessed(mpId, store)` checks `has(mpId)` BEFORE
 * acting and `add(mpId)` on first sight, so the same `mpId` (payment /
 * preapproval id) is never processed twice — even across MP re-deliveries or
 * multiple Hub instances, because the store lives in the shared Redis the Hub
 * already uses (same instance as the event queue / dedupe keys).
 *
 * We reuse {@link QueueService}'s `markAsProcessed` / `isEventProcessed`
 * (key `hub:processed:<id>`, 24h TTL) so payment idempotency shares the exact
 * same mechanism as the canonical-event idempotency — no second store invented.
 */
@Injectable()
export class MpIdempotencyStore implements IdempotencyStore {
  /** Namespace so a payment id never collides with a canonical idempotencyKey. */
  private readonly prefix = "mp:webhook:";

  constructor(private readonly queueService: QueueService) {}

  has(mpId: string): Promise<boolean> {
    return this.queueService.isEventProcessed(`${this.prefix}${mpId}`);
  }

  add(mpId: string): Promise<void> {
    return this.queueService.markAsProcessed(`${this.prefix}${mpId}`);
  }
}
