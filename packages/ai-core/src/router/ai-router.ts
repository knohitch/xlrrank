import { getEnv } from "@xlrrank/config";
import { REASONING_TIERS, type ReasoningTier } from "@xlrrank/shared";
import { AI_CAPABILITIES, type AiCapability } from "../capabilities.js";
import type { BaseAiProvider } from "../providers/base.js";
import type { AiMessage, EmbeddingResponse, StructuredResponse, TextGenerationResponse } from "../providers/types.js";
import type { ModelLifecycleStage } from "../registry/types.js";
import type { ModelRegistryService, RoutingModelCandidate } from "../registry/model-registry.js";
import type { AiGateway } from "../gateway.js";
import { AiProviderError } from "../providers/errors.js";
import {
  configureLanguagePolicy,
  languageGuard,
  type LanguageGuardResult,
  type LanguagePolicy,
  type SupportedLanguage,
} from "../language-guard.js";
import {
  AiExecutionGovernanceError,
  buildUsageAccounting,
  governedEmbeddingRequest,
  governedStructuredRequest,
  governedTextRequest,
  resolveAiExecutionLimits,
  type AiExecutionLimits,
  type AiUsageAccounting,
} from "../execution-governance.js";

export type RoutingMode = "AUTOMATIC" | "QUALITY_OPTIMIZED" | "COST_OPTIMIZED" | "CUSTOM";
export type RoutingExecutionKind = "text" | "structured" | "embeddings" | "streaming";
export type RoutingOutcomeStatus =
  | "SUCCEEDED"
  | "NO_ELIGIBLE_MODEL"
  | "PROVIDER_EXECUTION_FAILED"
  | "LANGUAGE_GUARD_FAILED"
  | "STRUCTURED_OUTPUT_FAILED";

export interface StructuredOutputRequirement {
  required?: boolean;
  schema: Record<string, unknown>;
  schemaName?: string;
}

export interface RoutingRequest {
  taskType: string;
  requiredCapability?: AiCapability;
  requiredCapabilities?: AiCapability[];
  tier?: ReasoningTier;
  reasoningTier?: ReasoningTier;
  mode?: RoutingMode;
  preferredProviderId?: string;
  preferredModelId?: string;
  scopeId?: string;
  credentialId?: string;
  targetLanguage?: SupportedLanguage;
  languagePolicy?: Partial<LanguagePolicy>;
  structuredOutput?: StructuredOutputRequirement;
  streaming?: boolean;
  vision?: boolean;
  embeddings?: boolean;
  embeddingInput?: string | string[];
  messages?: AiMessage[];
  prompt?: string;
  idempotencyKey?: string;
  maxOutputTokens?: number;
  maxFallbackAttempts?: number;
  maxLatencyMs?: number;
  maxCostPer1kTokens?: number;
  lifecycleStages?: ModelLifecycleStage[];
  routingPolicy?: Partial<RoutingPolicy>;
}

export interface RoutingModeWeights {
  quality: number;
  latency: number;
  health: number;
  capabilityPreference: number;
}

export interface RoutingPolicyTierRule {
  requiredCapabilities?: AiCapability[];
  preferredCapabilities?: Partial<Record<AiCapability, number>>;
  modeWeights?: Partial<Record<RoutingMode, Partial<RoutingModeWeights>>>;
}

export interface RoutingPolicy {
  maxFallbackAttempts: number;
  unknownQualityScore: number;
  unknownLatencyScore: number;
  latencyReferenceMs: number;
  healthScores: Record<"HEALTHY" | "DEGRADED" | "UNKNOWN", number>;
  defaultModeWeights: Record<RoutingMode, RoutingModeWeights>;
  tiers: Partial<Record<ReasoningTier, RoutingPolicyTierRule>>;
  executionLimits: AiExecutionLimits;
}

export type RuntimeProviderResolver = (candidate: RoutingModelCandidate) => Promise<BaseAiProvider>;
export type RoutingPolicyProvider = () => RoutingPolicy;

