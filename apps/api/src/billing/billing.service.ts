import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { subscriptions, usageMetering } from "@xlrrank/database/schema";

export type PlanId = "free" | "starter" | "pro" | "enterprise";

export interface Entitlements {
  intelligence: { deep_reasoning: boolean };
  platforms: { maxConnected: number };
  ai: { byok: boolean; maxDailyCost: number };
  reports: { export: boolean };
  team: { maxMembers: number };
  api: { access: boolean };
}

const PLAN_ENTITLEMENTS: Record<PlanId, Entitlements> = {
  free: {
    intelligence: { deep_reasoning: false },
    platforms: { maxConnected: 2 },
    ai: { byok: false, maxDailyCost: 0.5 },
    reports: { export: false },
    team: { maxMembers: 1 },
    api: { access: false },
  },
  starter: {
    intelligence: { deep_reasoning: false },
    platforms: { maxConnected: 5 },
    ai: { byok: true, maxDailyCost: 5 },
    reports: { export: true },
    team: { maxMembers: 3 },
    api: { access: false },
  },
  pro: {
    intelligence: { deep_reasoning: true },
    platforms: { maxConnected: 10 },
    ai: { byok: true, maxDailyCost: 25 },
    reports: { export: true },
    team: { maxMembers: 10 },
    api: { access: true },
  },
  enterprise: {
    intelligence: { deep_reasoning: true },
    platforms: { maxConnected: 999 },
    ai: { byok: true, maxDailyCost: 999 },
    reports: { export: true },
    team: { maxMembers: 999 },
    api: { access: true },
  },
};

@Injectable()
export class BillingService {
  async getEntitlements(userId: string): Promise<Entitlements> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    const sub = rows[0];
    if (!sub) return PLAN_ENTITLEMENTS.free;
    const planId = (sub.planId ?? "free") as PlanId;
    return PLAN_ENTITLEMENTS[planId] ?? PLAN_ENTITLEMENTS.free;
  }

  async getSubscription(userId: string) {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordUsage(userId: string, metric: string, amount: number) {
    const db = getDb();
    await db.insert(usageMetering).values({
      userId,
      metric,
      amount,
    });
  }

  async getUsage(userId: string, metric: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select()
      .from(usageMetering)
      .where(eq(usageMetering.userId, userId));
    return rows
      .filter((r) => r.metric === metric)
      .reduce((sum, r) => sum + r.amount, 0);
  }
}

export const BILLING_PLANS = PLAN_ENTITLEMENTS;
