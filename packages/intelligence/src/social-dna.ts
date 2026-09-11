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

export interface SocialDnaInput {
  personId: string;
  algorithmVersion?: string | undefined;
  profile?: {
    externalAccountId?: string | undefined;
    platformId?: string | undefined;
    providerObjectId?: string | undefined;
    bio?: string | undefined;
    displayName?: string | undefined;
    location?: string | undefined;
    website?: string | undefined;
    observedAt?: string | undefined;
  };
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

const DEFAULT_ALGORITHM_VERSION = "social-dna-deterministic-v1";
const TOKEN_MIN_LENGTH = 3;

const TOPIC_LEXICON: Record<string, readonly string[]> = {
  software_engineering: ["software", "engineering", "developer", "code", "typescript", "backend", "frontend"],
  ai_automation: ["ai", "automation", "agent", "llm", "workflow", "model"],
  saas: ["saas", "startup", "product", "growth", "b2b", "platform"],
  fashion_beauty: ["fashion", "beauty", "style", "makeup", "skincare", "outfit"],
  lifestyle: ["lifestyle", "wellness", "travel", "home", "creator", "visual"],
  finance: ["finance", "fintech", "market", "investing", "payments", "banking"],
  real_estate: ["real", "estate", "property", "broker", "homes", "realtor"],
};

const COMMERCIAL_TERMS = new Set(["saas", "startup", "b2b", "growth", "market", "brand", "product", "commerce"]);

export function generateSocialDna(input: SocialDnaInput): SocialDnaProfile {
  const algorithmVersion = input.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION;
  const evidence: SocialDnaEvidence[] = [];
  const statedSignals: SocialDnaSignal[] = [];
  const observedSignals: SocialDnaSignal[] = [];
  const topicCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();

  if (input.profile?.bio) {
    for (const [topic, count] of classifyText(input.profile.bio)) {
      addCount(topicCounts, topic, count);
      const item = evidenceItem("STATED", "profile_bio_topic", count, algorithmVersion, {
        externalAccountId: input.profile.externalAccountId,
        platformId: input.profile.platformId,
        providerObjectId: input.profile.providerObjectId,
        observedAt: input.profile.observedAt,
        sample: topic,
      });
      evidence.push(item);
      statedSignals.push({ key: "profile_bio_topic", value: topic, sourceKind: "STATED", evidence: [item] });
    }
  }

  for (const [key, value] of Object.entries(input.statedPreferences ?? {}).sort()) {
    const item = evidenceItem("STATED", `stated_preference:${key}`, 1, algorithmVersion, { sample: value });
    evidence.push(item);
    statedSignals.push({ key, value, sourceKind: "STATED", evidence: [item] });
  }

  for (const content of input.content ?? []) {
    addCount(formatCounts, content.contentType ?? "post", 1);
    if (content.language) addCount(languageCounts, content.language, 1);
    for (const [topic, count] of classifyText(content.body)) {
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
  if (input.profile?.location) {
    const item = evidenceItem("STATED", "profile_location", 1, algorithmVersion, {
      externalAccountId: input.profile.externalAccountId,
      platformId: input.profile.platformId,
      providerObjectId: input.profile.providerObjectId,
      observedAt: input.profile.observedAt,
      sample: input.profile.location,
    });
    evidence.push(item);
    statedSignals.push({ key: "location", value: input.profile.location, sourceKind: "STATED", evidence: [item] });
    dimensions.push({
      key: "geography",
      label: "Geography/location signals",
      values: [input.profile.location],
      confidence: confidenceFromCounts(1, evidence.length),
      sourceKind: "STATED",
      evidence: [item],
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
    personId: input.personId,
    profile: input.profile ?? null,
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
    expertise: sortedTopics.filter((topic) => !["lifestyle", "fashion_beauty"].includes(topic)),
    topics: sortedTopics,
    interests: [
      ...new Set([
        ...statedSignals.map((s) => s.value),
        ...sortedTopics.filter((topic) => topic === "lifestyle" || topic === "fashion_beauty"),
      ]),
    ].sort(),
    commercialInterests: sortedTopics.filter((topic) =>
      TOPIC_LEXICON[topic]?.some((term) => COMMERCIAL_TERMS.has(term)),
    ),
    geography: input.profile?.location ? [input.profile.location] : [],
    audienceTypes: inferAudienceTypes(sortedTopics),
    contentFormats,
    communicationStyle: inferCommunicationStyle(input.content ?? []),
    tone: "unknown",
    complexity: inferComplexity(input.content ?? []),
    generatedAt: sourceWindow.to ?? sourceWindow.from ?? "1970-01-01T00:00:00.000Z",
    sourceKind: "DERIVED",
  };
}

export function compareDnaProfiles(
  a: SocialDnaProfile,
  b: SocialDnaProfile,
): { similarity: number; sharedTopics: string[]; sharedInterests: string[] } {
  const sharedTopics = a.topics.filter((t) => b.topics.includes(t));
  const sharedInterests = a.interests.filter((i) => b.interests.includes(i));
  const maxTopics = Math.max(a.topics.length, b.topics.length, 1);
  const maxInterests = Math.max(a.interests.length, b.interests.length, 1);
  const similarity = Math.round(
    ((sharedTopics.length / maxTopics) * 0.6 + (sharedInterests.length / maxInterests) * 0.4) * 100,
  );
  return { similarity, sharedTopics, sharedInterests };
}

function classifyText(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const result = new Map<string, number>();
  for (const [topic, terms] of Object.entries(TOPIC_LEXICON)) {
    let count = 0;
    for (const term of terms) count += tokens.filter((token) => token === term).length;
    if (count > 0) result.set(topic, count);
  }
  return result;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= TOKEN_MIN_LENGTH);
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
  a: { id?: string | undefined; providerObjectId?: string | undefined },
  b: { id?: string | undefined; providerObjectId?: string | undefined },
): number {
  return (a.id ?? a.providerObjectId ?? "").localeCompare(b.id ?? b.providerObjectId ?? "");
}

function inferAudienceTypes(topics: string[]): string[] {
  const audience = new Set<string>();
  if (topics.some((t) => ["software_engineering", "ai_automation", "saas"].includes(t))) audience.add("developer");
  if (topics.some((t) => ["fashion_beauty", "lifestyle"].includes(t))) audience.add("creator");
  if (topics.includes("finance")) audience.add("commercial");
  return [...audience].sort();
}

function inferCommunicationStyle(content: Array<{ body: string }>): string {
  if (content.length === 0) return "unknown";
  const questionCount = content.filter((item) => item.body.includes("?")).length;
  return questionCount > content.length / 2 ? "inquisitive" : "informational";
}

function inferComplexity(content: Array<{ body: string }>): string {
  if (content.length === 0) return "unknown";
  const averageLength = content.reduce((sum, item) => sum + tokenize(item.body).length, 0) / content.length;
  if (averageLength >= 30) return "long_form";
  if (averageLength >= 10) return "medium_form";
  return "short_form";
}