export interface RoutingDecision {
  providerId: string;
  modelId: string;
  tier: ReasoningTier;
  mode: RoutingMode;
  rationale: string;
  fallbacks: Array<{ providerId: string; modelId: string; credentialId?: string | null; runtimeKey?: string }>;
  credentialId?: string | null;
  runtimeKey?: string;
}

export interface RoutingAttemptEvidence {
  providerId: string;
  modelId: string;
  credentialId?: string | null;
  runtimeKey: string;
  outcome: "SUCCESS" | "FAILED";
  errorCode?: string;
  retryable?: boolean;
  languageGuard?: LanguageGuardResult;
  usage?: AiUsageAccounting;
}

export interface RoutingExecutionEvidence {
  requirements: {
    capabilities: AiCapability[];
    tier: ReasoningTier;
    targetLanguage?: SupportedLanguage;
    executionKind: RoutingExecutionKind;
    maxAttempts: number;
  };
  candidates: Array<{
    providerId: string;
    modelId: string;
    credentialId: string | null;
    runtimeKey: string;
    lifecycleStage: ModelLifecycleStage;
    score: number;
  }>;
  attempts: RoutingAttemptEvidence[];
}

export interface RoutingExecutionResult {
  ok: boolean;
  status: RoutingOutcomeStatus;
  decision?: RoutingDecision;
  content?: string;
  structuredData?: unknown;
  embeddings?: EmbeddingResponse["embeddings"];
  usage?: TextGenerationResponse["usage"] | StructuredResponse["usage"] | EmbeddingResponse["usage"];
  error?: { code: string; message: string };
  evidence: RoutingExecutionEvidence;
}

interface RankedCandidate {
  candidate: RoutingModelCandidate;
  score: number;
}

const ROUTING_MODES = ["AUTOMATIC", "QUALITY_OPTIMIZED", "COST_OPTIMIZED", "CUSTOM"] as const satisfies readonly RoutingMode[];
const ROUTING_MODE_SET = new Set<string>(ROUTING_MODES);
const ROUTING_CAPABILITY_SET = new Set<string>(AI_CAPABILITIES);
const ROUTING_TIER_SET = new Set<string>(REASONING_TIERS);

const STRUCTURAL_ROUTING_MODE_WEIGHTS: Record<RoutingMode, RoutingModeWeights> = {
  AUTOMATIC: { quality: 0, latency: 0, health: 0, capabilityPreference: 0 },
  QUALITY_OPTIMIZED: { quality: 0, latency: 0, health: 0, capabilityPreference: 0 },
  COST_OPTIMIZED: { quality: 0, latency: 0, health: 0, capabilityPreference: 0 },
  CUSTOM: { quality: 0, latency: 0, health: 0, capabilityPreference: 0 },
};

export const STRUCTURAL_ROUTING_POLICY: RoutingPolicy = {
  maxFallbackAttempts: 0,
  unknownQualityScore: 0,
  unknownLatencyScore: 0,
  latencyReferenceMs: 1,
  healthScores: {
    HEALTHY: 0,
    DEGRADED: 0,
    UNKNOWN: 0,
  },
  defaultModeWeights: STRUCTURAL_ROUTING_MODE_WEIGHTS,
  tiers: {},
  executionLimits: resolveAiExecutionLimits(),
};

export class AiRouter {
  private readonly runtimeProviderResolver: RuntimeProviderResolver;
  private readonly routingPolicy: RoutingPolicy;
  private readonly inflight = new Map<string, Promise<RoutingExecutionResult>>();

  constructor(
    private readonly registry: ModelRegistryService,
    private readonly gateway: AiGateway,
    options: {
      routingPolicy?: Partial<RoutingPolicy>;
      routingPolicyProvider?: RoutingPolicyProvider;
      runtimeProviderResolver?: RuntimeProviderResolver;
    } = {},
  ) {
    this.routingPolicy = options.routingPolicy
      ? resolveRoutingPolicy(options.routingPolicy)
      : options.routingPolicyProvider?.() ?? loadRoutingPolicyFromEnv();
    this.runtimeProviderResolver =
      options.runtimeProviderResolver ??
      ((candidate) => this.registry.createRuntimeProvider({
        providerId: candidate.providerId,
        credentialId: candidate.credentialId,
      }));
  }

