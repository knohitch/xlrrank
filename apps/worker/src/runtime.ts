import { randomUUID } from "node:crypto";
import type { Worker } from "bullmq";
import { getEnv } from "@xlrrank/config";
import {
  checkDatabaseHealth,
  claimDueSocialSyncSchedules,
  claimPendingOutboxEntries,
  closeDatabase,
  createSocialConnectionSyncRequest,
  markOutboxDispatched,
  markOutboxFailed,
  markScheduleDispatched,
  reconcileWorkerState,
  touchWorkerHeartbeat,
} from "@xlrrank/database";
import { createChildLogger, getMetrics } from "@xlrrank/observability";
import {
  checkRedisHealth,
  closeConnections,
  createWorker,
  getQueue,
  JOB_TYPES,
  QUEUE_NAMES,
  parseProviderSubscriptionCleanupPayload,
  parseSocialConnectionSyncPayload,
  parseSocialWebhookProcessPayload,
  providerSubscriptionCleanupBullMqJobId,
  socialSyncBullMqJobId,
  socialWebhookBullMqJobId,
} from "@xlrrank/queue";
import { processProviderSubscriptionCleanup } from "./provider-subscription-cleanup-processor.js";
import { processSocialConnectionSync, socialSyncJobOptions } from "./social-sync-processor.js";
import { processSocialWebhook } from "./social-webhook-processor.js";

const logger = createChildLogger("worker.runtime");
const metrics = getMetrics();

class UnimplementedJobProcessorError extends Error {
  constructor(queue: string, jobName: string) {
    super(`No production processor is registered for ${queue}:${jobName}`);
    this.name = "UnimplementedJobProcessorError";
  }
}

export interface WorkerRuntime {
  workerId: string;
  workers: Worker[];
  stop(): Promise<void>;
  dispatchOutboxOnce(): Promise<number>;
  scheduleDueSyncsOnce(): Promise<number>;
}

export async function checkWorkerReadiness(): Promise<boolean> {
  const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
  return database && redis && Boolean(JOB_TYPES.socialConnectionSync);
}

export async function dispatchOutboxOnce(dispatcherId: string): Promise<number> {
  const env = getEnv();
  const entries = await claimPendingOutboxEntries({
    dispatcherId,
    limit: 25,
    leaseMs: env.SOCIAL_SYNC_DISPATCH_INTERVAL_MS * 5,
  });
  let dispatched = 0;
  for (const entry of entries) {
    try {
      const payload =
        entry.jobType === JOB_TYPES.socialWebhookProcess
          ? parseSocialWebhookProcessPayload(entry.payload)
          : entry.jobType === JOB_TYPES.providerSubscriptionCleanup
            ? parseProviderSubscriptionCleanupPayload(entry.payload)
            : parseSocialConnectionSyncPayload(entry.payload);
      const queue = getQueue(QUEUE_NAMES.ingestion);
      const bullmqJobId =
        entry.jobType === JOB_TYPES.socialWebhookProcess
          ? socialWebhookBullMqJobId(entry.jobId)
          : entry.jobType === JOB_TYPES.providerSubscriptionCleanup
            ? providerSubscriptionCleanupBullMqJobId(entry.jobId)
            : socialSyncBullMqJobId(entry.jobId);
      await queue.add(entry.jobType, payload, {
        ...socialSyncJobOptions(),
        jobId: bullmqJobId,
      });
      await markOutboxDispatched({
        outboxId: entry.id,
        jobId: entry.jobId,
        bullmqJobId,
      });
      metrics.increment("worker.outbox.dispatched");
      dispatched += 1;
    } catch (err) {
      await markOutboxFailed({ outboxId: entry.id, error: err });
      metrics.increment("worker.outbox.failed");
      logger.warn({ err, outboxId: entry.id, jobId: entry.jobId }, "Outbox dispatch failed");
    }
  }
  return dispatched;
}

export async function scheduleDueSyncsOnce(schedulerId: string): Promise<number> {
  const env = getEnv();
  const schedules = await claimDueSocialSyncSchedules({
    schedulerId,
    limit: 25,
    leaseMs: env.SOCIAL_SYNC_SCHEDULER_INTERVAL_MS * 5,
  });
  let scheduled = 0;
  for (const schedule of schedules) {
    await createSocialConnectionSyncRequest({
      connectionId: schedule.connectionId,
      reason: "SCHEDULED",
      idempotencyKey: `schedule:${schedule.scheduleId}:${new Date().toISOString().slice(0, 16)}`,
    });
    await markScheduleDispatched({
      scheduleId: schedule.scheduleId,
      schedulerId,
      cadenceSeconds: schedule.cadenceSeconds,
    });
    metrics.increment("worker.scheduler.dispatched");
    scheduled += 1;
  }
  return scheduled;
}

