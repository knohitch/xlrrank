import test from "node:test";
import assert from "node:assert/strict";

const { credentialMayBeUsedForScope, validateCredentialScope } = await import("../dist/index.js");

test("BYOK credential validation rejects ambiguous tenant scope and empty secrets", () => {
  assert.deepEqual(validateCredentialScope({ providerId: "provider", apiKey: "sk-valid-key" }), {
    scopeKind: "SYSTEM",
    scopeId: null,
    label: "default",
    apiKey: "sk-valid-key",
  });
  assert.throws(
    () =>
      validateCredentialScope({
        providerId: "provider",
        apiKey: "sk-valid-key",
        scopeKind: "USER",
      }),
    /require a scope id/,
  );
  assert.throws(
    () =>
      validateCredentialScope({
        providerId: "provider",
        apiKey: "sk-valid-key",
        scopeKind: "SYSTEM",
        scopeId: "tenant-a",
      }),
    /must not have a tenant scope/,
  );
  assert.throws(
    () => validateCredentialScope({ providerId: "provider", apiKey: "  ", scopeKind: "SYSTEM" }),
    /outside allowed bounds/,
  );
});

test("BYOK credential scope checks prevent cross-tenant runtime credential use", () => {
  assert.equal(
    credentialMayBeUsedForScope({ scope_kind: "SYSTEM", scope_id: null }, undefined),
    true,
  );
  assert.equal(
    credentialMayBeUsedForScope({ scope_kind: "ORGANIZATION", scope_id: "tenant-a" }, "tenant-a"),
    true,
  );
  assert.equal(
    credentialMayBeUsedForScope({ scope_kind: "ORGANIZATION", scope_id: "tenant-a" }, "tenant-b"),
    false,
  );
  assert.equal(
    credentialMayBeUsedForScope({ scope_kind: "USER", scope_id: "user-a" }, undefined),
    false,
  );
});
