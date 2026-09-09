import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip =
  process.env.X_OAUTH_E2E !== "1" || !DATABASE_URL || !DATABASE_URL.includes("xlrrank_x_oauth_e2e");

let pool;
let database;
let shared;
let service;
let tokenCalls = 0;
let instagramLoginTokenCalls = 0;
let metaRequests = [];
let linkedInTokenCalls = 0;
let linkedInRequests = [];
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
  instagramLoginTokenCalls = 0;
  metaRequests = [];
  linkedInTokenCalls = 0;
  linkedInRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.facebook.com") return metaJson(url);
    if (url.hostname === "graph.instagram.com") return instagramGraphJson(url);
    if (url.hostname === "api.instagram.com") return instagramTokenJson(url, init);
    if (url.hostname === "api.linkedin.com" || url.hostname === "www.linkedin.com") return linkedInJson(url, init);
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
    "TRUNCATE webhook_receipts, provider_authorization_assets, provider_authorizations, oauth_authorization_transactions, provider_app_configurations, job_dead_letters, worker_heartbeats, social_sync_schedules, social_sync_leases, job_outbox, jobs, audit_logs, social_content_metrics, social_interaction_observations, social_interactions, social_content_observations, social_content_items, social_account_observations, social_ingestion_runs, social_connections, social_account_handles, social_external_accounts, social_accounts, data_scopes, organization_member_permissions, organization_members, organizations, platforms, users RESTART IDENTITY CASCADE",
  );
}

function metaJson(url) {
  metaRequests.push({ host: url.hostname, method: "GET", path: url.pathname, params: Object.fromEntries(url.searchParams) });
  if (url.pathname === "/v26.0/oauth/access_token") {
    return json({
      token_type: "bearer",
      access_token: "meta-user-token",
      expires_in: 5184000,
      scope:
        "public_profile,pages_show_list,pages_read_engagement,pages_read_user_content,read_insights,instagram_basic,instagram_manage_insights,instagram_manage_comments",
    });
  }
  if (url.searchParams.get("access_token") !== "meta-user-token" && !url.searchParams.get("access_token")?.startsWith("meta-page-token")) {
    return json({ error: { type: "OAuthException", code: 190, message: "bad token" } }, 401);
  }
  if (url.pathname === "/v26.0/me") {
    return json({ id: "meta-user-1", name: "Meta User" });
  }
  if (url.pathname === "/v26.0/me/accounts") {
    return json({
      data: [
        {
          id: "page-a",
          name: "Page A",
          username: "page_a",
          access_token: "meta-page-token-a",
          instagram_business_account: {
            id: "ig-a",
            username: "ig_a",
            name: "Instagram A",
            account_type: "BUSINESS",
          },
        },
        {
          id: "page-b",
          name: "Page B",
          username: "page_b",
          access_token: "meta-page-token-b",
        },
      ],
    });
  }
  if (url.pathname === "/v26.0/page-a") {
    return json({ id: "page-a", name: "Page A", username: "page_a", followers_count: 10, fan_count: 9 });
  }
  if (url.pathname === "/v26.0/page-b") {
    return json({ id: "page-b", name: "Page B", username: "page_b", followers_count: 20, fan_count: 19 });
  }
  if (url.pathname === "/v26.0/ig-a") {
    return json({
      id: "ig-a",
      username: "ig_a",
      name: "Instagram A",
      followers_count: 30,
      follows_count: 5,
      media_count: 7,
      account_type: "BUSINESS",
    });
  }
  return json({ error: { message: `not found: ${url.pathname}` } }, 404);
}

function instagramTokenJson(url, init) {
  const body = init.body instanceof URLSearchParams
    ? Object.fromEntries(init.body)
    : Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
  metaRequests.push({ host: url.hostname, method: init.method ?? "GET", path: url.pathname, body });
  if (url.pathname === "/oauth/access_token" && init.method === "POST") {
    instagramLoginTokenCalls += 1;
    return json({ access_token: `ig-short-token-${instagramLoginTokenCalls}`, user_id: "ig-direct-a" });
  }
  return json({ error: { message: `not found: ${url.pathname}` } }, 404);
}

