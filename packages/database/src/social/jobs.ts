import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RetryClassification } from "@xlrrank/social-core";
import {
  assertJobTransition,
  JOB_STATUSES,
  JOB_TYPES,
  QUEUE_NAMES,
  SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION,
  SOCIAL_SYNC_PAYLOAD_VERSION,
  type JobStatus,
  type SocialConnectionSyncPayload,
  type SocialWebhookProcessPayload,
  type SocialSyncReason,
} from "@xlrrank/queue";
import { redactSensitive } from "@xlrrank/shared";
import { getEnv } from "@xlrrank/config";
import { getPool } from "../client.js";
import type { ScopeContext } from "./scope.js";
import { authorizeScope } from "./scope.js";

export const EXECUTABLE_SOCIAL_CONNECTION_STATES = ["CONNECTED", "DEGRADED"] as const;

const ACTIVE_JOB_STATUSES: JobStatus[] = [
  "PENDING_DISPATCH",
  "QUEUED",
  "RUNNING",
  "RETRY_SCHEDULED",
];

export interface DurableSocialSyncRequest {
  jobId: string;
  status: JobStatus;
  connectionId: string;
  scopeId: string;
  accepted: boolean;
  duplicate: boolean;
}

export interface ClaimedOutboxEntry {
  id: string;
  jobId: string;
  queueName: string;
  jobType: string;
  payload: unknown;
}

export interface SocialConnectionForSync {
  id: string;
  scopeId: string;
  scopeType: "PERSONAL" | "ORGANIZATION";
  scopeUserId: string | null;
  organizationId: string | null;
  platformId: string;
  platformSlug: string;
  platformEnabled: boolean;
  status: string;
  credentialsEncrypted: string | null;
  credentialVersion: number;
  syncCursor: string | null;
  syncEnabled: boolean;
  scheduleCadenceSeconds: number | null;
}

export interface SocialSyncJobRecord {
  id: string;
  type: string;
  status: JobStatus;
  connectionId: string;
  scopeId: string;
  payloadVersion: number;
  attemptCount: number;
  maxAttempts: number;
  ingestionRunId: string | null;
}

export interface SocialSyncJobStatusView {
  id: string;
  type: string;
  status: string;
  connectionId: string | null;
  scopeId: string | null;
  reason: string | null;
  attemptCount: number;
  maxAttempts: number;
  retryClassification: string | null;
  nextRetryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  deadLetteredAt: Date | null;
  ingestionRunId: string | null;
  runStatus: string | null;
  profilesProcessed: number | null;
  contentProcessed: number | null;
  interactionsProcessed: number | null;
  cursorAfter: string | null;
  safeError: unknown;
}

function assertJobStatus(value: string): asserts value is JobStatus {
  if (!JOB_STATUSES.includes(value as JobStatus)) {
    throw new Error(`Unknown durable job status: ${value}`);
  }
}

export function safeJobError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra = err as Error & {
      code?: unknown;
      retryClassification?: unknown;
      retryAfterSeconds?: unknown;
    };
    return redactSensitive({
      name: err.name,
      message: err.message,
      code: extra.code,
      retryClassification: extra.retryClassification,
      retryAfterSeconds: extra.retryAfterSeconds,
    });
  }
  if (err && typeof err === "object") {
    return redactSensitive(err as Record<string, unknown>);
  }
  return { message: String(err) };
}

function activeStatusList(): string {
  return ACTIVE_JOB_STATUSES.map((status) => `'${status}'`).join(", ");
}

function isActiveSyncUniqueConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505" &&
    "constraint" in err &&
    (err as { constraint?: string }).constraint === "jobs_active_social_connection_sync_unique"
  );
}

