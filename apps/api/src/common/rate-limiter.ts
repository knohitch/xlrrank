import { getEnv } from "@xlrrank/config";
import { createChildLogger } from "@xlrrank/observability";

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

export class FixedWindowRateLimiter {
  private buckets = new Map<ScopeKey, Bucket>();
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly logger = createChildLogger("rate-limit");

  constructor(options?: { windowMs?: number; limit?: number }) {
    const windowMs = options?.windowMs ?? 60_000;
    const limit = options?.limit ?? 60;
    let effectiveWindow = windowMs;
    let effectiveLimit = limit;
    if (getEnv().NODE_ENV === "test") {
      effectiveWindow = 10_000;
      effectiveLimit = 1000;
    }
    this.windowMs = effectiveWindow;
    this.limit = effectiveLimit;
  }

  consume(key: ScopeKey): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.limit;
    const remaining = Math.max(0, this.limit - bucket.count);
    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((bucket.windowStart + this.windowMs - now) / 1000),
    );
    if (this.buckets.size > 10_000) {
      this.sweep();
    }
    return { allowed, remaining, retryAfterSeconds };
  }

  block(key: ScopeKey, durationMs: number): void {
    const bucket = { windowStart: Date.now(), count: this.limit + 1 };
    bucket.windowStart = Date.now() + durationMs - this.windowMs;
    this.buckets.set(key, bucket);
  }

  reset(key: ScopeKey): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.debug({ removed }, "Rate limiter sweep");
  }
}
