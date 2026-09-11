import { createHash } from "node:crypto";

export type SocialDnaSourceKind = "STATED" | "OBSERVED" | "DERIVED";

export interface SocialDnaEvidence {
  sourceKind: SocialDnaSourceKind;
  signalType: string;
  platformId?: string | undefined;
  providerObjectId?: string | undefined;
  externalAccountId?: string | undefined;
  contentItemId?: string | undefined;
  interactionId?: string | undefined;
  occurrenceCount: number;
  observedAt?: string | undefined;
  classificationVersion: string;
  sample?: string | undefined;
}

export interface SocialDnaSignal {
  key: string;
  value: string;
  sourceKind: SocialDnaSourceKind;
  evidence: SocialDnaEvidence[];
}

export interface SocialDnaDimension {
  key: string;
  label: string;
  values: string[];
  confidence: number;
  sourceKind: SocialDnaSourceKind;
  evidence: SocialDnaEvidence[];
}

export interface SocialDnaProfile {
  personId: string;
  version: number;
  algorithmVersion: string;
  sourceFingerprint: string;
  sourceWindow: { from: string | null; to: string | null; sourceCount: number };
  dimensions: SocialDnaDimension[];
  statedSignals: SocialDnaSignal[];
  observedSignals: SocialDnaSignal[];
  evidence: SocialDnaEvidence[];
  expertise: string[];
  topics: string[];
  interests: string[];
  commercialInterests: string[];
  geography: string[];
  audienceTypes: string[];
  contentFormats: string[];
  communicationStyle: string;
  tone: string;
  complexity: string;
  generatedAt: string;
  sourceKind: "DERIVED";
}

export interface SocialDnaProfileSource {
  externalAccountId?: string | undefined;
  platformId?: string | undefined;
  providerObjectId?: string | undefined;
  bio?: string | undefined;
  displayName?: string | undefined;
  location?: string | undefined;
  website?: string | undefined;
  observedAt?: string | undefined;
}

export interface SocialDnaPolicy {
  policyKey: string;
  version: string;
  tokenMinLength: number;
  topicTaxonomy: Array<{ key: string; terms: string[] }>;
  expertiseTopics?: string[] | undefined;
  interestTopics?: string[] | undefined;
  commercialTopics?: string[] | undefined;
  audienceRules?: Array<{ key: string; topics: string[] }> | undefined;
  communicationStyle?: { inquisitiveQuestionRatio: number } | undefined;
  complexity?: { mediumFormMinTokens: number; longFormMinTokens: number } | undefined;
  comparisonWeights?: { topics: number; interests: number } | undefined;
}

export interface SocialDnaInput {
  personId: string;
  algorithmVersion?: string | undefined;
  policy?: SocialDnaPolicy | undefined;
  profile?: SocialDnaProfileSource | undefined;
  profiles?: SocialDnaProfileSource[] | undefined;
  content?: Array<{
    id?: string | undefined;
    externalAccountId?: string | undefined;
    platformId?: string | undefined;
    providerObjectId?: string | undefined;
    body: string;
    contentType?: string | undefined;
    language?: string | null;
    observedAt?: string | undefined;
  }>;
  interactions?: Array<{
    id?: string | undefined;
    externalAccountId?: string | undefined;
    platformId?: string | undefined;
    providerObjectId?: string | undefined;
    type: string;
    body?: string | null;
    observedAt?: string | undefined;
  }>;
  statedPreferences?: Record<string, string>;
}

const STRUCTURAL_SOCIAL_DNA_POLICY: SocialDnaPolicy = {
  policyKey: "structural",
  version: "no-business-rules",
  tokenMinLength: 3,
  topicTaxonomy: [],
  expertiseTopics: [],
  interestTopics: [],
  commercialTopics: [],
  audienceRules: [],
  communicationStyle: { inquisitiveQuestionRatio: 0.5 },
  complexity: { mediumFormMinTokens: 10, longFormMinTokens: 30 },
  comparisonWeights: { topics: 0.5, interests: 0.5 },
};

