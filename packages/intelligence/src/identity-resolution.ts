import { createHash } from "node:crypto";

export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW" | "REJECTED";
export type IdentityDecisionStatus = "PENDING" | "LINKED" | "REJECTED" | "SPLIT";

export interface IdentityAccountInput {
  id?: string;
  platformId?: string;
  externalId?: string;
  name?: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  handle?: string | null;
  company?: string | null;
  role?: string | null;
  profileUrl?: string | null;
  topics?: string[];
}

export interface IdentitySignalPolicy {
  key: string;
  weight: number;
  threshold?: number | undefined;
}

export interface IdentityResolutionPolicy {
  policyKey: string;
  version: string;
  autoLinkThreshold: number;
  manualReviewThreshold: number;
  minimumPositiveSignals: number;
  contradictionPenalty: number;
  signals: IdentitySignalPolicy[];
}

export interface IdentityMatchSignal {
  key: string;
  matched: boolean;
  weight: number;
  contribution: number;
  description: string;
}

export interface IdentityContradiction {
  key: string;
  penalty: number;
  description: string;
}

export interface IdentityMatch {
  matchScore: number;
  confidence: IdentityConfidence;
  recommendedStatus: IdentityDecisionStatus;
  signals: IdentityMatchSignal[];
  contradictions: IdentityContradiction[];
  evidenceFingerprint: string;
  policyKey: string;
  policyVersion: string;
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

const SUPPORTED_SIGNALS = new Set([
  "name_similarity",
  "handle_similarity",
  "company_match",
  "role_match",
  "website_domain_match",
  "profile_crosslink",
  "location_match",
  "bio_similarity",
  "topic_similarity",
]);

export function validateIdentityResolutionPolicy(policy: IdentityResolutionPolicy): IdentityResolutionPolicy {
  assertThreshold(policy.autoLinkThreshold, "autoLinkThreshold");
  assertThreshold(policy.manualReviewThreshold, "manualReviewThreshold");
  if (policy.manualReviewThreshold > policy.autoLinkThreshold) {
    throw new Error("manualReviewThreshold cannot exceed autoLinkThreshold");
  }
  if (!Number.isInteger(policy.minimumPositiveSignals) || policy.minimumPositiveSignals < 1) {
    throw new Error("minimumPositiveSignals must be a positive integer");
  }
  assertFiniteNonnegative(policy.contradictionPenalty, "contradictionPenalty");
  const seen = new Set<string>();
  for (const signal of policy.signals) {
    if (!SUPPORTED_SIGNALS.has(signal.key)) throw new Error(`Unsupported identity signal '${signal.key}'`);
    if (seen.has(signal.key)) throw new Error(`Duplicate identity signal '${signal.key}'`);
    seen.add(signal.key);
    assertFiniteNonnegative(signal.weight, `signals.${signal.key}.weight`);
    if (signal.threshold !== undefined) assertThreshold(signal.threshold, `signals.${signal.key}.threshold`);
  }
  return policy;
}

export function matchIdentity(
  a: IdentityAccountInput,
  b: IdentityAccountInput,
  policy: IdentityResolutionPolicy,
): IdentityMatch {
  const resolvedPolicy = validateIdentityResolutionPolicy(policy);
  const signals = resolvedPolicy.signals.map((signal) => evaluateSignal(signal, a, b));
  const contradictions = detectContradictions(a, b, resolvedPolicy.contradictionPenalty);
  const totalWeight = resolvedPolicy.signals.reduce((sum, signal) => sum + signal.weight, 0);
  const positiveSignalCount = signals.filter((signal) => signal.matched && signal.weight > 0).length;
  const weightedScore = signals.reduce((sum, signal) => sum + signal.contribution, 0);
  const contradictionPenalty = contradictions.reduce((sum, item) => sum + item.penalty, 0);
  const normalized = totalWeight > 0 ? ((weightedScore - contradictionPenalty) / totalWeight) * 100 : 0;
  const matchScore = Math.max(0, Math.min(100, Number(normalized.toFixed(4))));
  const confidence = confidenceForScore(matchScore, positiveSignalCount, resolvedPolicy);
  return {
    matchScore,
    confidence,
    recommendedStatus: confidence === "HIGH" ? "LINKED" : confidence === "REJECTED" ? "REJECTED" : "PENDING",
    signals,
    contradictions,
    evidenceFingerprint: fingerprint({ a: normalizedAccount(a), b: normalizedAccount(b), policy: resolvedPolicy }),
    policyKey: resolvedPolicy.policyKey,
    policyVersion: resolvedPolicy.version,
  };
}

export function shouldAutoMerge(match: IdentityMatch, policy: IdentityResolutionPolicy): boolean {
  const resolvedPolicy = validateIdentityResolutionPolicy(policy);
  return (
    match.confidence === "HIGH" &&
    match.matchScore >= resolvedPolicy.autoLinkThreshold &&
    match.signals.filter((signal) => signal.matched && signal.weight > 0).length >= resolvedPolicy.minimumPositiveSignals
  );
}

export function orderedPair(a: string, b: string): [string, string] {
  if (a === b) throw new Error("Identity resolution cannot compare an account with itself");
  return a < b ? [a, b] : [b, a];
}

function evaluateSignal(policy: IdentitySignalPolicy, a: IdentityAccountInput, b: IdentityAccountInput): IdentityMatchSignal {
  const result = signalMatched(policy, a, b);
  return {
    key: policy.key,
    matched: result.matched,
    weight: policy.weight,
    contribution: result.matched ? policy.weight : 0,
    description: result.description,
  };
}

function signalMatched(
  policy: IdentitySignalPolicy,
  a: IdentityAccountInput,
  b: IdentityAccountInput,
): { matched: boolean; description: string } {
  const key = policy.key;
  if (key === "name_similarity") {
    const similarity = textSimilarity(a.name, b.name);
    return thresholdMatch("normalized display-name similarity", similarity, policy.threshold);
  }
  if (key === "handle_similarity") {
    const similarity = textSimilarity(normalizeHandle(a.handle), normalizeHandle(b.handle));
    return thresholdMatch("normalized handle similarity", similarity, policy.threshold);
  }
  if (key === "company_match") return exactTextMatch(key, a.company, b.company);
  if (key === "role_match") return exactTextMatch(key, a.role, b.role);
  if (key === "website_domain_match") {
    const left = domain(a.website);
    const right = domain(b.website);
    return { matched: Boolean(left && right && left === right), description: `website domains ${left || "unknown"} / ${right || "unknown"}` };
  }
  if (key === "profile_crosslink") {
    const left = normalizeUrl(a.profileUrl);
    const right = normalizeUrl(b.profileUrl);
    const bioA = (a.bio ?? "").toLowerCase();
    const bioB = (b.bio ?? "").toLowerCase();
    return {
      matched: Boolean((left && bioB.includes(left)) || (right && bioA.includes(right))),
      description: "public profile link appears in opposite profile evidence",
    };
  }
  if (key === "location_match") return exactTextMatch(key, a.location, b.location);
  if (key === "bio_similarity") {
    const similarity = tokenJaccard(a.bio, b.bio);
    return thresholdMatch("bio token similarity", similarity, policy.threshold);
  }
  if (key === "topic_similarity") {
    const similarity = setJaccard(new Set(a.topics ?? []), new Set(b.topics ?? []));
    return thresholdMatch("topic similarity", similarity, policy.threshold);
  }
  throw new Error(`Unsupported identity signal '${key}'`);
}

function thresholdMatch(
  label: string,
  value: number,
  configuredThreshold: number | undefined,
): { matched: boolean; description: string } {
  if (configuredThreshold === undefined) {
    return { matched: value > 0, description: `${label} ${value.toFixed(4)} above structural zero threshold` };
  }
  return { matched: value >= configuredThreshold, description: `${label} ${value.toFixed(4)} threshold ${configuredThreshold.toFixed(4)}` };
}

function detectContradictions(
  a: IdentityAccountInput,
  b: IdentityAccountInput,
  penalty: number,
): IdentityContradiction[] {
  const contradictions: IdentityContradiction[] = [];
  if (domain(a.website) && domain(b.website) && domain(a.website) !== domain(b.website)) {
    contradictions.push({ key: "website_domain_conflict", penalty, description: "public websites use different domains" });
  }
  if (normalizedText(a.company) && normalizedText(b.company) && normalizedText(a.company) !== normalizedText(b.company)) {
    contradictions.push({ key: "company_conflict", penalty, description: "declared companies differ" });
  }
  if (normalizedText(a.location) && normalizedText(b.location) && normalizedText(a.location) !== normalizedText(b.location)) {
    contradictions.push({ key: "location_conflict", penalty, description: "declared locations differ" });
  }
  return contradictions;
}

function confidenceForScore(
  score: number,
  positiveSignalCount: number,
  policy: IdentityResolutionPolicy,
): IdentityConfidence {
  if (positiveSignalCount < policy.minimumPositiveSignals) return score >= policy.manualReviewThreshold ? "MEDIUM" : "LOW";
  if (score >= policy.autoLinkThreshold) return "HIGH";
  if (score >= policy.manualReviewThreshold) return "MEDIUM";
  return "LOW";
}

function exactTextMatch(key: string, a?: string | null, b?: string | null): { matched: boolean; description: string } {
  const left = normalizedText(a);
  const right = normalizedText(b);
  return { matched: Boolean(left && right && left === right), description: `${key}: ${left || "unknown"} / ${right || "unknown"}` };
}

function normalizedText(value?: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeHandle(value?: string | null): string {
  return normalizedText(value).replace(/^@/, "");
}

function normalizeUrl(value?: string | null): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return normalizedText(value);
  }
}

function domain(value?: string | null): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function textSimilarity(a?: string | null, b?: string | null): number {
  const left = normalizedText(a);
  const right = normalizedText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return tokenJaccard(left, right);
}

function tokenJaccard(a?: string | null, b?: string | null): number {
  return setJaccard(tokens(a), tokens(b));
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokens(value?: string | null): Set<string> {
  return new Set(normalizedText(value).split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function normalizedAccount(account: IdentityAccountInput): Record<string, unknown> {
  return {
    id: account.id,
    platformId: account.platformId,
    externalId: account.externalId,
    name: normalizedText(account.name),
    bio: normalizedText(account.bio),
    location: normalizedText(account.location),
    website: domain(account.website),
    handle: normalizeHandle(account.handle),
    company: normalizedText(account.company),
    role: normalizedText(account.role),
    profileUrl: normalizeUrl(account.profileUrl),
    topics: [...(account.topics ?? [])].sort(),
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function assertThreshold(value: unknown, path: string): asserts value is number {
  assertFiniteNonnegative(value, path);
  if ((value as number) > 100) throw new Error(`${path} must be <= 100`);
}

function assertFiniteNonnegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite nonnegative number`);
  }
}
