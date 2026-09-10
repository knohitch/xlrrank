import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL ?? process.env.QUEUE_URL ?? "";
const skip =
  process.env.WORKER_INGESTION_E2E !== "1" ||
  !DATABASE_URL ||
  !REDIS_URL ||
  !DATABASE_URL.includes("xlrrank_worker_e2e");

let pool;
let database;
let shared;
let queue;
const activeWorkers = new Set();

async function setup() {
  if (pool) return;
  process.env.ENCRYPTION_MASTER_KEY ??= "worker-e2e-master-key-32-bytes-minimum";
  database = await import("@xlrrank/database");
  shared = await import("@xlrrank/shared");
  queue = await import("@xlrrank/queue");
  await database.runMigrations();
  pool = new Pool({ connectionString: DATABASE_URL });
}

async function reset() {
  await setup();
  process.env.QUEUE_PREFIX = `xlrrank-worker-e2e-${process.pid}-${Date.now()}-${Math.random()}`;
  await pool.query(
    "TRUNCATE webhook_receipts, provider_event_subscriptions, provider_authorization_assets, provider_authorizations, oauth_authorization_transactions, provider_app_configurations, job_dead_letters, worker_heartbeats, social_sync_schedules, social_sync_leases, job_outbox, jobs, audit_logs, social_content_metrics, social_interaction_observations, social_interactions, social_content_observations, social_content_items, social_account_observations, social_ingestion_runs, social_connections, social_account_handles, social_external_accounts, social_accounts, data_scopes, organization_member_permissions, organization_members, organizations, platforms, users RESTART IDENTITY CASCADE",
  );
}

