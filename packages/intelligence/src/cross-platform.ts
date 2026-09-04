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
}

export function mergeCrossPlatformProfiles(
  profiles: Array<{
    platform: string;
    handle: string;
    displayName?: string;
    profileUrl?: string;
    followerCount?: number;
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
    };
  }

  const bestName = profiles.find((p) => p.displayName)?.displayName ?? profiles[0]!.handle;
  const totalFollowers = profiles.reduce((s, p) => s + (p.followerCount ?? 0), 0);

  return {
    personId: `cross_${profiles.map((p) => p.platform).join("_")}_${profiles[0]!.handle}`,
    name: bestName,
    accounts: profiles.map((p) => ({
      platform: p.platform,
      handle: p.handle,
      ...(p.profileUrl ? { profileUrl: p.profileUrl } : {}),
      ...(p.followerCount !== undefined ? { followerCount: p.followerCount } : {}),
    })),
    overallRelevance: Math.min(100, Math.round(totalFollowers / 100 + profiles.length * 15)),
    platformEvidence: Object.fromEntries(
      profiles.map((p) => [p.platform, p.metadata ?? {}]),
    ),
  };
}

export function analyzeCrossPlatformTopics(
  platformTopics: Map<string, string[]>,
): { sharedTopics: string[]; platformUnique: Record<string, string[]> } {
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