function instagramGraphJson(url) {
  metaRequests.push({ host: url.hostname, method: "GET", path: url.pathname, params: Object.fromEntries(url.searchParams) });
  if (url.pathname === "/access_token") {
    assert.equal(url.searchParams.get("grant_type"), "ig_exchange_token");
    assert.match(url.searchParams.get("access_token") ?? "", /^ig-short-token-\d+$/);
    return json({ access_token: "ig-long-token", token_type: "bearer", expires_in: 5184000 });
  }
  if (url.pathname === "/refresh_access_token") {
    assert.equal(url.searchParams.get("grant_type"), "ig_refresh_token");
    return json({ access_token: "ig-refreshed-token", token_type: "bearer", expires_in: 5184000 });
  }
  if (url.searchParams.get("access_token") !== "ig-long-token") {
    return json({ error: { type: "OAuthException", code: 190, message: "bad token" } }, 401);
  }
  if (url.pathname === "/v26.0/me" || url.pathname === "/v26.0/ig-direct-a") {
    return json({
      user_id: "ig-direct-a",
      username: "ig_direct_a",
      name: "Instagram Direct A",
      followers_count: 40,
      follows_count: 6,
      media_count: 2,
      account_type: "BUSINESS",
    });
  }
  if (url.pathname === "/v26.0/ig-direct-a/media") {
    return json({ data: [{ id: "ig-direct-media-a", caption: "direct media", media_type: "IMAGE", timestamp: "2026-03-01T00:00:00+0000" }] });
  }
  if (url.pathname === "/v26.0/ig-direct-media-a/comments") {
    return json({ data: [{ id: "ig-direct-comment-a", text: "direct comment", timestamp: "2026-03-01T01:00:00+0000", username: "commenter" }] });
  }
  return json({ error: { message: `not found: ${url.pathname}` } }, 404);
}

function linkedInJson(url, init = {}) {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const body = init.body instanceof URLSearchParams
    ? Object.fromEntries(init.body)
    : (typeof init.body === "string" ? init.body : undefined);
  linkedInRequests.push({ host: url.hostname, method, path: url.pathname, params: Object.fromEntries(url.searchParams), body });

  if (url.pathname === "/oauth/v2/accessToken" && method === "POST") {
    linkedInTokenCalls += 1;
    return json({
      access_token: `synthetic-linkedin-access-${linkedInTokenCalls}`,
      refresh_token: `synthetic-linkedin-refresh-${linkedInTokenCalls}`,
      expires_in: 5184000,
      token_type: "Bearer",
      scope: "openid,profile,email,r_organization_social,rw_organization_admin,r_organization_admin,r_organization_social_feed",
    });
  }

  const auth = headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer synthetic-linkedin-access-")) {
    return json({ status: 401, message: "Unauthorized token" }, 401);
  }

  if (url.pathname === "/v2/userinfo") {
    return json({
      sub: "li-member-sub-123",
      name: "LinkedIn Member",
      email: "member@example.com",
      email_verified: true,
    });
  }

  if (url.pathname === "/rest/organizationAcls") {
    assert.equal(headers.get("linkedin-version"), "202608");
    assert.equal(headers.get("x-restli-protocol-version"), "2.0.0");
    return json({
      elements: [
        {
          role: "ADMINISTRATOR",
          organization: "urn:li:organization:12345",
          state: "APPROVED",
          roleAssignee: "urn:li:person:li-member-sub-123",
        },
        {
          role: "ANALYST",
          organization: "urn:li:organization:67890",
          state: "APPROVED",
          roleAssignee: "urn:li:person:li-member-sub-123",
        },
      ],
    });
  }

  if (url.pathname === "/rest/organizations/12345") {
    assert.equal(headers.get("linkedin-version"), "202608");
    assert.equal(headers.get("x-restli-protocol-version"), "2.0.0");
    return json({
      id: 12345,
      localizedName: "Acme Corp",
      vanityName: "acme-corp",
      localizedDescription: "Acme Corporation on LinkedIn",
      primaryOrganizationType: "COMPANY",
    });
  }

  if (url.pathname === "/rest/organizations/67890") {
    assert.equal(headers.get("linkedin-version"), "202608");
    assert.equal(headers.get("x-restli-protocol-version"), "2.0.0");
    return json({
      id: 67890,
      localizedName: "Beta Labs",
      vanityName: "beta-labs",
      localizedDescription: "Beta Labs on LinkedIn",
      primaryOrganizationType: "NON_PROFIT",
    });
  }

  return json({ message: `not found: ${url.pathname}` }, 404);
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

