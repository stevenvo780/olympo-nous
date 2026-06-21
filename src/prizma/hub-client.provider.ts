import { HubClient } from "prizma-contracts";
import { HubRetryService } from "./hub-retry.service";

/**
 * Singleton HubClient for this service, configured with source="nous".
 *
 * Nous is the orchestrator and the receiver of every event in the
 * ecosystem; when it re-emits a canonical event (e.g. after normalizing a Hermes
 * webhook into `pedido.pagado`) it does so as `source: "nous"`.
 *
 * The client is fault-tolerant by design (throwOnError defaults to false): a
 * failed publish logs a warning and returns false instead of throwing, so it
 * never breaks local business logic (principle §2: connectors are optional).
 */
export const hubClient = new HubClient({
  source: "nous",
  // Optional overrides via env — use canonical NOUS_* names.
  hubUrl: process.env.NOUS_HUB_URL || undefined,
  secret: process.env.NOUS_HUB_SECRET || undefined,
});

/**
 * Singleton HubRetryService wrapping the HubClient with exponential backoff
 * reintentos, timeout guarantee, and better logging.
 *
 * Use this for critical events that should not be silently lost on network blips.
 */
export const hubRetryService = new HubRetryService(hubClient);

export const HUB_CLIENT = Symbol("NOUS_HUB_CLIENT");
export const HUB_RETRY_SERVICE = Symbol("NOUS_HUB_RETRY_SERVICE");