function createFixtureServer() {
  const tokenState = new Map();
  const tokenLog = [];
  const server = http.createServer(async (req, res) => {
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    tokenLog.push({ token, url: req.url, at: Date.now() });
    const state = tokenState.get(token) ?? { mode: token, contentCalls: 0 };
    tokenState.set(token, state);

    if (!token || token === "reauth") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "auth" }));
      return;
    }
    if (req.url?.startsWith("/auth/me")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `profile-${token}`,
          handle: `handle-${token}`,
          displayName: `Handle ${token}`,
          visibility: "PUBLIC",
        }),
      );
      return;
    }

    if (req.url?.startsWith("/content")) {
      state.contentCalls += 1;
      if (token === "temporary" && state.contentCalls === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporary" }));
        return;
      }
      if (token === "rate-limit" && state.contentCalls === 1) {
        res.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate-limit" }));
        return;
      }
      if (token === "permanent") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "permanent" }));
        return;
      }
      if (token === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{");
        return;
      }
      const cursor = new URL(`http://fixture${req.url}`).searchParams.get("cursor");
      const page = cursor === "page-1" ? 2 : 1;
      res.writeHead(200, {
        "content-type": "application/json",
        "x-fixture-rate-remaining": "99",
      });
      res.end(
        JSON.stringify({
          items:
            cursor === "done"
              ? []
              : [
                  {
                    id: `post-${token}-${page}`,
                    authorId: `profile-${token}`,
                    body: `public post ${page}`,
                    visibility: "PUBLIC",
                    createdAt: `2030-01-0${page}T00:00:00.000Z`,
                    metrics: { likes: page, comments: 0, shares: 0, impressions: page },
                  },
                ],
          nextCursor: cursor === "page-1" || cursor === "done" ? "done" : "page-1",
          hasMore: cursor === null,
        }),
      );
      return;
    }

    if (req.url?.startsWith("/interactions")) {
      const cursor = new URL(`http://fixture${req.url}`).searchParams.get("cursor");
      const page = cursor === "page-1" ? 2 : 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          items:
            cursor === "done"
              ? []
              : [
                  {
                    id: `interaction-${token}-${page}`,
                    fromId: `profile-${token}`,
                    toContentId: `post-${token}-${page}`,
                    type: "LIKE",
                    visibility: "PUBLIC",
                    occurredAt: `2030-01-0${page}T00:00:01.000Z`,
                  },
                ],
          nextCursor: cursor === "page-1" || cursor === "done" ? "done" : "page-1",
          hasMore: cursor === null,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  return {
    tokenLog,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createXFixtureServer() {
  const tokenLog = [];
  const contentCalls = new Map();
  const refreshCalls = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = String(req.headers.authorization ?? "");
    tokenLog.push({ authorization, url: url.pathname + url.search, at: Date.now() });

    if (url.pathname === "/2/oauth2/token" && req.method === "POST") {
      const body = await readBody(req);
      const refreshToken = new URLSearchParams(body).get("refresh_token");
      res.setHeader("content-type", "application/json");
      const refreshCount = (refreshCalls.get(refreshToken) ?? 0) + 1;
      refreshCalls.set(refreshToken, refreshCount);
      if (refreshToken === "x-refresh-reauth") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      if (refreshToken === "x-refresh-race") {
        if (refreshCount > 1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        await delay(1_000);
        res.end(
          JSON.stringify({
            token_type: "bearer",
            access_token: "x-access-race-2",
            refresh_token: "x-refresh-race-2",
            expires_in: 7200,
            scope: "tweet.read users.read follows.read offline.access",
          }),
        );
        return;
      }
      const suffix = refreshToken === "x-refresh-rate" ? "rate" : "ok";
      res.end(
        JSON.stringify({
          token_type: "bearer",
          access_token: `x-access-${suffix}`,
          refresh_token: `x-refresh-${suffix}-rotated`,
          expires_in: 7200,
          scope: "tweet.read users.read follows.read offline.access",
        }),
      );
      return;
    }

    const accessToken = authorization.replace("Bearer ", "");
    if (!accessToken.startsWith("x-access-")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ title: "Unauthorized" }] }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("x-rate-limit-limit", "900");
    res.setHeader("x-rate-limit-remaining", "899");
    res.setHeader("x-rate-limit-reset", String(Math.ceil(Date.now() / 1000) + 60));

    if (url.pathname === "/2/users/me") {
      res.end(JSON.stringify({ data: xUser() }));
      return;
    }
    if (url.pathname === "/2/users/9001/tweets") {
      const calls = (contentCalls.get(accessToken) ?? 0) + 1;
      contentCalls.set(accessToken, calls);
      if (accessToken === "x-access-rate" && calls === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ errors: [{ title: "Rate limit exceeded" }] }));
        return;
      }
      const second = url.searchParams.get("pagination_token") === "x-page-2";
      res.end(
        JSON.stringify({
          data: [
            {
              id: second ? "x-post-2" : "x-post-1",
              author_id: "9001",
              text: second ? "x page two" : "x page one",
              created_at: second ? "2030-02-02T00:00:00.000Z" : "2030-02-01T00:00:00.000Z",
              conversation_id: second ? "x-post-2" : "x-post-1",
              public_metrics: { like_count: 1, reply_count: 0, repost_count: 0, quote_count: 0 },
            },
          ],
          includes: { users: [xUser()] },
          meta: second ? { result_count: 1 } : { result_count: 1, next_token: "x-page-2" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ errors: [{ title: "not found" }] }));
  });
  return {
    tokenLog,
    refreshCalls,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("X fixture server did not bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createMetaFixtureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.setHeader("content-type", "application/json");
    if (!url.searchParams.get("access_token")?.startsWith("meta-access")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { type: "OAuthException", code: 190 } }));
      return;
    }
    if (url.pathname === "/v26.0/page-1") {
      res.end(JSON.stringify({ id: "page-1", name: "Fixture Page", username: "fixture_page", followers_count: 14, fan_count: 12 }));
      return;
    }
    if (url.pathname === "/v26.0/page-1/posts") {
      res.end(JSON.stringify({ data: [{ id: "fb-post-1", message: "facebook worker post", created_time: "2030-03-01T00:00:00+0000" }] }));
      return;
    }
    if (url.pathname === "/v26.0/ig-1") {
      res.end(JSON.stringify({ id: "ig-1", username: "fixture_ig", name: "Fixture IG", followers_count: 22, follows_count: 7, media_count: 4, account_type: "BUSINESS" }));
      return;
    }
    if (url.pathname === "/v26.0/ig-1/media") {
      res.end(JSON.stringify({ data: [{ id: "ig-media-1", caption: "instagram worker media", media_type: "IMAGE", timestamp: "2030-03-02T00:00:00+0000", like_count: 9, comments_count: 2 }] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return {
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Meta fixture server did not bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createInstagramLoginWorkerFixtureServer() {
  const requests = { instagram: [], facebookTrap: [] };
  const instagramServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.instagram.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.setHeader("content-type", "application/json");
    if (url.searchParams.get("access_token") !== "ig-direct-worker-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { type: "OAuthException", code: 190 } }));
      return;
    }
    if (url.pathname === "/v26.0/ig-direct-worker") {
      res.end(JSON.stringify({
        user_id: "ig-direct-worker",
        username: "worker_direct_ig",
        name: "Worker Direct IG",
        followers_count: 33,
        follows_count: 4,
        media_count: 2,
        account_type: "BUSINESS",
      }));
      return;
    }
    if (url.pathname === "/v26.0/ig-direct-worker/media") {
      const second = url.searchParams.get("after") === "direct-worker-page-2";
      res.end(JSON.stringify({
        data: [{
          id: second ? "ig-direct-worker-media-2" : "ig-direct-worker-media-1",
          caption: "direct instagram worker media",
          media_type: "IMAGE",
          timestamp: second ? "2030-04-02T00:00:00+0000" : "2030-04-01T00:00:00+0000",
        }],
        paging: second ? undefined : { cursors: { after: "direct-worker-page-2" } },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const facebookTrap = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.facebookTrap.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "facebook graph trap" } }));
  });
  return {
    requests,
    async start() {
      await Promise.all([instagramServer, facebookTrap].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
      const addressFor = (server) => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Instagram Login fixture server did not bind");
        return `http://127.0.0.1:${address.port}`;
      };
      return {
        instagramGraphBaseUrl: addressFor(instagramServer),
        facebookTrapBaseUrl: addressFor(facebookTrap),
      };
    },
    async stop() {
      instagramServer.closeIdleConnections?.();
      instagramServer.closeAllConnections?.();
      facebookTrap.closeIdleConnections?.();
      facebookTrap.closeAllConnections?.();
      await Promise.all([instagramServer, facebookTrap].map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

function createLinkedInWorkerFixtureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, url: req.url, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.setHeader("content-type", "application/json");

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer li-access-")) {
      res.writeHead(401);
      res.end(JSON.stringify({ status: 401, message: "Unauthorized token" }));
      return;
    }

    if (url.pathname === "/v2/userinfo") {
      res.end(
        JSON.stringify({
          sub: "li-worker-member-1",
          name: "LinkedIn Worker Member",
          email: "worker-member@example.com",
        }),
      );
      return;
    }

    if (url.pathname === "/rest/organizations/12345") {
      res.end(
        JSON.stringify({
          id: 12345,
          localizedName: "Acme Corp Worker",
          vanityName: "acme-corp-worker",
          primaryOrganizationType: "COMPANY",
        }),
      );
      return;
    }

    if (url.pathname === "/rest/posts") {
      const start = Number(url.searchParams.get("start") ?? "0");
      if (start === 0) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:share:10001",
                commentary: "First LinkedIn test post",
                createdAt: Date.parse("2026-03-01T10:00:00.000Z"),
                lifecycleState: "PUBLISHED",
                visibility: "PUBLIC",
              },
            ],
            paging: {
              start: 0,
              count: 1,
              total: 2,
            },
          }),
        );
        return;
      }
      if (start === 1) {
        res.end(
          JSON.stringify({
            elements: [
              {
                id: "urn:li:share:10002",
                commentary: "Second LinkedIn test post",
                createdAt: Date.parse("2026-03-02T10:00:00.000Z"),
                lifecycleState: "PUBLISHED",
                visibility: "PUBLIC",
              },
            ],
            paging: {
              start: 1,
              count: 1,
              total: 2,
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ elements: [], paging: { start: 2, count: 1, total: 2 } }));
      return;
    }

    if (url.pathname.includes("/socialActions/") && url.pathname.endsWith("/comments")) {
      res.end(
        JSON.stringify({
          elements: [
            {
              id: "comment-li-001",
              actor: "urn:li:person:commenter-1",
              message: { text: "Great post!" },
              created: { time: Date.parse("2026-03-01T11:00:00.000Z") },
            },
          ],
          paging: {
            start: 0,
            count: 1,
            total: 1,
          },
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/rest/networkSizes/")) {
      res.end(JSON.stringify({ firstDegreeSize: 450 }));
      return;
    }

    if (url.pathname === "/rest/organizationalEntityFollowerStatistics") {
      res.end(
        JSON.stringify({
          elements: [{ followerCountsByIndustry: [] }],
        }),
      );
      return;
    }

    if (url.pathname === "/rest/organizationalEntityShareStatistics") {
      res.end(
        JSON.stringify({
          elements: [{ shareCounts: 12 }],
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/rest/eventSubscriptions/") && req.method === "DELETE") {
      res.end(JSON.stringify({ deleted: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: `Not found: ${url.pathname}` }));
  });

  return {
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("LinkedIn fixture server did not bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function xUser() {
  return {
    id: "9001",
    username: "xlr_x_fixture",
    name: "XLR X Fixture",
    public_metrics: { followers_count: 10, following_count: 5, post_count: 2 },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function createConnection(token, fixtureBaseUrl) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [`${token}-${randomUUID()}@example.test`, token],
  );
  const platform = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ('reference-http', 'Reference HTTP', true) ON CONFLICT (slug) DO UPDATE SET enabled = true RETURNING id",
  );
  const scope = await database.ensurePersonalScope(user.rows[0].id);
  const connectionId = randomUUID();
  const credentials = { accessToken: token, metadata: { fixtureBaseUrl } };
  const encrypted = shared.encryptSecret(
    JSON.stringify(credentials),
    undefined,
    shared.socialCredentialAssociatedData({
      connectionId,
      scopeId: scope.scopeId,
      platformSlug: "reference-http",
    }),
  );
  await pool.query(
    `
      INSERT INTO social_connections (
        id, scope_id, platform_id, status, credentials_encrypted,
        verified_external_id, verified_handle
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $6)
    `,
    [connectionId, scope.scopeId, platform.rows[0].id, encrypted, `profile-${token}`, token],
  );
  return { userId: user.rows[0].id, platformId: platform.rows[0].id, scope, connectionId };
}

async function createXConnection(name, refreshToken) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [`${name}-${randomUUID()}@example.test`, name],
  );
  const platform = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ('x', 'X', true) ON CONFLICT (slug) DO UPDATE SET enabled = true RETURNING id",
  );
  const existingProviderConfig = await pool.query(
    "SELECT id FROM provider_app_configurations WHERE platform_id = $1 AND environment = 'test' LIMIT 1",
    [platform.rows[0].id],
  );
  const providerConfigId = existingProviderConfig.rows[0]?.id ?? randomUUID();
  const encryptedClientSecret = shared.encryptSecret(
    "x-client-secret-fixture",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId,
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
      VALUES ($1, $2, 'test', 'x-client-fixture', $3,
        'https://app.example.test/platforms/x/oauth/callback', true, '{}'::jsonb)
      ON CONFLICT (platform_id, environment) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_encrypted = provider_app_configurations.client_secret_encrypted,
        redirect_uri = EXCLUDED.redirect_uri,
        enabled = true
    `,
    [providerConfigId, platform.rows[0].id, encryptedClientSecret],
  );
  const scope = await database.ensurePersonalScope(user.rows[0].id);
  const connectionId = randomUUID();
  const credentials = {
    accessToken: "x-expired",
    refreshToken,
    expiresAt: "2000-01-01T00:00:00.000Z",
    scopes: ["tweet.read", "users.read", "offline.access"],
    metadata: { providerUserId: "9001" },
  };
  const encrypted = shared.encryptSecret(
    JSON.stringify(credentials),
    undefined,
    shared.socialCredentialAssociatedData({
      connectionId,
      scopeId: scope.scopeId,
      platformSlug: "x",
    }),
  );
  await pool.query(
    `
      INSERT INTO social_connections (
        id, scope_id, platform_id, status, credentials_encrypted,
        verified_external_id, verified_handle
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, '9001', 'xlr_x_fixture')
    `,
    [connectionId, scope.scopeId, platform.rows[0].id, encrypted],
  );
  return { userId: user.rows[0].id, platformId: platform.rows[0].id, scope, connectionId };
}

async function createMetaConnection(slug, assetId, options = {}) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [`${slug}-${randomUUID()}@example.test`, slug],
  );
  const platform = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ($1, $2, true) ON CONFLICT (slug) DO UPDATE SET enabled = true RETURNING id",
    [slug, slug === "facebook" ? "Facebook" : "Instagram"],
  );
  const scope = await database.ensurePersonalScope(user.rows[0].id);
  const connectionId = randomUUID();
  const scopes =
    slug === "facebook"
      ? ["pages_show_list", "pages_read_engagement", "pages_read_user_content", "read_insights"]
      : options.authMode === "INSTAGRAM_LOGIN"
        ? ["instagram_business_basic", "instagram_business_manage_comments"]
        : ["pages_show_list", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments"];
  const credentials = {
    accessToken: options.accessToken ?? "meta-access-worker",
    scopes,
    metadata: {
      assetId,
      appSecret: "meta-app-secret",
      ...(options.authMode ? { authMode: options.authMode } : {}),
    },
  };
  const encrypted = shared.encryptSecret(
    JSON.stringify(credentials),
    undefined,
    shared.socialCredentialAssociatedData({
      connectionId,
      scopeId: scope.scopeId,
      platformSlug: slug,
    }),
  );
  await pool.query(
    `
      INSERT INTO social_connections (
        id, scope_id, platform_id, status, credentials_encrypted,
        verified_external_id, verified_handle, provider_metadata
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $6, $7::jsonb)
    `,
    [
      connectionId,
      scope.scopeId,
      platform.rows[0].id,
      encrypted,
      assetId,
      assetId,
      JSON.stringify({ providerAssetId: assetId, assetType: slug === "facebook" ? "FACEBOOK_PAGE" : "INSTAGRAM_PROFESSIONAL_ACCOUNT" }),
    ],
  );
  return { userId: user.rows[0].id, platformId: platform.rows[0].id, scope, connectionId };
}

async function createMetaProviderConfig(platformId, slug = "facebook", metadata = {}) {
  const providerConfigId = randomUUID();
  const encrypted = shared.encryptSecret(
    "meta-app-secret",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId,
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
      ON CONFLICT (platform_id, environment) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
        enabled = true
    `,
    [providerConfigId, platformId, encrypted, JSON.stringify({ webhookVerifyToken: "verify-token", ...metadata })],
  );
}

async function createLinkedInConnection(assetId = "12345", options = {}) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [`linkedin-${randomUUID()}@example.test`, "LinkedIn User"],
  );
  const platform = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ('linkedin', 'LinkedIn', true) ON CONFLICT (slug) DO UPDATE SET enabled = true RETURNING id",
  );
  const scope = await database.ensurePersonalScope(user.rows[0].id);
  const connectionId = randomUUID();
  const credentials = {
    accessToken: options.accessToken ?? "li-access-worker",
    scopes: [
      "openid",
      "profile",
      "email",
      "r_organization_social",
      "rw_organization_admin",
      "r_organization_admin",
      "r_organization_social_feed",
    ],
    metadata: {
      assetId,
      providerAssetId: assetId,
      ...(options.metadata ?? {}),
    },
  };
  const encrypted = shared.encryptSecret(
    JSON.stringify(credentials),
    undefined,
    shared.socialCredentialAssociatedData({
      connectionId,
      scopeId: scope.scopeId,
      platformSlug: "linkedin",
    }),
  );
  await pool.query(
    `
      INSERT INTO social_connections (
        id, scope_id, platform_id, status, credentials_encrypted,
        verified_external_id, verified_handle, provider_metadata
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $6, $7::jsonb)
    `,
    [
      connectionId,
      scope.scopeId,
      platform.rows[0].id,
      encrypted,
      assetId,
      `org-${assetId}`,
      JSON.stringify({
        providerAssetId: assetId,
        assetType: "LINKEDIN_ORGANIZATION",
        grantedScopes: credentials.scopes,
      }),
    ],
  );
  return { userId: user.rows[0].id, platformId: platform.rows[0].id, scope, connectionId };
}

async function createLinkedInProviderConfig(platformId, metadata = {}) {
  const providerConfigId = randomUUID();
  const encrypted = shared.encryptSecret(
    "synthetic-linkedin-client-secret",
    undefined,
    shared.providerAppSecretAssociatedData({
      providerConfigId,
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
        $4::jsonb)
      ON CONFLICT (platform_id, environment) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
        enabled = true
    `,
    [providerConfigId, platformId, encrypted, JSON.stringify({ ...metadata })],
  );
}

function workerEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL,
    REDIS_URL,
    QUEUE_URL: REDIS_URL,
    QUEUE_PREFIX: process.env.QUEUE_PREFIX,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    SESSION_SIGNING_SECRET: "worker-e2e-session-signing-secret-value",
    ENABLE_REFERENCE_CONNECTOR: "true",
    INGESTION_WORKER_CONCURRENCY: "2",
    SOCIAL_SYNC_MAX_ATTEMPTS: "3",
    SOCIAL_SYNC_BACKOFF_BASE_MS: "300",
    SOCIAL_SYNC_BACKOFF_MAX_MS: "1000",
    SOCIAL_SYNC_BACKOFF_JITTER: "0",
    SOCIAL_SYNC_RATE_LIMIT_MIN_DELAY_MS: "900",
    SOCIAL_SYNC_RATE_LIMIT_MAX_DELAY_MS: "1200",
    SOCIAL_SYNC_DISPATCH_INTERVAL_MS: "100",
    SOCIAL_SYNC_SCHEDULER_INTERVAL_MS: "100",
    SOCIAL_SYNC_LEASE_MS: "900",
    SOCIAL_SYNC_LEASE_HEARTBEAT_MS: "200",
    SOCIAL_SYNC_PROVIDER_TIMEOUT_MS: "2000",
    SOCIAL_SYNC_BULLMQ_LOCK_MS: "900",
    SOCIAL_SYNC_BULLMQ_STALLED_INTERVAL_MS: "900",
    LOG_LEVEL: "fatal",
    ...extra,
  };
}

async function startWorker(extra = {}) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ["apps/worker/dist/main.js"], {
    cwd: process.cwd(),
    env: workerEnv(extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  activeWorkers.add(child);
  child.once("exit", () => activeWorkers.delete(child));
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`Worker exited before readiness with code ${child.exitCode}`);
      }
      const result = await pool.query(
        "SELECT count(*) FROM worker_heartbeats WHERE status = 'READY'",
      );
      return Number(result.rows[0].count) > 0;
    }, 10_000);
  } catch (err) {
    const detail = [...stdout, ...stderr].join("").slice(-4000);
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${detail}`);
  }
  child.__stdout = stdout;
  child.__stderr = stderr;
  return child;
}

async function stopWorker(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    delay(5_000).then(() => {
      child.kill("SIGKILL");
      return -1;
    }),
  ]);
  return result;
}

