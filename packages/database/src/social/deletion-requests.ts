import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  JOB_TYPES,
  PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
  QUEUE_NAMES,
  parseProviderDataDeletionPayload,
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
  status: "COMPLETED" | "FAILED" | "IN_PROGRESS";
  continuationJobId?: string | undefined;
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

function providerDataDeletionIdempotencyKey(input: CreateProviderDataDeletionInput): string {
  const scopeIdentity =
    input.scopeId ?? (input.metadata?.privilegedProviderDeletion === true ? "provider-wide" : "unspecified");
  return [
    "provider-deletion:v2",
    `provider:${input.providerFamily}`,
    `scope:${scopeIdentity}`,
    `connection:${input.connectionId ?? "all"}`,
    `authorization:${input.providerAuthorizationId ?? "all"}`,
  ].join(":");
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

    if (!input.scopeId && !input.connectionId && !input.providerAuthorizationId) {
      if (input.metadata?.privilegedProviderDeletion !== true) {
        throw new Error("Missing scope identifiers. For a provider-family-wide deletion, you must explicitly set metadata.privilegedProviderDeletion = true");
      }
    }

    const deadlineAt =
      input.deadlineAt ??
      (await calculateProviderDataDeletionDeadline(input.providerFamily, requestedAt, client));

    const idempotencyKey = providerDataDeletionIdempotencyKey(input);
    const active = await client.query<{ id: string; status: JobStatus; payload: unknown }>(
      `
        SELECT id, status, payload
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
      const activeJob = active.rows[0];
      const activePayload = parseProviderDataDeletionPayload(activeJob.payload);
      if (activePayload.jobRequestId !== activeJob.id) {
        throw new Error(`Active provider data deletion job '${activeJob.id}' has mismatched payload jobRequestId`);
      }

      const existingReq = await client.query<{
        id: string;
        provider_family: string;
        deadline_at: Date;
      }>(
        `
          SELECT id, provider_family, deadline_at
          FROM provider_data_deletion_requests
          WHERE id = $1
            AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING')
          LIMIT 1
        `,
        [activePayload.deletionRequestId],
      );
      if (!existingReq.rows[0]) {
        throw new Error(
          `Active provider data deletion job '${activeJob.id}' references missing or inactive deletion request '${activePayload.deletionRequestId}'`,
        );
      }

      if (ownsClient) await client.query("COMMIT");
      return {
        deletionRequestId: existingReq.rows[0].id,
        jobId: activeJob.id,
        providerFamily: existingReq.rows[0].provider_family,
        deadlineAt: existingReq.rows[0].deadline_at,
        status: activeJob.status,
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
  maxBatchesPerInvocation?: number;
  currentJobId?: string;
}

const DELETION_PHASES = [
  "CONTENT_OBSERVATIONS",
  "CANONICAL_ITEMS",
  "INTERACTION_OBSERVATIONS",
  "CANONICAL_INTERACTIONS",
  "ACCOUNT_OBSERVATIONS",
  "ACCOUNTS",
  "ACCOUNT_HANDLES",
  "CONTENT_METRICS",
] as const;

type DeletionPhase = (typeof DELETION_PHASES)[number];
type DeletionProgressPhase = DeletionPhase | "COMPLETED";
type DeletionTargetType = "CONTENT_ITEM" | "INTERACTION" | "EXTERNAL_ACCOUNT";

type DeletionCounts = Omit<
  ProviderDataDeletionExecutionResult,
  "deletionRequestId" | "providerFamily" | "status" | "evidence" | "continuationJobId"
>;

function emptyDeletionCounts(): DeletionCounts {
  return {
    contentObservationsPurged: 0,
    canonicalItemsPurged: 0,
    interactionsPurged: 0,
    canonicalInteractionsPurged: 0,
    accountObservationsPurged: 0,
    accountsSanitized: 0,
    accountHandlesPurged: 0,
    contentMetricsPurged: 0,
  };
}

function countsFromEvidence(evidence: Record<string, unknown> | null): DeletionCounts {
  const counts = emptyDeletionCounts();
  if (!evidence) return counts;
  for (const key of Object.keys(counts) as Array<keyof DeletionCounts>) {
    const value = evidence[key];
    if (typeof value === "number") counts[key] = value;
  }
  return counts;
}

function progressFromMetadata(metadata: Record<string, unknown> | null): {
  phase: DeletionProgressPhase;
  counts: DeletionCounts;
} {
  const progress = metadata?.deletionProgress as
    | { phase?: DeletionProgressPhase; counts?: Record<string, number> }
    | undefined;
  const phase = progress?.phase ?? "CONTENT_OBSERVATIONS";
  const counts = emptyDeletionCounts();
  for (const key of Object.keys(counts) as Array<keyof DeletionCounts>) {
    const value = progress?.counts?.[key];
    if (typeof value === "number") counts[key] = value;
  }
  return {
    phase: phase === "COMPLETED" || DELETION_PHASES.includes(phase as DeletionPhase) ? phase : "CONTENT_OBSERVATIONS",
    counts,
  };
}

async function checkpointDeletionProgress(
  client: PoolClient,
  deletionRequestId: string,
  metadata: Record<string, unknown> | null,
  phase: DeletionProgressPhase,
  counts: DeletionCounts,
): Promise<void> {
  const nextMetadata = { ...(metadata ?? {}) };
  nextMetadata.deletionProgress = {
    phase,
    counts: { ...counts },
  };
  await client.query(
    "UPDATE provider_data_deletion_requests SET metadata = $2::jsonb, updated_at = now() WHERE id = $1",
    [deletionRequestId, JSON.stringify(nextMetadata)],
  );
}

async function insertDeletionTargets(
  client: PoolClient,
  deletionRequestId: string,
  entityType: DeletionTargetType,
  entityIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(entityIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  await client.query(
    `
      INSERT INTO provider_data_deletion_targets (deletion_request_id, entity_type, entity_id)
      SELECT $1, $2, unnest($3::uuid[])
      ON CONFLICT (deletion_request_id, entity_type, entity_id)
      DO UPDATE SET updated_at = now()
    `,
    [deletionRequestId, entityType, uniqueIds],
  );
}

async function createContinuationJobTx(
  client: PoolClient,
  input: {
    deletionRequestId: string;
    currentJobId?: string;
  },
): Promise<string | undefined> {
  if (input.currentJobId) {
    await client.query(
      `
        UPDATE jobs
        SET status = 'COMPLETED',
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
        WHERE id = $1
      `,
      [input.currentJobId],
    );
  }

  const idempotencyKey = `provider-deletion-continuation:${input.deletionRequestId}`;
  const active = await client.query<{ id: string }>(
    `
      SELECT id
      FROM jobs
      WHERE type = $1
        AND idempotency_key = $2
        AND ($3::uuid IS NULL OR id <> $3)
        AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [JOB_TYPES.providerDataDeletion, idempotencyKey, input.currentJobId ?? null],
  );
  if (active.rows[0]) return active.rows[0].id;

  const jobId = randomUUID();
  const payload: ProviderDataDeletionPayload = {
    version: PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
    jobRequestId: jobId,
    deletionRequestId: input.deletionRequestId,
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
    "INSERT INTO job_outbox (job_id, queue_name, job_type, payload) VALUES ($1, $2, $3, $4::jsonb)",
    [jobId, QUEUE_NAMES.ingestion, JOB_TYPES.providerDataDeletion, JSON.stringify(payload)],
  );

  return jobId;
}