export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const env = getEnv();
  const workerId = `worker-${process.pid}-${randomUUID()}`;
  await reconcileWorkerState(workerId);
  await touchWorkerHeartbeat({
    workerId,
    kind: "worker",
    status: "STARTING",
    metadata: { queuePrefix: env.QUEUE_PREFIX },
  });

  const workers: Worker[] = [];
  workers.push(
    createWorker(
      QUEUE_NAMES.jobs,
      async (job) => {
        logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented job");
        throw new UnimplementedJobProcessorError(QUEUE_NAMES.jobs, job.name);
      },
      env.WORKER_CONCURRENCY,
    ),
  );
  workers.push(
    createWorker(
      QUEUE_NAMES.ingestion,
      async (job) => {
        if (job.name === JOB_TYPES.socialConnectionSync) {
          return processSocialConnectionSync(job);
        }
        if (job.name === JOB_TYPES.socialWebhookProcess) {
          return processSocialWebhook(job);
        }
        if (job.name === JOB_TYPES.providerSubscriptionCleanup) {
          return processProviderSubscriptionCleanup(job);
        }
        logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented ingestion job");
        throw new UnimplementedJobProcessorError(QUEUE_NAMES.ingestion, job.name);
      },
      env.INGESTION_WORKER_CONCURRENCY,
    ),
  );
  workers.push(
    createWorker(
      QUEUE_NAMES.intelligence,
      async (job) => {
        logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented intelligence job");
        throw new UnimplementedJobProcessorError(QUEUE_NAMES.intelligence, job.name);
      },
      env.WORKER_CONCURRENCY,
    ),
  );

  let stopping = false;
  const dispatcherTimer = setInterval(() => {
    if (!stopping)
      dispatchOutboxOnce(workerId).catch((err) => logger.error({ err }, "Dispatcher failed"));
  }, env.SOCIAL_SYNC_DISPATCH_INTERVAL_MS);
  const schedulerTimer = setInterval(() => {
    if (!stopping)
      scheduleDueSyncsOnce(workerId).catch((err) => logger.error({ err }, "Scheduler failed"));
  }, env.SOCIAL_SYNC_SCHEDULER_INTERVAL_MS);
  const heartbeatTimer = setInterval(
    () => {
      if (!stopping) {
        touchWorkerHeartbeat({
          workerId,
          kind: "worker",
          status: "READY",
          metadata: { queuePrefix: env.QUEUE_PREFIX },
        }).catch((err) => logger.error({ err }, "Heartbeat failed"));
      }
    },
    Math.min(10_000, env.SOCIAL_SYNC_LEASE_HEARTBEAT_MS),
  );

  await dispatchOutboxOnce(workerId);
  await scheduleDueSyncsOnce(workerId);
  await touchWorkerHeartbeat({
    workerId,
    kind: "worker",
    status: "READY",
    metadata: { queuePrefix: env.QUEUE_PREFIX },
  });
  logger.info(
    {
      workerId,
      ingestionConcurrency: env.INGESTION_WORKER_CONCURRENCY,
      queuePrefix: env.QUEUE_PREFIX,
    },
    "Worker runtime ready",
  );

  return {
    workerId,
    workers,
    dispatchOutboxOnce: () => dispatchOutboxOnce(workerId),
    scheduleDueSyncsOnce: () => scheduleDueSyncsOnce(workerId),
    async stop() {
      stopping = true;
      clearInterval(dispatcherTimer);
      clearInterval(schedulerTimer);
      clearInterval(heartbeatTimer);
      await touchWorkerHeartbeat({
        workerId,
        kind: "worker",
        status: "DRAINING",
        metadata: { queuePrefix: env.QUEUE_PREFIX },
      });
      await Promise.race([
        closeConnections(),
        new Promise((resolve) => setTimeout(resolve, env.SOCIAL_SYNC_SHUTDOWN_GRACE_MS)),
      ]);
      await touchWorkerHeartbeat({
        workerId,
        kind: "worker",
        status: "STOPPED",
        metadata: { queuePrefix: env.QUEUE_PREFIX },
      }).catch(() => {});
      await closeDatabase();
    },
  };
}
