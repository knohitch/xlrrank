import test from "node:test";
import assert from "node:assert/strict";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isAuditDb = DATABASE_URL.includes("xlrrank") || DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1");
const skip = !DATABASE_URL || !isAuditDb;

let pool;
let api;

async function setup() {
  if (pool) return;
  process.env.ENCRYPTION_MASTER_KEY ??= "sprint-13-intelligence-key-32-bytes";
  const { Pool } = await import("pg");
  api = await import("../dist/index.js");
  await api.runMigrations?.();
  pool = new Pool({ connectionString: DATABASE_URL });
}

async function reset() {
  await setup();
  await pool.query(
    `
      TRUNCATE
        discovery_results,
        discovery_snapshots,
        relationship_intelligence_snapshots,
        relationship_intelligence_policies,
        discovery_policies,
        identity_resolution_decisions,
        identity_resolution_candidates,
        identity_resolution_policies,
        social_dna_policies,
        canonical_person_accounts,
        social_dna_profiles,
        audit_logs,
        social_content_metrics,
        social_interaction_observations,
        social_interactions,
        social_content_observations,
        social_content_items,
        social_account_observations,
        social_ingestion_runs,
        social_connections,
        social_account_handles,
        social_external_accounts,
        people,
        data_scopes,
        platforms,
        users
      RESTART IDENTITY CASCADE
    `,
  );
}

async function user(email) {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $1, 'ACTIVE') RETURNING id",
    [email],
  );
  return result.rows[0].id;
}

async function scope(email) {
  return api.ensurePersonalScope(await user(email));
}

async function platform(slug) {
  const result = await pool.query(
    "INSERT INTO platforms (slug, provider_family, display_name, enabled) VALUES ($1, $1, $1, true) RETURNING id",
    [slug],
  );
  return result.rows[0].id;
}

async function account(platformId, suffix, fields = {}) {
  const result = await pool.query(
    `
      INSERT INTO social_external_accounts (
        platform_id, external_id, current_handle, display_name, bio, location,
        website, profile_url, visibility
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PUBLIC')
      RETURNING id
    `,
    [
      platformId,
      suffix,
      fields.handle ?? suffix,
      fields.displayName ?? suffix,
      fields.bio ?? "",
      fields.location ?? "",
      fields.website ?? "",
      fields.profileUrl ?? `https://example.test/${suffix}`,
    ],
  );
  return result.rows[0].id;
}

async function connection(scopeId, platformId, suffix) {
  const owner = await account(platformId, `${suffix}-owner`);
  const result = await pool.query(
    `
      INSERT INTO social_connections (
        scope_id, platform_id, external_account_id, status, credentials_encrypted,
        verified_external_id, verified_handle
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $5)
      RETURNING id
    `,
    [scopeId, platformId, owner, `enc:v2:${scopeId}:sprint13`, suffix],
  );
  return result.rows[0].id;
}

async function observeAccount(scopeId, connectionId, accountId) {
  await pool.query(
    `
      INSERT INTO social_account_observations (
        scope_id, connection_id, external_account_id, visibility,
        observed_at, normalization_version, adapter_version
      )
      VALUES ($1, $2, $3, 'PUBLIC', '2032-01-10T00:00:00.000Z', 'sprint-13-test-v1', 'fixture-v1')
    `,
    [scopeId, connectionId, accountId],
  );
}

async function person(name) {
  const result = await pool.query("INSERT INTO people (name, confidence) VALUES ($1, 'confirmed') RETURNING id", [name]);
  return result.rows[0].id;
}

async function link(scopeId, personId, accountId) {
  await pool.query(
    `
      INSERT INTO canonical_person_accounts (scope_id, person_id, external_account_id, status)
      VALUES ($1, $2, $3, 'CONFIRMED')
      ON CONFLICT (scope_id, external_account_id) WHERE status = 'CONFIRMED'
      DO UPDATE SET person_id = EXCLUDED.person_id, updated_at = now()
    `,
    [scopeId, personId, accountId],
  );
}

