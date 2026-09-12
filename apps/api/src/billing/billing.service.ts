import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
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

const ACCESS_GRANTING_STATUSES = new Set(["ACTIVE", "TRIALING", "TRIAL"]);
const BILLING_METRIC_PATTERN = /^[a-z][a-z0-9_.:-]{0,79}$/;

export interface BillingStateSnapshot {
  planId?: string | null;
  status?: string | null;
  trialEndsAt?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
}

function cloneEntitlements(entitlements: Entitlements): Entitlements {
  return {
    intelligence: { ...entitlements.intelligence },
    platforms: { ...entitlements.platforms },
    ai: { ...entitlements.ai },
    reports: { ...entitlements.reports },
    team: { ...entitlements.team },
    api: { ...entitlements.api },
  };
}

function dateFrom(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizePlanId(planId: string | null | undefined): PlanId {
  return planId === "starter" || planId === "pro" || planId === "enterprise" ? planId : "free";
}

export function subscriptionGrantsAccess(
  subscription: BillingStateSnapshot | null | undefined,
  now = new Date(),
): boolean {
  if (!subscription?.status) return false;
  const status = subscription.status.toUpperCase();
  if (!ACCESS_GRANTING_STATUSES.has(status)) return false;
  if (status === "TRIAL" || status === "TRIALING") {
    const trialEndsAt = dateFrom(subscription.trialEndsAt);
    return Boolean(trialEndsAt && trialEndsAt > now);
  }
  const currentPeriodEnd = dateFrom(subscription.currentPeriodEnd);
  return !currentPeriodEnd || currentPeriodEnd > now;
}

export function resolveEntitlements(
  subscription: BillingStateSnapshot | null | undefined,
  now = new Date(),
): Entitlements {
  if (!subscriptionGrantsAccess(subscription, now))
    return cloneEntitlements(PLAN_ENTITLEMENTS.free);
  return cloneEntitlements(
    PLAN_ENTITLEMENTS[normalizePlanId(subscription?.planId)] ?? PLAN_ENTITLEMENTS.free,
  );
}

export function validateUsageCharge(metric: string, amount: number): void {
  if (!BILLING_METRIC_PATTERN.test(metric)) {
    throw new Error("Invalid billing usage metric");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) {
    throw new Error("Invalid billing usage amount");
  }
}

@Injectable()
export class BillingService {
  async getEntitlements(userId: string): Promise<Entitlements> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return resolveEntitlements(rows[0]);
  }

  async getSubscription(userId: string) {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordUsage(userId: string, metric: string, amount: number) {
    validateUsageCharge(metric, amount);
    const db = getDb();
    await db.insert(usageMetering).values({
      userId,
      metric,
      amount,
    });
  }

  async getUsage(userId: string, metric: string): Promise<number> {
    if (!BILLING_METRIC_PATTERN.test(metric)) return 0;
    const db = getDb();
    const rows = await db
      .select({
        total: sql<number>`coalesce(sum(case when ${usageMetering.amount} > 0 then ${usageMetering.amount} else 0 end), 0)::int`,
      })
      .from(usageMetering)
      .where(and(eq(usageMetering.userId, userId), eq(usageMetering.metric, metric)));
    return rows[0]?.total ?? 0;
  }
}

export const BILLING_PLANS = PLAN_ENTITLEMENTS;
