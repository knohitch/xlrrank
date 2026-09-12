export interface ContentAnalysis {
  topics: string[];
  format: string;
  tone: string;
  archetype: string;
  performance: ContentPerformance;
  performanceState: "complete" | "partial" | "unknown";
  quality: number;
  provenance: {
    contentId?: string;
    platform?: string;
    authorId?: string;
    semanticSource: "structured" | "text";
    evaluatedAt: string;
    unknownMetrics: string[];
  };
}

export type MetricValue = number | "UNKNOWN" | null | undefined;

export interface ContentPerformance {
  likes: MetricValue;
  comments: MetricValue;
  shares: MetricValue;
  impressions: MetricValue;
  engagementRate: MetricValue;
}

export interface ContentDna {
  primaryTopics: string[];
  primaryFormats: string[];
  averageTone: string;
  averageQuality: number;
  contentVolume: number;
  bestPerformingTopics: string[];
}

export interface ContentGap {
  topic: string;
  angle: string;
  whyNow: string;
  recommendedFormat: string;
  evidence: string[];
  score: number;
}

export function analyzeContent(
  body: string,
  contentType?: string,
  performance?: ContentPerformance,
  options?: {
    structuredTopics?: string[];
    contentId?: string;
    platform?: string;
    authorId?: string;
    evaluationTimestamp?: string;
    deleted?: boolean;
  },
): ContentAnalysis {
  if (options?.deleted)
    throw new Error("Deleted content cannot be analyzed as current content intelligence");
  const evaluatedAt = parseTimestamp(
    options?.evaluationTimestamp ?? new Date().toISOString(),
    "evaluationTimestamp",
  );
  const structuredTopics = normalizeTopics(options?.structuredTopics ?? []);
  const words = body.toLowerCase().split(/\s+/);
  const topicFreq = new Map<string, number>();
  for (const word of words) {
    if (word.length > 4) {
      topicFreq.set(word, (topicFreq.get(word) ?? 0) + 1);
    }
  }
  const topics =
    structuredTopics.length > 0
      ? structuredTopics
      : [...topicFreq.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([w]) => w);

  const format = detectFormat(body, contentType);
  const tone = detectTone(body);
  const archetype = detectArchetype(body, format);

  const defaultPerf: Required<ContentPerformance> = {
    likes: "UNKNOWN",
    comments: "UNKNOWN",
    shares: "UNKNOWN",
    impressions: "UNKNOWN",
    engagementRate: "UNKNOWN",
  };
  const perf = normalizePerformance(performance ?? defaultPerf);
  const quality = computeContentQuality(body, perf);

  return {
    topics,
    format,
    tone,
    archetype,
    performance: perf.values,
    performanceState:
      perf.unknownMetrics.length === 0
        ? "complete"
        : perf.unknownMetrics.length === 5
          ? "unknown"
          : "partial",
    quality,
    provenance: {
      ...(options?.contentId ? { contentId: options.contentId } : {}),
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.authorId ? { authorId: options.authorId } : {}),
      semanticSource: structuredTopics.length > 0 ? "structured" : "text",
      evaluatedAt: evaluatedAt.toISOString(),
      unknownMetrics: perf.unknownMetrics,
    },
  };
}

function detectFormat(body: string, contentType?: string): string {
  if (contentType) return contentType;
  const lines = body.split("\n");
  if (lines.length > 5 && lines.some((l) => l.startsWith("- ") || l.startsWith("* ")))
    return "thread";
  if (body.length > 1000) return "article";
  if (body.includes("?")) return "question";
  return "short_post";
}

function detectTone(body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("!") && (lower.includes("amazing") || lower.includes("excited")))
    return "enthusiastic";
  if (lower.includes("?") && lower.split("?").length > 2) return "inquisitive";
  if (lower.includes("tip") || lower.includes("how to") || lower.includes("guide"))
    return "educational";
  if (lower.includes("i think") || lower.includes("in my opinion")) return "opinionated";
  return "neutral";
}

function detectArchetype(body: string, format: string): string {
  if (format === "thread") return "educator";
  if (body.includes("http")) return "curator";
  if (body.includes("?")) return "conversation_starter";
  return "commentator";
}

