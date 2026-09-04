import type { ReasoningTier } from "@xlrrank/shared";
import type { AiCapability } from "../capabilities.js";
import type { ModelRegistryEntry } from "../registry/types.js";
import type { ModelRegistryService } from "../registry/model-registry.js";
import type { AiGateway } from "../gateway.js";
import { TIER_RANK } from "./reasoning-tiers.js";

export type RoutingMode = "AUTOMATIC" | "QUALITY_OPTIMIZED" | "COST_OPTIMIZED" | "CUSTOM";

export interface RoutingRequest {
  taskType: string;
  requiredCapability: AiCapability;
  tier: ReasoningTier;
  mode?: RoutingMode;
  preferredProviderId?: string;
  preferredModelId?: string;
  maxLatencyMs?: number;
  maxCostPer1kTokens?: number;
}

export interface RoutingDecision {
  providerId: string;
  modelId: string;
  tier: ReasoningTier;
  mode: RoutingMode;
  rationale: string;
  fallbacks: Array<{ providerId: string; modelId: string }>;
}

export class AiRouter {
  constructor(
    private readonly registry: ModelRegistryService,
    private readonly gateway: AiGateway,
  ) {}

  route(request: RoutingRequest): RoutingDecision {
    const mode = request.mode ?? "AUTOMATIC";

    if (mode === "CUSTOM" && request.preferredProviderId && request.preferredModelId) {
      return {
        providerId: request.preferredProviderId,
        modelId: request.preferredModelId,
        tier: request.tier,
        mode,
        rationale: "User-configured preference",
        fallbacks: [],
      };
    }

    const candidates = this.findCandidates(request);
    if (candidates.length === 0) {
      return this.fallbackDecision(request);
    }

    const ranked = this.rankCandidates(candidates, request, mode);
    const best = ranked[0]!;
    const fallbacks = ranked.slice(1, 3).map((c) => ({
      providerId: c.providerId,
      modelId: c.modelId,
    }));

    return {
      providerId: best.providerId,
      modelId: best.modelId,
      tier: request.tier,
      mode,
      rationale: this.explainChoice(best, request, mode),
      fallbacks,
    };
  }

  private findCandidates(request: RoutingRequest): ModelRegistryEntry[] {
    const models = this.registry.list({ lifecycleStage: "ACTIVE" });
    return models.filter((m) => {
      const provider = this.gateway.getProvider(m.providerId);
      if (!provider || provider.getStatus() !== "connected") return false;
      return m.capabilities.includes(request.requiredCapability);
    });
  }

  private rankCandidates(
    candidates: ModelRegistryEntry[],
    request: RoutingRequest,
    mode: RoutingMode,
  ): ModelRegistryEntry[] {
    return [...candidates].sort((a, b) => {
      const scoreA = this.scoreCandidate(a, request, mode);
      const scoreB = this.scoreCandidate(b, request, mode);
      return scoreB - scoreA;
    });
  }

  private scoreCandidate(
    model: ModelRegistryEntry,
    request: RoutingRequest,
    mode: RoutingMode,
  ): number {
    let score = 0;

    const tierFit = this.tierFitness(model, request.tier);
    score += tierFit * 40;

    if (mode === "QUALITY_OPTIMIZED") {
      score += tierFit * 20;
    } else if (mode === "COST_OPTIMIZED") {
      if (model.pricing) {
        const cost = model.pricing.inputPer1k ?? 0;
        score += Math.max(0, 30 - cost * 100);
      } else {
        score += 15;
      }
    }

    if (model.health.healthy) score += 20;
    if (model.contextLimit && model.contextLimit >= 8192) score += 5;

    return score;
  }

  private tierFitness(model: ModelRegistryEntry, tier: ReasoningTier): number {
    const tierRank = TIER_RANK[tier] ?? 0;
    const hasReasoning = model.capabilities.includes("reasoning");
    if (tierRank >= 3 && hasReasoning) return 100;
    if (tierRank >= 3 && !hasReasoning) return 30;
    if (tierRank >= 1 && hasReasoning) return 80;
    return 70;
  }

  private explainChoice(
    model: ModelRegistryEntry,
    request: RoutingRequest,
    mode: RoutingMode,
  ): string {
    const parts: string[] = [];
    parts.push(`Selected ${model.displayName ?? model.modelId} for ${request.taskType}`);
    parts.push(`Tier: ${request.tier}`);
    parts.push(`Mode: ${mode}`);
    if (model.capabilities.includes("reasoning")) parts.push("Has reasoning capability");
    return parts.join(". ");
  }

  private fallbackDecision(request: RoutingRequest): RoutingDecision {
    const providers = this.gateway.listProviders();
    const healthy = providers.find((p) => p.status === "connected");
    if (healthy) {
      return {
        providerId: healthy.manifest.id,
        modelId: "default",
        tier: request.tier,
        mode: request.mode ?? "AUTOMATIC",
        rationale: "No ranked models available; falling back to first healthy provider",
        fallbacks: [],
      };
    }
    return {
      providerId: "none",
      modelId: "none",
      tier: request.tier,
      mode: request.mode ?? "AUTOMATIC",
      rationale: "No providers available",
      fallbacks: [],
    };
  }
}