async function dna(scopeId, personId, input) {
  await pool.query("UPDATE social_dna_profiles SET is_current = false WHERE scope_id = $1 AND person_id = $2", [scopeId, personId]);
  await pool.query(
    `
      INSERT INTO social_dna_profiles (
        scope_id, person_id, version, dimensions, confidence, stated_signals,
        observed_signals, evidence, algorithm_version, source_fingerprint,
        source_window, is_current
      )
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'sprint-13-fixture-v1', $8, $9, true)
    `,
    [
      scopeId,
      personId,
      JSON.stringify([
        { key: "topics", values: input.topics },
        { key: "expertise", values: input.expertise ?? [] },
        { key: "interests", values: input.interests ?? [] },
        { key: "recurring_topics", values: input.topics },
        { key: "geography", values: input.geography ?? [] },
      ]),
      JSON.stringify({ evidenceCount: input.evidenceCount ?? input.topics.length }),
      JSON.stringify((input.stated ?? []).map((value) => ({ key: "stated", value, provenance: { personId } }))),
      JSON.stringify((input.observed ?? input.topics).map((value) => ({ key: "observed", value, provenance: { personId } }))),
      JSON.stringify(input.topics.map((topic) => ({ signalType: "topic", value: topic, sourcePersonId: personId }))),
      `${personId}:${input.fingerprint}`,
      JSON.stringify({ from: input.from ?? "2032-01-01T00:00:00.000Z", to: input.to ?? "2032-01-10T00:00:00.000Z" }),
    ],
  );
}

async function interaction(scopeId, platformId, fromAccountId, toAccountId, type, occurredAt, externalId) {
  const result = await pool.query(
    `
      INSERT INTO social_interactions (
        scope_id, platform_id, external_id, from_external_account_id,
        to_external_account_id, type, visibility, occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'SCOPE_PRIVATE', $7)
      RETURNING id
    `,
    [scopeId, platformId, externalId, fromAccountId, toAccountId, type, occurredAt],
  );
  return result.rows[0].id;
}

async function discoveryPolicy(version, components, extras = {}) {
  return api.persistDiscoveryPolicy({
    policy: {
      policyKey: extras.policyKey ?? "sprint-13-discovery",
      version,
      components,
      minimumEvidence: extras.minimumEvidence ?? 1,
      minimumScore: extras.minimumScore,
      resultLimit: extras.resultLimit,
      freshness: extras.freshness,
    },
  });
}

async function relationshipPolicy(version, extras = {}) {
  return api.persistRelationshipIntelligencePolicy({
    policy: {
      policyKey: extras.policyKey ?? "sprint-13-relationships",
      version,
      interactionWeights: extras.interactionWeights ?? { REPLY: 30, MENTION: 10 },
      recency: extras.recency ?? { windowDays: 30, minimumMultiplier: 0.25 },
      frequency: extras.frequency ?? { maxCount: 4, weight: 20 },
      strengthBands: extras.strengthBands ?? [
        { key: "strong", minimumScore: 55 },
        { key: "active", minimumScore: 25 },
        { key: "weak", minimumScore: 1 },
      ],
      minimumEvidence: extras.minimumEvidence ?? 1,
    },
  });
}

const identityPolicy = {
  policyKey: "sprint-13-identity",
  version: "v1",
  autoLinkThreshold: 80,
  manualReviewThreshold: 45,
  minimumPositiveSignals: 2,
  contradictionPenalty: 25,
  signals: [
    { key: "website_domain_match", weight: 40 },
    { key: "name_similarity", weight: 30, threshold: 0.8 },
    { key: "bio_similarity", weight: 25, threshold: 0.35 },
  ],
};

