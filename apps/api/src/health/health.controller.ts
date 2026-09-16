import { Controller, Get, Inject } from "@nestjs/common";
import { HealthService } from "./health.service.js";
import { getEnv } from "@xlrrank/config";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(HealthService)
    private readonly healthService: HealthService,
  ) {}

  @Get()
  async health() {
    return this.healthService.check();
  }

  @Get("live")
  live() {
    return { status: "ok", service: "api", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async ready() {
    const env = getEnv();
    const databaseOk = await this.healthService.checkDatabase();
    const redisOk = await this.healthService.checkRedis();
    const allOk = databaseOk && redisOk;
    return {
      status: allOk ? "ready" : "degraded",
      checks: {
        database: databaseOk ? "ok" : "unavailable",
        redis: redisOk ? "ok" : "unavailable",
      },
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    };
  }
}