async function metaPlatform(slug = "facebook") {
  const result = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ($1, $2, true) RETURNING id",
    [slug, slug === "facebook" ? "Facebook" : "Instagram"],
  );
  return result.rows[0].id;
}

async function metaProviderConfig(platformId, slug = "facebook", metadata = {}) {
  const configId = randomUUID();
  const encrypted = shared.encryptSecret(
    "meta-app-secret",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId: configId,
      platformSlug: slug,
      secretName: "clientSecret",
    }),
  );
  await pool.query(
    `
      INSERT INTO provider_app_configurations (
        id, platform_id, environment, client_id, client_secret_encrypted,
        redirect_uri, enabled, metadata
      )
      VALUES ($1, $2, 'test', 'meta-app-id', $3,
        'https://app.example.test/platforms/meta/oauth/callback', true,
        $4::jsonb)
    `,
    [configId, platformId, encrypted, JSON.stringify({ webhookVerifyToken: "verify-token", ...metadata })],
  );
}

async function linkedinPlatform() {
  const result = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ('linkedin', 'LinkedIn', true) RETURNING id",
  );
  return result.rows[0].id;
}

async function linkedinProviderConfig(platformId) {
  const configId = randomUUID();
  const encrypted = shared.encryptSecret(
    "synthetic-linkedin-client-secret",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId: configId,
      platformSlug: "linkedin",
      secretName: "clientSecret",
    }),
  );
  await pool.query(
    `
      INSERT INTO provider_app_configurations (
        id, platform_id, environment, client_id, client_secret_encrypted,
        redirect_uri, enabled, metadata
      )
      VALUES ($1, $2, 'test', 'synthetic-linkedin-client-id', $3,
        'https://app.example.test/platforms/linkedin/oauth/callback', true,
        '{"access":{"fullArchiveSearch":false}}'::jsonb)
    `,
    [configId, platformId, encrypted],
  );
}

async function organizationWithManager(userId, name) {
  const org = await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [name]);
  const member = await pool.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id",
    [org.rows[0].id, userId],
  );
  await pool.query(
    "INSERT INTO organization_member_permissions (member_id, capability) VALUES ($1, 'MANAGE_SOCIAL_CONNECTIONS')",
    [member.rows[0].id],
  );
  return org.rows[0].id;
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

test("Meta webhook E2E: challenge, signature verification, and dedupe", { skip }, async () => {
  await reset();
  const platformId = await metaPlatform("facebook");
  await metaProviderConfig(platformId, "facebook");
  assert.equal(
    await service.verifyMetaWebhookChallenge("facebook", {
      mode: "subscribe",
      token: "verify-token",
      challenge: "challenge-value",
    }),
    "challenge-value",
  );
  await assert.rejects(
    () =>
      service.verifyMetaWebhookChallenge("facebook", {
        mode: "subscribe",
        token: "bad",
        challenge: "challenge-value",
      }),
    /verification failed/i,
  );

  const payload = {
    object: "page",
    entry: [{ id: "page-1", time: 1788912000, changes: [{ field: "feed", value: { post_id: "post-1" } }] }],
  };
  const signature = `sha256=${createHmac("sha256", "meta-app-secret")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")}`;
  await assert.rejects(
    () => service.receiveMetaWebhook("facebook", "sha256=00", payload),
    /signature verification failed/i,
  );
  const first = await service.receiveMetaWebhook("facebook", signature, payload);
  const second = await service.receiveMetaWebhook("facebook", signature, payload);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const count = await pool.query("SELECT count(*)::int AS count FROM webhook_receipts");
  assert.equal(count.rows[0].count, 1);
});

