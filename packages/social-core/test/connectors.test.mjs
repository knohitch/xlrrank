import test from "node:test";
import assert from "node:assert/strict";

import {
  XConnector,
  AuthenticationError,
  CapabilityUnavailableError,
} from "../dist/index.js";

test("interface-only connector cannot claim authentication success", async () => {
  const connector = new XConnector();
  assert.equal(connector.getStatus(), "DISCONNECTED");

  await assert.rejects(
    connector.authenticate({ accessToken: "not-a-real-token" }),
    AuthenticationError,
  );
  assert.equal(connector.getStatus(), "DISCONNECTED");
  assert.equal(await connector.checkHealth(), false);
});

test("configuration-required capability cannot return fake empty production data", async () => {
  const connector = new XConnector();
  await assert.rejects(
    connector.getProfile("someone"),
    CapabilityUnavailableError,
  );
  await assert.rejects(
    connector.getContent({ limit: 10 }),
    CapabilityUnavailableError,
  );
});