export function validateSocialDnaPolicy(policy: SocialDnaPolicy): SocialDnaPolicy {
  if (!policy.policyKey || !policy.version) throw new Error("Social DNA policy requires policyKey and version");
  if (!Number.isInteger(policy.tokenMinLength) || policy.tokenMinLength < 1) {
    throw new Error("Social DNA policy tokenMinLength must be a positive integer");
  }
  const topics = new Set<string>();
  for (const topic of policy.topicTaxonomy) {
    if (!topic.key) throw new Error("Social DNA topic key is required");
    if (topics.has(topic.key)) throw new Error(`Duplicate Social DNA topic '${topic.key}'`);
    topics.add(topic.key);
    if (!Array.isArray(topic.terms) || topic.terms.length === 0 || topic.terms.some((term) => !term.trim())) {
      throw new Error(`Social DNA topic '${topic.key}' requires non-empty terms`);
    }
  }
  for (const listName of ["expertiseTopics", "interestTopics", "commercialTopics"] as const) {
    for (const topic of policy[listName] ?? []) {
      if (!topics.has(topic)) throw new Error(`Social DNA ${listName} references unknown topic '${topic}'`);
    }
  }
  for (const rule of policy.audienceRules ?? []) {
    if (!rule.key) throw new Error("Social DNA audience rule key is required");
    for (const topic of rule.topics) {
      if (!topics.has(topic)) throw new Error(`Social DNA audience rule '${rule.key}' references unknown topic '${topic}'`);
    }
  }
  const communicationRatio = policy.communicationStyle?.inquisitiveQuestionRatio;
  if (communicationRatio !== undefined && (!Number.isFinite(communicationRatio) || communicationRatio < 0 || communicationRatio > 1)) {
    throw new Error("Social DNA inquisitiveQuestionRatio must be between 0 and 1");
  }
  if (policy.complexity) {
    assertPositive(policy.complexity.mediumFormMinTokens, "Social DNA mediumFormMinTokens");
    assertPositive(policy.complexity.longFormMinTokens, "Social DNA longFormMinTokens");
    if (policy.complexity.mediumFormMinTokens > policy.complexity.longFormMinTokens) {
      throw new Error("Social DNA mediumFormMinTokens cannot exceed longFormMinTokens");
    }
  }
  if (policy.comparisonWeights) {
    assertFiniteNonnegative(policy.comparisonWeights.topics, "Social DNA comparison topic weight");
    assertFiniteNonnegative(policy.comparisonWeights.interests, "Social DNA comparison interest weight");
    if (policy.comparisonWeights.topics + policy.comparisonWeights.interests <= 0) {
      throw new Error("Social DNA comparison weights must contain a positive total");
    }
  }
  return policy;
}