test("Meta OAuth E2E: shared grant, multi-asset selection, AAD, and IDOR", { skip }, async () => {
  await reset();
  const [userA, userB] = await Promise.all([user("meta-a@example.test"), user("meta-b@example.test")]);
  const facebookPlatformId = await metaPlatform("facebook");
  const instagramPlatformId = await metaPlatform("instagram");
  await metaProviderConfig(facebookPlatformId, "facebook");

  const start = await service.startOAuth("facebook", userA, { redirectTo: "/platforms/meta" });
  const callback = await service.handleOAuthCallback("facebook", userA, {
    state: stateFrom(start),
    code: "meta-ok",
  });
  assert.equal(callback.status, "ASSET_SELECTION_REQUIRED");
  assert.equal(callback.assets.length, 3);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM provider_authorizations")).rows[0].count),
    1,
  );
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM provider_authorization_assets")).rows[0].count),
    3,
  );
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM social_connections")).rows[0].count),
    0,
  );

  const listed = await service.listAuthorizationAssets(callback.authorizationId, userA);
  assert.equal(JSON.stringify(listed).includes("meta-page-token"), false);
  const pageA = listed.assets.find((asset) => asset.providerAssetId === "page-a");
  const pageB = listed.assets.find((asset) => asset.providerAssetId === "page-b");
  const igA = listed.assets.find((asset) => asset.providerAssetId === "ig-a");
  assert.ok(pageA);
  assert.ok(pageB);
  assert.ok(igA);

  await assert.rejects(
    () => service.listAuthorizationAssets(callback.authorizationId, userB),
    /denied/,
  );
  await assert.rejects(
    () => service.connectAuthorizationAsset(callback.authorizationId, pageA.id, userB),
    /denied/,
  );
  await assert.rejects(
    () => service.connectAuthorizationAsset(callback.authorizationId, "page-a", userA),
    /not found/i,
  );

  const connectedA = await service.connectAuthorizationAsset(callback.authorizationId, pageA.id, userA);
  const duplicateA = await service.connectAuthorizationAsset(callback.authorizationId, pageA.id, userA);
  const connectedB = await service.connectAuthorizationAsset(callback.authorizationId, pageB.id, userA);
  const connectedIg = await service.connectAuthorizationAsset(callback.authorizationId, igA.id, userA);
  assert.equal(connectedA.duplicate, false);
  assert.equal(duplicateA.duplicate, true);
  assert.equal(connectedB.platformId, facebookPlatformId);
  assert.equal(connectedIg.platformId, instagramPlatformId);

  const connections = await pool.query(
    "SELECT platform_id, verified_external_id, credentials_encrypted FROM social_connections ORDER BY verified_external_id",
  );
  assert.deepEqual(
    connections.rows.map((row) => row.verified_external_id),
    ["ig-a", "page-a", "page-b"],
  );
  assert.equal(JSON.stringify(connections.rows).includes("meta-page-token"), false);

  const grant = (
    await pool.query(
      "SELECT id, scope_id, credentials_encrypted FROM provider_authorizations WHERE id = $1",
      [callback.authorizationId],
    )
  ).rows[0];
  const grantPlain = shared.decryptSecret(
    grant.credentials_encrypted,
    undefined,
    shared.providerAuthorizationAssociatedData({
      authorizationId: grant.id,
      scopeId: grant.scope_id,
      providerFamily: "meta",
    }),
  );
  assert.equal(JSON.parse(grantPlain).accessToken, "meta-user-token");
  assert.throws(() =>
    shared.decryptSecret(
      grant.credentials_encrypted,
      undefined,
      shared.providerAuthorizationAssociatedData({
        authorizationId: randomUUID(),
        scopeId: grant.scope_id,
        providerFamily: "meta",
      }),
    ),
  );

  const assetRow = (
    await pool.query(
      `
        SELECT paa.id, paa.provider_authorization_id, pa.scope_id, p.slug,
               paa.provider_asset_id, paa.credentials_encrypted
        FROM provider_authorization_assets paa
        JOIN provider_authorizations pa ON pa.id = paa.provider_authorization_id
        JOIN platforms p ON p.id = paa.platform_id
        WHERE paa.id = $1
      `,
      [pageA.id],
    )
  ).rows[0];
  const assetPlain = shared.decryptSecret(
    assetRow.credentials_encrypted,
    undefined,
    shared.providerAuthorizationAssetAssociatedData({
      authorizationAssetId: assetRow.id,
      authorizationId: assetRow.provider_authorization_id,
      scopeId: assetRow.scope_id,
      platformSlug: assetRow.slug,
      providerAssetId: assetRow.provider_asset_id,
    }),
  );
  assert.equal(JSON.parse(assetPlain).accessToken, "meta-page-token-a");
  assert.throws(() =>
    shared.decryptSecret(
      assetRow.credentials_encrypted,
      undefined,
      shared.providerAuthorizationAssetAssociatedData({
        authorizationAssetId: assetRow.id,
        authorizationId: assetRow.provider_authorization_id,
        scopeId: assetRow.scope_id,
        platformSlug: assetRow.slug,
        providerAssetId: "page-b",
      }),
    ),
  );

  const orgA = await organizationWithManager(userA, "Meta Org A");
  const orgB = await organizationWithManager(userB, "Meta Org B");
  const orgStart = await service.startOAuth("facebook", userA, {
    scopeType: "ORGANIZATION",
    organizationId: orgA,
  });
  const orgCallback = await service.handleOAuthCallback("facebook", userA, {
    state: stateFrom(orgStart),
    code: "org-meta-ok",
  });
  await assert.rejects(
    () =>
      service.startOAuth("facebook", userA, {
        scopeType: "ORGANIZATION",
        organizationId: orgB,
      }),
    /denied/,
  );
  await assert.rejects(
    () => service.listAuthorizationAssets(orgCallback.authorizationId, userB),
    /denied/,
  );
});

