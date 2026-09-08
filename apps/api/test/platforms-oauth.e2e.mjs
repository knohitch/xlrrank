import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip =
  process.env.X_OAUTH_E2E !== "1" || !DATABASE_URL || !DATABASE_URL.includes("xlrrank_x_oauth_e2e");

let pool;
let database;
let shared;
let service;
let tokenCalls = 0;
const originalFetch = globalThis.fetch;

async function setup() {
  if (pool) return;
  process.env.NODE_ENV = "test";
  process.env.ENCRYPTION_MASTER_KEY ??= "x-oauth-e2e-master-key-32-bytes-minimum";
  database = await import("@xlrrank/database");
  shared = await import("@xlrrank/shared");
  const { PlatformsService } = await import("../dist/platforms/platforms.service.js");
  await database.runMigrations();
  pool = database.getPool();
  service = new PlatformsService({ record: async () => undefined });
}

async function reset() {
  await setup();
  tokenCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.x.com") throw new Error(`Unexpected outbound fetch: ${url}`);
    if (url.pathname === "/2/oauth2/token") {
      tokenCalls += 1;
      return json({
        token_type: "bearer",
        access_token: `synthetic-access-${tokenCalls}`,
        refresh_token: `synthetic-refresh-${tokenCalls}`,
        expires_in: 7200,
        scope: "tweet.read users.read follows.read offline.access",
      });
    }
    const authorization = new Headers(init.headers).get("authorization") ?? "";
    if (!authorization.startsWith("Bearer synthetic-access-")) {
      return json({ errors: [{ title: "Unauthorized" }] }, 401);
    }
    if (url.pathname === "/2/users/me") {
      return json({
        data: {
          id: "1001",
          username: "xlr_fixture",
          name: "XLR Fixture",
          public_metrics: { followers_count: 1, following_count: 2, post_count: 3 },
        },
      });
    }
    return json({ errors: [{ title: "not found" }] }, 404);
  };
  await pool.query(
    "TRUNCATE oauth_authorization_transactions, provider_app_configurations, job_dead_letters, worker_heartbeats, social_sync_schedules, social_sync_leases, job_outbox, jobs, audit_logs, social_content_metrics, social_interaction_observations, social_interactions, social_content_observations, social_content_items, social_account_observations, social_ingestion_runs, social_connections, social_account_handles, social_external_accounts, social_accounts, data_scopes, organization_member_permissions, organization_members, organizations, platforms, users RESTART IDENTITY CASCADE",
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function user(email) {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [email, email],
  );
  return result.rows[0].id;
}

async function xPlatform() {
  const result = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ('x', 'X', true) RETURNING id",
  );
  return result.rows[0].id;
}

async function providerConfig(platformId) {
  const configId = randomUUID();
  const encrypted = shared.encryptSecret(
    "synthetic-client-secret",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId: configId,
      platformSlug: "x",
      secretName: "clientSecret",
    }),
  );
  await pool.query(
    `
      INSERT INTO provider_app_configurations (
        id, platform_id, environment, client_id, client_secret_encrypted,
        redirect_uri, enabled, metadata
      )
      VALUES ($1, $2, 'test', 'synthetic-client-id', $3,
        'https://app.example.test/platforms/x/oauth/callback', true,
        '{"access":{"fullArchiveSearch":false}}'::jsonb)
    `,
    [configId, platformId, encrypted],
  );
}

function stateFrom(result) {
  return new URL(result.authorizationUrl).searchParams.get("state");
}

test.after(async () => {
  globalThis.fetch = originalFetch;
  await database?.closeDatabase?.();
});

