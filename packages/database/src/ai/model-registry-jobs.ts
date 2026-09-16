import { randomUUID } from "node:crypto";
import {
  AI_MODEL_REGISTRY_REFRESH_PAYLOAD_VERSION,
  JOB_TYPES,
  QUEUE_NAMES,
  assertNoCredentialsInPayload,
} from "@xlrrank/queue";
import { getEnv } from "@xlrrank/config";
import { getPool } from "../client.js";

interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  connect?(): Promise<TransactionClient>;
}

interface TransactionClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  release(): void;
}

export interface CreateAiModelRegistryRefreshInput {
  providerId?: string;
  credentialId?: string;
  reason?: "SCHEDULED" | "MANUAL" | "RETRY";
  idempotencyKey?: string;
}

export interface DurableAiModelRegistryRefreshRequest {
  jobId: string;
  duplicate: boolean;
}

function payload(input: { jobId: string; providerId?: string; credentialId?: string; reason: "SCHEDULED" | "MANUAL" | "RETRY" }) {
  return {
    version: AI_MODEL_REGISTRY_REFRESH_PAYLOAD_VERSION,
    jobRequestId: input.jobId,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    reason: input.reason,
  };
}

export async function createAiModelRegistryRefreshRequest(
  input: CreateAiModelRegistryRefreshInput,
  db: Queryable = getPool(),
): Promise<DurableAiModelRegistryRefreshRequest> {
  const reason = input.reason ?? "SCHEDULED";
  const idempotencyKey =
    input.idempotencyKey ??
    `ai-model-registry:${input.providerId ?? "all"}:${input.credentialId ?? "all"}:${reason}`;

  const client = await transactionClient(db);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${JOB_TYPES.aiModelRegistryRefresh}:${idempotencyKey}`,
    ]);
    const active = await client.query<{ id: string }>(
      `
      SELECT id
      FROM jobs
      WHERE type = $1
        AND idempotency_key = $2
        AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [JOB_TYPES.aiModelRegistryRefresh, idempotencyKey],
    );
    const existing = active.rows[0];
    if (existing) {
      await client.query("COMMIT");
      return { jobId: existing.id, duplicate: true };
    }

    const jobId = randomUUID();
    const body = payload({
      jobId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      reason,
    });
    assertNoCredentialsInPayload(body);

    await client.query(
      `
      INSERT INTO jobs (
        id, type, status, payload, queue_name, payload_version, reason,
        idempotency_key, max_attempts, created_at, updated_at
      )
      VALUES ($1, $2, 'PENDING_DISPATCH', $3::jsonb, $4, $5, $6, $7, $8, now(), now())
      `,
      [
        jobId,
        JOB_TYPES.aiModelRegistryRefresh,
        JSON.stringify(body),
        QUEUE_NAMES.modelManagement,
        AI_MODEL_REGISTRY_REFRESH_PAYLOAD_VERSION,
        reason,
        idempotencyKey,
        getEnv().SOCIAL_SYNC_MAX_ATTEMPTS,
      ],
    );
    await client.query(
      "INSERT INTO job_outbox (job_id, queue_name, job_type, payload) VALUES ($1, $2, $3, $4::jsonb)",
      [jobId, QUEUE_NAMES.modelManagement, JOB_TYPES.aiModelRegistryRefresh, JSON.stringify(body)],
    );
    await client.query("COMMIT");
    return { jobId, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function transactionClient(db: Queryable): Promise<TransactionClient> {
  if (!db.connect) {
    throw new Error("AI model registry refresh request creation requires a transaction-capable database client");
  }
  return db.connect();
}
