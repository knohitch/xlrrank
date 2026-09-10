import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { getEnv } from "@xlrrank/config";
import {
  beginSocialIngestionRun,
  completeSocialIngestionRun,
  getPool,
  markSocialIngestionFailed,
  persistSocialSyncPage,
  acquireSocialSyncLease,
  createDeadLetter,
  EXECUTABLE_SOCIAL_CONNECTION_STATES,
  loadConnectionForSync,
  loadSocialSyncJob,
  releaseSocialSyncLease,
  renewSocialSyncLease,
  safeJobError,
  transitionSocialSyncJob,
  type ScopeContext,
} from "@xlrrank/database";
import { createChildLogger, getMetrics } from "@xlrrank/observability";
import {
  defaultSocialSyncJobOptions,
  JOB_TYPES,
  QUEUE_NAMES,
  parseSocialConnectionSyncPayload,
} from "@xlrrank/queue";
import {
  decryptSecret,
  encryptSecret,
  providerAppSecretAssociatedData,
  socialCredentialAssociatedData,
} from "@xlrrank/shared";
import {
  connectorRegistry,
  FacebookConnector,
  InstagramConnector,
  LinkedInConnector,
  NORMALIZATION_VERSION,
  RedditConnector,
  ReferenceHttpConnector,
  XConnector,
  ConnectorError,
  RateLimitError,
  TemporaryProviderError,
  type ConnectorCredentials,
  type OAuthCapableConnector,
  type ProviderApplicationConfig,
  type RetryClassification,
} from "@xlrrank/social-core";
import type { ContentQuery } from "@xlrrank/social-core";
import type {
  NormalizedContent,
  NormalizedInteraction,
  NormalizedProfile,
} from "@xlrrank/social-core";

const logger = createChildLogger("worker.social-sync");
const metrics = getMetrics();

class DelayedBullMqError extends Error {
  constructor() {
    super("Job moved to delayed retry");
    this.name = "DelayedError";
  }
}

class CancelledSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelledSyncError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let connectorsInitialized = false;

export function ensureWorkerConnectors(): void {
  if (connectorsInitialized) return;
  connectorRegistry.registerFactory(() => new XConnector());
  connectorRegistry.registerFactory(() => new InstagramConnector());
  connectorRegistry.registerFactory(() => new FacebookConnector());
  connectorRegistry.registerFactory(() => new LinkedInConnector());
  connectorRegistry.registerFactory(() => new RedditConnector());
  if (process.env.ENABLE_REFERENCE_CONNECTOR === "true" && process.env.NODE_ENV !== "production") {
    connectorRegistry.registerFactory(() => new ReferenceHttpConnector(), { testOnly: true });
  }
  connectorsInitialized = true;
}

function retryClassification(err: unknown): RetryClassification {
  if (err instanceof ConnectorError) return err.retryClassification;
  if (err instanceof CancelledSyncError) return "NON_RETRYABLE";
  return "RETRYABLE";
}

function errorCategory(err: unknown): string {
  if (err instanceof ConnectorError) return err.code;
  if (err instanceof CancelledSyncError) return "CANCELLED";
  return "TEMPORARY_PROVIDER_FAILURE";
}

