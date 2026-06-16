import { HubClient } from "@olympo/contracts";

/**
 * Singleton HubClient for this service, configured with source="hub".
 *
 * HubCentral is the orchestrator and the receiver of every event in the
 * ecosystem; when it re-emits a canonical event (e.g. after normalizing a Graf
 * webhook into `pedido.pagado`) it does so as `source: "hub"`.
 *
 * The client is fault-tolerant by design (throwOnError defaults to false): a
 * failed publish logs a warning and returns false instead of throwing, so it
 * never breaks local business logic (principle §2: connectors are optional).
 */
export const hubClient = new HubClient({
  source: "hub",
  // Optional overrides via env; falls back to the contract defaults.
  hubUrl: process.env.CAUCE_HUB_URL || undefined,
  secret: process.env.CAUCE_HUB_SECRET || process.env.HUB_CENTRAL_SECRET || undefined,
});

export const HUB_CLIENT = Symbol("CAUCE_HUB_CLIENT");
