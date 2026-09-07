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

async function waitForJob(jobId, statuses, timeout = 20_000) {
  return waitFor(async () => {
    const result = await pool.query(
      "SELECT status, attempt_count, ingestion_run_id FROM jobs WHERE id = $1",
      [jobId],
    );
    const row = result.rows[0];
    return row && statuses.includes(row.status) ? row : false;
  }, timeout);
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
