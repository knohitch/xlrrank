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

export interface RelationshipStrength {
  strength: number;
  momentum: number;
  stage: RelationshipStage;
  lastInteractionAt?: string;
  eventCount: number;
}

export function calculateRelationshipStrength(
  events: RelationshipEvent[],
  pipeline: RelationshipStage[] = DEFAULT_PIPELINE,
): RelationshipStrength {
  if (events.length === 0) {
    return { strength: 0, momentum: 0, stage: "discovered", eventCount: 0 };
  }

  const sorted = [...events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const latest = sorted[0]!;
  const now = Date.now();
  const latestTime = new Date(latest.occurredAt).getTime();
  const daysSinceLatest = (now - latestTime) / (1000 * 60 * 60 * 24);

  let strength = 0;
  const typeWeights: Record<string, number> = {
    followed: 10,
    followed_back: 15,
    commented: 25,
    replied: 30,
    liked: 5,
    mentioned: 20,
    saved: 15,
    dm_interaction: 40,
    manual_note: 10,
    meeting: 50,
  };

  for (const event of events) {
    strength += typeWeights[event.eventType] ?? 10;
  }
  strength = Math.min(100, Math.round(strength / Math.max(events.length * 0.3, 1)));

  const decayFactor = Math.max(0, 1 - daysSinceLatest / 90);
  strength = Math.round(strength * decayFactor);

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

  const stageIndex = Math.min(
    pipeline.length - 1,
    Math.floor((strength / 100) * pipeline.length),
  );
  const stage = pipeline[stageIndex] ?? "discovered";

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