export async function createSocialConnectionSyncRequest(input: {
  connectionId: string;
  requestedByUserId?: string | null;
  reason: SocialSyncReason;
  idempotencyKey?: string | null;
}): Promise<DurableSocialSyncRequest> {
  const env = getEnv();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connection = await loadConnectionForSyncClient(client, input.connectionId);
    if (!connection) throw new Error("Social connection not found");
    if (!connection.platformEnabled) throw new Error("Social platform is disabled");
    if (!EXECUTABLE_SOCIAL_CONNECTION_STATES.includes(connection.status as never)) {
      throw new Error(`Social connection is not executable in state ${connection.status}`);
    }
    if (!connection.credentialsEncrypted) throw new Error("Social connection has no credentials");

    const active = await client.query<{ id: string; status: JobStatus }>(
      `
        SELECT id, status
        FROM jobs
        WHERE type = $1
          AND connection_id = $2
          AND status IN (${activeStatusList()})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE
      `,
      [JOB_TYPES.socialConnectionSync, input.connectionId],
    );
    const activeJob = active.rows[0];
    if (activeJob) {
      await client.query("COMMIT");
      return {
        jobId: activeJob.id,
        status: activeJob.status,
        connectionId: input.connectionId,
        scopeId: connection.scopeId,
        accepted: false,
        duplicate: true,
      };
    }

    const jobId = randomUUID();
    const payload: SocialConnectionSyncPayload = {
      version: SOCIAL_SYNC_PAYLOAD_VERSION,
      jobRequestId: jobId,
      connectionId: input.connectionId,
      reason: input.reason,
    };
    await client.query(
      `
        INSERT INTO jobs (
          id, type, queue_name, status, payload, payload_version, scope_id,
          connection_id, reason, idempotency_key, max_attempts, user_id
        )
        VALUES ($1, $2, $3, 'PENDING_DISPATCH', $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        jobId,
        JOB_TYPES.socialConnectionSync,
        QUEUE_NAMES.ingestion,
        JSON.stringify(payload),
        SOCIAL_SYNC_PAYLOAD_VERSION,
        connection.scopeId,
        input.connectionId,
        input.reason,
        input.idempotencyKey ?? `active:${JOB_TYPES.socialConnectionSync}:${input.connectionId}`,
        env.SOCIAL_SYNC_MAX_ATTEMPTS,
        input.requestedByUserId ?? null,
      ],
    );
    await client.query(
      `
        INSERT INTO job_outbox (job_id, queue_name, job_type, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [jobId, QUEUE_NAMES.ingestion, JOB_TYPES.socialConnectionSync, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    return {
      jobId,
      status: "PENDING_DISPATCH",
      connectionId: input.connectionId,
      scopeId: connection.scopeId,
      accepted: true,
      duplicate: false,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isActiveSyncUniqueConflict(err)) {
      const active = await pool.query<{ id: string; status: JobStatus; scope_id: string }>(
        `
          SELECT id, status, scope_id
          FROM jobs
          WHERE type = $1
            AND connection_id = $2
            AND status IN (${activeStatusList()})
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [JOB_TYPES.socialConnectionSync, input.connectionId],
      );
      const activeJob = active.rows[0];
      if (activeJob) {
        return {
          jobId: activeJob.id,
          status: activeJob.status,
          connectionId: input.connectionId,
          scopeId: activeJob.scope_id,
          accepted: false,
          duplicate: true,
        };
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function createSocialWebhookProcessRequest(input: {
  receiptId: string;
}): Promise<{ jobId: string; status: JobStatus; receiptId: string; accepted: boolean; duplicate: boolean }> {
  const env = getEnv();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM webhook_receipts WHERE id = $1 FOR UPDATE",
      [input.receiptId],
    );
    if (!receipt.rows[0]) throw new Error("Webhook receipt not found");
    const active = await client.query<{ id: string; status: JobStatus }>(
      `
        SELECT id, status
        FROM jobs
        WHERE type = $1
          AND idempotency_key = $2
          AND status IN (${activeStatusList()})
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [JOB_TYPES.socialWebhookProcess, `webhook:${input.receiptId}`],
    );
    if (active.rows[0]) {
      await client.query("COMMIT");
      return {
        jobId: active.rows[0].id,
        status: active.rows[0].status,
        receiptId: input.receiptId,
        accepted: false,
        duplicate: true,
      };
    }
    const jobId = randomUUID();
    const payload: SocialWebhookProcessPayload = {
      version: SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION,
      jobRequestId: jobId,
      receiptId: input.receiptId,
    };
    await client.query(
      `
        INSERT INTO jobs (
          id, type, queue_name, status, payload, payload_version,
          idempotency_key, max_attempts
        )
        VALUES ($1, $2, $3, 'PENDING_DISPATCH', $4::jsonb, $5, $6, $7)
      `,
      [
        jobId,
        JOB_TYPES.socialWebhookProcess,
        QUEUE_NAMES.ingestion,
        JSON.stringify(payload),
        SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION,
        `webhook:${input.receiptId}`,
        env.SOCIAL_SYNC_MAX_ATTEMPTS,
      ],
    );
    await client.query(
      "INSERT INTO job_outbox (job_id, queue_name, job_type, payload) VALUES ($1, $2, $3, $4::jsonb)",
      [jobId, QUEUE_NAMES.ingestion, JOB_TYPES.socialWebhookProcess, JSON.stringify(payload)],
    );
    await client.query(
      "UPDATE webhook_receipts SET status = 'PENDING_DISPATCH' WHERE id = $1",
      [input.receiptId],
    );
    await client.query("COMMIT");
    return {
      jobId,
      status: "PENDING_DISPATCH",
      receiptId: input.receiptId,
      accepted: true,
      duplicate: false,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function claimPendingOutboxEntries(input: {
  dispatcherId: string;
  limit: number;
  leaseMs: number;
}): Promise<ClaimedOutboxEntry[]> {
  const result = await getPool().query<{
    id: string;
    job_id: string;
    queue_name: string;
    job_type: string;
    payload: SocialConnectionSyncPayload;
  }>(
    `
      WITH claimed AS (
        SELECT id
        FROM job_outbox
        WHERE status IN ('PENDING', 'FAILED')
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE job_outbox jo
      SET locked_by = $1,
          locked_until = now() + ($3::text || ' milliseconds')::interval,
          attempt_count = jo.attempt_count + 1,
          updated_at = now()
      FROM claimed
      WHERE jo.id = claimed.id
      RETURNING jo.id, jo.job_id, jo.queue_name, jo.job_type, jo.payload
    `,
    [input.dispatcherId, input.limit, input.leaseMs],
  );
  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    queueName: row.queue_name,
    jobType: row.job_type,
    payload: row.payload,
  }));
}

export async function markOutboxDispatched(input: {
  outboxId: string;
  jobId: string;
  bullmqJobId: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE job_outbox
        SET status = 'DISPATCHED',
            bullmq_job_id = $3,
            dispatched_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            updated_at = now()
        WHERE id = $1 AND job_id = $2
      `,
      [input.outboxId, input.jobId, input.bullmqJobId],
    );
    await client.query(
      `
        UPDATE jobs
        SET status = 'QUEUED',
            bullmq_job_id = $2,
            updated_at = now()
        WHERE id = $1 AND status IN ('PENDING_DISPATCH', 'RETRY_SCHEDULED')
      `,
      [input.jobId, input.bullmqJobId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markOutboxFailed(input: { outboxId: string; error: unknown }): Promise<void> {
  await getPool().query(
    `
      UPDATE job_outbox
      SET status = 'FAILED',
          last_error = $2::jsonb,
          locked_by = NULL,
          locked_until = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [input.outboxId, JSON.stringify(safeJobError(input.error))],
  );
}

export async function loadSocialSyncJob(jobId: string): Promise<SocialSyncJobRecord | null> {
  const result = await getPool().query<{
    id: string;
    type: string;
    status: string;
    connection_id: string;
    scope_id: string;
    payload_version: number;
    attempt_count: number;
    max_attempts: number;
    ingestion_run_id: string | null;
  }>(
    `
      SELECT id, type, status, connection_id, scope_id, payload_version,
             attempt_count, max_attempts, ingestion_run_id
      FROM jobs
      WHERE id = $1 AND type = $2
    `,
    [jobId, JOB_TYPES.socialConnectionSync],
  );
  const row = result.rows[0];
  if (!row) return null;
  assertJobStatus(row.status);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    connectionId: row.connection_id,
    scopeId: row.scope_id,
    payloadVersion: row.payload_version,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ingestionRunId: row.ingestion_run_id,
  };
}

export async function transitionSocialSyncJob(input: {
  jobId: string;
  to: JobStatus;
  from?: JobStatus[];
  attemptCount?: number;
  ingestionRunId?: string | null;
  error?: unknown;
  retryClassification?: RetryClassification | null;
  nextRetryAt?: Date | null;
}): Promise<void> {
  const pool = getPool();
  const current = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
    input.jobId,
  ]);
  const from = current.rows[0]?.status;
  if (!from) throw new Error("Durable job not found");
  assertJobStatus(from);
  assertJobTransition(from, input.to);
  if (input.from && !input.from.includes(from)) {
    throw new Error(`Durable job is in ${from}, not one of ${input.from.join(", ")}`);
  }
  await pool.query(
    `
      UPDATE jobs
      SET status = $2,
          attempt_count = COALESCE($3, attempt_count),
          ingestion_run_id = COALESCE($4, ingestion_run_id),
          safe_error = COALESCE($5::jsonb, safe_error),
          error = COALESCE($5::jsonb, error),
          retry_classification = $6,
          next_retry_at = $7,
          started_at = CASE WHEN $2 = 'RUNNING' THEN COALESCE(started_at, now()) ELSE started_at END,
          completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
          failed_at = CASE WHEN $2 IN ('FAILED', 'DEAD_LETTERED') THEN now() ELSE failed_at END,
          dead_lettered_at = CASE WHEN $2 = 'DEAD_LETTERED' THEN now() ELSE dead_lettered_at END,
          updated_at = now()
      WHERE id = $1
    `,
    [
      input.jobId,
      input.to,
      input.attemptCount ?? null,
      input.ingestionRunId ?? null,
      input.error === undefined ? null : JSON.stringify(safeJobError(input.error)),
      input.retryClassification ?? null,
      input.nextRetryAt ?? null,
    ],
  );
}

