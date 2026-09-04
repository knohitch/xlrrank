import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";
import { closeConnections, createWorker, QUEUE_NAMES } from "@xlrrank/queue";

const logger = createChildLogger("worker");

async function start() {
  const env = getEnv();

  createWorker(
    QUEUE_NAMES.jobs,
    async (job) => {
      logger.info({ jobId: job.id, type: job.name, data: job.data }, "Processing job");
      return { processed: true };
    },
    env.WORKER_CONCURRENCY,
  );

  createWorker(
    QUEUE_NAMES.ingestion,
    async (job) => {
      logger.info({ jobId: job.id, type: job.name }, "Processing ingestion job");
      return { ingested: true };
    },
    env.WORKER_CONCURRENCY,
  );

  createWorker(
    QUEUE_NAMES.intelligence,
    async (job) => {
      logger.info({ jobId: job.id, type: job.name }, "Processing intelligence job");
      return { analyzed: true };
    },
    env.WORKER_CONCURRENCY,
  );

  logger.info(`Worker started with concurrency ${env.WORKER_CONCURRENCY}`);
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