test("Sprint 13 discovery is persisted, policy-driven, explainable, deterministic, filtered, and scope-safe", { skip }, async () => {
  await reset();
  const firstScope = await scope("sprint13-discovery@example.test");
  const otherScope = await scope("sprint13-other@example.test");
  const platformId = await platform("sprint13-disc");
  const subject = await person("Subject Builder");
  const relevant = await person("Relevant Automation");
  const irrelevant = await person("Irrelevant Fashion");
  const tieA = await person("Alpha Tie");
  const tieB = await person("Beta Tie");
  const outsider = await person("Other Scope");
  for (const [personId, suffix, scopeId] of [
    [subject, "subject", firstScope.scopeId],
    [relevant, "relevant", firstScope.scopeId],
    [irrelevant, "irrelevant", firstScope.scopeId],
    [tieA, "tie-a", firstScope.scopeId],
    [tieB, "tie-b", firstScope.scopeId],
    [outsider, "outsider", otherScope.scopeId],
  ]) {
    await link(scopeId, personId, await account(platformId, suffix));
  }
  await dna(firstScope.scopeId, subject, { topics: ["ai", "automation", "saas"], geography: ["london"], fingerprint: "subject" });
  await dna(firstScope.scopeId, relevant, { topics: ["ai", "automation", "developer-tools"], geography: ["london"], fingerprint: "relevant" });
  await dna(firstScope.scopeId, irrelevant, { topics: ["fashion", "beauty"], geography: ["paris"], fingerprint: "irrelevant" });
  await dna(firstScope.scopeId, tieA, { topics: ["automation"], geography: ["berlin"], fingerprint: "tie-a" });
  await dna(firstScope.scopeId, tieB, { topics: ["automation"], geography: ["berlin"], fingerprint: "tie-b" });
  await dna(otherScope.scopeId, outsider, { topics: ["ai", "automation"], geography: ["london"], fingerprint: "outsider" });

  await discoveryPolicy("topics-v1", [
    { key: "topic_overlap", weight: 10 },
    { key: "social_dna_similarity", weight: 5 },
  ]);
  const snapshotA = await api.recomputeDiscoverySnapshot({
    scopeId: firstScope.scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { topics: ["ai", "automation"], excludedPersonIds: [irrelevant], minimumScore: 1 },
  });
  assert.equal(snapshotA.results[0].personId, relevant);
  assert(snapshotA.results.every((result) => result.personId !== outsider));
  assert(snapshotA.results.every((result) => result.personId !== irrelevant));
  assert(snapshotA.results[0].components.some((component) => component.key === "topic_overlap" && component.evidence.length > 0));
  const repeat = await api.recomputeDiscoverySnapshot({
    scopeId: firstScope.scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { topics: ["ai", "automation"], excludedPersonIds: [irrelevant], minimumScore: 1 },
  });
  assert.equal(repeat.snapshotId, snapshotA.snapshotId);
  assert.equal(repeat.createdNewVersion, false);

  await discoveryPolicy("geo-v2", [{ key: "geography_alignment", weight: 10 }]);
  const snapshotB = await api.recomputeDiscoverySnapshot({
    scopeId: firstScope.scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { geography: ["berlin"], resultLimit: 2 },
  });
  assert.deepEqual(snapshotB.results.map((result) => result.name), ["Alpha Tie", "Beta Tie"]);
});

