import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  authorizeConnection,
  createSocialConnectionSyncRequest,
  ensurePersonalScope,
  getAuthorizedSocialSyncJobStatus,
  getDb,
  getPool,
} from "@xlrrank/database";
import { platforms } from "@xlrrank/database/schema";
import {
  connectorRegistry,
  FacebookConnector,
  InstagramConnector,
  LinkedInConnector,
  RedditConnector,
  XConnector,
} from "@xlrrank/social-core";
import type { ConnectorCredentials } from "@xlrrank/social-core";
import { AuditService } from "../audit/audit.service.js";
import { encryptSecret, socialCredentialAssociatedData } from "../common/encryption.js";

interface ConnectionRow {
  id: string;
  scope_id: string;
  platform_id: string;
  external_account_id: string | null;
  status: string;
  verified_external_id: string | null;
  verified_handle: string | null;
  last_sync_at: Date | null;
  last_sync_attempt_at: Date | null;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: Date | null;
  retry_after_seconds: number | null;
  sync_error: unknown;
}

@Injectable()
export class PlatformsService {
  private initialized = false;

  constructor(
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}

  private ensureConnectors(): void {
    if (this.initialized) return;
    connectorRegistry.registerFactory(() => new XConnector());
    connectorRegistry.registerFactory(() => new InstagramConnector());
    connectorRegistry.registerFactory(() => new FacebookConnector());
    connectorRegistry.registerFactory(() => new LinkedInConnector());
    connectorRegistry.registerFactory(() => new RedditConnector());
    this.initialized = true;
  }

  private isLiveConnected(status: string | null | undefined): boolean {
    return status === "CONNECTED";
  }

  private toConnectionDto(account: ConnectionRow | undefined) {
    if (!account) return null;
    return {
      id: account.id,
      scopeId: account.scope_id,
      platformId: account.platform_id,
      externalAccountId: account.external_account_id,
      status: account.status,
      connected: this.isLiveConnected(account.status),
      verifiedExternalId: account.verified_external_id,
      verifiedHandle: account.verified_handle,
      lastSyncAt: account.last_sync_at,
      lastSyncAttemptAt: account.last_sync_attempt_at,
      sync: {
        status: account.status,
      },
      diagnostics: {
        rateLimitRemaining: account.rate_limit_remaining,
        rateLimitResetAt: account.rate_limit_reset_at,
        retryAfterSeconds: account.retry_after_seconds,
        syncError: account.sync_error,
      },
    };
  }

  async listPlatforms(userId: string) {
    this.ensureConnectors();
    const db = getDb();
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const allPlatforms = await db.select().from(platforms);
    const connections = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1",
      [scope.scopeId],
    );