test("Instagram Login OAuth E2E: direct auth mode, asset, AAD, and scope isolation", { skip }, async () => {
  await reset();
  const [userA, userB, userC] = await Promise.all([
    user("ig-login-a@example.test"),
    user("ig-login-b@example.test"),
    user("ig-login-c@example.test"),
  ]);
  const instagramPlatformId = await metaPlatform("instagram");
  await metaProviderConfig(instagramPlatformId, "instagram", { authMode: "INSTAGRAM_LOGIN" });

  await assert.rejects(
    () => service.startOAuth("instagram", userA, { requestedScopes: ["instagram_basic"] }),
    /not allowed/,
  );
  const start = await service.startOAuth("instagram", userA, {
    redirectTo: "/platforms/instagram",
    requestedScopes: ["instagram_business_basic", "instagram_business_manage_comments"],
  });
  const authorizationUrl = new URL(start.authorizationUrl);
  assert.equal(authorizationUrl.hostname, "www.instagram.com");
  assert.equal(authorizationUrl.pathname, "/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_comments");
  assert.equal(authorizationUrl.searchParams.get("scope").includes("instagram_basic"), false);
  assert.equal(authorizationUrl.searchParams.get("scope").includes("pages_show_list"), false);

  const callback = await service.handleOAuthCallback("instagram", userA, {
    state: stateFrom(start),
    code: "ig-login-code",
  });
  assert.equal(callback.status, "ASSET_SELECTION_REQUIRED");
  assert.equal(callback.assets.length, 1);
  assert.equal(callback.assets[0].providerAssetId, "ig-direct-a");
  assert.equal(callback.assets[0].parentProviderAssetId, null);
  assert.equal(metaRequests.some((request) => request.host === "graph.instagram.com" && request.path === "/v26.0/me"), true);
  assert.equal(metaRequests.some((request) => request.host === "graph.instagram.com" && request.path === "/v26.0/me/accounts"), false);
  assert.equal(metaRequests.some((request) => request.host === "api.instagram.com" && request.path === "/oauth/access_token" && request.method === "POST"), true);
  assert.equal(metaRequests.some((request) => request.host === "graph.instagram.com" && request.path === "/access_token"), true);
  assert.equal(metaRequests.some((request) => request.host === "graph.facebook.com"), false);

  const listed = await service.listAuthorizationAssets(callback.authorizationId, userA);
  assert.equal(JSON.stringify(listed).includes("ig-long-token"), false);
  const asset = listed.assets[0];
  assert.equal(asset.providerAssetId, "ig-direct-a");
  await assert.rejects(
    () => service.listAuthorizationAssets(callback.authorizationId, userB),
    /denied/,
  );
  await assert.rejects(
    () => service.connectAuthorizationAsset(callback.authorizationId, "ig-direct-a", userA),
    /not found/i,
  );

  const connected = await service.connectAuthorizationAsset(callback.authorizationId, asset.id, userA);
  assert.equal(connected.platformId, instagramPlatformId);
  assert.equal(connected.externalAccountId, "ig-direct-a");
  const duplicate = await service.connectAuthorizationAsset(callback.authorizationId, asset.id, userA);
  assert.equal(duplicate.duplicate, true);

  const grant = (
    await pool.query(
      "SELECT id, scope_id, provider_user_id, credentials_encrypted, granted_scopes FROM provider_authorizations WHERE id = $1",
      [callback.authorizationId],
    )
  ).rows[0];
  assert.equal(grant.provider_user_id, "ig-direct-a");
  assert.deepEqual(grant.granted_scopes, [
    "instagram_business_basic",
    "instagram_business_manage_comments",
  ]);
  assert.equal(grant.granted_scopes.includes("instagram_business_manage_insights"), false);
  const grantPlain = JSON.parse(shared.decryptSecret(
    grant.credentials_encrypted,
    undefined,
    shared.providerAuthorizationAssociatedData({
      authorizationId: grant.id,
      scopeId: grant.scope_id,
      providerFamily: "meta",
    }),
  ));
  assert.equal(grantPlain.accessToken, "ig-long-token");
  assert.equal(grantPlain.metadata.authMode, "INSTAGRAM_LOGIN");
  assert.deepEqual(grantPlain.scopes, [
    "instagram_business_basic",
    "instagram_business_manage_comments",
  ]);

  const assetRow = (
    await pool.query(
      `
        SELECT paa.id, paa.provider_authorization_id, pa.scope_id, p.slug,
               paa.provider_asset_id, paa.credentials_encrypted
        FROM provider_authorization_assets paa
        JOIN provider_authorizations pa ON pa.id = paa.provider_authorization_id
        JOIN platforms p ON p.id = paa.platform_id
        WHERE paa.id = $1
      `,
      [asset.id],
    )
  ).rows[0];
  const assetPlain = JSON.parse(shared.decryptSecret(
    assetRow.credentials_encrypted,
    undefined,
    shared.providerAuthorizationAssetAssociatedData({
      authorizationAssetId: assetRow.id,
      authorizationId: assetRow.provider_authorization_id,
      scopeId: assetRow.scope_id,
      platformSlug: assetRow.slug,
      providerAssetId: assetRow.provider_asset_id,
    }),
  ));
  assert.equal(assetPlain.accessToken, "ig-long-token");
  assert.equal(assetPlain.metadata.authMode, "INSTAGRAM_LOGIN");
  assert.deepEqual(assetPlain.scopes, [
    "instagram_business_basic",
    "instagram_business_manage_comments",
  ]);

  const connection = (
    await pool.query(
      "SELECT credentials_encrypted, provider_metadata FROM social_connections WHERE verified_external_id = 'ig-direct-a'",
    )
  ).rows[0];
  assert.equal(connection.credentials_encrypted.includes("ig-long-token"), false);
  assert.equal(JSON.stringify(connection.provider_metadata).includes("ig-long-token"), false);
  assert.equal(connection.provider_metadata.authMode, "INSTAGRAM_LOGIN");
  assert.deepEqual(connection.provider_metadata.grantedScopes, [
    "instagram_business_basic",
    "instagram_business_manage_comments",
  ]);
  assert.equal(connection.provider_metadata.grantedCapabilities.metrics, "AVAILABLE");

  const fullStart = await service.startOAuth("instagram", userC, {
    requestedScopes: [
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ],
  });
  const fullCallback = await service.handleOAuthCallback("instagram", userC, {
    state: stateFrom(fullStart),
    code: "ig-full-code",
  });
  const fullGrant = (
    await pool.query(
      "SELECT granted_scopes FROM provider_authorizations WHERE id = $1",
      [fullCallback.authorizationId],
    )
  ).rows[0];
  assert.deepEqual(fullGrant.granted_scopes, [
    "instagram_business_basic",
    "instagram_business_manage_insights",
    "instagram_business_manage_comments",
  ]);

  const orgA = await organizationWithManager(userA, "Instagram Login Org A");
  const orgB = await organizationWithManager(userB, "Instagram Login Org B");
  const orgStart = await service.startOAuth("instagram", userA, {
    scopeType: "ORGANIZATION",
    organizationId: orgA,
  });
  const orgCallback = await service.handleOAuthCallback("instagram", userA, {
    state: stateFrom(orgStart),
    code: "ig-org-code",
  });
  await assert.rejects(
    () => service.startOAuth("instagram", userA, { scopeType: "ORGANIZATION", organizationId: orgB }),
    /denied/,
  );
  await assert.rejects(
    () => service.listAuthorizationAssets(orgCallback.authorizationId, userB),
    /denied/,
  );
});