test("Sprint 13 closure: discovery consumes the exact active relationship policy and current rows are unique", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-policy-isolation@example.test");
  const platformId = await platform("sprint13-policy");
  const subject = await person("Subject Policy");
  const target = await person("Target Policy");
  const subjectAccount = await account(platformId, "policy-subject");
  const targetAccount = await account(platformId, "policy-target");
  await link(scopeId, subject, subjectAccount);
  await link(scopeId, target, targetAccount);
  await dna(scopeId, subject, { topics: ["ai"], expertise: ["automation"], interests: ["developer-tools"], geography: ["london"], fingerprint: "subject" });
  await dna(scopeId, target, { topics: ["ai"], expertise: ["automation"], interests: ["developer-tools"], geography: ["london"], fingerprint: "target" });
  await interaction(scopeId, platformId, subjectAccount, targetAccount, "REPLY", "2032-01-10T00:00:00.000Z", "policy-reply");

  await relationshipPolicy("high-v1", { policyKey: "rel-high", interactionWeights: { REPLY: 90 }, frequency: { maxCount: 1, weight: 0 } });
  await relationshipPolicy("low-v1", { policyKey: "rel-low", interactionWeights: { REPLY: 10 }, frequency: { maxCount: 1, weight: 0 } });
  await Promise.all([
    api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-high", evaluationTimestamp: "2032-01-15T00:00:00.000Z" }),
    api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-low", evaluationTimestamp: "2032-01-15T00:00:00.000Z" }),
  ]);
  await discoveryPolicy("relationship-only", [{ key: "relationship_strength", weight: 1 }], { policyKey: "policy-isolation-discovery" });
  const high = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "policy-isolation-discovery",
    relationshipPolicyKey: "rel-high",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const low = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "policy-isolation-discovery",
    relationshipPolicyKey: "rel-low",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const highScore = high.results[0].components.find((component) => component.key === "relationship_strength").rawScore;
  const lowScore = low.results[0].components.find((component) => component.key === "relationship_strength").rawScore;
  assert(highScore > lowScore);
  assert.equal(highScore, 75);
  assert.equal(lowScore, 8);
  const duplicateCurrent = await pool.query(
    `
      SELECT policy_key, count(*)
      FROM relationship_intelligence_snapshots
      WHERE scope_id = $1 AND is_current = true
      GROUP BY scope_id, from_person_id, to_person_id, policy_key
      HAVING count(*) > 1
    `,
    [scopeId],
  );
  assert.equal(duplicateCurrent.rowCount, 0);
});

test("Sprint 13 closure: recompute removes disappeared and non-qualifying relationships", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-disappeared@example.test");
  const platformId = await platform("sprint13-disappeared");
  const subject = await person("Subject Gone");
  const target = await person("Target Gone");
  const subjectAccount = await account(platformId, "gone-subject");
  const targetAccount = await account(platformId, "gone-target");
  await link(scopeId, subject, subjectAccount);
  await link(scopeId, target, targetAccount);
  await dna(scopeId, subject, { topics: ["ai"], expertise: [], interests: [], geography: [], fingerprint: "subject" });
  await dna(scopeId, target, { topics: ["ai"], expertise: [], interests: [], geography: [], fingerprint: "target" });
  const interactionId = await interaction(scopeId, platformId, subjectAccount, targetAccount, "REPLY", "2032-01-10T00:00:00.000Z", "gone-reply");
  await relationshipPolicy("gone-v1", {
    policyKey: "rel-gone",
    interactionWeights: { REPLY: 60 },
    frequency: { maxCount: 5, weight: 50 },
  });
  const before = await api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-gone", evaluationTimestamp: "2032-01-15T00:00:00.000Z" });
  assert.equal(before.snapshots.length, 1);
  await pool.query("DELETE FROM social_interactions WHERE id = $1", [interactionId]);
  const after = await api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-gone", evaluationTimestamp: "2032-01-15T00:00:00.000Z" });
  assert.equal(after.snapshots.length, 0);
  const stale = await pool.query("SELECT is_current FROM relationship_intelligence_snapshots WHERE id = $1", [before.snapshots[0].snapshotId]);
  assert.equal(stale.rows[0].is_current, false);

  await interaction(scopeId, platformId, subjectAccount, targetAccount, "LIKE", "2032-01-11T00:00:00.000Z", "unknown-only");
  const unknown = await api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-gone", evaluationTimestamp: "2032-01-15T00:00:00.000Z" });
  assert.equal(unknown.snapshots.length, 0);
  await discoveryPolicy("gone-discovery", [{ key: "relationship_strength", weight: 1 }], { policyKey: "gone-discovery" });
  const discovery = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "gone-discovery",
    relationshipPolicyKey: "rel-gone",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  assert.equal(discovery.results.length, 0);
});

