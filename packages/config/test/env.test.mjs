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
