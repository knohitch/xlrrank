import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { featureFlags } from "@xlrrank/database/schema";

export type FeatureFlagScope = "GLOBAL" | "ENVIRONMENT" | "ORGANIZATION" | "USER";

@Injectable()
export class FeatureFlagsService {
  async isEnabled(key: string, userId?: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, key));

    for (const flag of rows) {
      if (flag.scope === "GLOBAL" && flag.enabled) return true;
      if (flag.scope === "USER" && flag.targetUserId === userId && flag.enabled) return true;
    }
    return false;
  }

  async listAll() {
    const db = getDb();
    return db.select().from(featureFlags).orderBy(desc(featureFlags.createdAt));
  }

  async setFlag(key: string, scope: FeatureFlagScope, enabled: boolean, options?: { userId?: string; orgId?: string }) {
    const db = getDb();
    await db
      .insert(featureFlags)
      .values({
        key,
        scope,
        enabled,
        ...(options?.userId ? { targetUserId: options.userId } : {}),
        ...(options?.orgId ? { targetOrgId: options.orgId } : {}),
      })
      .onConflictDoNothing();
  }
}
