/**
 * Architectural Law #9 (appendix) + Prompt 0 constitution.
 *
 * Deterministic, configurable, versioned scoring. An LLM must never invent the
 * final percentage. Component scores are stored with provenance so a result
 * remains explainable. Nothing here hardcodes weights or niches.
 */

export interface ScoringComponent {
  key: string;
  label: string;
  weight: number;
  value: number;
}

export interface ScoringConfig {
  id: string;
  version: string;
  name: string;
  components: ScoringComponent[];
  createdAt: string;
}

export interface DeterministicScore {
  overall: number;
  components: ScoringComponent[];
  scoringConfigId: string;
  scoringVersion: string;
  evidenceRefIds: string[];
  computedAt: string;
}