test("Sprint 13 closure: discovery filters and Social DNA semantics are eligibility constraints", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-filters@example.test");
  const platformId = await platform("sprint13-filters");
  const subject = await person("Subject Filters");
  const highScoreWrongTopic = await person("Wrong Topic");
  const rightCandidate = await person("Right Candidate");
  const staleCandidate = await person("Stale Candidate");
  for (const [personId, suffix] of [
    [subject, "filters-subject"],
    [highScoreWrongTopic, "filters-wrong"],
    [rightCandidate, "filters-right"],
    [staleCandidate, "filters-stale"],
  ]) {
    await link(scopeId, personId, await account(platformId, suffix));
  }
  await dna(scopeId, subject, {
    topics: ["ai"],
    expertise: ["automation"],
    interests: ["developer-tools"],
    geography: ["london"],
    fingerprint: "subject",
    stated: ["https://subject.example.test", "london"],
  });
  await dna(scopeId, highScoreWrongTopic, {
    topics: ["fashion"],
    expertise: ["styling"],
    interests: ["beauty"],
    geography: ["paris"],
    fingerprint: "wrong",
  });
  await dna(scopeId, rightCandidate, {
    topics: ["ai"],
    expertise: ["automation"],
    interests: ["developer-tools"],
    geography: ["london"],
    fingerprint: "right",
    to: "2032-01-14T00:00:00.000Z",
  });
  await dna(scopeId, staleCandidate, {
    topics: ["ai"],
    expertise: ["automation"],
    interests: ["developer-tools"],
    geography: ["london"],
    fingerprint: "stale",
    to: "2031-01-01T00:00:00.000Z",
  });
  await discoveryPolicy(
    "semantic-filters",
    [
      { key: "social_dna_similarity", weight: 10 },
      { key: "shared_expertise", weight: 10 },
      { key: "shared_interests", weight: 10 },
      { key: "activity_freshness", weight: 1 },
    ],
    { policyKey: "semantic-discovery", freshness: { windowDays: 30 } },
  );
  const result = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "semantic-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: {
      topics: ["ai"],
      expertise: ["automation"],
      geography: ["london"],
      activeWithinDays: 7,
    },
  });
  assert.deepEqual(result.results.map((item) => item.personId), [rightCandidate]);
  assert.equal(
    result.results[0].components.find((component) => component.key === "shared_interests").rawScore,
    100,
  );
  const websiteInterestLeak = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "semantic-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { expertise: ["ai"] },
  });
  assert.equal(websiteInterestLeak.results.length, 0);
});

test("Sprint 13 closure: evaluation timestamp is validated and future interactions are excluded", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-evaluation@example.test");
  const platformId = await platform("sprint13-evaluation");
  const subject = await person("Subject Time");
  const target = await person("Target Time");
  const subjectAccount = await account(platformId, "time-subject");
  const targetAccount = await account(platformId, "time-target");
  await link(scopeId, subject, subjectAccount);
  await link(scopeId, target, targetAccount);
  await interaction(scopeId, platformId, subjectAccount, targetAccount, "REPLY", "2032-01-10T00:00:00.000Z", "time-before");
  await interaction(scopeId, platformId, subjectAccount, targetAccount, "REPLY", "2032-02-10T00:00:00.000Z", "time-after");
  await relationshipPolicy("time-v1", { policyKey: "rel-time", interactionWeights: { REPLY: 20 }, frequency: { maxCount: 10, weight: 10 } });
  const historical = await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "rel-time",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  assert.equal(historical.snapshots[0].evidence.length, 1);
  await assert.rejects(
    () => api.recomputeRelationshipIntelligence({ scopeId, policyKey: "rel-time", evaluationTimestamp: "not-a-date" }),
    /evaluationTimestamp/,
  );
  await discoveryPolicy("time-discovery", [{ key: "activity_freshness", weight: 1 }], {
    policyKey: "time-discovery",
    freshness: { windowDays: 30 },
  });
  await dna(scopeId, target, { topics: ["ai"], expertise: [], interests: [], geography: [], fingerprint: "future", to: "2032-02-10T00:00:00.000Z" });
  const futureDna = await api.recomputeDiscoverySnapshot({
    scopeId,
    policyKey: "time-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { activeWithinDays: 30 },
  });
  assert.equal(futureDna.results.length, 0);
});