test(
  "LinkedIn OAuth: start, callback, OIDC identity, organization asset discovery, asset connect, IDOR, and webhooks",
  { skip },
  async () => {
    await reset();
    const userA = await user("linkedin-user-a@example.test");
    const userB = await user("linkedin-user-b@example.test");
    const platformId = await linkedinPlatform();
    await linkedinProviderConfig(platformId);

    // 1. Start OAuth
    const start = await service.startOAuth("linkedin", userA, {
      scopeType: "PERSONAL",
      redirectTo: "/platforms?connected=linkedin",
    });
    assert.ok(start.authorizationUrl);
    const startUrl = new URL(start.authorizationUrl);
    assert.equal(startUrl.hostname, "www.linkedin.com");
    assert.equal(startUrl.pathname, "/oauth/v2/authorization");
    assert.equal(startUrl.searchParams.get("client_id"), "synthetic-linkedin-client-id");
    assert.equal(startUrl.searchParams.get("response_type"), "code");
    assert.equal(startUrl.searchParams.get("redirect_uri"), "https://app.example.test/platforms/linkedin/oauth/callback");
    const state = startUrl.searchParams.get("state");
    assert.ok(state);

    // 2. Complete OAuth Callback -> returns ASSET_SELECTION_REQUIRED
    const callback = await service.handleOAuthCallback("linkedin", userA, {
      state,
      code: "synthetic-linkedin-auth-code",
    });
    assert.equal(callback.status, "ASSET_SELECTION_REQUIRED");
    assert.ok(callback.authorizationId);
    assert.equal(callback.assets.length, 2);

    // 3. Verify provider authorization in database
    const grant = (
      await pool.query(
        "SELECT * FROM provider_authorizations WHERE id = $1",
        [callback.authorizationId],
      )
    ).rows[0];
    assert.equal(grant.provider_family, "linkedin");
    assert.equal(grant.provider_user_id, "li-member-sub-123");
    assert.equal(grant.status, "ACTIVE");

    // 4. List authorization assets
    const assetList = await service.listAuthorizationAssets(callback.authorizationId, userA);
    assert.equal(assetList.assets.length, 2);
    const acmeAsset = assetList.assets.find((a) => a.providerAssetId === "12345");
    const betaAsset = assetList.assets.find((a) => a.providerAssetId === "67890");
    assert.ok(acmeAsset);
    assert.ok(betaAsset);
    assert.equal(acmeAsset.name, "Acme Corp");
    assert.equal(acmeAsset.handle, "acme-corp");
    assert.equal(acmeAsset.assetType, "LINKEDIN_ORGANIZATION");
    assert.equal(acmeAsset.metadata.primaryRole, "ADMINISTRATOR");
    assert.equal(betaAsset.name, "Beta Labs");
    assert.equal(betaAsset.handle, "beta-labs");
    assert.equal(betaAsset.metadata.primaryRole, "ANALYST");

    // 5. Tenant / User isolation: User B cannot list or connect User A's assets
    await assert.rejects(
      () => service.listAuthorizationAssets(callback.authorizationId, userB),
      /denied/,
    );
    await assert.rejects(
      () => service.connectAuthorizationAsset(callback.authorizationId, acmeAsset.id, userB),
      /denied/,
    );

    // 6. Connect Acme Asset
    const connected1 = await service.connectAuthorizationAsset(
      callback.authorizationId,
      acmeAsset.id,
      userA,
    );
    assert.equal(connected1.status, "CONNECTED");
    assert.ok(connected1.connectionId);
    assert.equal(connected1.handle, "acme-corp");

    // 7. Verify Social Connection record in database
    const conn1 = (
      await pool.query(
        "SELECT * FROM social_connections WHERE id = $1",
        [connected1.connectionId],
      )
    ).rows[0];
    assert.equal(conn1.status, "CONNECTED");
    assert.equal(conn1.verified_external_id, "12345");
    assert.equal(conn1.verified_handle, "acme-corp");

    // 8. Connect Beta Asset in the same scope (multi-asset support)
    const connected2 = await service.connectAuthorizationAsset(
      callback.authorizationId,
      betaAsset.id,
      userA,
    );
    assert.equal(connected2.status, "CONNECTED");
    assert.notEqual(connected2.connectionId, connected1.connectionId);
    assert.equal(connected2.handle, "beta-labs");

    // 9. Reconnecting Acme Asset idempotently
    const reconnected1 = await service.connectAuthorizationAsset(
      callback.authorizationId,
      acmeAsset.id,
      userA,
    );
    assert.equal(reconnected1.status, "CONNECTED");
    assert.equal(reconnected1.connectionId, connected1.connectionId);

    // 10. Webhook challenge-response handshake
    const challengeRes = await service.verifyLinkedInWebhookChallenge(platformId, {
      challengeCode: "test-challenge-code-123",
    });
    assert.equal(challengeRes.challengeCode, "test-challenge-code-123");
    const expectedHmac = createHmac("sha256", "synthetic-linkedin-client-secret")
      .update("test-challenge-code-123")
      .digest("hex");
    assert.equal(challengeRes.challengeResponse, expectedHmac);

    // 11. Webhook delivery POST with valid HMAC signature
    const webhookPayload = {
      notificationId: "notif-uuid-001",
      eventTime: Date.now(),
      resource: "urn:li:organization:12345",
      action: "ORGANIZATION_SOCIAL_ACTION",
    };
    const rawBody = JSON.stringify(webhookPayload);
    const signature = createHmac("sha256", "synthetic-linkedin-client-secret")
      .update(rawBody)
      .digest("hex");

    const webhookResult = await service.receiveLinkedInWebhook(
      platformId,
      signature,
      webhookPayload,
      rawBody,
    );
    assert.equal(webhookResult.status, "received");
    assert.equal(webhookResult.duplicate, false);
    assert.ok(webhookResult.receiptId);
    assert.ok(webhookResult.job);

    // Verify receipt stored in DB
    const receipt = (
      await pool.query("SELECT * FROM webhook_receipts WHERE id = $1", [webhookResult.receiptId])
    ).rows[0];
    assert.equal(receipt.provider_family, "linkedin");
    assert.equal(receipt.signature_valid, true);
    assert.equal(receipt.status, "PENDING_DISPATCH");

    // 12. Webhook deduplication: send identical payload again
    const duplicateResult = await service.receiveLinkedInWebhook(
      platformId,
      signature,
      webhookPayload,
      rawBody,
    );
    assert.equal(duplicateResult.status, "received");
    assert.equal(duplicateResult.duplicate, true);

    // 13. Invalid signature rejected with 403 Forbidden
    await assert.rejects(
      () => service.receiveLinkedInWebhook(platformId, "invalid-sig", webhookPayload, rawBody),
      /signature verification failed/,
    );
  },
);
