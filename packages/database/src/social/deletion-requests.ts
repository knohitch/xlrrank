import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  JOB_TYPES,
  PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
  QUEUE_NAMES,
  type JobStatus,
  type ProviderDataDeletionPayload,
} from "@xlrrank/queue";
import { getPool } from "../client.js";
import { safeJobError } from "./jobs.js";

type QueryExecutor = Pool | PoolClient;

export interface ProviderDataDeletionRequestRecord {
  id: string;
  providerFamily: string;
  scopeId: string | null;
  connectionId: string | null;
  providerAuthorizationId: string | null;
  reason: string;
  source: string;
  requestedAt: Date;
  deadlineAt: Date;
  status: JobStatus | string;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  failureEvidence: Record<string, unknown> | null;
  completedAt: Date | null;
  completionEvidence: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProviderDataDeletionInput {
  providerFamily: string;
  scopeId?: string | null;
  connectionId?: string | null;
  providerAuthorizationId?: string | null;
  reason: string;
  source: string;
  requestedAt?: Date;
  deadlineAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface CreateProviderDataDeletionResult {
  deletionRequestId: string;
  jobId: string;
  providerFamily: string;
  deadlineAt: Date;
  status: JobStatus;
  accepted: boolean;
  duplicate: boolean;
}

export interface ProviderDataDeletionExecutionResult {
  deletionRequestId: string;
  providerFamily: string;
  status: "COMPLETED" | "FAILED";
  contentObservationsPurged: number;
  canonicalItemsPurged: number;
  interactionsPurged: number;
  canonicalInteractionsPurged: number;
  accountObservationsPurged: number;
  accountsSanitized: number;
  accountHandlesPurged: number;
  contentMetricsPurged: number;
  evidence: Record<string, unknown>;
}

export async function calculateProviderDataDeletionDeadline(
  providerFamily: string,
  requestedAt = new Date(),
  executor: QueryExecutor = getPool(),
): Promise<Date> {
  const res = await executor.query<{
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT metadata
      FROM provider_data_retention_policies
      WHERE provider_family = $1
        AND metadata IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [providerFamily],
  );

  let deadlineSeconds: number | null = null;
  const meta = res.rows[0]?.metadata;
  if (typeof meta?.deletionRequestDeadlineSeconds === "number") {
    deadlineSeconds = meta.deletionRequestDeadlineSeconds;
  } else if (typeof meta?.dpaDeletionDeadlineDays === "number") {
    deadlineSeconds = meta.dpaDeletionDeadlineDays * 86400;
  } else {
    const upper = providerFamily.toUpperCase().replaceAll("-", "_");
    const envVal =
      process.env[`PROVIDER_DATA_DELETION_DEADLINE_SECONDS_${upper}`] ??
      process.env[`${upper}_DATA_DELETION_DEADLINE_SECONDS`];
    if (envVal) {
      const parsed = parseInt(envVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) deadlineSeconds = parsed;
    }
  }

  // Default fallback if no provider policy establishes a deadline: 30 days
  const effectiveSeconds = deadlineSeconds ?? 30 * 86400;
  return new Date(requestedAt.getTime() + effectiveSeconds * 1000);
}

export async function createProviderDataDeletionRequest(
  input: CreateProviderDataDeletionInput,
  executor?: PoolClient,
): Promise<CreateProviderDataDeletionResult> {
  const pool = getPool();
  const client = executor ?? (await pool.connect());
  const ownsClient = !executor;

  try {
    if (ownsClient) await client.query("BEGIN");

    const requestedAt = input.requestedAt ?? new Date();
    const deadlineAt =
      input.deadlineAt ??
      (await calculateProviderDataDeletionDeadline(input.providerFamily, requestedAt, client));

    const idempotencyKey = `provider-deletion:${input.providerFamily}:${input.scopeId ?? "global"}:${input.connectionId ?? "all"}`;
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
      [JOB_TYPES.providerDataDeletion, idempotencyKey],
    );

    if (active.rows[0]) {
      const existingReq = await client.query<{ id: string }>(
        `
          SELECT id
          FROM provider_data_deletion_requests
          WHERE provider_family = $1
            AND ($2::uuid IS NULL OR scope_id = $2)
            AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING')
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [input.providerFamily, input.scopeId ?? null],
      );

      if (ownsClient) await client.query("COMMIT");
      return {
        deletionRequestId: existingReq.rows[0]?.id ?? "",
        jobId: active.rows[0].id,
        providerFamily: input.providerFamily,
        deadlineAt,
        status: active.rows[0].status,
        accepted: false,
        duplicate: true,
      };
    }

    const deletionRequestId = randomUUID();
    const jobId = randomUUID();

    await client.query(
      `
        INSERT INTO provider_data_deletion_requests (
          id, provider_family, scope_id, connection_id, provider_authorization_id,
          reason, source, requested_at, deadline_at, status, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_DISPATCH', $10::jsonb)
      `,
      [
        deletionRequestId,
        input.providerFamily,
        input.scopeId ?? null,
        input.connectionId ?? null,
        input.providerAuthorizationId ?? null,
        input.reason,
        input.source,
        requestedAt,
        deadlineAt,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const payload: ProviderDataDeletionPayload = {
      version: PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
      jobRequestId: jobId,
      deletionRequestId,
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
        JOB_TYPES.providerDataDeletion,
        QUEUE_NAMES.ingestion,
        JSON.stringify(payload),
        PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
        idempotencyKey,
      ],
    );

    await client.query(
      `
        INSERT INTO job_outbox (job_id, queue_name, job_type, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [jobId, QUEUE_NAMES.ingestion, JOB_TYPES.providerDataDeletion, JSON.stringify(payload)],
    );

    if (ownsClient) await client.query("COMMIT");

    return {
      deletionRequestId,
      jobId,
      providerFamily: input.providerFamily,
      deadlineAt,
      status: "PENDING_DISPATCH",
      accepted: true,
      duplicate: false,
    };
  } catch (err) {
    if (ownsClient) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

export async function executeProviderDataDeletion(
  deletionRequestId: string,
  options: { executor?: QueryExecutor } = {},
): Promise<ProviderDataDeletionExecutionResult> {
  const pool = getPool();
  const client = (options.executor ?? (await pool.connect())) as PoolClient;
  const ownsClient = !options.executor;

  try {
    if (ownsClient) await client.query("BEGIN");

    const reqRes = await client.query<{
      id: string;
      provider_family: string;
      scope_id: string | null;
      connection_id: string | null;
      status: string;
      completion_evidence: Record<string, unknown> | null;
    }>(
      `
        SELECT id, provider_family, scope_id, connection_id, status, completion_evidence
        FROM provider_data_deletion_requests
        WHERE id = $1
        FOR UPDATE
      `,
      [deletionRequestId],
    );

    const request = reqRes.rows[0];
    if (!request) {
      throw new Error(`Provider data deletion request '${deletionRequestId}' not found`);
    }

    if (request.status === "COMPLETED" && request.completion_evidence) {
      if (ownsClient) await client.query("COMMIT");
      return {
        deletionRequestId,
        providerFamily: request.provider_family,
        status: "COMPLETED",
        contentObservationsPurged: (request.completion_evidence.contentObservationsPurged as number) ?? 0,
        canonicalItemsPurged: (request.completion_evidence.canonicalItemsPurged as number) ?? 0,
        interactionsPurged: (request.completion_evidence.interactionsPurged as number) ?? 0,
        canonicalInteractionsPurged:
          (request.completion_evidence.canonicalInteractionsPurged as number) ?? 0,
        accountObservationsPurged:
          (request.completion_evidence.accountObservationsPurged as number) ?? 0,
        accountsSanitized: (request.completion_evidence.accountsSanitized as number) ?? 0,
        accountHandlesPurged: (request.completion_evidence.accountHandlesPurged as number) ?? 0,
        contentMetricsPurged: (request.completion_evidence.contentMetricsPurged as number) ?? 0,
        evidence: request.completion_evidence,
      };
    }

    await client.query(
      "UPDATE provider_data_deletion_requests SET status = 'RUNNING', updated_at = now() WHERE id = $1",
      [deletionRequestId],
    );

    const providerFamily = request.provider_family;
    const scopeId = request.scope_id;
    const connectionId = request.connection_id;

    // 1. Purge content observations for this provider family (and optional scope / connection)
    const scopeObsFilter = scopeId ? "AND sco.scope_id = $2" : "";
    const connObsFilter = connectionId ? "AND sco.connection_id = $3" : "";
    const obsParams: unknown[] = [providerFamily];
    if (scopeId) obsParams.push(scopeId);
    if (connectionId) obsParams.push(connectionId);

    const delObsRes = await client.query<{ content_item_id: string }>(
      `
        DELETE FROM social_content_observations sco
        USING social_connections sc, platforms p
        WHERE sco.connection_id = sc.id
          AND sc.platform_id = p.id
          AND COALESCE(p.provider_family, p.slug) = $1
          ${scopeObsFilter}
          ${connObsFilter}
        RETURNING sco.content_item_id
      `,
      obsParams,
    );
    const contentObservationsPurged = delObsRes.rowCount ?? 0;

    // Clean orphaned canonical items ONLY IF no other observation from another provider exists
    let canonicalItemsPurged = 0;
    const candidateItemIds = [...new Set(delObsRes.rows.map((r) => r.content_item_id))];
    if (candidateItemIds.length > 0) {
      const orphanDel = await client.query(
        `
          DELETE FROM social_content_items sci
          WHERE sci.id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM social_content_observations sco
              WHERE sco.content_item_id = sci.id
            )
        `,
        [candidateItemIds],
      );
      canonicalItemsPurged = orphanDel.rowCount ?? 0;
    }

    // 2. Purge interaction observations and orphaned canonical interactions
    const scopeIntFilter = scopeId ? "AND sio.scope_id = $2" : "";
    const connIntFilter = connectionId ? "AND sio.connection_id = $3" : "";
    const delIntObsRes = await client.query<{ interaction_id: string }>(
      `
        DELETE FROM social_interaction_observations sio
        USING social_connections sc, platforms p
        WHERE sio.connection_id = sc.id
          AND sc.platform_id = p.id
          AND COALESCE(p.provider_family, p.slug) = $1
          ${scopeIntFilter}
          ${connIntFilter}
        RETURNING sio.interaction_id
      `,
      obsParams,
    );
    const interactionsPurged = delIntObsRes.rowCount ?? 0;

    let canonicalInteractionsPurged = 0;
    const candidateIntIds = [...new Set(delIntObsRes.rows.map((r) => r.interaction_id))];
    if (candidateIntIds.length > 0) {
      const orphanIntDel = await client.query(
        `
          DELETE FROM social_interactions si
          WHERE si.id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM social_interaction_observations sio
              WHERE sio.interaction_id = si.id
            )
        `,
        [candidateIntIds],
      );
      canonicalInteractionsPurged = orphanIntDel.rowCount ?? 0;
    }

    // 3. Purge account observations
    const delAcctObsRes = await client.query<{ external_account_id: string }>(
      `
        DELETE FROM social_account_observations sao
        USING social_connections sc, platforms p
        WHERE sao.connection_id = sc.id
          AND sc.platform_id = p.id
          AND COALESCE(p.provider_family, p.slug) = $1
          ${scopeId ? "AND sao.scope_id = $2" : ""}
          ${connectionId ? "AND sao.connection_id = $3" : ""}
        RETURNING sao.external_account_id
      `,
      obsParams,
    );
    const accountObservationsPurged = delAcctObsRes.rowCount ?? 0;

    // Sanitize external accounts for this provider family where no observations remain
    const sanitizeRes = await client.query(
      `
        UPDATE social_external_accounts sea
        SET current_handle = NULL,
            display_name = NULL,
            profile_url = NULL,
            profile_image_url = NULL,
            bio = NULL,
            location = NULL,
            website = NULL,
            follower_count = NULL,
            following_count = NULL,
            metadata = jsonb_build_object(
              'deletionRequestPurgedAt', now(),
              'deletionRequestId', $2::text,
              'providerFamily', $1::text
            ),
            updated_at = now()
        FROM platforms p
        WHERE p.id = sea.platform_id
          AND COALESCE(p.provider_family, p.slug) = $1
          AND NOT EXISTS (
            SELECT 1 FROM social_account_observations sao
            WHERE sao.external_account_id = sea.id
          )
      `,
      [providerFamily, deletionRequestId],
    );
    const accountsSanitized = sanitizeRes.rowCount ?? 0;

    // Purge account handles for orphaned accounts
    const handleDelRes = await client.query(
      `
        DELETE FROM social_account_handles sah
        USING social_external_accounts sea, platforms p
        WHERE sea.id = sah.external_account_id
          AND p.id = sea.platform_id
          AND COALESCE(p.provider_family, p.slug) = $1
          AND NOT EXISTS (
            SELECT 1 FROM social_account_observations sao
            WHERE sao.external_account_id = sea.id
          )
      `,
      [providerFamily],
    );
    const accountHandlesPurged = handleDelRes.rowCount ?? 0;

    // 4. Purge content metrics (derivatives)
    const metricsDelRes = await client.query(
      `
        DELETE FROM social_content_metrics scm
        USING social_connections sc, platforms p
        WHERE scm.connection_id = sc.id
          AND sc.platform_id = p.id
          AND COALESCE(p.provider_family, p.slug) = $1
          ${scopeId ? "AND scm.scope_id = $2" : ""}
      `,
      scopeId ? [providerFamily, scopeId] : [providerFamily],
    );
    const contentMetricsPurged = metricsDelRes.rowCount ?? 0;

    const evidence = {
      contentObservationsPurged,
      canonicalItemsPurged,
      interactionsPurged,
      canonicalInteractionsPurged,
      accountObservationsPurged,
      accountsSanitized,
      accountHandlesPurged,
      contentMetricsPurged,
      executedAt: new Date().toISOString(),
    };

    await client.query(
      `
        UPDATE provider_data_deletion_requests
        SET status = 'COMPLETED',
            completed_at = now(),
            completion_evidence = $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [deletionRequestId, JSON.stringify(evidence)],
    );

    // Also mark associated jobs COMPLETED
    await client.query(
      `
        UPDATE jobs
        SET status = 'COMPLETED',
            completed_at = now(),
            updated_at = now()
        WHERE payload->>'deletionRequestId' = $1
          AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING')
      `,
      [deletionRequestId],
    );

    if (ownsClient) await client.query("COMMIT");

    return {
      deletionRequestId,
      providerFamily,
      status: "COMPLETED",
      contentObservationsPurged,
      canonicalItemsPurged,
      interactionsPurged,
      canonicalInteractionsPurged,
      accountObservationsPurged,
      accountsSanitized,
      accountHandlesPurged,
      contentMetricsPurged,
      evidence,
    };
  } catch (err) {
    if (ownsClient) await client.query("ROLLBACK");
    await client
      .query(
        `
          UPDATE provider_data_deletion_requests
          SET status = 'FAILED',
              failure_evidence = $2::jsonb,
              attempt_count = attempt_count + 1,
              updated_at = now()
          WHERE id = $1
        `,
        [deletionRequestId, JSON.stringify(safeJobError(err))],
      )
      .catch(() => undefined);
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}
