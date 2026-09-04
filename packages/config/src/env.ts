import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),

  DATABASE_URL: z
    .string()
    .default("postgres://xlrrank:xlrrank@localhost:5432/xlrrank"),
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

  API_PORT: z.coerce.number().default(4000),
  WEB_PORT: z.coerce.number().default(3000),
  WORKER_CONCURRENCY: z.coerce.number().default(5),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
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

export { envSchema };
