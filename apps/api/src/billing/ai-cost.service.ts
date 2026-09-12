import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { aiUsage } from "@xlrrank/database/schema";
import { createChildLogger } from "@xlrrank/observability";
import { redactSensitiveText } from "../common/encryption.js";

export function validateAiUsageAccounting(input: {
  promptTokens: number;
  completionTokens: number;
  costEstimate?: number;
  latencyMs?: number;
}): void {
  const tokenAmounts = [input.promptTokens, input.completionTokens];
  if (
    tokenAmounts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000_000)
  ) {
    throw new Error("Invalid AI token usage amount");
  }
  if (
    input.costEstimate !== undefined &&
    (!Number.isFinite(input.costEstimate) || input.costEstimate < 0 || input.costEstimate > 10_000)
  ) {
    throw new Error("Invalid AI usage cost estimate");
  }
  if (
    input.latencyMs !== undefined &&
    (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 3_600_000)
  ) {
    throw new Error("Invalid AI usage latency");
  }
}

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

@Injectable()
export class AiCostService {
  private readonly logger = createChildLogger("ai-cost");

  async trackUsage(input: {
    userId?: string;
    providerId: string;
    modelId: string;
    taskType: string;
    promptTokens: number;
    completionTokens: number;
    costEstimate?: number;
    latencyMs?: number;
    success: boolean;
    errorMessage?: string;
  }) {
    validateAiUsageAccounting(input);
    const db = getDb();
    await db.insert(aiUsage).values({
      ...(input.userId ? { userId: input.userId } : {}),
      providerId: input.providerId,
      modelId: input.modelId,
      taskType: input.taskType,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.promptTokens + input.completionTokens,
      ...(input.costEstimate !== undefined ? { costEstimate: input.costEstimate } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      success: input.success,
      ...(input.errorMessage
        ? { errorMessage: redactSensitiveText(input.errorMessage).slice(0, 1_000) }
        : {}),
    });
  }

  async getDailyCost(userId: string): Promise<number> {
    const db = getDb();
    const today = utcDayStart();
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.userId, userId));
    return rows
      .filter((r) => r.createdAt >= today)
      .reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
  }

  async getUsageSummary(userId: string) {
    const db = getDb();
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.userId, userId));

    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost = rows.reduce((s, r) => s + (r.costEstimate ?? 0), 0);
    const totalRequests = rows.length;
    const failedRequests = rows.filter((r) => !r.success).length;

    return { totalTokens, totalCost, totalRequests, failedRequests };
  }
}
