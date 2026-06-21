import { Global, Module } from "@nestjs/common";
import { PrizmaService } from "./prizma.service";

/**
 * PrizmaModule — wires the HubClient (from the contracts package) into the Nest DI graph.
 *
 * Marked @Global so any feature module (queue, connectors, webhooks, ...) can
 * inject PrizmaService to publish canonical events without re-importing.
 */
@Global()
@Module({
  providers: [PrizmaService],
  exports: [PrizmaService],
})
export class PrizmaModule {}
