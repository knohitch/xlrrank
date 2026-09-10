import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
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

export const JOB_TYPES = {
  socialConnectionSync: "social.connection.sync",
  socialWebhookProcess: "social.webhook.process",
  providerSubscriptionCleanup: "provider.subscription.cleanup",
  providerAuthorizationCleanup: "provider.authorization.cleanup",
  providerDataDeletion: "provider.data.deletion",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const SOCIAL_SYNC_PAYLOAD_VERSION = 1 as const;
export const SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION = 1 as const;
export const PROVIDER_SUBSCRIPTION_CLEANUP_PAYLOAD_VERSION = 1 as const;
export const PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION = 1 as const;
export const PROVIDER_DATA_DELETION_PAYLOAD_VERSION = 1 as const;

export const SOCIAL_SYNC_REASONS = ["MANUAL", "SCHEDULED", "RETRY"] as const;
export type SocialSyncReason = (typeof SOCIAL_SYNC_REASONS)[number];

export interface SocialConnectionSyncPayloadV1 {
  version: typeof SOCIAL_SYNC_PAYLOAD_VERSION;
  jobRequestId: string;
  connectionId: string;
  reason: SocialSyncReason;
}

export type SocialConnectionSyncPayload = SocialConnectionSyncPayloadV1;

export interface SocialWebhookProcessPayloadV1 {
  version: typeof SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION;
  jobRequestId: string;
  receiptId: string;
}

export type SocialWebhookProcessPayload = SocialWebhookProcessPayloadV1;

export interface ProviderSubscriptionCleanupPayloadV1 {
  version: typeof PROVIDER_SUBSCRIPTION_CLEANUP_PAYLOAD_VERSION;
  jobRequestId: string;
  subscriptionId: string;
}

export type ProviderSubscriptionCleanupPayload = ProviderSubscriptionCleanupPayloadV1;

export interface ProviderAuthorizationCleanupPayloadV1 {
  version: typeof PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION;
  jobRequestId: string;
  cleanupId: string;
}

export type ProviderAuthorizationCleanupPayload = ProviderAuthorizationCleanupPayloadV1;

export interface ProviderDataDeletionPayloadV1 {
  version: typeof PROVIDER_DATA_DELETION_PAYLOAD_VERSION;
  jobRequestId: string;
  deletionRequestId: string;
}

export type ProviderDataDeletionPayload = ProviderDataDeletionPayloadV1;

export const JOB_STATUSES = [
  "PENDING_DISPATCH",
  "QUEUED",
  "RUNNING",
  "RETRY_SCHEDULED",
  "COMPLETED",
  "FAILED",
  "DEAD_LETTERED",
  "CANCELLED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  PENDING_DISPATCH: ["QUEUED", "RUNNING", "CANCELLED", "FAILED"],
  QUEUED: ["RUNNING", "CANCELLED", "RETRY_SCHEDULED", "FAILED"],
  RUNNING: ["COMPLETED", "FAILED", "RETRY_SCHEDULED", "DEAD_LETTERED", "CANCELLED"],
  RETRY_SCHEDULED: ["QUEUED", "RUNNING", "FAILED", "DEAD_LETTERED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["PENDING_DISPATCH", "DEAD_LETTERED"],
  DEAD_LETTERED: ["PENDING_DISPATCH"],
  CANCELLED: ["PENDING_DISPATCH"],
};

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (from === to) return;
  if (!JOB_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidJobPayloadError(`Illegal job transition from ${from} to ${to}`);
  }
}

export function isJobStatus(value: string): value is JobStatus {
  return JOB_STATUSES.includes(value as JobStatus);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "clientSecret",
  "client_secret",
  "credentials",
  "credentialsEncrypted",
  "credentials_encrypted",
  "cookie",
  "authorization",
]);

let _connection: Redis | null = null;
const _queues = new Map<string, Queue>();
const _workers = new Set<Worker>();

export class InvalidJobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobPayloadError";
  }
}

export function getQueuePrefix(): string {
  return getEnv().QUEUE_PREFIX;
}

function queueKey(name: QueueName): string {
  return `${getQueuePrefix()}:${name}`;
}

function hasForbiddenPayloadKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenPayloadKey(item));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return true;
    if (hasForbiddenPayloadKey(child)) return true;
  }
  return false;
}

