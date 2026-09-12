import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../client.js";

type Executor = Pick<Pool | PoolClient, "query">;

export interface DiscoveryPolicy {
  policyKey: string;
  version: string;
  components: Array<{ key: string; weight: number }>;
  minimumEvidence: number;
  minimumScore?: number | undefined;
  resultLimit?: number | undefined;
  freshness?: { windowDays: number } | undefined;
}

export interface RelationshipIntelligencePolicy {
  policyKey: string;
  version: string;
  interactionWeights: Record<string, number>;
  recency?: { windowDays: number; minimumMultiplier: number } | undefined;
  frequency?: { maxCount: number; weight: number } | undefined;
  strengthBands: Array<{ key: string; minimumScore: number }>;
  minimumEvidence: number;
}

export interface PersistDiscoveryPolicyInput {
  policy: DiscoveryPolicy;
  active?: boolean | undefined;
}

export interface PersistRelationshipIntelligencePolicyInput {
  policy: RelationshipIntelligencePolicy;
  active?: boolean | undefined;
}

export interface RecomputeRelationshipInput {
  scopeId: string;
  policyKey: string;
  fromPersonId?: string | undefined;
  toPersonId?: string | undefined;
  evaluationTimestamp: string;
  algorithmVersion?: string | undefined;
}

export interface RelationshipSnapshot {
  snapshotId: string;
  fromPersonId: string;
  toPersonId: string;
  score: number;
  strengthLabel: string;
  evidence: RelationshipEvidence[];
  directionalEvidence: RelationshipEvidence[];
  policyVersion: string;
  createdNewVersion: boolean;
}

export interface RelationshipEvidence {
  interactionId: string;
  interactionType: string;
  direction: string;
  fromPersonId: string;
  toPersonId: string;
  occurredAt: string;
  baseWeight: number;
  recencyMultiplier: number;
  contribution: number;
  platformId?: string | undefined;
  providerObjectId?: string | undefined;
}

export interface RecomputeDiscoveryInput {
  scopeId: string;
  policyKey: string;
  subjectPersonId?: string | undefined;
  relationshipPolicyKey?: string | undefined;
  evaluationTimestamp: string;
  algorithmVersion?: string | undefined;
  filters?: DiscoveryFilters | undefined;
}

export interface DiscoveryFilters {
  topics?: string[] | undefined;
  expertise?: string[] | undefined;
  geography?: string[] | undefined;
  excludedPersonIds?: string[] | undefined;
  minimumScore?: number | undefined;
  activeWithinDays?: number | undefined;
}

export interface DiscoverySnapshot {
  snapshotId: string;
  policyVersion: string;
  relationshipPolicyVersion?: string | undefined;
  results: DiscoveryResult[];
  createdNewVersion: boolean;
}

export interface DiscoveryResult {
  personId: string;
  name: string;
  rank: number;
  score: number;
  components: DiscoveryComponentEvidence[];
  evidence: unknown[];
}

export interface DiscoveryComponentEvidence {
  key: string;
  rawScore: number;
  weight: number;
  contribution: number;
  evidence: unknown[];
}

const DISCOVERY_COMPONENTS = new Set([
  "social_dna_similarity",
  "shared_expertise",
  "shared_interests",
  "topic_overlap",
  "geography_alignment",
  "relationship_strength",
  "activity_freshness",
]);

export async function persistDiscoveryPolicy(
  input: PersistDiscoveryPolicyInput,
  executor: Executor = getPool(),
): Promise<string> {
  const policy = validateDiscoveryPolicy(input.policy);
  return persistVersionedPolicy(executor, {
    table: "discovery_policies",
    key: policy.policyKey,
    version: policy.version,
    config: policy,
    active: input.active ?? true,
  });
}

export async function persistRelationshipIntelligencePolicy(
  input: PersistRelationshipIntelligencePolicyInput,
  executor: Executor = getPool(),
): Promise<string> {
  const policy = validateRelationshipPolicy(input.policy);
  return persistVersionedPolicy(executor, {
    table: "relationship_intelligence_policies",
    key: policy.policyKey,
    version: policy.version,
    config: policy,
    active: input.active ?? true,
  });
}