    return allPlatforms.map((p) => {
      const connector = connectorRegistry.getDefinition(p.slug);
      const account = connections.rows.find((a) => a.platform_id === p.id);
      const status = account?.status ?? "DISCONNECTED";
      return {
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        enabled: p.enabled,
        connected: this.isLiveConnected(status),
        status,
        lastSyncAt: account?.last_sync_at ?? null,
        capabilities: connector?.manifest.capabilities ?? {},
        connection: this.toConnectionDto(account),
      };
    });
  }

  async getPlatform(platformId: string, userId: string) {
    this.ensureConnectors();
    const db = getDb();
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const rows = await db.select().from(platforms).where(eq(platforms.id, platformId)).limit(1);
    const platform = rows[0];
    if (!platform) throw new NotFoundException("Platform not found.");

    const accounts = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2",
      [scope.scopeId, platformId],
    );
    const account = accounts.rows[0];
    const status = account?.status ?? "DISCONNECTED";

    return {
      id: platform.id,
      slug: platform.slug,
      displayName: platform.displayName,
      enabled: platform.enabled,
      connected: this.isLiveConnected(status),
      status,
      lastSyncAt: account?.last_sync_at ?? null,
      capabilities: connectorRegistry.getDefinition(platform.slug)?.manifest.capabilities ?? {},
      connection: this.toConnectionDto(account),
    };
  }

  async connectPlatform(platformId: string, userId: string, credentials: ConnectorCredentials) {
    this.ensureConnectors();
    const db = getDb();
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const platformRows = await db
      .select()
      .from(platforms)
      .where(eq(platforms.id, platformId))
      .limit(1);
    const platform = platformRows[0];
    if (!platform) throw new NotFoundException("Platform not found.");
    if (!platform.enabled) throw new BadRequestException("This platform is disabled.");

    const connector = connectorRegistry.create(platform.slug);
    if (!connector) {
      throw new BadRequestException("No connector implementation is registered for this platform.");
    }

    const auth = await connector.authenticate(credentials);
    if (!auth.success || auth.status !== "CONNECTED") {
      await this.audit.record({
        actorUserId: userId,
        action: "social.connection.authentication_failed",
        entityType: "platform",
        entityId: platformId,
        metadata: { platformId, scopeId: scope.scopeId },
      });
      throw new BadRequestException(auth.error ?? "Platform authentication failed.");
    }

    const profile = auth.profile ?? (await connector.getAuthenticatedProfile());
    if (!profile?.externalId || !profile.handle) {
      await connector.disconnect();
      throw new BadRequestException(
        "The platform did not return a verified authenticated profile.",
      );
    }

    const connectionResult = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2",
      [scope.scopeId, platformId],
    );
    const existing = connectionResult.rows[0];
    const connectionId = existing?.id ?? randomUUID();
    const credentialsEncrypted = encryptSecret(
      JSON.stringify(credentials),
      undefined,
      socialCredentialAssociatedData({
        connectionId,
        scopeId: scope.scopeId,
        platformSlug: platform.slug,
      }),
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const accountResult = await client.query<{ id: string }>(
        `
          INSERT INTO social_external_accounts (
            platform_id, external_id, current_handle, display_name,
            profile_image_url, bio, location, website, follower_count,
            following_count, visibility, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (platform_id, external_id) DO UPDATE SET
            current_handle = EXCLUDED.current_handle,
            display_name = EXCLUDED.display_name,
            profile_image_url = EXCLUDED.profile_image_url,
            bio = EXCLUDED.bio,
            location = EXCLUDED.location,
            website = EXCLUDED.website,
            follower_count = EXCLUDED.follower_count,
            following_count = EXCLUDED.following_count,
            last_observed_at = now(),
            updated_at = now()
          RETURNING id
        `,
        [
          platformId,
          profile.externalId,
          profile.handle,
          profile.displayName ?? null,
          profile.profileImageUrl ?? null,
          profile.bio ?? null,
          profile.location ?? null,
          profile.website ?? null,
          profile.followerCount ?? null,
          profile.followingCount ?? null,
          profile.visibility ?? "UNKNOWN",
          profile.metadata ?? {},
        ],
      );
      const externalAccountId = accountResult.rows[0]?.id;
      if (!externalAccountId) throw new Error("Failed to persist canonical social account");

      await client.query(
        `
          INSERT INTO social_account_handles (external_account_id, handle)
          VALUES ($1, $2)
          ON CONFLICT (external_account_id, handle)
          DO UPDATE SET last_seen_at = now()
        `,
        [externalAccountId, profile.handle],
      );

      await client.query(
        `
          INSERT INTO social_connections (
            id, scope_id, platform_id, external_account_id, status,
            credentials_encrypted, verified_external_id, verified_handle, provider_metadata
          )
          VALUES ($1, $2, $3, $4, 'CONNECTED', $5, $6, $7, $8)
          ON CONFLICT (scope_id, platform_id) DO UPDATE SET
            external_account_id = EXCLUDED.external_account_id,
            status = 'CONNECTED',
            credentials_encrypted = EXCLUDED.credentials_encrypted,
            credential_version = social_connections.credential_version + 1,
            verified_external_id = EXCLUDED.verified_external_id,
            verified_handle = EXCLUDED.verified_handle,
            provider_metadata = EXCLUDED.provider_metadata,
            disconnected_at = NULL,
            updated_at = now()
        `,
        [
          connectionId,
          scope.scopeId,
          platformId,
          externalAccountId,
          credentialsEncrypted,
          profile.externalId,
          profile.handle,
          profile.metadata ?? {},
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
      await connector.disconnect();
    }

    await this.audit.record({
      actorUserId: userId,
      action: existing ? "social.connection.credentials_replaced" : "social.connection.created",
      entityType: "social_connection",
      entityId: connectionId,
      metadata: { platformId, scopeId: scope.scopeId },
    });

    return {
      status: "CONNECTED",
      message: existing ? "Platform reconnected." : "Platform connected.",
      connectionId,
      externalAccountId: profile.externalId,
      handle: profile.handle,
    };
  }

  async disconnectPlatform(platformId: string, userId: string) {
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const accounts = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2",
      [scope.scopeId, platformId],
    );

    const account = accounts.rows[0];
    if (!account) throw new NotFoundException("No connection found for this platform.");
    if (account.scope_id !== scope.scopeId)
      throw new ForbiddenException("Connection scope denied.");

    await pool.query(
      `
        UPDATE social_connections
        SET status = 'DISCONNECTED',
            credentials_encrypted = NULL,
            disabled_at = NULL,
            disconnected_at = now(),
            updated_at = now()
        WHERE id = $1 AND scope_id = $2
      `,
      [account.id, scope.scopeId],
    );
    await this.audit.record({
      actorUserId: userId,
      action: "social.connection.disconnected",
      entityType: "social_connection",
      entityId: account.id,
      metadata: { platformId, scopeId: scope.scopeId },
    });
    return { status: "DISCONNECTED", message: "Platform disconnected." };
  }

  async requestConnectionSync(connectionId: string, userId: string, idempotencyKey?: string) {
    const scope = await authorizeConnection(userId, connectionId, "TRIGGER_SOCIAL_SYNC");
    if (!scope) throw new NotFoundException("Sync job target not found.");
    const request = await createSocialConnectionSyncRequest({
      connectionId,
      requestedByUserId: userId,
      reason: "MANUAL",
      idempotencyKey: idempotencyKey ?? null,
    });
    await this.audit.record({
      actorUserId: userId,
      action: request.duplicate
        ? "social.connection.sync_duplicate_requested"
        : "social.connection.sync_requested",
      entityType: "social_connection",
      entityId: connectionId,
      metadata: { jobId: request.jobId, scopeId: scope.scopeId, status: request.status },
    });
    return {
      status: request.duplicate ? "already_queued" : "accepted",
      jobId: request.jobId,
      connectionId: request.connectionId,
      jobStatus: request.status,
    };
  }

  async getSyncJobStatus(jobId: string, userId: string) {
    const status = await getAuthorizedSocialSyncJobStatus({ userId, jobId });
    if (!status) throw new NotFoundException("Sync job not found.");
    return {
      job: {
        id: status.id,
        type: status.type,
        status: status.status,
        connectionId: status.connectionId,
        reason: status.reason,
        attemptCount: status.attemptCount,
        maxAttempts: status.maxAttempts,
        retryClassification: status.retryClassification,
        nextRetryAt: status.nextRetryAt,
        startedAt: status.startedAt,
        completedAt: status.completedAt,
        failedAt: status.failedAt,
        deadLetteredAt: status.deadLetteredAt,
        ingestionRunId: status.ingestionRunId,
        runStatus: status.runStatus,
        profilesProcessed: status.profilesProcessed,
        contentProcessed: status.contentProcessed,
        interactionsProcessed: status.interactionsProcessed,
        cursorAfter: status.cursorAfter,
        error: status.safeError,
      },
    };
  }

  async retrySyncJob(jobId: string, userId: string) {
    const status = await getAuthorizedSocialSyncJobStatus({ userId, jobId });
    if (!status?.connectionId) throw new NotFoundException("Sync job not found.");
    if (!["FAILED", "DEAD_LETTERED", "CANCELLED"].includes(status.status)) {
      throw new BadRequestException("Only terminal sync jobs can be retried.");
    }
    const request = await createSocialConnectionSyncRequest({
      connectionId: status.connectionId,
      requestedByUserId: userId,
      reason: "RETRY",
      idempotencyKey: `manual-retry:${jobId}:${Date.now()}`,
    });
    await this.audit.record({
      actorUserId: userId,
      action: "social.connection.sync_retry_requested",
      entityType: "social_connection",
      entityId: status.connectionId,
      metadata: { previousJobId: jobId, jobId: request.jobId },
    });
    return {
      status: "accepted",
      jobId: request.jobId,
      connectionId: request.connectionId,
      jobStatus: request.status,
    };
  }
}
