import { createChildLogger, getMetrics } from "@xlrrank/observability";
import { checkDatabaseHealth } from "@xlrrank/database";
import { checkRedisHealth } from "@xlrrank/queue";

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, { status: string; latencyMs?: number }>;
  metrics: Record<string, number>;
  timestamp: string;
}

export async function collectHealthReport(): Promise<HealthReport> {
  const logger = createChildLogger("health-report");
  const checks: Record<string, { status: string; latencyMs?: number }> = {};

  const dbStart = Date.now();
  try {
    const dbOk = await checkDatabaseHealth();
    checks.database = { status: dbOk ? "ok" : "unavailable", latencyMs: Date.now() - dbStart };
  } catch {
    checks.database = { status: "error", latencyMs: Date.now() - dbStart };
  }

  const redisStart = Date.now();
  try {
    const redisOk = await checkRedisHealth();
    checks.redis = { status: redisOk ? "ok" : "unavailable", latencyMs: Date.now() - redisStart };
  } catch {
    checks.redis = { status: "error", latencyMs: Date.now() - redisStart };
  }

  const metrics = getMetrics().snapshot();

  const allOk = Object.values(checks).every((c) => c.status === "ok");
  const anyOk = Object.values(checks).some((c) => c.status === "ok");
  const status = allOk ? "healthy" : anyOk ? "degraded" : "unhealthy";

  logger.info({ status, checks: Object.keys(checks) }, "Health report collected");

  return { status, checks, metrics, timestamp: new Date().toISOString() };
}