export async function recomputeRelationshipIntelligence(input: RecomputeRelationshipInput): Promise<{
  policyVersion: string;
  snapshots: RelationshipSnapshot[];
}> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`relationship-intelligence:${input.scopeId}:${input.policyKey}`]);
    const policy = await loadActivePolicy<RelationshipIntelligencePolicy>(client, "relationship_intelligence_policies", input.policyKey);
    validateRelationshipPolicy(policy);
    const pairs = await relationshipPairs(client, input);
    const snapshots: RelationshipSnapshot[] = [];
    for (const pair of pairs) {
      const computed = computeRelationship(pair, policy, input.evaluationTimestamp);
      if (computed.evidence.length < policy.minimumEvidence || computed.score <= 0) continue;
      snapshots.push(await persistRelationshipSnapshot(client, input, policy, computed));
    }
    await client.query("COMMIT");
    return { policyVersion: policy.version, snapshots };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recomputeDiscoverySnapshot(input: RecomputeDiscoveryInput): Promise<DiscoverySnapshot> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `discovery:${input.scopeId}:${input.policyKey}:${input.subjectPersonId ?? "all"}`,
    ]);
    const policy = await loadActivePolicy<DiscoveryPolicy>(client, "discovery_policies", input.policyKey);
    validateDiscoveryPolicy(policy);
    const relationshipPolicy = input.relationshipPolicyKey
      ? await loadActivePolicy<RelationshipIntelligencePolicy>(client, "relationship_intelligence_policies", input.relationshipPolicyKey)
      : undefined;
    if (relationshipPolicy) validateRelationshipPolicy(relationshipPolicy);
    const results = scoreDiscovery(await discoveryPeople(client, input.scopeId), await currentRelationships(client, input.scopeId), input, policy);
    const filtered = applyDiscoveryFilters(results, input.filters, policy);
    const snapshot = await persistDiscoverySnapshot(client, input, policy, relationshipPolicy, filtered);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function invalidateIntelligenceForPeople(executor: Executor, scopeId: string, personIds: string[]): Promise<void> {
  const ids = uniqueSorted(personIds);
  if (ids.length === 0) return;
  await executor.query(
    `
      UPDATE relationship_intelligence_snapshots
      SET is_current = false, superseded_at = COALESCE(superseded_at, now())
      WHERE scope_id = $1 AND is_current = true
        AND (from_person_id = ANY($2::uuid[]) OR to_person_id = ANY($2::uuid[]))
    `,
    [scopeId, ids],
  );
  await executor.query(
    `
      UPDATE discovery_snapshots
      SET is_current = false, superseded_at = COALESCE(superseded_at, now())
      WHERE scope_id = $1 AND is_current = true
        AND (
          subject_person_id = ANY($2::uuid[])
          OR EXISTS (
            SELECT 1 FROM discovery_results dr
            WHERE dr.snapshot_id = discovery_snapshots.id
              AND dr.target_person_id = ANY($2::uuid[])
          )
        )
    `,
    [scopeId, ids],
  );
}

function validateDiscoveryPolicy(policy: DiscoveryPolicy): DiscoveryPolicy {
  if (!policy.policyKey || !policy.version) throw new Error("Discovery policy requires policyKey and version");
  if (!Number.isInteger(policy.minimumEvidence) || policy.minimumEvidence < 0) throw new Error("minimumEvidence must be a nonnegative integer");
  if (policy.minimumScore !== undefined) assertScore(policy.minimumScore, "minimumScore");
  if (policy.resultLimit !== undefined && (!Number.isInteger(policy.resultLimit) || policy.resultLimit < 1)) {
    throw new Error("resultLimit must be a positive integer");
  }
  if (policy.freshness && (!Number.isFinite(policy.freshness.windowDays) || policy.freshness.windowDays <= 0)) {
    throw new Error("freshness.windowDays must be positive");
  }
  const seen = new Set<string>();
  for (const component of policy.components) {
    if (!DISCOVERY_COMPONENTS.has(component.key)) throw new Error(`Unsupported discovery component '${component.key}'`);
    if (seen.has(component.key)) throw new Error(`Duplicate discovery component '${component.key}'`);
    seen.add(component.key);
    assertFiniteNonnegative(component.weight, `components.${component.key}.weight`);
  }
  return policy;
}