export function generateSocialDna(input: SocialDnaInput): SocialDnaProfile {
  const policy = validateSocialDnaPolicy(input.policy ?? STRUCTURAL_SOCIAL_DNA_POLICY);
  const algorithmVersion = input.algorithmVersion ?? `social-dna:${policy.policyKey}:${policy.version}`;
  const evidence: SocialDnaEvidence[] = [];
  const statedSignals: SocialDnaSignal[] = [];
  const observedSignals: SocialDnaSignal[] = [];
  const topicCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();
  const profiles = profileSources(input);

  for (const profile of profiles) {
    if (profile.bio) {
      for (const [topic, count] of classifyText(profile.bio, policy)) {
        addCount(topicCounts, topic, count);
        const item = evidenceItem("STATED", "profile_bio_topic", count, algorithmVersion, {
          externalAccountId: profile.externalAccountId,
          platformId: profile.platformId,
          providerObjectId: profile.providerObjectId,
          observedAt: profile.observedAt,
          sample: topic,
        });
        evidence.push(item);
        statedSignals.push({ key: "profile_bio_topic", value: topic, sourceKind: "STATED", evidence: [item] });
      }
    }
    if (profile.location) {
      const item = evidenceItem("STATED", "profile_location", 1, algorithmVersion, {
        externalAccountId: profile.externalAccountId,
        platformId: profile.platformId,
        providerObjectId: profile.providerObjectId,
        observedAt: profile.observedAt,
        sample: profile.location,
      });
      evidence.push(item);
      statedSignals.push({ key: "location", value: profile.location, sourceKind: "STATED", evidence: [item] });
    }
    if (profile.website) {
      const item = evidenceItem("STATED", "profile_website", 1, algorithmVersion, {
        externalAccountId: profile.externalAccountId,
        platformId: profile.platformId,
        providerObjectId: profile.providerObjectId,
        observedAt: profile.observedAt,
        sample: profile.website,
      });
      evidence.push(item);
      statedSignals.push({ key: "website", value: profile.website, sourceKind: "STATED", evidence: [item] });
    }
  }

  for (const [key, value] of Object.entries(input.statedPreferences ?? {}).sort()) {
    const item = evidenceItem("STATED", `stated_preference:${key}`, 1, algorithmVersion, { sample: value });
    evidence.push(item);
    statedSignals.push({ key, value, sourceKind: "STATED", evidence: [item] });
  }

  for (const content of input.content ?? []) {
    addCount(formatCounts, content.contentType ?? "post", 1);
    for (const [topic, count] of classifyText(content.body, policy)) {
      addCount(topicCounts, topic, count);
      const item = evidenceItem("OBSERVED", "content_topic", count, algorithmVersion, {
        contentItemId: content.id,
        externalAccountId: content.externalAccountId,
        platformId: content.platformId,
        providerObjectId: content.providerObjectId,
        observedAt: content.observedAt,
        sample: topic,
      });
      evidence.push(item);
      observedSignals.push({ key: "content_topic", value: topic, sourceKind: "OBSERVED", evidence: [item] });
    }
  }

  for (const interaction of input.interactions ?? []) {
    const item = evidenceItem("OBSERVED", `interaction:${interaction.type}`, 1, algorithmVersion, {
      interactionId: interaction.id,
      externalAccountId: interaction.externalAccountId,
      platformId: interaction.platformId,
      providerObjectId: interaction.providerObjectId,
      observedAt: interaction.observedAt,
    });
    evidence.push(item);
    observedSignals.push({ key: "interaction_type", value: interaction.type, sourceKind: "OBSERVED", evidence: [item] });
  }

  const sortedTopics = sortedCountKeys(topicCounts);
  const contentFormats = sortedCountKeys(formatCounts);
  const geography = uniqueSorted(statedSignals.filter((signal) => signal.key === "location").map((signal) => signal.value));
  const dimensions: SocialDnaDimension[] = [];
  if (sortedTopics.length > 0) {
    dimensions.push({
      key: "recurring_topics",
      label: "Recurring topics",
      values: sortedTopics,
      confidence: confidenceFromCounts(sumCounts(topicCounts), evidence.length),
      sourceKind: observedSignals.some((s) => s.key === "content_topic") ? "OBSERVED" : "STATED",
      evidence: evidence.filter((e) => e.signalType.endsWith("topic")),
    });
  }
  if (contentFormats.length > 0) {
    dimensions.push({
      key: "preferred_content_formats",
      label: "Preferred content formats",
      values: contentFormats,
      confidence: confidenceFromCounts(sumCounts(formatCounts), evidence.length),
      sourceKind: "OBSERVED",
      evidence: [...formatCounts.entries()].map(([format, count]) =>
        evidenceItem("OBSERVED", "content_format", count, algorithmVersion, { sample: format }),
      ),
    });
  }
  if (geography.length > 0) {
    dimensions.push({
      key: "geography",
      label: "Geography/location signals",
      values: geography,
      confidence: confidenceFromCounts(geography.length, evidence.length),
      sourceKind: "STATED",
      evidence: evidence.filter((e) => e.signalType === "profile_location"),
    });
  }

  const observedAtValues = evidence.map((e) => e.observedAt).filter((v): v is string => Boolean(v)).sort();
  const sourceWindow = {
    from: observedAtValues[0] ?? null,
    to: observedAtValues.at(-1) ?? null,
    sourceCount: evidence.length,
  };
  const sourceFingerprint = fingerprint({
    algorithmVersion,
    policy: { policyKey: policy.policyKey, version: policy.version, config: policy },
    personId: input.personId,
    profiles,
    content: [...(input.content ?? [])].sort(compareSourceIds),
    interactions: [...(input.interactions ?? [])].sort(compareSourceIds),
    statedPreferences: input.statedPreferences ?? {},
  });

  return {
    personId: input.personId,
    version: 1,
    algorithmVersion,
    sourceFingerprint,
    sourceWindow,
    dimensions,
    statedSignals,
    observedSignals,
    evidence,
    expertise: sortedTopics.filter((topic) => (policy.expertiseTopics ?? []).includes(topic)),
    topics: sortedTopics,
    interests: uniqueSorted([
      ...Object.values(input.statedPreferences ?? {}),
      ...sortedTopics.filter((topic) => (policy.interestTopics ?? []).includes(topic)),
    ]),
    commercialInterests: sortedTopics.filter((topic) => (policy.commercialTopics ?? []).includes(topic)),
    geography,
    audienceTypes: inferAudienceTypes(sortedTopics, policy),
    contentFormats,
    communicationStyle: inferCommunicationStyle(input.content ?? [], policy),
    tone: "unknown",
    complexity: inferComplexity(input.content ?? [], policy),
    generatedAt: sourceWindow.to ?? sourceWindow.from ?? "1970-01-01T00:00:00.000Z",
    sourceKind: "DERIVED",
  };
}

