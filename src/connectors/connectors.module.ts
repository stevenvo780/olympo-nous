import { Module, forwardRef } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ConnectorOrchestratorService } from "./connector-orchestrator.service";
import { EventRouterService } from "./event-router.service";
import { QueueModule } from "../queue/queue.module";
import { PluginsModule } from "../plugins/plugins.module";
import { LogosModule } from "./logos/logos.module";
import { MnemosyneConnectorService } from "./mnemosyne/mnemosyne-connector.service";
import { LogosEventConnectorService } from "./logos/logos-event-connector.service";
import { TalariaConnectorService } from "./talaria/talaria-connector.service";
import { IrisConnectorService } from "./iris/iris-connector.service";
import { TalantonConnectorService } from "./talanton/talanton-connector.service";
import { HermesConnectorService } from "./hermes/hermes-connector.service";
import { PistisConnectorService } from "./pistis/pistis-connector.service";

@Module({
  imports: [
    HttpModule,
    EventEmitterModule.forRoot(),
    forwardRef(() => QueueModule),
    PluginsModule,
    LogosModule,
  ],
  providers: [
    ConnectorOrchestratorService,
    EventRouterService,
    // One connector per destination service (ARCHITECTURE.md §4 fan-out).
    MnemosyneConnectorService,
    LogosEventConnectorService,
    TalariaConnectorService,
    IrisConnectorService,
    TalantonConnectorService,
    HermesConnectorService,
    PistisConnectorService,
  ],
  exports: [
    ConnectorOrchestratorService,
    EventRouterService,
    MnemosyneConnectorService,
    LogosEventConnectorService,
    TalariaConnectorService,
    IrisConnectorService,
    TalantonConnectorService,
    HermesConnectorService,
    PistisConnectorService,
  ],
})
export class ConnectorsModule {}
