export interface ContentAnalysis {
  topics: string[];
  format: string;
  tone: string;
  archetype: string;
  performance: ContentPerformance;
  quality: number;
}

export interface ContentPerformance {
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
  engagementRate: number;
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
): ContentAnalysis {
  const words = body.toLowerCase().split(/\s+/);
  const topicFreq = new Map<string, number>();
  for (const word of words) {
    if (word.length > 4) {
      topicFreq.set(word, (topicFreq.get(word) ?? 0) + 1);
    }
  }
  const topics = [...topicFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  const format = detectFormat(body, contentType);
  const tone = detectTone(body);
  const archetype = detectArchetype(body, format);

  const defaultPerf: ContentPerformance = {
    likes: 0, comments: 0, shares: 0, impressions: 0, engagementRate: 0,
  };
  const perf = performance ?? defaultPerf;
  const quality = computeContentQuality(body, perf);

  return { topics, format, tone, archetype, performance: perf, quality };
}

function detectFormat(body: string, contentType?: string): string {
  if (contentType) return contentType;
  const lines = body.split("\n");
  if (lines.length > 5 && lines.some((l) => l.startsWith("- ") || l.startsWith("* "))) return "thread";
  if (body.length > 1000) return "article";
  if (body.includes("?")) return "question";
  return "short_post";
}

function detectTone(body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("!") && (lower.includes("amazing") || lower.includes("excited"))) return "enthusiastic";
  if (lower.includes("?") && lower.split("?").length > 2) return "inquisitive";
  if (lower.includes("tip") || lower.includes("how to") || lower.includes("guide")) return "educational";
  if (lower.includes("i think") || lower.includes("in my opinion")) return "opinionated";
  return "neutral";
}

function detectArchetype(body: string, format: string): string {
  if (format === "thread") return "educator";
  if (body.includes("http")) return "curator";
  if (body.includes("?")) return "conversation_starter";
  return "commentator";
}

function computeContentQuality(body: string, perf: ContentPerformance): number {
  let score = 0;
  score += Math.min(30, body.length / 20);
  score += Math.min(30, perf.engagementRate * 100);
  score += Math.min(20, (perf.likes + perf.comments + perf.shares) / 5);
  score += Math.min(20, perf.impressions / 100);
  return Math.round(Math.min(100, score));
}

export function buildContentDna(analyses: ContentAnalysis[]): ContentDna {
  const topicFreq = new Map<string, number>();
  const formatFreq = new Map<string, number>();
  let totalQuality = 0;
  const topicPerformance = new Map<string, number>();

  for (const a of analyses) {
    for (const t of a.topics) {
      topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
      topicPerformance.set(t, (topicPerformance.get(t) ?? 0) + a.quality);
    }
    formatFreq.set(a.format, (formatFreq.get(a.format) ?? 0) + 1);
    totalQuality += a.quality;
  }

  const primaryTopics = [...topicFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  const primaryFormats = [...formatFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f]) => f);

  const bestPerformingTopics = [...topicPerformance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  return {
    primaryTopics,
    primaryFormats,
    averageTone: "neutral",
    averageQuality: analyses.length > 0 ? Math.round(totalQuality / analyses.length) : 0,
    contentVolume: analyses.length,
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
