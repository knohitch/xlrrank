export interface CrossPlatformProfile {
  personId: string;
  name: string;
  accounts: Array<{
    platform: string;
    handle: string;
    profileUrl?: string;
    followerCount?: number;
  }>;
  overallRelevance: number;
  platformEvidence: Record<string, Record<string, unknown>>;
  mergeEvidence: string[];
}

export type NormalizedMetricKind =
  "reaction" | "comment" | "share" | "view" | "follower" | "save" | "unknown";

export interface PlatformMetricDefinition {
  providerMetric: string;
  normalizedKind: NormalizedMetricKind;
  semanticVersion: string;
  comparable: boolean;
}

export function mergeCrossPlatformProfiles(
  profiles: Array<{
    platform: string;
    handle: string;
    displayName?: string;
    canonicalPersonId?: string;
    externalId?: string;
    profileUrl?: string;
    followerCount?: number | "UNKNOWN" | null;
    identityEvidence?: { confidence: "HIGH" | "MEDIUM" | "LOW"; evidenceIds: string[] };
    metadata?: Record<string, unknown>;
  }>,
): CrossPlatformProfile {
  if (profiles.length === 0) {
    return {
      personId: "",
      name: "Unknown",
      accounts: [],
      overallRelevance: 0,
      platformEvidence: {},
      mergeEvidence: [],
    };
  }

  const canonicalIds = new Set(
    profiles.map((profile) => profile.canonicalPersonId).filter((id): id is string => Boolean(id)),
  );
  const highConfidenceEvidence = profiles.every(
    (profile) =>
      profile.identityEvidence?.confidence === "HIGH" &&
      (profile.identityEvidence.evidenceIds.length > 0 || profiles.length === 1),
  );
  if (profiles.length > 1 && canonicalIds.size !== 1 && !highConfidenceEvidence) {
    throw new Error(
      "Cross-platform profiles require one verified canonical identity or high-confidence identity evidence",
    );
  }

  const uniquePlatformExternalIds = new Set<string>();
  for (const profile of profiles) {
    const key = `${normalizeToken(profile.platform)}:${profile.externalId ?? normalizeToken(profile.handle)}`;
    if (uniquePlatformExternalIds.has(key))
      throw new Error("Duplicate platform identity in cross-platform merge input");
    uniquePlatformExternalIds.add(key);
  }

  const sortedProfiles = [...profiles].sort(
    (a, b) =>
      normalizeToken(a.platform).localeCompare(normalizeToken(b.platform)) ||
      normalizeToken(a.handle).localeCompare(normalizeToken(b.handle)),
  );
  const bestName =
    sortedProfiles.find((p) => p.displayName)?.displayName ?? sortedProfiles[0]!.handle;
  const totalFollowers = sortedProfiles.reduce((sum, profile) => {
    if (typeof profile.followerCount !== "number") return sum;
    if (!Number.isFinite(profile.followerCount) || profile.followerCount < 0) {
      throw new Error("followerCount must be finite, nonnegative, or UNKNOWN");
    }
    return sum + profile.followerCount;
  }, 0);

  return {
    personId:
      [...canonicalIds][0] ??
      `cross_${sortedProfiles.map((p) => normalizeToken(p.platform)).join("_")}_${normalizeToken(sortedProfiles[0]!.handle)}`,
    name: bestName,
    accounts: sortedProfiles.map((p) => ({
      platform: p.platform,
      handle: p.handle,
      ...(p.profileUrl ? { profileUrl: p.profileUrl } : {}),
      ...(typeof p.followerCount === "number" ? { followerCount: p.followerCount } : {}),
    })),
    overallRelevance: Math.min(100, Math.round(totalFollowers / 100 + sortedProfiles.length * 15)),
    platformEvidence: Object.fromEntries(sortedProfiles.map((p) => [p.platform, p.metadata ?? {}])),
    mergeEvidence: sortedProfiles.flatMap((profile) => profile.identityEvidence?.evidenceIds ?? []),
  };
}

export function analyzeCrossPlatformTopics(platformTopics: Map<string, string[]>): {
  sharedTopics: string[];
  platformUnique: Record<string, string[]>;
} {
  const allTopics = new Map<string, Set<string>>();
  for (const [platform, topics] of platformTopics) {
    for (const topic of topics) {
      if (!allTopics.has(topic)) allTopics.set(topic, new Set());
      allTopics.get(topic)!.add(platform);
    }
  }

  const sharedTopics: string[] = [];
  const platformUnique: Record<string, string[]> = {};

  for (const [topic, platforms] of allTopics) {
    if (platforms.size >= 2) {
      sharedTopics.push(topic);
    } else {
      const platform = [...platforms][0]!;
      if (!platformUnique[platform]) platformUnique[platform] = [];
      platformUnique[platform].push(topic);
    }
  }

  return { sharedTopics, platformUnique };
}

export function normalizePlatformMetrics(
  metrics: Record<string, number | "UNKNOWN" | null | undefined>,
  definitions: PlatformMetricDefinition[],
): {
  values: Partial<Record<NormalizedMetricKind, number>>;
  unknown: NormalizedMetricKind[];
  incomparable: string[];
  version: string;
} {
  const values: Partial<Record<NormalizedMetricKind, number>> = {};
  const unknown = new Set<NormalizedMetricKind>();
  const incomparable: string[] = [];
  const definitionByProviderMetric = new Map(
    definitions.map((definition) => [definition.providerMetric, definition]),
  );

  for (const [providerMetric, value] of Object.entries(metrics)) {
    const definition = definitionByProviderMetric.get(providerMetric);
    if (!definition) {
      incomparable.push(providerMetric);
      continue;
    }
    if (!definition.comparable || definition.normalizedKind === "unknown") {
      incomparable.push(providerMetric);
      continue;
    }
    if (value === "UNKNOWN" || value === null || value === undefined) {
      unknown.add(definition.normalizedKind);
      continue;
    }
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Metric '${providerMetric}' must be finite, nonnegative, or UNKNOWN`);
    values[definition.normalizedKind] = (values[definition.normalizedKind] ?? 0) + value;
  }

  return {
    values,
    unknown: [...unknown].sort(),
    incomparable: incomparable.sort(),
    version: [...new Set(definitions.map((definition) => definition.semanticVersion))]
      .sort()
      .join("+"),
  };
}

function normalizeToken(value: string): string {
  return value.trim().toLocaleLowerCase().normalize("NFKC");
}