function retryDelayMs(err: unknown, attempt: number): number {
  const env = getEnv();
  if (err instanceof RateLimitError) {
    const providerDelay = Math.max(0, err.retryAfterSeconds * 1000);
    return Math.min(
      env.SOCIAL_SYNC_RATE_LIMIT_MAX_DELAY_MS,
      Math.max(env.SOCIAL_SYNC_RATE_LIMIT_MIN_DELAY_MS, providerDelay),
    );
  }
  const exponential = Math.min(
    env.SOCIAL_SYNC_BACKOFF_MAX_MS,
    env.SOCIAL_SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = exponential * env.SOCIAL_SYNC_BACKOFF_JITTER * Math.random();
  return Math.round(Math.min(env.SOCIAL_SYNC_BACKOFF_MAX_MS, exponential + jitter));
}

async function withProviderTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getEnv().SOCIAL_SYNC_PROVIDER_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TemporaryProviderError("provider", "Provider operation timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function scopeContext(connection: Awaited<ReturnType<typeof loadConnectionForSync>>): ScopeContext {
  if (!connection) throw new Error("Connection not loaded");
  return {
    scopeId: connection.scopeId,
    scopeType: connection.scopeType,
    userId: connection.scopeUserId ?? "",
    organizationId: connection.organizationId,
  };
}

function parseCredentials(
  connection: NonNullable<Awaited<ReturnType<typeof loadConnectionForSync>>>,
): ConnectorCredentials {
  if (!connection.credentialsEncrypted) {
    throw new ConnectorError(
      "Social connection has no credentials",
      connection.platformSlug,
      "AUTHENTICATION",
      false,
      "REAUTH_REQUIRED",
    );
  }
  const plaintext = decryptSecret(
    connection.credentialsEncrypted,
    undefined,
    socialCredentialAssociatedData({
      connectionId: connection.id,
      scopeId: connection.scopeId,
      platformSlug: connection.platformSlug,
    }),
  );
  return JSON.parse(plaintext) as ConnectorCredentials;
}

function isOAuthCapable(connector: unknown): connector is OAuthCapableConnector {
  return (
    !!connector &&
    typeof connector === "object" &&
    typeof (connector as { getOAuthAdapter?: unknown }).getOAuthAdapter === "function"
  );
}

function tokenNeedsRefresh(credentials: ConnectorCredentials): boolean {
  if (!credentials.expiresAt) return false;
  const expiresAt = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + 60_000;
}

export async function loadProviderConfigForWorker(
  platformSlug: string,
): Promise<ProviderApplicationConfig> {
  const result = await getPool().query<{
    id: string;
    platform_slug: string;
    environment: string;
    client_id: string;
    client_secret_encrypted: string | null;
    redirect_uri: string;
    enabled: boolean;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT pac.id, p.slug AS platform_slug, pac.environment, pac.client_id,
             pac.client_secret_encrypted, pac.redirect_uri, pac.enabled, pac.metadata
      FROM provider_app_configurations pac
      JOIN platforms p ON p.id = pac.platform_id
      WHERE p.slug = $1 AND pac.environment = $2 AND pac.enabled = true
      LIMIT 1
    `,
    [platformSlug, process.env.NODE_ENV || "development"],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ConnectorError(
      "Provider application configuration is required for OAuth refresh",
      platformSlug,
      "CONFIGURATION",
      false,
      "NON_RETRYABLE",
    );
  }
  const config: ProviderApplicationConfig = {
    platformId: row.platform_slug,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    enabled: row.enabled,
    metadata: { ...(row.metadata ?? {}), environment: row.environment },
  };
  if (row.client_secret_encrypted) {
    config.clientSecret = decryptSecret(
      row.client_secret_encrypted,
      undefined,
      providerAppSecretAssociatedData({
        providerConfigId: row.id,
        platformSlug: row.platform_slug,
        secretName: "clientSecret",
      }),
    );
  }
  return config;
}

async function refreshCredentialsIfNeeded(input: {
  connection: NonNullable<Awaited<ReturnType<typeof loadConnectionForSync>>>;
  connector: NonNullable<ReturnType<typeof connectorRegistry.create>>;
  credentials: ConnectorCredentials;
  scope: ScopeContext;
  signal?: AbortSignal;
}): Promise<ConnectorCredentials> {
  if (!tokenNeedsRefresh(input.credentials)) return input.credentials;
  if (!input.credentials.refreshToken) {
    throw new ConnectorError(
      "OAuth access token expired without a refresh token",
      input.connection.platformSlug,
      "AUTHENTICATION",
      false,
      "REAUTH_REQUIRED",
    );
  }
  if (!isOAuthCapable(input.connector)) {
    return input.credentials;
  }
  const providerConfig = providerConfigWithCredentialAuthMode(
    await loadProviderConfigForWorker(input.connection.platformSlug),
    input.credentials,
  );
  const refreshed = await input.connector.getOAuthAdapter().refreshAccessToken(
    {
      providerConfig,
      refreshToken: input.credentials.refreshToken,
    },
    input.signal,
  );
  const nextCredentials: ConnectorCredentials = {
    ...input.credentials,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? input.credentials.refreshToken,
    metadata: {
      ...(input.credentials.metadata ?? {}),
      tokenType: refreshed.tokenType ?? input.credentials.metadata?.tokenType,
    },
  };
  const scopes = refreshed.grantedScopes.length
    ? refreshed.grantedScopes
    : input.credentials.scopes;
  if (scopes) nextCredentials.scopes = scopes;
  if (refreshed.expiresAt) nextCredentials.expiresAt = refreshed.expiresAt;
  const verifyContext = {
    scopeId: input.scope.scopeId,
    connectionId: input.connection.id,
    credentials: nextCredentials,
  };
  if (input.signal) {
    await input.connector.getOAuthAdapter().verifyIdentity(nextCredentials, {
      ...verifyContext,
      signal: input.signal,
    });
  } else {
    await input.connector.getOAuthAdapter().verifyIdentity(nextCredentials, verifyContext);
  }
  const ciphertext = encryptSecret(
    JSON.stringify(nextCredentials),
    undefined,
    socialCredentialAssociatedData({
      connectionId: input.connection.id,
      scopeId: input.connection.scopeId,
      platformSlug: input.connection.platformSlug,
    }),
  );
  const update = await getPool().query(
    `
      UPDATE social_connections
      SET credentials_encrypted = $2,
          credential_version = credential_version + 1,
          provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE id = $1
        AND credential_version = $3
        AND status IN ('CONNECTED', 'DEGRADED')
    `,
    [
      input.connection.id,
      ciphertext,
      input.connection.credentialVersion,
      JSON.stringify({
        grantedScopes: nextCredentials.scopes ?? [],
        tokenRefreshedAt: new Date().toISOString(),
      }),
    ],
  );
  if (update.rowCount !== 1) {
    throw new TemporaryProviderError(
      input.connection.platformSlug,
      "OAuth credentials changed during refresh",
    );
  }
  return nextCredentials;
}

function bindNormalizedPlatformId<
  T extends NormalizedProfile | NormalizedContent | NormalizedInteraction,
>(item: T, platformId: string): T {
  return { ...item, platformId };
}

function providerConfigWithCredentialAuthMode(
  providerConfig: ProviderApplicationConfig,
  credentials: ConnectorCredentials,
): ProviderApplicationConfig {
  const authMode = credentials.metadata?.authMode;
  if (typeof authMode !== "string") return providerConfig;
  return {
    ...providerConfig,
    metadata: {
      ...(providerConfig.metadata ?? {}),
      authMode,
    },
  };
}

async function updateConnectionAfterFailure(input: {
  connectionId: string;
  err: unknown;
  retryAfterMs?: number;
}): Promise<void> {
  const retryAt = input.retryAfterMs ? new Date(Date.now() + input.retryAfterMs) : null;
  const classification = retryClassification(input.err);
  const setReauth = classification === "REAUTH_REQUIRED";
  const errorMessage = input.err instanceof Error ? input.err.message.toLowerCase() : "";
  const isRoleOrAccessLoss =
    errorMessage.includes("lacks required organization role") ||
    errorMessage.includes("role") ||
    errorMessage.includes("product or permission access required");

  await getPool().query(
    `
      UPDATE social_connections
      SET status = CASE
            WHEN $2 THEN 'REAUTH_REQUIRED'
            WHEN $6 THEN 'DEGRADED'
            ELSE status
          END,
          sync_error = $3::jsonb,
          rate_limit_reset_at = CASE WHEN $4::timestamptz IS NULL THEN rate_limit_reset_at ELSE $4 END,
          retry_after_seconds = CASE WHEN $5::integer IS NULL THEN retry_after_seconds ELSE $5 END,
          last_sync_attempt_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [
      input.connectionId,
      setReauth,
      JSON.stringify(safeJobError(input.err)),
      retryAt,
      input.retryAfterMs ? Math.ceil(input.retryAfterMs / 1000) : null,
      isRoleOrAccessLoss,
    ],
  );
}

async function cancelIfConnectionStopped(input: {
  connectionId: string;
  jobId: string;
  runId: string;
  ownerToken: string;
}): Promise<NonNullable<Awaited<ReturnType<typeof loadConnectionForSync>>>> {
  const current = await loadConnectionForSync(input.connectionId);
  if (!current) throw new CancelledSyncError("Connection was deleted");
  if (!EXECUTABLE_SOCIAL_CONNECTION_STATES.includes(current.status as never)) {
    throw new CancelledSyncError(`Connection is no longer executable: ${current.status}`);
  }
  const renewed = await renewSocialSyncLease({
    connectionId: input.connectionId,
    ownerToken: input.ownerToken,
    leaseMs: getEnv().SOCIAL_SYNC_LEASE_MS,
  });
  if (!renewed) throw new TemporaryProviderError(current.platformSlug, "Sync lease was lost");
  await transitionSocialSyncJob({
    jobId: input.jobId,
    to: "RUNNING",
    from: ["RUNNING"],
    ingestionRunId: input.runId,
  });
  return current;
}

async function delayJob(job: Job, delayMs: number): Promise<never> {
  const timestamp = Date.now() + delayMs;
  await job.moveToDelayed(timestamp, job.token);
  throw new DelayedBullMqError();
}

export async function processSocialConnectionSync(job: Job): Promise<void> {
  ensureWorkerConnectors();
  if (job.name !== JOB_TYPES.socialConnectionSync) {
    throw new Error(`Unsupported ingestion job type: ${job.name}`);
  }
  const payload = parseSocialConnectionSyncPayload(job.data);
  const durableJob = await loadSocialSyncJob(payload.jobRequestId);
  if (!durableJob) throw new Error("Durable job request not found");
  if (durableJob.connectionId !== payload.connectionId) {
    throw new Error("Queue payload connection does not match durable job");
  }
  if (durableJob.status === "COMPLETED" || durableJob.status === "CANCELLED") return;

  const attempt = durableJob.attemptCount + 1;
  const ownerToken = randomUUID();
  let runId = durableJob.ingestionRunId;
  let lastDurableCursor: string | null = null;

  try {
    await transitionSocialSyncJob({
      jobId: durableJob.id,
      to: "RUNNING",
      from: ["PENDING_DISPATCH", "QUEUED", "RETRY_SCHEDULED"],
      attemptCount: attempt,
    });

    const connection = await loadConnectionForSync(payload.connectionId);
    if (!connection) throw new CancelledSyncError("Connection not found");
    if (!connection.platformEnabled) throw new CancelledSyncError("Platform is disabled");
    if (!EXECUTABLE_SOCIAL_CONNECTION_STATES.includes(connection.status as never)) {
      throw new CancelledSyncError(`Connection is not executable: ${connection.status}`);
    }

    const leaseAcquired = await acquireSocialSyncLease({
      connectionId: connection.id,
      jobId: durableJob.id,
      ownerToken,
      leaseMs: getEnv().SOCIAL_SYNC_LEASE_MS,
    });
    if (!leaseAcquired)
      throw new TemporaryProviderError(connection.platformSlug, "Sync lease busy");

    const connector = connectorRegistry.create(connection.platformSlug);
    if (!connector) {
      throw new ConnectorError(
        "Connector is not registered",
        connection.platformSlug,
        "CONFIGURATION",
        false,
        "NON_RETRYABLE",
      );
    }

    const initialCredentials = parseCredentials(connection);
    const scope = scopeContext(connection);
    const credentials = await withProviderTimeout((signal) =>
      refreshCredentialsIfNeeded({
        connection,
        connector,
        credentials: initialCredentials,
        scope,
        signal,
      }),
    );
    lastDurableCursor = connection.syncCursor;
    runId =
      runId ??
      (await beginSocialIngestionRun({
        scope,
        connectionId: connection.id,
        platformId: connection.platformId,
        cursorBefore: lastDurableCursor,
        normalizationVersion: NORMALIZATION_VERSION,
      }));
    await transitionSocialSyncJob({
      jobId: durableJob.id,
      to: "RUNNING",
      from: ["RUNNING"],
      ingestionRunId: runId,
    });

    const profile = await withProviderTimeout((signal) =>
      connector.authenticate(credentials, {
        scopeId: scope.scopeId,
        connectionId: connection.id,
        credentials,
        signal,
      }),
    );
    if (!profile.success || profile.status !== "CONNECTED" || !profile.profile) {
      throw new ConnectorError(
        profile.error ?? "Provider authentication failed",
        connection.platformSlug,
        "AUTHENTICATION",
        false,
        "REAUTH_REQUIRED",
      );
    }

    let cursor = lastDurableCursor;
    let hasMore = true;
    let includeProfile = true;
    while (hasMore) {
      const current = await cancelIfConnectionStopped({
        connectionId: connection.id,
        jobId: durableJob.id,
        runId,
        ownerToken,
      });
      const credentialsForPage = await withProviderTimeout((signal) =>
        refreshCredentialsIfNeeded({
          connection: current,
          connector,
          credentials: parseCredentials(current),
          scope,
          signal,
        }),
      );
      const context = {
        scopeId: scope.scopeId,
        connectionId: connection.id,
        credentials: credentialsForPage,
      };
      const pageQuery: ContentQuery = { limit: getEnv().SOCIAL_SYNC_PAGE_LIMIT };
      if (cursor) pageQuery.cursor = cursor;
      const contentPage = await withProviderTimeout((signal) =>
        connector.getContentPage(pageQuery, { ...context, signal }),
      );
      const interactionPage = await withProviderTimeout((signal) =>
        connector.getInteractionsPage(pageQuery, { ...context, signal }),
      );

      if (
        process.env.NODE_ENV === "test" &&
        process.env.WORKER_TEST_CRASH_BEFORE_PERSIST_CURSOR === (cursor ?? "START")
      ) {
        process.exit(75);
      }

      const nextCursor = contentPage.cursor.value;
      await persistSocialSyncPage({
        scope,
        connectionId: connection.id,
        platformId: connection.platformId,
        ingestionRunId: runId,
        cursorBefore: cursor,
        cursorAfter: nextCursor,
        profiles: includeProfile
          ? [bindNormalizedPlatformId(profile.profile, connection.platformId)]
          : [],
        content: contentPage.items.map((item) =>
          bindNormalizedPlatformId(item, connection.platformId),
        ),
        interactions: interactionPage.items.map((item) =>
          bindNormalizedPlatformId(item, connection.platformId),
        ),
        normalizationVersion: NORMALIZATION_VERSION,
        adapterVersion: connector.getManifest().version,
        completeRun: false,
      });
      metrics.increment("worker.social_sync.pages_persisted");
      metrics.increment("worker.social_sync.content_persisted", contentPage.items.length);
      metrics.increment("worker.social_sync.interactions_persisted", interactionPage.items.length);
      lastDurableCursor = nextCursor;
      cursor = nextCursor;
      hasMore = contentPage.cursor.hasMore;
      includeProfile = false;

      if (
        process.env.NODE_ENV === "test" &&
        process.env.WORKER_TEST_PAUSE_AFTER_CURSOR === (cursor ?? "END")
      ) {
        await sleep(Number(process.env.WORKER_TEST_PAUSE_MS ?? 1_500));
      }

      if (
        process.env.NODE_ENV === "test" &&
        process.env.WORKER_TEST_CRASH_AFTER_CURSOR === (cursor ?? "END")
      ) {
        process.exit(76);
      }
    }

    await completeSocialIngestionRun({ runId, cursorAfter: lastDurableCursor });
    await transitionSocialSyncJob({
      jobId: durableJob.id,
      to: "COMPLETED",
      from: ["RUNNING"],
      ingestionRunId: runId,
    });
    await releaseSocialSyncLease({ connectionId: connection.id, ownerToken });
    metrics.increment("worker.social_sync.completed");
    logger.info(
      {
        jobId: durableJob.id,
        jobType: job.name,
        ingestionRunId: runId,
        connectionId: connection.id,
        attempt,
      },
      "Social sync job completed",
    );
  } catch (err) {
    const classification = retryClassification(err);
    const category = errorCategory(err);
    const retryDelay = retryDelayMs(err, attempt);
    if (runId) {
      await markSocialIngestionFailed({
        runId,
        error: { ...safeJobError(err), code: category },
        retryClassification: classification,
      });
    }
    const failureUpdate: {
      connectionId: string;
      err: unknown;
      retryAfterMs?: number;
    } = {
      connectionId: payload.connectionId,
      err,
    };
    if (err instanceof RateLimitError) failureUpdate.retryAfterMs = retryDelay;
    await updateConnectionAfterFailure(failureUpdate);
    await releaseSocialSyncLease({ connectionId: payload.connectionId, ownerToken });

    if (err instanceof CancelledSyncError) {
      await transitionSocialSyncJob({
        jobId: durableJob.id,
        to: "CANCELLED",
        from: ["RUNNING"],
        ingestionRunId: runId,
        error: err,
        retryClassification: "NON_RETRYABLE",
      });
      metrics.increment("worker.social_sync.cancelled");
      return;
    }

    if (classification === "RETRYABLE" && attempt < durableJob.maxAttempts) {
      const nextRetryAt = new Date(Date.now() + retryDelay);
      await transitionSocialSyncJob({
        jobId: durableJob.id,
        to: "RETRY_SCHEDULED",
        from: ["RUNNING"],
        ingestionRunId: runId,
        error: err,
        retryClassification: classification,
        nextRetryAt,
      });
      metrics.increment("worker.social_sync.retried");
      logger.warn(
        {
          jobId: durableJob.id,
          jobType: job.name,
          ingestionRunId: runId,
          connectionId: payload.connectionId,
          attempt,
          errorCategory: category,
        },
        "Social sync job scheduled for retry",
      );
      await delayJob(job, retryDelay);
    }

    const terminalStatus = classification === "REAUTH_REQUIRED" ? "FAILED" : "DEAD_LETTERED";
    await transitionSocialSyncJob({
      jobId: durableJob.id,
      to: terminalStatus,
      from: ["RUNNING"],
      ingestionRunId: runId,
      error: err,
      retryClassification: classification,
    });
    if (terminalStatus === "DEAD_LETTERED") {
      await createDeadLetter({
        jobId: durableJob.id,
        queueName: QUEUE_NAMES.ingestion,
        jobType: JOB_TYPES.socialConnectionSync,
        connectionId: payload.connectionId,
        ingestionRunId: runId,
        attemptCount: attempt,
        retryClassification: classification,
        error: err,
      });
    }
    metrics.increment(
      terminalStatus === "DEAD_LETTERED"
        ? "worker.social_sync.dead_lettered"
        : "worker.social_sync.failed",
    );
    logger.error(
      {
        jobId: durableJob.id,
        jobType: job.name,
        ingestionRunId: runId,
        connectionId: payload.connectionId,
        attempt,
        errorCategory: category,
      },
      "Social sync job reached terminal state",
    );
  }
}

export function socialSyncJobOptions() {
  return defaultSocialSyncJobOptions();
}
