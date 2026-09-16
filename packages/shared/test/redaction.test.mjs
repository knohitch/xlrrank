import test from "node:test";
import assert from "node:assert/strict";

const { redactSensitive, redactSensitiveText } = await import("../dist/index.js");

test("central redaction removes common secret forms from text", () => {
  const fakeApiKey = ["sk", "testSECRET123456789"].join("-");
  const input = `Authorization: Bearer abc.def-123 and api_key=${fakeApiKey}`;
  const redacted = redactSensitiveText(input);
  assert.equal(redacted.includes("abc.def-123"), false);
  assert.equal(redacted.includes(fakeApiKey), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /api_key=\[REDACTED\]/);
});

test("central object redaction masks sensitive keys and nested secret-bearing strings", () => {
  const redacted = redactSensitive({
    token: "secret-token",
    nested: { error: "provider failed with Authorization=Bearer abc123XYZ456" },
  });
  assert.equal(redacted.token, "[REDACTED]");
  assert.deepEqual(redacted.nested, { error: "provider failed with Authorization=[REDACTED]" });
});
