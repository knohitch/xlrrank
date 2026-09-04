import type { ReasoningTier } from "@xlrrank/shared";
import { TIER_RANK } from "./reasoning-tiers.js";

export interface ComplexitySignal {
  entityCount: number;
  inputSizeTokens: number;
  relationshipCount: number;
  ambiguityLevel: number;
  conflictingEvidence: boolean;
  crossPlatformBreadth: number;
  requestedDepth: "shallow" | "normal" | "deep";
}

export interface ComplexityEstimate {
  defaultTier: ReasoningTier;
  estimatedTier: ReasoningTier;
  escalated: boolean;
  signals: ComplexitySignal;
  score: number;
}

export function estimateComplexity(
  defaultTier: ReasoningTier,
  signals: ComplexitySignal,
): ComplexityEstimate {
  let score = (TIER_RANK[defaultTier] ?? 0) * 20;

  if (signals.entityCount > 50) score += 15;
  else if (signals.entityCount > 20) score += 8;
  else if (signals.entityCount > 10) score += 3;

  if (signals.inputSizeTokens > 8000) score += 15;
  else if (signals.inputSizeTokens > 4000) score += 8;
  else if (signals.inputSizeTokens > 2000) score += 3;

  if (signals.relationshipCount > 100) score += 12;
  else if (signals.relationshipCount > 30) score += 6;

  score += signals.ambiguityLevel * 10;

  if (signals.conflictingEvidence) score += 10;

  score += signals.crossPlatformBreadth * 5;

  if (signals.requestedDepth === "deep") score += 15;
  else if (signals.requestedDepth === "shallow") score -= 5;

  let estimatedTier: ReasoningTier;
  if (score < 20) estimatedTier = "TIER_0_UTILITY";
  else if (score < 40) estimatedTier = "TIER_1_EVERYDAY";
  else if (score < 60) estimatedTier = "TIER_2_ADVANCED";
  else if (score < 80) estimatedTier = "TIER_3_DEEP_INTELLIGENCE";
  else estimatedTier = "TIER_4_CRITICAL";

  const escalated = (TIER_RANK[estimatedTier] ?? 0) > (TIER_RANK[defaultTier] ?? 0);

  return { defaultTier, estimatedTier, escalated, signals, score };
}
