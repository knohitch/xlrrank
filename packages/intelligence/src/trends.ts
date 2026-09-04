export interface TrendDataPoint {
  timestamp: string;
  volume: number;
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
}

export function detectTrends(
  topicVolumes: Map<string, TrendDataPoint[]>,
  options?: { minDataPoints?: number; velocityThreshold?: number },
): DetectedTrend[] {
  const minPoints = options?.minDataPoints ?? 3;
  const velocityThreshold = options?.velocityThreshold ?? 5;
  const trends: DetectedTrend[] = [];

  for (const [topic, points] of topicVolumes) {
    if (points.length < minPoints) continue;

    const sorted = [...points].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const recent = sorted.slice(-3);
    const older = sorted.slice(0, -3);

    const recentAvg = recent.reduce((s, p) => s + p.volume, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((s, p) => s + p.volume, 0) / older.length : recentAvg;

    const velocity = recentAvg - olderAvg;
    const velocityPercent = olderAvg > 0 ? (velocity / olderAvg) * 100 : velocity > 0 ? 100 : 0;

    const prevAvg = sorted.length > 3
      ? sorted.slice(-6, -3).reduce((s, p) => s + p.volume, 0) / Math.max(sorted.slice(-6, -3).length, 1)
      : olderAvg;
    const prevVelocity = prevAvg > 0 ? ((olderAvg - prevAvg) / prevAvg) * 100 : 0;
    const acceleration = velocityPercent - prevVelocity;

    if (Math.abs(velocityPercent) < velocityThreshold) continue;

    let status: DetectedTrend["status"];
    if (velocityPercent > 20 && acceleration > 0) status = "emerging";
    else if (velocityPercent > 5) status = "growing";
    else if (velocityPercent < -10) status = "declining";
    else status = "stable";

    const explanation = buildTrendExplanation(topic, velocityPercent, acceleration, status, recentAvg);

    trends.push({
      id: `trend_${topic}_${Date.now()}`,
      topic,
      scope: "global",
      velocity: Math.round(velocityPercent),
      acceleration: Math.round(acceleration),
      status,
      dataPoints: sorted,
      explanation,
      detectedAt: new Date().toISOString(),
    });
  }

  return trends.sort((a, b) => Math.abs(b.velocity) - Math.abs(a.velocity));
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
