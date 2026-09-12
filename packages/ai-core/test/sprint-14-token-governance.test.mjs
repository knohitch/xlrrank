import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(32);

const { runMigrations, getPool } = await import("@xlrrank/database");
const {
  AiGateway,
  AiProviderError,
  AiRouter,
  BaseAiProvider,
  ModelRegistryService,
} = await import("../dist/index.js");

const COMPLETE_LIMITS = {
  maxMessages: 4,
  maxMessageCharacters: 256,
  maxInputCharacters: 512,
  maxEmbeddingInputs: 4,
  maxSchemaCharacters: 512,
  maxToolDefinitions: 2,
  maxToolParameterCharacters: 512,
  maxOutputTokens: 16,
  maxModelInvocations: 3,
};

class GovernanceFixtureProvider extends BaseAiProvider {
  constructor(id, behavior = {}) {
    super();
    this.behavior = behavior;
    this.status = "connected";
    this.calls = [];
    this.manifest = {
      id,
      name: `governance-${id}`,
      protocol: "fixture",
      capabilities: ["text_generation", "structured_output", "embeddings", "streaming"],
    };
  }

  async generateText(request) {
    this.calls.push({ kind: "text", request });
    const action = nextAction(this.behavior.text?.[request.model], request);
    if (action instanceof Error) throw action;
    const content = typeof action === "function" ? await action(request) : action ?? "ok";
    return { content, model: request.model, usage: this.behavior.usage, finishReason: "stop" };
  }

  async generateStructured(request) {
    this.calls.push({ kind: "structured", request });
    return { data: { status: "ok" }, model: request.model, usage: this.behavior.usage, rawContent: '{"status":"ok"}' };
  }

  async generateEmbeddings(request) {
    this.calls.push({ kind: "embeddings", request });
    return { embeddings: [[0.1, 0.2]], model: request.model, usage: this.behavior.usage };
  }
}

function nextAction(action, request) {
  if (Array.isArray(action)) return action.shift();
  if (typeof action === "function") return action(request);
  return action;
}

async function insertProvider(pool) {
  const slug = `sprint-14-${randomUUID()}`;
  const result = await pool.query(
    `
    INSERT INTO ai_providers (name, slug, protocol, enabled, config, status, health)
    VALUES ($1, $2, 'fixture', true, '{}'::jsonb, 'HEALTHY', '{"status":"fixture"}'::jsonb)
    RETURNING id
    `,
    [`Sprint 14 ${slug}`, slug],
  );
  return result.rows[0].id;
}

async function insertRuntimeModel(pool, input) {
  const modelResult = await pool.query(
    `
    INSERT INTO ai_models
      (provider_id, model_id, display_name, version, fingerprint, lifecycle_stage, capabilities, health, last_seen_at, last_probed_at)
    VALUES ($1, $2, $2, 'v1', 'fp1', 'VALIDATED', $3::jsonb, '{"healthy":true}'::jsonb, now(), now())
    RETURNING id
    `,
    [input.providerId, input.modelId, JSON.stringify(input.capabilities)],
  );
  const modelUuid = modelResult.rows[0].id;
  await pool.query(
    `
    INSERT INTO ai_model_availability
      (provider_id, model_id, credential_id, runtime_key, status, health, last_seen_at, last_checked_at, last_probed_at)
    VALUES ($1, $2, NULL, 'system', 'AVAILABLE', '{"healthy":true}'::jsonb, now(), now(), now())
    `,
    [input.providerId, modelUuid],
  );
  for (const validation of input.validations) {
    await pool.query(
      `
      INSERT INTO ai_model_capability_validations
        (model_id, credential_id, runtime_key, capability, status, quality, latency_ms)
      VALUES ($1, NULL, 'system', $2, 'VALIDATED', $3, $4)
      `,
      [modelUuid, validation.capability, validation.quality ?? 80, validation.latencyMs ?? 100],
    );
  }
}

function routerFor(providerId, fixture, routingPolicy = {}) {
  const gateway = new AiGateway();
  gateway.registerProvider(fixture);
  return new AiRouter(new ModelRegistryService(), gateway, {
    routingPolicy,
    runtimeProviderResolver: async () => fixture,
  });
}

