import { createHmac } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";
import { getConnection } from "@xlrrank/queue";

interface Bucket {
  windowStart: number;
  count: number;
}

type ScopeKey = string;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiterStore {
  consume(key: ScopeKey, windowMs: number, limit: number): Promise<RateLimitResult>;
  reset?(key: ScopeKey): Promise<void>;
}

export class MemoryRateLimiterStore implements RateLimiterStore {
  private buckets = new Map<ScopeKey, Bucket>();
  private readonly logger = createChildLogger("rate-limit");

  async consume(key: ScopeKey, windowMs: number, limit: number): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= limit;
    const remaining = Math.max(0, limit - bucket.count);
    const retryAfterSeconds = Math.max(0, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    if (this.buckets.size > 10_000) {
      this.sweep(windowMs);
    }
    return { allowed, remaining, retryAfterSeconds };
  }

  async reset(key: ScopeKey): Promise<void> {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  private sweep(windowMs: number): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= windowMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.debug({ removed }, "Rate limiter sweep");
  }
}

export class RedisRateLimiterStore implements RateLimiterStore {
  async consume(key: ScopeKey, windowMs: number, limit: number): Promise<RateLimitResult> {
    const redis = getConnection();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, windowMs);
    }
    const ttl = await redis.pttl(key);
    const retryAfterSeconds = Math.max(1, Math.ceil(ttl / 1000));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    };
  }

  async reset(key: ScopeKey): Promise<void> {
    await getConnection().del(key);
  }
}

export type RateLimitOperation =
  | "signin"
  | "signup"
  | "resend-verification"
  | "forgot-password"
  | "verify-email"
  | "reset-password";

export class FixedWindowRateLimiter {
  private readonly store: RateLimiterStore;

  constructor(
    private readonly options: { windowMs: number; limit: number },
    store?: RateLimiterStore,
  ) {
    this.store = store ?? new MemoryRateLimiterStore();
  }

  consume(key: ScopeKey): Promise<RateLimitResult> {
    return this.store.consume(key, this.options.windowMs, this.options.limit);
  }
}

@Injectable()
export class AuthRateLimitService {
  private readonly store: RateLimiterStore;
  private readonly windowMs: number;

  constructor(store?: RateLimiterStore) {
    const env = getEnv();
    this.store =
      store ??
      (env.RATE_LIMIT_STORE === "memory"
        ? new MemoryRateLimiterStore()
        : new RedisRateLimiterStore());
    this.windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;
  }

  async consume(
    operation: RateLimitOperation,
    identityParts: Array<string | null | undefined>,
  ): Promise<RateLimitResult> {
    const env = getEnv();
    const limit = this.limitFor(operation);
    const key = this.keyFor(operation, identityParts, env.SESSION_SIGNING_SECRET);
    return this.store.consume(key, this.windowMs, limit);
  }

  private limitFor(operation: RateLimitOperation): number {
    const env = getEnv();
    if (operation === "signin") return env.RATE_LIMIT_SIGNIN_LIMIT;
    if (operation === "signup") return env.RATE_LIMIT_SIGNUP_LIMIT;
    if (operation === "verify-email" || operation === "reset-password") {
      return env.RATE_LIMIT_TOKEN_LIMIT;
    }
    return env.RATE_LIMIT_RECOVERY_LIMIT;
  }

  private keyFor(
    operation: RateLimitOperation,
    identityParts: Array<string | null | undefined>,
    secret: string | undefined,
  ): string {
    const hmacSecret =
      secret && secret.length >= 32 ? secret : "local-rate-limit-secret-for-non-production";
    const normalized = identityParts
      .map((part) => (part ?? "unknown").trim().toLowerCase())
      .join("|");
    const digest = createHmac("sha256", hmacSecret).update(normalized).digest("hex");
    return `xlrrank:rate-limit:${operation}:${digest}`;
  }
}
