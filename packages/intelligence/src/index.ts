export type { ScoringComponent, ScoringConfig } from "./scoring.js";
export { DEFAULT_DISCOVERY_SCORING, computeDeterministicScore } from "./scoring.js";

export type { SocialDnaDimension, SocialDnaPolicy, SocialDnaProfile, SocialDnaInput } from "./social-dna.js";
export { generateSocialDna, compareDnaProfiles, validateSocialDnaPolicy } from "./social-dna.js";

export type {
  IdentityAccountInput,
  IdentityConfidence,
  IdentityDecisionStatus,
  IdentityMatch,
  IdentityResolutionPolicy,
  IdentitySignalPolicy,
  PersonIdentity,
} from "./identity-resolution.js";
export {
  matchIdentity,
  orderedPair,
  shouldAutoMerge,
  validateIdentityResolutionPolicy,
} from "./identity-resolution.js";

export type { DiscoveryCandidate, DiscoveryResult } from "./discovery.js";
export { scoreDiscoveryCandidate, rankCandidates } from "./discovery.js";

export type { RelationshipEvent, RelationshipPolicy, RelationshipStage, RelationshipStrength } from "./relationships.js";
export {
  DEFAULT_PIPELINE,
  calculateRelationshipStrength,
  findWarmingRelationships,
  findCoolingRelationships,
} from "./relationships.js";

export type {
  OpportunityType,
  OpportunitySignal,
  DetectedOpportunity,
} from "./opportunities.js";
export { detectOpportunity, rankOpportunities } from "./opportunities.js";

export type { TrendDataPoint, DetectedTrend } from "./trends.js";
export { detectTrends } from "./trends.js";

export type {
  ContentAnalysis,
  ContentPerformance,
  ContentDna,
  ContentGap,
} from "./content.js";
export { analyzeContent, buildContentDna, findContentGaps } from "./content.js";

export type { CrossPlatformProfile } from "./cross-platform.js";
export { mergeCrossPlatformProfiles, analyzeCrossPlatformTopics } from "./cross-platform.js";

export type { SearchQuery, SearchResult, SearchResponse } from "./search.js";
export { buildSearchIndex, search } from "./search.js";
