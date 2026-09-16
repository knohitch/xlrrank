import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(32);
process.env.AI_MODEL_DISCOVERY_SWEEP_TIMEOUT_MS = "5000";
process.env.AI_MODEL_PROBE_TIMEOUT_MS = "500";
process.env.AI_MODEL_DISCOVERY_MAX_PROVIDERS_PER_RUN = "2";
process.env.AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER = "10";
process.env.AI_MODEL_PROBE_MAX_MODELS_PER_RUN = "2";

const {
  runMigrations,
  getPool,
  closeDatabase,
  createAiModelRegistryRefreshRequest,
} = await import("@xlrrank/database");
const { ModelRegistryService } = await import("@xlrrank/ai-core");
const { JOB_TYPES } = await import("@xlrrank/queue");
const {
  processAiModelRegistryRefresh,
} = await import("../dist/ai-model-registry-refresh-processor.js");
const {
  scheduleDueAiModelRegistryRefreshesOnce,
} = await import("../dist/runtime.js");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function startFixture(state) {
  const server = createServer(async (req, res) => {
    const key = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const account = state.accounts.get(key);
    if (!account) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      if (account.failList) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: account.models.map(({ serverCapabilities, ...model }) => model) }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJson(req);
      const model = account.models.find((item) => item.id === body.model);
      if (!model?.serverCapabilities?.includes("text_generation")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no chat" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function insertProvider(pool, input) {
  const result = await pool.query(
    `
    INSERT INTO ai_providers (name, slug, protocol, base_url, enabled, config, status, last_discovery_attempt_at)
    VALUES ($1, $2, 'openai-compatible', $3, true, $4::jsonb, 'CONFIGURED', $5)
    RETURNING id
    `,
    [
      input.name,
      input.slug,
      input.baseUrl,
      JSON.stringify({ allowPrivateNetwork: true, probeCapabilities: ["text_generation"] }),
      input.lastDiscoveryAttemptAt ?? null,
    ],
  );
  return result.rows[0].id;
}

test("Sprint 10 worker: durable AI registry refresh processor updates registry and job ledger", async () => {
  await runMigrations();
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const state = {
    accounts: new Map([
      [
        "worker-key",
        {
          failList: false,
          models: [{ id: `worker-model-${suffix}`, object: "model", version: "v1", serverCapabilities: ["text_generation"] }],
        },
      ],
      ["fail-key", { failList: true, models: [] }],
    ]),
  };
  const fixture = await startFixture(state);
  try {
    const registry = new ModelRegistryService();
    const providerId = await insertProvider(pool, {
      name: `Worker AI Provider ${suffix}`,
      slug: `worker-ai-provider-${suffix}`,
      baseUrl: fixture.baseUrl,
    });
    const credential = await registry.createCredential({ providerId, apiKey: "worker-key", scopeKind: "SYSTEM" });
    const durable = await createAiModelRegistryRefreshRequest({
      providerId,
      credentialId: credential.id,
      reason: "MANUAL",
      idempotencyKey: `worker-ai-refresh-${suffix}`,
    });
    const jobRow = await pool.query("SELECT payload FROM jobs WHERE id = $1", [durable.jobId]);
    const outbox = await pool.query("SELECT id FROM job_outbox WHERE job_id = $1", [durable.jobId]);
    assert.equal(outbox.rowCount, 1, "durable refresh outbox exists");

    const processed = await processAiModelRegistryRefresh({
      name: JOB_TYPES.aiModelRegistryRefresh,
      data: jobRow.rows[0].payload,
    });
    assert.equal(processed.refreshedRuntimes, 1);
    const model = await pool.query("SELECT id FROM ai_models WHERE provider_id = $1 AND model_id = $2", [
      providerId,
      `worker-model-${suffix}`,
    ]);
    assert.equal(model.rowCount, 1, "processor persisted registry changes");
    const completed = await pool.query("SELECT status FROM jobs WHERE id = $1", [durable.jobId]);
    assert.equal(completed.rows[0]?.status, "COMPLETED", "durable job reaches terminal COMPLETED");

    const failingProviderId = await insertProvider(pool, {
      name: `Worker AI Failure ${suffix}`,
      slug: `worker-ai-failure-${suffix}`,
      baseUrl: fixture.baseUrl,
    });
    const failingCredential = await registry.createCredential({ providerId: failingProviderId, apiKey: "fail-key", scopeKind: "SYSTEM" });
    const failingDurable = await createAiModelRegistryRefreshRequest({
      providerId: failingProviderId,
      credentialId: failingCredential.id,
      reason: "MANUAL",
      idempotencyKey: `worker-ai-refresh-fail-${suffix}`,
    });
    const failingJob = await pool.query("SELECT payload FROM jobs WHERE id = $1", [failingDurable.jobId]);
    await assert.rejects(
      processAiModelRegistryRefresh({
        name: JOB_TYPES.aiModelRegistryRefresh,
        data: failingJob.rows[0].payload,
      }),
      /refresh failed/,
    );
    const retry = await pool.query("SELECT status, safe_error FROM jobs WHERE id = $1", [failingDurable.jobId]);
    assert.equal(retry.rows[0]?.status, "RETRY_SCHEDULED", "provider failure records truthful retry state");
    assert.equal(JSON.stringify(retry.rows[0]?.safe_error).includes("fail-key"), false, "safe job error does not include credentials");
  } finally {
    await fixture.close();
  }
});

test("Sprint 10 worker: scheduled AI registry sweep is bounded and duplicate-safe", async () => {
  await runMigrations();
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const fixture = await startFixture({ accounts: new Map([["key", { failList: false, models: [] }]]) });
  try {
    await pool.query("UPDATE ai_providers SET enabled = false WHERE enabled = true");
    const providerIds = [];
    for (let index = 0; index < 3; index += 1) {
      providerIds.push(
        await insertProvider(pool, {
          name: `Sweep Provider ${index} ${suffix}`,
          slug: `sweep-provider-${index}-${suffix}`,
          baseUrl: fixture.baseUrl,
          lastDiscoveryAttemptAt: new Date(0),
        }),
      );
    }
    const first = await scheduleDueAiModelRegistryRefreshesOnce(`test-scheduler-${suffix}`);
    assert.equal(first, 2, "sweep respects max providers per run");
    const second = await scheduleDueAiModelRegistryRefreshesOnce(`test-scheduler-${suffix}`);
    assert.equal(second, 1, "later cycle schedules remaining provider without starvation");
    const third = await scheduleDueAiModelRegistryRefreshesOnce(`test-scheduler-${suffix}`);
    assert.equal(third, 0, "active refresh jobs prevent duplicate concurrent scheduling");
    const queued = await pool.query(
      `
      SELECT count(*)::int AS count
      FROM jobs
      WHERE type = $1
        AND payload->>'providerId' = ANY($2::text[])
      `,
      [JOB_TYPES.aiModelRegistryRefresh, providerIds],
    );
    assert.equal(queued.rows[0].count, 3);
  } finally {
    await fixture.close();
    await closeDatabase();
  }
});
