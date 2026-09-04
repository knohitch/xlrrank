import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { platforms, socialAccounts } from "@xlrrank/database/schema";
import {
  connectorRegistry,
  XConnector,
  InstagramConnector,
  FacebookConnector,
  LinkedInConnector,
  RedditConnector,
} from "@xlrrank/social-core";
import type { ConnectorCredentials } from "@xlrrank/social-core";
import { encryptSecret } from "../common/encryption.js";

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

  private isLiveConnected(status: string | null | undefined): boolean {
    return status === "CONNECTED" || status === "HEALTHY";
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
      const connector = connectorRegistry.get(p.slug);
      const account = accounts.find((a) => a.platformId === p.id);
      const status = account?.status ?? "DISCONNECTED";
      return {
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        enabled: p.enabled,
        connected: this.isLiveConnected(status),
        demo: status === "DEMO",
        status,
        lastSyncAt: account?.lastSyncAt ?? null,
        capabilities: connector?.getManifest().capabilities ?? {},
      };
    });
  }

  async getPlatform(platformId: string, userId: string) {
    this.ensureConnectors();
    const db = getDb();
    const rows = await db.select().from(platforms).where(eq(platforms.id, platformId)).limit(1);
    const platform = rows[0];
    if (!platform) throw new NotFoundException("Platform not found.");

    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));
    const account = accounts.find((a) => a.platformId === platformId);
    const status = account?.status ?? "DISCONNECTED";

    return {
      ...platform,
      connected: this.isLiveConnected(status),
      demo: status === "DEMO",
      status,
      lastSyncAt: account?.lastSyncAt ?? null,
      capabilities: connectorRegistry.get(platform.slug)?.getManifest().capabilities ?? {},
    };
  }

  async connectPlatform(
    platformId: string,
    userId: string,
    credentials: ConnectorCredentials,
  ) {
    this.ensureConnectors();
    const db = getDb();
    const platformRows = await db
      .select()
      .from(platforms)
      .where(eq(platforms.id, platformId))
      .limit(1);
    const platform = platformRows[0];
    if (!platform) throw new NotFoundException("Platform not found.");
    if (!platform.enabled) {
      throw new BadRequestException("This platform is disabled.");
    }

    const connector = connectorRegistry.get(platform.slug);
    if (!connector) {
      throw new BadRequestException("No connector implementation is registered for this platform.");
    }

    // A connector must prove authentication against the provider before any
    // database row can be labelled CONNECTED. Current interface-only adapters
    // fail closed here instead of masquerading as live integrations.
    const auth = await connector.authenticate(credentials);
    if (!auth.success || !this.isLiveConnected(auth.status)) {
      throw new BadRequestException(auth.error ?? "Platform authentication failed.");
    }

    const profile = auth.profile ?? (await connector.getAuthenticatedProfile());
    if (!profile?.externalId || !profile.handle) {
      await connector.disconnect();
      throw new BadRequestException(
        "The platform did not return a verified authenticated profile.",
      );
    }

    const credentialsEncrypted = encryptSecret(JSON.stringify(credentials));
    const existing = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, userId));
    const account = existing.find((a) => a.platformId === platformId);

    try {
      if (account) {
        await db
          .update(socialAccounts)
          .set({
            externalId: profile.externalId,
            handle: profile.handle,
            displayName: profile.displayName ?? null,
            profileImageUrl: profile.profileImageUrl ?? null,
            bio: profile.bio ?? null,
            location: profile.location ?? null,
            website: profile.website ?? null,
            followerCount: profile.followerCount ?? null,
            followingCount: profile.followingCount ?? null,
            status: auth.status,
            credentialsEncrypted,
            updatedAt: new Date(),
          })
          .where(eq(socialAccounts.id, account.id));
        return { status: auth.status, message: "Platform reconnected." };
      }

      await db.insert(socialAccounts).values({
        platformId,
        userId,
        externalId: profile.externalId,
        handle: profile.handle,
        displayName: profile.displayName ?? null,
        profileImageUrl: profile.profileImageUrl ?? null,
        bio: profile.bio ?? null,
        location: profile.location ?? null,
        website: profile.website ?? null,
        followerCount: profile.followerCount ?? null,
        followingCount: profile.followingCount ?? null,
        status: auth.status,
        credentialsEncrypted,
      });
      return { status: auth.status, message: "Platform connected." };
    } finally {
      // Do not retain per-user credentials in the singleton registry adapter.
      await connector.disconnect();
    }
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
      .set({
        status: "DISCONNECTED",
        credentialsEncrypted: null,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, account.id));
    return { status: "DISCONNECTED", message: "Platform disconnected." };
  }
}
