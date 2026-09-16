export interface RelationshipEvent {
  id: string;
  relationshipId: string;
  eventType: string;
  description?: string;
  sourceKind: string;
  occurredAt: string;
}

export type RelationshipStage =
  | "discovered"
  | "following"
  | "engaged"
  | "mutual_engagement"
  | "familiar"
  | "conversation"
  | "relationship";

export const DEFAULT_PIPELINE: RelationshipStage[] = [
  "discovered",
  "following",
  "engaged",
  "mutual_engagement",
  "familiar",
  "conversation",
  "relationship",
];

export interface RelationshipPolicy {
  policyKey: string;
  version: string;
  interactionWeights: Record<string, number>;
  recency?: { windowDays: number; minimumMultiplier: number } | undefined;
  frequency?: { maxCount: number; weight: number } | undefined;
  strengthBands?: Array<{ key: RelationshipStage; minimumScore: number }> | undefined;
}

export interface RelationshipStrength {
  strength: number;
  momentum: number;
  stage: RelationshipStage;
  lastInteractionAt?: string;
  eventCount: number;
}

export function calculateRelationshipStrength(
  events: RelationshipEvent[],
  policy: RelationshipPolicy = {
    policyKey: "structural",
    version: "no-business-rules",
    interactionWeights: {},
  },
  evaluationTimestamp = new Date(0).toISOString(),
): RelationshipStrength {
  if (events.length === 0) {
    return { strength: 0, momentum: 0, stage: "discovered", eventCount: 0 };
  }

  const sorted = [...events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const latest = sorted[0]!;
  const now = new Date(evaluationTimestamp).getTime();
  const latestTime = new Date(latest.occurredAt).getTime();

  let strength = 0;
  for (const event of events) {
    const base = policy.interactionWeights[event.eventType] ?? 0;
    if (!policy.recency) {
      strength += base;
      continue;
    }
    const days = Math.max(0, (now - new Date(event.occurredAt).getTime()) / (1000 * 60 * 60 * 24));
    const multiplier = Math.max(policy.recency.minimumMultiplier, 1 - days / policy.recency.windowDays);
    strength += base * multiplier;
  }
  if (policy.frequency && events.length > 0) {
    strength += (Math.min(events.length, policy.frequency.maxCount) / policy.frequency.maxCount) * policy.frequency.weight;
  }
  strength = Math.round(Math.min(100, strength));

  let momentum = 0;
  const recentEvents = events.filter(
    (e) => now - new Date(e.occurredAt).getTime() < 30 * 24 * 60 * 60 * 1000,
  );
  const olderEvents = events.filter(
    (e) => now - new Date(e.occurredAt).getTime() >= 30 * 24 * 60 * 60 * 1000,
  );
  if (recentEvents.length > olderEvents.length) momentum = Math.min(100, recentEvents.length * 15);
  else if (recentEvents.length < olderEvents.length) momentum = Math.max(-100, -(olderEvents.length - recentEvents.length) * 10);
  else momentum = 0;

  const stage =
    [...(policy.strengthBands ?? [])]
      .sort((a, b) => b.minimumScore - a.minimumScore)
      .find((band) => strength >= band.minimumScore)?.key ?? "discovered";

  return {
    strength: Math.max(0, Math.min(100, strength)),
    momentum,
    stage,
    lastInteractionAt: latest.occurredAt,
    eventCount: events.length,
  };
}

export function findWarmingRelationships(
  relationships: Array<{ id: string; strength: RelationshipStrength }>,
): Array<{ id: string; strength: RelationshipStrength }> {
  return relationships
    .filter((r) => r.strength.momentum > 20)
    .sort((a, b) => b.strength.momentum - a.strength.momentum);
}

export function findCoolingRelationships(
  relationships: Array<{ id: string; strength: RelationshipStrength }>,
): Array<{ id: string; strength: RelationshipStrength }> {
  return relationships
    .filter((r) => r.strength.momentum < -20)
    .sort((a, b) => a.strength.momentum - b.strength.momentum);
}
