import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { QueueService } from "../queue/queue.service";
import { firstValueFrom, timeout, catchError } from "rxjs";
import { of } from "rxjs";

export interface HealthStatus {
  status: "healthy" | "unhealthy" | "degraded";
  timestamp: string;
  checks: Record<string, any>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
    private httpService: HttpService,
    private queueService: QueueService,
  ) {}

  /**
   * Health check general del sistema
   */
  async getSystemHealth(): Promise<HealthStatus> {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      memory: this.checkMemory(),
      uptime: this.getUptime(),
    };

    const overallStatus = this.determineOverallStatus(checks);

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  /**
   * Health check específico de base de datos
   */
  async getDatabaseHealth(): Promise<any> {
    return this.checkDatabase();
  }

  /**
   * Health check específico de Redis
   */
  async getRedisHealth(): Promise<any> {
    return this.checkRedis();
  }

  /**
   * Health check del ecosistema completo
   */
  async getEcosystemHealth(): Promise<any> {
    const systems = [
      { name: "hermes", url: process.env.HERMES_API_URL },
      { name: "iris", url: process.env.IRIS_API_URL },
      { name: "talaria", url: process.env.TALARIA_API_URL },
      { name: "pistis", url: process.env.PISTIS_API_URL },
      { name: "talanton", url: process.env.TALANTON_API_URL },
      { name: "logos", url: process.env.LOGOS_API_URL },
      { name: "mnemosyne", url: process.env.MNEMOSYNE_API_URL },
    ];

    const checks = await Promise.allSettled(
      systems.map((system) => this.checkExternalSystem(system)),
    );

    const results = {};
    systems.forEach((system, index) => {
      const check = checks[index];
      results[system.name] =
        check.status === "fulfilled"
          ? check.value
          : { status: "unhealthy", error: check.reason };
    });

    return {
      timestamp: new Date().toISOString(),
      systems: results,
      summary: this.generateEcosystemSummary(results),
    };
  }

  /**
   * Métricas del sistema
   */
  async getSystemMetrics(): Promise<any> {
    const queueStats = await this.queueService.getQueueStats();

    return {
      timestamp: new Date().toISOString(),
      queues: queueStats,
      memory: this.getMemoryUsage(),
      uptime: this.getUptime(),
      load: this.getSystemLoad(),
    };
  }

  private async checkDatabase(): Promise<any> {
    try {
      await this.dataSource.query("SELECT 1");
      return {
        status: "healthy",
        responseTime: Date.now(),
        connection: "active",
      };
    } catch (error) {
      this.logger.error("Database health check failed:", error);
      return {
        status: "unhealthy",
        error: error.message,
      };
    }
  }

  private async checkRedis(): Promise<any> {
    try {
      const stats = await this.queueService.getQueueStats();
      return {
        status: "healthy",
        queues: Object.keys(stats).length,
        connection: "active",
      };
    } catch (error) {
      this.logger.error("Redis health check failed:", error);
      return {
        status: "unhealthy",
        error: error.message,
      };
    }
  }

  private checkMemory(): any {
    const usage = process.memoryUsage();
    const totalMB = Math.round(usage.heapTotal / 1024 / 1024);
    const usedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const utilization = (usedMB / totalMB) * 100;

    return {
      status: utilization > 90 ? "degraded" : "healthy",
      totalMB,
      usedMB,
      utilization: Math.round(utilization),
    };
  }

  private getUptime(): any {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);

    return {
      seconds: uptimeSeconds,
      formatted: `${hours}h ${minutes}m ${seconds}s`,
    };
  }

  private async checkExternalSystem(system: {
    name: string;
    url: string;
  }): Promise<any> {
    try {
      const start = Date.now();

      await firstValueFrom(
        this.httpService.get(`${system.url}/health`).pipe(
          timeout(5000),
          catchError((error) => of({ data: { error: error.message } })),
        ),
      );

      const responseTime = Date.now() - start;

      return {
        status: "healthy",
        responseTime,
        url: system.url,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        error: error.message,
        url: system.url,
      };
    }
  }

  private determineOverallStatus(
    checks: Record<string, any>,
  ): "healthy" | "unhealthy" | "degraded" {
    const statuses = Object.values(checks).map((check) => check.status);

    if (statuses.includes("unhealthy")) {
      return "unhealthy";
    }

    if (statuses.includes("degraded")) {
      return "degraded";
    }

    return "healthy";
  }

  private generateEcosystemSummary(results: Record<string, any>): any {
    const total = Object.keys(results).length;
    const healthy = Object.values(results).filter(
      (r) => r.status === "healthy",
    ).length;
    const unhealthy = Object.values(results).filter(
      (r) => r.status === "unhealthy",
    ).length;

    return {
      total,
      healthy,
      unhealthy,
      degraded: total - healthy - unhealthy,
      healthPercentage: Math.round((healthy / total) * 100),
    };
  }

  private getMemoryUsage(): any {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024),
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
      external: Math.round(usage.external / 1024 / 1024),
    };
  }

  private getSystemLoad(): any {
    return {
      cpu: "N/A",
      platform: process.platform,
      nodeVersion: process.version,
    };
  }
}
