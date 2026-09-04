export type IdentityConfidence = "confirmed" | "probable" | "uncertain" | "rejected";

export interface IdentityMatch {
  matchScore: number;
  confidence: IdentityConfidence;
  signals: Array<{ signal: string; weight: number; matched: boolean }>;
}

export interface PersonIdentity {
  id: string;
  name: string;
  bio?: string;
  location?: string;
  website?: string;
  socialAccountIds: string[];
  identifiers: Array<{ type: string; value: string }>;
  confidence: IdentityConfidence;
}

export function matchIdentity(
  a: { name: string; bio?: string; location?: string; website?: string; handle?: string },
  b: { name: string; bio?: string; location?: string; website?: string; handle?: string },
): IdentityMatch {
  const signals: Array<{ signal: string; weight: number; matched: boolean }> = [];

  const nameA = a.name.toLowerCase().trim();
  const nameB = b.name.toLowerCase().trim();
  signals.push({
    signal: "name_exact",
    weight: 0.35,
    matched: nameA === nameB,
  });
  signals.push({
    signal: "name_contains",
    weight: 0.15,
    matched: nameA.includes(nameB) || nameB.includes(nameA),
  });

  if (a.handle && b.handle) {
    const hA = a.handle.toLowerCase().replace(/^@/, "");
    const hB = b.handle.toLowerCase().replace(/^@/, "");
    signals.push({
      signal: "handle_exact",
      weight: 0.3,
      matched: hA === hB,
    });
  }

  if (a.location && b.location) {
    const locA = a.location.toLowerCase();
    const locB = b.location.toLowerCase();
    signals.push({
      signal: "location_match",
      weight: 0.1,
      matched: locA === locB || locA.includes(locB) || locB.includes(locA),
    });
  }

  if (a.website && b.website) {
    const domainA = extractDomain(a.website);
    const domainB = extractDomain(b.website);
    signals.push({
      signal: "website_match",
      weight: 0.2,
      matched: domainA !== "" && domainA === domainB,
    });
  }

  if (a.bio && b.bio) {
    const wordsA = new Set(a.bio.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const wordsB = new Set(b.bio.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const overlap = [...wordsA].filter((w) => wordsB.has(w)).length;
    const maxWords = Math.max(wordsA.size, wordsB.size, 1);
    signals.push({
      signal: "bio_similarity",
      weight: 0.1,
      matched: overlap / maxWords > 0.3,
    });
  }

  let weightedScore = 0;
  let totalWeight = 0;
  for (const s of signals) {
    totalWeight += s.weight;
    if (s.matched) weightedScore += s.weight;
  }
  const matchScore = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;

  let confidence: IdentityConfidence;
  if (matchScore >= 90) confidence = "confirmed";
  else if (matchScore >= 70) confidence = "probable";
  else if (matchScore >= 40) confidence = "uncertain";
  else confidence = "rejected";

  return { matchScore, confidence, signals };
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function shouldAutoMerge(match: IdentityMatch): boolean {
  return match.confidence === "confirmed" && match.matchScore >= 95;
}
