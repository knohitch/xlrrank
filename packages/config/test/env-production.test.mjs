import test from "node:test";
import assert from "node:assert/strict";

test("production env: SESSION_SIGNING_SECRET is required", async () => {
  const { envSchema } = await import("../dist/env.js");

  // Missing SESSION_SIGNING_SECRET in production should fail
  const result = envSchema.safeParse({
    NODE_ENV: "production",
    ENCRYPTION_MASTER_KEY: "a".repeat(32),
  });
  assert.equal(result.success, false, "Should reject production without SESSION_SIGNING_SECRET");
});

test("production env: ENCRYPTION_MASTER_KEY is required", async () => {
  const { envSchema } = await import("../dist/env.js");

  // Missing ENCRYPTION_MASTER_KEY in production should fail
  const result = envSchema.safeParse({
    NODE_ENV: "production",
    SESSION_SIGNING_SECRET: "a".repeat(32),
  });
  assert.equal(result.success, false, "Should reject production without ENCRYPTION_MASTER_KEY");
});

test("production env: valid with all required secrets", async () => {
  const { envSchema } = await import("../dist/env.js");

  const result = envSchema.safeParse({
    NODE_ENV: "production",
    SESSION_SIGNING_SECRET: "a".repeat(32),
    ENCRYPTION_MASTER_KEY: "a".repeat(32),
  });
  assert.equal(result.success, true, "Should accept production with all required secrets");
});
