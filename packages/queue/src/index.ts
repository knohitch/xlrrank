import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import { getEnv } from "@xlrrank/config";

export const QUEUE_NAMES = {
  ingestion: "ingestion",
  intelligence: "intelligence",
  notifications: "notifications",
  modelManagement: "model-management",
  jobs: "jobs",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

let _connection: Redis | null = null;
const _queues = new Map<string, Queue>();
const _workers = new Map<string, Worker>();

export function getConnection(): Redis {
  if (_connection) return _connection;
  const env = getEnv();
  _connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _connection;
}

export function getQueue<T = unknown>(name: QueueName): Queue<T, unknown, string> {
  const existing = _queues.get(name);
  if (existing) return existing as Queue<T, unknown, string>;
  const queue = new Queue<T>(name, { connection: getConnection() });
  _queues.set(name, queue);
  return queue as Queue<T, unknown, string>;
}

export function createWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  concurrency = 5,
): Worker<T> {
  const existing = _workers.get(name);
  if (existing) {
    existing.close().catch(() => {});
    _workers.delete(name);
  }
  const worker = new Worker<T>(name, processor, {
    connection: getConnection(),
    concurrency,
  });
  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.name} failed:`, err.message);
  });
  _workers.set(name, worker);
  return worker;
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const conn = getConnection();
    await conn.ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeConnections(): Promise<void> {
  await Promise.all(
    [..._workers.values()].map((w) => w.close()),
  );
  await Promise.all(
    [..._queues.values()].map((q) => q.close()),
  );
  if (_connection) {
    _connection.disconnect();
    _connection = null;
  }
}
