import test from "node:test";
import assert from "node:assert/strict";

const security = await import("../dist/security.js");
const isSupportedSocialUrl = security.isSupportedSocialUrl ?? security.a;
const parseExtensionMessage = security.parseExtensionMessage ?? security.p;
const boundedText = security.boundedText ?? security.b;
const isTrustedExtensionSender = security.isTrustedExtensionSender ?? security.i;
const MAX_CONTENT_TEXT_LENGTH = security.MAX_CONTENT_TEXT_LENGTH ?? security.e;

test("extension URL validation accepts only exact HTTPS supported hosts", () => {
  assert.equal(isSupportedSocialUrl("https://x.com/example"), true);
  assert.equal(isSupportedSocialUrl("https://www.linkedin.com/in/example"), true);
  assert.equal(isSupportedSocialUrl("http://x.com/example"), false);
  assert.equal(isSupportedSocialUrl("https://evilx.com/example"), false);
  assert.equal(isSupportedSocialUrl("https://x.com.evil.example/example"), false);
  assert.equal(isSupportedSocialUrl("not a url"), false);
});

test("extension message schema rejects unsupported, oversized, and auth-bearing messages", () => {
  assert.deepEqual(parseExtensionMessage({ type: "xlrrank:detect-profile" }), {
    type: "xlrrank:detect-profile",
  });
  assert.equal(
    parseExtensionMessage({ type: "xlrrank:set-auth", auth: { token: "secret" } }),
    null,
  );
  assert.equal(parseExtensionMessage({ type: "xlrrank:detect-profile", tenantId: "other" }), null);
  assert.equal(parseExtensionMessage("xlrrank:detect-profile"), null);
});

test("extension text extraction bounds page-controlled fields", () => {
  const long = "x".repeat(5_000);
  assert.equal(boundedText(long, MAX_CONTENT_TEXT_LENGTH).length, 2_000);
  assert.equal(boundedText("  hello \n world  ", 50), "hello world");
});

test("extension sender validation requires the installed extension id", () => {
  assert.equal(isTrustedExtensionSender({ id: "extension-id" }, "extension-id"), true);
  assert.equal(isTrustedExtensionSender({ id: "other-id" }, "extension-id"), false);
  assert.equal(isTrustedExtensionSender(undefined, "extension-id"), false);
});
