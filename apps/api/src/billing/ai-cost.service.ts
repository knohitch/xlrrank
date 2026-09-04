import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { aiProviders, aiUsage } from "@xlrrank/database/schema";
import { createChildLogger } from "@xlrrank/observability";

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
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
  }

  async getDailyCost(userId: string): Promise<number> {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.userId, userId));
    return rows
      .filter((r) => r.createdAt >= today)
      .reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
  }

  async getUsageSummary(userId: string) {
    const db = getDb();
    const rows = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.userId, userId));

    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost = rows.reduce((s, r) => s + (r.costEstimate ?? 0), 0);
    const totalRequests = rows.length;
    const failedRequests = rows.filter((r) => !r.success).length;

    return { totalTokens, totalCost, totalRequests, failedRequests };
  }
}
