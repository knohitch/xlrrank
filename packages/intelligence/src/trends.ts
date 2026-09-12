export interface TrendDataPoint {
  timestamp: string;
  volume: number;
  sourceId?: string;
  platform?: string;
  metricKind?: "count" | "reaction" | "share" | "comment" | "view" | "unknown";
  deleted?: boolean;
}

export interface DetectedTrend {
  id: string;
  topic: string;
  scope: "global" | "network";
  velocity: number;
  acceleration: number;
  status: "emerging" | "growing" | "stable" | "declining";
  dataPoints: TrendDataPoint[];
  explanation: string;
  detectedAt: string;
  completeness: {
    includedPoints: number;
    excludedPoints: number;
    metricKind: string;
  };
}

export function detectTrends(
  topicVolumes: Map<string, TrendDataPoint[]>,
  options?: {
    minDataPoints?: number;
    velocityThreshold?: number;
    evaluationTimestamp?: string;
    windowMs?: number;
    metricKind?: TrendDataPoint["metricKind"];
  },
): DetectedTrend[] {
  const minPoints = options?.minDataPoints ?? 3;
  const velocityThreshold = options?.velocityThreshold ?? 5;
  const evaluationTime = parseTimestamp(
    options?.evaluationTimestamp ?? new Date().toISOString(),
    "evaluationTimestamp",
  );
  const trends: DetectedTrend[] = [];

  for (const [topic, points] of topicVolumes) {
    const { included, excluded } = normalizeTrendPoints(points, evaluationTime, options);
    if (included.length < minPoints) continue;

    const sorted = [...included].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() ||
        (a.sourceId ?? "").localeCompare(b.sourceId ?? "") ||
        (a.platform ?? "").localeCompare(b.platform ?? ""),
    );

    const recent = sorted.slice(-3);
    const older = sorted.slice(0, -3);

    const recentAvg = recent.reduce((s, p) => s + p.volume, 0) / recent.length;
    const olderAvg =
      older.length > 0 ? older.reduce((s, p) => s + p.volume, 0) / older.length : recentAvg;

    const velocity = recentAvg - olderAvg;
    const velocityPercent = olderAvg > 0 ? (velocity / olderAvg) * 100 : velocity > 0 ? 100 : 0;

    const prevAvg =
      sorted.length > 3
        ? sorted.slice(-6, -3).reduce((s, p) => s + p.volume, 0) /
          Math.max(sorted.slice(-6, -3).length, 1)
        : olderAvg;
    const prevVelocity = prevAvg > 0 ? ((olderAvg - prevAvg) / prevAvg) * 100 : 0;
    const acceleration = velocityPercent - prevVelocity;

    if (Math.abs(velocityPercent) < velocityThreshold) continue;

    let status: DetectedTrend["status"];
    if (velocityPercent > 20 && acceleration > 0) status = "emerging";
    else if (velocityPercent > 5) status = "growing";
    else if (velocityPercent < -10) status = "declining";
    else status = "stable";

    const explanation = buildTrendExplanation(
      topic,
      velocityPercent,
      acceleration,
      status,
      recentAvg,
    );

    trends.push({
      id: trendId(topic, evaluationTime, options?.metricKind),
      topic,
      scope: "global",
      velocity: Math.round(velocityPercent),
      acceleration: Math.round(acceleration),
      status,
      dataPoints: sorted,
      explanation,
      detectedAt: evaluationTime.toISOString(),
      completeness: {
        includedPoints: included.length,
        excludedPoints: excluded,
        metricKind: options?.metricKind ?? sorted[0]?.metricKind ?? "count",
      },
    });
  }

  return trends.sort(
    (a, b) =>
      Math.abs(b.velocity) - Math.abs(a.velocity) ||
      b.acceleration - a.acceleration ||
      a.topic.localeCompare(b.topic),
  );
}

function buildTrendExplanation(
  topic: string,
  velocity: number,
  acceleration: number,
  status: string,
  volume: number,
): string {
  const direction = velocity > 0 ? "increased" : "decreased";
  const magnitude = Math.abs(velocity) > 50 ? "sharply" : "moderately";
  return (
    `Discussion around "${topic}" has ${magnitude} ${direction} ` +
    `(${Math.round(Math.abs(velocity))}% change, volume: ${Math.round(volume)}). ` +
    `Status: ${status}. Acceleration: ${acceleration > 0 ? "+" : ""}${Math.round(acceleration)}%.`
  );
}

function normalizeTrendPoints(
  points: TrendDataPoint[],
  evaluationTime: Date,
  options?: {
    windowMs?: number;
    metricKind?: TrendDataPoint["metricKind"];
  },
): { included: TrendDataPoint[]; excluded: number } {
  const deduped = new Map<string, TrendDataPoint>();
  let excluded = 0;

  for (const point of points) {
    if (point.deleted) {
      excluded += 1;
      continue;
    }
    const timestamp = safeTimestamp(point.timestamp);
    if (!timestamp) {
      excluded += 1;
      continue;
    }
    if (timestamp.getTime() > evaluationTime.getTime()) {
      excluded += 1;
      continue;
    }
    if (
      options?.windowMs !== undefined &&
      evaluationTime.getTime() - timestamp.getTime() > options.windowMs
    ) {
      excluded += 1;
      continue;
    }
    if (!Number.isFinite(point.volume) || point.volume < 0) {
      excluded += 1;
      continue;
    }
    if (options?.metricKind && point.metricKind && point.metricKind !== options.metricKind) {
      excluded += 1;
      continue;
    }
    const key = point.sourceId
      ? `${point.platform ?? "unknown"}:${point.sourceId}`
      : `${point.timestamp}:${point.volume}`;
    const existing = deduped.get(key);
    if (
      !existing ||
      parseTimestamp(existing.timestamp, "point.timestamp").getTime() < timestamp.getTime()
    ) {
      deduped.set(key, point);
    } else {
      excluded += 1;
    }
  }

  return { included: [...deduped.values()], excluded };
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function safeTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function trendId(topic: string, evaluationTime: Date, metricKind?: string): string {
  const normalizedTopic = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `trend_${normalizedTopic || "unknown"}_${metricKind ?? "count"}_${evaluationTime.toISOString()}`;
}
