import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(32);

const { runMigrations, getPool } = await import("@xlrrank/database");
const {
  AiAuthenticationError,
  AiGateway,
  AiProviderError,
  AiRouter,
  BaseAiProvider,
  ModelRegistryService,
} = await import("../dist/index.js");

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

class FixtureProvider extends BaseAiProvider {
  constructor(id, behavior = {}) {
    super();
    this.behavior = behavior;
    this.status = behavior.status ?? "connected";
    this.manifest = {
      id,
      name: `fixture-${id}`,
      protocol: "fixture",
      capabilities: ["text_generation", "structured_output", "embeddings", "streaming", "reasoning"],
    };
  }

  async generateText(request) {
    const action = nextAction(this.behavior.text?.[request.model], request);
    if (action instanceof Error) throw action;
    const content = typeof action === "function" ? action(request) : action ?? "ok";
    return { content, model: request.model, usage, finishReason: "stop" };
  }

  async generateStructured(request) {
    const action = nextAction(this.behavior.structured?.[request.model], request);
    if (action instanceof Error) throw action;
    const data = typeof action === "function" ? action(request) : action ?? { status: "ok" };
    return { data, model: request.model, usage, rawContent: JSON.stringify(data) };
  }

  async generateEmbeddings(request) {
    const action = nextAction(this.behavior.embeddings?.[request.model], request);
    if (action instanceof Error) throw action;
    return { embeddings: [[0.1, 0.2, 0.3]], model: request.model, usage };
  }
}

function nextAction(action, request) {
  if (Array.isArray(action)) return action.shift();
  if (typeof action === "function") return action(request);
  return action;
}

async function insertProvider(pool, { status = "HEALTHY" } = {}) {
  const slug = `sprint-11-${randomUUID()}`;
  const result = await pool.query(
    `
    INSERT INTO ai_providers (name, slug, protocol, enabled, config, status, health)
    VALUES ($1, $2, 'fixture', true, '{}'::jsonb, $3, '{"status":"fixture"}'::jsonb)
    RETURNING id
    `,
    [`Sprint 11 ${slug}`, slug, status],
  );
  return result.rows[0].id;
}

async function insertCredential(pool, providerId, { scopeId = randomUUID(), status = "HEALTHY" } = {}) {
  const result = await pool.query(
    `
    INSERT INTO ai_provider_credentials
      (provider_id, scope_kind, scope_id, label, credentials_encrypted, status)
    VALUES ($1, 'USER', $2, $3, 'encrypted-test-placeholder', $4)
    RETURNING id
    `,
    [providerId, scopeId, `fixture-${randomUUID()}`, status],
  );
  return { id: result.rows[0].id, scopeId };
}

