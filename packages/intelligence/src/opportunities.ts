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

export type SignalValue = number | "UNKNOWN" | null | undefined;

export interface OpportunitySignal {
  freshness: SignalValue;
  semanticRelevance: SignalValue;
  networkValue: SignalValue;
  commercialRelevance: SignalValue;
  conversationSaturation: SignalValue;
  authorRelevance: SignalValue;
  interactionAccessibility: SignalValue;
  velocity: SignalValue;
  confidence: SignalValue;
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
  policy?: { key: string; version: string };
  provenance: {
    sourceIdentity?: string;
    evaluationTimestamp: string;
    freshnessWindowMs?: number;
    unknownSignals: string[];
  };
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
  context: {
    title?: string;
    description?: string;
    evidence?: string[];
    evaluationTimestamp?: string;
    signalObservedAt?: string;
    freshnessWindowMs?: number;
    policy?: { key: string; version: string };
    sourceIdentity?: string;
    excluded?: boolean;
    exclusionReason?: string;
  },
): DetectedOpportunity {
  const evaluationTime = parseTimestamp(
    context.evaluationTimestamp ?? new Date().toISOString(),
    "evaluationTimestamp",
  );
  if (context.signalObservedAt) {
    const observedTime = parseTimestamp(context.signalObservedAt, "signalObservedAt");
    if (observedTime.getTime() > evaluationTime.getTime()) {
      throw new Error("signalObservedAt cannot be after evaluationTimestamp");
    }
    if (
      context.freshnessWindowMs !== undefined &&
      evaluationTime.getTime() - observedTime.getTime() > context.freshnessWindowMs
    ) {
      return staleOpportunity(type, signals, context, evaluationTime);
    }
  }

  const normalized = normalizeSignals(signals);
  const score = computeOpportunityScore(normalized.values);

  let doNotEngage = false;
  let doNotEngageReason: string | undefined;

  if (context.excluded) {
    doNotEngage = true;
    doNotEngageReason = context.exclusionReason ?? "Excluded by active policy";
  } else if (normalized.unknownSignals.length > 0) {
    doNotEngage = true;
    doNotEngageReason = `Unknown required signals: ${normalized.unknownSignals.join(", ")}`;
  } else if (normalized.values.confidence < 20) {
    doNotEngage = true;
    doNotEngageReason = "Weak evidence";
  } else if (normalized.values.conversationSaturation > 80) {
    doNotEngage = true;
    doNotEngageReason = "Oversaturated conversation";
  } else if (normalized.values.freshness < 10) {
    doNotEngage = true;
    doNotEngageReason = "Stale conversation";
  } else if (normalized.values.semanticRelevance < 20) {
    doNotEngage = true;
    doNotEngageReason = "Low relevance";
  } else if (normalized.values.networkValue < 15) {
    doNotEngage = true;
    doNotEngageReason = "Low strategic fit";
  }

  const result: DetectedOpportunity = {
    type,
    title: context.title ?? `${type} opportunity`,
    description: context.description ?? `A ${type} opportunity detected.`,
    score: doNotEngage ? Math.round(score * 0.3) : score,
    signals: normalized.values,
    recommendedAction: doNotEngage ? "Ignore" : (ACTION_MAP[type] ?? "Research"),
    doNotEngage,
    evidence: context.evidence ?? [],
    detectedAt: evaluationTime.toISOString(),
    provenance: {
      ...(context.sourceIdentity ? { sourceIdentity: context.sourceIdentity } : {}),
      evaluationTimestamp: evaluationTime.toISOString(),
      ...(context.freshnessWindowMs !== undefined
        ? { freshnessWindowMs: context.freshnessWindowMs }
        : {}),
      unknownSignals: normalized.unknownSignals,
    },
  };
  if (context.policy) result.policy = context.policy;
  if (doNotEngageReason) result.doNotEngageReason = doNotEngageReason;
  return result;
}

function computeOpportunityScore(
  signals: Required<Record<keyof OpportunitySignal, number>>,
): number {
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
  return [...opportunities].sort(
    (a, b) =>
      b.score - a.score ||
      a.detectedAt.localeCompare(b.detectedAt) ||
      a.type.localeCompare(b.type) ||
      a.title.localeCompare(b.title),
  );
}

function normalizeSignals(signals: OpportunitySignal): {
  values: Required<Record<keyof OpportunitySignal, number>>;
  unknownSignals: string[];
} {
  const values = {} as Required<Record<keyof OpportunitySignal, number>>;
  const unknownSignals: string[] = [];
  for (const key of Object.keys(signals) as Array<keyof OpportunitySignal>) {
    const value = signals[key];
    if (value === "UNKNOWN" || value === null || value === undefined) {
      values[key] = 0;
      unknownSignals.push(key);
      continue;
    }
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(
        `Opportunity signal '${key}' must be a finite number from 0 to 100 or UNKNOWN`,
      );
    }
    values[key] = value;
  }
  return { values, unknownSignals };
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function staleOpportunity(
  type: OpportunityType,
  signals: OpportunitySignal,
  context: Parameters<typeof detectOpportunity>[2],
  evaluationTime: Date,
): DetectedOpportunity {
  const normalized = normalizeSignals(signals);
  const result: DetectedOpportunity = {
    type,
    title: context.title ?? `${type} opportunity`,
    description: context.description ?? `A ${type} opportunity detected.`,
    score: 0,
    signals: normalized.values,
    recommendedAction: "Ignore",
    doNotEngage: true,
    doNotEngageReason: "Stale conversation",
    evidence: context.evidence ?? [],
    detectedAt: evaluationTime.toISOString(),
    provenance: {
      ...(context.sourceIdentity ? { sourceIdentity: context.sourceIdentity } : {}),
      evaluationTimestamp: evaluationTime.toISOString(),
      ...(context.freshnessWindowMs !== undefined
        ? { freshnessWindowMs: context.freshnessWindowMs }
        : {}),
      unknownSignals: normalized.unknownSignals,
    },
  };
  if (context.policy) result.policy = context.policy;
  return result;
}