  async route(request: RoutingRequest): Promise<RoutingDecision> {
    const ranked = await this.rankEligibleCandidates(request);
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const mode = request.mode ?? "AUTOMATIC";
    if (ranked.length === 0) {
      return {
        providerId: "none",
        modelId: "none",
        tier,
        mode,
        rationale: "No persisted runtime has the required availability, lifecycle, health, and capability validation evidence",
        fallbacks: [],
      };
    }
    return this.toDecision(ranked, request);
  }

  async execute(request: RoutingRequest): Promise<RoutingExecutionResult> {
    const policy = this.policyFor(request);
    const inflightKey = request.idempotencyKey ? this.inflightKey(request, policy) : undefined;
    if (inflightKey) {
      const existing = this.inflight.get(inflightKey);
      if (existing) return existing;
    }
    const execution = this.executeOnce(request, policy);
    if (!inflightKey) return execution;
    this.inflight.set(inflightKey, execution);
    try {
      return await execution;
    } finally {
      this.inflight.delete(inflightKey);
    }
  }

  private async executeOnce(request: RoutingRequest, policy: RoutingPolicy): Promise<RoutingExecutionResult> {
    const ranked = await this.rankEligibleCandidates(request);
    const capabilities = this.requiredCapabilities(request, policy);
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const executionKind = this.executionKind(request);
    const requestedAttempts = Math.max(1, 1 + (request.maxFallbackAttempts ?? policy.maxFallbackAttempts));
    const maxAttempts = Math.min(requestedAttempts, policy.executionLimits.maxModelInvocations);
    const evidence: RoutingExecutionEvidence = {
      requirements: {
        capabilities,
        tier,
        ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
        executionKind,
        maxAttempts,
      },
      candidates: ranked.map(({ candidate, score }) => ({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        credentialId: candidate.credentialId,
        runtimeKey: candidate.runtimeKey,
        lifecycleStage: candidate.lifecycleStage,
        score,
      })),
      attempts: [],
    };

    if (ranked.length === 0) {
      return {
        ok: false,
        status: "NO_ELIGIBLE_MODEL",
        error: { code: "NO_ELIGIBLE_MODEL", message: "No eligible AI runtime matched the task requirements" },
        evidence,
      };
    }

    const decision = this.toDecision(ranked, request);
    let lastError: { status: RoutingOutcomeStatus; code: string; message: string } | undefined;
    let attempts = 0;

    for (const { candidate } of ranked) {
      let languageRetries = 0;
      do {
        if (attempts >= maxAttempts) break;
        attempts += 1;
        try {
          const result = await this.executeCandidate(candidate, request, languageRetries > 0);
          const guardResult = this.checkLanguage(result.content ?? result.rawContent ?? "", request);
          if (guardResult && !guardResult.passed) {
            evidence.attempts.push({
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              credentialId: candidate.credentialId,
              runtimeKey: candidate.runtimeKey,
              outcome: "FAILED",
              errorCode: "LANGUAGE_MISMATCH",
              retryable: languageRetries < (request.languagePolicy?.maxRetryAttempts ?? 1),
              languageGuard: guardResult,
            });
            lastError = {
              status: "LANGUAGE_GUARD_FAILED",
              code: "LANGUAGE_MISMATCH",
              message: "Model output did not satisfy the configured target language policy",
            };
            languageRetries += 1;
            if (languageRetries > (request.languagePolicy?.maxRetryAttempts ?? 1) && request.languagePolicy?.allowFallback === false) {
              return {
                ok: false,
                status: "LANGUAGE_GUARD_FAILED",
                decision,
                error: lastError,
                evidence,
              };
            }
            continue;
          }

          evidence.attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            credentialId: candidate.credentialId,
            runtimeKey: candidate.runtimeKey,
            outcome: "SUCCESS",
            ...(guardResult ? { languageGuard: guardResult } : {}),
            ...(result.usageAccounting ? { usage: result.usageAccounting } : {}),
          });
          return {
            ok: true,
            status: "SUCCEEDED",
            decision,
            ...(result.content !== undefined ? { content: result.content } : {}),
            ...(result.structuredData !== undefined ? { structuredData: result.structuredData } : {}),
            ...(result.embeddings !== undefined ? { embeddings: result.embeddings } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            evidence,
          };
        } catch (err) {
          const classified = this.classifyError(err);
          evidence.attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            credentialId: candidate.credentialId,
            runtimeKey: candidate.runtimeKey,
            outcome: "FAILED",
            errorCode: classified.code,
            retryable: classified.retryable,
          });
          lastError = {
            status: classified.status,
            code: classified.code,
            message: classified.message,
          };
          if (!classified.retryable) {
            return {
              ok: false,
              status: classified.status,
              decision,
              error: {
                code: classified.code,
                message: classified.message,
              },
              evidence,
            };
          }
          break;
        }
      } while (languageRetries <= (request.languagePolicy?.maxRetryAttempts ?? 1));
    }

    return {
      ok: false,
      status: lastError?.status ?? "PROVIDER_EXECUTION_FAILED",
      decision,
      error: {
        code: lastError?.code ?? "PROVIDER_EXECUTION_FAILED",
        message: lastError?.message ?? "Eligible AI runtimes failed to complete the task",
      },
      evidence,
    };
  }

  private async rankEligibleCandidates(request: RoutingRequest): Promise<RankedCandidate[]> {
    const mode = request.mode ?? "AUTOMATIC";
    const policy = this.policyFor(request);
    const capabilities = this.requiredCapabilities(request, policy);
    const query = {
      capabilities,
      lifecycleStages: request.lifecycleStages ?? ["VALIDATED", "ACTIVE"],
      ...(request.preferredProviderId && mode === "CUSTOM" ? { providerId: request.preferredProviderId } : {}),
      ...(request.credentialId ? { credentialId: request.credentialId } : {}),
      ...(request.scopeId ? { scopeId: request.scopeId } : {}),
    };
    const candidates = await this.registry.listRoutingCandidates(query);
    const eligible = candidates.filter((candidate) => this.isRuntimeHealthy(candidate));
    const customFiltered =
      mode === "CUSTOM" && request.preferredModelId
        ? eligible.filter((candidate) => candidate.modelId === request.preferredModelId)
        : eligible;
    return customFiltered
      .map((candidate) => ({ candidate, score: this.scoreCandidate(candidate, request, mode, policy) }))
      .sort((a, b) => b.score - a.score);
  }

  private requiredCapabilities(request: RoutingRequest, policy = this.policyFor(request)): AiCapability[] {
    const capabilities = new Set<AiCapability>();
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    for (const capability of request.requiredCapabilities ?? []) capabilities.add(capability);
    if (request.requiredCapability) capabilities.add(request.requiredCapability);
    for (const capability of policy.tiers[tier]?.requiredCapabilities ?? []) capabilities.add(capability);
    if (request.structuredOutput?.required || request.structuredOutput?.schema) capabilities.add("structured_output");
    if (request.streaming) capabilities.add("streaming");
    if (request.vision) capabilities.add("vision");
    if (request.embeddings || request.embeddingInput !== undefined) capabilities.add("embeddings");
    if (capabilities.size === 0) capabilities.add("text_generation");
    return [...capabilities];
  }

  private executionKind(request: RoutingRequest): RoutingExecutionKind {
    if (request.structuredOutput?.required || request.structuredOutput?.schema) return "structured";
    if (request.embeddings || request.embeddingInput !== undefined) return "embeddings";
    if (request.streaming) return "streaming";
    return "text";
  }

  private isRuntimeHealthy(candidate: RoutingModelCandidate): boolean {
    const provider = this.gateway.getProvider(candidate.providerId);
    const gatewayStatus = provider?.getStatus();
    if (this.gateway.listProviders().length > 0 && !provider) return false;
    if (provider && !["connected", "degraded"].includes(gatewayStatus ?? "")) return false;
    if (candidate.availabilityStatus !== "AVAILABLE") return false;
    if (!["VALIDATED", "ACTIVE"].includes(candidate.lifecycleStage)) return false;
    const providerStatus = candidate.providerStatus.toUpperCase();
    if (["AUTHENTICATION_FAILED", "TEMPORARILY_UNAVAILABLE", "CONFIGURATION_MISSING"].includes(providerStatus)) {
      return false;
    }
    const credentialStatus = candidate.credentialStatus?.toUpperCase();
    if (credentialStatus && ["AUTHENTICATION_FAILED", "TEMPORARILY_UNAVAILABLE", "CONFIGURATION_MISSING"].includes(credentialStatus)) {
      return false;
    }
    return true;
  }

  private scoreCandidate(
    candidate: RoutingModelCandidate,
    request: RoutingRequest,
    mode: RoutingMode,
    policy: RoutingPolicy,
  ): number {
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const quality = candidate.validationQuality ?? policy.unknownQualityScore;
    const latency = candidate.validationLatencyMs;
    const latencyScore = latency === null
      ? policy.unknownLatencyScore
      : Math.max(0, ((policy.latencyReferenceMs - latency) / policy.latencyReferenceMs) * 100);
    const healthKey = candidate.providerStatus.toUpperCase() === "DEGRADED" ? "DEGRADED" : "HEALTHY";
    const healthScore = policy.healthScores[healthKey] ?? policy.healthScores.UNKNOWN;
    const tierRule = policy.tiers[tier] ?? {};
    const weights = {
      ...policy.defaultModeWeights[mode],
      ...tierRule.modeWeights?.[mode],
    };
    const validatedCapabilities = new Set(candidate.validations.map((item) => item.capability));
    const capabilityPreference = Object.entries(tierRule.preferredCapabilities ?? {}).reduce((score, [capability, value]) => {
      return validatedCapabilities.has(capability as AiCapability) ? score + (value ?? 0) : score;
    }, 0);

    return (
      quality * weights.quality +
      latencyScore * weights.latency +
      healthScore * weights.health +
      capabilityPreference * weights.capabilityPreference
    );
  }

  private toDecision(ranked: RankedCandidate[], request: RoutingRequest): RoutingDecision {
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const mode = request.mode ?? "AUTOMATIC";
    const best = ranked[0]!.candidate;
    return {
      providerId: best.providerId,
      modelId: best.modelId,
      credentialId: best.credentialId,
      runtimeKey: best.runtimeKey,
      tier,
      mode,
      rationale: `Selected persisted ${best.lifecycleStage} runtime with validated ${this.requiredCapabilities(request).join(", ")} capability evidence`,
      fallbacks: ranked.slice(1, 4).map(({ candidate }) => ({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        credentialId: candidate.credentialId,
        runtimeKey: candidate.runtimeKey,
      })),
    };
  }

  private buildMessages(request: RoutingRequest, forceLanguageInstruction: boolean): AiMessage[] {
    const messages = request.messages ?? [{ role: "user" as const, content: request.prompt ?? "" }];
    if (!forceLanguageInstruction || !request.targetLanguage) return messages;
    return [
      {
        role: "system",
        content: `Respond only in the target language '${request.targetLanguage}'. Do not switch languages except for code, URLs, proper nouns, or quoted source text.`,
      },
      ...messages,
    ];
  }

  private async executeCandidate(
    candidate: RoutingModelCandidate,
    request: RoutingRequest,
    forceLanguageInstruction: boolean,
  ): Promise<{
    content?: string;
    rawContent?: string;
    structuredData?: unknown;
    embeddings?: EmbeddingResponse["embeddings"];
    usage?: TextGenerationResponse["usage"] | StructuredResponse["usage"] | EmbeddingResponse["usage"];
    usageAccounting?: AiUsageAccounting;
  }> {
    const kind = this.executionKind(request);
    const messages = this.buildMessages(request, forceLanguageInstruction);
    const provider = await this.runtimeProviderResolver(candidate);
    const policy = this.policyFor(request);
    const outputLimit = request.maxOutputTokens ?? policy.executionLimits.maxOutputTokens;
    if (kind === "structured") {
      const schema = request.structuredOutput?.schema;
      if (!schema) throw new Error("Structured output schema is required");
      const governedRequest = governedStructuredRequest({
        model: candidate.modelId,
        messages,
        schema,
        maxTokens: outputLimit,
        ...(request.structuredOutput?.schemaName ? { schemaName: request.structuredOutput.schemaName } : {}),
      }, policy.executionLimits);
      const response = await provider.generateStructured(governedRequest);
      const schemaError = validateStructuredResponse(response.data, schema);
      if (schemaError) {
        throw new Error(`STRUCTURED_OUTPUT_INVALID:${schemaError}`);
      }
      return {
        structuredData: response.data,
        rawContent: response.rawContent,
        usage: response.usage,
        usageAccounting: buildUsageAccounting({ usage: response.usage, messages, outputTokenLimit: governedRequest.maxTokens }),
      };
    }
    if (kind === "embeddings") {
      const input = request.embeddingInput ?? request.prompt ?? messages.map((message) => message.content).join("\n");
      const governedRequest = governedEmbeddingRequest({
        model: candidate.modelId,
        input,
      }, policy.executionLimits);
      const response = await provider.generateEmbeddings(governedRequest);
      return {
        embeddings: response.embeddings,
        usage: response.usage,
        usageAccounting: buildUsageAccounting({ usage: response.usage, embeddingInput: input }),
      };
    }
    if (kind === "streaming") {
      let content = "";
      let usage: TextGenerationResponse["usage"] | undefined;
      const governedRequest = governedTextRequest({ model: candidate.modelId, messages, maxTokens: outputLimit }, policy.executionLimits);
      for await (const chunk of provider.streamText(governedRequest)) {
        content += chunk.delta;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.promptTokens ?? 0,
            completionTokens: chunk.usage.completionTokens ?? 0,
            totalTokens: chunk.usage.totalTokens ?? 0,
          };
        }
      }
      return {
        content,
        ...(usage ? { usage } : {}),
        usageAccounting: buildUsageAccounting({ usage, messages, outputTokenLimit: governedRequest.maxTokens }),
      };
    }
    const governedRequest = governedTextRequest({
      model: candidate.modelId,
      messages,
      maxTokens: outputLimit,
    }, policy.executionLimits);
    const response = await provider.generateText(governedRequest);
    return {
      content: response.content,
      usage: response.usage,
      usageAccounting: buildUsageAccounting({ usage: response.usage, messages, outputTokenLimit: governedRequest.maxTokens }),
    };
  }

  private checkLanguage(content: string, request: RoutingRequest): LanguageGuardResult | undefined {
    if (!request.targetLanguage || !content.trim()) return undefined;
    const policy = configureLanguagePolicy({
      ...request.languagePolicy,
      targetLanguage: request.targetLanguage,
      allowedLanguages: request.languagePolicy?.allowedLanguages ?? [request.targetLanguage],
    });
    return languageGuard(content, policy);
  }

  private classifyError(err: unknown): { status: RoutingOutcomeStatus; code: string; message: string; retryable: boolean } {
    if (err instanceof AiExecutionGovernanceError) {
      return {
        status: "PROVIDER_EXECUTION_FAILED",
        code: err.code,
        message: err.message,
        retryable: false,
      };
    }
    if (err instanceof AiProviderError) {
      return {
        status: "PROVIDER_EXECUTION_FAILED",
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      };
    }
    const message = err instanceof Error ? err.message : "Unknown AI routing failure";
    if (message.startsWith("STRUCTURED_OUTPUT_INVALID:")) {
      return {
        status: "STRUCTURED_OUTPUT_FAILED",
        code: "STRUCTURED_OUTPUT_INVALID",
        message: message.replace("STRUCTURED_OUTPUT_INVALID:", ""),
        retryable: true,
      };
    }
    return {
      status: "PROVIDER_EXECUTION_FAILED",
      code: "PROVIDER_EXECUTION_FAILED",
      message,
      retryable: true,
    };
  }

  private policyFor(request: RoutingRequest): RoutingPolicy {
    return request.routingPolicy ? resolveRoutingPolicy(request.routingPolicy, this.routingPolicy) : this.routingPolicy;
  }

  private inflightKey(request: RoutingRequest, policy: RoutingPolicy): string {
    return `${request.idempotencyKey}:${stableStringify({ request: { ...request, idempotencyKey: undefined }, policy })}`;
  }
}