function validateRelationshipPolicy(policy: RelationshipIntelligencePolicy): RelationshipIntelligencePolicy {
  if (!policy.policyKey || !policy.version) throw new Error("Relationship policy requires policyKey and version");
  if (!Number.isInteger(policy.minimumEvidence) || policy.minimumEvidence < 0) throw new Error("minimumEvidence must be a nonnegative integer");
  for (const [key, weight] of Object.entries(policy.interactionWeights)) {
    if (!key) throw new Error("Relationship interaction weight key is required");
    assertFiniteNonnegative(weight, `interactionWeights.${key}`);
  }
  if (policy.recency) {
    if (!Number.isFinite(policy.recency.windowDays) || policy.recency.windowDays <= 0) throw new Error("recency.windowDays must be positive");
    if (!Number.isFinite(policy.recency.minimumMultiplier) || policy.recency.minimumMultiplier < 0 || policy.recency.minimumMultiplier > 1) {
      throw new Error("recency.minimumMultiplier must be between 0 and 1");
    }
  }
  if (policy.frequency) {
    if (!Number.isInteger(policy.frequency.maxCount) || policy.frequency.maxCount < 1) throw new Error("frequency.maxCount must be positive");
    assertFiniteNonnegative(policy.frequency.weight, "frequency.weight");
  }
  for (const band of policy.strengthBands) assertScore(band.minimumScore, `strengthBands.${band.key}.minimumScore`);
  return policy;
}

