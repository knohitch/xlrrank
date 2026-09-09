import type { Job } from "bullmq";
import { createSocialConnectionSyncRequest, getPool, safeJobError } from "@xlrrank/database";
import { JOB_TYPES, parseSocialWebhookProcessPayload } from "@xlrrank/queue";

export async function processSocialWebhook(job: Job): Promise<void> {
  if (job.name !== JOB_TYPES.socialWebhookProcess) {
    throw new Error(`Unsupported webhook job type: ${job.name}`);
  }
  const payload = parseSocialWebhookProcessPayload(job.data);
  const pool = getPool();
  await pool.query(
    "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1",
    [payload.jobRequestId],
  );
  try {
    await pool.query("UPDATE webhook_receipts SET status = 'PROCESSING' WHERE id = $1", [
      payload.receiptId,
    ]);
    const receipt = (
      await pool.query<{ payload: Record<string, unknown>; provider_family: string }>(
        "SELECT payload, provider_family FROM webhook_receipts WHERE id = $1",
        [payload.receiptId],
      )
    ).rows[0];
    if (!receipt || (receipt.provider_family !== "meta" && receipt.provider_family !== "linkedin")) {
      await markIgnored(payload.jobRequestId, payload.receiptId);
      return;
    }
    const assetIds =
      receipt.provider_family === "linkedin"
        ? providerAssetIdsFromLinkedInPayload(receipt.payload)
        : providerAssetIdsFromMetaPayload(receipt.payload);
    if (assetIds.length === 0) {
      await markIgnored(payload.jobRequestId, payload.receiptId);
      return;
    }
    const connections = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM social_connections
        WHERE status IN ('CONNECTED', 'DEGRADED')
          AND (
            provider_metadata->>'providerAssetId' = ANY($1::text[])
            OR verified_external_id = ANY($1::text[])
          )
        ORDER BY id
      `,
      [assetIds],
    );
    if (connections.rows.length === 0) {
      await markIgnored(payload.jobRequestId, payload.receiptId);
      return;
    }
    for (const connection of connections.rows) {
      await createSocialConnectionSyncRequest({
        connectionId: connection.id,
        reason: "MANUAL",
        idempotencyKey: `webhook:${payload.receiptId}:${connection.id}`,
      });
    }
    await pool.query(
      "UPDATE webhook_receipts SET status = 'PROCESSED', processed_at = now(), metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1",
      [payload.receiptId, JSON.stringify({ resolvedConnectionCount: connections.rows.length })],
    );
    await pool.query("UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [
      payload.jobRequestId,
    ]);
  } catch (err) {
    await pool.query(
      "UPDATE webhook_receipts SET status = 'FAILED', metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1",
      [payload.receiptId, JSON.stringify({ error: safeJobError(err) })],
    );
    await pool.query("UPDATE jobs SET status = 'FAILED', failed_at = now(), safe_error = $2::jsonb WHERE id = $1", [
      payload.jobRequestId,
      JSON.stringify(safeJobError(err)),
    ]);
    throw err;
  }
}

function providerAssetIdsFromMetaPayload(payload: Record<string, unknown>): string[] {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  return [
    ...new Set(
      entries
        .map((entry) =>
          entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
            ? (entry as { id: string }).id
            : undefined,
        )
        .filter((value): value is string => !!value),
    ),
  ];
}

function providerAssetIdsFromLinkedInPayload(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const addUrn = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    ids.add(value);
    ids.add(value.replace(/^urn:li:organization:/, ""));
  };
  const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
  for (const notification of notifications) {
    if (!notification || typeof notification !== "object") continue;
    const record = notification as Record<string, unknown>;
    addUrn(record.organizationalEntity);
    addUrn(record.organization);
    addUrn(record.entityUrn);
    addUrn(record.assetId);
  }
  if (typeof payload.organization === "string") {
    addUrn(payload.organization);
  }
  if (typeof payload.entityUrn === "string") {
    addUrn(payload.entityUrn);
  }
  if (typeof payload.organizationalEntity === "string") {
    addUrn(payload.organizationalEntity);
  }
  if (typeof payload.assetId === "string") {
    ids.add(payload.assetId);
  }
  return [...ids].filter(Boolean);
}

async function markIgnored(jobId: string, receiptId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE webhook_receipts SET status = 'IGNORED', processed_at = now() WHERE id = $1",
    [receiptId],
  );
  await pool.query("UPDATE jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [
    jobId,
  ]);
}
