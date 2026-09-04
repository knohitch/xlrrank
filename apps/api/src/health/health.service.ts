import { Injectable } from "@nestjs/common";
import { checkDatabaseHealth } from "@xlrrank/database";
import { checkRedisHealth } from "@xlrrank/queue";
import { createChildLogger } from "@xlrrank/observability";

@Injectable()
export class HealthService {
  private readonly logger = createChildLogger("health");

  async check() {
    const [database, redis] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const result = {
      status: "ok",
      service: "xlrrank-api",
      checks: {
        database: database.status === "fulfilled" && database.value ? "ok" : "unavailable",
        redis: redis.status === "fulfilled" && redis.value ? "ok" : "unavailable",
      },
      timestamp: new Date().toISOString(),
    };

    if (result.checks.database !== "ok" || result.checks.redis !== "ok") {
      result.status = "degraded";
    }

    return result;
  }

  async checkDatabase(): Promise<boolean> {
    try {
      return await checkDatabaseHealth();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Database health check failed");
      return false;
    }
  }

  async checkRedis(): Promise<boolean> {
    try {
      return await checkRedisHealth();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Redis health check failed");
      return false;
    }
  }
}
