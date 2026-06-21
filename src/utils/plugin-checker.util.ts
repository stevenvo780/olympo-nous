import { Logger } from "@nestjs/common";
import { PluginsService } from "../plugins/plugins.service";

export async function isPluginEnabled(
  pluginsService: PluginsService,
  logger: Logger,
  pluginKey: string,
  userId?: string,
  serviceKey?: string,
): Promise<boolean> {
  try {
    if (!userId) return false;

    const plugin = await pluginsService.getUserPlugin(
      userId,
      serviceKey || "nous",
      pluginKey,
    );
    return plugin?.enabled === true;
  } catch (error) {
    logger.warn(
      `Error verificando plugin ${pluginKey} para usuario ${userId}: ${error.message}`,
    );
    return false;
  }
}
