import { createChildLogger } from "@xlrrank/observability";
import { checkWorkerReadiness, startWorkerRuntime, type WorkerRuntime } from "./runtime.js";

const logger = createChildLogger("worker");

let runtime: WorkerRuntime | null = null;

async function start() {
  if (process.argv.includes("--readiness-check")) {
    const ready = await checkWorkerReadiness();
    process.exit(ready ? 0 : 1);
  }
  runtime = await startWorkerRuntime();
}

start().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker runtime");
  if (runtime) await runtime.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
