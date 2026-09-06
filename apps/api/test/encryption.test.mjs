import test from "node:test";
import assert from "node:assert/strict";

const MASTER_KEY = "audit-test-master-key-material-32-bytes-minimum";

test("secret encryption round-trips without storing plaintext", async () => {
  const { encryptSecret, decryptSecret } = await import("../dist/common/encryption.js");
  const plaintext = "super-sensitive-api-key";
  const encrypted = encryptSecret(plaintext, MASTER_KEY);

  assert.match(encrypted, /^enc:v1:/);
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(decryptSecret(encrypted, MASTER_KEY), plaintext);
});

test("secret encryption uses a fresh nonce", async () => {
  const { encryptSecret } = await import("../dist/common/encryption.js");
  const a = encryptSecret("same-value", MASTER_KEY);
  const b = encryptSecret("same-value", MASTER_KEY);
  assert.notEqual(a, b);
});

test("tampered ciphertext fails authentication", async () => {
  const { encryptSecret, decryptSecret } = await import("../dist/common/encryption.js");
  const encrypted = encryptSecret("protected", MASTER_KEY);
  const parts = encrypted.split(":");
  parts[4] = `${parts[4].slice(0, -1)}${parts[4].endsWith("A") ? "B" : "A"}`;
  const tampered = parts.join(":");
  assert.throws(() => decryptSecret(tampered, MASTER_KEY));
});

test("associated data binds ciphertext to one social connection context", async () => {
  const { encryptSecret, decryptSecret } = await import("../dist/common/encryption.js");
  const encrypted = encryptSecret(
    "connection-secret",
    MASTER_KEY,
    "social-connection:connection-a:scope-a:reference:credentials:v2",
  );

  assert.match(encrypted, /^enc:v2:/);
  assert.equal(
    decryptSecret(
      encrypted,
      MASTER_KEY,
      "social-connection:connection-a:scope-a:reference:credentials:v2",
    ),
    "connection-secret",
  );
  assert.throws(() =>
    decryptSecret(
      encrypted,
      MASTER_KEY,
      "social-connection:connection-b:scope-b:reference:credentials:v2",
    ),
  );
});

test("legacy reversible enc payloads are rejected", async () => {
  const { decryptSecret } = await import("../dist/common/encryption.js");
  assert.throws(() => decryptSecret("enc:cGxhaW50ZXh0", MASTER_KEY));
});