test(
  "X OAuth E2E: state, PKCE, replay, actor binding, redirects, and token storage",
  { skip },
  async () => {
    await reset();
    const [userA, userB] = await Promise.all([user("a@example.test"), user("b@example.test")]);
    const platformId = await xPlatform();
    await providerConfig(platformId);

    await assert.rejects(
      () => service.startOAuth("x", userA, { redirectTo: "https://evil.example/callback" }),
      /application-local/,
    );
    await assert.rejects(() => service.startOAuth("x", userA, { redirectTo: "%E0%A4%A" }));

    const start = await service.startOAuth("x", userA, { redirectTo: "/platforms?connected=x" });
    const state = stateFrom(start);
    assert.ok(state);
    const tx = (
      await pool.query(
        "SELECT state_digest, pkce_verifier, requested_scopes, redirect_to, expires_at, used_at FROM oauth_authorization_transactions",
      )
    ).rows[0];
    assert.notEqual(tx.state_digest, state);
    assert.ok(tx.state_digest.length >= 32);
    assert.ok(tx.pkce_verifier.length >= 43);
    assert.equal(tx.redirect_to, "/platforms?connected=x");
    assert.equal(tx.used_at, null);
    assert.ok(tx.expires_at.getTime() > Date.now());

    await assert.rejects(
      () => service.handleOAuthCallback("x", userB, { state, code: "wrong-user" }),
      /does not match/,
    );
    const [first, replay] = await Promise.allSettled([
      service.handleOAuthCallback("x", userA, { state, code: "ok" }),
      service.handleOAuthCallback("x", userA, { state, code: "replay" }),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(replay.status, "rejected");
    assert.match(replay.reason.message, /already used|does not match|invalid/);

    const connection = (
      await pool.query(
        "SELECT credentials_encrypted, provider_metadata FROM social_connections WHERE platform_id = $1",
        [platformId],
      )
    ).rows[0];
    assert.equal(connection.credentials_encrypted.includes("synthetic-access"), false);
    assert.equal(connection.credentials_encrypted.includes("synthetic-refresh"), false);
    assert.equal(JSON.stringify(connection.provider_metadata).includes("synthetic-access"), false);
    assert.equal(JSON.stringify(connection.provider_metadata).includes("synthetic-refresh"), false);

    const expired = await service.startOAuth("x", userA, {});
    await pool.query(
      "UPDATE oauth_authorization_transactions SET expires_at = now() - interval '1 minute'",
    );
    await assert.rejects(
      () => service.handleOAuthCallback("x", userA, { state: stateFrom(expired), code: "late" }),
      /expired/,
    );
  },
);

test(
  "X OAuth E2E: organization scope binding prevents cross-tenant connection",
  { skip },
  async () => {
    await reset();
    const userId = await user("org@example.test");
    const platformId = await xPlatform();
    await providerConfig(platformId);
    const [orgA, orgB] = await Promise.all([
      pool.query("INSERT INTO organizations (name) VALUES ('Org A') RETURNING id"),
      pool.query("INSERT INTO organizations (name) VALUES ('Org B') RETURNING id"),
    ]);
    const member = await pool.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id",
      [orgA.rows[0].id, userId],
    );
    await pool.query(
      "INSERT INTO organization_member_permissions (member_id, capability) VALUES ($1, 'MANAGE_SOCIAL_CONNECTIONS')",
      [member.rows[0].id],
    );
    const scopeA = await database.ensureOrganizationScope(orgA.rows[0].id);
    const scopeB = await database.ensureOrganizationScope(orgB.rows[0].id);

    await assert.rejects(
      () =>
        service.startOAuth("x", userId, {
          scopeType: "ORGANIZATION",
          organizationId: orgB.rows[0].id,
        }),
      /denied/,
    );
    const start = await service.startOAuth("x", userId, {
      scopeType: "ORGANIZATION",
      organizationId: orgA.rows[0].id,
    });
    await service.handleOAuthCallback("x", userId, { state: stateFrom(start), code: "org-ok" });
    const connectionScope = (
      await pool.query("SELECT scope_id FROM social_connections WHERE platform_id = $1", [
        platformId,
      ])
    ).rows[0].scope_id;
    assert.equal(connectionScope, scopeA);
    assert.notEqual(connectionScope, scopeB);
  },
);