test("Sprint 13 relationships are policy-driven, directional, recency-aware, explainable, and idempotent under concurrency", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-relationships@example.test");
  const platformId = await platform("sprint13-rel");
  const personA = await person("A");
  const personB = await person("B");
  const personC = await person("C");
  const accountA = await account(platformId, "a");
  const accountB = await account(platformId, "b");
  const accountC = await account(platformId, "c");
  await link(scopeId, personA, accountA);
  await link(scopeId, personB, accountB);
  await link(scopeId, personC, accountC);
  await interaction(scopeId, platformId, accountA, accountB, "REPLY", "2032-01-10T00:00:00.000Z", "a-b-1");
  await interaction(scopeId, platformId, accountA, accountB, "REPLY", "2032-01-11T00:00:00.000Z", "a-b-2");
  await interaction(scopeId, platformId, accountB, accountA, "MENTION", "2031-12-01T00:00:00.000Z", "b-a-1");

  await relationshipPolicy("rel-v1");
  const rel = await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const ab = rel.snapshots.find((snapshot) => snapshot.fromPersonId === personA && snapshot.toPersonId === personB);
  const ba = rel.snapshots.find((snapshot) => snapshot.fromPersonId === personB && snapshot.toPersonId === personA);
  assert(ab);
  assert(ba);
  assert(ab.score > ba.score);
  assert.equal(ab.evidence.length, 2);
  assert.equal(ab.evidence[0].direction, "OUTBOUND");
  assert(ab.evidence.every((item) => item.providerObjectId));
  assert.equal(rel.snapshots.some((snapshot) => snapshot.toPersonId === personC), false);

  const later = await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "sprint-13-relationships",
    fromPersonId: personA,
    toPersonId: personB,
    evaluationTimestamp: "2032-03-01T00:00:00.000Z",
  });
  assert(later.snapshots[0].score < ab.score);

  await relationshipPolicy("rel-v2", { interactionWeights: { REPLY: 5, MENTION: 50 }, frequency: { maxCount: 2, weight: 0 } });
  const changed = await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const changedBa = changed.snapshots.find((snapshot) => snapshot.fromPersonId === personB && snapshot.toPersonId === personA);
  assert(changedBa.score > ba.score);

  const concurrent = await Promise.all([
    api.recomputeRelationshipIntelligence({ scopeId, policyKey: "sprint-13-relationships", evaluationTimestamp: "2032-01-15T00:00:00.000Z" }),
    api.recomputeRelationshipIntelligence({ scopeId, policyKey: "sprint-13-relationships", evaluationTimestamp: "2032-01-15T00:00:00.000Z" }),
  ]);
  assert(concurrent[0].snapshots.length >= 2);
  const currentRows = await pool.query(
    "SELECT from_person_id, to_person_id, count(*) FROM relationship_intelligence_snapshots WHERE scope_id = $1 AND is_current = true GROUP BY from_person_id, to_person_id HAVING count(*) > 1",
    [scopeId],
  );
  assert.equal(currentRows.rowCount, 0);
});

