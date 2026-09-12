import test from "node:test";
import assert from "node:assert/strict";

test("profile avatar URLs are restricted to HTTP(S) and normalized", async () => {
  const { normalizeUserAvatarUrl } = await import("../dist/users/users.service.js");
  assert.equal(
    normalizeUserAvatarUrl(" https://example.com/avatar.png#frag "),
    "https://example.com/avatar.png",
  );
  assert.equal(normalizeUserAvatarUrl(""), null);
  assert.throws(() => normalizeUserAvatarUrl("javascript:alert(1)"), /HTTP\(S\)/);
  assert.throws(() => normalizeUserAvatarUrl("file:///etc/passwd"), /HTTP\(S\)/);
});

test("fatal API error logging redacts nested secret-bearing details", async () => {
  const { safeLoggableError } = await import("../dist/common/error-redaction.js");
  const redacted = safeLoggableError({
    message: "provider failed Authorization=Bearer token-value",
    nested: { apiKey: "secret-value" },
  });
  assert.deepEqual(redacted, {
    message: "provider failed Authorization=[REDACTED]",
    nested: { apiKey: "[REDACTED]" },
  });
});
