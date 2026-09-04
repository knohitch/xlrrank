import { computeDeterministicScore, type ScoringConfig, type ScoringComponent, DEFAULT_DISCOVERY_SCORING } from "./scoring.js";

export interface DiscoveryCandidate {
  personId: string;
  name: string;
  componentScores: Record<string, number>;
}

export interface DiscoveryResult {
  personId: string;
  name: string;
  overall: number;
  componentScores: Record<string, number>;
  scoringVersion: string;
  explanation: string;
}

export function scoreDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  config: ScoringConfig = DEFAULT_DISCOVERY_SCORING,
): DiscoveryResult {
  const { overall, components } = computeDeterministicScore(config, candidate.componentScores);
  const explanation = buildExplanation(candidate.name, components, config);
  return {
    personId: candidate.personId,
    name: candidate.name,
    overall,
    componentScores: components,
    scoringVersion: config.version,
    explanation,
  };
}

function buildExplanation(
  name: string,
  scores: Record<string, number>,
  config: ScoringConfig,
): string {
  const parts: string[] = [];
  parts.push(`${name} scored ${Math.round(Object.values(scores).reduce((a: number, b: number) => a + b, 0) / Math.max(Object.keys(scores).length, 1))} overall.`);

  const sorted = config.components
    .filter((c: ScoringComponent) => scores[c.key] !== undefined)
    .sort((a: ScoringComponent, b: ScoringComponent) => (scores[b.key] ?? 0) - (scores[a.key] ?? 0));

  for (const comp of sorted.slice(0, 3)) {
    const score = scores[comp.key] ?? 0;
    if (score >= 70) {
      parts.push(`Strong ${comp.label.toLowerCase()} (${score}).`);
    } else if (score < 40) {
      parts.push(`Low ${comp.label.toLowerCase()} (${score}).`);
    }
  }

  return parts.join(" ");
}

export function rankCandidates(
  candidates: DiscoveryCandidate[],
  config?: ScoringConfig,
): DiscoveryResult[] {
  return candidates
    .map((c) => scoreDiscoveryCandidate(c, config))
    .sort((a, b) => b.overall - a.overall);
}
