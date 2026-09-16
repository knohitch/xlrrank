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
  createProviderAuthorizationCleanupRequestTx,
  createProviderSubscriptionCleanupRequestTx,
  createSocialConnectionSyncRequest,
  createSocialWebhookProcessRequest,
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
  NormalizedProfile,
  OAuthCapableConnector,
  OAuthProviderContract,
  ProviderApplicationConfig,
  ProviderAsset,
  SocialConnector,
} from "@xlrrank/social-core";
import {
  linkedInWebhookDedupeKey,
  verifyLinkedInWebhookChallenge,
  verifyLinkedInWebhookSignature,
} from "@xlrrank/social-core";
import type { ConnectorManifest } from "@xlrrank/shared";
import { AuditService } from "../audit/audit.service.js";
import {
  decryptSecret,
  encryptSecret,
  providerAuthorizationAssetAssociatedData,
  providerAuthorizationAssociatedData,
  providerAuthorizationCleanupAssociatedData,
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
  credentials_encrypted?: string | null;
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
    const configured = await this.configuredPlatformMetadata();
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
          metadata: account?.provider_metadata ?? configured.get(p.id),
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
    const configured = await this.providerAppConfigMetadata(platform.id);
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
        configured: !!configured,
        metadata: account?.provider_metadata ?? configured,
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
    const oauthContract = resolveOAuthContract(connector.getManifest().oauth, providerConfig);
    const state = randomBytes(32).toString("base64url");
    const stateDigest = digest(state);
    const pkceVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = base64UrlSha256(pkceVerifier);
    const requestedScopes = this.normalizeScopes(
      input.requestedScopes,
      connector.resolveOAuthDefaultScopes?.(oauthContract.defaultScopes, providerConfig) ??
        oauthContract.defaultScopes,
      platform.slug,
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
        JSON.stringify({
          scopeType: scope.scopeType,
          organizationId: scope.organizationId,
          authMode: oauthContract.id,
        }),
      ],
    );

    const authorizationUrl = connector
      .getOAuthAdapter()
      .buildAuthorizationUrl({
        providerConfig,
        contract: oauthContract,
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
    const callbackProviderConfig = providerConfigWithAuthMode(providerConfig, transaction.authMode);
    const oauthContract = resolveOAuthContract(connector.getManifest().oauth, callbackProviderConfig);
    const tokenResult = await connector.getOAuthAdapter().exchangeAuthorizationCode({
      providerConfig: callbackProviderConfig,
      contract: oauthContract,
      code: input.code,
      codeVerifier: transaction.pkceVerifier,
      redirectUri: callbackProviderConfig.redirectUri,
      requestedScopes: transaction.requestedScopes,
    });
    const credentials: ConnectorCredentials = {
      accessToken: tokenResult.accessToken,
      scopes: tokenResult.grantedScopes.length
        ? tokenResult.grantedScopes
        : transaction.requestedScopes,
      metadata: { ...(tokenResult.rawProviderMetadata ?? {}) },
    };
    if (tokenResult.refreshToken) credentials.refreshToken = tokenResult.refreshToken;
    if (tokenResult.expiresAt) credentials.expiresAt = tokenResult.expiresAt;
    if (tokenResult.tokenType) credentials.metadata!.tokenType = tokenResult.tokenType;
    if (typeof callbackProviderConfig.metadata?.environment === "string") {
      credentials.metadata!.providerConfigEnvironment = callbackProviderConfig.metadata.environment;
    }
    if (typeof callbackProviderConfig.metadata?.authMode === "string") {
      credentials.metadata!.authMode = callbackProviderConfig.metadata.authMode;
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
    if (typeof credentials.metadata?.authMode === "string") capabilityInput.authMode = credentials.metadata.authMode;
    const access = objectFromMetadata(callbackProviderConfig.metadata, "access");
    if (access) capabilityInput.access = access;
    const capabilities = connector.evaluateCapabilities?.(capabilityInput) ?? {};
    if (!hasAssetLister(connector) && capabilities.profiles !== "AVAILABLE") {
      await this.audit.record({
        actorUserId: userId,
        action: "social.oauth.access_not_ready",
        entityType: "platform",
        entityId: platform.id,
        metadata: {
          platformId: platform.id,
          platformSlug: platform.slug,
          scopeId: transaction.scopeId,
          capabilities,
        },
      });
      throw new BadRequestException("Provider authorization is not ready for production access.");
    }
    if (hasAssetLister(connector)) {
      const snapshot = await this.persistMetaAuthorizationSnapshot({
        scopeId: transaction.scopeId,
        platform,
        actorUserId: userId,
        providerUserId: profile.externalId,
        credentials,
        providerConfig: callbackProviderConfig,
        assets: await connector.listAuthorizationAssets(credentials, {
          scopeId: transaction.scopeId,
          connectionId: "meta-asset-discovery",
          credentials,
        }),
      });
      await this.audit.record({
        actorUserId: userId,
        action: "social.oauth.asset_authorization_ready",
        entityType: "provider_authorization",
        entityId: snapshot.authorizationId,
        metadata: {
          platformId: platform.id,
          platformSlug: platform.slug,
          scopeId: transaction.scopeId,
          assetCount: snapshot.assets.length,
        },
      });
      return {
        status: "ASSET_SELECTION_REQUIRED",
        authorizationId: snapshot.authorizationId,
        assets: snapshot.assets,
        handle: profile.handle,
        redirectTo: `${transaction.redirectTo}${transaction.redirectTo.includes("?") ? "&" : "?"}authorizationId=${snapshot.authorizationId}`,
      };
    }
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
        access: objectFromMetadata(callbackProviderConfig.metadata, "access") ?? {},
      },
    });
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
    const receiptId = result.rows[0]?.id;
    const inserted = result.rows[0]?.inserted === true;
    const job = receiptId && inserted ? await createSocialWebhookProcessRequest({ receiptId }) : null;
    return { status: "received", receiptId, duplicate: !inserted, job };
  }

  async verifyLinkedInWebhookChallenge(
    platformId: string,
    input: { challengeCode?: string | undefined },
  ) {
    const platform = await this.resolvePlatform(platformId);
    if (platform.slug !== "linkedin") {
      throw new BadRequestException("LinkedIn webhooks are only available for LinkedIn.");
    }
    if (!input.challengeCode) {
      throw new BadRequestException("Missing challengeCode for LinkedIn webhook challenge.");
    }
    const providerConfig = await this.loadProviderAppConfig(platform);
    const secret = providerConfig.clientSecret;
    if (!secret) {
      throw new BadRequestException("LinkedIn clientSecret is not configured.");
    }
    return verifyLinkedInWebhookChallenge(input.challengeCode, secret);
  }

  async receiveLinkedInWebhook(
    platformId: string,
    signature: string | undefined,
    payload: Record<string, unknown>,
    rawBody?: Buffer | string,
  ) {
    const platform = await this.resolvePlatform(platformId);
    if (platform.slug !== "linkedin") {
      throw new BadRequestException("LinkedIn webhooks are only available for LinkedIn.");
    }
    const providerConfig = await this.loadProviderAppConfig(platform);
    const secret = providerConfig.clientSecret;
    if (!secret) {
      throw new BadRequestException("LinkedIn clientSecret is not configured.");
    }
    if (rawBody === undefined || rawBody === null) {
      throw new BadRequestException("LinkedIn webhook raw body is required for signature verification.");
    }
    if (!verifyLinkedInWebhookSignature(rawBody, signature, secret)) {
      throw new ForbiddenException("LinkedIn webhook signature verification failed.");
    }
    const minimalPayload = minimalLinkedInWebhookPayload(payload);
    const rawJson = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const logicalPayloads = linkedInLogicalWebhookPayloads(minimalPayload, rawJson);
    const receipts: Array<{ receiptId: string; notificationId: string | null; duplicate: boolean; job: unknown }> = [];
    for (const logical of logicalPayloads) {
      const result = await getPool().query<{ id: string; inserted: boolean }>(
        `
          INSERT INTO webhook_receipts (
            provider_family, platform_id, object_id, dedupe_key, signature_valid,
            status, payload, provider_data_category, metadata
          )
          VALUES ('linkedin', $1, $2, $3, true, 'RECEIVED', $4::jsonb, 'webhook_operational_receipt', $5::jsonb)
          ON CONFLICT (provider_family, dedupe_key) DO UPDATE SET
            metadata = webhook_receipts.metadata || jsonb_build_object('duplicateSeenAt', now())
          RETURNING id, (xmax = 0) AS inserted
        `,
        [
          platform.id,
          logical.notificationId,
          logical.dedupeKey,
          JSON.stringify(logical.payload),
          JSON.stringify({
            platformSlug: platform.slug,
            signatureHeader: "x-li-signature",
            providerDataCategory: "webhook_operational_receipt",
            retentionBasis: "XLRRANK_OPERATIONAL_RETENTION",
            notificationId: logical.notificationId,
            dedupeFallback: logical.dedupeFallback,
          }),
        ],
      );
      const receiptId = result.rows[0]?.id;
      const inserted = result.rows[0]?.inserted === true;
      const job = receiptId && inserted ? await createSocialWebhookProcessRequest({ receiptId }) : null;
      if (receiptId) receipts.push({ receiptId, notificationId: logical.notificationId, duplicate: !inserted, job });
    }
    return {
      status: "received",
      receiptId: receipts[0]?.receiptId,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
      duplicate: receipts.length > 0 && receipts.every((receipt) => receipt.duplicate),
      acceptedCount: receipts.filter((receipt) => !receipt.duplicate).length,
      duplicateCount: receipts.filter((receipt) => receipt.duplicate).length,
      receipts,
      job: receipts.find((receipt) => receipt.job)?.job ?? null,
    };
  }

  async listAuthorizationAssets(authorizationId: string, userId: string) {
    if (!isUuid(authorizationId)) throw new NotFoundException("Provider authorization not found.");
    const auth = await this.loadAuthorizedProviderAuthorization(authorizationId, userId);
    const result = await getPool().query<{
      id: string;
      platform_id: string;
      platform_slug: string;
      asset_type: string;
      provider_asset_id: string;
      parent_provider_asset_id: string | null;
      name: string | null;
      handle: string | null;
      token_kind: string;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT paa.id, paa.platform_id, p.slug AS platform_slug, paa.asset_type,
               paa.provider_asset_id, paa.parent_provider_asset_id, paa.name,
               paa.handle, paa.token_kind, paa.metadata
        FROM provider_authorization_assets paa
        JOIN platforms p ON p.id = paa.platform_id
        WHERE paa.provider_authorization_id = $1
        ORDER BY p.slug, paa.name NULLS LAST, paa.provider_asset_id
      `,
      [auth.id],
    );
    return {
      authorizationId: auth.id,
      providerFamily: auth.provider_family,
      scopeId: auth.scope_id,
      assets: result.rows.map((row) => ({
        id: row.id,
        platformId: row.platform_id,
        platformSlug: row.platform_slug,
        assetType: row.asset_type,
        providerAssetId: row.provider_asset_id,
        parentProviderAssetId: row.parent_provider_asset_id,
        name: row.name,
        handle: row.handle,
        tokenKind: row.token_kind,
        metadata: row.metadata ?? {},
      })),
    };
  }

  async connectAuthorizationAsset(authorizationId: string, assetId: string, userId: string) {
    if (!isUuid(authorizationId) || !isUuid(assetId)) {
      throw new NotFoundException("Authorization asset not found.");
    }
    this.ensureConnectors();
    const auth = await this.loadAuthorizedProviderAuthorization(authorizationId, userId);
    const result = await getPool().query<{
      id: string;
      platform_id: string;
      platform_slug: string;
      asset_type: string;
      provider_asset_id: string;
      parent_provider_asset_id: string | null;
      name: string | null;
      handle: string | null;
      token_kind: string;
      credentials_encrypted: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT paa.id, paa.platform_id, p.slug AS platform_slug, paa.asset_type,
               paa.provider_asset_id, paa.parent_provider_asset_id, paa.name,
               paa.handle, paa.token_kind, paa.credentials_encrypted, paa.metadata
        FROM provider_authorization_assets paa
        JOIN platforms p ON p.id = paa.platform_id
        WHERE paa.provider_authorization_id = $1 AND paa.id = $2
        LIMIT 1
      `,
      [auth.id, assetId],
    );
    const asset = result.rows[0];
    if (!asset) throw new NotFoundException("Authorization asset not found.");
    const connector = connectorRegistry.create(asset.platform_slug);
    if (!connector) throw new BadRequestException("No connector implementation is registered for this asset platform.");
    if (!asset.credentials_encrypted) throw new BadRequestException("Authorization asset has no usable credential.");
    const credentials = JSON.parse(
      decryptSecret(
        asset.credentials_encrypted,
        undefined,
        providerAuthorizationAssetAssociatedData({
          authorizationAssetId: asset.id,
          authorizationId: auth.id,
          scopeId: auth.scope_id,
          platformSlug: asset.platform_slug,
          providerAssetId: asset.provider_asset_id,
        }),
      ),
    ) as ConnectorCredentials;
    credentials.metadata = {
      ...(credentials.metadata ?? {}),
      assetId: asset.provider_asset_id,
      providerAuthorizationId: auth.id,
      providerAuthorizationAssetId: asset.id,
      tokenKind: asset.token_kind,
      providerUserId: auth.provider_user_id,
    };
    const platform = {
      id: asset.platform_id,
      slug: asset.platform_slug,
      displayName: asset.platform_slug,
      enabled: true,
    };
    const profile = await connector.getProfile(asset.provider_asset_id, {
      scopeId: auth.scope_id,
      connectionId: "authorization-asset-selection",
      credentials,
    });
    if (!profile) throw new BadRequestException("Provider asset profile could not be verified.");
    const roles = stringArrayFromMetadata(asset.metadata, "roles");
    const access = objectFromMetadata(auth.metadata, "access") ?? {};
    const capabilities = connector.evaluateCapabilities?.({
      configured: true,
      grantedScopes: credentials.scopes ?? [],
      authMode: typeof credentials.metadata?.authMode === "string" ? credentials.metadata.authMode : undefined,
      access: {
        ...access,
        organizationRole: roles[0],
      },
    }) ?? {};
    const persistResult = await this.persistConnectedConnection({
      scopeId: auth.scope_id,
      platform,
      profile,
      credentials,
      providerMetadata: {
        displayName: profile.displayName,
        providerUserId: auth.provider_user_id,
        providerAuthorizationId: auth.id,
        providerAuthorizationAssetId: asset.id,
        providerAssetId: asset.provider_asset_id,
        parentProviderAssetId: asset.parent_provider_asset_id,
        assetType: asset.asset_type,
        access,
        roles,
        authMode: typeof credentials.metadata?.authMode === "string" ? credentials.metadata.authMode : undefined,
        grantedScopes: credentials.scopes ?? [],
        grantedCapabilities: capabilities,
      },
    });
    await this.syncProviderEventSubscription({
      connector,
      auth,
      asset,
      connectionId: persistResult.connectionId,
      credentials,
      access,
      roles,
    });
    await this.audit.record({
      actorUserId: userId,
      action: persistResult.existing
        ? "social.authorization_asset.connection_reused"
        : "social.authorization_asset.connected",
      entityType: "social_connection",
      entityId: persistResult.connectionId,
      metadata: {
        providerAuthorizationId: auth.id,
        providerAuthorizationAssetId: asset.id,
        scopeId: auth.scope_id,
        platformId: asset.platform_id,
      },
    });
    return {
      status: "CONNECTED",
      duplicate: persistResult.existing,
      connectionId: persistResult.connectionId,
      platformId: asset.platform_id,
      platformSlug: asset.platform_slug,
      externalAccountId: profile.externalId,
      handle: profile.handle,
    };
  }

  async disconnectPlatform(platformId: string, userId: string) {
    const pool = getPool();
    const scope = await ensurePersonalScope(userId);
    const accounts = await pool.query<ConnectionRow>(
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2 ORDER BY created_at ASC",
      [scope.scopeId, platformId],
    );

    const account = accounts.rows[0];
    if (!account) throw new NotFoundException("No connection found for this platform.");
    if (account.scope_id !== scope.scopeId)
      throw new ForbiddenException("Connection scope denied.");

    return this.disconnectConnection(account.id, userId);
  }

  async disconnectConnection(connectionId: string, userId: string) {
    if (!isUuid(connectionId)) throw new NotFoundException("Connection not found.");
    const scope = await authorizeConnection(userId, connectionId, "MANAGE_SOCIAL_CONNECTIONS");
    if (!scope) throw new NotFoundException("Connection not found.");
    const pool = getPool();
    const connection = (
      await pool.query<ConnectionRow & { platform_slug: string; provider_family?: string }>(
        `
          SELECT sc.*, p.slug AS platform_slug, COALESCE(p.provider_family, p.slug) AS provider_family
          FROM social_connections sc
          JOIN platforms p ON p.id = sc.platform_id
          WHERE sc.id = $1
          LIMIT 1
        `,
        [connectionId],
      )
    ).rows[0];
    if (!connection || connection.scope_id !== scope.scopeId) {
      throw new NotFoundException("Connection not found.");
    }
    const providerCleanup = await this.markConnectionLocallyDisconnected({
      connection,
      scopeId: scope.scopeId,
    });
    await this.audit.record({
      actorUserId: userId,
      action: "social.connection.disconnected",
      entityType: "social_connection",
      entityId: connection.id,
      metadata: { platformId: connection.platform_id, scopeId: scope.scopeId, providerCleanup },
    });
    return {
      status: "DISCONNECTED",
      connectionId: connection.id,
      providerCleanup,
      message: "Connection disconnected.",
    };
  }

  private async markConnectionLocallyDisconnected(input: {
    connection: ConnectionRow & { platform_slug: string; provider_family?: string };
    scopeId: string;
  }): Promise<Record<string, unknown>> {
    const pool = getPool();
    const connection = input.connection;
    const providerFamily = connection.provider_family ?? connection.platform_slug;

    // Check if another active connection in the same scope shares this verified_external_id
    let siblingActive = false;
    if (connection.verified_external_id) {
      const siblingCheck = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM social_connections
          WHERE scope_id = $1
            AND platform_id = $2
            AND verified_external_id = $3
            AND id <> $4
            AND status = 'CONNECTED'
          LIMIT 1
        `,
        [input.scopeId, connection.platform_id, connection.verified_external_id, connection.id],
      );
      siblingActive = (siblingCheck.rowCount ?? 0) > 0;
    }

    let immediateRevoked = false;
    let plaintextCredentials: string | null = null;
    let parsedCredentials: ConnectorCredentials | null = null;

    if (!siblingActive && connection.credentials_encrypted) {
      try {
        plaintextCredentials = decryptSecret(
          connection.credentials_encrypted,
          undefined,
          socialCredentialAssociatedData({
            connectionId: connection.id,
            scopeId: input.scopeId,
            platformSlug: connection.platform_slug,
          }),
        );
        parsedCredentials = JSON.parse(plaintextCredentials) as ConnectorCredentials;
      } catch {
        plaintextCredentials = null;
      }
    }

    if (!siblingActive && parsedCredentials) {
      this.ensureConnectors();
      const connector = connectorRegistry.create(connection.platform_slug);
      const oauth = (connector as OAuthCapableConnector | undefined)?.getOAuthAdapter?.();
      if (typeof oauth?.revoke === "function") {
        try {
          const providerConfig = await this.loadProviderAppConfig({
            id: connection.platform_id,
            slug: connection.platform_slug,
          } as PlatformRow);
          const revokeResult = await oauth.revoke(
            parsedCredentials,
            providerConfig,
            AbortSignal.timeout(1500),
          );
          if (revokeResult?.providerRevoked) {
            immediateRevoked = true;
          }
        } catch {
          immediateRevoked = false;
        }
      }
    }

    const client = await pool.connect();
    const subscriptionIds: string[] = [];
    let cleanupJobId: string | null = null;

    try {
      await client.query("BEGIN");

      if (!siblingActive && !immediateRevoked && plaintextCredentials) {
        this.ensureConnectors();
        const connector = connectorRegistry.create(connection.platform_slug);
        const oauth = (connector as OAuthCapableConnector | undefined)?.getOAuthAdapter?.();
        if (typeof oauth?.revoke === "function") {
          const cleanupId = randomUUID();
          const cleanupEncrypted = encryptSecret(
            plaintextCredentials,
            undefined,
            providerAuthorizationCleanupAssociatedData({
              cleanupId,
              scopeId: input.scopeId,
              platformSlug: connection.platform_slug,
            }),
          );
          const cleanupJob = await createProviderAuthorizationCleanupRequestTx(client, {
            id: cleanupId,
            connectionId: connection.id,
            scopeId: input.scopeId,
            platformId: connection.platform_id,
            providerFamily,
            credentialsEncrypted: cleanupEncrypted,
            metadata: {
              connectionId: connection.id,
              platformSlug: connection.platform_slug,
              verifiedExternalId: connection.verified_external_id,
            },
          });
          cleanupJobId = cleanupJob.jobId;
        }
      }

      await client.query(
        `
          UPDATE social_connections
          SET status = 'DISCONNECTED',
              sync_enabled = false,
              next_sync_at = NULL,
              credentials_encrypted = NULL,
              disabled_at = NULL,
              disconnected_at = now(),
              updated_at = now()
          WHERE id = $1 AND scope_id = $2
        `,
        [connection.id, input.scopeId],
      );

      const subscriptions = await client.query<{ id: string; provider_status: string }>(
        `
          UPDATE provider_event_subscriptions
          SET provider_status = CASE
                WHEN provider_status IN ('PROVIDER_DELETED', 'PROVIDER_ALREADY_ABSENT', 'PROVIDER_DELETE_TERMINAL')
                  THEN provider_status
                ELSE 'PENDING_PROVIDER_DELETE'
              END,
              deactivated_at = COALESCE(deactivated_at, now()),
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'disconnectCleanupStatus',
                CASE
                  WHEN provider_status IN ('PROVIDER_DELETED', 'PROVIDER_ALREADY_ABSENT', 'PROVIDER_DELETE_TERMINAL')
                    THEN provider_status
                  ELSE 'PENDING_PROVIDER_DELETE'
                END
              ),
              updated_at = now()
          WHERE social_connection_id = $1
          RETURNING id, provider_status
        `,
        [connection.id],
      );

      subscriptionIds.push(
        ...subscriptions.rows
          .filter((row) => row.provider_status === "PENDING_PROVIDER_DELETE")
          .map((row) => row.id),
      );

      const cleanupJobIds: string[] = [];
      for (const subscriptionId of subscriptionIds) {
        const cleanupJob = await createProviderSubscriptionCleanupRequestTx(client, { subscriptionId });
        cleanupJobIds.push(cleanupJob.jobId);
      }

      await client.query("COMMIT");

      if (siblingActive) {
        return { status: "SIBLING_ACTIVE", providerRevoked: false };
      }
      if (immediateRevoked) {
        return { status: "REVOKED", providerRevoked: true };
      }
      if (cleanupJobId) {
        return {
          status: "PENDING_PROVIDER_REVOCATION",
          cleanupJobId,
          providerRevoked: false,
        };
      }
      return subscriptionIds.length
        ? {
            status: "PENDING_PROVIDER_DELETE",
            subscriptionIds,
            cleanupJobIds,
          }
        : { status: "NO_SUBSCRIPTION" };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
      "SELECT * FROM social_connections WHERE scope_id = $1 AND platform_id = $2 AND verified_external_id = $3",
      [input.scopeId, input.platform.id, input.profile.externalId],
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
            following_count, visibility, provider_data_category, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          ON CONFLICT (platform_id, external_id) DO UPDATE SET
            current_handle = EXCLUDED.current_handle,
            display_name = EXCLUDED.display_name,
            profile_image_url = EXCLUDED.profile_image_url,
            bio = EXCLUDED.bio,
            location = EXCLUDED.location,
            website = EXCLUDED.website,
            follower_count = EXCLUDED.follower_count,
            following_count = EXCLUDED.following_count,
            provider_data_category = COALESCE(EXCLUDED.provider_data_category, social_external_accounts.provider_data_category),
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
          providerDataCategoryFromProfile(input.profile),
          JSON.stringify(input.profile.metadata ?? {}),
        ],
      );
      const externalAccountId = accountResult.rows[0]?.id;
      if (!externalAccountId) throw new Error("Failed to persist canonical social account");

      await client.query(
        `
          INSERT INTO social_account_handles (
            external_account_id, handle, provider_data_category, provider_retention_basis
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (external_account_id, handle)
          DO UPDATE SET
            provider_data_category = COALESCE(EXCLUDED.provider_data_category, social_account_handles.provider_data_category),
            provider_retention_basis = COALESCE(EXCLUDED.provider_retention_basis, social_account_handles.provider_retention_basis),
            last_seen_at = now()
        `,
        [
          externalAccountId,
          input.profile.handle,
          providerDataCategoryFromProfile(input.profile),
          stringFromMetadata(input.profile.metadata, "providerRetentionBasis"),
        ],
      );

      await client.query(
        `
          INSERT INTO social_connections (
            id, scope_id, platform_id, external_account_id, status,
            credentials_encrypted, verified_external_id, verified_handle, provider_metadata
          )
          VALUES ($1, $2, $3, $4, 'CONNECTED', $5, $6, $7, $8::jsonb)
          ON CONFLICT (scope_id, platform_id, verified_external_id) DO UPDATE SET
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
      await client.query(
        `
          INSERT INTO social_account_observations (
            scope_id, connection_id, external_account_id, visibility, observed_at,
            provider_created_at, provider_data_category, normalization_version, adapter_version, metadata
          )
          VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9::jsonb)
          ON CONFLICT (scope_id, external_account_id) DO UPDATE SET
            connection_id = EXCLUDED.connection_id,
            visibility = EXCLUDED.visibility,
            observed_at = now(),
            provider_created_at = EXCLUDED.provider_created_at,
            provider_data_category = EXCLUDED.provider_data_category,
            normalization_version = EXCLUDED.normalization_version,
            adapter_version = EXCLUDED.adapter_version,
            metadata = EXCLUDED.metadata
        `,
        [
          input.scopeId,
          connectionId,
          externalAccountId,
          input.profile.visibility ?? "UNKNOWN",
          input.profile.providerCreatedAt ?? null,
          providerDataCategoryFromProfile(input.profile),
          input.profile.provenance?.normalizationVersion ?? "api-connection-profile",
          input.profile.provenance?.adapterVersion ?? input.platform.slug,
          JSON.stringify({
            ...(input.profile.metadata ?? {}),
            providerProfilePersistedBy: "connection_create",
          }),
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
    providerUserId: string;
    credentials: ConnectorCredentials;
    providerConfig: ProviderApplicationConfig;
    assets: ProviderAsset[];
  }): Promise<{ authorizationId: string; assets: Array<Record<string, unknown>> }> {
    const pool = getPool();
    const connector = connectorRegistry.create(input.platform.slug);
    const providerFamily = connectorProviderFamily(connector, input.platform.slug);
    const existingGrant = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM provider_authorizations
        WHERE scope_id = $1 AND provider_family = $2 AND provider_user_id = $3
        LIMIT 1
      `,
      [input.scopeId, providerFamily, input.providerUserId],
    );
    const grantId = existingGrant.rows[0]?.id ?? randomUUID();
    const encryptedGrant = encryptSecret(
      JSON.stringify(input.credentials),
      undefined,
      providerAuthorizationAssociatedData({
        authorizationId: grantId,
        scopeId: input.scopeId,
        providerFamily,
      }),
    );
    const providerAccess = objectFromMetadata(input.providerConfig.metadata, "access") ?? {};
    const grant = await pool.query<{ id: string }>(
      `
        INSERT INTO provider_authorizations (
          id, provider_family, scope_id, platform_id, actor_user_id,
          provider_user_id, status, credentials_encrypted, granted_scopes,
          expires_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8::jsonb, $9, $10::jsonb)
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
        providerFamily,
        input.scopeId,
        input.platform.id,
        input.actorUserId,
        input.providerUserId,
        encryptedGrant,
        JSON.stringify(input.credentials.scopes ?? []),
        input.credentials.expiresAt ? new Date(input.credentials.expiresAt) : null,
        JSON.stringify({
          platformSlug: input.platform.slug,
          providerAppPlatformId: input.providerConfig.platformId,
          access: providerAccess,
        }),
      ],
    );
    const providerAuthorizationId = grant.rows[0]?.id;
    if (!providerAuthorizationId) throw new Error("Failed to persist provider authorization");
    const platformIds = await this.platformIdsBySlug([
      ...new Set([input.platform.slug, ...input.assets.map((asset) => asset.platformId)]),
    ]);
    const persistedAssets: Array<Record<string, unknown>> = [];
    for (const asset of input.assets) {
      const assetPlatformId = platformIds.get(asset.platformId) ?? input.platform.id;
      if (!assetPlatformId) continue;
      const existingAsset = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM provider_authorization_assets
          WHERE provider_authorization_id = $1 AND platform_id = $2 AND provider_asset_id = $3
          LIMIT 1
        `,
        [providerAuthorizationId, assetPlatformId, asset.assetId],
      );
      const assetRecordId = existingAsset.rows[0]?.id ?? randomUUID();
      const assetCredentialsEncrypted = asset.accessToken
        ? encryptSecret(
            JSON.stringify({
              accessToken: asset.accessToken,
              scopes: input.credentials.scopes ?? [],
              metadata: {
                assetId: asset.assetId,
                parentAssetId: asset.parentAssetId,
                tokenKind: asset.tokenKind,
                providerUserId: input.providerUserId,
                access: providerAccess,
                ...(asset.credentialMetadata ?? {}),
              },
            }),
            undefined,
            providerAuthorizationAssetAssociatedData({
              authorizationAssetId: assetRecordId,
              authorizationId: providerAuthorizationId,
              scopeId: input.scopeId,
              platformSlug: asset.platformId,
              providerAssetId: asset.assetId,
            }),
          )
        : null;
      const assetResult = await pool.query<{ id: string }>(
        `
          INSERT INTO provider_authorization_assets (
            id, provider_authorization_id, platform_id, asset_type, provider_asset_id,
            parent_provider_asset_id, name, handle, token_kind,
            credentials_encrypted, provider_data_category, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          ON CONFLICT (provider_authorization_id, platform_id, provider_asset_id) DO UPDATE SET
            name = EXCLUDED.name,
            handle = EXCLUDED.handle,
            token_kind = EXCLUDED.token_kind,
            credentials_encrypted = EXCLUDED.credentials_encrypted,
            provider_data_category = EXCLUDED.provider_data_category,
            metadata = EXCLUDED.metadata,
            updated_at = now()
          RETURNING id
        `,
        [
          assetRecordId,
          providerAuthorizationId,
          assetPlatformId,
          asset.assetType,
          asset.assetId,
          asset.parentAssetId ?? null,
          asset.name,
          asset.handle ?? null,
          asset.tokenKind,
          assetCredentialsEncrypted,
          providerDataCategoryFromMetadata(asset.metadata),
          JSON.stringify({
            ...(asset.metadata ?? {}),
            access: providerAccess,
            ...(Array.isArray(asset.metadata?.roles) && !asset.metadata?.roleObservedAt
              ? {
                  roleObservedAt: new Date().toISOString(),
                  roleProviderDataCategory: "organization_admin_reporting",
                }
              : {}),
          }),
        ],
      );
      const id = assetResult.rows[0]?.id ?? assetRecordId;
      persistedAssets.push({
        id,
        platformId: assetPlatformId,
        platformSlug: asset.platformId,
        assetType: asset.assetType,
        providerAssetId: asset.assetId,
        parentProviderAssetId: asset.parentAssetId ?? null,
        name: asset.name,
        handle: asset.handle ?? null,
      });
    }
    return { authorizationId: providerAuthorizationId, assets: persistedAssets };
  }

  private async syncProviderEventSubscription(input: {
    connector: SocialConnector;
    auth: {
      id: string;
      provider_family: string;
      scope_id: string;
      provider_user_id: string;
      metadata: Record<string, unknown> | null;
    };
    asset: {
      id: string;
      platform_id: string;
      platform_slug: string;
      provider_asset_id: string;
      metadata: Record<string, unknown> | null;
    };
    connectionId: string;
    credentials: ConnectorCredentials;
    access: Record<string, unknown>;
    roles: string[];
  }): Promise<void> {
    const method = input.connector.upsertProviderEventSubscription;
    if (typeof method !== "function") return;

    const webhookUrl = stringFromMetadata(input.access, "webhookUrl");
    const eventType = stringFromMetadata(input.access, "eventType");
    const result = await method.call(
      input.connector,
      {
        providerFamily: input.auth.provider_family,
        providerUserId: input.auth.provider_user_id,
        providerAssetId: input.asset.provider_asset_id,
        assetMetadata: input.asset.metadata,
        authorizationMetadata: input.auth.metadata,
        access: input.access,
        roles: input.roles,
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(eventType ? { eventType } : {}),
      },
      {
        scopeId: input.auth.scope_id,
        connectionId: input.connectionId,
        credentials: input.credentials,
      },
    );
    if (!result) return;

    if (result.providerStatus === "ACCESS_LOST") {
      await getPool().query(
        `
          UPDATE social_connections
          SET status = 'DEGRADED',
              sync_error = $2::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [
          input.connectionId,
          JSON.stringify({ code: "PROVIDER_EVENT_SUBSCRIPTION_ACCESS_LOST", eventType: result.eventType }),
        ],
      );
    }

    await this.upsertProviderEventSubscriptionRecord({
      ...input,
      providerStatus: result.providerStatus,
      eventType: result.eventType,
      providerKey: result.providerKey,
      webhookUrl: result.webhookUrl ?? "",
      expiresAt: result.expiresAt,
      metadata: {
        ...(result.metadata ?? {}),
        provider: result.raw,
      },
      lastError: result.lastError,
    });
  }

  private async upsertProviderEventSubscriptionRecord(input: {
    auth: { id: string; provider_family: string; scope_id: string; provider_user_id: string };
    asset: { id: string; platform_id: string; provider_asset_id: string };
    connectionId: string;
    providerStatus: string;
    eventType: string;
    providerKey: Record<string, unknown>;
    webhookUrl: string;
    expiresAt?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    lastError?: Record<string, unknown> | undefined;
  }): Promise<void> {
    await getPool().query(
      `
        INSERT INTO provider_event_subscriptions (
          provider_family, scope_id, platform_id, provider_authorization_id,
          provider_authorization_asset_id, social_connection_id, provider_user_id,
          provider_asset_id, developer_application_urn, member_urn, entity_urn,
          provider_key, event_type, webhook_url, provider_status, last_provider_sync_at,
          expires_at, deactivated_at, last_error, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15,
          now(), $16, CASE WHEN $15 = 'ACTIVE' THEN NULL ELSE now() END, $17::jsonb, $18::jsonb)
        ON CONFLICT (provider_family, provider_authorization_id, provider_authorization_asset_id, event_type)
        DO UPDATE SET
          social_connection_id = EXCLUDED.social_connection_id,
          provider_status = EXCLUDED.provider_status,
          provider_key = EXCLUDED.provider_key,
          webhook_url = EXCLUDED.webhook_url,
          last_provider_sync_at = now(),
          expires_at = EXCLUDED.expires_at,
          deactivated_at = EXCLUDED.deactivated_at,
          last_error = EXCLUDED.last_error,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        input.auth.provider_family,
        input.auth.scope_id,
        input.asset.platform_id,
        input.auth.id,
        input.asset.id,
        input.connectionId,
        input.auth.provider_user_id,
        input.asset.provider_asset_id,
        providerKeyString(input.providerKey, "applicationKey") ?? "provider:application:unknown",
        providerKeyString(input.providerKey, "actorKey") ?? input.auth.provider_user_id,
        providerKeyString(input.providerKey, "entityKey") ?? input.asset.provider_asset_id,
        JSON.stringify(input.providerKey),
        input.eventType,
        input.webhookUrl,
        input.providerStatus,
        parseProviderTimestamp(input.expiresAt),
        input.lastError ? JSON.stringify(input.lastError) : null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  private async platformIdsBySlug(slugs: string[]): Promise<Map<string, string>> {
    const result = await getPool().query<{ id: string; slug: string }>(
      "SELECT id, slug FROM platforms WHERE slug = ANY($1::text[])",
      [slugs],
    );
    return new Map(result.rows.map((row) => [row.slug, row.id]));
  }

  private async loadAuthorizedProviderAuthorization(authorizationId: string, userId: string) {
    if (!isUuid(authorizationId)) throw new NotFoundException("Provider authorization not found.");
    const result = await getPool().query<{
      id: string;
      provider_family: string;
      scope_id: string;
      provider_user_id: string;
      status: string;
      granted_scopes: unknown;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT id, provider_family, scope_id, provider_user_id, status, granted_scopes, metadata
        FROM provider_authorizations
        WHERE id = $1
        LIMIT 1
      `,
      [authorizationId],
    );
    const auth = result.rows[0];
    if (!auth || auth.status !== "ACTIVE") {
      throw new NotFoundException("Provider authorization not found.");
    }
    const authorized = await authorizeScope(userId, auth.scope_id, "MANAGE_SOCIAL_CONNECTIONS");
    if (!authorized) throw new ForbiddenException("Provider authorization scope denied.");
    return auth;
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

  private async configuredPlatformMetadata(): Promise<Map<string, Record<string, unknown>>> {
    const result = await getPool().query<{ platform_id: string; metadata: Record<string, unknown> | null }>(
      "SELECT platform_id, metadata FROM provider_app_configurations WHERE enabled = true",
    );
    return new Map(result.rows.map((row) => [row.platform_id, row.metadata ?? {}]));
  }

  private async providerAppConfigMetadata(platformId: string): Promise<Record<string, unknown> | null> {
    const result = await getPool().query<{ metadata: Record<string, unknown> | null }>(
      "SELECT metadata FROM provider_app_configurations WHERE platform_id = $1 AND enabled = true LIMIT 1",
      [platformId],
    );
    return result.rows[0]?.metadata ?? null;
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

  private normalizeScopes(
    requested: string[] | undefined,
    defaults: string[],
    platformSlug: string,
  ): string[] {
    const allowed = new Set(defaults);
    const source = requested && requested.length ? requested : defaults;
    const invalid = source.filter((scope) => !allowed.has(scope));
    if (invalid.length) {
      throw new BadRequestException(
        `Requested OAuth scopes are not allowed for this authorization mode: ${invalid.join(", ")}`,
      );
    }
    const normalized = [...source];
    if (platformSlug === "x") {
      if (!normalized.includes("tweet.read")) normalized.push("tweet.read");
      if (!normalized.includes("users.read")) normalized.push("users.read");
    }
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
    authMode?: string | undefined;
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
        metadata: Record<string, unknown> | null;
      }>(
        `
          SELECT id, platform_id, scope_id, actor_user_id, pkce_verifier,
                 requested_scopes, redirect_to, expires_at, used_at, metadata
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
        authMode: typeof row.metadata?.authMode === "string" ? row.metadata.authMode : undefined,
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

function hasAssetLister(
  connector: unknown,
): connector is OAuthCapableConnector & {
  listAuthorizationAssets: (
    credentials: ConnectorCredentials,
    context?: { scopeId: string; connectionId: string; credentials: ConnectorCredentials },
  ) => Promise<ProviderAsset[]>;
} {
  return (
    hasOAuthAdapter(connector) &&
    typeof (connector as { listAuthorizationAssets?: unknown }).listAuthorizationAssets === "function"
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

function minimalLinkedInWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
  if (notifications.length > 0) {
    return {
      type: typeof payload.type === "string" ? payload.type : "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
      notifications: notifications
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          notificationId: item.notificationId,
          organizationalEntity: item.organizationalEntity,
          organization: item.organization,
          action: item.action,
          sourcePost: item.sourcePost,
          generatedActivity: item.generatedActivity,
          lastModifiedAt: item.lastModifiedAt,
          subscriber: item.subscriber,
        })),
    };
  }
  return {
    type: payload.type,
    notificationId: payload.notificationId,
    organizationalEntity: payload.organizationalEntity,
    organization: payload.organization,
    entityUrn: payload.entityUrn,
    assetId: payload.assetId,
    action: payload.action,
    sourcePost: payload.sourcePost,
    generatedActivity: payload.generatedActivity,
    lastModifiedAt: payload.lastModifiedAt,
    eventTime: payload.eventTime,
    timestamp: payload.timestamp,
  };
}

function firstLinkedInNotificationId(payload: Record<string, unknown>): string | null {
  if (typeof payload.notificationId !== "undefined" && payload.notificationId !== null) {
    return String(payload.notificationId);
  }
  const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
  for (const item of notifications) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { notificationId?: unknown }).notificationId !== "undefined"
    ) {
      return String((item as { notificationId: unknown }).notificationId);
    }
  }
  return null;
}

function linkedInLogicalWebhookPayloads(
  payload: Record<string, unknown>,
  rawJson: string,
): Array<{
  payload: Record<string, unknown>;
  notificationId: string | null;
  dedupeKey: string;
  dedupeFallback: boolean;
}> {
  const notifications = Array.isArray(payload.notifications)
    ? payload.notifications.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
  if (notifications.length === 0) {
    const notificationId = firstLinkedInNotificationId(payload);
    const dedupeKey = notificationId
      ? linkedInWebhookDedupeKey(payload, rawJson)
      : linkedInWebhookDedupeKey(payload, rawJson);
    return [{ payload, notificationId, dedupeKey, dedupeFallback: !notificationId }];
  }
  return notifications.map((notification, index) => {
    const notificationId =
      typeof notification.notificationId !== "undefined" && notification.notificationId !== null
        ? String(notification.notificationId)
        : null;
    const logicalPayload = {
      type: payload.type,
      notificationId,
      lastModifiedAt:
        notification && typeof notification === "object"
          ? (notification as Record<string, unknown>).lastModifiedAt
          : undefined,
      notifications: [notification],
    };
    const dedupeKey = notificationId
      ? linkedInWebhookDedupeKey(logicalPayload, rawJson)
      : linkedInWebhookDedupeKey({ ...notification, batchIndex: index }, rawJson);
    return {
      payload: logicalPayload,
      notificationId,
      dedupeKey,
      dedupeFallback: !notificationId,
    };
  });
}

function providerDataCategoryFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const category = metadata?.providerDataCategory;
  return typeof category === "string" && category.length > 0 ? category : null;
}

function connectorProviderFamily(
  connector: { getProviderFamily?: () => string; getManifest?: () => ConnectorManifest } | undefined,
  fallback: string,
): string {
  return connector?.getProviderFamily?.() ?? connector?.getManifest?.().id ?? fallback;
}

function providerDataCategoryFromProfile(profile: NormalizedProfile): string | null {
  const direct = profile.providerDataCategory;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return providerDataCategoryFromMetadata(profile.metadata);
}

function parseProviderTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function stringFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function providerKeyString(providerKey: Record<string, unknown>, key: string): string | null {
  const value = providerKey[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
    const authMode = stringFromMetadata(input.metadata, "authMode");
    if (authMode) evaluation.authMode = authMode;
    if (access) evaluation.access = access;
    return (
      instance as { evaluateCapabilities(input: CapabilityEvaluationInput): unknown }
    ).evaluateCapabilities(evaluation);
  }
  return input.connector.manifest.capabilities;
}

function resolveOAuthContract(
  oauth: ConnectorManifest["oauth"] | undefined,
  providerConfig: ProviderApplicationConfig,
): OAuthProviderContract {
  if (!oauth) throw new BadRequestException("This platform does not support OAuth authorization.");
  const requestedMode =
    typeof providerConfig.metadata?.authMode === "string" ? providerConfig.metadata.authMode : undefined;
  const mode = requestedMode
    ? oauth.authModes?.find((entry) => entry.id === requestedMode)
    : undefined;
  if (requestedMode && !mode) {
    throw new BadRequestException("Configured OAuth authorization mode is not supported.");
  }
  const contract: OAuthProviderContract = {
    authorizationEndpoint: mode?.authorizationEndpoint ?? oauth.authorizationEndpoint,
    tokenEndpoint: mode?.tokenEndpoint ?? oauth.tokenEndpoint,
    defaultScopes: mode?.defaultScopes ?? oauth.defaultScopes,
    pkceRequired: mode?.pkceRequired ?? oauth.pkceRequired,
    supportsRefresh: mode?.supportsRefresh ?? oauth.supportsRefresh,
    supportsRevocation: mode?.supportsRevocation ?? oauth.supportsRevocation,
  };
  if (mode?.id) contract.id = mode.id;
  if (mode?.apiBaseUrl) contract.apiBaseUrl = mode.apiBaseUrl;
  return contract;
}

function providerConfigWithAuthMode(
  providerConfig: ProviderApplicationConfig,
  authMode: string | undefined,
): ProviderApplicationConfig {
  if (!authMode) return providerConfig;
  return {
    ...providerConfig,
    metadata: {
      ...(providerConfig.metadata ?? {}),
      authMode,
    },
  };
}
