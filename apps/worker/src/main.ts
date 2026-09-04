import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";
import { closeConnections, createWorker, QUEUE_NAMES } from "@xlrrank/queue";

const logger = createChildLogger("worker");

class UnimplementedJobProcessorError extends Error {
  constructor(queue: string, jobName: string) {
    super(`No production processor is registered for ${queue}:${jobName}`);
    this.name = "UnimplementedJobProcessorError";
  }
}

async function start() {
  const env = getEnv();

  createWorker(
    QUEUE_NAMES.jobs,
    async (job) => {
      logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented job");
      throw new UnimplementedJobProcessorError(QUEUE_NAMES.jobs, job.name);
    },
    env.WORKER_CONCURRENCY,
  );

  createWorker(
    QUEUE_NAMES.ingestion,
    async (job) => {
      logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented ingestion job");
      throw new UnimplementedJobProcessorError(QUEUE_NAMES.ingestion, job.name);
    },
    env.WORKER_CONCURRENCY,
  );

  createWorker(
    QUEUE_NAMES.intelligence,
    async (job) => {
      logger.error({ jobId: job.id, type: job.name }, "Rejecting unimplemented intelligence job");
      throw new UnimplementedJobProcessorError(QUEUE_NAMES.intelligence, job.name);
    },
    env.WORKER_CONCURRENCY,
  );

  logger.warn(
    { concurrency: env.WORKER_CONCURRENCY },
    "Worker started in fail-closed mode: production job processors are not implemented",
  );
}

start().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  await closeConnections();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