export function assertNoCredentialsInPayload(payload: unknown): void {
  if (hasForbiddenPayloadKey(payload)) {
    throw new InvalidJobPayloadError("Queue payload contains forbidden credential material");
  }
}

export function parseSocialConnectionSyncPayload(payload: unknown): SocialConnectionSyncPayload {
  assertNoCredentialsInPayload(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidJobPayloadError("Social sync payload must be an object");
  }
  const item = payload as Record<string, unknown>;
  if (item.version !== SOCIAL_SYNC_PAYLOAD_VERSION) {
    throw new InvalidJobPayloadError("Unsupported social sync payload version");
  }
  if (typeof item.jobRequestId !== "string" || !UUID_RE.test(item.jobRequestId)) {
    throw new InvalidJobPayloadError("Social sync payload jobRequestId must be a UUID");
  }
  if (typeof item.connectionId !== "string" || !UUID_RE.test(item.connectionId)) {
    throw new InvalidJobPayloadError("Social sync payload connectionId must be a UUID");
  }
  if (
    typeof item.reason !== "string" ||
    !SOCIAL_SYNC_REASONS.includes(item.reason as SocialSyncReason)
  ) {
    throw new InvalidJobPayloadError("Social sync payload reason is invalid");
  }
  return {
    version: SOCIAL_SYNC_PAYLOAD_VERSION,
    jobRequestId: item.jobRequestId,
    connectionId: item.connectionId,
    reason: item.reason as SocialSyncReason,
  };
}

export function parseSocialWebhookProcessPayload(payload: unknown): SocialWebhookProcessPayload {
  assertNoCredentialsInPayload(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidJobPayloadError("Social webhook payload must be an object");
  }
  const item = payload as Record<string, unknown>;
  if (item.version !== SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION) {
    throw new InvalidJobPayloadError("Unsupported social webhook payload version");
  }
  if (typeof item.jobRequestId !== "string" || !UUID_RE.test(item.jobRequestId)) {
    throw new InvalidJobPayloadError("Social webhook payload jobRequestId must be a UUID");
  }
  if (typeof item.receiptId !== "string" || !UUID_RE.test(item.receiptId)) {
    throw new InvalidJobPayloadError("Social webhook payload receiptId must be a UUID");
  }
  return {
    version: SOCIAL_WEBHOOK_PROCESS_PAYLOAD_VERSION,
    jobRequestId: item.jobRequestId,
    receiptId: item.receiptId,
  };
}

export function parseProviderSubscriptionCleanupPayload(
  payload: unknown,
): ProviderSubscriptionCleanupPayload {
  assertNoCredentialsInPayload(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidJobPayloadError("Provider subscription cleanup payload must be an object");
  }
  const item = payload as Record<string, unknown>;
  if (item.version !== PROVIDER_SUBSCRIPTION_CLEANUP_PAYLOAD_VERSION) {
    throw new InvalidJobPayloadError("Unsupported provider subscription cleanup payload version");
  }
  if (typeof item.jobRequestId !== "string" || !UUID_RE.test(item.jobRequestId)) {
    throw new InvalidJobPayloadError("Provider subscription cleanup payload jobRequestId must be a UUID");
  }
  if (typeof item.subscriptionId !== "string" || !UUID_RE.test(item.subscriptionId)) {
    throw new InvalidJobPayloadError("Provider subscription cleanup payload subscriptionId must be a UUID");
  }
  return {
    version: PROVIDER_SUBSCRIPTION_CLEANUP_PAYLOAD_VERSION,
    jobRequestId: item.jobRequestId,
    subscriptionId: item.subscriptionId,
  };
}

export function parseProviderAuthorizationCleanupPayload(
  payload: unknown,
): ProviderAuthorizationCleanupPayload {
  assertNoCredentialsInPayload(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidJobPayloadError("Provider authorization cleanup payload must be an object");
  }
  const item = payload as Record<string, unknown>;
  if (item.version !== PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION) {
    throw new InvalidJobPayloadError("Unsupported provider authorization cleanup payload version");
  }
  if (typeof item.jobRequestId !== "string" || !UUID_RE.test(item.jobRequestId)) {
    throw new InvalidJobPayloadError("Provider authorization cleanup payload jobRequestId must be a UUID");
  }
  if (typeof item.cleanupId !== "string" || !UUID_RE.test(item.cleanupId)) {
    throw new InvalidJobPayloadError("Provider authorization cleanup payload cleanupId must be a UUID");
  }
  return {
    version: PROVIDER_AUTHORIZATION_CLEANUP_PAYLOAD_VERSION,
    jobRequestId: item.jobRequestId,
    cleanupId: item.cleanupId,
  };
}

