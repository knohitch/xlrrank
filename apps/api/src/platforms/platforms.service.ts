import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  authorizeScope,
  createSocialConnectionSyncRequest,
  ensureOrganizationScope,
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
import type {
  CapabilityEvaluationInput,
  ConnectorCredentials,
  MetaAsset,
  NormalizedProfile,
  OAuthCapableConnector,
  ProviderApplicationConfig,
} from "@xlrrank/social-core";
import { AuditService } from "../audit/audit.service.js";
import {
  decryptSecret,
  encryptSecret,
  providerAppSecretAssociatedData,
  socialCredentialAssociatedData,
} from "../common/encryption.js";

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
  provider_metadata: Record<string, unknown> | null;
  next_sync_at: Date | null;
}

interface PlatformRow {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
}

interface ProviderAppConfigRow {
  id: string;
  platform_id: string;
  platform_slug: string;
  environment: string;
  client_id: string;
  client_secret_encrypted: string | null;
  redirect_uri: string;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
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
      nextSyncAt: account.next_sync_at,
      lastSyncAttemptAt: account.last_sync_attempt_at,
      displayName: stringFromMetadata(account.provider_metadata, "displayName"),
      grantedCapabilities: account.provider_metadata?.grantedCapabilities ?? {},
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
    const configured = await this.configuredPlatformIds();
    const connections = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1",
      [scope.scopeId],
    );

    return allPlatforms.map((p) => {
      const connector = connectorRegistry.getDefinition(p.slug);
      const account = connections.rows.find((a) => a.platform_id === p.id);
      const status = account?.status ?? "DISCONNECTED";
      const grantedScopes = stringArrayFromMetadata(account?.provider_metadata, "grantedScopes");
      return {
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        enabled: p.enabled,
        connected: this.isLiveConnected(status),
        status,
        lastSyncAt: account?.last_sync_at ?? null,
        nextSyncAt: account?.next_sync_at ?? null,
        capabilities: evaluateConnectorCapabilities({
          connector,
          configured: configured.has(p.id),
          metadata: account?.provider_metadata,
          grantedScopes,
        }),
        connection: this.toConnectionDto(account),
      };
    });
  }

  async getPlatform(platformId: string, userId: string) {
    this.ensureConnectors();
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const platform = await this.resolvePlatform(platformId);

    const accounts = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2",
      [scope.scopeId, platform.id],
    );
    const account = accounts.rows[0];
    const status = account?.status ?? "DISCONNECTED";
    const configured = await this.hasProviderAppConfig(platform.id);
    const grantedScopes = stringArrayFromMetadata(account?.provider_metadata, "grantedScopes");

    return {
      id: platform.id,
      slug: platform.slug,
      displayName: platform.displayName,
      enabled: platform.enabled,
      connected: this.isLiveConnected(status),
      status,
      lastSyncAt: account?.last_sync_at ?? null,
      nextSyncAt: account?.next_sync_at ?? null,
      capabilities: evaluateConnectorCapabilities({
        connector: connectorRegistry.getDefinition(platform.slug),
        configured,
        metadata: account?.provider_metadata,
        grantedScopes,
      }),
      connection: this.toConnectionDto(account),
    };
  }

  async connectPlatform(platformId: string, userId: string, credentials: ConnectorCredentials) {
    this.ensureConnectors();
    const db = getDb();
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
    if (hasOAuthAdapter(connector)) {
      throw new BadRequestException(
        "This platform uses OAuth. Start an OAuth authorization instead.",
      );
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

    const persistResult = await this.persistConnectedConnection({
      scopeId: scope.scopeId,
      platform,
      profile,
      credentials,
      providerMetadata: profile.metadata ?? {},
    });
    await connector.disconnect();

    await this.audit.record({
      actorUserId: userId,
      action: persistResult.existing
        ? "social.connection.credentials_replaced"
        : "social.connection.created",
      entityType: "social_connection",
      entityId: persistResult.connectionId,
      metadata: { platformId, scopeId: scope.scopeId },
    });

    return {
      status: "CONNECTED",
      message: persistResult.existing ? "Platform reconnected." : "Platform connected.",
      connectionId: persistResult.connectionId,
      externalAccountId: profile.externalId,
      handle: profile.handle,
    };
  }

  async startOAuth(
    platformId: string,
    userId: string,
    input: {
      scopeType?: "PERSONAL" | "ORGANIZATION";
      organizationId?: string;
      redirectTo?: string;
      requestedScopes?: string[];
    },
  ) {
    this.ensureConnectors();
    const platform = await this.resolvePlatform(platformId);
    if (!platform.enabled) throw new BadRequestException("This platform is disabled.");
    const connector = connectorRegistry.create(platform.slug);
    if (!connector || !hasOAuthAdapter(connector)) {
      throw new BadRequestException("This platform does not support OAuth authorization.");
    }
    const scope = await this.resolveRequestedScope(userId, input);
    const providerConfig = await this.loadProviderAppConfig(platform);
    const state = randomBytes(32).toString("base64url");
    const stateDigest = digest(state);
    const pkceVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = base64UrlSha256(pkceVerifier);
    const requestedScopes = this.normalizeScopes(
      input.requestedScopes,
      connector.getManifest().oauth?.defaultScopes ?? [],
    );
    const redirectTo = safeLocalRedirect(input.redirectTo ?? "/platforms");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await getPool().query(
      `
        INSERT INTO oauth_authorization_transactions (
          platform_id, scope_id, actor_user_id, state_digest, pkce_verifier,
          requested_scopes, redirect_to, expires_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
      `,
      [
        platform.id,
        scope.scopeId,
        userId,
        stateDigest,
        pkceVerifier,
        JSON.stringify(requestedScopes),
        redirectTo,
        expiresAt,
        JSON.stringify({ scopeType: scope.scopeType, organizationId: scope.organizationId }),
      ],
    );

    const authorizationUrl = connector
      .getOAuthAdapter()
      .buildAuthorizationUrl({
        providerConfig,
        state,
        codeChallenge,
        requestedScopes,
      })
      .toString();

    await this.audit.record({
      actorUserId: userId,
      action: "social.oauth.started",
      entityType: "platform",
      entityId: platform.id,
      metadata: { platformId: platform.id, platformSlug: platform.slug, scopeId: scope.scopeId },
    });

    return { authorizationUrl, expiresAt };
  }

  async handleOAuthCallback(
    platformId: string,
    userId: string,
    input: { state?: string; code?: string; error?: string; errorDescription?: string },
  ) {
    this.ensureConnectors();
    const platform = await this.resolvePlatform(platformId);
    const connector = connectorRegistry.create(platform.slug);
    if (!connector || !hasOAuthAdapter(connector)) {
      throw new BadRequestException("This platform does not support OAuth authorization.");
    }
    if (!input.state) throw new BadRequestException("OAuth state is required.");
    const transaction = await this.consumeOAuthTransaction({
      state: input.state,
      userId,
      platformId: platform.id,
    });
    if (input.error) {
      await this.audit.record({
        actorUserId: userId,
        action: "social.oauth.failed",
        entityType: "platform",
        entityId: platform.id,
        metadata: {
          platformId: platform.id,
          platformSlug: platform.slug,
          scopeId: transaction.scopeId,
          providerError: input.error,
        },
      });
      throw new BadRequestException("Provider authorization was denied or failed.");
    }
    if (!input.code) throw new BadRequestException("OAuth authorization code is required.");
    const providerConfig = await this.loadProviderAppConfig(platform);
    const tokenResult = await connector.getOAuthAdapter().exchangeAuthorizationCode({
      providerConfig,
      code: input.code,
      codeVerifier: transaction.pkceVerifier,
      redirectUri: providerConfig.redirectUri,
    });
    const credentials: ConnectorCredentials = {
      accessToken: tokenResult.accessToken,
      scopes: tokenResult.grantedScopes.length
        ? tokenResult.grantedScopes
        : transaction.requestedScopes,
      metadata: {},
    };
    if (tokenResult.refreshToken) credentials.refreshToken = tokenResult.refreshToken;
    if (tokenResult.expiresAt) credentials.expiresAt = tokenResult.expiresAt;
    if (tokenResult.tokenType) credentials.metadata!.tokenType = tokenResult.tokenType;
    if (typeof providerConfig.metadata?.environment === "string") {
      credentials.metadata!.providerConfigEnvironment = providerConfig.metadata.environment;
    }
    const profile = await connector.getOAuthAdapter().verifyIdentity(credentials, {
      scopeId: transaction.scopeId,
      connectionId: "oauth-verification",
      credentials,
    });
    credentials.metadata = {
      ...credentials.metadata,
      providerUserId: profile.externalId,
    };
    const capabilityInput: CapabilityEvaluationInput = { configured: true };
    if (credentials.scopes) capabilityInput.grantedScopes = credentials.scopes;
    const access = objectFromMetadata(providerConfig.metadata, "access");
    if (access) capabilityInput.access = access;
    const capabilities = connector.evaluateCapabilities?.(capabilityInput) ?? {};
    const persistResult = await this.persistConnectedConnection({
      scopeId: transaction.scopeId,
      platform,
      profile,
      credentials,
      providerMetadata: {
        displayName: profile.displayName,
        providerUserId: profile.externalId,
        grantedScopes: credentials.scopes ?? [],
        grantedCapabilities: capabilities,
        access: objectFromMetadata(providerConfig.metadata, "access") ?? {},
      },
    });
    if (hasMetaAssetLister(connector)) {
      await this.persistMetaAuthorizationSnapshot({
        scopeId: transaction.scopeId,
        platform,
        actorUserId: userId,
        connectionId: persistResult.connectionId,
        providerUserId: profile.externalId,
        credentials,
        providerConfig,
        assets: await connector.listAssets(credentials, {
          scopeId: transaction.scopeId,
          connectionId: persistResult.connectionId,
          credentials,
        }),
      });
    }
    const sync = await createSocialConnectionSyncRequest({
      connectionId: persistResult.connectionId,
      requestedByUserId: userId,
      reason: "MANUAL",
      idempotencyKey: `oauth-connected:${persistResult.connectionId}:${Date.now()}`,
    });
    await this.audit.record({
      actorUserId: userId,
      action: persistResult.existing ? "social.oauth.reauthorized" : "social.oauth.successful",
      entityType: "social_connection",
      entityId: persistResult.connectionId,
      metadata: {
        platformId: platform.id,
        platformSlug: platform.slug,
        scopeId: transaction.scopeId,
        jobId: sync.jobId,
      },
    });
    return {
      status: "CONNECTED",
      connectionId: persistResult.connectionId,
      handle: profile.handle,
      redirectTo: transaction.redirectTo,
      sync,
    };
  }

  async verifyMetaWebhookChallenge(
    platformId: string,
    input: { mode?: string | undefined; token?: string | undefined; challenge?: string | undefined },
  ) {
    const platform = await this.resolvePlatform(platformId);
    if (platform.slug !== "facebook" && platform.slug !== "instagram") {
      throw new BadRequestException("Meta webhooks are only available for Facebook and Instagram.");
    }
    const providerConfig = await this.loadProviderAppConfig(platform);
    const expected = metaWebhookVerifyToken(providerConfig);
    if (!expected) throw new BadRequestException("Meta webhook verify token is not configured.");
    if (input.mode !== "subscribe" || !input.challenge || input.token !== expected) {
      throw new ForbiddenException("Meta webhook verification failed.");
    }
    return input.challenge;
  }

  async receiveMetaWebhook(
    platformId: string,
    signature: string | undefined,
    payload: Record<string, unknown>,
    rawBody?: Buffer | string,
  ) {
    const platform = await this.resolvePlatform(platformId);
    if (platform.slug !== "facebook" && platform.slug !== "instagram") {
      throw new BadRequestException("Meta webhooks are only available for Facebook and Instagram.");
    }
    const providerConfig = await this.loadProviderAppConfig(platform);
    const secret = metaWebhookSigningSecret(providerConfig);
    if (!secret) throw new BadRequestException("Meta webhook signing secret is not configured.");
    const canonical = rawBody ?? JSON.stringify(payload);
    if (!verifyMetaWebhookSignature(canonical, signature, secret)) {
      throw new ForbiddenException("Meta webhook signature verification failed.");
    }
    const payloadJson = JSON.stringify(payload);
    const dedupeKey = metaWebhookDedupeKey(platform.slug, payload, payloadJson);
    const result = await getPool().query<{ id: string; inserted: boolean }>(
      `
        INSERT INTO webhook_receipts (
          provider_family, platform_id, object_id, dedupe_key, signature_valid,
          status, payload, metadata
        )
        VALUES ('meta', $1, $2, $3, true, 'RECEIVED', $4::jsonb, $5::jsonb)
        ON CONFLICT (provider_family, dedupe_key) DO UPDATE SET
          metadata = webhook_receipts.metadata || jsonb_build_object('duplicateSeenAt', now())
        RETURNING id, (xmax = 0) AS inserted
      `,
      [
        platform.id,
        typeof payload.object === "string" ? payload.object : null,
        dedupeKey,
        payloadJson,
        JSON.stringify({ platformSlug: platform.slug, signatureHeader: "x-hub-signature-256" }),
      ],
    );
    return { status: "received", receiptId: result.rows[0]?.id, duplicate: !result.rows[0]?.inserted };
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

  private async persistConnectedConnection(input: {
    scopeId: string;
    platform: PlatformRow;
    profile: NormalizedProfile;
    credentials: ConnectorCredentials;
    providerMetadata: Record<string, unknown>;
  }): Promise<{ connectionId: string; existing: boolean }> {
    const pool = getPool();
    const connectionResult = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2",
      [input.scopeId, input.platform.id],
    );
    const existing = connectionResult.rows[0];
    const connectionId = existing?.id ?? randomUUID();
    const credentialsEncrypted = encryptSecret(
      JSON.stringify(input.credentials),
      undefined,
      socialCredentialAssociatedData({
        connectionId,
        scopeId: input.scopeId,
        platformSlug: input.platform.slug,
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
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
          input.platform.id,
          input.profile.externalId,
          input.profile.handle,
          input.profile.displayName ?? null,
          input.profile.profileImageUrl ?? null,
          input.profile.bio ?? null,
          input.profile.location ?? null,
          input.profile.website ?? null,
          input.profile.followerCount ?? null,
          input.profile.followingCount ?? null,
          input.profile.visibility ?? "UNKNOWN",
          JSON.stringify(input.profile.metadata ?? {}),
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
        [externalAccountId, input.profile.handle],
      );

      await client.query(
        `
          INSERT INTO social_connections (
            id, scope_id, platform_id, external_account_id, status,
            credentials_encrypted, verified_external_id, verified_handle, provider_metadata
          )
          VALUES ($1, $2, $3, $4, 'CONNECTED', $5, $6, $7, $8::jsonb)
          ON CONFLICT (scope_id, platform_id) DO UPDATE SET
            external_account_id = EXCLUDED.external_account_id,
            status = 'CONNECTED',
            credentials_encrypted = EXCLUDED.credentials_encrypted,
            credential_version = social_connections.credential_version + 1,
            verified_external_id = EXCLUDED.verified_external_id,
            verified_handle = EXCLUDED.verified_handle,
            provider_metadata = EXCLUDED.provider_metadata,
            sync_error = NULL,
            disconnected_at = NULL,
            updated_at = now()
        `,
        [
          connectionId,
          input.scopeId,
          input.platform.id,
          externalAccountId,
          credentialsEncrypted,
          input.profile.externalId,
          input.profile.handle,
          JSON.stringify(input.providerMetadata),
        ],
      );
      await client.query("COMMIT");
      return { connectionId, existing: !!existing };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async persistMetaAuthorizationSnapshot(input: {
    scopeId: string;
    platform: PlatformRow;
    actorUserId: string;
    connectionId: string;
    providerUserId: string;
    credentials: ConnectorCredentials;
    providerConfig: ProviderApplicationConfig;
    assets: MetaAsset[];
  }): Promise<void> {
    const pool = getPool();
    const grantId = randomUUID();
    const encryptedGrant = encryptSecret(
      JSON.stringify(input.credentials),
      undefined,
      socialCredentialAssociatedData({
        connectionId: input.connectionId,
        scopeId: input.scopeId,
        platformSlug: input.platform.slug,
      }),
    );
    const grant = await pool.query<{ id: string }>(
      `
        INSERT INTO provider_authorizations (
          id, provider_family, scope_id, platform_id, actor_user_id,
          provider_user_id, status, credentials_encrypted, granted_scopes,
          expires_at, metadata
        )
        VALUES ($1, 'meta', $2, $3, $4, $5, 'ACTIVE', $6, $7::jsonb, $8, $9::jsonb)
        ON CONFLICT (scope_id, provider_family, provider_user_id) DO UPDATE SET
          platform_id = EXCLUDED.platform_id,
          actor_user_id = EXCLUDED.actor_user_id,
          status = 'ACTIVE',
          credentials_encrypted = EXCLUDED.credentials_encrypted,
          credential_version = provider_authorizations.credential_version + 1,
          granted_scopes = EXCLUDED.granted_scopes,
          expires_at = EXCLUDED.expires_at,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING id
      `,
      [
        grantId,
        input.scopeId,
        input.platform.id,
        input.actorUserId,
        input.providerUserId,
        encryptedGrant,
        JSON.stringify(input.credentials.scopes ?? []),
        input.credentials.expiresAt ? new Date(input.credentials.expiresAt) : null,
        JSON.stringify({ platformSlug: input.platform.slug, providerAppPlatformId: input.providerConfig.platformId }),
      ],
    );
    const providerAuthorizationId = grant.rows[0]?.id;
    if (!providerAuthorizationId) return;
    const platformIds = await this.platformIdsBySlug(["facebook", "instagram"]);
    for (const asset of input.assets) {
      const assetPlatformId = platformIds.get(asset.platformId);
      if (!assetPlatformId) continue;
      const assetCredentialsEncrypted = asset.accessToken
        ? encryptSecret(
            JSON.stringify({
              accessToken: asset.accessToken,
              scopes: input.credentials.scopes ?? [],
              metadata: {
                assetId: asset.assetId,
                parentAssetId: asset.parentAssetId,
                tokenKind: asset.tokenKind,
              },
            }),
            undefined,
            socialCredentialAssociatedData({
              connectionId: input.connectionId,
              scopeId: input.scopeId,
              platformSlug: asset.platformId,
            }),
          )
        : null;
      await pool.query(
        `
          INSERT INTO provider_authorization_assets (
            provider_authorization_id, platform_id, asset_type, provider_asset_id,
            parent_provider_asset_id, name, handle, token_kind,
            credentials_encrypted, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (provider_authorization_id, platform_id, provider_asset_id) DO UPDATE SET
            name = EXCLUDED.name,
            handle = EXCLUDED.handle,
            token_kind = EXCLUDED.token_kind,
            credentials_encrypted = EXCLUDED.credentials_encrypted,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        `,
        [
          providerAuthorizationId,
          assetPlatformId,
          asset.assetType,
          asset.assetId,
          asset.parentAssetId ?? null,
          asset.name,
          asset.handle ?? null,
          asset.tokenKind,
          assetCredentialsEncrypted,
          JSON.stringify(asset.metadata ?? {}),
        ],
      );
    }
  }

  private async platformIdsBySlug(slugs: string[]): Promise<Map<string, string>> {
    const result = await getPool().query<{ id: string; slug: string }>(
      "SELECT id, slug FROM platforms WHERE slug = ANY($1::text[])",
      [slugs],
    );
    return new Map(result.rows.map((row) => [row.slug, row.id]));
  }

  private async resolveRequestedScope(
    userId: string,
    input: { scopeType?: "PERSONAL" | "ORGANIZATION"; organizationId?: string },
  ) {
    if (input.scopeType === "ORGANIZATION") {
      if (!input.organizationId) {
        throw new BadRequestException("organizationId is required for organization scope.");
      }
      const scopeId = await ensureOrganizationScope(input.organizationId);
      const authorized = await authorizeScope(userId, scopeId, "MANAGE_SOCIAL_CONNECTIONS");
      if (!authorized) throw new ForbiddenException("Organization connection scope denied.");
      return authorized;
    }
    return ensurePersonalScope(userId);
  }

  private async resolvePlatform(slugOrId: string): Promise<PlatformRow> {
    const result = await getPool().query<{
      id: string;
      slug: string;
      display_name: string;
      enabled: boolean;
    }>(
      "SELECT id, slug, display_name, enabled FROM platforms WHERE id::text = $1 OR slug = $1 LIMIT 1",
      [slugOrId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Platform not found.");
    return { id: row.id, slug: row.slug, displayName: row.display_name, enabled: row.enabled };
  }

  private async configuredPlatformIds(): Promise<Set<string>> {
    const result = await getPool().query<{ platform_id: string }>(
      "SELECT platform_id FROM provider_app_configurations WHERE enabled = true",
    );
    return new Set(result.rows.map((row) => row.platform_id));
  }

  private async hasProviderAppConfig(platformId: string): Promise<boolean> {
    const result = await getPool().query(
      "SELECT 1 FROM provider_app_configurations WHERE platform_id = $1 AND enabled = true LIMIT 1",
      [platformId],
    );
    return result.rowCount === 1;
  }

  private async loadProviderAppConfig(platform: PlatformRow): Promise<ProviderApplicationConfig> {
    const environment = process.env.NODE_ENV || "development";
    const result = await getPool().query<ProviderAppConfigRow>(
      `
        SELECT pac.id, pac.platform_id, p.slug AS platform_slug, pac.environment,
               pac.client_id, pac.client_secret_encrypted, pac.redirect_uri,
               pac.enabled, pac.metadata
        FROM provider_app_configurations pac
        JOIN platforms p ON p.id = pac.platform_id
        WHERE pac.platform_id = $1 AND pac.environment = $2
        LIMIT 1
      `,
      [platform.id, environment],
    );
    const row = result.rows[0];
    if (!row || !row.enabled) {
      throw new BadRequestException("Provider application configuration is required.");
    }
    const clientSecret = row.client_secret_encrypted
      ? decryptSecret(
          row.client_secret_encrypted,
          undefined,
          providerAppSecretAssociatedData({
            providerConfigId: row.id,
            platformSlug: row.platform_slug,
            secretName: "clientSecret",
          }),
        )
      : undefined;
    const config: ProviderApplicationConfig = {
      platformId: row.platform_slug,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      enabled: row.enabled,
      metadata: { ...(row.metadata ?? {}), environment: row.environment },
    };
    if (clientSecret) config.clientSecret = clientSecret;
    return config;
  }

  private normalizeScopes(requested: string[] | undefined, defaults: string[]): string[] {
    const allowed = new Set(defaults);
    const source = requested && requested.length ? requested : defaults;
    const normalized = source.filter((scope) => allowed.has(scope));
    if (!normalized.includes("tweet.read")) normalized.push("tweet.read");
    if (!normalized.includes("users.read")) normalized.push("users.read");
    return [...new Set(normalized)];
  }

  private async consumeOAuthTransaction(input: {
    state: string;
    userId: string;
    platformId: string;
  }): Promise<{
    id: string;
    scopeId: string;
    pkceVerifier: string;
    requestedScopes: string[];
    redirectTo: string;
  }> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        platform_id: string;
        scope_id: string;
        actor_user_id: string;
        pkce_verifier: string;
        requested_scopes: unknown;
        redirect_to: string;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `
          SELECT id, platform_id, scope_id, actor_user_id, pkce_verifier,
                 requested_scopes, redirect_to, expires_at, used_at
          FROM oauth_authorization_transactions
          WHERE state_digest = $1
          LIMIT 1
          FOR UPDATE
        `,
        [digest(input.state)],
      );
      const row = result.rows[0];
      if (!row) throw new BadRequestException("OAuth state is invalid.");
      if (row.used_at) throw new BadRequestException("OAuth state was already used.");
      if (row.expires_at.getTime() <= Date.now()) {
        throw new BadRequestException("OAuth state has expired.");
      }
      if (row.actor_user_id !== input.userId || row.platform_id !== input.platformId) {
        throw new BadRequestException("OAuth state does not match this authorization attempt.");
      }
      const scope = await authorizeScope(input.userId, row.scope_id, "MANAGE_SOCIAL_CONNECTIONS");
      if (!scope) throw new ForbiddenException("Connection scope denied.");
      await client.query(
        "UPDATE oauth_authorization_transactions SET used_at = now() WHERE id = $1 AND used_at IS NULL",
        [row.id],
      );
      await client.query("COMMIT");
      return {
        id: row.id,
        scopeId: row.scope_id,
        pkceVerifier: row.pkce_verifier,
        requestedScopes: Array.isArray(row.requested_scopes)
          ? row.requested_scopes.filter((value): value is string => typeof value === "string")
          : [],
        redirectTo: row.redirect_to,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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

function hasOAuthAdapter(connector: unknown): connector is OAuthCapableConnector {
  return (
    !!connector &&
    typeof connector === "object" &&
    typeof (connector as { getOAuthAdapter?: unknown }).getOAuthAdapter === "function"
  );
}

function hasMetaAssetLister(
  connector: unknown,
): connector is OAuthCapableConnector & {
  listAssets: (
    credentials: ConnectorCredentials,
    context?: { scopeId: string; connectionId: string; credentials: ConnectorCredentials },
  ) => Promise<MetaAsset[]>;
} {
  return (
    hasOAuthAdapter(connector) &&
    typeof (connector as { listAssets?: unknown }).listAssets === "function"
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function safeLocalRedirect(raw: string): string {
  let decoded = raw;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new BadRequestException("OAuth redirect target must be application-local.");
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\\\") ||
    decoded.includes("://")
  ) {
    throw new BadRequestException("OAuth redirect target must be application-local.");
  }
  return decoded;
}

function stringArrayFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function metaWebhookVerifyToken(config: ProviderApplicationConfig): string | undefined {
  const token = config.metadata?.webhookVerifyToken;
  if (typeof token === "string" && token.length > 0) return token;
  return process.env.META_WEBHOOK_VERIFY_TOKEN;
}

function metaWebhookSigningSecret(config: ProviderApplicationConfig): string | undefined {
  const secret = config.metadata?.webhookAppSecret;
  if (typeof secret === "string" && secret.length > 0) return secret;
  return config.clientSecret ?? process.env.META_WEBHOOK_APP_SECRET;
}

function verifyMetaWebhookSignature(
  canonicalPayload: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(canonicalPayload).digest("hex"),
    "hex",
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function metaWebhookDedupeKey(
  platformSlug: string,
  payload: Record<string, unknown>,
  canonicalPayload: string,
): string {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const parts = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as { id?: unknown; time?: unknown; changes?: unknown };
    const changeFields = Array.isArray(record.changes)
      ? record.changes
          .map((change) =>
            change && typeof change === "object" && typeof (change as { field?: unknown }).field === "string"
              ? (change as { field: string }).field
              : undefined,
          )
          .filter(Boolean)
          .join(",")
      : "";
    return [`${String(record.id ?? "")}:${String(record.time ?? "")}:${changeFields}`];
  });
  const material = parts.length ? parts.join("|") : canonicalPayload;
  return `${platformSlug}:${createHash("sha256").update(material, "utf8").digest("base64url")}`;
}

function stringFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function evaluateConnectorCapabilities(input: {
  connector:
    | { manifest: { capabilities: Partial<Record<string, string>> }; create: () => unknown }
    | undefined;
  configured: boolean;
  metadata: Record<string, unknown> | null | undefined;
  grantedScopes: string[];
}) {
  if (!input.connector) return {};
  const instance = input.connector.create();
  if (
    instance &&
    typeof instance === "object" &&
    typeof (instance as { evaluateCapabilities?: unknown }).evaluateCapabilities === "function"
  ) {
    const access = objectFromMetadata(input.metadata, "access");
    const evaluation: CapabilityEvaluationInput = {
      configured: input.configured,
      grantedScopes: input.grantedScopes,
    };
    if (access) evaluation.access = access;
    return (
      instance as { evaluateCapabilities(input: CapabilityEvaluationInput): unknown }
    ).evaluateCapabilities(evaluation);
  }
  return input.connector.manifest.capabilities;
}