async function completeCurrentDeletionJob(client: PoolClient, currentJobId?: string): Promise<void> {
  if (!currentJobId) return;
  await client.query(
    `
      UPDATE jobs
      SET status = 'COMPLETED',
          completed_at = COALESCE(completed_at, now()),
          updated_at = now()
      WHERE id = $1
    `,
    [currentJobId],
  );
}

export async function executeProviderDataDeletion(
  deletionRequestId: string,
  options: ExecuteProviderDataDeletionOptions = {},
): Promise<ProviderDataDeletionExecutionResult> {
  const pool = getPool();
  const client = (options.executor ?? (await pool.connect())) as PoolClient;
  const ownsClient = !options.executor;
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const currentJobId = options.currentJobId;

  try {
    if (ownsClient) await client.query("BEGIN");

    const reqRes = await client.query<{
      id: string;
      provider_family: string;
      scope_id: string | null;
      connection_id: string | null;
      provider_authorization_id: string | null;
      status: string;
      completion_evidence: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT id, provider_family, scope_id, connection_id, provider_authorization_id, status, completion_evidence, metadata
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
      await completeCurrentDeletionJob(client, currentJobId);
      if (ownsClient) await client.query("COMMIT");
      return {
        deletionRequestId,
        providerFamily: request.provider_family,
        status: "COMPLETED",
        ...countsFromEvidence(request.completion_evidence),
        evidence: request.completion_evidence,
      };
    }

    await client.query(
      "UPDATE provider_data_deletion_requests SET status = 'RUNNING', updated_at = now() WHERE id = $1",
      [deletionRequestId],
    );

    const providerFamily = request.provider_family;
    let scopeId = request.scope_id;
    let connectionIds: string[] | null = request.connection_id ? [request.connection_id] : null;

    if (request.provider_authorization_id) {
      const authRes = await client.query<{
        scope_id: string;
        provider_family: string;
        provider_user_id: string;
      }>(
        "SELECT scope_id, provider_family, provider_user_id FROM provider_authorizations WHERE id = $1 LIMIT 1",
        [request.provider_authorization_id],
      );
      const auth = authRes.rows[0];
      if (!auth) {
        throw new Error(`Provider authorization '${request.provider_authorization_id}' not found`);
      }
      if (auth.provider_family !== request.provider_family) {
        throw new Error(`Provider family mismatch for authorization '${request.provider_authorization_id}'`);
      }
      if (request.scope_id && request.scope_id !== auth.scope_id) {
        throw new Error(`Scope mismatch for authorization '${request.provider_authorization_id}'`);
      }
      if (request.connection_id) {
        const connScopeRes = await client.query<{ scope_id: string }>(
          "SELECT scope_id FROM social_connections WHERE id = $1 LIMIT 1",
          [request.connection_id],
        );
        if (connScopeRes.rows[0]?.scope_id !== auth.scope_id) {
          throw new Error(`Connection scope mismatch for authorization '${request.provider_authorization_id}'`);
        }
      }
      if (!scopeId) {
        scopeId = auth.scope_id;
      }

      const mappedConnections = await client.query<{ social_connection_id: string }>(
        `
          SELECT DISTINCT pes.social_connection_id
          FROM provider_event_subscriptions pes
          JOIN social_connections sc ON sc.id = pes.social_connection_id
          JOIN platforms p ON p.id = sc.platform_id
          WHERE pes.provider_authorization_id = $1
            AND pes.provider_family = $2
            AND pes.scope_id = $3
            AND COALESCE(p.provider_family, p.slug) = $2
            AND ($4::uuid IS NULL OR pes.social_connection_id = $4)
        `,
        [request.provider_authorization_id, providerFamily, auth.scope_id, request.connection_id ?? null],
      );
      if (mappedConnections.rows.length === 0) {
        throw new Error(
          `Provider authorization '${request.provider_authorization_id}' is not mapped to deletable social connection provenance`,
        );
      }
      connectionIds = mappedConnections.rows.map((row) => row.social_connection_id);
    }

    if (request.connection_id) {
      const connRes = await client.query<{ scope_id: string; provider_family: string }>(
        `
          SELECT sc.scope_id, COALESCE(p.provider_family, p.slug) AS provider_family
          FROM social_connections sc
          JOIN platforms p ON p.id = sc.platform_id
          WHERE sc.id = $1
          LIMIT 1
        `,
        [request.connection_id],
      );
      const conn = connRes.rows[0];
      if (!conn) {
        throw new Error(`Social connection '${request.connection_id}' not found`);
      }
      if (scopeId && scopeId !== conn.scope_id) {
        throw new Error(`Scope mismatch for connection '${request.connection_id}'`);
      }
      if (conn.provider_family !== providerFamily) {
        throw new Error(`Provider family mismatch for connection '${request.connection_id}'`);
      }
      if (!scopeId) {
        scopeId = conn.scope_id;
      }
    }

    const currentMetadata: Record<string, unknown> = { ...(request.metadata ?? {}) };
    const progress = progressFromMetadata(currentMetadata);
    const counts = progress.counts;

    const finishInProgress = async (phase: DeletionProgressPhase) => {
      await checkpointDeletionProgress(client, deletionRequestId, currentMetadata, phase, counts);
      const continuationJobId = currentJobId
        ? await createContinuationJobTx(client, { deletionRequestId, currentJobId })
        : undefined;
      if (ownsClient) await client.query("COMMIT");
      return {
        deletionRequestId,
        providerFamily,
        status: "IN_PROGRESS" as const,
        continuationJobId,
        ...counts,
        evidence: { phase, continuationJobId },
      };
    };

    const appendScopeFilters = (params: unknown[], alias: string): string => {
      let where = "";
      if (scopeId) {
        params.push(scopeId);
        where += ` AND ${alias}.scope_id = $${params.length}`;
      }
      if (connectionIds) {
        params.push(connectionIds);
        where += ` AND ${alias}.connection_id = ANY($${params.length}::uuid[])`;
      }
      return where;
    };

    if (progress.phase === "CONTENT_OBSERVATIONS") {
      const params: unknown[] = [providerFamily];
      const filters = appendScopeFilters(params, "sco");
      params.push(batchSize);
      const delRes = await client.query<{ content_item_id: string }>(
        `
          DELETE FROM social_content_observations
          WHERE id IN (
            SELECT sco.id
            FROM social_content_observations sco
            JOIN social_connections sc ON sco.connection_id = sc.id
            JOIN platforms p ON sc.platform_id = p.id
            WHERE COALESCE(p.provider_family, p.slug) = $1
              ${filters}
            ORDER BY sco.id ASC
            LIMIT $${params.length}
          )
          RETURNING content_item_id
        `,
        params,
      );
      const deleted = delRes.rowCount ?? 0;
      counts.contentObservationsPurged += deleted;
      await insertDeletionTargets(
        client,
        deletionRequestId,
        "CONTENT_ITEM",
        delRes.rows.map((row) => row.content_item_id),
      );
      return finishInProgress(deleted < batchSize ? "CANONICAL_ITEMS" : "CONTENT_OBSERVATIONS");
    }

    if (progress.phase === "CANONICAL_ITEMS") {
      const params: unknown[] = [deletionRequestId, providerFamily, batchSize];
      const delRes = await client.query<{ id: string }>(
        `
          WITH candidates AS (
            SELECT sci.id
            FROM provider_data_deletion_targets pddt
            JOIN social_content_items sci ON sci.id = pddt.entity_id
            JOIN platforms p ON sci.platform_id = p.id
            WHERE pddt.deletion_request_id = $1
              AND pddt.entity_type = 'CONTENT_ITEM'
              AND COALESCE(p.provider_family, p.slug) = $2
              AND NOT EXISTS (
                SELECT 1 FROM social_content_observations sco
                WHERE sco.content_item_id = sci.id
              )
            ORDER BY pddt.entity_id ASC
            LIMIT $3
          ),
          deleted AS (
            DELETE FROM social_content_items sci
            USING candidates c
            WHERE sci.id = c.id
            RETURNING sci.id
          )
          UPDATE provider_data_deletion_targets pddt
          SET status = 'PURGED', updated_at = now()
          FROM deleted d
          WHERE pddt.deletion_request_id = $1
            AND pddt.entity_type = 'CONTENT_ITEM'
            AND pddt.entity_id = d.id
          RETURNING d.id
        `,
        params,
      );
      const deleted = delRes.rowCount ?? 0;
      counts.canonicalItemsPurged += deleted;
      return finishInProgress(deleted < batchSize ? "INTERACTION_OBSERVATIONS" : "CANONICAL_ITEMS");
    }

    if (progress.phase === "INTERACTION_OBSERVATIONS") {
      const params: unknown[] = [providerFamily];
      const filters = appendScopeFilters(params, "sio");
      params.push(batchSize);
      const delRes = await client.query<{ interaction_id: string }>(
        `
          DELETE FROM social_interaction_observations
          WHERE id IN (
            SELECT sio.id
            FROM social_interaction_observations sio
            JOIN social_connections sc ON sio.connection_id = sc.id
            JOIN platforms p ON sc.platform_id = p.id
            WHERE COALESCE(p.provider_family, p.slug) = $1
              ${filters}
            ORDER BY sio.id ASC
            LIMIT $${params.length}
          )
          RETURNING interaction_id
        `,
        params,
      );
      const deleted = delRes.rowCount ?? 0;
      counts.interactionsPurged += deleted;
      await insertDeletionTargets(
        client,
        deletionRequestId,
        "INTERACTION",
        delRes.rows.map((row) => row.interaction_id),
      );
      return finishInProgress(deleted < batchSize ? "CANONICAL_INTERACTIONS" : "INTERACTION_OBSERVATIONS");
    }

    if (progress.phase === "CANONICAL_INTERACTIONS") {
      const delRes = await client.query<{ id: string }>(
        `
          WITH candidates AS (
            SELECT si.id
            FROM provider_data_deletion_targets pddt
            JOIN social_interactions si ON si.id = pddt.entity_id
            JOIN platforms p ON si.platform_id = p.id
            WHERE pddt.deletion_request_id = $1
              AND pddt.entity_type = 'INTERACTION'
              AND COALESCE(p.provider_family, p.slug) = $2
              AND NOT EXISTS (
                SELECT 1 FROM social_interaction_observations sio
                WHERE sio.interaction_id = si.id
              )
            ORDER BY pddt.entity_id ASC
            LIMIT $3
          ),
          deleted AS (
            DELETE FROM social_interactions si
            USING candidates c
            WHERE si.id = c.id
            RETURNING si.id
          )
          UPDATE provider_data_deletion_targets pddt
          SET status = 'PURGED', updated_at = now()
          FROM deleted d
          WHERE pddt.deletion_request_id = $1
            AND pddt.entity_type = 'INTERACTION'
            AND pddt.entity_id = d.id
          RETURNING d.id
        `,
        [deletionRequestId, providerFamily, batchSize],
      );
      const deleted = delRes.rowCount ?? 0;
      counts.canonicalInteractionsPurged += deleted;
      return finishInProgress(deleted < batchSize ? "ACCOUNT_OBSERVATIONS" : "CANONICAL_INTERACTIONS");
    }

    if (progress.phase === "ACCOUNT_OBSERVATIONS") {
      const params: unknown[] = [providerFamily];
      const filters = appendScopeFilters(params, "sao");
      params.push(batchSize);
      const delRes = await client.query<{ external_account_id: string }>(
        `
          DELETE FROM social_account_observations
          WHERE id IN (
            SELECT sao.id
            FROM social_account_observations sao
            JOIN social_connections sc ON sao.connection_id = sc.id
            JOIN platforms p ON sc.platform_id = p.id
            WHERE COALESCE(p.provider_family, p.slug) = $1
              ${filters}
            ORDER BY sao.id ASC
            LIMIT $${params.length}
          )
          RETURNING external_account_id
        `,
        params,
      );
      const deleted = delRes.rowCount ?? 0;
      counts.accountObservationsPurged += deleted;
      await insertDeletionTargets(
        client,
        deletionRequestId,
        "EXTERNAL_ACCOUNT",
        delRes.rows.map((row) => row.external_account_id),
      );
      return finishInProgress(deleted < batchSize ? "ACCOUNTS" : "ACCOUNT_OBSERVATIONS");
    }

    if (progress.phase === "ACCOUNTS") {
      const seedParams: unknown[] = [deletionRequestId, providerFamily, batchSize];
      let seedFilters = "";
      if (scopeId) {
        seedParams.push(scopeId);
        seedFilters += ` AND sc.scope_id = $${seedParams.length}`;
      }
      if (connectionIds) {
        seedParams.push(connectionIds);
        seedFilters += ` AND sc.id = ANY($${seedParams.length}::uuid[])`;
      }
      const seedRes = await client.query<{ entity_id: string }>(
        `
          INSERT INTO provider_data_deletion_targets (deletion_request_id, entity_type, entity_id)
          SELECT $1, 'EXTERNAL_ACCOUNT', sc.external_account_id
          FROM social_connections sc
          JOIN platforms p ON p.id = sc.platform_id
          WHERE COALESCE(p.provider_family, p.slug) = $2
            AND sc.external_account_id IS NOT NULL
            ${seedFilters}
            AND NOT EXISTS (
              SELECT 1
              FROM provider_data_deletion_targets pddt
              WHERE pddt.deletion_request_id = $1
                AND pddt.entity_type = 'EXTERNAL_ACCOUNT'
                AND pddt.entity_id = sc.external_account_id
            )
          ORDER BY sc.external_account_id ASC
          LIMIT $3
          ON CONFLICT (deletion_request_id, entity_type, entity_id) DO NOTHING
          RETURNING entity_id
        `,
        seedParams,
      );
      if ((seedRes.rowCount ?? 0) >= batchSize) {
        return finishInProgress("ACCOUNTS");
      }

      const sanitizeRes = await client.query<{ id: string }>(
        `
          WITH candidates AS (
            SELECT sea.id
            FROM provider_data_deletion_targets pddt
            JOIN social_external_accounts sea ON sea.id = pddt.entity_id
            JOIN platforms p ON p.id = sea.platform_id
            WHERE pddt.deletion_request_id = $1
              AND pddt.entity_type = 'EXTERNAL_ACCOUNT'
              AND pddt.status = 'PENDING'
              AND COALESCE(p.provider_family, p.slug) = $2
              AND (sea.metadata IS NULL OR NOT (sea.metadata ? 'deletionRequestPurgedAt'))
              AND NOT EXISTS (
                SELECT 1 FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
              )
            ORDER BY pddt.entity_id ASC
            LIMIT $3
          ),
          sanitized AS (
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
                  'deletionRequestId', $1::text,
                  'providerFamily', $2::text
                ),
                updated_at = now()
            FROM candidates c
            WHERE sea.id = c.id
            RETURNING sea.id
          )
          UPDATE provider_data_deletion_targets pddt
          SET status = 'PURGED', updated_at = now()
          FROM sanitized s
          WHERE pddt.deletion_request_id = $1
            AND pddt.entity_type = 'EXTERNAL_ACCOUNT'
            AND pddt.entity_id = s.id
          RETURNING s.id
        `,
        [deletionRequestId, providerFamily, batchSize],
      );
      const sanitized = sanitizeRes.rowCount ?? 0;
      counts.accountsSanitized += sanitized;
      return finishInProgress(sanitized < batchSize ? "ACCOUNT_HANDLES" : "ACCOUNTS");
    }

    if (progress.phase === "ACCOUNT_HANDLES") {
      const handleDelRes = await client.query(
        `
          DELETE FROM social_account_handles
          WHERE id IN (
            SELECT sah.id
            FROM social_account_handles sah
            JOIN provider_data_deletion_targets pddt
              ON pddt.entity_id = sah.external_account_id
            JOIN social_external_accounts sea ON sea.id = sah.external_account_id
            JOIN platforms p ON p.id = sea.platform_id
            WHERE pddt.deletion_request_id = $1
              AND pddt.entity_type = 'EXTERNAL_ACCOUNT'
              AND COALESCE(p.provider_family, p.slug) = $2
              AND NOT EXISTS (
                SELECT 1 FROM social_account_observations sao
                WHERE sao.external_account_id = sea.id
              )
            ORDER BY sah.id ASC
            LIMIT $3
          )
        `,
        [deletionRequestId, providerFamily, batchSize],
      );
      const deleted = handleDelRes.rowCount ?? 0;
      counts.accountHandlesPurged += deleted;
      return finishInProgress(deleted < batchSize ? "CONTENT_METRICS" : "ACCOUNT_HANDLES");
    }

    if (progress.phase === "CONTENT_METRICS") {
      const params: unknown[] = [providerFamily];
      const filters = appendScopeFilters(params, "scm");
      params.push(batchSize);
      const metricsDelRes = await client.query(
        `
          DELETE FROM social_content_metrics
          WHERE id IN (
            SELECT scm.id
            FROM social_content_metrics scm
            JOIN social_connections sc ON scm.connection_id = sc.id
            JOIN platforms p ON sc.platform_id = p.id
            WHERE COALESCE(p.provider_family, p.slug) = $1
              ${filters}
            ORDER BY scm.id ASC
            LIMIT $${params.length}
          )
        `,
        params,
      );
      const deleted = metricsDelRes.rowCount ?? 0;
      counts.contentMetricsPurged += deleted;
      if (deleted >= batchSize) {
        return finishInProgress("CONTENT_METRICS");
      }
      await checkpointDeletionProgress(client, deletionRequestId, currentMetadata, "COMPLETED", counts);
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

    await completeCurrentDeletionJob(client, currentJobId);
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