test("Sprint 13 discovery consumes relationship scores separately and identity split invalidates stale intelligence", { skip }, async () => {
  await reset();
  const { scopeId } = await scope("sprint13-combined@example.test");
  const platformId = await platform("sprint13-combined");
  await api.persistIdentityResolutionPolicy({ policy: identityPolicy });
  const subject = await person("Subject");
  const near = await person("Near");
  const far = await person("Far");
  const subjectAccount = await account(platformId, "subject-combined");
  const nearAccount = await account(platformId, "near-combined");
  const farAccount = await account(platformId, "far-combined");
  await link(scopeId, subject, subjectAccount);
  await link(scopeId, near, nearAccount);
  await link(scopeId, far, farAccount);
  await dna(scopeId, subject, { topics: ["ai"], geography: ["london"], fingerprint: "subject" });
  await dna(scopeId, near, { topics: ["fashion"], geography: ["paris"], fingerprint: "near" });
  await dna(scopeId, far, { topics: ["ai"], geography: ["london"], fingerprint: "far" });
  await interaction(scopeId, platformId, subjectAccount, nearAccount, "REPLY", "2032-01-10T00:00:00.000Z", "subject-near");
  await relationshipPolicy("combined-rel-v1", { interactionWeights: { REPLY: 80 }, frequency: { maxCount: 1, weight: 0 } });
  await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });

  await discoveryPolicy("relationship-first", [
    { key: "relationship_strength", weight: 10 },
    { key: "topic_overlap", weight: 1 },
  ]);
  const relationshipFirst = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    relationshipPolicyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  assert.equal(relationshipFirst.results[0].personId, near);

  await discoveryPolicy("topic-first", [
    { key: "relationship_strength", weight: 1 },
    { key: "topic_overlap", weight: 10 },
  ]);
  const topicFirst = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    relationshipPolicyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  assert.equal(topicFirst.results[0].personId, far);

  await relationshipPolicy("combined-rel-v2", { interactionWeights: { REPLY: 10 }, frequency: { maxCount: 1, weight: 0 } });
  await api.recomputeRelationshipIntelligence({
    scopeId,
    policyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const reducedRelationship = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    relationshipPolicyKey: "sprint-13-relationships",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
  });
  const nearContribution = reducedRelationship.results
    .find((result) => result.personId === near)
    .components.find((component) => component.key === "relationship_strength").rawScore;
  assert.equal(nearContribution, 8);

  const unionAccountA = await account(platformId, "union-a", {
    displayName: "Sam Union",
    bio: "AI automation founder",
    website: "https://sam.example.test",
  });
  const unionAccountB = await account(platformId, "union-b", {
    displayName: "Sam Union",
    bio: "AI automation founder",
    website: "https://sam.example.test",
  });
  const unionConnection = await connection(scopeId, platformId, "union");
  await observeAccount(scopeId, unionConnection, unionAccountA);
  await observeAccount(scopeId, unionConnection, unionAccountB);
  const union = await api.resolveIdentityCandidate({
    scopeId,
    accountAId: unionAccountA,
    accountBId: unionAccountB,
    policyKey: "sprint-13-identity",
  });
  await dna(scopeId, union.personId, { topics: ["ai", "automation"], geography: ["london"], fingerprint: "union" });
  const beforeSplit = await api.recomputeDiscoverySnapshot({
    scopeId,
    subjectPersonId: subject,
    policyKey: "sprint-13-discovery",
    evaluationTimestamp: "2032-01-15T00:00:00.000Z",
    filters: { topics: ["automation"] },
  });
  await api.splitIdentityCandidate({ candidateId: union.candidateId, reason: "Sprint 13 isolation" });
  const stale = await pool.query(
    "SELECT is_current FROM discovery_snapshots WHERE id = $1",
    [beforeSplit.snapshotId],
  );
  assert.equal(stale.rows[0].is_current, false);
  const splitPeople = await pool.query(
    "SELECT person_id FROM canonical_person_accounts WHERE external_account_id = ANY($1::uuid[]) AND status = 'CONFIRMED' ORDER BY external_account_id",
    [[unionAccountA, unionAccountB]],
  );
  assert.equal(splitPeople.rowCount, 2);
  assert.notEqual(splitPeople.rows[0].person_id, splitPeople.rows[1].person_id);
});
