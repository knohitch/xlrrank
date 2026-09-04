/**
 * Architectural Law #9 — AI is not the business logic.
 *
 * Deterministic operations use structured data, mathematics, graph algorithms,
 * configured scoring rules, and statistical analysis. AI is used for
 * interpretation, classification, reasoning, language generation, semantic
 * extraction, and explanations.
 *
 * Models are benchmarked into reasoning tiers; tiers are independent of
 * provider names and marketing labels.
 */

export const REASONING_TIERS = [
  "TIER_0_UTILITY",
  "TIER_1_EVERYDAY",
  "TIER_2_ADVANCED",
  "TIER_3_DEEP_INTELLIGENCE",
  "TIER_4_CRITICAL",
] as const;

export type ReasoningTier = (typeof REASONING_TIERS)[number];

export const AI_TASK_TYPES = [
  "interpretation",
  "classification",
  "reasoning",
  "language_generation",
  "semantic_extraction",
  "explanation",
] as const;

export type AiTaskType = (typeof AI_TASK_TYPES)[number];