export function loadRoutingPolicyFromEnv(): RoutingPolicy {
  const raw = process.env.AI_ROUTING_POLICY_JSON ?? getEnv().AI_ROUTING_POLICY_JSON;
  if (!raw) return STRUCTURAL_ROUTING_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI_ROUTING_POLICY_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_ROUTING_POLICY_JSON must be a JSON object");
  }
  return resolveRoutingPolicy(parsed as Partial<RoutingPolicy>);
}

export function resolveRoutingPolicy(
  override: Partial<RoutingPolicy> = {},
  base: RoutingPolicy = STRUCTURAL_ROUTING_POLICY,
): RoutingPolicy {
  return validateRoutingPolicy(mergeRoutingPolicy(base, override));
}

export function validateRoutingPolicy(policy: RoutingPolicy): RoutingPolicy {
  assertNonnegativeInteger(policy.maxFallbackAttempts, "maxFallbackAttempts");
  assertFiniteNumber(policy.unknownQualityScore, "unknownQualityScore");
  assertFiniteNumber(policy.unknownLatencyScore, "unknownLatencyScore");
  assertPositiveFiniteNumber(policy.latencyReferenceMs, "latencyReferenceMs");

  for (const key of ["HEALTHY", "DEGRADED", "UNKNOWN"] as const) {
    assertFiniteNumber(policy.healthScores[key], `healthScores.${key}`);
  }
  for (const [mode, weights] of Object.entries(policy.defaultModeWeights)) {
    if (!ROUTING_MODE_SET.has(mode)) throw new Error(`Unsupported routing mode '${mode}'`);
    validateWeights(weights, `defaultModeWeights.${mode}`);
  }
  for (const mode of ROUTING_MODES) {
    validateWeights(policy.defaultModeWeights[mode], `defaultModeWeights.${mode}`);
  }
  for (const [tier, rule] of Object.entries(policy.tiers)) {
    if (!ROUTING_TIER_SET.has(tier)) throw new Error(`Unsupported routing tier '${tier}'`);
    for (const capability of rule?.requiredCapabilities ?? []) {
      if (!ROUTING_CAPABILITY_SET.has(capability)) throw new Error(`Unsupported required capability '${capability}'`);
    }
    for (const [capability, value] of Object.entries(rule?.preferredCapabilities ?? {})) {
      if (!ROUTING_CAPABILITY_SET.has(capability)) throw new Error(`Unsupported preferred capability '${capability}'`);
      assertFiniteNumber(value, `tiers.${tier}.preferredCapabilities.${capability}`);
    }
    for (const [mode, weights] of Object.entries(rule?.modeWeights ?? {})) {
      if (!ROUTING_MODE_SET.has(mode)) throw new Error(`Unsupported routing mode '${mode}'`);
      validatePartialWeights(weights, `tiers.${tier}.modeWeights.${mode}`);
    }
  }
  validateAiExecutionLimitsForRouting(policy.executionLimits);
  return policy;
}