async function persistVersionedPolicy(
  executor: Executor,
  input: {
    table: "discovery_policies" | "relationship_intelligence_policies";
    key: string;
    version: string;
    config: unknown;
    active: boolean;
  },
): Promise<string> {
  const maybePool = executor as Executor & { connect?: () => Promise<PoolClient> };
  const run = async (client: Executor) => {
    if (input.active) {
      await client.query(`UPDATE ${input.table} SET active = false, updated_at = now() WHERE policy_key = $1 AND version <> $2`, [
        input.key,
        input.version,
      ]);
    }
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO ${input.table} (policy_key, version, config, active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (policy_key, version)
        DO UPDATE SET config = EXCLUDED.config, active = EXCLUDED.active, updated_at = now()
        RETURNING id
      `,
      [input.key, input.version, input.config, input.active],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Policy was not persisted");
    return row.id;
  };
  if (typeof maybePool.connect !== "function") return run(executor);
  const client = await maybePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`policy:${input.table}:${input.key}`]);
    const id = await run(client);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadActivePolicy<T>(executor: Executor, table: string, policyKey: string): Promise<T> {
  const result = await executor.query<{ config: T }>(
    `SELECT config FROM ${table} WHERE policy_key = $1 AND active = true ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [policyKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Policy '${policyKey}' is not configured`);
  return row.config;
}

interface RawRelationshipPair {
  fromPersonId: string;
  toPersonId: string;
  events: Array<{
    id: string;
    type: string;
    occurredAt: string;
    platformId: string;
    providerObjectId: string;
  }>;
}

async function relationshipPairs(executor: Executor, input: RecomputeRelationshipInput): Promise<RawRelationshipPair[]> {
  const result = await executor.query<{
    id: string;
    type: string;
    occurred_at: Date;
    platform_id: string;
    external_id: string;
    from_person_id: string;
    to_person_id: string;
  }>(
    `
      SELECT si.id, si.type, si.occurred_at, si.platform_id, si.external_id,
             from_cpa.person_id AS from_person_id,
             COALESCE(to_cpa.person_id, content_author_cpa.person_id) AS to_person_id
      FROM social_interactions si
      JOIN canonical_person_accounts from_cpa
        ON from_cpa.scope_id = $1
       AND from_cpa.external_account_id = si.from_external_account_id
       AND from_cpa.status = 'CONFIRMED'
      LEFT JOIN canonical_person_accounts to_cpa
        ON to_cpa.scope_id = $1
       AND to_cpa.external_account_id = si.to_external_account_id
       AND to_cpa.status = 'CONFIRMED'
      LEFT JOIN social_content_items sci ON sci.id = si.to_content_item_id
      LEFT JOIN canonical_person_accounts content_author_cpa
        ON content_author_cpa.scope_id = $1
       AND content_author_cpa.external_account_id = sci.author_external_account_id
       AND content_author_cpa.status = 'CONFIRMED'
      WHERE si.scope_id = $1
        AND COALESCE(to_cpa.person_id, content_author_cpa.person_id) IS NOT NULL
        AND from_cpa.person_id <> COALESCE(to_cpa.person_id, content_author_cpa.person_id)
        AND ($2::uuid IS NULL OR from_cpa.person_id = $2)
        AND ($3::uuid IS NULL OR COALESCE(to_cpa.person_id, content_author_cpa.person_id) = $3)
      ORDER BY from_cpa.person_id, COALESCE(to_cpa.person_id, content_author_cpa.person_id), si.occurred_at, si.id
    `,
    [input.scopeId, input.fromPersonId ?? null, input.toPersonId ?? null],
  );
  const pairs = new Map<string, RawRelationshipPair>();
  for (const row of result.rows) {
    const key = `${row.from_person_id}:${row.to_person_id}`;
    const pair = pairs.get(key) ?? { fromPersonId: row.from_person_id, toPersonId: row.to_person_id, events: [] };
    pair.events.push({
      id: row.id,
      type: row.type,
      occurredAt: row.occurred_at.toISOString(),
      platformId: row.platform_id,
      providerObjectId: row.external_id,
    });
    pairs.set(key, pair);
  }
  return [...pairs.values()].sort((a, b) => a.fromPersonId.localeCompare(b.fromPersonId) || a.toPersonId.localeCompare(b.toPersonId));
}

function computeRelationship(
  pair: RawRelationshipPair,
  policy: RelationshipIntelligencePolicy,
  evaluationTimestamp: string,
): Omit<RelationshipSnapshot, "snapshotId" | "policyVersion" | "createdNewVersion"> & { sourceFingerprint: string } {
  const evaluationTime = new Date(evaluationTimestamp).getTime();
  const evidence = pair.events.map((event) => {
    const baseWeight = policy.interactionWeights[event.type] ?? 0;
    const days = Math.max(0, (evaluationTime - new Date(event.occurredAt).getTime()) / (1000 * 60 * 60 * 24));
    const recencyMultiplier = policy.recency ? Math.max(policy.recency.minimumMultiplier, 1 - days / policy.recency.windowDays) : 1;
    const contribution = Number((baseWeight * recencyMultiplier).toFixed(4));
    return {
      interactionId: event.id,
      interactionType: event.type,
      direction: "OUTBOUND",
      fromPersonId: pair.fromPersonId,
      toPersonId: pair.toPersonId,
      occurredAt: event.occurredAt,
      baseWeight,
      recencyMultiplier: Number(recencyMultiplier.toFixed(4)),
      contribution,
      platformId: event.platformId,
      providerObjectId: event.providerObjectId,
    };
  });
  const frequencyContribution = policy.frequency
    ? Number(((Math.min(evidence.length, policy.frequency.maxCount) / policy.frequency.maxCount) * policy.frequency.weight).toFixed(4))
    : 0;
  const score = Math.max(0, Math.min(100, Math.round(evidence.reduce((sum, item) => sum + item.contribution, 0) + frequencyContribution)));
  const strengthLabel =
    [...policy.strengthBands].sort((a, b) => b.minimumScore - a.minimumScore).find((band) => score >= band.minimumScore)?.key ?? "none";
  const directionalEvidence = [
    {
      direction: "OUTBOUND",
      occurrenceCount: evidence.length,
      contribution: score,
      frequencyContribution,
      fromPersonId: pair.fromPersonId,
      toPersonId: pair.toPersonId,
    },
  ];
  const sourceFingerprint = fingerprint({
    pair,
    policy,
    evaluationTimestamp,
    evidence,
    score,
    frequencyContribution,
  });
  return {
    fromPersonId: pair.fromPersonId,
    toPersonId: pair.toPersonId,
    score,
    strengthLabel,
    evidence,
    directionalEvidence: directionalEvidence as unknown as RelationshipEvidence[],
    sourceFingerprint,
  };
}

async function persistRelationshipSnapshot(
  executor: Executor,
  input: RecomputeRelationshipInput,
  policy: RelationshipIntelligencePolicy,
  computed: Omit<RelationshipSnapshot, "snapshotId" | "policyVersion" | "createdNewVersion"> & { sourceFingerprint: string },
): Promise<RelationshipSnapshot> {
  const algorithmVersion = input.algorithmVersion ?? "relationship-intelligence-v1";
  const existing = await executor.query<{ id: string }>(
    `
      SELECT id
      FROM relationship_intelligence_snapshots
      WHERE scope_id = $1 AND from_person_id = $2 AND to_person_id = $3
        AND policy_key = $4 AND policy_version = $5 AND algorithm_version = $6 AND source_fingerprint = $7
      LIMIT 1
    `,
    [input.scopeId, computed.fromPersonId, computed.toPersonId, policy.policyKey, policy.version, algorithmVersion, computed.sourceFingerprint],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    await markRelationshipCurrent(executor, input.scopeId, computed.fromPersonId, computed.toPersonId, existingId);
    return { ...computed, snapshotId: existingId, policyVersion: policy.version, createdNewVersion: false };
  }
  await executor.query(
    `
      UPDATE relationship_intelligence_snapshots
      SET is_current = false, superseded_at = COALESCE(superseded_at, now())
      WHERE scope_id = $1 AND from_person_id = $2 AND to_person_id = $3 AND is_current = true
    `,
    [input.scopeId, computed.fromPersonId, computed.toPersonId],
  );
  const inserted = await executor.query<{ id: string }>(
    `
      INSERT INTO relationship_intelligence_snapshots (
        scope_id, from_person_id, to_person_id, score, strength_label,
        directional_evidence, evidence, policy_key, policy_version, algorithm_version,
        evaluation_at, source_fingerprint, is_current
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
      RETURNING id
    `,
    [
      input.scopeId,
      computed.fromPersonId,
      computed.toPersonId,
      computed.score,
      computed.strengthLabel,
      JSON.stringify(computed.directionalEvidence),
      JSON.stringify(computed.evidence),
      policy.policyKey,
      policy.version,
      algorithmVersion,
      input.evaluationTimestamp,
      computed.sourceFingerprint,
    ],
  );
  return { ...computed, snapshotId: inserted.rows[0]!.id, policyVersion: policy.version, createdNewVersion: true };
}

async function markRelationshipCurrent(executor: Executor, scopeId: string, fromPersonId: string, toPersonId: string, snapshotId: string): Promise<void> {
  await executor.query(
    `
      UPDATE relationship_intelligence_snapshots
      SET is_current = (id = $4), superseded_at = CASE WHEN id = $4 THEN NULL ELSE COALESCE(superseded_at, now()) END
      WHERE scope_id = $1 AND from_person_id = $2 AND to_person_id = $3
    `,
    [scopeId, fromPersonId, toPersonId, snapshotId],
  );
}

interface PersonDna {
  personId: string;
  name: string;
  topics: string[];
  expertise: string[];
  interests: string[];
  geography: string[];
  sourceWindowTo: string | null;
  evidenceCount: number;
  sourceFingerprint: string;
}

async function discoveryPeople(executor: Executor, scopeId: string): Promise<PersonDna[]> {
  const result = await executor.query<{
    person_id: string;
    name: string;
    dimensions: Array<{ key: string; values?: string[] }>;
    stated_signals: Array<{ key: string; value: string }>;
    observed_signals: Array<{ key: string; value: string }>;
    evidence: unknown[];
    source_window: { to?: string | null } | null;
    source_fingerprint: string;
  }>(
    `
      SELECT sdp.person_id, p.name, sdp.dimensions, sdp.stated_signals, sdp.observed_signals,
             sdp.evidence, sdp.source_window, sdp.source_fingerprint
      FROM social_dna_profiles sdp
      JOIN people p ON p.id = sdp.person_id
      WHERE sdp.scope_id = $1 AND sdp.is_current = true
        AND EXISTS (
          SELECT 1 FROM canonical_person_accounts cpa
          WHERE cpa.scope_id = $1 AND cpa.person_id = sdp.person_id AND cpa.status = 'CONFIRMED'
        )
      ORDER BY p.name, sdp.person_id
    `,
    [scopeId],
  );
  return result.rows.map((row) => {
    const recurring = row.dimensions.find((item) => item.key === "recurring_topics")?.values ?? [];
    const geography = row.dimensions.find((item) => item.key === "geography")?.values ?? [];
    const stated = row.stated_signals.map((item) => item.value).filter(Boolean);
    return {
      personId: row.person_id,
      name: row.name,
      topics: uniqueSorted(recurring),
      expertise: uniqueSorted(recurring),
      interests: uniqueSorted([...stated, ...row.observed_signals.map((item) => item.value).filter(Boolean)]),
      geography: uniqueSorted(geography),
      sourceWindowTo: row.source_window?.to ?? null,
      evidenceCount: row.evidence.length,
      sourceFingerprint: row.source_fingerprint,
    };
  });
}

async function currentRelationships(executor: Executor, scopeId: string): Promise<Map<string, number>> {
  const result = await executor.query<{ from_person_id: string; to_person_id: string; score: number }>(
    `
      SELECT from_person_id, to_person_id, score
      FROM relationship_intelligence_snapshots
      WHERE scope_id = $1 AND is_current = true
    `,
    [scopeId],
  );
  return new Map(result.rows.map((row) => [`${row.from_person_id}:${row.to_person_id}`, Number(row.score)]));
}

function scoreDiscovery(
  people: PersonDna[],
  relationships: Map<string, number>,
  input: RecomputeDiscoveryInput,
  policy: DiscoveryPolicy,
): DiscoveryResult[] {
  const subject = input.subjectPersonId ? people.find((person) => person.personId === input.subjectPersonId) : undefined;
  const results: DiscoveryResult[] = [];
  for (const person of people) {
    if (person.personId === input.subjectPersonId) continue;
    const components = policy.components.map((component) => componentScore(component, person, subject, relationships, input, policy));
    if (components.filter((component) => component.rawScore > 0).length < policy.minimumEvidence) continue;
    const weightSum = components.reduce((sum, item) => sum + item.weight, 0);
    const score = weightSum > 0 ? Math.round(components.reduce((sum, item) => sum + item.rawScore * item.weight, 0) / weightSum) : 0;
    results.push({
      personId: person.personId,
      name: person.name,
      rank: 0,
      score,
      components: components.sort((a, b) => a.key.localeCompare(b.key)),
      evidence: [{ personId: person.personId, sourceFingerprint: person.sourceFingerprint, evidenceCount: person.evidenceCount }],
    });
  }
  return results
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId))
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function componentScore(
  component: { key: string; weight: number },
  person: PersonDna,
  subject: PersonDna | undefined,
  relationships: Map<string, number>,
  input: RecomputeDiscoveryInput,
  policy: DiscoveryPolicy,
): DiscoveryComponentEvidence {
  let rawScore = 0;
  let evidence: unknown[] = [];
  if (component.key === "social_dna_similarity" && subject) {
    rawScore = setScore([...person.topics, ...person.interests], [...subject.topics, ...subject.interests]);
    evidence = [{ shared: intersection([...person.topics, ...person.interests], [...subject.topics, ...subject.interests]) }];
  } else if (component.key === "shared_expertise" && subject) {
    rawScore = setScore(person.expertise, subject.expertise);
    evidence = [{ shared: intersection(person.expertise, subject.expertise) }];
  } else if (component.key === "shared_interests" && subject) {
    rawScore = setScore(person.interests, subject.interests);
    evidence = [{ shared: intersection(person.interests, subject.interests) }];
  } else if (component.key === "topic_overlap") {
    const requested = input.filters?.topics ?? subject?.topics ?? [];
    rawScore = requested.length ? coverageScore(person.topics, requested) : 0;
    evidence = [{ matched: intersection(person.topics, requested), requested }];
  } else if (component.key === "geography_alignment") {
    const requested = input.filters?.geography ?? subject?.geography ?? [];
    rawScore = requested.length ? coverageScore(person.geography, requested) : 0;
    evidence = [{ matched: intersection(person.geography, requested), requested }];
  } else if (component.key === "relationship_strength" && subject) {
    rawScore = relationships.get(`${subject.personId}:${person.personId}`) ?? 0;
    evidence = [{ fromPersonId: subject.personId, toPersonId: person.personId, score: rawScore }];
  } else if (component.key === "activity_freshness" && person.sourceWindowTo && policy.freshness) {
    const days = Math.max(0, (new Date(input.evaluationTimestamp).getTime() - new Date(person.sourceWindowTo).getTime()) / (1000 * 60 * 60 * 24));
    rawScore = Math.max(0, Math.round((1 - days / policy.freshness.windowDays) * 100));
    evidence = [{ sourceWindowTo: person.sourceWindowTo, evaluationTimestamp: input.evaluationTimestamp, days }];
  }
  return {
    key: component.key,
    rawScore,
    weight: component.weight,
    contribution: rawScore * component.weight,
    evidence,
  };
}

function applyDiscoveryFilters(results: DiscoveryResult[], filters: DiscoveryFilters | undefined, policy: DiscoveryPolicy): DiscoveryResult[] {
  const excluded = new Set(filters?.excludedPersonIds ?? []);
  const minScore = filters?.minimumScore ?? policy.minimumScore ?? 0;
  return results
    .filter((result) => !excluded.has(result.personId))
    .filter((result) => result.score >= minScore)
    .slice(0, policy.resultLimit ?? results.length)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

async function persistDiscoverySnapshot(
  executor: Executor,
  input: RecomputeDiscoveryInput,
  policy: DiscoveryPolicy,
  relationshipPolicy: RelationshipIntelligencePolicy | undefined,
  results: DiscoveryResult[],
): Promise<DiscoverySnapshot> {
  const algorithmVersion = input.algorithmVersion ?? "discovery-intelligence-v1";
  const query = input.filters ?? {};
  const sourceFingerprint = fingerprint({
    scopeId: input.scopeId,
    subjectPersonId: input.subjectPersonId ?? null,
    policy,
    relationshipPolicy: relationshipPolicy ? { policyKey: relationshipPolicy.policyKey, version: relationshipPolicy.version } : null,
    algorithmVersion,
    evaluationTimestamp: input.evaluationTimestamp,
    query,
    results: results.map((result) => ({
      personId: result.personId,
      score: result.score,
      components: result.components,
      evidence: result.evidence,
    })),
  });
  const existing = await executor.query<{ id: string }>(
    `
      SELECT id
      FROM discovery_snapshots
      WHERE scope_id = $1 AND policy_key = $2 AND policy_version = $3
        AND algorithm_version = $4 AND source_fingerprint = $5
      LIMIT 1
    `,
    [input.scopeId, policy.policyKey, policy.version, algorithmVersion, sourceFingerprint],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    await markDiscoveryCurrent(executor, input.scopeId, input.subjectPersonId ?? null, existingId);
    return { snapshotId: existingId, policyVersion: policy.version, relationshipPolicyVersion: relationshipPolicy?.version, results, createdNewVersion: false };
  }
  await executor.query(
    `
      UPDATE discovery_snapshots
      SET is_current = false, superseded_at = COALESCE(superseded_at, now())
      WHERE scope_id = $1 AND policy_key = $2
        AND subject_person_id IS NOT DISTINCT FROM $3::uuid
        AND is_current = true
    `,
    [input.scopeId, policy.policyKey, input.subjectPersonId ?? null],
  );
  const inserted = await executor.query<{ id: string }>(
    `
      INSERT INTO discovery_snapshots (
        scope_id, subject_person_id, policy_key, policy_version,
        relationship_policy_key, relationship_policy_version, algorithm_version,
        query, evaluation_at, source_fingerprint, is_current
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
      RETURNING id
    `,
    [
      input.scopeId,
      input.subjectPersonId ?? null,
      policy.policyKey,
      policy.version,
      relationshipPolicy?.policyKey ?? null,
      relationshipPolicy?.version ?? null,
      algorithmVersion,
      JSON.stringify(query),
      input.evaluationTimestamp,
      sourceFingerprint,
    ],
  );
  const snapshotId = inserted.rows[0]!.id;
  for (const result of results) {
    await executor.query(
      `
        INSERT INTO discovery_results (snapshot_id, target_person_id, rank, score, components, evidence)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [snapshotId, result.personId, result.rank, result.score, JSON.stringify(result.components), JSON.stringify(result.evidence)],
    );
  }
  return { snapshotId, policyVersion: policy.version, relationshipPolicyVersion: relationshipPolicy?.version, results, createdNewVersion: true };
}

async function markDiscoveryCurrent(executor: Executor, scopeId: string, subjectPersonId: string | null, snapshotId: string): Promise<void> {
  await executor.query(
    `
      UPDATE discovery_snapshots
      SET is_current = (id = $3), superseded_at = CASE WHEN id = $3 THEN NULL ELSE COALESCE(superseded_at, now()) END
      WHERE scope_id = $1 AND subject_person_id IS NOT DISTINCT FROM $2::uuid
    `,
    [scopeId, subjectPersonId, snapshotId],
  );
}

function setScore(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return Math.round((shared / union) * 100);
}

function coverageScore(values: string[], requested: string[]): number {
  const matched = intersection(values, requested).length;
  return requested.length ? Math.round((matched / requested.length) * 100) : 0;
}

function intersection(a: string[], b: string[]): string[] {
  const right = new Set(b);
  return uniqueSorted(a.filter((item) => right.has(item)));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function assertScore(value: unknown, path: string): asserts value is number {
  assertFiniteNonnegative(value, path);
  if ((value as number) > 100) throw new Error(`${path} must be <= 100`);
}

function assertFiniteNonnegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite nonnegative number`);
  }
}
