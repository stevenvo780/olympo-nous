import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { LogosConnectorService } from "./logos-connector.service";
import { PluginsModule } from "../../plugins/plugins.module";

@Module({
  imports: [HttpModule, PluginsModule],
  providers: [LogosConnectorService],
  exports: [LogosConnectorService],
})
export class LogosModule {}