function mergeRoutingPolicy(base: RoutingPolicy, override: Partial<RoutingPolicy> = {}): RoutingPolicy {
  const defaultModeWeights = { ...base.defaultModeWeights };
  for (const mode of Object.keys(override.defaultModeWeights ?? {}) as RoutingMode[]) {
    defaultModeWeights[mode] = {
      ...defaultModeWeights[mode],
      ...override.defaultModeWeights?.[mode],
    };
  }
  const tiers: RoutingPolicy["tiers"] = { ...base.tiers };
  for (const [tier, rule] of Object.entries(override.tiers ?? {}) as Array<[ReasoningTier, RoutingPolicyTierRule]>) {
    const existing = tiers[tier] ?? {};
    const modeWeights = { ...(existing.modeWeights ?? {}) };
    for (const mode of Object.keys(rule.modeWeights ?? {}) as RoutingMode[]) {
      modeWeights[mode] = {
        ...(modeWeights[mode] ?? {}),
        ...rule.modeWeights?.[mode],
      };
    }
    tiers[tier] = {
      ...existing,
      ...rule,
      preferredCapabilities: {
        ...(existing.preferredCapabilities ?? {}),
        ...(rule.preferredCapabilities ?? {}),
      },
      modeWeights,
    };
  }
  return {
    ...base,
    ...override,
    healthScores: {
      ...base.healthScores,
      ...(override.healthScores ?? {}),
    },
    defaultModeWeights,
    tiers,
    executionLimits: resolveAiExecutionLimits(override.executionLimits, base.executionLimits),
  };
}

