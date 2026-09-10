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

export class MissingProviderDeletionDeadlinePolicyError extends Error {
  constructor(public readonly providerFamily: string) {
    super(
      `No data deletion deadline policy found for provider family '${providerFamily}'. A retention policy record or environment override is required.`,
    );
    this.name = "MissingProviderDeletionDeadlinePolicyError";
  }
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

  if (deadlineSeconds === null) {
    throw new MissingProviderDeletionDeadlinePolicyError(providerFamily);
  }

  return new Date(requestedAt.getTime() + deadlineSeconds * 1000);
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

export interface ExecuteProviderDataDeletionOptions {
  executor?: QueryExecutor;
  batchSize?: number;
}

export async function executeProviderDataDeletion(
  deletionRequestId: string,
  options: ExecuteProviderDataDeletionOptions = {},
): Promise<ProviderDataDeletionExecutionResult> {
  const pool = getPool();
  const client = (options.executor ?? (await pool.connect())) as PoolClient;
  const ownsClient = !options.executor;
  const batchSize = Math.max(1, options.batchSize ?? 100);

  try {
    if (ownsClient) await client.query("BEGIN");

    const reqRes = await client.query<{
      id: string;
      provider_family: string;
      scope_id: string | null;
      connection_id: string | null;
      status: string;
      completion_evidence: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT id, provider_family, scope_id, connection_id, status, completion_evidence, metadata
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
    let scopeId = request.scope_id;
    const connectionId = request.connection_id;

    if (connectionId && !scopeId) {
      const connScopeRes = await client.query<{ scope_id: string }>(
        "SELECT scope_id FROM social_connections WHERE id = $1 LIMIT 1",
        [connectionId],
      );
      if (connScopeRes.rows[0]?.scope_id) {
        scopeId = connScopeRes.rows[0].scope_id;
      }
    }

    const PHASES = [
      "CONTENT_OBSERVATIONS",
      "CANONICAL_ITEMS",
      "INTERACTION_OBSERVATIONS",
      "CANONICAL_INTERACTIONS",
      "ACCOUNT_OBSERVATIONS",
      "ACCOUNTS",
      "ACCOUNT_HANDLES",
      "CONTENT_METRICS",
    ] as const;

    type Phase = typeof PHASES[number];

    const currentMetadata: Record<string, unknown> = { ...(request.metadata ?? {}) };
    const savedProgress = currentMetadata.deletionProgress as
      | {
          phase?: Phase | "COMPLETED";
          counts?: Record<string, number>;
        }
      | undefined;

    const counts = {
      contentObservationsPurged: savedProgress?.counts?.contentObservationsPurged ?? 0,
      canonicalItemsPurged: savedProgress?.counts?.canonicalItemsPurged ?? 0,
      interactionsPurged: savedProgress?.counts?.interactionsPurged ?? 0,
      canonicalInteractionsPurged: savedProgress?.counts?.canonicalInteractionsPurged ?? 0,
      accountObservationsPurged: savedProgress?.counts?.accountObservationsPurged ?? 0,
      accountsSanitized: savedProgress?.counts?.accountsSanitized ?? 0,
      accountHandlesPurged: savedProgress?.counts?.accountHandlesPurged ?? 0,
      contentMetricsPurged: savedProgress?.counts?.contentMetricsPurged ?? 0,
    };

    let startPhaseIndex = 0;
    if (savedProgress?.phase) {
      const idx = PHASES.indexOf(savedProgress.phase as Phase);
      if (idx >= 0) {
        startPhaseIndex = idx;
      } else if (savedProgress.phase === "COMPLETED") {
        startPhaseIndex = PHASES.length;
      }
    }

    const checkpoint = async (nextPhase: Phase | "COMPLETED") => {
      currentMetadata.deletionProgress = {
        phase: nextPhase,
        counts: { ...counts },
      };
      await client.query(
        "UPDATE provider_data_deletion_requests SET metadata = $2::jsonb, updated_at = now() WHERE id = $1",
        [deletionRequestId, JSON.stringify(currentMetadata)],
      );
    };

    // Phase 1: CONTENT_OBSERVATIONS
    if (startPhaseIndex <= 0) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND sco.scope_id = $${params.length}`;
        }
        if (connectionId) {
          params.push(connectionId);
          where += ` AND sco.connection_id = $${params.length}`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const delRes = await client.query(
          `
            DELETE FROM social_content_observations
            WHERE id IN (
              SELECT sco.id
              FROM social_content_observations sco
              JOIN social_connections sc ON sco.connection_id = sc.id
              JOIN platforms p ON sc.platform_id = p.id
              WHERE ${where}
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = delRes.rowCount ?? 0;
        counts.contentObservationsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("CANONICAL_ITEMS");
    }

    // Phase 2: CANONICAL_ITEMS (Orphaned canonical items only if NO observation from any provider remains)
    if (startPhaseIndex <= 1) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND (sci.scope_id = $${params.length} OR sci.scope_id IS NULL)`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const delRes = await client.query(
          `
            DELETE FROM social_content_items
            WHERE id IN (
              SELECT sci.id
              FROM social_content_items sci
              JOIN platforms p ON sci.platform_id = p.id
              WHERE ${where}
                AND NOT EXISTS (
                  SELECT 1 FROM social_content_observations sco
                  WHERE sco.content_item_id = sci.id
                )
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = delRes.rowCount ?? 0;
        counts.canonicalItemsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("INTERACTION_OBSERVATIONS");
    }

    // Phase 3: INTERACTION_OBSERVATIONS
    if (startPhaseIndex <= 2) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND sio.scope_id = $${params.length}`;
        }
        if (connectionId) {
          params.push(connectionId);
          where += ` AND sio.connection_id = $${params.length}`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const delRes = await client.query(
          `
            DELETE FROM social_interaction_observations
            WHERE id IN (
              SELECT sio.id
              FROM social_interaction_observations sio
              JOIN social_connections sc ON sio.connection_id = sc.id
              JOIN platforms p ON sc.platform_id = p.id
              WHERE ${where}
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = delRes.rowCount ?? 0;
        counts.interactionsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("CANONICAL_INTERACTIONS");
    }

    // Phase 4: CANONICAL_INTERACTIONS
    if (startPhaseIndex <= 3) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND (si.scope_id = $${params.length} OR si.scope_id IS NULL)`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const delRes = await client.query(
          `
            DELETE FROM social_interactions
            WHERE id IN (
              SELECT si.id
              FROM social_interactions si
              JOIN platforms p ON si.platform_id = p.id
              WHERE ${where}
                AND NOT EXISTS (
                  SELECT 1 FROM social_interaction_observations sio
                  WHERE sio.interaction_id = si.id
                )
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = delRes.rowCount ?? 0;
        counts.canonicalInteractionsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("ACCOUNT_OBSERVATIONS");
    }

    // Phase 5: ACCOUNT_OBSERVATIONS
    if (startPhaseIndex <= 4) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND sao.scope_id = $${params.length}`;
        }
        if (connectionId) {
          params.push(connectionId);
          where += ` AND sao.connection_id = $${params.length}`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const delRes = await client.query(
          `
            DELETE FROM social_account_observations
            WHERE id IN (
              SELECT sao.id
              FROM social_account_observations sao
              JOIN social_connections sc ON sao.connection_id = sc.id
              JOIN platforms p ON sc.platform_id = p.id
              WHERE ${where}
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = delRes.rowCount ?? 0;
        counts.accountObservationsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("ACCOUNTS");
    }

    // Phase 6: ACCOUNTS (Sanitize orphaned external accounts)
    if (startPhaseIndex <= 5) {
      while (true) {
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
                metadata = (COALESCE(sea.metadata, '{}'::jsonb)) || jsonb_build_object(
                  'deletionRequestPurgedAt', now(),
                  'deletionRequestId', $2::text,
                  'providerFamily', $1::text
                ),
                updated_at = now()
            WHERE sea.id IN (
              SELECT sea2.id
              FROM social_external_accounts sea2
              JOIN platforms p ON p.id = sea2.platform_id
              WHERE COALESCE(p.provider_family, p.slug) = $1
                AND (sea2.metadata IS NULL OR NOT (sea2.metadata ? 'deletionRequestPurgedAt'))
                AND NOT EXISTS (
                  SELECT 1 FROM social_account_observations sao
                  WHERE sao.external_account_id = sea2.id
                )
              LIMIT $3
            )
          `,
          [providerFamily, deletionRequestId, batchSize],
        );
        const sanitized = sanitizeRes.rowCount ?? 0;
        counts.accountsSanitized += sanitized;
        if (sanitized < batchSize) break;
      }
      await checkpoint("ACCOUNT_HANDLES");
    }

    // Phase 7: ACCOUNT_HANDLES (Purge account handles for orphaned accounts)
    if (startPhaseIndex <= 6) {
      while (true) {
        const handleDelRes = await client.query(
          `
            DELETE FROM social_account_handles
            WHERE id IN (
              SELECT sah.id
              FROM social_account_handles sah
              JOIN social_external_accounts sea ON sea.id = sah.external_account_id
              JOIN platforms p ON p.id = sea.platform_id
              WHERE COALESCE(p.provider_family, p.slug) = $1
                AND NOT EXISTS (
                  SELECT 1 FROM social_account_observations sao
                  WHERE sao.external_account_id = sea.id
                )
              LIMIT $2
            )
          `,
          [providerFamily, batchSize],
        );
        const deleted = handleDelRes.rowCount ?? 0;
        counts.accountHandlesPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("CONTENT_METRICS");
    }

    // Phase 8: CONTENT_METRICS (Purge derivatives)
    if (startPhaseIndex <= 7) {
      while (true) {
        const params: unknown[] = [providerFamily];
        let where = "COALESCE(p.provider_family, p.slug) = $1";
        if (scopeId) {
          params.push(scopeId);
          where += ` AND scm.scope_id = $${params.length}`;
        }
        if (connectionId) {
          params.push(connectionId);
          where += ` AND scm.connection_id = $${params.length}`;
        }
        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const metricsDelRes = await client.query(
          `
            DELETE FROM social_content_metrics
            WHERE id IN (
              SELECT scm.id
              FROM social_content_metrics scm
              JOIN social_connections sc ON scm.connection_id = sc.id
              JOIN platforms p ON sc.platform_id = p.id
              WHERE ${where}
              LIMIT ${limitParam}
            )
          `,
          params,
        );
        const deleted = metricsDelRes.rowCount ?? 0;
        counts.contentMetricsPurged += deleted;
        if (deleted < batchSize) break;
      }
      await checkpoint("COMPLETED");
    }

    const evidence = {
      ...counts,
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
      ...counts,
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
