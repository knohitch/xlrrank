export interface SocialDnaDimension {
  key: string;
  label: string;
  value: number;
  confidence: number;
  sourceKind: "OBSERVED" | "USER_PROVIDED" | "DERIVED" | "INFERRED";
}

export interface SocialDnaProfile {
  personId: string;
  version: number;
  dimensions: SocialDnaDimension[];
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
  sourceKind: "OBSERVED" | "USER_PROVIDED" | "DERIVED" | "INFERRED";
}

export interface SocialDnaInput {
  personId: string;
  profile?: { bio?: string; location?: string; website?: string };
  content?: Array<{ body: string; contentType?: string }>;
  interactions?: Array<{ type: string; body?: string }>;
  statedPreferences?: Record<string, string>;
}

export function generateSocialDna(input: SocialDnaInput): SocialDnaProfile {
  const dimensions: SocialDnaDimension[] = [];
  const expertise: string[] = [];
  const topics: string[] = [];
  const interests: string[] = [];

  if (input.profile?.bio) {
    const bioWords = input.profile.bio.toLowerCase().split(/\s+/);
    const topicKeywords = bioWords.filter((w) => w.length > 4);
    for (const kw of topicKeywords.slice(0, 5)) {
      if (!topics.includes(kw)) topics.push(kw);
    }
    dimensions.push({
      key: "bio_length",
      label: "Bio detail level",
      value: Math.min(100, input.profile.bio.length * 2),
      confidence: 0.8,
      sourceKind: "OBSERVED",
    });
  }

  if (input.content && input.content.length > 0) {
    const allWords = input.content
      .map((c) => c.body.toLowerCase().split(/\s+/))
      .flat();
    const wordFreq = new Map<string, number>();
    for (const word of allWords) {
      if (word.length > 3) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }
    const sorted = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [word] of sorted.slice(0, 10)) {
      if (!topics.includes(word)) topics.push(word);
    }

    dimensions.push({
      key: "content_volume",
      label: "Content volume",
      value: Math.min(100, input.content.length * 10),
      confidence: 0.9,
      sourceKind: "OBSERVED",
    });

    const contentTypes = new Set(input.content.map((c) => c.contentType ?? "post"));
    dimensions.push({
      key: "format_diversity",
      label: "Content format diversity",
      value: Math.min(100, contentTypes.size * 25),
      confidence: 0.85,
      sourceKind: "OBSERVED",
    });
  }

  if (input.interactions && input.interactions.length > 0) {
    const interactionTypes = new Set(input.interactions.map((i) => i.type));
    dimensions.push({
      key: "engagement_diversity",
      label: "Engagement diversity",
      value: Math.min(100, interactionTypes.size * 20),
      confidence: 0.8,
      sourceKind: "OBSERVED",
    });

    dimensions.push({
      key: "activity_level",
      label: "Activity level",
      value: Math.min(100, input.interactions.length * 5),
      confidence: 0.85,
      sourceKind: "OBSERVED",
    });
  }

  if (input.statedPreferences) {
    for (const [key, value] of Object.entries(input.statedPreferences)) {
      interests.push(value);
      dimensions.push({
        key: `stated_${key}`,
        label: `Stated: ${key}`,
        value: 80,
        confidence: 1.0,
        sourceKind: "USER_PROVIDED",
      });
    }
  }

  return {
    personId: input.personId,
    version: 1,
    dimensions,
    expertise,
    topics,
    interests,
    commercialInterests: [],
    geography: input.profile?.location ? [input.profile.location] : [],
    audienceTypes: [],
    contentFormats: input.content?.map((c) => c.contentType ?? "post") ?? [],
    communicationStyle: "unknown",
    tone: "unknown",
    complexity: "unknown",
    generatedAt: new Date().toISOString(),
    sourceKind: input.content ? "DERIVED" : "OBSERVED",
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
