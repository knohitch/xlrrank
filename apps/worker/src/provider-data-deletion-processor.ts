import type { Job } from "bullmq";
import { executeProviderDataDeletion, getPool, safeJobError } from "@xlrrank/database";
import { JOB_TYPES, parseProviderDataDeletionPayload } from "@xlrrank/queue";
import { createChildLogger } from "@xlrrank/observability";

const logger = createChildLogger("worker.provider-data-deletion");

export async function processProviderDataDeletion(job: Job): Promise<void> {
  if (job.name !== JOB_TYPES.providerDataDeletion) {
    throw new Error(`Unsupported provider data deletion job type: ${job.name}`);
  }

  const payload = parseProviderDataDeletionPayload(job.data);
  const pool = getPool();

  const durableJob = await pool.query<{ status: string }>(
    `
      UPDATE jobs
      SET status = 'RUNNING',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = $1
        AND status <> 'COMPLETED'
      RETURNING status
    `,
    [payload.jobRequestId],
  );
  if (!durableJob.rows[0]) {
    logger.info({ jobRequestId: payload.jobRequestId }, "Provider data deletion job already completed");
    return;
  }

  try {
    const result = await executeProviderDataDeletion(payload.deletionRequestId, {
      currentJobId: payload.jobRequestId,
    });

    if (result.status === "IN_PROGRESS") {
      logger.info(
        {
          jobRequestId: payload.jobRequestId,
          deletionRequestId: payload.deletionRequestId,
          providerFamily: result.providerFamily,
          result,
        },
        "Provider data deletion partially complete, durable continuation scheduled",
      );
      return;
    }

    logger.info(
      {
        jobRequestId: payload.jobRequestId,
        deletionRequestId: payload.deletionRequestId,
        providerFamily: result.providerFamily,
        result,
      },
      "Provider data deletion executed successfully",
    );
  } catch (err) {
    logger.error(
      {
        err: safeJobError(err),
        jobRequestId: payload.jobRequestId,
        deletionRequestId: payload.deletionRequestId,
      },
      "Provider data deletion execution failed",
    );
    await pool.query(
      "UPDATE jobs SET status = 'FAILED', failed_at = now(), safe_error = $2::jsonb WHERE id = $1",
      [payload.jobRequestId, JSON.stringify(safeJobError(err))],
    );
    throw err;
  }
}
