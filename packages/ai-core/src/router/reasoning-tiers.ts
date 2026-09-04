import type { ReasoningTier } from "@xlrrank/shared";

export interface TierDefinition {
  tier: ReasoningTier;
  label: string;
  description: string;
  defaultTasks: string[];
}

export const TIER_DEFINITIONS: TierDefinition[] = [
  {
    tier: "TIER_0_UTILITY",
    label: "Utility",
    description: "Simple extraction, tagging, formatting, language detection",
    defaultTasks: ["extraction", "tagging", "formatting", "language_detection"],
  },
  {
    tier: "TIER_1_EVERYDAY",
    label: "Everyday",
    description: "Summaries, routine classification, recommendations, basic Social DNA",
    defaultTasks: ["summary", "classification", "recommendation", "social_dna_basic"],
  },
  {
    tier: "TIER_2_ADVANCED",
    label: "Advanced",
    description: "Relationship analysis, content strategy, commercial intent, cross-platform comparison",
    defaultTasks: ["relationship_analysis", "content_strategy", "commercial_intent", "cross_platform"],
  },
  {
    tier: "TIER_3_DEEP_INTELLIGENCE",
    label: "Deep Intelligence",
    description: "Network strategy, complex graph reasoning, multi-platform intelligence",
    defaultTasks: ["network_strategy", "graph_reasoning", "multi_platform", "high_ambiguity"],
  },
  {
    tier: "TIER_4_CRITICAL",
    label: "Critical",
    description: "Highest-confidence work requiring verification or multi-model review",
    defaultTasks: ["verification", "multi_model_review", "critical_analysis"],
  },
];

export const TIER_RANK: Record<ReasoningTier, number> = {
  TIER_0_UTILITY: 0,
  TIER_1_EVERYDAY: 1,
  TIER_2_ADVANCED: 2,
  TIER_3_DEEP_INTELLIGENCE: 3,
  TIER_4_CRITICAL: 4,
};

export function tierForTask(taskType: string): ReasoningTier {
  for (const def of TIER_DEFINITIONS) {
    if (def.defaultTasks.includes(taskType)) return def.tier;
  }
  return "TIER_1_EVERYDAY";
}
