import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: "Health check general del Hub Central" })
  @ApiResponse({ status: 200, description: "Estado de salud del sistema" })
  async getHealth() {
    return this.healthService.getSystemHealth();
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness simple (Prizma contract)" })
  @ApiResponse({ status: 200, description: "{ status: 'healthy', service: 'hub' }" })
  getLiveness() {
    return { status: "healthy", service: "hub" };
  }

  @Get("database")
  @ApiOperation({ summary: "Health check de la base de datos" })
  @ApiResponse({ status: 200, description: "Estado de la base de datos" })
  async getDatabaseHealth() {
    return this.healthService.getDatabaseHealth();
  }

  @Get("redis")
  @ApiOperation({ summary: "Health check de Redis" })
  @ApiResponse({ status: 200, description: "Estado de Redis" })
  async getRedisHealth() {
    return this.healthService.getRedisHealth();
  }

  @Get("ecosystem")
  @ApiOperation({ summary: "Health check del ecosistema completo" })
  @ApiResponse({
    status: 200,
    description: "Estado de todos los sistemas del ecosistema",
  })
  async getEcosystemHealth() {
    return this.healthService.getEcosystemHealth();
  }

  @Get("metrics")
  @ApiOperation({ summary: "Métricas del sistema" })
  @ApiResponse({ status: 200, description: "Métricas de rendimiento y estado" })
  async getMetrics() {
    return this.healthService.getSystemMetrics();
  }
}