function computeContentQuality(
  body: string,
  perf: { values: Required<Record<keyof ContentPerformance, number>>; unknownMetrics: string[] },
): number {
  let score = 0;
  score += Math.min(30, body.length / 20);
  if (!perf.unknownMetrics.includes("engagementRate"))
    score += Math.min(30, perf.values.engagementRate * 100);
  const knownEngagementMetrics = ["likes", "comments", "shares"].filter(
    (key) => !perf.unknownMetrics.includes(key),
  );
  if (knownEngagementMetrics.length > 0) {
    const engagementTotal = knownEngagementMetrics.reduce(
      (sum, key) => sum + perf.values[key as "likes" | "comments" | "shares"],
      0,
    );
    score += Math.min(20, engagementTotal / 5);
  }
  if (!perf.unknownMetrics.includes("impressions"))
    score += Math.min(20, perf.values.impressions / 100);
  return Math.round(Math.min(100, score));
}

export function buildContentDna(analyses: ContentAnalysis[]): ContentDna {
  const topicFreq = new Map<string, number>();
  const formatFreq = new Map<string, number>();
  let totalQuality = 0;
  let includedAnalyses = 0;
  const topicPerformance = new Map<string, number>();
  const seenContent = new Set<string>();

  for (const a of analyses) {
    const uniqueContentKey = a.provenance.contentId
      ? `${a.provenance.platform ?? "unknown"}:${a.provenance.contentId}`
      : undefined;
    if (uniqueContentKey && seenContent.has(uniqueContentKey)) continue;
    if (uniqueContentKey) seenContent.add(uniqueContentKey);
    includedAnalyses += 1;
    for (const t of a.topics) {
      topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
      topicPerformance.set(t, (topicPerformance.get(t) ?? 0) + a.quality);
    }
    formatFreq.set(a.format, (formatFreq.get(a.format) ?? 0) + 1);
    totalQuality += a.quality;
  }

  const primaryTopics = [...topicFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([t]) => t);

  const primaryFormats = [...formatFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([f]) => f);

  const bestPerformingTopics = [...topicPerformance.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([t]) => t);

  return {
    primaryTopics,
    primaryFormats,
    averageTone: "neutral",
    averageQuality: includedAnalyses > 0 ? Math.round(totalQuality / includedAnalyses) : 0,
    contentVolume: includedAnalyses,
    bestPerformingTopics,
  };
}

export function findContentGaps(
  userDna: ContentDna,
  marketTopics: string[],
  lowSaturationTopics: string[],
): ContentGap[] {
  const gaps: ContentGap[] = [];

  for (const marketTopic of marketTopics) {
    const inExpertise = userDna.primaryTopics.some(
      (t) => t.includes(marketTopic) || marketTopic.includes(t),
    );
    const isLowSaturation = lowSaturationTopics.includes(marketTopic);

    if (inExpertise || isLowSaturation) {
      gaps.push({
        topic: marketTopic,
        angle: inExpertise
          ? `Share your expertise on ${marketTopic}`
          : `First-mover content on ${marketTopic}`,
        whyNow: isLowSaturation
          ? "Low competition in this topic area"
          : "High market interest with your unique perspective",
        recommendedFormat: userDna.primaryFormats[0] ?? "short_post",
        evidence: [
          inExpertise ? "Matches your content expertise" : "Market demand signal",
          isLowSaturation ? "Low content saturation" : "Audience interest confirmed",
        ],
        score: (inExpertise ? 50 : 0) + (isLowSaturation ? 50 : 20),
      });
    }
  }

  return gaps.sort((a, b) => b.score - a.score);
}

function normalizePerformance(performance: ContentPerformance): {
  values: Required<Record<keyof ContentPerformance, number>>;
  unknownMetrics: string[];
} {
  const values = {} as Required<Record<keyof ContentPerformance, number>>;
  const unknownMetrics: string[] = [];
  for (const key of ["likes", "comments", "shares", "impressions", "engagementRate"] as Array<
    keyof ContentPerformance
  >) {
    const value = performance[key];
    if (value === "UNKNOWN" || value === null || value === undefined) {
      values[key] = 0;
      unknownMetrics.push(key);
      continue;
    }
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Content metric '${key}' must be finite, nonnegative, or UNKNOWN`);
    values[key] = value;
  }
  return { values, unknownMetrics };
}

function normalizeTopics(topics: string[]): string[] {
  return [...new Set(topics.map((topic) => topic.trim().toLowerCase()).filter(Boolean))].sort();
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}
