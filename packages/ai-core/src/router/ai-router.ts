import type { ReasoningTier } from "@xlrrank/shared";
import type { AiCapability } from "../capabilities.js";
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
import { TIER_RANK } from "./reasoning-tiers.js";

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
  maxFallbackAttempts?: number;
  maxLatencyMs?: number;
  maxCostPer1kTokens?: number;
  lifecycleStages?: ModelLifecycleStage[];
}

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

export class AiRouter {
  constructor(
    private readonly registry: ModelRegistryService,
    private readonly gateway: AiGateway,
  ) {}

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
    const ranked = await this.rankEligibleCandidates(request);
    const capabilities = this.requiredCapabilities(request);
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const executionKind = this.executionKind(request);
    const maxAttempts = Math.max(1, 1 + (request.maxFallbackAttempts ?? 2));
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
            continue;
          }

          evidence.attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            credentialId: candidate.credentialId,
            runtimeKey: candidate.runtimeKey,
            outcome: "SUCCESS",
            ...(guardResult ? { languageGuard: guardResult } : {}),
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
    const capabilities = this.requiredCapabilities(request);
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
      .map((candidate) => ({ candidate, score: this.scoreCandidate(candidate, request, mode) }))
      .sort((a, b) => b.score - a.score);
  }

  private requiredCapabilities(request: RoutingRequest): AiCapability[] {
    const capabilities = new Set<AiCapability>();
    for (const capability of request.requiredCapabilities ?? []) capabilities.add(capability);
    if (request.requiredCapability) capabilities.add(request.requiredCapability);
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
    if (!provider || !["connected", "degraded"].includes(gatewayStatus ?? "")) return false;
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
  ): number {
    const tier = request.reasoningTier ?? request.tier ?? "TIER_1_EVERYDAY";
    const tierRank = TIER_RANK[tier] ?? 1;
    const quality = candidate.validationQuality ?? 50;
    const latency = candidate.validationLatencyMs;
    const latencyScore = latency === null ? 20 : Math.max(0, 35 - latency / 100);
    const hasReasoning = candidate.validations.some((item) => item.capability === "reasoning");
    const reasoningFit = tierRank >= 3 ? (hasReasoning ? 30 : -15) : (hasReasoning ? 5 : 10);
    const healthFit = candidate.providerStatus.toUpperCase() === "DEGRADED" ? 5 : 15;

    if (mode === "QUALITY_OPTIMIZED") {
      return quality * 1.5 + reasoningFit + healthFit + latencyScore * 0.3;
    }
    if (mode === "COST_OPTIMIZED") {
      return latencyScore * 1.5 + quality * 0.5 + healthFit + (tierRank <= 1 ? 10 : 0);
    }
    if (tierRank >= 3) {
      return quality * 1.25 + reasoningFit + healthFit + latencyScore * 0.4;
    }
    return latencyScore + quality * 0.75 + healthFit + reasoningFit;
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
  }> {
    const kind = this.executionKind(request);
    const messages = this.buildMessages(request, forceLanguageInstruction);
    if (kind === "structured") {
      const schema = request.structuredOutput?.schema;
      if (!schema) throw new Error("Structured output schema is required");
      const response = await this.gateway.generateStructured(candidate.providerId, {
        model: candidate.modelId,
        messages,
        schema,
        ...(request.structuredOutput?.schemaName ? { schemaName: request.structuredOutput.schemaName } : {}),
      });
      const schemaError = validateStructuredResponse(response.data, schema);
      if (schemaError) {
        throw new Error(`STRUCTURED_OUTPUT_INVALID:${schemaError}`);
      }
      return { structuredData: response.data, rawContent: response.rawContent, usage: response.usage };
    }
    if (kind === "embeddings") {
      const response = await this.gateway.generateEmbeddings(candidate.providerId, {
        model: candidate.modelId,
        input: request.embeddingInput ?? request.prompt ?? messages.map((message) => message.content).join("\n"),
      });
      return { embeddings: response.embeddings, usage: response.usage };
    }
    if (kind === "streaming") {
      let content = "";
      let usage: TextGenerationResponse["usage"] | undefined;
      for await (const chunk of this.gateway.streamText(candidate.providerId, { model: candidate.modelId, messages })) {
        content += chunk.delta;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.promptTokens ?? 0,
            completionTokens: chunk.usage.completionTokens ?? 0,
            totalTokens: chunk.usage.totalTokens ?? 0,
          };
        }
      }
      return { content, ...(usage ? { usage } : {}) };
    }
    const response = await this.gateway.generateText(candidate.providerId, {
      model: candidate.modelId,
      messages,
    });
    return { content: response.content, usage: response.usage };
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
}

function validateStructuredResponse(value: unknown, schema: Record<string, unknown>): string | undefined {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "expected object";
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in record)) return `missing required property '${key}'`;
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      const expected = propertySchema.type;
      if (expected === "array" && !Array.isArray(record[key])) return `property '${key}' expected array`;
      if (expected === "object" && (!record[key] || typeof record[key] !== "object" || Array.isArray(record[key]))) {
        return `property '${key}' expected object`;
      }
      if (typeof expected === "string" && !["array", "object"].includes(expected) && typeof record[key] !== expected) {
        return `property '${key}' expected ${expected}`;
      }
    }
  }
  return undefined;
}
