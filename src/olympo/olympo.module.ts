import { Global, Module } from "@nestjs/common";
import { OlympoService } from "./cauce.service";

/**
 * OlympoModule — wires the @olympo/contracts HubClient into the Nest DI graph.
 *
 * Marked @Global so any feature module (queue, connectors, webhooks, ...) can
 * inject OlympoService to publish canonical events without re-importing.
 */
@Global()
@Module({
  providers: [OlympoService],
  exports: [OlympoService],
})
export class OlympoModule {}