async function waitWorkerExit(child, expectedCode, timeout = 10_000) {
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    delay(timeout).then(() => {
      child.kill("SIGKILL");
      return "timeout";
    }),
  ]);
  const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
  assert.ok(
    expectedCodes.includes(result),
    `expected worker exit code ${expectedCodes.join(" or ")}, got ${result}`,
  );
  return result;
}

async function waitFor(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for condition");
}

async function jobDiagnostics(jobId) {
  const [jobs, outbox, runs, deadLetters, connections, heartbeats] = await Promise.all([
    pool.query(
      `SELECT id, status, attempt_count, max_attempts, retry_classification,
              next_retry_at, bullmq_job_id, ingestion_run_id, safe_error
       FROM jobs WHERE id = $1`,
      [jobId],
    ),
    pool.query(
      `SELECT status, attempt_count, bullmq_job_id, locked_by, locked_until, last_error
       FROM job_outbox WHERE job_id = $1`,
      [jobId],
    ),
    pool.query(
      `SELECT id, status, cursor_before, cursor_after, errors, retry_classification
       FROM social_ingestion_runs
       WHERE id = (SELECT ingestion_run_id FROM jobs WHERE id = $1)`,
      [jobId],
    ),
    pool.query(
      `SELECT queue_name, job_type, attempt_count, retry_classification, safe_error
       FROM job_dead_letters WHERE job_id = $1`,
      [jobId],
    ),
    pool.query(
      `SELECT id, status, sync_cursor, sync_error, retry_after_seconds, rate_limit_reset_at
       FROM social_connections
       WHERE id = (SELECT connection_id FROM jobs WHERE id = $1)`,
      [jobId],
    ),
    pool.query(
      `SELECT worker_id, kind, status, metadata, last_seen_at
       FROM worker_heartbeats
       ORDER BY last_seen_at DESC
       LIMIT 5`,
    ),
  ]);
  const workerOutput = [...activeWorkers]
    .flatMap((worker) => [...(worker.__stdout ?? []), ...(worker.__stderr ?? [])])
    .join("")
    .slice(-8000);
  return JSON.stringify(
    {
      jobs: jobs.rows,
      outbox: outbox.rows,
      runs: runs.rows,
      deadLetters: deadLetters.rows,
      connections: connections.rows,
      heartbeats: heartbeats.rows,
      workerOutput,
    },
    null,
    2,
  );
}

