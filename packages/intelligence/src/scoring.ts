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
  version: "structural",
  name: "Person Discovery",
  components: [],
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
