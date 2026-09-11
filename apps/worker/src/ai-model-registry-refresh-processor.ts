import type { Job } from "bullmq";
import { modelRegistry } from "@xlrrank/ai-core";
import { getEnv } from "@xlrrank/config";
import { getPool, safeJobError } from "@xlrrank/database";
import { parseAiModelRegistryRefreshPayload, type AiModelRegistryRefreshPayload } from "@xlrrank/queue";

export async function processAiModelRegistryRefresh(
  job: Job<AiModelRegistryRefreshPayload>,
): Promise<{ refreshedRuntimes: number }> {
  const payload = parseAiModelRegistryRefreshPayload(job.data);
  const pool = getPool();
  await pool.query(
    `
    UPDATE jobs
    SET status = 'RUNNING',
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE id = $1
      AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RETRY_SCHEDULED', 'RUNNING')
    `,
    [payload.jobRequestId],
  );
  try {
    const result = await modelRegistry.refresh({
      ...(payload.providerId ? { providerId: payload.providerId } : {}),
      ...(payload.credentialId ? { credentialId: payload.credentialId } : {}),
      reason: payload.reason,
    });
    const failures = result.runtimes.filter((runtime) => !runtime.discovery.ok);
    if (failures.length > 0) {
      const retryable = failures.some((runtime) => !runtime.discovery.ok && runtime.discovery.retryable);
      const safeError = {
        message: "AI model registry refresh encountered provider discovery failures",
        runtimes: failures.map((runtime) => ({
          providerId: runtime.providerId,
          runtimeKey: runtime.runtimeKey,
          health: runtime.discovery.health,
          retryable: runtime.discovery.ok ? false : runtime.discovery.retryable,
          code: runtime.discovery.ok ? "UNKNOWN" : runtime.discovery.safeError.code,
          status: runtime.discovery.ok ? undefined : runtime.discovery.safeError.status,
        })),
      };
      if (retryable) {
        await pool.query(
          `
          UPDATE jobs
          SET status = 'RETRY_SCHEDULED',
              safe_error = $2::jsonb,
              error = $2::jsonb,
              retry_classification = 'RETRYABLE',
              next_retry_at = now() + make_interval(secs => $3),
              updated_at = now()
          WHERE id = $1
          `,
          [payload.jobRequestId, JSON.stringify(safeJobError(safeError)), Math.ceil(getEnv().AI_MODEL_DISCOVERY_SWEEP_INTERVAL_MS / 1000)],
        );
      } else {
        await pool.query(
          `
          UPDATE jobs
          SET status = 'FAILED',
              failed_at = now(),
              safe_error = $2::jsonb,
              error = $2::jsonb,
              retry_classification = 'NON_RETRYABLE',
              updated_at = now()
          WHERE id = $1
          `,
          [payload.jobRequestId, JSON.stringify(safeJobError(safeError))],
        );
      }
      throw new Error("AI model registry refresh failed for one or more provider runtimes");
    }
    await pool.query(
      `
      UPDATE jobs
      SET status = 'COMPLETED',
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
      `,
      [payload.jobRequestId],
    );
    return { refreshedRuntimes: result.runtimes.length };
  } catch (err) {
    const current = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
      payload.jobRequestId,
    ]);
    const status = current.rows[0]?.status;
    if (status === "RUNNING") {
      await pool.query(
        `
        UPDATE jobs
        SET status = 'FAILED',
            failed_at = now(),
            safe_error = $2::jsonb,
            error = $2::jsonb,
            retry_classification = 'NON_RETRYABLE',
            updated_at = now()
        WHERE id = $1
        `,
        [payload.jobRequestId, JSON.stringify(safeJobError(err))],
      );
    }
    throw err;
  }
}
