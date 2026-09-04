export type OpportunityType =
  | "conversation"
  | "relationship"
  | "commercial_intent"
  | "content_gap"
  | "trend"
  | "collaboration"
  | "investment"
  | "hiring"
  | "media";

export interface OpportunitySignal {
  freshness: number;
  semanticRelevance: number;
  networkValue: number;
  commercialRelevance: number;
  conversationSaturation: number;
  authorRelevance: number;
  interactionAccessibility: number;
  velocity: number;
  confidence: number;
}

export interface DetectedOpportunity {
  type: OpportunityType;
  title: string;
  description: string;
  score: number;
  signals: OpportunitySignal;
  recommendedAction: string;
  doNotEngage: boolean;
  doNotEngageReason?: string;
  evidence: string[];
  detectedAt: string;
}

const ACTION_MAP: Record<OpportunityType, string> = {
  conversation: "Join conversation",
  relationship: "Reconnect",
  commercial_intent: "Research",
  content_gap: "Post content",
  trend: "Join conversation",
  collaboration: "Follow",
  investment: "Research",
  hiring: "Follow",
  media: "Join conversation",
};

export function detectOpportunity(
  type: OpportunityType,
  signals: OpportunitySignal,
  context: { title?: string; description?: string; evidence?: string[] },
): DetectedOpportunity {
  const score = computeOpportunityScore(signals);

  let doNotEngage = false;
  let doNotEngageReason: string | undefined;

  if (signals.conversationSaturation > 80) {
    doNotEngage = true;
    doNotEngageReason = "Oversaturated conversation";
  } else if (signals.freshness < 10) {
    doNotEngage = true;
    doNotEngageReason = "Stale conversation";
  } else if (signals.semanticRelevance < 20) {
    doNotEngage = true;
    doNotEngageReason = "Low relevance";
  } else if (signals.networkValue < 15) {
    doNotEngage = true;
    doNotEngageReason = "Low strategic fit";
  }

  const result: DetectedOpportunity = {
    type,
    title: context.title ?? `${type} opportunity`,
    description: context.description ?? `A ${type} opportunity detected.`,
    score: doNotEngage ? Math.round(score * 0.3) : score,
    signals,
    recommendedAction: doNotEngage ? "Ignore" : (ACTION_MAP[type] ?? "Research"),
    doNotEngage,
    evidence: context.evidence ?? [],
    detectedAt: new Date().toISOString(),
  };
  if (doNotEngageReason) result.doNotEngageReason = doNotEngageReason;
  return result;
}

function computeOpportunityScore(signals: OpportunitySignal): number {
  const weights = {
    freshness: 0.15,
    semanticRelevance: 0.2,
    networkValue: 0.15,
    commercialRelevance: 0.15,
    conversationSaturation: 0.05,
    authorRelevance: 0.1,
    interactionAccessibility: 0.1,
    velocity: 0.05,
    confidence: 0.05,
  };

  let score = 0;
  score += signals.freshness * weights.freshness;
  score += signals.semanticRelevance * weights.semanticRelevance;
  score += signals.networkValue * weights.networkValue;
  score += signals.commercialRelevance * weights.commercialRelevance;
  score += (100 - signals.conversationSaturation) * weights.conversationSaturation;
  score += signals.authorRelevance * weights.authorRelevance;
  score += signals.interactionAccessibility * weights.interactionAccessibility;
  score += signals.velocity * weights.velocity;
  score += signals.confidence * weights.confidence;

  return Math.round(Math.min(100, Math.max(0, score)));
}

export function rankOpportunities(opportunities: DetectedOpportunity[]): DetectedOpportunity[] {
  return [...opportunities].sort((a, b) => b.score - a.score);
}