export async function createDeadLetter(input: {
  jobId: string;
  queueName: string;
  jobType: string;
  connectionId: string | null;
  ingestionRunId?: string | null;
  attemptCount: number;
  retryClassification: RetryClassification;
  error: unknown;
}): Promise<void> {
  await getPool().query(
    `
      INSERT INTO job_dead_letters (
        job_id, queue_name, job_type, connection_id, ingestion_run_id,
        safe_error, attempt_count, retry_classification
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      ON CONFLICT (job_id) DO UPDATE SET
        safe_error = EXCLUDED.safe_error,
        attempt_count = EXCLUDED.attempt_count,
        retry_classification = EXCLUDED.retry_classification
    `,
    [
      input.jobId,
      input.queueName,
      input.jobType,
      input.connectionId,
      input.ingestionRunId ?? null,
      JSON.stringify(safeJobError(input.error)),
      input.attemptCount,
      input.retryClassification,
    ],
  );
}

export async function loadConnectionForSync(
  connectionId: string,
): Promise<SocialConnectionForSync | null> {
  return loadConnectionForSyncClient(getPool(), connectionId);
}

async function loadConnectionForSyncClient(
  client: Pick<PoolClient, "query">,
  connectionId: string,
): Promise<SocialConnectionForSync | null> {
  const result = await client.query<{
    id: string;
    scope_id: string;
    scope_type: "PERSONAL" | "ORGANIZATION";
    scope_user_id: string | null;
    organization_id: string | null;
    platform_id: string;
    platform_slug: string;
    platform_enabled: boolean;
    status: string;
    credentials_encrypted: string | null;
    credential_version: number;
    sync_cursor: string | null;
    sync_enabled: boolean;
    schedule_cadence_seconds: number | null;
  }>(
    `
      SELECT sc.id,
             sc.scope_id,
             ds.scope_type,
             ds.user_id AS scope_user_id,
             ds.organization_id,
             sc.platform_id,
             p.slug AS platform_slug,
             p.enabled AS platform_enabled,
             sc.status,
             sc.credentials_encrypted,
             sc.credential_version,
             sc.sync_cursor,
             sc.sync_enabled,
             sc.schedule_cadence_seconds
      FROM social_connections sc
      JOIN data_scopes ds ON ds.id = sc.scope_id
      JOIN platforms p ON p.id = sc.platform_id
      WHERE sc.id = $1
    `,
    [connectionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scopeId: row.scope_id,
    scopeType: row.scope_type,
    scopeUserId: row.scope_user_id,
    organizationId: row.organization_id,
    platformId: row.platform_id,
    platformSlug: row.platform_slug,
    platformEnabled: row.platform_enabled,
    status: row.status,
    credentialsEncrypted: row.credentials_encrypted,
    credentialVersion: row.credential_version,
    syncCursor: row.sync_cursor,
    syncEnabled: row.sync_enabled,
    scheduleCadenceSeconds: row.schedule_cadence_seconds,
  };
}

export async function acquireSocialSyncLease(input: {
  connectionId: string;
  jobId: string;
  ownerToken: string;
  leaseMs: number;
}): Promise<boolean> {
  const result = await getPool().query<{ owner_token: string }>(
    `
      INSERT INTO social_sync_leases (connection_id, job_id, owner_token, expires_at)
      VALUES ($1, $2, $3, now() + ($4::text || ' milliseconds')::interval)
      ON CONFLICT (connection_id) DO UPDATE SET
        job_id = EXCLUDED.job_id,
        owner_token = EXCLUDED.owner_token,
        expires_at = EXCLUDED.expires_at,
        heartbeat_at = now(),
        updated_at = now()
      WHERE social_sync_leases.expires_at < now()
         OR social_sync_leases.owner_token = $3
      RETURNING owner_token
    `,
    [input.connectionId, input.jobId, input.ownerToken, input.leaseMs],
  );
  return result.rows[0]?.owner_token === input.ownerToken;
}

export async function renewSocialSyncLease(input: {
  connectionId: string;
  ownerToken: string;
  leaseMs: number;
}): Promise<boolean> {
  const result = await getPool().query(
    `
      UPDATE social_sync_leases
      SET expires_at = now() + ($3::text || ' milliseconds')::interval,
          heartbeat_at = now(),
          updated_at = now()
      WHERE connection_id = $1 AND owner_token = $2
    `,
    [input.connectionId, input.ownerToken, input.leaseMs],
  );
  return result.rowCount === 1;
}

export async function releaseSocialSyncLease(input: {
  connectionId: string;
  ownerToken: string;
}): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM social_sync_leases WHERE connection_id = $1 AND owner_token = $2",
    [input.connectionId, input.ownerToken],
  );
  return result.rowCount === 1;
}