async function waitForJob(jobId, statuses, timeout = 20_000) {
  try {
    return await waitFor(async () => {
      const result = await pool.query(
        "SELECT status, attempt_count, ingestion_run_id FROM jobs WHERE id = $1",
        [jobId],
      );
      const row = result.rows[0];
      return row && statuses.includes(row.status) ? row : false;
    }, timeout);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${await jobDiagnostics(jobId)}`,
    );
  }
}

async function contentCount(token) {
  const result = await pool.query(
    "SELECT count(*) FROM social_content_items WHERE external_id LIKE $1",
    [`post-${token}-%`],
  );
  return Number(result.rows[0].count);
}

test.afterEach(async () => {
  await queue?.closeConnections?.();
});

test.after(async () => {
  await queue?.closeConnections?.();
  await pool?.end?.();
  await database?.closeDatabase?.();
});

test(
  "worker ingestion e2e: outbox to BullMQ to real worker persists two pages",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const { connectionId } = await createConnection("happy", baseUrl);
      const first = await database.createSocialConnectionSyncRequest({
        connectionId,
        reason: "MANUAL",
      });
      const duplicate = await database.createSocialConnectionSyncRequest({
        connectionId,
        reason: "MANUAL",
      });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.jobId, first.jobId);
      worker = await startWorker();
      const job = await waitForJob(first.jobId, ["COMPLETED"]);
      assert.equal(job.attempt_count, 1);
      assert.equal(await contentCount("happy"), 2);
      assert.equal(
        (
          await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [
            connectionId,
          ])
        ).rows[0].sync_cursor,
        "done",
      );
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: redis outage leaves durable outbox pending until transport recovers",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const { connectionId } = await createConnection("redis-outage", baseUrl);

      const request = await database.createSocialConnectionSyncRequest({
        connectionId,
        reason: "MANUAL",
        idempotencyKey: "redis-outage-request",
      });

      assert.equal(request.duplicate, false);
      assert.equal(
        (await pool.query("SELECT status FROM jobs WHERE id = $1", [request.jobId])).rows[0].status,
        "PENDING_DISPATCH",
      );
      assert.equal(
        (await pool.query("SELECT status FROM job_outbox WHERE job_id = $1", [request.jobId]))
          .rows[0].status,
        "PENDING",
      );
      assert.equal(await contentCount("redis-outage"), 0);

      worker = await startWorker();
      await waitForJob(request.jobId, ["COMPLETED"], 25_000);
      assert.equal(
        (await pool.query("SELECT status FROM job_outbox WHERE job_id = $1", [request.jobId]))
          .rows[0].status,
        "DISPATCHED",
      );
      assert.equal(await contentCount("redis-outage"), 2);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: retry, rate-limit, reauth, malformed and DLQ behavior",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const temporary = await createConnection("temporary", baseUrl);
      const rateLimit = await createConnection("rate-limit", baseUrl);
      const reauth = await createConnection("reauth", baseUrl);
      const malformed = await createConnection("malformed", baseUrl);
      const permanent = await createConnection("permanent", baseUrl);
      const requests = await Promise.all(
        [temporary, rateLimit, reauth, malformed, permanent].map((item) =>
          database.createSocialConnectionSyncRequest({
            connectionId: item.connectionId,
            reason: "MANUAL",
          }),
        ),
      );
      worker = await startWorker();
      const tempJob = await waitForJob(requests[0].jobId, ["COMPLETED"], 25_000);
      const rateJob = await waitForJob(requests[1].jobId, ["COMPLETED"], 25_000);
      const reauthJob = await waitForJob(requests[2].jobId, ["FAILED"], 25_000);
      const malformedJob = await waitForJob(requests[3].jobId, ["DEAD_LETTERED"], 25_000);
      const permanentJob = await waitForJob(requests[4].jobId, ["DEAD_LETTERED"], 25_000);
      assert.equal(tempJob.attempt_count, 2);
      assert.equal(rateJob.attempt_count, 2);
      assert.equal(reauthJob.attempt_count, 1);
      assert.equal(malformedJob.attempt_count, 1);
      assert.equal(permanentJob.attempt_count, 1);
      assert.equal(await contentCount("temporary"), 2);
      assert.equal(await contentCount("rate-limit"), 2);
      assert.equal(
        (
          await pool.query("SELECT status FROM social_connections WHERE id = $1", [
            reauth.connectionId,
          ])
        ).rows[0].status,
        "REAUTH_REQUIRED",
      );
      assert.equal(
        Number((await pool.query("SELECT count(*) FROM job_dead_letters")).rows[0].count),
        2,
      );
      const deadLetter = JSON.stringify(
        (await pool.query("SELECT safe_error FROM job_dead_letters LIMIT 1")).rows[0].safe_error,
      );
      assert.equal(deadLetter.includes("accessToken"), false);
      assert.equal(deadLetter.includes("refreshToken"), false);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: crash after page commit resumes without duplicates",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let crashingWorker;
    let worker;
    try {
      const { connectionId } = await createConnection("crash", baseUrl);
      const request = await database.createSocialConnectionSyncRequest({
        connectionId,
        reason: "MANUAL",
      });
      crashingWorker = await startWorker({ WORKER_TEST_CRASH_AFTER_CURSOR: "page-1" });
      await waitWorkerExit(crashingWorker, process.platform === "win32" ? [76, 3221226505] : 76);
      await delay(1_500);
      worker = await startWorker();
      await waitForJob(request.jobId, ["COMPLETED"], 30_000);
      assert.equal(await contentCount("crash"), 2);
      assert.equal(
        (
          await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [
            connectionId,
          ])
        ).rows[0].sync_cursor,
        "done",
      );
    } finally {
      if (crashingWorker) await stopWorker(crashingWorker);
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: crash before page commit leaves cursor unchanged",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let crashingWorker;
    let worker;
    try {
      const { connectionId } = await createConnection("before-commit", baseUrl);
      const request = await database.createSocialConnectionSyncRequest({
        connectionId,
        reason: "MANUAL",
      });
      crashingWorker = await startWorker({ WORKER_TEST_CRASH_BEFORE_PERSIST_CURSOR: "START" });
      await waitWorkerExit(crashingWorker, process.platform === "win32" ? [75, 3221226505] : 75);
      assert.equal(await contentCount("before-commit"), 0);
      assert.equal(
        (
          await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [
            connectionId,
          ])
        ).rows[0].sync_cursor,
        null,
      );
      await delay(1_500);
      worker = await startWorker();
      await waitForJob(request.jobId, ["COMPLETED"], 30_000);
      assert.equal(await contentCount("before-commit"), 2);
    } finally {
      if (crashingWorker) await stopWorker(crashingWorker);
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: scheduled sync is multi-scheduler safe and connections run concurrently",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let workerA;
    let workerB;
    try {
      const a = await createConnection("concurrent-a", baseUrl);
      const b = await createConnection("concurrent-b", baseUrl);
      await database.enableSocialSyncSchedule({
        connectionId: a.connectionId,
        cadenceSeconds: 60,
        nextSyncAt: new Date(Date.now() - 1_000),
      });
      const requestB = await database.createSocialConnectionSyncRequest({
        connectionId: b.connectionId,
        reason: "MANUAL",
      });
      workerA = await startWorker();
      workerB = await startWorker();
      await waitFor(async () => {
        const result = await pool.query("SELECT count(*) FROM jobs WHERE connection_id = $1", [
          a.connectionId,
        ]);
        return Number(result.rows[0].count) === 1;
      }, 15_000);
      const scheduleJob = (
        await pool.query("SELECT id FROM jobs WHERE connection_id = $1", [a.connectionId])
      ).rows[0].id;
      await waitForJob(scheduleJob, ["COMPLETED"], 25_000);
      await waitForJob(requestB.jobId, ["COMPLETED"], 25_000);
      assert.equal(await contentCount("concurrent-a"), 2);
      assert.equal(await contentCount("concurrent-b"), 2);
      assert.ok(fixture.tokenLog.some((entry) => entry.token === "concurrent-a"));
      assert.ok(fixture.tokenLog.some((entry) => entry.token === "concurrent-b"));
    } finally {
      if (workerA) await stopWorker(workerA);
      if (workerB) await stopWorker(workerB);
      await fixture.stop();
    }
  },
);

test(
  "worker ingestion e2e: queued and mid-sync disconnects prevent unauthorized continuation",
  { skip },
  async () => {
    await reset();
    const fixture = createFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const queued = await createConnection("queued-disconnect", baseUrl);
      const queuedRequest = await database.createSocialConnectionSyncRequest({
        connectionId: queued.connectionId,
        reason: "MANUAL",
      });
      await pool.query(
        "UPDATE social_connections SET status = 'DISCONNECTED', credentials_encrypted = NULL WHERE id = $1",
        [queued.connectionId],
      );
      worker = await startWorker();
      await waitForJob(queuedRequest.jobId, ["CANCELLED"], 20_000);
      assert.equal(
        fixture.tokenLog.some((entry) => entry.token === "queued-disconnect"),
        false,
      );
      await stopWorker(worker);

      const running = await createConnection("running-disconnect", baseUrl);
      const runningRequest = await database.createSocialConnectionSyncRequest({
        connectionId: running.connectionId,
        reason: "MANUAL",
      });
      worker = await startWorker({
        WORKER_TEST_PAUSE_AFTER_CURSOR: "page-1",
        WORKER_TEST_PAUSE_MS: "2000",
      });
      await waitFor(async () => {
        const cursor = (
          await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [
            running.connectionId,
          ])
        ).rows[0].sync_cursor;
        return cursor === "page-1";
      }, 15_000);
      await pool.query(
        "UPDATE social_connections SET status = 'DISCONNECTED', credentials_encrypted = NULL WHERE id = $1",
        [running.connectionId],
      );
      await waitForJob(runningRequest.jobId, ["CANCELLED"], 25_000);
      assert.equal(await contentCount("running-disconnect"), 1);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "X worker ingestion e2e: OAuth refresh, BullMQ worker, pagination, 429 retry, reauth, and tenant isolation",
  { skip },
  async () => {
    await reset();
    const fixture = createXFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const ok = await createXConnection("x-ok", "x-refresh-ok");
      const rate = await createXConnection("x-rate", "x-refresh-rate");
      const reauth = await createXConnection("x-reauth", "x-refresh-reauth");
      const requests = await Promise.all(
        [ok, rate, reauth].map((item) =>
          database.createSocialConnectionSyncRequest({
            connectionId: item.connectionId,
            reason: "MANUAL",
          }),
        ),
      );
      worker = await startWorker({ X_API_BASE_URL: baseUrl });
      const okJob = await waitForJob(requests[0].jobId, ["COMPLETED"], 30_000);
      const rateJob = await waitForJob(requests[1].jobId, ["COMPLETED"], 30_000);
      const reauthJob = await waitForJob(requests[2].jobId, ["FAILED"], 30_000);
      assert.equal(okJob.attempt_count, 1);
      assert.equal(rateJob.attempt_count, 2);
      assert.equal(reauthJob.attempt_count, 1);
      assert.equal(
        Number((await pool.query("SELECT count(*) FROM social_content_items")).rows[0].count),
        2,
      );
      assert.ok(
        fixture.tokenLog.some(
          (entry) =>
            entry.url.includes("/2/users/9001/tweets?") &&
            entry.url.includes("pagination_token=x-page-2"),
        ),
      );
      const refreshed = (
        await pool.query(
          "SELECT credentials_encrypted, status FROM social_connections WHERE id = $1",
          [ok.connectionId],
        )
      ).rows[0];
      assert.equal(refreshed.status, "CONNECTED");
      assert.equal(refreshed.credentials_encrypted.includes("x-access-ok"), false);
      const plaintext = shared.decryptSecret(
        refreshed.credentials_encrypted,
        undefined,
        shared.socialCredentialAssociatedData({
          connectionId: ok.connectionId,
          scopeId: ok.scope.scopeId,
          platformSlug: "x",
        }),
      );
      assert.equal(JSON.parse(plaintext).refreshToken, "x-refresh-ok-rotated");
      assert.equal(
        (
          await pool.query("SELECT status FROM social_connections WHERE id = $1", [
            reauth.connectionId,
          ])
        ).rows[0].status,
        "REAUTH_REQUIRED",
      );
      const scopedRows = await pool.query(
        "SELECT scope_id, count(*) FROM social_content_items GROUP BY scope_id ORDER BY scope_id NULLS LAST",
      );
      assert.ok(scopedRows.rows.every((row) => row.scope_id === null || Number(row.count) <= 2));
      assert.ok(fixture.tokenLog.some((entry) => entry.url.startsWith("/2/oauth2/token")));
      assert.ok(fixture.tokenLog.some((entry) => entry.url.startsWith("/2/users/9001/tweets")));
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "Meta worker ingestion e2e: Facebook Page and Instagram Professional connectors persist content",
  { skip },
  async () => {
    await reset();
    const fixture = createMetaFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const facebook = await createMetaConnection("facebook", "page-1");
      const instagram = await createMetaConnection("instagram", "ig-1");
      const requests = await Promise.all(
        [facebook, instagram].map((item) =>
          database.createSocialConnectionSyncRequest({
            connectionId: item.connectionId,
            reason: "MANUAL",
          }),
        ),
      );
      worker = await startWorker({ META_GRAPH_BASE_URL: baseUrl });
      await waitForJob(requests[0].jobId, ["COMPLETED"], 30_000);
      await waitForJob(requests[1].jobId, ["COMPLETED"], 30_000);
      const rows = await pool.query(
        `
          SELECT p.slug, sci.external_id
          FROM social_content_items sci
          JOIN platforms p ON p.id = sci.platform_id
          WHERE p.slug IN ('facebook', 'instagram')
          ORDER BY p.slug, sci.external_id
        `,
      );
      assert.deepEqual(rows.rows, [
        { slug: "facebook", external_id: "fb-post-1" },
        { slug: "instagram", external_id: "ig-media-1" },
      ]);
      assert.ok(fixture.requests.some((request) => request.path === "/v26.0/page-1/posts"));
      assert.ok(fixture.requests.some((request) => request.path === "/v26.0/ig-1/media"));
      assert.ok(fixture.requests.every((request) => request.params.appsecret_proof));
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "Instagram Login worker e2e: direct Graph fixture persists professional media",
  { skip },
  async () => {
    await reset();
    const fixture = createInstagramLoginWorkerFixtureServer();
    const endpoints = await fixture.start();
    let worker;
    try {
      const instagram = await createMetaConnection("instagram", "ig-direct-worker", {
        authMode: "INSTAGRAM_LOGIN",
        accessToken: "ig-direct-worker-token",
      });
      await createMetaProviderConfig(instagram.platformId, "instagram", { authMode: "INSTAGRAM_LOGIN" });
      const request = await database.createSocialConnectionSyncRequest({
        connectionId: instagram.connectionId,
        reason: "MANUAL",
      });
      worker = await startWorker({
        META_GRAPH_BASE_URL: endpoints.facebookTrapBaseUrl,
        INSTAGRAM_GRAPH_BASE_URL: endpoints.instagramGraphBaseUrl,
      });
      await waitForJob(request.jobId, ["COMPLETED"], 30_000);
      const rows = await pool.query(
        `
          SELECT p.slug, sci.external_id
          FROM social_content_items sci
          JOIN platforms p ON p.id = sci.platform_id
          WHERE p.slug = 'instagram'
          ORDER BY sci.external_id
        `,
      );
      assert.deepEqual(rows.rows, [
        { slug: "instagram", external_id: "ig-direct-worker-media-1" },
        { slug: "instagram", external_id: "ig-direct-worker-media-2" },
      ]);
      const observation = (
        await pool.query(
          `
            SELECT sea.external_id, sea.follower_count
            FROM social_account_observations sao
            JOIN social_external_accounts sea ON sea.id = sao.external_account_id
            WHERE sea.external_id = 'ig-direct-worker'
          `,
        )
      ).rows[0];
      assert.equal(observation.external_id, "ig-direct-worker");
      assert.equal(observation.follower_count, 33);
      const connection = (
        await pool.query("SELECT credentials_encrypted FROM social_connections WHERE id = $1", [
          instagram.connectionId,
        ])
      ).rows[0];
      const cursorRun = (
        await pool.query(
          "SELECT cursor_before, cursor_after FROM social_ingestion_runs WHERE connection_id = $1",
          [instagram.connectionId],
        )
      ).rows[0];
      assert.equal(cursorRun.cursor_before, null);
      assert.equal(cursorRun.cursor_after, null);
      assert.ok(fixture.requests.instagram.some((request) => request.params.after === "direct-worker-page-2"));
      assert.equal(connection.credentials_encrypted.includes("ig-direct-worker-token"), false);
      const jobs = await pool.query("SELECT payload::text AS payload FROM jobs");
      assert.equal(jobs.rows.some((row) => row.payload.includes("ig-direct-worker-token")), false);
      assert.equal(fixture.requests.facebookTrap.length, 0);
      assert.ok(fixture.requests.instagram.some((request) => request.path === "/v26.0/ig-direct-worker"));
      assert.ok(fixture.requests.instagram.some((request) => request.path === "/v26.0/ig-direct-worker/media"));
      assert.ok(fixture.requests.instagram.every((request) => request.params.access_token === "ig-direct-worker-token"));
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "Meta webhook worker e2e: receipt outbox resolves connected scopes and triggers sync",
  { skip },
  async () => {
    await reset();
    const fixture = createMetaFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const facebookA = await createMetaConnection("facebook", "page-1");
      const facebookB = await createMetaConnection("facebook", "page-1");
      await createMetaProviderConfig(facebookA.platformId, "facebook");
      const { PlatformsService } = await import("../../api/dist/platforms/platforms.service.js");
      const service = new PlatformsService({ record: async () => undefined });
      const payload = {
        object: "page",
        entry: [{ id: "page-1", time: 1788998400, changes: [{ field: "feed", value: { post_id: "fb-post-1" } }] }],
      };
      const signature = `sha256=${createHmac("sha256", "meta-app-secret")
        .update(JSON.stringify(payload), "utf8")
        .digest("hex")}`;
      const received = await service.receiveMetaWebhook("facebook", signature, payload);
      assert.equal(received.duplicate, false);
      assert.equal(JSON.stringify(received.job).includes("meta-app-secret"), false);
      assert.equal(JSON.stringify(received.job).includes("meta-access"), false);

      worker = await startWorker({ META_GRAPH_BASE_URL: baseUrl });
      await waitFor(async () => {
        const result = await pool.query(
          "SELECT status FROM webhook_receipts WHERE id = $1",
          [received.receiptId],
        );
        return result.rows[0]?.status === "PROCESSED";
      }, 30_000);
      await waitFor(async () => {
        const result = await pool.query(
          `
            SELECT count(*)::int AS count
            FROM social_content_observations sco
            JOIN social_connections sc ON sc.id = sco.connection_id
            WHERE sc.id = ANY($1::uuid[])
          `,
          [[facebookA.connectionId, facebookB.connectionId]],
        );
        return result.rows[0]?.count === 2;
      }, 30_000);
      const receipt = (
        await pool.query("SELECT metadata FROM webhook_receipts WHERE id = $1", [
          received.receiptId,
        ])
      ).rows[0];
      assert.equal(receipt.metadata.resolvedConnectionCount, 2);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "X worker ingestion e2e: concurrent same-connection refresh uses one rotating refresh token",
  { skip },
  async () => {
    await reset();
    const fixture = createXFixtureServer();
    const baseUrl = await fixture.start();
    let workerA;
    let workerB;
    try {
      const connection = await createXConnection("x-race", "x-refresh-race");
      const before = (
        await pool.query("SELECT credential_version FROM social_connections WHERE id = $1", [
          connection.connectionId,
        ])
      ).rows[0].credential_version;
      const requests = await Promise.all([
        database.createSocialConnectionSyncRequest({
          connectionId: connection.connectionId,
          reason: "MANUAL",
        }),
        database.createSocialConnectionSyncRequest({
          connectionId: connection.connectionId,
          reason: "MANUAL",
        }),
      ]);
      const accepted = requests.filter((request) => request.accepted);
      const duplicate = requests.filter((request) => request.duplicate);
      assert.equal(accepted.length, 1);
      assert.equal(duplicate.length, 1);

      workerA = await startWorker({
        X_API_BASE_URL: baseUrl,
        SOCIAL_SYNC_LEASE_MS: "2000",
      });
      workerB = await startWorker({
        X_API_BASE_URL: baseUrl,
        SOCIAL_SYNC_LEASE_MS: "2000",
      });

      const completed = await waitForJob(accepted[0].jobId, ["COMPLETED"], 30_000);
      assert.equal(completed.attempt_count, 1);
      assert.equal(duplicate[0].jobId, accepted[0].jobId);
      assert.equal(fixture.refreshCalls.get("x-refresh-race"), 1);

      const row = (
        await pool.query(
          "SELECT credentials_encrypted, credential_version, status FROM social_connections WHERE id = $1",
          [connection.connectionId],
        )
      ).rows[0];
      assert.equal(row.status, "CONNECTED");
      assert.equal(row.credential_version, before + 1);
      const credentials = JSON.parse(
        shared.decryptSecret(
          row.credentials_encrypted,
          undefined,
          shared.socialCredentialAssociatedData({
            connectionId: connection.connectionId,
            scopeId: connection.scope.scopeId,
            platformSlug: "x",
          }),
        ),
      );
      assert.equal(credentials.accessToken, "x-access-race-2");
      assert.equal(credentials.refreshToken, "x-refresh-race-2");
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM social_content_items WHERE external_id LIKE 'x-post-%'",
            )
          ).rows[0].count,
        ),
        2,
      );
    } finally {
      if (workerA) await stopWorker(workerA);
      if (workerB) await stopWorker(workerB);
      await fixture.stop();
    }
  },
);

test(
  "X worker ingestion e2e: stale credential-version CAS cannot overwrite rotated credentials",
  { skip },
  async () => {
    await reset();
    const connection = await createXConnection("x-cas", "x-refresh-cas-1");
    const current = (
      await pool.query(
        "SELECT credentials_encrypted, credential_version FROM social_connections WHERE id = $1",
        [connection.connectionId],
      )
    ).rows[0];
    const encrypt = (accessToken, refreshToken) =>
      shared.encryptSecret(
        JSON.stringify({
          accessToken,
          refreshToken,
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: ["tweet.read", "users.read", "offline.access"],
          metadata: { providerUserId: "9001" },
        }),
        undefined,
        shared.socialCredentialAssociatedData({
          connectionId: connection.connectionId,
          scopeId: connection.scope.scopeId,
          platformSlug: "x",
        }),
      );
    const newer = encrypt("x-access-newer", "x-refresh-newer");
    await pool.query(
      "UPDATE social_connections SET credentials_encrypted = $2, credential_version = credential_version + 1 WHERE id = $1",
      [connection.connectionId, newer],
    );
    const stale = await pool.query(
      `
        UPDATE social_connections
        SET credentials_encrypted = $2, credential_version = credential_version + 1
        WHERE id = $1 AND credential_version = $3
      `,
      [
        connection.connectionId,
        encrypt("x-access-stale", "x-refresh-stale"),
        current.credential_version,
      ],
    );
    assert.equal(stale.rowCount, 0);
    const final = (
      await pool.query(
        "SELECT credentials_encrypted, credential_version FROM social_connections WHERE id = $1",
        [connection.connectionId],
      )
    ).rows[0];
    assert.equal(final.credential_version, current.credential_version + 1);
    const credentials = JSON.parse(
      shared.decryptSecret(
        final.credentials_encrypted,
        undefined,
        shared.socialCredentialAssociatedData({
          connectionId: connection.connectionId,
          scopeId: connection.scope.scopeId,
          platformSlug: "x",
        }),
      ),
    );
    assert.equal(credentials.accessToken, "x-access-newer");
    assert.equal(credentials.refreshToken, "x-refresh-newer");
  },
);

test(
  "LinkedIn worker ingestion e2e: organization posts, pagination, comments, and follower metrics",
  { skip },
  async () => {
    await reset();
    const fixture = createLinkedInWorkerFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const linkedInConn = await createLinkedInConnection("12345");
      const request = await database.createSocialConnectionSyncRequest({
        connectionId: linkedInConn.connectionId,
        reason: "MANUAL",
      });
      assert.equal(request.accepted, true);

      worker = await startWorker({
        LINKEDIN_REST_BASE_URL: `${baseUrl}/rest`,
      });

      const completed = await waitForJob(request.jobId, ["COMPLETED"], 30_000);
      assert.equal(completed.status, "COMPLETED");

      // Verify posts were ingested across pages (total 2 posts)
      const posts = await pool.query(
        "SELECT external_id, body FROM social_content_items WHERE platform_id = $1 ORDER BY external_id",
        [linkedInConn.platformId],
      );
      assert.equal(posts.rows.length, 2);
      assert.equal(posts.rows[0].external_id, "urn:li:share:10001");
      assert.equal(posts.rows[0].body, "First LinkedIn test post");
      assert.equal(posts.rows[1].external_id, "urn:li:share:10002");
      assert.equal(posts.rows[1].body, "Second LinkedIn test post");

      // Verify observations in scope
      const observations = await pool.query(
        "SELECT count(*)::int AS count FROM social_content_observations WHERE scope_id = $1",
        [linkedInConn.scope.scopeId],
      );
      assert.equal(observations.rows[0].count, 2);

      // Verify connection updated
      const updatedConn = (
        await pool.query(
          "SELECT status, last_sync_at, sync_error FROM social_connections WHERE id = $1",
          [linkedInConn.connectionId],
        )
      ).rows[0];
      assert.equal(updatedConn.status, "CONNECTED");
      assert.ok(updatedConn.last_sync_at);
      assert.equal(updatedConn.sync_error, null);

      // Verify token secrecy
      const jobs = await pool.query("SELECT payload::text AS payload FROM jobs");
      assert.equal(jobs.rows.some((row) => row.payload.includes("li-access-worker")), false);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "LinkedIn webhook worker e2e: receipt outbox resolves connected scopes and triggers sync",
  { skip },
  async () => {
    await reset();
    const fixture = createLinkedInWorkerFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const connA = await createLinkedInConnection("12345");
      const connB = await createLinkedInConnection("12345");
      await createLinkedInProviderConfig(connA.platformId);

      const { PlatformsService } = await import("../../api/dist/platforms/platforms.service.js");
      const service = new PlatformsService({ record: async () => undefined });
      const payload = {
        organization: "urn:li:organization:12345",
        action: "ORGANIZATION_SOCIAL_ACTION",
        notificationId: "notif-worker-test-01",
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac("sha256", "synthetic-linkedin-client-secret")
        .update(`hmacsha256=${rawBody}`, "utf8")
        .digest("hex");

      const received = await service.receiveLinkedInWebhook(
        connA.platformId,
        signature,
        payload,
        rawBody,
      );
      assert.equal(received.duplicate, false);
      assert.ok(received.receiptId);

      worker = await startWorker({ LINKEDIN_REST_BASE_URL: `${baseUrl}/rest` });

      await waitFor(async () => {
        const result = await pool.query(
          "SELECT status FROM webhook_receipts WHERE id = $1",
          [received.receiptId],
        );
        return result.rows[0]?.status === "PROCESSED";
      }, 30_000);

      await waitFor(async () => {
        const result = await pool.query(
          `
            SELECT count(*)::int AS count
            FROM social_content_observations sco
            JOIN social_connections sc ON sc.id = sco.connection_id
            WHERE sc.id = ANY($1::uuid[])
          `,
          [[connA.connectionId, connB.connectionId]],
        );
        return result.rows[0]?.count === 4; // 2 posts * 2 connections
      }, 30_000);

      const receipt = (
        await pool.query("SELECT metadata FROM webhook_receipts WHERE id = $1", [
          received.receiptId,
        ])
      ).rows[0];
      assert.equal(receipt.metadata.resolvedConnectionCount, 2);
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "Data retention: record-level LinkedIn categories purge member comments and preserve lawful org content",
  { skip },
  async () => {
    await reset();
    const policies = await database.loadProviderRetentionPolicies("linkedin");
    assert.ok(policies.length >= 10, "Expected corrected LinkedIn retention policy categories");
    assert.equal(policies.find((p) => p.dataCategory === "authenticated_member_profile").maxRetentionSeconds, null);
    assert.equal(policies.find((p) => p.dataCategory === "other_member_profile").maxRetentionSeconds, 86400);
    assert.equal(policies.find((p) => p.dataCategory === "member_social_activity").maxRetentionSeconds, 172800);
    assert.equal(
      policies.find((p) => p.dataCategory === "organization_social_activity_authenticated_org").maxRetentionSeconds,
      15552000,
    );
    assert.equal(policies.find((p) => p.dataCategory === "organization_admin_reporting").maxRetentionSeconds, 31536000);

    const connA = await createLinkedInConnection("12345");
    const connB = await createLinkedInConnection("12345");

    const extAccountId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, provider_data_category
        )
        VALUES ($1, $2, '12345', 'acme-corp', 'Acme Corp', 'organization_profile')
      `,
      [extAccountId, connA.platformId],
    );
    const memberAccountId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, provider_data_category
        )
        VALUES ($1, $2, 'person-x', 'person-x', NULL, 'other_member_id')
      `,
      [memberAccountId, connA.platformId],
    );

    const contentItemId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_content_items (
          id, scope_id, platform_id, author_external_account_id, external_id, body,
          visibility, provider_created_at, provider_data_category
        )
        VALUES ($1, NULL, $2, $3, 'li-retained-item-1', 'Retained post body',
          'PUBLIC', now() - interval '3 days', 'organization_social_activity_authenticated_org')
      `,
      [contentItemId, connA.platformId, extAccountId],
    );

    const obsAId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_content_observations (
          id, scope_id, connection_id, content_item_id, visibility, observed_at,
          provider_created_at, provider_data_category, normalization_version, adapter_version
        )
        VALUES ($1, $2, $3, $4, 'PUBLIC', now() - interval '7 months',
          now() - interval '7 months', 'organization_social_activity_authenticated_org', '1', '1')
      `,
      [obsAId, connA.scope.scopeId, connA.connectionId, contentItemId],
    );

    const obsBId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_content_observations (
          id, scope_id, connection_id, content_item_id, visibility, observed_at,
          provider_created_at, provider_data_category, normalization_version, adapter_version
        )
        VALUES ($1, $2, $3, $4, 'PUBLIC', now() - interval '1 day',
          now() - interval '1 day', 'organization_social_activity_authenticated_org', '1', '1')
      `,
      [obsBId, connB.scope.scopeId, connB.connectionId, contentItemId],
    );

    const interactionId = randomUUID();
    const interactionObsId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_interactions (
          id, scope_id, platform_id, external_id, from_external_account_id,
          to_content_item_id, type, body, visibility, occurred_at, provider_data_category
        )
        VALUES ($1, NULL, $2, 'urn:li:comment:(activity:org-a,person-x-comment)',
          $3, $4, 'COMMENT', 'Member Person X comment', 'PUBLIC',
          now() - interval '3 days', 'member_social_activity')
      `,
      [interactionId, connA.platformId, memberAccountId, contentItemId],
    );
    await pool.query(
      `
        INSERT INTO social_interaction_observations (
          id, scope_id, connection_id, interaction_id, visibility, observed_at,
          provider_data_category, normalization_version, adapter_version
        )
        VALUES ($1, $2, $3, $4, 'PUBLIC', now() - interval '3 days',
          'member_social_activity', '1', '1')
      `,
      [interactionObsId, connA.scope.scopeId, connA.connectionId, interactionId],
    );

    const receiptId = randomUUID();
    await pool.query(
      `
        INSERT INTO webhook_receipts (
          id, provider_family, platform_id, dedupe_key, signature_valid,
          status, payload, provider_data_category, metadata, received_at
        )
        VALUES ($1, 'linkedin', $2, 'old-hook-dedupe', true,
          'PROCESSED', '{}'::jsonb, 'webhook_operational_receipt', '{}'::jsonb, now() - interval '10 days')
      `,
      [receiptId, connA.platformId],
    );

    const dryRun = await database.purgeExpiredProviderData({ providerFamily: "linkedin", dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.interactionsPurged >= 1);

    const purgeResult = await database.purgeExpiredProviderData({ providerFamily: "linkedin" });
    assert.equal(purgeResult.providerFamily, "linkedin");
    assert.ok(purgeResult.contentObservationsPurged >= 1);
    assert.ok(purgeResult.interactionsPurged >= 1);
    assert.ok(purgeResult.receiptsPurged >= 1);

    const checkObsA = await pool.query("SELECT * FROM social_content_observations WHERE id = $1", [obsAId]);
    assert.equal(checkObsA.rows.length, 0);

    const checkObsB = await pool.query("SELECT * FROM social_content_observations WHERE id = $1", [obsBId]);
    assert.equal(checkObsB.rows.length, 1);

    const checkItem = await pool.query("SELECT * FROM social_content_items WHERE id = $1", [contentItemId]);
    assert.equal(checkItem.rows.length, 1);

    const checkInteractionObs = await pool.query("SELECT * FROM social_interaction_observations WHERE id = $1", [interactionObsId]);
    assert.equal(checkInteractionObs.rows.length, 0);
    const checkInteraction = await pool.query("SELECT * FROM social_interactions WHERE id = $1", [interactionId]);
    assert.equal(checkInteraction.rows.length, 0);

    const checkReceipt = await pool.query("SELECT * FROM webhook_receipts WHERE id = $1", [receiptId]);
    assert.equal(checkReceipt.rows.length, 0);
  },
);

test(
  "Provider subscription cleanup worker e2e: processes pending cleanup job, invokes LinkedIn DELETE, marks PROVIDER_DELETED",
  { skip },
  async () => {
    await reset();
    const fixture = createLinkedInWorkerFixtureServer();
    const baseUrl = await fixture.start();
    let worker;
    try {
      const conn = await createLinkedInConnection("12345");
      const platformId = conn.platformId;
      const authId = randomUUID();
      const credentials = {
        accessToken: "li-access-cleanup-test",
        metadata: {
          fixtureBaseUrl: `${baseUrl}/rest`,
        },
      };
      const credentialsEncrypted = shared.encryptSecret(
        JSON.stringify(credentials),
        undefined,
        shared.providerAuthorizationAssociatedData({
          authorizationId: authId,
          scopeId: conn.scope.scopeId,
          providerFamily: "linkedin",
        }),
      );
      await pool.query(
        `
          INSERT INTO provider_authorizations (
            id, scope_id, provider_family, provider_user_id, status, credentials_encrypted, granted_scopes
          )
          VALUES ($1, $2, 'linkedin', 'urn:li:person:cleanup-member', 'ACTIVE', $3,
            '["openid", "profile", "r_organization_social", "r_organization_admin", "rw_organization_admin"]'::jsonb)
        `,
        [authId, conn.scope.scopeId, credentialsEncrypted],
      );

      const assetId = randomUUID();
      await pool.query(
        `
          INSERT INTO provider_authorization_assets (
            id, provider_authorization_id, platform_id, asset_type, provider_asset_id,
            token_kind, provider_data_category
          )
          VALUES ($1, $2, $3, 'LINKEDIN_ORGANIZATION', '12345', 'USER', 'organization_profile')
        `,
        [assetId, authId, platformId],
      );

      const subscriptionId = randomUUID();
      await pool.query(
        `
          INSERT INTO provider_event_subscriptions (
            id, provider_family, scope_id, platform_id, provider_authorization_id,
            provider_authorization_asset_id, social_connection_id, provider_user_id,
            provider_asset_id, developer_application_urn, member_urn, entity_urn,
            event_type, webhook_url, provider_status
          )
          VALUES ($1, 'linkedin', $2, $3, $4, $5, $6, 'urn:li:person:cleanup-member',
            '12345', 'urn:li:developerApplication:999', 'urn:li:person:cleanup-member',
            'urn:li:organization:12345', 'ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS',
            'https://app.example.test/platforms/linkedin/webhook', 'PENDING_PROVIDER_DELETE')
        `,
        [subscriptionId, conn.scope.scopeId, platformId, authId, assetId, conn.connectionId],
      );

      const cleanupRequest = await database.createProviderSubscriptionCleanupRequest({ subscriptionId });
      assert.ok(cleanupRequest.jobId);

      worker = await startWorker({ LINKEDIN_REST_BASE_URL: `${baseUrl}/rest` });
      await waitForJob(cleanupRequest.jobId, ["COMPLETED"], 30_000);

      const updatedSub = (
        await pool.query(
          "SELECT provider_status, metadata FROM provider_event_subscriptions WHERE id = $1",
          [subscriptionId],
        )
      ).rows[0];
      assert.equal(updatedSub.provider_status, "PROVIDER_DELETED");
      assert.equal(updatedSub.metadata.cleanupRetryCompleted, true);
      assert.ok(fixture.requests.some((r) => r.method === "DELETE" && r.url.includes("/rest/eventSubscriptions/")));
    } finally {
      if (worker) await stopWorker(worker);
      await fixture.stop();
    }
  },
);

test(
  "Data retention: canonical profile retention, redaction, cross-scope preservation, and authorization asset minimization",
  { skip },
  async () => {
    await reset();
    const connA = await createLinkedInConnection("org-a");
    const connB = await createLinkedInConnection("org-b");
    const platformId = connA.platformId;

    // 1. Authenticated member profile: NO_PROVIDER_DURATION_LIMIT (10 weeks old)
    const authMemberId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, bio, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'auth-member-1', 'auth-handle', 'Auth Member', 'Auth bio', 'authenticated_member_profile', now() - interval '10 weeks')
      `,
      [authMemberId, platformId],
    );

    // 2. Other member profile: 23h old (< 24h) vs 25h old (> 24h)
    const otherMember23hId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, bio, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'other-member-23h', 'other-23h', 'Other 23h', 'Bio 23h', 'other_member_profile', now() - interval '23 hours')
      `,
      [otherMember23hId, platformId],
    );
    const otherMember25hId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, bio, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'other-member-25h', 'other-25h', 'Other 25h', 'Bio 25h', 'other_member_profile', now() - interval '25 hours')
      `,
      [otherMember25hId, platformId],
    );

    // 3. Organization profile within 8 weeks (3 weeks) vs expired (9 weeks)
    const org3wId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'org-3w', 'org-3w', 'Org 3w', 'organization_profile', now() - interval '3 weeks')
      `,
      [org3wId, platformId],
    );
    const org9wId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'org-9w', 'org-9w', 'Org 9w', 'organization_profile', now() - interval '9 weeks')
      `,
      [org9wId, platformId],
    );

    // 4. Cross-scope organization profile:
    // Shared external account observed by Scope A (9 weeks ago, expired) and Scope B (1 week ago, lawful)
    const orgSharedId = randomUUID();
    await pool.query(
      `
        INSERT INTO social_external_accounts (
          id, platform_id, external_id, current_handle, display_name, provider_data_category, last_observed_at
        )
        VALUES ($1, $2, 'org-shared', 'org-shared', 'Org Shared', 'organization_profile', now() - interval '1 week')
      `,
      [orgSharedId, platformId],
    );
    const saoExpiredA = randomUUID();
    await pool.query(
      `
        INSERT INTO social_account_observations (
          id, scope_id, connection_id, external_account_id, observed_at, provider_data_category,
          normalization_version, adapter_version
        )
        VALUES ($1, $2, $3, $4, now() - interval '9 weeks', 'organization_profile', '1', '1')
      `,
      [saoExpiredA, connA.scope.scopeId, connA.connectionId, orgSharedId],
    );
    const saoLawfulB = randomUUID();
    await pool.query(
      `
        INSERT INTO social_account_observations (
          id, scope_id, connection_id, external_account_id, observed_at, provider_data_category,
          normalization_version, adapter_version
        )
        VALUES ($1, $2, $3, $4, now() - interval '1 week', 'organization_profile', '1', '1')
      `,
      [saoLawfulB, connB.scope.scopeId, connB.connectionId, orgSharedId],
    );

    // 5. Authorization asset minimization and retention
    const authId = randomUUID();
    await pool.query(
      `
        INSERT INTO provider_authorizations (
          id, scope_id, provider_family, provider_user_id, status, granted_scopes
        )
        VALUES ($1, $2, 'linkedin', 'urn:li:person:auth-user', 'ACTIVE', '["openid"]'::jsonb)
      `,
      [authId, connA.scope.scopeId],
    );
    const asset9wId = randomUUID();
    await pool.query(
      `
        INSERT INTO provider_authorization_assets (
          id, provider_authorization_id, platform_id, asset_type, provider_asset_id,
          name, handle, token_kind, provider_data_category, metadata, updated_at
        )
        VALUES ($1, $2, $3, 'LINKEDIN_ORGANIZATION', '99999',
          'Org 9w Decorative Name', 'org-9w-handle', 'USER', 'organization_profile',
          '{"organizationUrn":"urn:li:organization:99999","roles":["ADMINISTRATOR"],"primaryRole":"ADMINISTRATOR"}'::jsonb,
          now() - interval '9 weeks')
      `,
      [asset9wId, authId, platformId],
    );

    // Execute purge
    const result = await database.purgeExpiredProviderData({ providerFamily: "linkedin" });
    assert.ok(result.accountProfilesSanitized >= 2);
    assert.ok(result.authorizationAssetsSanitized >= 1);

    // Assertions:
    // 1. Authenticated member profile remains untouched
    const authMember = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [authMemberId])).rows[0];
    assert.equal(authMember.display_name, "Auth Member");
    assert.equal(authMember.bio, "Auth bio");

    // 2. Other member 23h remains; 25h redacted
    const other23h = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [otherMember23hId])).rows[0];
    assert.equal(other23h.display_name, "Other 23h");
    const other25h = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [otherMember25hId])).rows[0];
    assert.equal(other25h.display_name, null);
    assert.equal(other25h.bio, null);
    assert.equal(other25h.current_handle, null);
    assert.equal(other25h.external_id, "other-member-25h"); // stable ID remains!
    assert.equal(other25h.metadata.stableProviderIdentifierRetained, true);

    // 3. Org 3w remains; Org 9w redacted
    const org3w = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [org3wId])).rows[0];
    assert.equal(org3w.display_name, "Org 3w");
    const org9w = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [org9wId])).rows[0];
    assert.equal(org9w.display_name, null);
    assert.equal(org9w.current_handle, null);
    assert.equal(org9w.external_id, "org-9w"); // stable ID remains!

    // 4. Cross-scope: Scope A observation purged, Scope B observation remains; canonical profile remains
    const obsA = await pool.query("SELECT * FROM social_account_observations WHERE id = $1", [saoExpiredA]);
    assert.equal(obsA.rows.length, 0);
    const obsB = await pool.query("SELECT * FROM social_account_observations WHERE id = $1", [saoLawfulB]);
    assert.equal(obsB.rows.length, 1);
    const orgShared = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [orgSharedId])).rows[0];
    assert.equal(orgShared.display_name, "Org Shared");

    // Age Scope B observation to 9 weeks and purge again -> now canonical profile redacted!
    await pool.query("UPDATE social_account_observations SET observed_at = now() - interval '9 weeks' WHERE id = $1", [saoLawfulB]);
    await pool.query("UPDATE social_external_accounts SET last_observed_at = now() - interval '9 weeks' WHERE id = $1", [orgSharedId]);
    await database.purgeExpiredProviderData({ providerFamily: "linkedin" });
    const orgSharedAfterB = (await pool.query("SELECT * FROM social_external_accounts WHERE id = $1", [orgSharedId])).rows[0];
    assert.equal(orgSharedAfterB.display_name, null);
    assert.equal(orgSharedAfterB.external_id, "org-shared");

    // 5. Authorization asset: decorative fields sanitized, role/urn preserved
    const asset9w = (await pool.query("SELECT * FROM provider_authorization_assets WHERE id = $1", [asset9wId])).rows[0];
    assert.equal(asset9w.name, null);
    assert.equal(asset9w.handle, null);
    assert.equal(asset9w.provider_asset_id, "99999");
    assert.equal(asset9w.metadata.organizationUrn, "urn:li:organization:99999");
    assert.deepEqual(asset9w.metadata.roles, ["ADMINISTRATOR"]);
    assert.equal(asset9w.metadata.stableProviderIdentifierRetained, true);
  },
);
