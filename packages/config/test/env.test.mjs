import test from "node:test";
import assert from "node:assert/strict";

test("env schema applies safe defaults", async () => {
  const { envSchema } = await import("../dist/env.js");
  const parsed = envSchema.parse({});
  assert.equal(parsed.NODE_ENV, "development");
  assert.equal(parsed.API_PORT, 4000);
  assert.equal(parsed.STORAGE_DRIVER, "filesystem");
  assert.equal(parsed.EMAIL_TRANSPORT, "console");
  assert.equal(parsed.SESSION_MAX_AGE_DAYS, 30);
});

test("env schema rejects invalid storage driver", async () => {
  const { envSchema } = await import("../dist/env.js");
  const result = envSchema.safeParse({ STORAGE_DRIVER: "dropbox" });
  assert.equal(result.success, false);
});

test("env schema coerces numeric strings", async () => {
  const { envSchema } = await import("../dist/env.js");
  const parsed = envSchema.parse({ API_PORT: "5000", WORKER_CONCURRENCY: "3" });
  assert.equal(parsed.API_PORT, 5000);
  assert.equal(parsed.WORKER_CONCURRENCY, 3);
});

test("production requires signing and encryption secrets", async () => {
  const { envSchema } = await import("../dist/env.js");
  const missing = envSchema.safeParse({ NODE_ENV: "production" });
  assert.equal(missing.success, false);

  const valid = envSchema.safeParse({
    NODE_ENV: "production",
    SESSION_SIGNING_SECRET: "s".repeat(32),
    ENCRYPTION_MASTER_KEY: "e".repeat(32),
    AI_ROUTING_POLICY_JSON: "{}",
  });
  assert.equal(valid.success, true);
});

test("production requires configured AI routing policy", async () => {
  const { envSchema } = await import("../dist/env.js");
  const missing = envSchema.safeParse({
    NODE_ENV: "production",
    SESSION_SIGNING_SECRET: "s".repeat(32),
    ENCRYPTION_MASTER_KEY: "e".repeat(32),
  });
  assert.equal(missing.success, false);

  const malformed = envSchema.safeParse({
    AI_ROUTING_POLICY_JSON: "not-json",
  });
  assert.equal(malformed.success, false);

  const valid = envSchema.safeParse({
    AI_ROUTING_POLICY_JSON: "{}",
  });
  assert.equal(valid.success, true);
});

test("smtp transport requires delivery configuration", async () => {
  const { envSchema } = await import("../dist/env.js");
  const missing = envSchema.safeParse({ EMAIL_TRANSPORT: "smtp" });
  assert.equal(missing.success, false);

  const valid = envSchema.safeParse({
    EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_FROM: "no-reply@example.test",
  });
  assert.equal(valid.success, true);
});

test("env schema validates PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN", async () => {
  const { envSchema } = await import("../dist/env.js");
  const defaults = envSchema.parse({});
  assert.equal(defaults.PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN, 5);

  const custom = envSchema.parse({ PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN: "12" });
  assert.equal(custom.PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN, 12);

  const invalidZero = envSchema.safeParse({ PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN: "0" });
  assert.equal(invalidZero.success, false);

  const invalidNegative = envSchema.safeParse({ PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN: "-3" });
  assert.equal(invalidNegative.success, false);

  const invalidTooLarge = envSchema.safeParse({ PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN: "101" });
  assert.equal(invalidTooLarge.success, false);
});

test("env schema validates bounded AI model discovery and probe limits", async () => {
  const { envSchema } = await import("../dist/env.js");
  const defaults = envSchema.parse({});
  assert.equal(defaults.AI_MODEL_DISCOVERY_MAX_PROVIDERS_PER_RUN, 10);
  assert.equal(defaults.AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER, 50);
  assert.equal(defaults.AI_MODEL_DISCOVERY_MISSED_THRESHOLD, 2);
  assert.equal(defaults.AI_MODEL_PROBE_MAX_MODELS_PER_RUN, 10);

  assert.equal(envSchema.safeParse({ AI_MODEL_DISCOVERY_MAX_PROVIDERS_PER_RUN: "51" }).success, false);
  assert.equal(envSchema.safeParse({ AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER: "201" }).success, false);
  assert.equal(envSchema.safeParse({ AI_MODEL_DISCOVERY_MISSED_THRESHOLD: "11" }).success, false);
  assert.equal(envSchema.safeParse({ AI_MODEL_PROBE_MAX_MODELS_PER_RUN: "51" }).success, false);
  assert.equal(envSchema.safeParse({ AI_MODEL_PROBE_TIMEOUT_MS: "60001" }).success, false);
});
