import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Pool } from "pg";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_MASTER_KEY ??= "integration-test-master-key-32b!";

const {
  createProviderAuthorizationCleanupRequestTx,
} = await import("@xlrrank/database");
const {
  JOB_TYPES,
} = await import("@xlrrank/queue");
const {
  encryptSecret,
  providerAppSecretAssociatedData,
  providerAuthorizationCleanupAssociatedData,
} = await import("@xlrrank/shared");
const {
  RedditConnector,
} = await import("@xlrrank/social-core");
const { processProviderAuthorizationCleanup } = await import("../dist/provider-authorization-cleanup-processor.js");

async function createTestScope(executor) {
  const userRes = await executor.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', 'Test User', 'ACTIVE') RETURNING id",
    [`user-worker-${Date.now()}-${Math.random()}@example.com`],
  );
  const userId = userRes.rows[0].id;
  const scopeRes = await executor.query(
    "INSERT INTO data_scopes (scope_type, user_id) VALUES ('PERSONAL', $1) RETURNING id",
    [userId],
  );
  return scopeRes.rows[0].id;
}

test("Sprint 09 Closure E2E: processProviderAuthorizationCleanup through real worker processor", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  let revokeCallCount = 0;
  let simulateRetryable = false;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/revoke_token" && req.method === "POST") {
      revokeCallCount++;
      if (simulateRetryable) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: 503, message: "Service Unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}`;

  process.env.REDDIT_TOKEN_BASE_URL = fixtureUrl;
  process.env.REDDIT_API_BASE_URL = fixtureUrl;

  try {
    const scopeId = await createTestScope(client);
    const platformId = randomUUID();
    const connectionId = randomUUID();
    const configId = randomUUID();
    const cleanupId = randomUUID();
    const platformSlug = "reddit";

    // 1. Setup platform
    const platRes = await client.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family)
       VALUES ($1, $2, 'Reddit', true, 'reddit')
       ON CONFLICT (slug) DO UPDATE SET enabled = true
       RETURNING id`,
      [platformId, platformSlug],
    );
    const effectivePlatformId = platRes.rows[0].id;

    // 2. Setup connection
    await client.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status)
       VALUES ($1, $2, $3, 'DISCONNECTED')`,
      [connectionId, scopeId, effectivePlatformId],
    );

    // 3. Setup provider app config in 'test' environment
    await client.query(
      `DELETE FROM provider_app_configurations WHERE platform_id = $1 AND environment = 'test'`,
      [effectivePlatformId],
    );

    const appSecretAad = providerAppSecretAssociatedData({
      providerConfigId: configId,
      platformSlug,
      secretName: "clientSecret",
    });
    const encryptedClientSecret = encryptSecret("mock-reddit-client-secret", undefined, appSecretAad);

    await client.query(
      `INSERT INTO provider_app_configurations (
         id, platform_id, environment, client_id, client_secret_encrypted,
         redirect_uri, enabled, metadata
       )
       VALUES ($1, $2, 'test', 'mock-reddit-client-id', $3, 'https://app.test/callback', true, '{"userAgent": "xlrrank-worker-test/1.0"}'::jsonb)`,
      [configId, effectivePlatformId, encryptedClientSecret],
    );

    // 4. Setup cleanup request with encrypted credentials
    const plaintextCreds = JSON.stringify({
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    });
    const cleanupAad = providerAuthorizationCleanupAssociatedData({
      cleanupId,
      scopeId,
      platformSlug,
    });
    const credentialsEncrypted = encryptSecret(plaintextCreds, undefined, cleanupAad);

    const cleanupRequest = await createProviderAuthorizationCleanupRequestTx(client, {
      id: cleanupId,
      connectionId,
      scopeId,
      platformId: effectivePlatformId,
      providerFamily: "reddit",
      credentialsEncrypted,
    });

    // 5. Invoke real worker processor
    const mockJob = {
      name: JOB_TYPES.providerAuthorizationCleanup,
      data: {
        version: 1,
        jobRequestId: cleanupRequest.jobId,
        cleanupId: cleanupRequest.cleanupId,
      },
    };

    await processProviderAuthorizationCleanup(mockJob);

    // 6. Assert revocation was called and secret wiped
    assert.equal(revokeCallCount, 1, "Revoke endpoint must be called once");

    const cleanupState = await client.query(
      "SELECT status, credentials_encrypted FROM provider_authorization_cleanups WHERE id = $1",
      [cleanupId],
    );
    assert.equal(cleanupState.rows[0]?.status, "COMPLETED");
    assert.equal(
      cleanupState.rows[0]?.credentials_encrypted,
      null,
      "Encrypted cleanup secret must be wiped upon successful completion",
    );

    // 7. Verify retryable failure retains encrypted cleanup material
    const retryCleanupId = randomUUID();
    const retryAad = providerAuthorizationCleanupAssociatedData({
      cleanupId: retryCleanupId,
      scopeId,
      platformSlug,
    });
    const retryCredsEncrypted = encryptSecret(plaintextCreds, undefined, retryAad);

    const retryRequest = await createProviderAuthorizationCleanupRequestTx(client, {
      id: retryCleanupId,
      connectionId: null,
      scopeId,
      platformId: effectivePlatformId,
      providerFamily: "reddit",
      credentialsEncrypted: retryCredsEncrypted,
    });

    simulateRetryable = true;
    const retryMockJob = {
      name: JOB_TYPES.providerAuthorizationCleanup,
      data: {
        version: 1,
        jobRequestId: retryRequest.jobId,
        cleanupId: retryRequest.cleanupId,
      },
    };

    await assert.rejects(
      () => processProviderAuthorizationCleanup(retryMockJob),
      /503/,
      "Retryable error must be re-thrown by processor",
    );

    const retryRow = await client.query(
      "SELECT status, attempt_count, credentials_encrypted FROM provider_authorization_cleanups WHERE id = $1",
      [retryCleanupId],
    );
    assert.equal(retryRow.rows[0]?.attempt_count, 1, "Attempt count must increment");
    assert.ok(
      retryRow.rows[0]?.credentials_encrypted,
      "Encrypted credentials must be RETAINED after retryable failure",
    );
  } finally {
    delete process.env.REDDIT_TOKEN_BASE_URL;
    delete process.env.REDDIT_API_BASE_URL;
    server.close();
    client.release();
    await pool.end();
  }
});

