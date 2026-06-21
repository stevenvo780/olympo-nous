import {
  Controller,
  Get,
  Param,
  Query,
  Put,
  Body,
  Delete,
  Req,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from "@nestjs/swagger";
import { Request } from "express";
import { PluginsService } from "./plugins.service";
import { Logger } from "@nestjs/common";
import { ValidatedUpdatePluginDto } from "./dto/credential-validation.dto";

@ApiTags("plugins")
@Controller("plugins")
export class PluginsController {
  private readonly logger = new Logger(PluginsController.name);
  constructor(private readonly plugins: PluginsService) {}

  @Get("catalog")
  @ApiOperation({ summary: "Catálogo global de plugins soportados" })
  getCatalog() {
    return [
      { key: "logos", name: "Facturación SIGO", scopes: ["billing"] },
      { key: "iris", name: "Mensajería IRIS", scopes: ["messaging"] },
      { key: "talaria", name: "Logística Talaria", scopes: ["delivery"] },
      { key: "talanton", name: "POS Talanton", scopes: ["pos"] },
      { key: "hermes", name: "E-commerce Hermes", scopes: ["ecommerce"] },
      { key: "pistis", name: "Créditos PISTIS", scopes: ["credits"] },
    ];
  }

  @Get("plugins")
  @ApiOperation({
    summary: "Listar plugins configurados por usuario autenticado",
  })
  @ApiQuery({
    name: "service",
    required: false,
    description: "Servicio propietario (por defecto nous)",
  })
  async listUserPlugins(
    @Req() req: Request,
    @Query("service") service?: string,
  ) {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new Error("Usuario no autenticado. Header x-user-email requerido.");
    }
    return this.plugins.listUserPlugins(userId, service);
  }

  @Put("plugins/:pluginKey/credentials")
  @ApiOperation({
    summary: "Actualizar/crear credenciales de plugin para usuario autenticado",
  })
  @ApiQuery({
    name: "service",
    required: false,
    description: "Servicio propietario (por defecto nous)",
  })
  @ApiQuery({
    name: "subconfigId",
    required: false,
    description:
      "ID de subconfiguraci\u00f3n para plugins con m\u00faltiples instancias",
  })
  @ApiResponse({
    status: 200,
    description: "Credenciales actualizadas exitosamente",
  })
  @ApiResponse({ status: 400, description: "Datos de entrada inválidos" })
  @ApiResponse({ status: 401, description: "Usuario no autenticado" })
  @ApiResponse({ status: 429, description: "Demasiadas solicitudes" })
  async upsertCredentials(
    @Param("pluginKey") pluginKey: string,
    @Body() dto: ValidatedUpdatePluginDto,
    @Req() req: Request,
    @Query("service") service = "nous",
    @Query("subconfigId") subconfigId?: string,
  ) {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new Error("Usuario no autenticado. Header x-user-email requerido.");
    }

    const auditMetadata = {
      ip: req.ip,
      userAgent: req.get("user-agent"),
    };

    this.logger.log(
      `PUT /plugins/${pluginKey}/credentials service=${service} sub=${subconfigId} user=${userId} dto.keys=[${Object.keys(
        dto?.config || {},
      ).join(",",
      )}]`,
    );
    const result = await this.plugins.upsertUserPlugin(
      userId,
      service,
      pluginKey,
      dto,
      auditMetadata,
      subconfigId,
    );
    const cfg = result?.config || {};
    const subCfg = subconfigId ? cfg : cfg; // already flattened for subconfig in service
    const hasTriggerEvent = !!(subCfg?.triggerEvent);
    this.logger.log(
      `Saved plugin ${pluginKey} for user=${userId} sub=${subconfigId} triggerEvent=${hasTriggerEvent ? subCfg.triggerEvent : '<none>'}`,
    );
    return result;
  }

  @Get("plugins/:pluginKey")
  @ApiOperation({
    summary:
      "Obtener credenciales específicas de plugin para usuario autenticado",
  })
  @ApiQuery({
    name: "service",
    required: false,
    description: "Servicio propietario (por defecto nous)",
  })
  @ApiQuery({
    name: "subconfigId",
    required: false,
    description: "ID de subconfiguración para plugins con múltiples instancias",
  })
  @ApiResponse({ status: 200, description: "Credenciales encontradas" })
  @ApiResponse({ status: 401, description: "Usuario no autenticado" })
  @ApiResponse({ status: 404, description: "Plugin no encontrado" })
  @ApiResponse({ status: 429, description: "Demasiadas solicitudes" })
  async getCredentials(
    @Param("pluginKey") pluginKey: string,
    @Req() req: Request,
    @Query("service") service = "nous",
    @Query("subconfigId") subconfigId?: string,
  ) {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new Error("Usuario no autenticado. Header x-user-email requerido.");
    }

    const auditMetadata = { ip: req.ip };
    const plugin = await this.plugins.getUserPlugin(
      userId,
      service,
      pluginKey,
      auditMetadata,
      subconfigId,
    );

    if (!plugin) {
      return {
        pluginKey,
        userId,
        service,
        enabled: false,
        config: {},
        exists: false,
      };
    }

    const cfg = plugin.config || {};
    this.logger.log(
      `GET /plugins/${pluginKey} service=${service} sub=${subconfigId} user=${userId} triggerEvent=${cfg?.triggerEvent ?? '<none>'}`,
    );
    return {
      pluginKey: plugin.pluginKey,
      userId,
      service: plugin.service,
      enabled: plugin.enabled,
      config: plugin.config,
      exists: true,
      createdAt: plugin.createdAt,
      updatedAt: plugin.updatedAt,
    };
  }

  @Delete("plugins/:pluginKey/credentials")
  @ApiOperation({
    summary: "Eliminar credenciales de plugin para usuario autenticado",
  })
  @ApiQuery({
    name: "service",
    required: false,
    description: "Servicio propietario (por defecto nous)",
  })
  @ApiQuery({
    name: "subconfigId",
    required: false,
    description: "ID de subconfiguración para plugins con múltiples instancias",
  })
  @ApiResponse({
    status: 200,
    description: "Credenciales eliminadas exitosamente",
  })
  @ApiResponse({ status: 401, description: "Usuario no autenticado" })
  @ApiResponse({ status: 404, description: "Plugin no encontrado" })
  @ApiResponse({ status: 429, description: "Demasiadas solicitudes" })
  async deleteCredentials(
    @Param("pluginKey") pluginKey: string,
    @Req() req: Request,
    @Query("service") service = "nous",
    @Query("subconfigId") subconfigId?: string,
  ) {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new Error("Usuario no autenticado. Header x-user-email requerido.");
    }

    const auditMetadata = {
      ip: req.ip,
      userAgent: req.get("user-agent"),
    };

    const deleted = await this.plugins.deleteUserPlugin(
      userId,
      service,
      pluginKey,
      auditMetadata,
      subconfigId,
    );
    return {
      success: deleted,
      message: deleted
        ? "Credenciales eliminadas exitosamente"
        : "Plugin no encontrado",
      pluginKey,
      userId,
      service,
      timestamp: new Date().toISOString(),
    };
  }

  @Get("plugins/:pluginKey/health")
  @ApiOperation({
    summary: "Health check del plugin para usuario autenticado",
  })
  @ApiQuery({ name: "service", required: false })
  @ApiQuery({
    name: "subconfigId",
    required: false,
    description: "ID de subconfiguración para plugins con múltiples instancias",
  })
  @ApiResponse({ status: 200, description: "Estado del plugin" })
  @ApiResponse({ status: 401, description: "Usuario no autenticado" })
  async pluginHealth(
    @Param("pluginKey") pluginKey: string,
    @Req() req: Request,
    @Query("service") service = "nous",
    @Query("subconfigId") subconfigId?: string,
  ) {
    const userId = req.userContext?.userId;
    if (!userId) {
      throw new Error("Usuario no autenticado. Header x-user-email requerido.");
    }

    const row = await this.plugins.getUserPlugin(
      userId,
      service,
      pluginKey,
      {},
      subconfigId,
    );
    return {
      pluginKey,
      userId,
      enabled: !!row?.enabled,
      status: row?.enabled ? "ok" : "disabled",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Health check unificado
   */
  @Get("health")
  @ApiOperation({ summary: "Health check del sistema de plugins y usuarios" })
  @ApiResponse({ status: 200, description: "Estado del sistema" })
  async healthCheck() {
    try {
      const healthStatus = await this.plugins.healthCheck();

      return {
        success: true,
        service: "Plugins & Users Service",
        timestamp: new Date().toISOString(),
        ...healthStatus,
      };
    } catch (error) {
      return {
        success: false,
        service: "Plugins & Users Service",
        timestamp: new Date().toISOString(),
        status: "unhealthy",
        error: error.message,
      };
    }
  }
}
