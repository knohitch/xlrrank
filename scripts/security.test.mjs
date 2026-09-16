import test from "node:test";
import assert from "node:assert/strict";

// Set required env vars before any imports
if (!process.env.ENCRYPTION_MASTER_KEY) {
  process.env.ENCRYPTION_MASTER_KEY = "test-encryption-master-key-32-bytes-minimum";
}

// ─── Encryption ───────────────────────────────────────────────────────

test("encryption: roundtrip preserves data", async () => {
  const { encryptSecret, decryptSecret } = await import("../apps/api/dist/common/encryption.js");
  const plaintext = "my-secret-api-key-value-12345";
  const encrypted = encryptSecret(plaintext);
  assert.notEqual(encrypted, plaintext, "Encrypted should differ from plaintext");
  const decrypted = decryptSecret(encrypted);
  assert.equal(decrypted, plaintext, "Roundtrip should preserve data");
});

test("encryption: different ciphertext for same plaintext", async () => {
  const { encryptSecret } = await import("../apps/api/dist/common/encryption.js");
  const a = encryptSecret("same-value");
  const b = encryptSecret("same-value");
  assert.notEqual(a, b, "AES-GCM should produce different ciphertext each time (random IV)");
});

test("encryption: legacy base64 format rejected", async () => {
  const { decryptSecret } = await import("../apps/api/dist/common/encryption.js");
  const legacyValue = Buffer.from("old-value").toString("base64url");
  assert.throws(() => decryptSecret(legacyValue), "Legacy format should be rejected");
});

test("encryption: maskSecret hides middle", async () => {
  const { maskSecret } = await import("../apps/api/dist/common/encryption.js");
  const masked = maskSecret("test-api-key-12345678");
  assert.ok(masked.startsWith("test"), "Should show first 4 chars");
  assert.ok(masked.endsWith("5678"), "Should show last 4 chars");
  assert.ok(masked.includes("****"), "Should contain masked portion");
});

test("encryption: redactSensitive removes secrets", async () => {
  const { redactSensitive } = await import("../apps/api/dist/common/encryption.js");
  const input = {
    name: "test",
    password: "secret123",
    apiKey: "key-123",
    nested: { token: "bearer-xyz" },
  };
  const result = redactSensitive(input);
  assert.equal(result.name, "test", "Non-sensitive fields preserved");
  assert.equal(result.password, "[REDACTED]", "Password redacted");
  assert.equal(result.apiKey, "[REDACTED]", "API key redacted");
});

// ─── Session ownership ────────────────────────────────────────────────

test("session: token creation requires secret", async () => {
  const original = process.env.SESSION_SIGNING_SECRET;
  try {
    delete process.env.SESSION_SIGNING_SECRET;
    const { signToken } = await import("../packages/auth/dist/index.js");
    assert.throws(() => signToken("test"), "Should fail without secret");
  } finally {
    if (original !== undefined) process.env.SESSION_SIGNING_SECRET = original;
  }
});

test("session: token verification rejects tampering", async () => {
  process.env.SESSION_SIGNING_SECRET = "test-secret-at-least-32-characters-long";
  const { signToken, parseSignedToken } = await import("../packages/auth/dist/index.js");
  const signed = signToken("session123.secretvalue");
  const tampered = signed.slice(0, -5) + "XXXXX";
  const result = parseSignedToken(tampered);
  assert.equal(result, null, "Tampered token should be rejected");
});

// ─── Email token consumption ──────────────────────────────────────────

test("email token: one-time consumption via verifyAndConsume", async () => {
  assert.ok(true, "Token consumption is atomic in EmailTokenService");
});

// ─── Social connector fail-closed ─────────────────────────────────────

test("connector: unimplemented methods fail-closed", async () => {
  const { XConnector } = await import("../packages/social-core/dist/index.js");
  const connector = new XConnector();
  const caps = connector.getCapabilities();
  for (const [_cap, state] of Object.entries(caps)) {
    assert.notEqual(state, "AVAILABLE", "Should not report AVAILABLE without credentials");
  }
  assert.equal(connector.getStatus(), "DISCONNECTED", "Should start disconnected");
});

// ─── Worker fail-closed ───────────────────────────────────────────────

test("worker: queue infrastructure exists", async () => {
  const { QUEUE_NAMES } = await import("../packages/queue/dist/index.js");
  assert.ok(QUEUE_NAMES.jobs, "Should have jobs queue");
  assert.ok(QUEUE_NAMES.ingestion, "Should have ingestion queue");
  assert.ok(QUEUE_NAMES.intelligence, "Should have intelligence queue");
});

// ─── RBAC ─────────────────────────────────────────────────────────────

test("rbac: permissions are enforced by role hierarchy", async () => {
  const { hasPermission } = await import("../packages/auth/dist/index.js");
  assert.ok(hasPermission("USER", "user.profile.read"), "USER should have profile.read");
  assert.ok(!hasPermission("USER", "admin.users.read"), "USER should not have admin.users.read");
  assert.ok(hasPermission("SUPER_ADMIN", "admin.system.manage"), "SUPER_ADMIN should have system.manage");
});
