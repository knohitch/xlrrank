import test from "node:test";
import assert from "node:assert/strict";

import { XConnector } from "../dist/index.js";

test("X connector requires real OAuth user credentials before authentication", async () => {
  const connector = new XConnector();
  assert.equal(connector.getStatus(), "DISCONNECTED");

  const result = await connector.authenticate({});
  assert.equal(result.success, false);
  assert.equal(result.status, "REAUTH_REQUIRED");
  assert.equal(connector.getStatus(), "DISCONNECTED");
  assert.equal(await connector.checkHealth(), false);
});

test("X connector does not report capabilities available without configuration", async () => {
  const connector = new XConnector();
  assert.equal(connector.getCapabilities().profiles, "CONFIGURATION_REQUIRED");
  assert.equal(connector.getCapabilities().search, "CONFIGURATION_REQUIRED");
  assert.equal(connector.getCapabilities().followers, "CONFIGURATION_REQUIRED");
  assert.equal(connector.getManifest().oauth.type, "authorization_code_pkce");
  assert.equal(connector.getManifest().oauth.pkceRequired, true);
});
