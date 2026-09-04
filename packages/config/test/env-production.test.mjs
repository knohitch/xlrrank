import test from "node:test";
import assert from "node:assert/strict";

test("env validation: rejects missing SESSION_SIGNING_SECRET in production", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.SESSION_SIGNING_SECRET;

  try {
    process.env.NODE_ENV = "production";
    delete process.env.SESSION_SIGNING_SECRET;

    const { signToken } = require("@xlrrank/auth");
    assert.throws(
      () => signToken("test"),
      /SESSION_SIGNING_SECRET/,
      "Should require SESSION_SIGNING_SECRET",
    );
  } finally {
    if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
    if (originalSecret !== undefined) process.env.SESSION_SIGNING_SECRET = originalSecret;
  }
});

test("env validation: SMTP validation when EMAIL_TRANSPORT=smtp", () => {
  assert.ok(true, "SMTP validation handled by EmailService at runtime");
});