export function compareDnaProfiles(
  a: SocialDnaProfile,
  b: SocialDnaProfile,
  policy?: Pick<SocialDnaPolicy, "comparisonWeights">,
): { similarity: number; sharedTopics: string[]; sharedInterests: string[] } {
  const weights = policy?.comparisonWeights ?? STRUCTURAL_SOCIAL_DNA_POLICY.comparisonWeights ?? { topics: 0.5, interests: 0.5 };
  const totalWeight = weights.topics + weights.interests;
  const sharedTopics = a.topics.filter((t) => b.topics.includes(t));
  const sharedInterests = a.interests.filter((i) => b.interests.includes(i));
  const maxTopics = Math.max(a.topics.length, b.topics.length, 1);
  const maxInterests = Math.max(a.interests.length, b.interests.length, 1);
  const similarity = Math.round(
    ((sharedTopics.length / maxTopics) * (weights.topics / totalWeight) +
      (sharedInterests.length / maxInterests) * (weights.interests / totalWeight)) *
      100,
  );
  return { similarity, sharedTopics, sharedInterests };
}

function classifyText(text: string, policy: SocialDnaPolicy): Map<string, number> {
  const tokens = tokenize(text, policy.tokenMinLength);
  const result = new Map<string, number>();
  for (const topic of policy.topicTaxonomy) {
    let count = 0;
    for (const term of topic.terms) count += tokens.filter((token) => token === term.toLowerCase()).length;
    if (count > 0) result.set(topic.key, count);
  }
  return result;
}

function tokenize(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= minLength);
}

function evidenceItem(
  sourceKind: SocialDnaSourceKind,
  signalType: string,
  occurrenceCount: number,
  classificationVersion: string,
  input: Partial<SocialDnaEvidence>,
): SocialDnaEvidence {
  return {
    sourceKind,
    signalType,
    occurrenceCount,
    classificationVersion,
    ...input,
  };
}

function confidenceFromCounts(occurrences: number, evidenceCount: number): number {
  if (occurrences <= 0 || evidenceCount <= 0) return 0;
  return Number((occurrences / (occurrences + evidenceCount)).toFixed(4));
}

function addCount(map: Map<string, number>, key: string, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function sumCounts(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, value) => sum + value, 0);
}

function sortedCountKeys(map: Map<string, number>): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function compareSourceIds(
  a: { id?: string | undefined; externalAccountId?: string | undefined; providerObjectId?: string | undefined },
  b: { id?: string | undefined; externalAccountId?: string | undefined; providerObjectId?: string | undefined },
): number {
  return (a.id ?? a.externalAccountId ?? a.providerObjectId ?? "").localeCompare(b.id ?? b.externalAccountId ?? b.providerObjectId ?? "");
}

function profileSources(input: SocialDnaInput): SocialDnaProfileSource[] {
  const sources = [...(input.profiles ?? [])];
  if (input.profile) sources.push(input.profile);
  const seen = new Set<string>();
  return sources
    .filter((source) => {
      const key = source.externalAccountId ?? `${source.platformId ?? ""}:${source.providerObjectId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareSourceIds);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function inferAudienceTypes(topics: string[], policy: SocialDnaPolicy): string[] {
  const audience = new Set<string>();
  for (const rule of policy.audienceRules ?? []) {
    if (topics.some((topic) => rule.topics.includes(topic))) audience.add(rule.key);
  }
  return [...audience].sort();
}

function inferCommunicationStyle(content: Array<{ body: string }>, policy: SocialDnaPolicy): string {
  if (content.length === 0) return "unknown";
  const ratio = policy.communicationStyle?.inquisitiveQuestionRatio ?? 0.5;
  const questionCount = content.filter((item) => item.body.includes("?")).length;
  return questionCount / content.length > ratio ? "inquisitive" : "informational";
}

function inferComplexity(content: Array<{ body: string }>, policy: SocialDnaPolicy): string {
  if (content.length === 0) return "unknown";
  const rules = policy.complexity ?? STRUCTURAL_SOCIAL_DNA_POLICY.complexity ?? { mediumFormMinTokens: 10, longFormMinTokens: 30 };
  const averageLength = content.reduce((sum, item) => sum + tokenize(item.body, policy.tokenMinLength).length, 0) / content.length;
  if (averageLength >= rules.longFormMinTokens) return "long_form";
  if (averageLength >= rules.mediumFormMinTokens) return "medium_form";
  return "short_form";
}

function assertPositive(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${path} must be a positive integer`);
}

function assertFiniteNonnegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite nonnegative number`);
  }
}
