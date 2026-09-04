import { Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { platforms, socialAccounts } from "@xlrrank/database/schema";
import { connectorRegistry, XConnector, InstagramConnector, FacebookConnector, LinkedInConnector, RedditConnector } from "@xlrrank/social-core";

@Injectable()
export class PlatformsService {
  private initialized = false;

  private ensureConnectors(): void {
    if (this.initialized) return;
    connectorRegistry.register(new XConnector());
    connectorRegistry.register(new InstagramConnector());
    connectorRegistry.register(new FacebookConnector());
    connectorRegistry.register(new LinkedInConnector());
    connectorRegistry.register(new RedditConnector());
    this.initialized = true;
  }

  async listPlatforms(userId: string) {
    this.ensureConnectors();
    const db = getDb();
    const allPlatforms = await db.select().from(platforms);

    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));

    return allPlatforms.map((p) => {
      const connector = connectorRegistry.get(p.id);
      const account = accounts.find((a) => a.platformId === p.id);
      return {
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        enabled: p.enabled,
        connected: !!account,
        status: account?.status ?? "DISCONNECTED",
        lastSyncAt: account?.lastSyncAt ?? null,
        capabilities: connector?.getManifest().capabilities ?? {},
      };
    });
  }

  async getPlatform(platformId: string, userId: string) {
    const db = getDb();
    const rows = await db.select().from(platforms).where(eq(platforms.id, platformId)).limit(1);
    const platform = rows[0];
    if (!platform) throw new NotFoundException("Platform not found.");

    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));
    const account = accounts.find((a) => a.platformId === platformId);

    return {
      ...platform,
      connected: !!account,
      status: account?.status ?? "DISCONNECTED",
      lastSyncAt: account?.lastSyncAt ?? null,
    };
  }

  async connectPlatform(platformId: string, userId: string, credentials: Record<string, unknown>) {
    const db = getDb();
    const existing = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));

    const account = existing.find((a) => a.platformId === platformId);
    if (account) {
      await db
        .update(socialAccounts)
        .set({
          status: "CONNECTED",
          credentialsEncrypted: JSON.stringify(credentials),
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, account.id));
      return { status: "CONNECTED", message: "Platform reconnected." };
    }

    await db.insert(socialAccounts).values({
      platformId,
      userId,
      externalId: credentials.externalId as string ?? "unknown",
      handle: credentials.handle as string ?? "unknown",
      status: "CONNECTED",
      credentialsEncrypted: JSON.stringify(credentials),
    });
    return { status: "CONNECTED", message: "Platform connected." };
  }

  async disconnectPlatform(platformId: string, userId: string) {
    const db = getDb();
    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));

    const account = accounts.find((a) => a.platformId === platformId);
    if (!account) throw new NotFoundException("No connection found for this platform.");

    await db
      .update(socialAccounts)
      .set({ status: "DISCONNECTED", updatedAt: new Date() })
      .where(eq(socialAccounts.id, account.id));
    return { status: "DISCONNECTED", message: "Platform disconnected." };
  }
}
