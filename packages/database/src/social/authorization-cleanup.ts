import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  JOB_TYPES,
  PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION,
  QUEUE_NAMES,
  type JobStatus,
  type ProviderAuthorizationCleanupPayload,
} from "@xlrrank/queue";
import { getPool } from "../client.js";
import { safeJobError } from "./jobs.js";

type QueryExecutor = Pool | PoolClient;

export interface DurableProviderAuthorizationCleanupRequest {
  jobId: string;
  cleanupId: string;
  status: JobStatus;
  accepted: boolean;
  duplicate: boolean;
}

export interface CreateProviderAuthorizationCleanupInput {
  connectionId?: string | null;
  scopeId: string;
  platformId: string;
  providerFamily: string;
  credentialsEncrypted: string;
  metadata?: Record<string, unknown>;
}

export async function createProviderAuthorizationCleanupRequestTx(
  client: PoolClient,
  input: CreateProviderAuthorizationCleanupInput,
): Promise<DurableProviderAuthorizationCleanupRequest> {
  const cleanupId = randomUUID();
  const jobId = randomUUID();
  const idempotencyKey = `provider-auth-cleanup:${input.connectionId ?? cleanupId}`;

  const active = await client.query<{ id: string; status: JobStatus }>(
    `
      SELECT id, status
      FROM jobs
      WHERE type = $1
        AND idempotency_key = $2
        AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [JOB_TYPES.providerAuthorizationCleanup, idempotencyKey],
  );

  if (active.rows[0]) {
    const existingCleanup = await client.query<{ id: string }>(
      `
        SELECT id
        FROM provider_authorization_cleanups
        WHERE connection_id = $1
          AND status IN ('PENDING', 'RUNNING')
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [input.connectionId],
    );

    return {
      jobId: active.rows[0].id,
      cleanupId: existingCleanup.rows[0]?.id ?? "",
      status: active.rows[0].status,
      accepted: false,
      duplicate: true,
    };
  }

  await client.query(
    `
      INSERT INTO provider_authorization_cleanups (
        id, connection_id, scope_id, platform_id, provider_family,
        credentials_encrypted, status, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7::jsonb)
    `,
    [
      cleanupId,
      input.connectionId ?? null,
      input.scopeId,
      input.platformId,
      input.providerFamily,
      input.credentialsEncrypted,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const payload: ProviderAuthorizationCleanupPayload = {
    version: PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION,
    jobRequestId: jobId,
    cleanupId,
  };

  await client.query(
    `
      INSERT INTO jobs (
        id, type, queue_name, status, payload, payload_version,
        idempotency_key, max_attempts
      )
      VALUES ($1, $2, $3, 'PENDING_DISPATCH', $4::jsonb, $5, $6, 3)
    `,
    [
      jobId,
      JOB_TYPES.providerAuthorizationCleanup,
      QUEUE_NAMES.ingestion,
      JSON.stringify(payload),
      PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION,
      idempotencyKey,
    ],
  );

  await client.query(
    `
      INSERT INTO job_outbox (job_id, queue_name, job_type, payload)
      VALUES ($1, $2, $3, $4::jsonb)
    `,
    [jobId, QUEUE_NAMES.ingestion, JOB_TYPES.providerAuthorizationCleanup, JSON.stringify(payload)],
  );

  return {
    jobId,
    cleanupId,
    status: "PENDING_DISPATCH",
    accepted: true,
    duplicate: false,
  };
}

export async function createProviderAuthorizationCleanupRequest(
  input: CreateProviderAuthorizationCleanupInput,
): Promise<DurableProviderAuthorizationCleanupRequest> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createProviderAuthorizationCleanupRequestTx(client, input);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markAuthorizationCleanupTerminal(
  cleanupId: string,
  jobRequestId: string,
  error: unknown,
  executor?: QueryExecutor,
): Promise<void> {
  const client = executor ?? getPool();
  const safeErr = safeJobError(error);

  await client.query(
    `
      UPDATE provider_authorization_cleanups
      SET status = 'DEAD_LETTERED',
          credentials_encrypted = NULL,
          last_error = $2::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [cleanupId, JSON.stringify(safeErr)],
  );

  await client.query(
    `
      UPDATE jobs
      SET status = 'DEAD_LETTERED',
          safe_error = $2::jsonb,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [jobRequestId, JSON.stringify(safeErr)],
  );
}

export async function markAuthorizationCleanupCompleted(
  cleanupId: string,
  jobRequestId: string,
  executor?: QueryExecutor,
): Promise<void> {
  const client = executor ?? getPool();

  await client.query(
    `
      UPDATE provider_authorization_cleanups
      SET status = 'COMPLETED',
          credentials_encrypted = NULL,
          completed_at = now(),
          last_error = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [cleanupId],
  );

  await client.query(
    `
      UPDATE jobs
      SET status = 'COMPLETED',
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [jobRequestId],
  );
}
