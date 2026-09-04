export interface ScoringComponent {
  key: string;
  label: string;
  weight: number;
}

export interface ScoringConfig {
  id: string;
  version: string;
  name: string;
  components: ScoringComponent[];
  enabled: boolean;
}

export const DEFAULT_DISCOVERY_SCORING: ScoringConfig = {
  id: "discovery",
  version: "1.0.0",
  name: "Person Discovery",
  components: [
    { key: "niche_relevance", label: "Niche relevance", weight: 0.2 },
    { key: "relationship_value", label: "Relationship value", weight: 0.15 },
    { key: "content_overlap", label: "Content overlap", weight: 0.2 },
    { key: "audience_overlap", label: "Audience overlap", weight: 0.1 },
    { key: "conversation_accessibility", label: "Conversation accessibility", weight: 0.15 },
    { key: "commercial_relevance", label: "Commercial relevance", weight: 0.2 },
  ],
  enabled: true,
};

export function computeDeterministicScore(
  config: ScoringConfig,
  componentScores: Record<string, number>,
): { overall: number; components: Record<string, number> } {
  let weightedTotal = 0;
  let weightSum = 0;
  for (const component of config.components) {
    const score = componentScores[component.key];
    if (score === undefined) continue;
    weightedTotal += score * component.weight;
    weightSum += component.weight;
  }
  const overall = weightSum > 0 ? Math.round(weightedTotal / weightSum) : 0;
  return { overall, components: { ...componentScores } };
}
