import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    "TRUNCATE job_dead_letters, worker_heartbeats, social_sync_schedules, social_sync_leases, job_outbox, jobs, audit_logs, social_content_metrics, social_interaction_observations, social_interactions, social_content_observations, social_content_items, social_account_observations, social_ingestion_runs, social_connections, social_account_handles, social_external_accounts, social_accounts, data_scopes, organization_member_permissions, organization_members, organizations, platforms, users RESTART IDENTITY CASCADE",
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
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = String(req.headers.authorization ?? "");
    tokenLog.push({ authorization, url: url.pathname + url.search, at: Date.now() });

    if (url.pathname === "/2/oauth2/token" && req.method === "POST") {
      const body = await readBody(req);
      const refreshToken = new URLSearchParams(body).get("refresh_token");
      res.setHeader("content-type", "application/json");
      if (refreshToken === "x-refresh-reauth") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid_grant" }));
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
  const providerConfigId = randomUUID();
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
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
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
  assert.equal(result, expectedCode);
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
      await waitWorkerExit(crashingWorker, 76);
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
      await waitWorkerExit(crashingWorker, 75);
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
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM social_ingestion_runs WHERE connection_id = $1 AND cursor_after = $2",
              [
                ok.connectionId,
                Buffer.from(JSON.stringify({ timeline: "x-page-2" }), "utf8").toString("base64url"),
              ],
            )
          ).rows[0].count,
        ),
        1,
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