async function insertRuntimeModel(pool, input) {
  const modelResult = await pool.query(
    `
    INSERT INTO ai_models
      (provider_id, model_id, display_name, version, fingerprint, lifecycle_stage, capabilities, health, last_seen_at, last_probed_at)
    VALUES ($1, $2, $2, $3, $4, $5, $6::jsonb, '{"healthy":true,"lastChecked":"2026-09-11T00:00:00.000Z"}'::jsonb, now(), now())
    ON CONFLICT (provider_id, model_id) DO UPDATE
    SET lifecycle_stage = EXCLUDED.lifecycle_stage,
        capabilities = EXCLUDED.capabilities,
        health = EXCLUDED.health,
        last_seen_at = now(),
        last_probed_at = now(),
        updated_at = now()
    RETURNING id
    `,
    [
      input.providerId,
      input.modelId,
      input.version ?? "v1",
      input.fingerprint ?? "fp1",
      input.lifecycleStage ?? "VALIDATED",
      JSON.stringify(input.capabilities ?? []),
    ],
  );
  const modelUuid = modelResult.rows[0].id;
  const runtimeKey = input.credentialId ? `credential:${input.credentialId}` : "system";
  await pool.query(
    `
    INSERT INTO ai_model_availability
      (provider_id, model_id, credential_id, runtime_key, status, health, last_seen_at, last_checked_at, last_probed_at)
    VALUES ($1, $2, $3, $4, $5, '{"healthy":true}'::jsonb, now(), now(), now())
    `,
    [input.providerId, modelUuid, input.credentialId ?? null, runtimeKey, input.availabilityStatus ?? "AVAILABLE"],
  );
  for (const validation of input.validations ?? []) {
    await pool.query(
      `
      INSERT INTO ai_model_capability_validations
        (model_id, credential_id, runtime_key, capability, status, quality, latency_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        modelUuid,
        input.credentialId ?? null,
        runtimeKey,
        validation.capability,
        validation.status ?? "VALIDATED",
        validation.quality ?? 70,
        validation.latencyMs ?? 250,
      ],
    );
  }
  return modelUuid;
}

function routerFor(providerId, behavior = {}, options = {}) {
  const gateway = new AiGateway();
  gateway.registerProvider(new FixtureProvider(providerId, behavior));
  return new AiRouter(new ModelRegistryService(), gateway, {
    ...options,
    runtimeProviderResolver: options.runtimeProviderResolver ?? (async () => new FixtureProvider(providerId, behavior)),
  });
}

test("Sprint 11 router: capability evidence filters text, structured, and stale-revision candidates", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const suffix = randomUUID();
  const textModel = `generated-text-${suffix}`;
  const embeddingOnly = `generated-embedding-${suffix}`;
  const structuredModel = `generated-structured-${suffix}`;
  const staleModel = `generated-stale-${suffix}`;

  await insertRuntimeModel(pool, {
    providerId,
    modelId: embeddingOnly,
    capabilities: ["embeddings"],
    validations: [{ capability: "embeddings", quality: 95, latencyMs: 40 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: textModel,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 75, latencyMs: 120 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: structuredModel,
    capabilities: ["structured_output"],
    validations: [{ capability: "structured_output", quality: 80, latencyMs: 180 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: staleModel,
    lifecycleStage: "PROBING",
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 99, latencyMs: 10 }],
  });

  const router = routerFor(providerId, {
    text: { [textModel]: "The result is ready.", [embeddingOnly]: "wrong", [staleModel]: "stale" },
    structured: { [structuredModel]: { status: "ok" } },
  });

  const text = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "classify",
  });
  assert.equal(text.ok, true);
  assert.equal(text.decision?.modelId, textModel);
  assert.equal(text.evidence.candidates.some((candidate) => candidate.modelId === embeddingOnly), false);
  assert.equal(text.evidence.candidates.some((candidate) => candidate.modelId === staleModel), false);

  const structured = await router.execute({
    taskType: "semantic_extraction",
    tier: "TIER_1_EVERYDAY",
    structuredOutput: {
      required: true,
      schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
    },
    prompt: "extract",
  });
  assert.equal(structured.ok, true);
  assert.equal(structured.decision?.modelId, structuredModel);
});

test("Sprint 11 router: routing policy changes ranking and deep policy can prefer reasoning evidence", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const suffix = randomUUID();
  const fastModel = `generated-fast-${suffix}`;
  const deepModel = `generated-deep-${suffix}`;

  await insertRuntimeModel(pool, {
    providerId,
    modelId: fastModel,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 80, latencyMs: 50 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: deepModel,
    capabilities: ["text_generation", "reasoning"],
    validations: [
      { capability: "text_generation", quality: 95, latencyMs: 2200 },
      { capability: "reasoning", quality: 96, latencyMs: 2200 },
    ],
  });
  const latencyPolicy = {
    latencyReferenceMs: 3000,
    defaultModeWeights: {
      AUTOMATIC: { quality: 0.1, latency: 2, health: 0, capabilityPreference: 0 },
    },
    tiers: {
      TIER_3_DEEP_INTELLIGENCE: {
        preferredCapabilities: { reasoning: 100 },
        modeWeights: {
          AUTOMATIC: { quality: 0.2, latency: 0.1, health: 0, capabilityPreference: 3 },
        },
      },
    },
  };
  const qualityPolicy = {
    latencyReferenceMs: 3000,
    defaultModeWeights: {
      AUTOMATIC: { quality: 2, latency: 0.1, health: 0, capabilityPreference: 0 },
    },
  };
  const latencyRouter = routerFor(providerId, {
    text: { [fastModel]: "fast response", [deepModel]: "deep response" },
  }, { routingPolicy: latencyPolicy });
  const qualityRouter = routerFor(providerId, {
    text: { [fastModel]: "fast response", [deepModel]: "deep response" },
  }, { routingPolicy: qualityPolicy });

  const routine = await latencyRouter.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "routine",
  });
  assert.equal(routine.ok, true);
  assert.equal(routine.decision?.modelId, fastModel);

  const qualityBiased = await qualityRouter.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "routine",
  });
  assert.equal(qualityBiased.ok, true);
  assert.equal(qualityBiased.decision?.modelId, deepModel);

  const deep = await latencyRouter.execute({
    taskType: "reasoning",
    requiredCapability: "text_generation",
    tier: "TIER_3_DEEP_INTELLIGENCE",
    prompt: "analyze",
  });
  assert.equal(deep.ok, true);
  assert.equal(deep.decision?.modelId, deepModel);
  assert.equal(deep.evidence.requirements.capabilities.includes("reasoning"), false);
});

test("Sprint 11 router: credential scoped availability and health remain isolated", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool, { status: "DEGRADED" });
  const scopeA = randomUUID();
  const credentialA = await insertCredential(pool, providerId, { scopeId: scopeA, status: "HEALTHY" });
  const credentialB = await insertCredential(pool, providerId, { status: "HEALTHY" });
  const credentialBad = await insertCredential(pool, providerId, { status: "AUTHENTICATION_FAILED" });
  const modelA = `generated-user-a-${randomUUID()}`;
  const modelB = `generated-user-b-${randomUUID()}`;
  const modelBad = `generated-user-bad-${randomUUID()}`;

  for (const [modelId, credentialId] of [
    [modelA, credentialA.id],
    [modelB, credentialB.id],
    [modelBad, credentialBad.id],
  ]) {
    await insertRuntimeModel(pool, {
      providerId,
      modelId,
      credentialId,
      capabilities: ["text_generation"],
      validations: [{ capability: "text_generation", quality: 80, latencyMs: 100 }],
    });
  }
  const router = routerFor(providerId, {
    text: { [modelA]: "scoped A", [modelB]: "scoped B", [modelBad]: "bad" },
  });

  const scopedA = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    scopeId: scopeA,
    prompt: "classify",
  });
  assert.equal(scopedA.ok, true);
  assert.equal(scopedA.decision?.credentialId, credentialA.id);
  assert.equal(scopedA.decision?.modelId, modelA);

  const badCredential = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    credentialId: credentialBad.id,
    prompt: "classify",
  });
  assert.equal(badCredential.ok, false);
  assert.equal(badCredential.status, "NO_ELIGIBLE_MODEL");
});

test("Sprint 11 router: selected credential runtime is the executed provider runtime", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const scopeA = randomUUID();
  const scopeB = randomUUID();
  const credentialA = await insertCredential(pool, providerId, { scopeId: scopeA, status: "HEALTHY" });
  const credentialB = await insertCredential(pool, providerId, { scopeId: scopeB, status: "HEALTHY" });
  const sharedModel = `generated-shared-runtime-${randomUUID()}`;
  const invocations = [];

  for (const credential of [credentialA, credentialB]) {
    await insertRuntimeModel(pool, {
      providerId,
      modelId: sharedModel,
      credentialId: credential.id,
      capabilities: ["text_generation"],
      validations: [{ capability: "text_generation", quality: 80, latencyMs: 100 }],
    });
  }

  const router = routerFor(providerId, {}, {
    runtimeProviderResolver: async (candidate) => new FixtureProvider(providerId, {
      text: {
        [sharedModel]: () => {
          invocations.push({ credentialId: candidate.credentialId, runtimeKey: candidate.runtimeKey });
          return `executed:${candidate.credentialId}`;
        },
      },
    }),
  });

  const resultA = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    scopeId: scopeA,
    prompt: "classify",
  });
  assert.equal(resultA.ok, true);
  assert.equal(resultA.decision?.credentialId, credentialA.id);
  assert.equal(resultA.content, `executed:${credentialA.id}`);

  const resultB = await router.execute({
    taskType: "classification",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    scopeId: scopeB,
    prompt: "classify",
  });
  assert.equal(resultB.ok, true);
  assert.equal(resultB.decision?.credentialId, credentialB.id);
  assert.equal(resultB.content, `executed:${credentialB.id}`);
  assert.deepEqual(invocations.map((item) => item.credentialId), [credentialA.id, credentialB.id]);
  assert.equal(JSON.stringify(resultA.evidence).includes("encrypted-test-placeholder"), false);
  assert.equal(JSON.stringify(resultB.evidence).includes("encrypted-test-placeholder"), false);
});

test("Sprint 11 router: bounded fallback handles transient, auth, language, and attempt limits", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const primary = `generated-primary-${randomUUID()}`;
  const secondary = `generated-secondary-${randomUUID()}`;
  const authOnly = `generated-auth-${randomUUID()}`;

  await insertRuntimeModel(pool, {
    providerId,
    modelId: primary,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 95, latencyMs: 50 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: secondary,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 75, latencyMs: 120 }],
  });
  await insertRuntimeModel(pool, {
    providerId,
    modelId: authOnly,
    capabilities: ["text_generation"],
    validations: [{ capability: "text_generation", quality: 70, latencyMs: 130 }],
  });

  const transientRouter = routerFor(providerId, {
    text: {
      [primary]: [
        new AiProviderError("temporary outage", providerId, "TEMPORARY", true),
      ],
      [secondary]: "The fallback answer is ready.",
    },
  });

  const transient = await transientRouter.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "answer",
    maxFallbackAttempts: 1,
  });
  assert.equal(transient.ok, true);
  assert.equal(transient.decision?.modelId, primary);
  assert.equal(transient.content, "The fallback answer is ready.");
  assert.equal(transient.evidence.attempts.length, 2);

  const limitedRouter = routerFor(providerId, {
    text: {
      [primary]: new AiProviderError("temporary outage", providerId, "TEMPORARY", true),
      [secondary]: "The fallback answer is ready.",
    },
  });
  const limited = await limitedRouter.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "answer",
    maxFallbackAttempts: 0,
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.evidence.attempts.length, 1);

  const languageRouter = routerFor(providerId, {
    text: {
      [primary]: (request) => request.messages.some((message) => message.role === "system")
        ? "The corrected English answer is ready."
        : "这是中文输出，应当被英文目标拒绝。",
      [secondary]: "The fallback answer is ready.",
    },
  });
  const language = await languageRouter.execute({
    taskType: "language_generation",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    languagePolicy: { maxRetryAttempts: 1, minimumTextCharacters: 4 },
    prompt: "answer in English",
    maxFallbackAttempts: 2,
  });
  assert.equal(language.ok, true);
  assert.equal(language.content, "The corrected English answer is ready.");
  assert.equal(language.evidence.attempts.some((attempt) => attempt.errorCode === "LANGUAGE_MISMATCH"), true);

  const authRouter = routerFor(providerId, {
    text: { [authOnly]: new AiAuthenticationError(providerId) },
  });
  const auth = await authRouter.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: authOnly,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    prompt: "answer",
    maxFallbackAttempts: 0,
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.error?.code, "AUTHENTICATION_ERROR");
});

test("Sprint 11 router: language guard supports target language and protected short content", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const englishModel = `generated-english-${randomUUID()}`;
  const chineseModel = `generated-chinese-${randomUUID()}`;
  const spanishModel = `generated-spanish-${randomUUID()}`;
  const frenchModel = `generated-french-${randomUUID()}`;
  const shortModel = `generated-short-${randomUUID()}`;

  for (const modelId of [englishModel, chineseModel, spanishModel, frenchModel, shortModel]) {
    await insertRuntimeModel(pool, {
      providerId,
      modelId,
      capabilities: ["text_generation"],
      validations: [{ capability: "text_generation", quality: modelId === chineseModel ? 90 : 80, latencyMs: 100 }],
    });
  }
  const router = routerFor(providerId, {
    text: {
      [englishModel]: "This answer is clearly written in English.",
      [chineseModel]: "这是完全中文的回答，应该满足中文目标。",
      [spanishModel]: (request) => request.messages.some((message) => message.role === "system")
        ? "This corrected answer is clearly written in English."
        : "Esta respuesta esta claramente escrita en espanol para probar el idioma.",
      [frenchModel]: (request) => request.messages.some((message) => message.role === "system")
        ? "This corrected answer is clearly written in English."
        : "Cette reponse est clairement ecrite en francais pour tester la langue.",
      [shortModel]: "Use `API_URL` at https://example.test.",
    },
  });

  const english = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: englishModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    languagePolicy: { minimumTextCharacters: 4 },
    prompt: "answer",
  });
  assert.equal(english.ok, true);

  const chinese = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: chineseModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "zh",
    languagePolicy: { minimumTextCharacters: 4 },
    prompt: "answer",
  });
  assert.equal(chinese.ok, true);

  const spanishRejectedThenCorrected = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: spanishModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    languagePolicy: { minimumTextCharacters: 4, minimumConfidence: 0.45, maxRetryAttempts: 1 },
    prompt: "answer",
  });
  assert.equal(spanishRejectedThenCorrected.ok, true);
  assert.equal(spanishRejectedThenCorrected.evidence.attempts[0].languageGuard?.outputLanguage, "es");

  const frenchRejectedThenCorrected = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: frenchModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    languagePolicy: { minimumTextCharacters: 4, minimumConfidence: 0.45, maxRetryAttempts: 1 },
    prompt: "answer",
  });
  assert.equal(frenchRejectedThenCorrected.ok, true);
  assert.equal(frenchRejectedThenCorrected.evidence.attempts[0].languageGuard?.outputLanguage, "fr");

  const spanishTarget = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: spanishModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "es",
    languagePolicy: { minimumTextCharacters: 4, minimumConfidence: 0.45 },
    prompt: "answer",
  });
  assert.equal(spanishTarget.ok, true);

  const frenchTarget = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: frenchModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "fr",
    languagePolicy: { minimumTextCharacters: 4, minimumConfidence: 0.45 },
    prompt: "answer",
  });
  assert.equal(frenchTarget.ok, true);

  const noFallback = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: spanishModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    languagePolicy: { minimumTextCharacters: 4, minimumConfidence: 0.45, maxRetryAttempts: 0, allowFallback: false },
    prompt: "answer",
    maxFallbackAttempts: 2,
  });
  assert.equal(noFallback.ok, false);
  assert.equal(noFallback.status, "LANGUAGE_GUARD_FAILED");
  assert.equal(noFallback.evidence.attempts.length, 1);

  const protectedShort = await router.execute({
    taskType: "language_generation",
    preferredProviderId: providerId,
    preferredModelId: shortModel,
    mode: "CUSTOM",
    requiredCapability: "text_generation",
    tier: "TIER_1_EVERYDAY",
    targetLanguage: "en",
    prompt: "answer",
  });
  assert.equal(protectedShort.ok, true);
});

test("Sprint 11 router: malformed structured output fails and eligible fallback can recover", async () => {
  await runMigrations();
  const pool = getPool();
  const providerId = await insertProvider(pool);
  const missingModel = `generated-structured-missing-${randomUUID()}`;
  const primitiveModel = `generated-structured-primitive-${randomUUID()}`;
  const arrayModel = `generated-structured-array-${randomUUID()}`;
  const enumConstraintModel = `generated-structured-enum-${randomUUID()}`;
  const goodModel = `generated-structured-good-${randomUUID()}`;

  for (const [modelId, quality] of [
    [missingModel, 99],
    [primitiveModel, 98],
    [arrayModel, 97],
    [enumConstraintModel, 96],
  ]) {
    await insertRuntimeModel(pool, {
      providerId,
      modelId,
      capabilities: ["structured_output"],
      validations: [{ capability: "structured_output", quality, latencyMs: 50 }],
    });
  }
  await insertRuntimeModel(pool, {
    providerId,
    modelId: goodModel,
    capabilities: ["structured_output"],
    validations: [{ capability: "structured_output", quality: 80, latencyMs: 100 }],
  });
  const router = routerFor(providerId, {
    structured: {
      [missingModel]: { status: "ok" },
      [primitiveModel]: { status: "ok", profile: { name: 42, role: "member", tags: ["alpha"], score: 2 } },
      [arrayModel]: { status: "ok", profile: { name: "Ada", role: "member", tags: ["alpha", 7], score: 2 } },
      [enumConstraintModel]: { status: "ok", profile: { name: "Ada", role: "owner", tags: ["alpha"], score: 0 } },
      [goodModel]: { status: "ok", profile: { name: "Ada", role: "member", tags: ["alpha"], score: 2 } },
    },
  });

  const result = await router.execute({
    taskType: "semantic_extraction",
    tier: "TIER_1_EVERYDAY",
    structuredOutput: {
      required: true,
      schema: {
        type: "object",
        required: ["status", "profile"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          profile: {
            type: "object",
            required: ["name", "role", "tags", "score"],
            properties: {
              name: { type: "string", minLength: 2 },
              role: { type: "string", enum: ["admin", "member"] },
              tags: { type: "array", minItems: 1, items: { type: "string" } },
              score: { type: "number", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
    },
    prompt: "extract",
    maxFallbackAttempts: 4,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.structuredData, { status: "ok", profile: { name: "Ada", role: "member", tags: ["alpha"], score: 2 } });
  assert.equal(result.evidence.attempts.filter((attempt) => attempt.errorCode === "STRUCTURED_OUTPUT_INVALID").length, 4);
});
