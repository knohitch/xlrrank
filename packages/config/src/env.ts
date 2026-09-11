import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),

  DATABASE_URL: z.string().default("postgres://xlrrank:xlrrank@localhost:5432/xlrrank"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  QUEUE_URL: z.string().default("redis://localhost:6379"),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("xlrrank"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(["s3", "filesystem"]).default("filesystem"),
  STORAGE_LOCAL_PATH: z.string().default("./storage"),

  ENCRYPTION_MASTER_KEY: z.string().optional(),
  SESSION_SIGNING_SECRET: z.string().optional(),
  SESSION_ENCRYPTION_SECRET: z.string().optional(),
  PASSWORD_RESET_SECRET: z.string().optional(),

  EMAIL_TRANSPORT: z.enum(["console", "smtp"]).default("console"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  SESSION_COOKIE_SECURE: z.string().default("auto"),
  SESSION_MAX_AGE_DAYS: z.coerce.number().default(30),
  EMAIL_VERIFY_EXPIRY_MINUTES: z.coerce.number().default(60),
  PASSWORD_RESET_EXPIRY_MINUTES: z.coerce.number().default(30),

  RATE_LIMIT_STORE: z.enum(["redis", "memory"]).default("redis"),
  RATE_LIMIT_SIGNIN_LIMIT: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SIGNUP_LIMIT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RECOVERY_LIMIT: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_TOKEN_LIMIT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  API_PORT: z.coerce.number().default(4000),
  WEB_PORT: z.coerce.number().default(3000),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  INGESTION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  QUEUE_PREFIX: z.string().min(1).default("xlrrank"),
  SOCIAL_SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  SOCIAL_SYNC_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  SOCIAL_SYNC_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  SOCIAL_SYNC_BACKOFF_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  SOCIAL_SYNC_RATE_LIMIT_MIN_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  SOCIAL_SYNC_RATE_LIMIT_MAX_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
  SOCIAL_SYNC_LEASE_MS: z.coerce.number().int().positive().default(120_000),
  SOCIAL_SYNC_LEASE_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),
  SOCIAL_SYNC_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SOCIAL_SYNC_PAGE_LIMIT: z.coerce.number().int().positive().max(500).default(100),
  SOCIAL_SYNC_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  SOCIAL_SYNC_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  PROVIDER_RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  PROVIDER_RETENTION_SWEEP_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  PROVIDER_RECONCILIATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  PROVIDER_RECONCILIATION_SWEEP_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN: z.coerce.number().int().positive().max(100).default(5),
  AI_MODEL_DISCOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  AI_MODEL_DISCOVERY_SWEEP_TIMEOUT_MS: z.coerce.number().int().positive().max(900_000).default(300_000),
  AI_MODEL_DISCOVERY_MAX_PROVIDERS_PER_RUN: z.coerce.number().int().positive().max(50).default(10),
  AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER: z.coerce.number().int().positive().max(200).default(50),
  AI_MODEL_PROBE_MAX_MODELS_PER_RUN: z.coerce.number().int().nonnegative().max(50).default(10),
  AI_MODEL_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  SOCIAL_SYNC_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  SOCIAL_SYNC_BULLMQ_LOCK_MS: z.coerce.number().int().positive().default(30_000),
  SOCIAL_SYNC_BULLMQ_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SOCIAL_SYNC_REMOVE_ON_COMPLETE: z.coerce.number().int().nonnegative().default(100),
  SOCIAL_SYNC_REMOVE_ON_FAIL: z.coerce.number().int().nonnegative().default(1_000),
  ENABLE_REFERENCE_CONNECTOR: z.coerce.boolean().default(false),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production") {
    if (!env.SESSION_SIGNING_SECRET || env.SESSION_SIGNING_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_SIGNING_SECRET"],
        message:
          "SESSION_SIGNING_SECRET is required in production and must be at least 32 characters",
      });
    }
    if (!env.ENCRYPTION_MASTER_KEY || env.ENCRYPTION_MASTER_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENCRYPTION_MASTER_KEY"],
        message:
          "ENCRYPTION_MASTER_KEY is required in production and must be at least 32 characters",
      });
    }
  }

  if (env.EMAIL_TRANSPORT === "smtp") {
    for (const [key, value] of [
      ["SMTP_HOST", env.SMTP_HOST],
      ["SMTP_PORT", env.SMTP_PORT],
      ["SMTP_FROM", env.SMTP_FROM],
    ] as const) {
      if (value === undefined || value === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when EMAIL_TRANSPORT=smtp`,
        });
      }
    }
  }

  if (env.NODE_ENV === "production" && env.RATE_LIMIT_STORE !== "redis") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RATE_LIMIT_STORE"],
      message: "RATE_LIMIT_STORE=redis is required in production",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let _cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (_cachedEnv) return _cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables. Check server logs for details.");
  }
  _cachedEnv = parsed.data;
  return _cachedEnv;
}

export function getEnv(): Env {
  if (!_cachedEnv) return loadEnv();
  return _cachedEnv;
}

export { baseEnvSchema };