test("Sprint 14 governance: context, output, embedding, and usage boundaries are enforced", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const textModel = `governance-text-${randomUUID()}`;
  const embeddingModel = `governance-embedding-${randomUUID()}`;
  await insertRuntimeModel(pool, {
    providerId,
    modelId: textModel,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation" }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: embeddingModel,
    capabilities: ["embeddings"],
    validations: [{ capability: "embeddings" }],
  });

  const fixture = new GovernanceFixtureProvider(providerId, { text: { [textModel]: "bounded answer" } });
  const router = routerFor(providerId, fixture, {
    executionLimits: { ...COMPLETE_LIMITS, maxInputCharacters: 20, maxMessageCharacters: 20, maxEmbeddingInputs: 2, maxOutputTokens: 7 },
  });

  const bounded = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    preferredProviderId: providerId,
    preferredModelId: textModel,
    mode: "CUSTOM",
    prompt: "small prompt",
    maxOutputTokens: 6,
  });
  assert.equal(bounded.ok, true);
  assert.equal(fixture.calls[0].request.maxTokens, 6);
  assert.equal(bounded.usage, undefined);
  assert.equal(bounded.evidence.attempts[0].usage?.source, "UNKNOWN");
  assert.equal(bounded.evidence.attempts[0].usage?.outputTokenLimit, 6);

  const oversized = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    preferredProviderId: providerId,
    preferredModelId: textModel,
    mode: "CUSTOM",
    prompt: "x".repeat(21),
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error?.code, "AI_EXECUTION_LIMIT_EXCEEDED");

  const excessiveOutput = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    preferredProviderId: providerId,
    preferredModelId: textModel,
    mode: "CUSTOM",
    prompt: "small",
    maxOutputTokens: 8,
  });
  assert.equal(excessiveOutput.ok, false);
  assert.equal(excessiveOutput.error?.code, "AI_EXECUTION_LIMIT_EXCEEDED");

  const excessiveEmbeddingBatch = await router.execute({
    taskType: "embedding",
    preferredProviderId: providerId,
    preferredModelId: embeddingModel,
    mode: "CUSTOM",
    embeddingInput: ["a", "b", "c"],
  });
  assert.equal(excessiveEmbeddingBatch.ok, false);
  assert.equal(excessiveEmbeddingBatch.error?.code, "AI_EXECUTION_LIMIT_EXCEEDED");
});

test("Sprint 14 governance: retry, fallback, and language correction cannot amplify beyond policy", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const primary = `governance-primary-${randomUUID()}`;
  const secondary = `governance-secondary-${randomUUID()}`;
  for (const [modelId, quality] of [[primary, 90], [secondary, 80]]) {
    await insertRuntimeModel(pool, {
      providerId,
      modelId,
      capabilities: ["text_generation"],
      validations: [{ capability: "text_generation", quality }],
    });
  }

  const fixture = new GovernanceFixtureProvider(providerId, {
    text: {
      [primary]: "这是完全中文的回答，应该满足中文目标。",
      [secondary]: new AiProviderError("temporary outage", providerId, "TEMPORARY", true),
    },
  });
  const router = routerFor(providerId, fixture, {
    defaultModeWeights: { AUTOMATIC: { quality: 1, latency: 0, health: 0, capabilityPreference: 0 } },
    maxFallbackAttempts: 5,
    executionLimits: { ...COMPLETE_LIMITS, maxModelInvocations: 2 },
  });

  const result = await router.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    targetLanguage: "en",
    languagePolicy: { maxRetryAttempts: 5, minimumTextCharacters: 4, minimumConfidence: 0.45 },
    prompt: "answer in English",
    maxFallbackAttempts: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.requirements.maxAttempts, 2);
  assert.equal(result.evidence.attempts.length, 2);
  assert.equal(fixture.calls.length, 2);
  assert.equal(result.evidence.attempts.every((attempt) => attempt.modelId === primary), true);
});

test("Sprint 14 governance: duplicate in-flight logical execution is idempotent by material fingerprint", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const modelId = `governance-idempotent-${randomUUID()}`;
  await insertRuntimeModel(pool, {
    providerId,
    modelId,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation" }],
  });

  const fixture = new GovernanceFixtureProvider(providerId, {
    text: {
      [modelId]: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return `answer:${request.messages.at(-1)?.content}`;
      },
    },
  });
  const router = routerFor(providerId, fixture, { executionLimits: COMPLETE_LIMITS });
  const baseRequest = {
    taskType: "classification",
    requiredCapability: "text_generation",
    preferredProviderId: providerId,
    preferredModelId: modelId,
    mode: "CUSTOM",
    idempotencyKey: `logical-work-${randomUUID()}`,
    prompt: "same source revision",
  };

  const [first, second] = await Promise.all([router.execute(baseRequest), router.execute(baseRequest)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(first.content, second.content);

  const changed = await router.execute({ ...baseRequest, prompt: "changed source revision" });
  assert.equal(changed.ok, true);
  assert.equal(fixture.calls.length, 2);
});

test("Sprint 14 governance: direct gateway execution has structural fail-safe bounds", async () => {
  const providerId = `direct-${randomUUID()}`;
  const fixture = new GovernanceFixtureProvider(providerId, { text: { model: "direct ok" } });
  const gateway = new AiGateway({
    executionLimits: { ...COMPLETE_LIMITS, maxInputCharacters: 5, maxMessageCharacters: 5, maxOutputTokens: 3 },
  });
  gateway.registerProvider(fixture);

  await assert.rejects(
    () => gateway.generateText(providerId, { model: "model", messages: [{ role: "user", content: "too long" }] }),
    /exceeds configured/,
  );

  const result = await gateway.generateText(providerId, { model: "model", messages: [{ role: "user", content: "ok" }] });
  assert.equal(result.content, "direct ok");
  assert.equal(fixture.calls.at(-1).request.maxTokens, 3);
});