export async function touchWorkerHeartbeat(input: {
  workerId: string;
  kind: string;
  status: "STARTING" | "READY" | "DRAINING" | "STOPPED" | "ERROR";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getPool().query(
    `
      INSERT INTO worker_heartbeats (worker_id, kind, status, metadata)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (worker_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        last_seen_at = now()
    `,
    [input.workerId, input.kind, input.status, JSON.stringify(input.metadata ?? {})],
  );
}

export async function reconcileWorkerState(workerId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE job_outbox
      SET locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE locked_until < now()
    `,
  );
  await pool.query(
    `
      UPDATE jobs
      SET status = 'RETRY_SCHEDULED',
          next_retry_at = now(),
          updated_at = now()
      WHERE status = 'RUNNING'
        AND type = $1
        AND NOT EXISTS (
          SELECT 1
          FROM social_sync_leases ssl
          WHERE ssl.job_id = jobs.id AND ssl.expires_at > now()
        )
    `,
    [JOB_TYPES.socialConnectionSync],
  );
  await pool.query(
    `
      UPDATE worker_heartbeats
      SET status = 'STOPPED'
      WHERE worker_id <> $1
        AND status IN ('STARTING', 'READY', 'DRAINING')
        AND last_seen_at < now() - interval '5 minutes'
    `,
    [workerId],
  );
}

export async function getAuthorizedSocialSyncJobStatus(input: {
  userId: string;
  jobId: string;
}): Promise<SocialSyncJobStatusView | null> {
  const result = await getPool().query<{
    id: string;
    type: string;
    status: string;
    connection_id: string | null;
    scope_id: string | null;
    reason: string | null;
    attempt_count: number;
    max_attempts: number;
    retry_classification: string | null;
    next_retry_at: Date | null;
    started_at: Date | null;
    completed_at: Date | null;
    failed_at: Date | null;
    dead_lettered_at: Date | null;
    ingestion_run_id: string | null;
    run_status: string | null;
    profiles_processed: number | null;
    content_processed: number | null;
    interactions_processed: number | null;
    cursor_after: string | null;
    safe_error: unknown;
  }>(
    `
      SELECT j.id, j.type, j.status, j.connection_id, j.scope_id, j.reason,
             j.attempt_count, j.max_attempts, j.retry_classification, j.next_retry_at,
             j.started_at, j.completed_at, j.failed_at, j.dead_lettered_at,
             j.ingestion_run_id, sir.status AS run_status, sir.profiles_processed,
             sir.content_processed, sir.interactions_processed, sir.cursor_after, j.safe_error
      FROM jobs j
      LEFT JOIN social_ingestion_runs sir ON sir.id = j.ingestion_run_id
      WHERE j.id = $1 AND j.type = $2
    `,
    [input.jobId, JOB_TYPES.socialConnectionSync],
  );
  const row = result.rows[0];
  if (!row?.scope_id) return null;
  const scope = await authorizeScope(input.userId, row.scope_id, "VIEW_SOCIAL_DATA");
  if (!scope) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    connectionId: row.connection_id,
    scopeId: row.scope_id,
    reason: row.reason,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryClassification: row.retry_classification,
    nextRetryAt: row.next_retry_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    deadLetteredAt: row.dead_lettered_at,
    ingestionRunId: row.ingestion_run_id,
    runStatus: row.run_status,
    profilesProcessed: row.profiles_processed,
    contentProcessed: row.content_processed,
    interactionsProcessed: row.interactions_processed,
    cursorAfter: row.cursor_after,
    safeError: row.safe_error,
  };
}

export async function claimDueSocialSyncSchedules(input: {
  schedulerId: string;
  limit: number;
  leaseMs: number;
}): Promise<Array<{ scheduleId: string; connectionId: string; cadenceSeconds: number }>> {
  const result = await getPool().query<{
    id: string;
    connection_id: string;
    cadence_seconds: number;
  }>(
    `
      WITH claimed AS (
        SELECT s.id
        FROM social_sync_schedules s
        JOIN social_connections sc ON sc.id = s.connection_id
        WHERE s.enabled = true
          AND s.next_sync_at <= now()
          AND (s.locked_until IS NULL OR s.locked_until < now())
          AND sc.status IN ('CONNECTED', 'DEGRADED')
        ORDER BY s.next_sync_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE social_sync_schedules s
      SET locked_by = $1,
          locked_until = now() + ($3::text || ' milliseconds')::interval,
          updated_at = now()
      FROM claimed
      WHERE s.id = claimed.id
      RETURNING s.id, s.connection_id, s.cadence_seconds
    `,
    [input.schedulerId, input.limit, input.leaseMs],
  );
  return result.rows.map((row) => ({
    scheduleId: row.id,
    connectionId: row.connection_id,
    cadenceSeconds: row.cadence_seconds,
  }));
}

export async function markScheduleDispatched(input: {
  scheduleId: string;
  schedulerId: string;
  cadenceSeconds: number;
  rateLimitUntil?: Date | null;
}): Promise<Date> {
  const now = new Date();
  const cadenceNext = new Date(now.getTime() + input.cadenceSeconds * 1000);
  const nextSyncAt =
    input.rateLimitUntil && input.rateLimitUntil > cadenceNext ? input.rateLimitUntil : cadenceNext;
  await getPool().query(
    `
      WITH updated_schedule AS (
        UPDATE social_sync_schedules
        SET last_scheduled_at = now(),
            next_sync_at = $3,
            locked_by = NULL,
            locked_until = NULL,
            updated_at = now()
        WHERE id = $1 AND locked_by = $2
        RETURNING connection_id
      )
      UPDATE social_connections
      SET last_scheduled_at = now(),
          next_sync_at = $3,
          updated_at = now()
      WHERE id IN (SELECT connection_id FROM updated_schedule)
    `,
    [input.scheduleId, input.schedulerId, nextSyncAt],
  );
  return nextSyncAt;
}

export async function enableSocialSyncSchedule(input: {
  connectionId: string;
  cadenceSeconds: number;
  nextSyncAt: Date;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO social_sync_schedules (connection_id, cadence_seconds, next_sync_at, enabled)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (connection_id) DO UPDATE SET
          cadence_seconds = EXCLUDED.cadence_seconds,
          next_sync_at = EXCLUDED.next_sync_at,
          enabled = true,
          updated_at = now()
      `,
      [input.connectionId, input.cadenceSeconds, input.nextSyncAt],
    );
    await client.query(
      `
        UPDATE social_connections
        SET sync_enabled = true,
            schedule_cadence_seconds = $2,
            next_sync_at = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [input.connectionId, input.cadenceSeconds, input.nextSyncAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
