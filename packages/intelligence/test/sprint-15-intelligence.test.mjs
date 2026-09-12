import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeContent,
  buildContentDna,
  detectOpportunity,
  detectTrends,
  rankOpportunities,
} from "../dist/index.js";

const completeSignals = {
  freshness: 90,
  semanticRelevance: 85,
  networkValue: 70,
  commercialRelevance: 55,
  conversationSaturation: 20,
  authorRelevance: 60,
  interactionAccessibility: 80,
  velocity: 30,
  confidence: 75,
};

test("Sprint 15 opportunity radar treats UNKNOWN as weak evidence and preserves provenance", () => {
  const unknown = detectOpportunity(
    "commercial_intent",
    { ...completeSignals, commercialRelevance: "UNKNOWN" },
    {
      title: "Procurement signal",
      evidence: ["post:x:123"],
      evaluationTimestamp: "2032-01-10T00:00:00.000Z",
      signalObservedAt: "2032-01-09T00:00:00.000Z",
      freshnessWindowMs: 7 * 24 * 60 * 60 * 1000,
      policy: { key: "opportunity-default", version: "v1" },
      sourceIdentity: "x:acct-1",
    },
  );
  assert.equal(unknown.doNotEngage, true);
  assert.match(unknown.doNotEngageReason, /Unknown required signals/);
  assert.deepEqual(unknown.provenance.unknownSignals, ["commercialRelevance"]);
  assert.equal(unknown.detectedAt, "2032-01-10T00:00:00.000Z");
  assert.equal(unknown.policy.version, "v1");

  const zero = detectOpportunity(
    "commercial_intent",
    { ...completeSignals, commercialRelevance: 0 },
    {
      title: "Zero commercial relevance is explicit",
      evaluationTimestamp: "2032-01-10T00:00:00.000Z",
      signalObservedAt: "2032-01-10T00:00:00.000Z",
    },
  );
  assert.equal(zero.provenance.unknownSignals.length, 0);
  assert.equal(zero.doNotEngage, false);

  assert.throws(
    () =>
      detectOpportunity("trend", completeSignals, {
        evaluationTimestamp: "2032-01-10T00:00:00.000Z",
        signalObservedAt: "2032-01-11T00:00:00.000Z",
      }),
    /signalObservedAt/,
  );
});

test("Sprint 15 opportunity ranking is stable for score ties", () => {
  const a = detectOpportunity("trend", completeSignals, {
    title: "Beta",
    evaluationTimestamp: "2032-01-10T00:00:00.000Z",
  });
  const b = detectOpportunity("trend", completeSignals, {
    title: "Alpha",
    evaluationTimestamp: "2032-01-10T00:00:00.000Z",
  });
  assert.deepEqual(
    rankOpportunities([a, b]).map((item) => item.title),
    ["Alpha", "Beta"],
  );
});

test("Sprint 15 trends exclude future, stale, deleted, malformed, duplicate and mixed metrics", () => {
  const points = new Map([
    [
      "AI agents",
      [
        {
          timestamp: "2032-01-01T00:00:00.000Z",
          volume: 10,
          sourceId: "a",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-02T00:00:00.000Z",
          volume: 11,
          sourceId: "b",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-03T00:00:00.000Z",
          volume: 12,
          sourceId: "c",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-08T00:00:00.000Z",
          volume: 20,
          sourceId: "d",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-09T00:00:00.000Z",
          volume: 35,
          sourceId: "e",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-09T00:00:00.000Z",
          volume: 35,
          sourceId: "e",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-10T00:00:00.000Z",
          volume: 40,
          sourceId: "f",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-11T00:00:00.000Z",
          volume: 100,
          sourceId: "future",
          platform: "x",
          metricKind: "count",
        },
        {
          timestamp: "2032-01-08T00:00:00.000Z",
          volume: 99,
          sourceId: "deleted",
          platform: "x",
          metricKind: "count",
          deleted: true,
        },
        {
          timestamp: "2032-01-08T00:00:00.000Z",
          volume: 99,
          sourceId: "views",
          platform: "x",
          metricKind: "view",
        },
        { timestamp: "bad-date", volume: 99, sourceId: "bad", platform: "x", metricKind: "count" },
      ],
    ],
  ]);

  const trends = detectTrends(points, {
    evaluationTimestamp: "2032-01-10T00:00:00.000Z",
    windowMs: 10 * 24 * 60 * 60 * 1000,
    metricKind: "count",
    minDataPoints: 3,
  });
  assert.equal(trends.length, 1);
  assert.equal(trends[0].id, "trend_ai-agents_count_2032-01-10T00:00:00.000Z");
  assert.equal(
    trends[0].dataPoints.some((point) => point.sourceId === "future"),
    false,
  );
  assert.equal(
    trends[0].dataPoints.some((point) => point.sourceId === "deleted"),
    false,
  );
  assert.equal(
    trends[0].dataPoints.some((point) => point.metricKind === "view"),
    false,
  );
  assert.equal(trends[0].completeness.includedPoints, 6);
  assert.equal(trends[0].detectedAt, "2032-01-10T00:00:00.000Z");
});

test("Sprint 15 content intelligence prefers structured semantics and separates zero from unknown metrics", () => {
  const structured = analyzeContent(
    "generic generic words without taxonomy",
    "post",
    { likes: 0, comments: "UNKNOWN", shares: 0, impressions: "UNKNOWN", engagementRate: 0 },
    {
      structuredTopics: ["AI", "Automation", "ai"],
      contentId: "post-1",
      platform: "linkedin",
      authorId: "acct-1",
      evaluationTimestamp: "2032-01-10T00:00:00.000Z",
    },
  );
  assert.deepEqual(structured.topics, ["ai", "automation"]);
  assert.equal(structured.provenance.semanticSource, "structured");
  assert.deepEqual(structured.provenance.unknownMetrics, ["comments", "impressions"]);
  assert.equal(structured.performanceState, "partial");

  const duplicate = analyzeContent(
    "AI automation launch",
    "post",
    { likes: 5, comments: 1, shares: 1, impressions: 100, engagementRate: 0.07 },
    {
      structuredTopics: ["ai"],
      contentId: "post-1",
      platform: "linkedin",
      evaluationTimestamp: "2032-01-10T00:00:00.000Z",
    },
  );
  const unique = analyzeContent(
    "AI automation launch",
    "post",
    { likes: 6, comments: 1, shares: 1, impressions: 100, engagementRate: 0.08 },
    {
      structuredTopics: ["automation"],
      contentId: "post-2",
      platform: "linkedin",
      evaluationTimestamp: "2032-01-10T00:00:00.000Z",
    },
  );
  const dna = buildContentDna([structured, duplicate, unique]);
  assert.equal(dna.contentVolume, 2);
  assert.throws(
    () => analyzeContent("removed", "post", undefined, { deleted: true }),
    /Deleted content/,
  );
});
