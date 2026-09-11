import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(32);
process.env.AI_MODEL_DISCOVERY_SWEEP_TIMEOUT_MS = "5000";
process.env.AI_MODEL_PROBE_TIMEOUT_MS = "1500";
process.env.AI_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER = "50";
process.env.AI_MODEL_PROBE_MAX_MODELS_PER_RUN = "10";

const {
  runMigrations,
  getPool,
  closeDatabase,
  createAiModelRegistryRefreshRequest,
} = await import("@xlrrank/database");
const { ModelRegistryService, validateProviderBaseUrl } = await import("../dist/index.js");

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

async function startOpenAiFixture(state) {
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
      res.end(JSON.stringify({ object: "list", data: account.models }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJson(req);
      const model = account.models.find((item) => item.id === body.model);
      if (!model?.capabilities?.includes("text_generation")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no chat" } }));
        return;
      }
      const structured = Boolean(body.response_format);
      const content =
        structured && model.id.includes("structured-bad")
          ? "not-json"
          : structured
            ? JSON.stringify({ status: "ok" })
            : "OK";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: randomUUID(),
          model: body.model,
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      const body = await readJson(req);
      const model = account.models.find((item) => item.id === body.model);
      if (!model?.capabilities?.includes("embeddings")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no embeddings" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
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

async function startAnthropicFixture(modelIds) {
  const server = createServer(async (req, res) => {
    if (req.headers["x-api-key"] !== "anthropic-key") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad key" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      const after = new URL(req.url, "http://fixture.test").searchParams.get("after_id");
      const page = after ? modelIds.slice(1) : modelIds.slice(0, 1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: page.map((id) => ({
            id,
            display_name: id,
            capabilities: { text_generation: { supported: true } },
          })),
          has_more: !after && modelIds.length > 1,
          last_id: page.at(-1),
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/messages") {
      const body = await readJson(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: randomUUID(),
          model: body.model,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startOllamaFixture(modelId) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ name: modelId, model: modelId, digest: randomUUID(), capabilities: ["text_generation"] }],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function insertProvider(pool, input) {
  const result = await pool.query(
    `
    INSERT INTO ai_providers (name, slug, protocol, base_url, enabled, config, status)
    VALUES ($1, $2, $3, $4, true, $5::jsonb, 'CONFIGURED')
    RETURNING id
    `,
    [input.name, input.slug, input.protocol, input.baseUrl, JSON.stringify(input.config ?? { allowPrivateNetwork: true })],
  );
  return result.rows[0].id;
}

test("Sprint 10 registry: persistent discovery, scoped credentials, capability validation, durability and SSRF policy", async () => {
  await runMigrations();
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const openAiState = {
    accounts: new Map([
      [
        "key-a",
        {
          failList: false,
          models: [
            {
              id: `fixture-text-${suffix}`,
              object: "model",
              version: "v1",
              fingerprint: "f1",
              capabilities: ["text_generation"],
            },
            {
              id: `fixture-embedding-${suffix}`,
              object: "model",
              version: "v1",
              capabilities: ["embeddings"],
            },
            {
              id: `fixture-structured-bad-${suffix}`,
              object: "model",
              version: "v1",
              capabilities: ["text_generation", "structured_output"],
            },
          ],
        },
      ],
      [
        "key-b",
        {
          failList: false,
          models: [
            {
              id: `fixture-b-only-${suffix}`,
              object: "model",
              version: "v1",
              capabilities: ["text_generation"],
            },
          ],
        },
      ],
    ]),
  };
  const fixture = await startOpenAiFixture(openAiState);
  try {
    const providerId = await insertProvider(pool, {
      name: `Fixture OpenAI ${suffix}`,
      slug: `fixture-openai-${suffix}`,
      protocol: "openai-compatible",
      baseUrl: fixture.baseUrl,
    });
    const registryA = new ModelRegistryService();
    const scopeA = randomUUID();
    const scopeB = randomUUID();
    const credentialA = await registryA.createCredential({ providerId, apiKey: "key-a", scopeKind: "USER", scopeId: scopeA });
    const credentialB = await registryA.createCredential({ providerId, apiKey: "key-b", scopeKind: "USER", scopeId: scopeB });
    const badCredential = await registryA.createCredential({ providerId, apiKey: "wrong", scopeKind: "USER", scopeId: randomUUID() });

    const first = await registryA.refresh({ providerId, credentialId: credentialA.id, maxProbeModels: 10 });
    assert.equal(first.runtimes[0].discovery.ok, true);
    assert.equal(first.runtimes[0].persistedModels, 3);
    assert.ok(first.runtimes[0].probedModels >= 2);

    const registryAfterRestart = new ModelRegistryService();
    const textModels = await registryAfterRestart.listAvailableModels({
      credentialId: credentialA.id,
      capability: "text_generation",
      lifecycleStage: "VALIDATED",
    });
    assert.ok(textModels.some((model) => model.modelId === `fixture-text-${suffix}`), "discovered text model survived registry restart");
    assert.ok(textModels.every((model) => model.lifecycleStage !== "ACTIVE"), "models do not become ACTIVE from discovery alone");

    const embeddingModels = await registryAfterRestart.listAvailableModels({
      credentialId: credentialA.id,
      capability: "embeddings",
      lifecycleStage: "VALIDATED",
    });
    assert.ok(embeddingModels.some((model) => model.modelId === `fixture-embedding-${suffix}`), "embedding-only model validates without chat probes");

    const failedCapability = await pool.query(
      `
      SELECT acv.status
      FROM ai_model_capability_validations acv
      JOIN ai_models am ON am.id = acv.model_id
      WHERE am.model_id = $1 AND acv.capability = 'structured_output'
      `,
      [`fixture-structured-bad-${suffix}`],
    );
    assert.equal(failedCapability.rows[0]?.status, "FAILED");

    openAiState.accounts.get("key-a").models.push({
      id: `fixture-new-${suffix}`,
      object: "model",
      version: "v1",
      capabilities: ["text_generation"],
    });
    await registryAfterRestart.refresh({ providerId, credentialId: credentialA.id, maxProbeModels: 10 });
    const newModel = await registryAfterRestart.get(providerId, `fixture-new-${suffix}`);
    assert.equal(newModel?.lifecycleStage, "VALIDATED", "previously unknown model appears without code change");

    await pool.query(
      "UPDATE ai_models SET lifecycle_stage = 'ACTIVE' WHERE provider_id = $1 AND model_id = $2",
      [providerId, `fixture-text-${suffix}`],
    );
    openAiState.accounts.get("key-a").models[0].fingerprint = "f2";
    await registryAfterRestart.refresh({ providerId, credentialId: credentialA.id, maxProbeModels: 10 });
    const changed = await registryAfterRestart.get(providerId, `fixture-text-${suffix}`);
    assert.equal(changed?.lifecycleStage, "VALIDATED", "changed fingerprint forced revalidation instead of silently remaining ACTIVE");

    const beforeFailure = await registryAfterRestart.get(providerId, `fixture-text-${suffix}`);
    openAiState.accounts.get("key-a").failList = true;
    const failed = await registryAfterRestart.refresh({ providerId, credentialId: credentialA.id });
    assert.equal(failed.runtimes[0].discovery.ok, false);
    const afterFailure = await registryAfterRestart.get(providerId, `fixture-text-${suffix}`);
    assert.equal(afterFailure?.modelId, beforeFailure?.modelId, "provider list failure preserves previous model state");
    openAiState.accounts.get("key-a").failList = false;

    await registryAfterRestart.refresh({ providerId, credentialId: credentialB.id, maxProbeModels: 10 });
    const bModels = await registryAfterRestart.listAvailableModels({ credentialId: credentialB.id });
    assert.ok(bModels.some((model) => model.modelId === `fixture-b-only-${suffix}`));
    assert.ok(!bModels.some((model) => model.modelId === `fixture-text-${suffix}`), "scoped BYOK credentials are isolated");

    const authFailure = await registryAfterRestart.refresh({ providerId, credentialId: badCredential.id });
    assert.equal(authFailure.runtimes[0].discovery.ok, false);
    assert.equal(authFailure.runtimes[0].discovery.health, "AUTHENTICATION_FAILED");

    const boundedProviderId = await insertProvider(pool, {
      name: `Fixture Bounded ${suffix}`,
      slug: `fixture-bounded-${suffix}`,
      protocol: "openai-compatible",
      baseUrl: fixture.baseUrl,
    });
    await registryAfterRestart.createCredential({ providerId: boundedProviderId, apiKey: "key-a", scopeKind: "USER", scopeId: randomUUID() });
    const bounded = await registryAfterRestart.refresh({ providerId: boundedProviderId, maxModelsPerProvider: 2, maxProbeModels: 1 });
    assert.equal(bounded.runtimes[0].persistedModels, 2, "discovery work is bounded");
    assert.equal(bounded.runtimes[0].probedModels, 1, "probe work is bounded");

    const durable = await createAiModelRegistryRefreshRequest({
      providerId,
      credentialId: credentialA.id,
      idempotencyKey: `ai-registry-test-${suffix}`,
      reason: "MANUAL",
    });
    const durableJob = await pool.query("SELECT payload FROM jobs WHERE id = $1", [durable.jobId]);
    assert.deepEqual(Object.keys(durableJob.rows[0].payload).sort(), ["credentialId", "jobRequestId", "providerId", "reason", "version"]);

    assert.throws(() => validateProviderBaseUrl("http://127.0.0.1:11434"));
    assert.equal(validateProviderBaseUrl("http://127.0.0.1:11434", { allowPrivateNetwork: true }), "http://127.0.0.1:11434");
  } finally {
    await fixture.close();
  }
});

test("Sprint 10 registry: Anthropic pagination, Ollama tags, and no static production model catalog", async () => {
  await runMigrations();
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const anthropicIds = [`anthropic-fixture-a-${suffix}`, `anthropic-fixture-b-${suffix}`];
  const anthropic = await startAnthropicFixture(anthropicIds);
  const ollama = await startOllamaFixture(`ollama-fixture-${suffix}:latest`);
  try {
    const registry = new ModelRegistryService();
    const anthropicProviderId = await insertProvider(pool, {
      name: `Fixture Anthropic ${suffix}`,
      slug: `fixture-anthropic-${suffix}`,
      protocol: "anthropic",
      baseUrl: anthropic.baseUrl,
    });
    const anthropicCredential = await registry.createCredential({
      providerId: anthropicProviderId,
      apiKey: "anthropic-key",
      scopeKind: "SYSTEM",
    });
    const anthropicResult = await registry.refresh({ providerId: anthropicProviderId, credentialId: anthropicCredential.id, maxProbeModels: 10 });
    assert.equal(anthropicResult.runtimes[0].discovery.ok, true);
    assert.equal(anthropicResult.runtimes[0].persistedModels, 2, "Anthropic paginated discovery persists dynamic IDs");

    const ollamaProviderId = await insertProvider(pool, {
      name: `Fixture Ollama ${suffix}`,
      slug: `fixture-ollama-${suffix}`,
      protocol: "ollama",
      baseUrl: ollama.baseUrl,
    });
    const ollamaResult = await registry.refresh({ providerId: ollamaProviderId, maxProbeModels: 0 });
    assert.equal(ollamaResult.runtimes[0].discovery.ok, true);
    assert.equal(ollamaResult.runtimes[0].persistedModels, 1, "Ollama tag discovery persists dynamic IDs");

    const anthropicSource = await readFile(new URL("../src/providers/anthropic-provider.ts", import.meta.url), "utf8");
    assert.ok(!anthropicSource.includes("claude-sonnet-4-20250514"));
    assert.ok(!anthropicSource.includes("claude-opus-4-20250514"));
  } finally {
    await anthropic.close();
    await ollama.close();
    await closeDatabase();
  }
});
