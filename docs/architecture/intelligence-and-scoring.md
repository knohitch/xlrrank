# Intelligence and Scoring

Law 9. Reference implementations: `packages/shared/src/constitution/reasoning.ts`,
`packages/shared/src/constitution/scoring.ts`.

## Division of labor

| Concern | Mechanism | Provider |
| --- | --- | --- |
| Final percentages, composite scores | deterministic mathematics over recorded facts | Engine code + configured weights |
| Relationship strength / momentum | deterministic formulas over relationship events | Engine code |
| Trend detection | embedding clusters, time-series statistics, velocity | Engine code + embeddings |
| Evidence ranking | graph algorithms, configured scoring rules | Engine code |
| Interpretation, classification, reasoning, language, explanation | LLM calls grounded in evidence | AI gateway |

An LLM never invents the final percentage or a numeric score not derived from recorded inputs.

## Reasoning tiers

Models are benchmarked into tiers independent of provider names and marketing labels:

- `TIER_0_UTILITY` — simple extraction, tagging, formatting, language detection.
- `TIER_1_EVERYDAY` — summaries, routine classification, normal recommendations, basic Social DNA.
- `TIER_2_ADVANCED` — relationship analysis, content strategy, commercial-intent reasoning,
  cross-platform comparison.
- `TIER_3_DEEP_INTELLIGENCE` — network strategy, complex graph reasoning, multi-platform
  intelligence, high-ambiguity investigations.
- `TIER_4_CRITICAL` — highest-confidence complex work requiring verification or multi-model review.

A task has a default tier; a complexity estimator may escalate based on entity count, input size,
relationship count, ambiguity, conflicting evidence, cross-platform breadth, and requested depth.
Tier assignment comes from benchmarking, not from names like "Pro"/"Ultra".

## Scoring configuration

A `ScoringConfig` is a versioned record of labeled, weighted components (e.g. niche relevance,
relationship value, content overlap, audience overlap, conversation accessibility, commercial
relevance). A `DeterministicScore` stores the overall value, component values, the config
version, and the evidence ids — so any displayed score is reproducible and explainable.

## Rules

1. Weights are configuration/database records, never literals scattered in code.
2. Niche vocabularies are data, never hardcoded lists in business logic.
3. Explanations cite stored evidence; they never invent reasons.