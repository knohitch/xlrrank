import type { Job } from "bullmq";
import { getPool, safeJobError } from "@xlrrank/database";
import { JOB_TYPES, parseProviderSubscriptionCleanupPayload } from "@xlrrank/queue";
import { decryptSecret, providerAuthorizationAssociatedData } from "@xlrrank/shared";
import {
  AuthenticationError,
  AuthorizationError,
  connectorRegistry,
  PermanentProviderError,
  RateLimitError,
  TemporaryProviderError,
  type ConnectorCredentials,
} from "@xlrrank/social-core";
import { ensureWorkerConnectors } from "./social-sync-processor.js";

export async function processProviderSubscriptionCleanup(job: Job): Promise<void> {
  if (job.name !== JOB_TYPES.providerSubscriptionCleanup) {
    throw new Error(`Unsupported provider subscription cleanup job type: ${job.name}`);
  }
  const payload = parseProviderSubscriptionCleanupPayload(job.data);
  const pool = getPool();
  await pool.query(
    "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1",
    [payload.jobRequestId],
  );
  const subscription = (
    await pool.query<{
      id: string;
      provider_status: string;
      provider_family: string;
      provider_authorization_id: string;
      scope_id: string;
      social_connection_id: string;
      platform_slug: string;
      provider_key: Record<string, unknown> | null;
      event_type: string;
      credentials_encrypted: string | null;
    }>(
      `
        SELECT pes.id, pes.provider_status, pes.provider_family,
               pes.provider_authorization_id, pa.scope_id, pes.social_connection_id,
               p.slug AS platform_slug,
               pes.provider_key, pes.event_type, pa.credentials_encrypted
        FROM provider_event_subscriptions pes
        JOIN provider_authorizations pa ON pa.id = pes.provider_authorization_id
        JOIN platforms p ON p.id = pes.platform_id
        WHERE pes.id = $1
        LIMIT 1
      `,
      [payload.subscriptionId],
    )
  ).rows[0];
  if (!subscription || subscription.provider_status !== "PENDING_PROVIDER_DELETE") {
    await pool.query("UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [
      payload.jobRequestId,
    ]);
    return;
  }
  ensureWorkerConnectors();
  const connector = connectorRegistry.create(subscription.platform_slug);
  const deleteSubscription = connector?.deleteProviderEventSubscription;
  if (!deleteSubscription || !subscription.credentials_encrypted) {
    await markSubscriptionTerminal(subscription.id, payload.jobRequestId, {
      code: "PROVIDER_DELETE_TERMINAL",
      message: "Provider subscription cleanup is not executable",
    });
    return;
  }
  const credentials = JSON.parse(
    decryptSecret(
      subscription.credentials_encrypted,
      undefined,
      providerAuthorizationAssociatedData({
        authorizationId: subscription.provider_authorization_id,
        scopeId: subscription.scope_id,
        providerFamily: subscription.provider_family,
      }),
    ),
  ) as ConnectorCredentials;
  try {
    await deleteSubscription.call(
      connector,
      {
        providerFamily: subscription.provider_family,
        providerKey: subscription.provider_key ?? {},
        eventType: subscription.event_type,
      },
      {
        scopeId: subscription.scope_id,
        connectionId: subscription.social_connection_id,
        credentials,
      },
    );
    await getPool().query(
      `
        UPDATE provider_event_subscriptions
        SET provider_status = 'PROVIDER_DELETED',
            last_error = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || '{"cleanupRetryCompleted":true}'::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [subscription.id],
    );
    await pool.query("UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [
      payload.jobRequestId,
    ]);
  } catch (err) {
    if (err instanceof TemporaryProviderError || err instanceof RateLimitError) {
      await pool.query(
        `
          UPDATE provider_event_subscriptions
          SET last_error = $2::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [subscription.id, JSON.stringify(safeJobError(err))],
      );
      await pool.query("UPDATE jobs SET status = 'FAILED', failed_at = now(), safe_error = $2::jsonb WHERE id = $1", [
        payload.jobRequestId,
        JSON.stringify(safeJobError(err)),
      ]);
      throw err;
    }
    const status =
      err instanceof PermanentProviderError && /not found|404/i.test(err.message)
        ? "PROVIDER_ALREADY_ABSENT"
        : "PROVIDER_DELETE_TERMINAL";
    await markSubscriptionTerminal(subscription.id, payload.jobRequestId, {
      code:
        err instanceof AuthenticationError || err instanceof AuthorizationError || err instanceof PermanentProviderError
          ? err.code
          : "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
      providerStatus: status,
    }, status);
  }
}

async function markSubscriptionTerminal(
  subscriptionId: string,
  jobRequestId: string,
  error: Record<string, unknown>,
  status = "PROVIDER_DELETE_TERMINAL",
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE provider_event_subscriptions
      SET provider_status = $2,
          last_error = $3::jsonb,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cleanupTerminalAt', now()),
          updated_at = now()
      WHERE id = $1
    `,
    [subscriptionId, status, JSON.stringify(error)],
  );
  await pool.query("UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [
    jobRequestId,
  ]);
}