function validateWeights(weights: RoutingModeWeights, path: string): void {
  for (const key of ["quality", "latency", "health", "capabilityPreference"] as const) {
    assertFiniteNumber(weights[key], `${path}.${key}`);
  }
}

function validatePartialWeights(weights: Partial<RoutingModeWeights>, path: string): void {
  for (const [key, value] of Object.entries(weights)) {
    if (!["quality", "latency", "health", "capabilityPreference"].includes(key)) {
      throw new Error(`Unsupported routing weight '${path}.${key}'`);
    }
    assertFiniteNumber(value, `${path}.${key}`);
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Routing policy value '${path}' must be finite`);
  }
}

function assertPositiveFiniteNumber(value: unknown, path: string): asserts value is number {
  assertFiniteNumber(value, path);
  if (value <= 0) throw new Error(`Routing policy value '${path}' must be positive`);
}

function assertNonnegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Routing policy value '${path}' must be a nonnegative integer`);
  }
}

function validateAiExecutionLimitsForRouting(limits: AiExecutionLimits): void {
  try {
    resolveAiExecutionLimits(limits);
  } catch (err) {
    throw new Error(`Routing policy executionLimits invalid: ${(err as Error).message}`);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function validateStructuredResponse(value: unknown, schema: Record<string, unknown>): string | undefined {
  return validateJsonSchemaValue(value, schema, "$");
}

function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): string | undefined {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqualJson(item, value))) {
    return `${path} must match an allowed enum value`;
  }
  if ("const" in schema && !deepEqualJson(schema.const, value)) {
    return `${path} must match const value`;
  }
  const expectedTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => jsonTypeMatches(value, type))) {
    return `${path} expected ${expectedTypes.join(" or ")}`;
  }
  if (value === null || value === undefined) return undefined;

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in record)) return `${path}.${key} is required`;
    }
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in record)) continue;
      const error = validateJsonSchemaValue(record[key], propertySchema, `${path}.${key}`);
      if (error) return error;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      const unexpected = Object.keys(record).find((key) => !allowed.has(key));
      if (unexpected) return `${path}.${unexpected} is not allowed`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchemaValue(value[index], schema.items as Record<string, unknown>, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is shorter than ${schema.minLength}`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength}`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern`;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is less than ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is greater than ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} must be greater than ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} must be less than ${schema.exclusiveMaximum}`;
  }
  return undefined;
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