test("Defect 5 + 6: Reddit suspended account safety & rate limit short-circuit", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.includes("/user/suspended_acct/about.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { is_suspended: true, name: "suspended_acct" } }));
      return;
    }
    if (url.pathname.includes("/user/notfound_acct/about.json")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found", error: 404 }));
      return;
    }
    if (url.pathname.includes("/user/ratelimited_acct/about.json")) {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "12",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "12",
      });
      res.end(JSON.stringify({ message: "Too Many Requests" }));
      return;
    }
    if (url.pathname.includes("/user/normal_acct/about.json")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "100",
        "x-ratelimit-reset": "60",
      });
      res.end(JSON.stringify({ data: { name: "normal_acct", is_suspended: false } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}`;

  try {
    const connector = new RedditConnector({ baseUrl: fixtureUrl, tokenBaseUrl: fixtureUrl });
    const ctx = {
      credentials: {
        accessToken: "dummy-token",
        metadata: { userAgent: "xlrrank-test/1.0" },
      },
      signal: new AbortController().signal,
    };

    // 1. Suspended account -> UNKNOWN with ACCOUNT_SUSPENDED (Defect 6)
    // 2. 404 account -> UNKNOWN with ACCOUNT_NOT_FOUND_404 (Defect 6)
    const res1 = await connector.reconcileResources(
      [
        { id: "1", externalId: "t2_susp", entityType: "ACCOUNT", lookupKey: "suspended_acct" },
        { id: "2", externalId: "t2_404", entityType: "ACCOUNT", lookupKey: "notfound_acct" },
      ],
      ctx,
    );

    const sMap = new Map(res1.statuses.map((s) => [s.externalId, s]));
    assert.equal(sMap.get("t2_susp")?.state, "UNKNOWN");
    assert.equal(sMap.get("t2_susp")?.details?.reason, "ACCOUNT_SUSPENDED");
    assert.equal(sMap.get("t2_404")?.state, "UNKNOWN");
    assert.equal(sMap.get("t2_404")?.details?.reason, "ACCOUNT_NOT_FOUND_404");

    // 3. Rate-limited account -> short-circuits and defers remaining accounts (Defect 5)
    const res2 = await connector.reconcileResources(
      [
        { id: "3", externalId: "t2_rl", entityType: "ACCOUNT", lookupKey: "ratelimited_acct" },
        { id: "4", externalId: "t2_deferred1", entityType: "ACCOUNT", lookupKey: "deferred_one" },
        { id: "5", externalId: "t2_deferred2", entityType: "ACCOUNT", lookupKey: "deferred_two" },
      ],
      ctx,
    );

    const rlMap = new Map(res2.statuses.map((s) => [s.externalId, s]));
    assert.equal(rlMap.get("t2_deferred1")?.state, "UNKNOWN");
    assert.equal(rlMap.get("t2_deferred1")?.details?.reason, "DEFERRED_RATE_LIMIT");
    assert.equal(rlMap.get("t2_deferred2")?.state, "UNKNOWN");
    assert.equal(rlMap.get("t2_deferred2")?.details?.reason, "DEFERRED_RATE_LIMIT");
    assert.equal(res2.rateLimit?.remaining, 0);
    assert.equal(res2.rateLimit?.retryAfter, 12);
  } finally {
    server.close();
  }
});