export function parseProviderDataDeletionPayload(
  payload: unknown,
): ProviderDataDeletionPayload {
  assertNoCredentialsInPayload(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidJobPayloadError("Provider data deletion payload must be an object");
  }
  const item = payload as Record<string, unknown>;
  if (item.version !== PROVIDER_DATA_DELETION_PAYLOAD_VERSION) {
    throw new InvalidJobPayloadError("Unsupported provider data deletion payload version");
  }
  if (typeof item.jobRequestId !== "string" || !UUID_RE.test(item.jobRequestId)) {
    throw new InvalidJobPayloadError("Provider data deletion payload jobRequestId must be a UUID");
  }
  if (typeof item.deletionRequestId !== "string" || !UUID_RE.test(item.deletionRequestId)) {
    throw new InvalidJobPayloadError("Provider data deletion payload deletionRequestId must be a UUID");
  }
  return {
    version: PROVIDER_DATA_DELETION_PAYLOAD_VERSION,
    jobRequestId: item.jobRequestId,
    deletionRequestId: item.deletionRequestId,
  };
}

export function socialSyncBullMqJobId(jobRequestId: string): string {
  return `${JOB_TYPES.socialConnectionSync.replaceAll(".", "-")}-${jobRequestId}`;
}

export function socialWebhookBullMqJobId(jobRequestId: string): string {
  return `${JOB_TYPES.socialWebhookProcess.replaceAll(".", "-")}-${jobRequestId}`;
}

export function providerSubscriptionCleanupBullMqJobId(jobRequestId: string): string {
  return `${JOB_TYPES.providerSubscriptionCleanup.replaceAll(".", "-")}-${jobRequestId}`;
}

export function providerAuthorizationCleanupBullMqJobId(jobRequestId: string): string {
  return `${JOB_TYPES.providerAuthorizationCleanup.replaceAll(".", "-")}-${jobRequestId}`;
}

export function providerDataDeletionBullMqJobId(jobRequestId: string): string {
  return `${JOB_TYPES.providerDataDeletion.replaceAll(".", "-")}-${jobRequestId}`;
}

export function defaultSocialSyncJobOptions(): JobsOptions {
  const env = getEnv();
  return {
    attempts: env.SOCIAL_SYNC_MAX_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: env.SOCIAL_SYNC_BACKOFF_BASE_MS,
    },
    removeOnComplete: env.SOCIAL_SYNC_REMOVE_ON_COMPLETE,
    removeOnFail: env.SOCIAL_SYNC_REMOVE_ON_FAIL,
  };
}

export function getConnection(): Redis {
  if (_connection) return _connection;
  const env = getEnv();
  _connection = new Redis(env.QUEUE_URL || env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _connection;
}

export function getQueue<T = unknown>(name: QueueName): Queue<T, unknown, string> {
  const key = queueKey(name);
  const existing = _queues.get(key);
  if (existing) return existing as Queue<T, unknown, string>;
  const queue = new Queue<T>(name, {
    connection: getConnection(),
    prefix: getQueuePrefix(),
  });
  _queues.set(key, queue);
  return queue as Queue<T, unknown, string>;
}

export function createWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  concurrency = 5,
): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: getConnection(),
    concurrency,
    prefix: getQueuePrefix(),
    lockDuration: getEnv().SOCIAL_SYNC_BULLMQ_LOCK_MS,
    stalledInterval: getEnv().SOCIAL_SYNC_BULLMQ_STALLED_INTERVAL_MS,
    maxStalledCount: 2,
  });
  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.name} failed:`, err.message);
  });
  _workers.add(worker);
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
  await Promise.all([..._workers.values()].map((w) => w.close()));
  _workers.clear();
  await Promise.all([..._queues.values()].map((q) => q.close()));
  _queues.clear();
  if (_connection) {
    _connection.disconnect();
    _connection = null;
  }
}
