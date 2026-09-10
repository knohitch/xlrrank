import type { Job } from "bullmq";
import {
  getPool,
  markAuthorizationCleanupCompleted,
  markAuthorizationCleanupTerminal,
  safeJobError,
} from "@xlrrank/database";
import {
  JOB_TYPES,
  parseProviderAuthorizationCleanupPayload,
} from "@xlrrank/queue";
import {
  decryptSecret,
  providerAuthorizationCleanupAssociatedData,
} from "@xlrrank/shared";
import {
  connectorRegistry,
  AuthenticationError,
  AuthorizationError,
  PermanentProviderError,
  RateLimitError,
  TemporaryProviderError,
  type ConnectorCredentials,
  type OAuthCapableConnector,
} from "@xlrrank/social-core";
import { createChildLogger } from "@xlrrank/observability";
import { ensureWorkerConnectors, loadProviderConfigForWorker } from "./social-sync-processor.js";

function isOAuthCapable(connector: unknown): connector is OAuthCapableConnector {
  return (
    !!connector &&
    typeof connector === "object" &&
    typeof (connector as { getOAuthAdapter?: unknown }).getOAuthAdapter === "function"
  );
}

const logger = createChildLogger("worker.provider-authorization-cleanup");

export async function processProviderAuthorizationCleanup(job: Job): Promise<void> {
  if (job.name !== JOB_TYPES.providerAuthorizationCleanup) {
    throw new Error(`Unsupported provider authorization cleanup job type: ${job.name}`);
  }

  const payload = parseProviderAuthorizationCleanupPayload(job.data);
  const pool = getPool();

  await pool.query(
    "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1",
    [payload.jobRequestId],
  );

  const cleanup = (
    await pool.query<{
      id: string;
      status: string;
      scope_id: string;
      platform_id: string;
      connection_id: string | null;
      credentials_encrypted: string | null;
      attempt_count: number;
      platform_slug: string;
    }>(
      `
        SELECT pac.id, pac.status, pac.scope_id, pac.platform_id,
               pac.connection_id, pac.credentials_encrypted, pac.attempt_count,
               p.slug AS platform_slug
        FROM provider_authorization_cleanups pac
        JOIN platforms p ON p.id = pac.platform_id
        WHERE pac.id = $1
        LIMIT 1
      `,
      [payload.cleanupId],
    )
  ).rows[0];

  if (!cleanup || cleanup.status === "COMPLETED" || cleanup.status === "DEAD_LETTERED") {
    await pool.query(
      "UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
      [payload.jobRequestId],
    );
    return;
  }

  if (!cleanup.credentials_encrypted) {
    await markAuthorizationCleanupCompleted(cleanup.id, payload.jobRequestId);
    return;
  }

  ensureWorkerConnectors();
  const connector = connectorRegistry.create(cleanup.platform_slug);
  const adapter = isOAuthCapable(connector) ? connector.getOAuthAdapter() : undefined;

  if (!adapter || typeof adapter.revoke !== "function") {
    await markAuthorizationCleanupCompleted(cleanup.id, payload.jobRequestId);
    return;
  }

  let credentials: ConnectorCredentials;
  try {
    const plaintext = decryptSecret(
      cleanup.credentials_encrypted,
      undefined,
      providerAuthorizationCleanupAssociatedData({
        cleanupId: cleanup.id,
        scopeId: cleanup.scope_id,
        platformSlug: cleanup.platform_slug,
      }),
    );
    credentials = JSON.parse(plaintext) as ConnectorCredentials;
  } catch (err) {
    logger.error(
      { err: safeJobError(err), cleanupId: cleanup.id },
      "Failed to decrypt authorization cleanup credentials snapshot; marking terminal",
    );
    await markAuthorizationCleanupTerminal(cleanup.id, payload.jobRequestId, err);
    return;
  }

  const providerConfig = await loadProviderConfigForWorker(cleanup.platform_slug).catch(() => undefined);
  if (!providerConfig) {
    await markAuthorizationCleanupTerminal(
      cleanup.id,
      payload.jobRequestId,
      new Error(`Provider application configuration missing for ${cleanup.platform_slug}`),
    );
    return;
  }

  try {
    await adapter.revoke(credentials, providerConfig);
    await markAuthorizationCleanupCompleted(cleanup.id, payload.jobRequestId);
    logger.info(
      { cleanupId: cleanup.id, platform: cleanup.platform_slug },
      "Provider authorization cleanup completed successfully; credentials wiped",
    );
  } catch (err) {
    const isRetryable =
      err instanceof TemporaryProviderError ||
      err instanceof RateLimitError ||
      (err instanceof Error && /timeout|network|econnrefused|etimedout/i.test(err.message));

    if (isRetryable && cleanup.attempt_count + 1 < 3) {
      await pool.query(
        `
          UPDATE provider_authorization_cleanups
          SET attempt_count = attempt_count + 1,
              last_error = $2::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [cleanup.id, JSON.stringify(safeJobError(err))],
      );
      await pool.query(
        "UPDATE jobs SET status = 'FAILED', failed_at = now(), safe_error = $2::jsonb WHERE id = $1",
        [payload.jobRequestId, JSON.stringify(safeJobError(err))],
      );
      throw err;
    }

    const isAlreadyInvalid =
      err instanceof AuthenticationError ||
      err instanceof AuthorizationError ||
      (err instanceof PermanentProviderError && /invalid_token|revoked|not found|404/i.test(err.message)) ||
      (err instanceof Error && /invalid_token|revoked/i.test(err.message));

    if (isAlreadyInvalid) {
      await markAuthorizationCleanupCompleted(cleanup.id, payload.jobRequestId);
      logger.info(
        { cleanupId: cleanup.id, platform: cleanup.platform_slug },
        "Token already invalid or revoked upstream; completed cleanup and wiped credentials",
      );
    } else {
      await markAuthorizationCleanupTerminal(cleanup.id, payload.jobRequestId, err);
      logger.warn(
        { err: safeJobError(err), cleanupId: cleanup.id, platform: cleanup.platform_slug },
        "Provider authorization cleanup reached terminal failure; wiped credentials snapshot",
      );
    }
  }
}
