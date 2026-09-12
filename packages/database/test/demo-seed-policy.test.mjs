import test from "node:test";
import assert from "node:assert/strict";

test("demo seed fails closed outside explicit safe environments", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    ALLOW_DEMO_SEED: process.env.ALLOW_DEMO_SEED,
  };
  const { assertDemoSeedAllowed } = await import("../dist/seed-demo.js");
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://xlrrank:xlrrank@db.example.com:5432/xlrrank";
    delete process.env.ALLOW_DEMO_SEED;
    assert.throws(() => assertDemoSeedAllowed(), /Demo seed is disabled/);

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://xlrrank:xlrrank@localhost:5432/xlrrank_test";
    process.env.ALLOW_DEMO_SEED = "true";
    assert.doesNotThrow(() => assertDemoSeedAllowed());
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("demo reset uses the same fail-closed production guard as demo seed", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    ALLOW_DEMO_SEED: process.env.ALLOW_DEMO_SEED,
  };
  const { resetDemoData } = await import("../dist/seed-demo.js");
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://xlrrank:xlrrank@db.example.com:5432/xlrrank";
    process.env.ALLOW_DEMO_SEED = "true";
    await assert.rejects(resetDemoData(), /Demo seed is disabled/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
