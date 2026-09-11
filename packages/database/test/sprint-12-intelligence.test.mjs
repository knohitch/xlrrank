import test from "node:test";
import assert from "node:assert/strict";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isAuditDb = DATABASE_URL.includes("xlrrank") || DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1");
const skip = !DATABASE_URL || !isAuditDb;

let pool;
let api;

async function setup() {
  if (pool) return;
  process.env.ENCRYPTION_MASTER_KEY ??= "sprint-12-intelligence-key-32-bytes";
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

async function user(email = "sprint12@example.test") {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [email, email],
  );
  return result.rows[0].id;
}

async function platform(slug, family = slug) {
  const result = await pool.query(
    "INSERT INTO platforms (slug, provider_family, display_name, enabled) VALUES ($1, $2, $1, true) RETURNING id",
    [slug, family],
  );
  return result.rows[0].id;
}

async function connection(scopeId, platformId, externalId) {
  const owner = await pool.query(
    `
      INSERT INTO social_external_accounts (platform_id, external_id, current_handle, display_name, visibility)
      VALUES ($1, $2, $2, $2, 'PUBLIC')
      ON CONFLICT (platform_id, external_id) DO UPDATE SET current_handle = EXCLUDED.current_handle
      RETURNING id
    `,
    [platformId, `${externalId}-owner`],
  );
  const result = await pool.query(
    `
      INSERT INTO social_connections (
        scope_id, platform_id, external_account_id, status, credentials_encrypted,
        verified_external_id, verified_handle
      )
      VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $5)
      RETURNING id
    `,
    [scopeId, platformId, owner.rows[0].id, `enc:v2:${scopeId}:fixture`, externalId],
  );
  return result.rows[0].id;
}

async function account(scopeId, connectionId, input) {
  const result = await pool.query(
    `
      INSERT INTO social_external_accounts (
        platform_id, external_id, current_handle, display_name, bio, location,
        website, profile_url, visibility, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PUBLIC', $9)
      RETURNING id
    `,
    [
      input.platformId,
      input.externalId,
      input.handle,
      input.displayName,
      input.bio,
      input.location,
      input.website,
      input.profileUrl,
      input.metadata ?? {},
    ],
  );
  await pool.query(
    `
      INSERT INTO social_account_observations (
        scope_id, connection_id, external_account_id, visibility,
        observed_at, normalization_version, adapter_version
      )
      VALUES ($1, $2, $3, 'PUBLIC', $4, 'sprint-12-test-v1', 'fixture-v1')
    `,
    [scopeId, connectionId, result.rows[0].id, input.observedAt ?? "2031-01-01T00:00:00.000Z"],
  );
  return result.rows[0].id;
}

async function content(scopeId, connectionId, input) {
  const item = await pool.query(
    `
      INSERT INTO social_content_items (
        scope_id, platform_id, author_external_account_id, external_id,
        body, content_type, language, visibility, provider_created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'en', 'PUBLIC', $7)
      RETURNING id
    `,
    [
      null,
      input.platformId,
      input.authorExternalAccountId,
      input.externalId,
      input.body,
      input.contentType ?? "post",
      input.observedAt ?? "2031-01-01T00:00:00.000Z",
    ],
  );
  await pool.query(
    `
      INSERT INTO social_content_observations (
        scope_id, connection_id, content_item_id, visibility,
        observed_at, normalization_version, adapter_version
      )
      VALUES ($1, $2, $3, 'PUBLIC', $4, 'sprint-12-test-v1', 'fixture-v1')
    `,
    [scopeId, connectionId, item.rows[0].id, input.observedAt ?? "2031-01-01T00:00:00.000Z"],
  );
  return item.rows[0].id;
}

async function person(name = "Fixture Person") {
  const result = await pool.query("INSERT INTO people (name, confidence) VALUES ($1, 'confirmed') RETURNING id", [name]);
  return result.rows[0].id;
}

async function linkFixture(scopeId, personId, accountId) {
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

async function currentDna(personId) {
  const result = await pool.query(
    "SELECT * FROM social_dna_profiles WHERE person_id = $1 AND is_current = true ORDER BY version DESC LIMIT 1",
    [personId],
  );
  return result.rows[0];
}

const policyA = {
  policyKey: "sprint-12",
  version: "v1",
  autoLinkThreshold: 80,
  manualReviewThreshold: 45,
  minimumPositiveSignals: 2,
  contradictionPenalty: 25,
  signals: [
    { key: "website_domain_match", weight: 35 },
    { key: "name_similarity", weight: 20, threshold: 0.8 },
    { key: "company_match", weight: 20 },
    { key: "location_match", weight: 10 },
    { key: "bio_similarity", weight: 15, threshold: 0.35 },
  ],
};

const policyB = {
  ...policyA,
  version: "v2",
  autoLinkThreshold: 95,
  manualReviewThreshold: 70,
  minimumPositiveSignals: 3,
  signals: [
    { key: "name_similarity", weight: 10, threshold: 0.8 },
    { key: "website_domain_match", weight: 5 },
    { key: "company_match", weight: 5 },
    { key: "topic_similarity", weight: 80, threshold: 0.35 },
  ],
};

const socialPolicyA = {
  policyKey: "sprint-12-social",
  version: "v1",
  tokenMinLength: 3,
  topicTaxonomy: [
    { key: "software_engineering", terms: ["software", "engineering", "developer", "typescript", "backend"] },
    { key: "ai_automation", terms: ["ai", "automation", "workflow"] },
    { key: "saas", terms: ["saas", "startup", "product", "growth", "platform"] },
    { key: "fashion_beauty", terms: ["fashion", "beauty", "skincare", "outfit"] },
    { key: "lifestyle", terms: ["lifestyle", "creator", "visual"] },
  ],
  expertiseTopics: ["software_engineering", "ai_automation", "saas"],
  interestTopics: ["fashion_beauty", "lifestyle"],
  commercialTopics: ["saas"],
  audienceRules: [
    { key: "developer", topics: ["software_engineering", "ai_automation", "saas"] },
    { key: "creator", topics: ["fashion_beauty", "lifestyle"] },
  ],
  communicationStyle: { inquisitiveQuestionRatio: 0.5 },
  complexity: { mediumFormMinTokens: 10, longFormMinTokens: 30 },
  comparisonWeights: { topics: 0.6, interests: 0.4 },
};

const socialPolicyB = {
  ...socialPolicyA,
  version: "v2",
  topicTaxonomy: [...socialPolicyA.topicTaxonomy, { key: "robotics", terms: ["robotics", "robot"] }],
  expertiseTopics: [...socialPolicyA.expertiseTopics, "robotics"],
};

test("Sprint 12 Social DNA: deterministic, evidence-backed, versioned, and deletion-aware", { skip }, async () => {
  await reset();
  const userId = await user();
  const scope = await api.ensurePersonalScope(userId);
  const devPlatform = await platform("sprint12-dev");
  const stylePlatform = await platform("sprint12-style");
  const devConnection = await connection(scope.scopeId, devPlatform, "dev-owner");
  const styleConnection = await connection(scope.scopeId, stylePlatform, "style-owner");
  await api.persistSocialDnaPolicy({ policy: socialPolicyA });

  const devAccount = await account(scope.scopeId, devConnection, {
    platformId: devPlatform,
    externalId: "dev-a",
    handle: "dev_a",
    displayName: "Ada Engineer",
    bio: "Software engineering leader building AI automation for SaaS developer workflows.",
    location: "San Francisco",
    website: "https://ada.example",
    metadata: { company: "XLRrank", role: "Engineering" },
  });
  const styleAccount = await account(scope.scopeId, styleConnection, {
    platformId: stylePlatform,
    externalId: "style-b",
    handle: "style_b",
    displayName: "Bea Creator",
    bio: "Fashion beauty lifestyle visual creator with skincare and outfit content.",
    location: "Paris",
    website: "https://bea.example",
    metadata: { company: "Studio Bea", role: "Creator" },
  });
  await content(scope.scopeId, devConnection, {
    platformId: devPlatform,
    authorExternalAccountId: devAccount,
    externalId: "dev-post-1",
    body: "AI automation and TypeScript software engineering for SaaS backend developer workflows.",
    contentType: "article",
  });
  const removedSource = await content(scope.scopeId, devConnection, {
    platformId: devPlatform,
    authorExternalAccountId: devAccount,
    externalId: "dev-post-2",
    body: "Startup SaaS product growth automation for developer platforms.",
    contentType: "post",
  });
  await content(scope.scopeId, styleConnection, {
    platformId: stylePlatform,
    authorExternalAccountId: styleAccount,
    externalId: "style-post-1",
    body: "Beauty skincare fashion outfit creator lifestyle visual story.",
    contentType: "video",
  });

  const devPerson = await person("Ada Engineer");
  const stylePerson = await person("Bea Creator");
  await linkFixture(scope.scopeId, devPerson, devAccount);
  await linkFixture(scope.scopeId, stylePerson, styleAccount);

  const first = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson, policyKey: "sprint-12-social" });
  const retry = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson, policyKey: "sprint-12-social" });
  assert.equal(retry.profileId, first.profileId);
  assert.equal(retry.createdNewVersion, false);
  assert.deepEqual(retry.profile.dimensions, first.profile.dimensions);

  const style = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: stylePerson, policyKey: "sprint-12-social" });
  assert.notDeepEqual(style.profile.topics, first.profile.topics);
  assert.ok(first.profile.topics.includes("software_engineering"));
  assert.ok(first.profile.topics.includes("ai_automation"));
  assert.ok(style.profile.topics.includes("fashion_beauty"));
  assert.ok(style.profile.audienceTypes.includes("creator"));

  const row = await currentDna(devPerson);
  assert.ok(row.stated_signals.some((signal) => signal.sourceKind === "STATED"));
  assert.ok(row.observed_signals.some((signal) => signal.sourceKind === "OBSERVED"));
  assert.ok(row.evidence.every((item) => item.sourceKind && item.signalType && item.classificationVersion));
  assert.equal(Number(row.confidence.sourceCount), row.evidence.length);

  await pool.query("DELETE FROM social_content_observations WHERE content_item_id = $1", [removedSource]);
  const changed = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson, policyKey: "sprint-12-social" });
  assert.equal(changed.createdNewVersion, true);
  assert.equal(changed.version, first.version + 1);
  assert.equal(changed.profile.evidence.some((item) => item.contentItemId === removedSource), false);
  assert.equal((await pool.query("SELECT count(*) FROM social_dna_profiles WHERE person_id = $1", [devPerson])).rows[0].count, "2");

  await content(scope.scopeId, devConnection, {
    platformId: devPlatform,
    authorExternalAccountId: devAccount,
    externalId: "dev-post-robotics",
    body: "Robotics automation for developer workflow teams.",
    contentType: "post",
  });
  const beforePolicyChange = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: devPerson,
    policyKey: "sprint-12-social",
    algorithmVersion: "policy-a",
  });
  assert.equal(beforePolicyChange.profile.topics.includes("robotics"), false);
  await api.persistSocialDnaPolicy({ policy: socialPolicyB });
  const activeSocialPolicies = await pool.query("SELECT version FROM social_dna_policies WHERE policy_key = 'sprint-12-social' AND active = true");
  assert.equal(activeSocialPolicies.rowCount, 1);
  assert.equal(activeSocialPolicies.rows[0].version, "v2");
  const afterPolicyChange = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: devPerson,
    policyKey: "sprint-12-social",
    algorithmVersion: "policy-b",
  });
  assert.ok(afterPolicyChange.profile.topics.includes("robotics"));
});

test("Sprint 12 identity resolution: policy-driven, auditable, idempotent, and provenance-safe", { skip }, async () => {
  await reset();
  const userId = await user("identity@example.test");
  const scope = await api.ensurePersonalScope(userId);
  const xPlatform = await platform("sprint12-x");
  const inPlatform = await platform("sprint12-linkedin");
  const xConnection = await connection(scope.scopeId, xPlatform, "x-owner");
  const inConnection = await connection(scope.scopeId, inPlatform, "in-owner");

  await api.persistIdentityResolutionPolicy({ policy: policyA });
  await api.persistSocialDnaPolicy({ policy: socialPolicyA });
  const accountA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "ada-x",
    handle: "adaai",
    displayName: "Ada Lovelace",
    bio: "AI automation software engineering for SaaS workflows.",
    location: "London",
    website: "https://ada.example",
    metadata: { company: "Analytical Engines", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const accountB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "ada-in",
    handle: "ada-lovelace",
    displayName: "Ada Lovelace",
    bio: "Software engineering and AI automation leader for SaaS teams.",
    location: "London",
    website: "https://ada.example",
    metadata: { company: "Analytical Engines", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  await content(scope.scopeId, xConnection, {
    platformId: xPlatform,
    authorExternalAccountId: accountA,
    externalId: "ada-x-post",
    body: "Software engineering automation for AI SaaS developer teams.",
  });
  await content(scope.scopeId, inConnection, {
    platformId: inPlatform,
    authorExternalAccountId: accountB,
    externalId: "ada-in-post",
    body: "Backend TypeScript developer platform automation.",
  });

  const strong = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: accountA,
    accountBId: accountB,
    policyKey: "sprint-12",
  });
  assert.equal(strong.status, "LINKED");
  assert.equal(strong.confidence, "HIGH");
  assert.ok(strong.personId);

  const reversed = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: accountB,
    accountBId: accountA,
    policyKey: "sprint-12",
  });
  assert.equal(reversed.candidateId, strong.candidateId);
  assert.equal(
    (await pool.query("SELECT count(*) FROM identity_resolution_candidates WHERE id = $1", [strong.candidateId])).rows[0].count,
    "1",
  );

  const johnLondon = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "john-london",
    handle: "johnfin",
    displayName: "John Smith",
    bio: "London fintech payments banking market operator.",
    location: "London",
    website: "https://john-fin.example",
    metadata: { company: "FinPay", role: "Founder", topics: ["finance"] },
  });
  const johnToronto = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "john-toronto",
    handle: "johnhomes",
    displayName: "John Smith",
    bio: "Toronto real estate property broker for family homes.",
    location: "Toronto",
    website: "https://john-homes.example",
    metadata: { company: "Homes North", role: "Broker", topics: ["real_estate"] },
  });
  const collision = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: johnLondon,
    accountBId: johnToronto,
    policyKey: "sprint-12",
  });
  assert.equal(collision.status, "PENDING");
  assert.notEqual(collision.confidence, "HIGH");
  const collisionRow = await pool.query("SELECT contradictions FROM identity_resolution_candidates WHERE id = $1", [collision.candidateId]);
  assert.ok(collisionRow.rows[0].contradictions.length >= 2);

  await api.rejectIdentityCandidate({ candidateId: collision.candidateId, actorUserId: userId, reason: "Different public company and country" });
  const rejectedAgain = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: johnToronto,
    accountBId: johnLondon,
    policyKey: "sprint-12",
  });
  assert.equal(rejectedAgain.candidateId, collision.candidateId);
  assert.equal(rejectedAgain.status, "REJECTED");

  await api.persistIdentityResolutionPolicy({ policy: policyB });
  const activeIdentityPolicies = await pool.query("SELECT version FROM identity_resolution_policies WHERE policy_key = 'sprint-12' AND active = true");
  assert.equal(activeIdentityPolicies.rowCount, 1);
  assert.equal(activeIdentityPolicies.rows[0].version, "v2");
  const topicOnlyA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "topic-a",
    handle: "topic-a",
    displayName: "Different Name",
    bio: "AI automation software engineering",
    location: "Remote",
    website: null,
    metadata: { company: "Builder Collective", role: "Builder", topics: ["ai_automation", "software_engineering"] },
  });
  const topicOnlyB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "topic-b",
    handle: "topic-b",
    displayName: "Other Person",
    bio: "AI automation software engineering",
    location: "Remote",
    website: null,
    metadata: { company: "Builder Collective", role: "Builder", topics: ["ai_automation", "software_engineering"] },
  });
  const policyChanged = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: topicOnlyA,
    accountBId: topicOnlyB,
    policyKey: "sprint-12",
  });
  assert.equal(policyChanged.confidence, "MEDIUM");
  assert.equal(policyChanged.status, "PENDING");

  const manualPerson = await api.linkIdentityCandidate({ candidateId: policyChanged.candidateId, actorUserId: userId, reason: "Operator reviewed same person" });
  assert.ok(manualPerson);
  assert.equal((await pool.query("SELECT count(*) FROM identity_resolution_decisions WHERE candidate_id = $1 AND action = 'LINK'", [policyChanged.candidateId])).rows[0].count, "1");

  await api.splitIdentityCandidate({ candidateId: policyChanged.candidateId, actorUserId: userId, reason: "Correcting mistaken link" });
  const confirmedAfterSplit = await pool.query(
    "SELECT count(DISTINCT person_id) FROM canonical_person_accounts WHERE external_account_id IN ($1, $2) AND status = 'CONFIRMED'",
    [topicOnlyA, topicOnlyB],
  );
  assert.equal(confirmedAfterSplit.rows[0].count, "2");

  const concurrentResults = await Promise.all([
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: accountA, accountBId: accountB, policyKey: "sprint-12" }),
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: accountB, accountBId: accountA, policyKey: "sprint-12" }),
  ]);
  assert.equal(concurrentResults[0].candidateId, concurrentResults[1].candidateId);

  const personA = await person("Canonical John London Only");
  await linkFixture(scope.scopeId, personA, johnLondon);
  const beforeCandidateDna = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: personA,
    policyKey: "sprint-12-social",
    algorithmVersion: "candidate-boundary-v1",
  });
  assert.equal(beforeCandidateDna.profile.evidence.some((item) => item.externalAccountId === johnToronto), false);

  const confirmedDna = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: strong.personId,
    policyKey: "sprint-12-social",
    algorithmVersion: "confirmed-aggregate-v1",
  });
  const evidenceAccounts = new Set(confirmedDna.profile.evidence.map((item) => item.externalAccountId).filter(Boolean));
  assert.ok(evidenceAccounts.has(accountA));
  assert.ok(evidenceAccounts.has(accountB));
});

test("Sprint 12 closure: configurable identity thresholds and canonical union are concurrency safe", { skip }, async () => {
  await reset();
  const userId = await user("closure-union@example.test");
  const scope = await api.ensurePersonalScope(userId);
  const xPlatform = await platform("sprint12-closure-x");
  const inPlatform = await platform("sprint12-closure-in");
  const xConnection = await connection(scope.scopeId, xPlatform, "closure-x-owner");
  const inConnection = await connection(scope.scopeId, inPlatform, "closure-in-owner");

  await api.persistIdentityResolutionPolicy({
    policy: {
      ...policyA,
      policyKey: "threshold-test",
      version: "low",
      autoLinkThreshold: 80,
      manualReviewThreshold: 50,
      minimumPositiveSignals: 1,
      signals: [{ key: "name_similarity", weight: 100, threshold: 0.3 }],
    },
  });
  const thresholdA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "threshold-a",
    handle: "threshold-a",
    displayName: "Ada Lovelace",
    bio: "Engineering.",
    location: "London",
    website: null,
  });
  const thresholdB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "threshold-b",
    handle: "threshold-b",
    displayName: "Ada Byron",
    bio: "Engineering.",
    location: "London",
    website: null,
  });
  const lowThreshold = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: thresholdA,
    accountBId: thresholdB,
    policyKey: "threshold-test",
  });
  assert.equal(lowThreshold.status, "LINKED");
  await api.persistIdentityResolutionPolicy({
    policy: {
      ...policyA,
      policyKey: "threshold-test",
      version: "high",
      autoLinkThreshold: 80,
      manualReviewThreshold: 50,
      minimumPositiveSignals: 1,
      signals: [{ key: "name_similarity", weight: 100, threshold: 0.8 }],
    },
  });
  const highThreshold = await api.resolveIdentityCandidate({
    scopeId: scope.scopeId,
    accountAId: thresholdA,
    accountBId: thresholdB,
    policyKey: "threshold-test",
  });
  assert.equal(highThreshold.status, "PENDING");

  await api.persistIdentityResolutionPolicy({ policy: policyA });
  const accountA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "union-a",
    handle: "union-a",
    displayName: "Union Person",
    bio: "AI automation software engineering for SaaS.",
    location: "London",
    website: "https://union.example",
    metadata: { company: "Union Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const accountB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "union-b",
    handle: "union-b",
    displayName: "Union Person",
    bio: "Software engineering and AI automation.",
    location: "London",
    website: "https://union.example",
    metadata: { company: "Union Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const accountC = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "union-c",
    handle: "union-c",
    displayName: "Union Person",
    bio: "SaaS software engineering automation.",
    location: "London",
    website: "https://union.example",
    metadata: { company: "Union Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const overlapping = await Promise.all([
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: accountA, accountBId: accountB, policyKey: "sprint-12" }),
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: accountB, accountBId: accountC, policyKey: "sprint-12" }),
  ]);
  assert.equal(overlapping.every((result) => result.status === "LINKED"), true);
  const cluster = await pool.query(
    "SELECT count(DISTINCT person_id) AS people, count(*) AS links FROM canonical_person_accounts WHERE external_account_id = ANY($1::uuid[]) AND status = 'CONFIRMED'",
    [[accountA, accountB, accountC]],
  );
  assert.equal(cluster.rows[0].people, "1");
  assert.equal(cluster.rows[0].links, "3");

  const reverseA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "reverse-a",
    handle: "reverse-a",
    displayName: "Reverse Person",
    bio: "AI automation software engineering.",
    location: "Berlin",
    website: "https://reverse.example",
    metadata: { company: "Reverse Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const reverseB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "reverse-b",
    handle: "reverse-b",
    displayName: "Reverse Person",
    bio: "AI automation software engineering.",
    location: "Berlin",
    website: "https://reverse.example",
    metadata: { company: "Reverse Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const reverseC = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "reverse-c",
    handle: "reverse-c",
    displayName: "Reverse Person",
    bio: "AI automation software engineering.",
    location: "Berlin",
    website: "https://reverse.example",
    metadata: { company: "Reverse Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  await Promise.all([
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: reverseB, accountBId: reverseC, policyKey: "sprint-12" }),
    api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: reverseA, accountBId: reverseB, policyKey: "sprint-12" }),
  ]);
  const reverseCluster = await pool.query(
    "SELECT count(DISTINCT person_id) AS people FROM canonical_person_accounts WHERE external_account_id = ANY($1::uuid[]) AND status = 'CONFIRMED'",
    [[reverseA, reverseB, reverseC]],
  );
  assert.equal(reverseCluster.rows[0].people, "1");

  const personOne = await person("Existing One");
  const personTwo = await person("Existing Two");
  const existingA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "existing-a",
    handle: "existing-a",
    displayName: "Existing Cluster",
    bio: "AI automation software engineering.",
    location: "Rome",
    website: "https://existing.example",
    metadata: { company: "Existing Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const existingB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "existing-b",
    handle: "existing-b",
    displayName: "Existing Cluster",
    bio: "AI automation software engineering.",
    location: "Rome",
    website: "https://existing.example",
    metadata: { company: "Existing Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const existingC = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "existing-c",
    handle: "existing-c",
    displayName: "Existing Cluster",
    bio: "AI automation software engineering.",
    location: "Rome",
    website: "https://existing.example",
    metadata: { company: "Existing Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  await linkFixture(scope.scopeId, personOne, existingA);
  await linkFixture(scope.scopeId, personTwo, existingB);
  await linkFixture(scope.scopeId, personTwo, existingC);
  await api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: existingA, accountBId: existingB, policyKey: "sprint-12" });
  const existingUnion = await pool.query(
    "SELECT count(DISTINCT person_id) AS people FROM canonical_person_accounts WHERE external_account_id = ANY($1::uuid[]) AND status = 'CONFIRMED'",
    [[existingA, existingB, existingC]],
  );
  assert.equal(existingUnion.rows[0].people, "1");

  await api.splitIdentityCandidate({ candidateId: overlapping[0].candidateId, actorUserId: userId, reason: "First split" });
  await api.linkIdentityCandidate({ candidateId: overlapping[0].candidateId, actorUserId: userId, reason: "Relink after review" });
  await api.splitIdentityCandidate({ candidateId: overlapping[0].candidateId, actorUserId: userId, reason: "Second split" });
  const splitHistory = await pool.query(
    `
      SELECT
        count(*) FILTER (WHERE status = 'SPLIT') AS split_rows,
        count(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed_rows,
        count(DISTINCT external_account_id) FILTER (WHERE status = 'CONFIRMED') AS confirmed_accounts
      FROM canonical_person_accounts
      WHERE external_account_id = ANY($1::uuid[])
    `,
    [[accountA, accountB]],
  );
  assert.equal(splitHistory.rows[0].split_rows, "4");
  assert.equal(splitHistory.rows[0].confirmed_rows, "2");
  assert.equal(splitHistory.rows[0].confirmed_accounts, "2");
});

test("Sprint 12 closure: Social DNA stated provenance and split invalidation are membership-safe", { skip }, async () => {
  await reset();
  const userId = await user("closure-dna@example.test");
  const scope = await api.ensurePersonalScope(userId);
  const xPlatform = await platform("sprint12-dna-x");
  const inPlatform = await platform("sprint12-dna-in");
  const xConnection = await connection(scope.scopeId, xPlatform, "dna-x-owner");
  const inConnection = await connection(scope.scopeId, inPlatform, "dna-in-owner");
  await api.persistIdentityResolutionPolicy({ policy: policyA });
  await api.persistSocialDnaPolicy({ policy: socialPolicyA });

  const accountA = await account(scope.scopeId, xConnection, {
    platformId: xPlatform,
    externalId: "dna-a",
    handle: "dna-a",
    displayName: "Dna Person",
    bio: "AI automation software engineering.",
    location: "London",
    website: "https://dna.example/a",
    metadata: { company: "DNA Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const accountB = await account(scope.scopeId, inConnection, {
    platformId: inPlatform,
    externalId: "dna-b",
    handle: "dna-b",
    displayName: "Dna Person",
    bio: "SaaS product growth automation.",
    location: "New York",
    website: "https://dna.example/b",
    metadata: { company: "DNA Co", role: "CTO", topics: ["ai_automation", "software_engineering"] },
  });
  const contentA = await content(scope.scopeId, xConnection, {
    platformId: xPlatform,
    authorExternalAccountId: accountA,
    externalId: "dna-a-post",
    body: "Software engineering and AI automation for developer teams.",
  });
  const contentB = await content(scope.scopeId, inConnection, {
    platformId: inPlatform,
    authorExternalAccountId: accountB,
    externalId: "dna-b-post",
    body: "SaaS product growth automation for platform teams.",
  });

  const linked = await api.resolveIdentityCandidate({ scopeId: scope.scopeId, accountAId: accountA, accountBId: accountB, policyKey: "sprint-12" });
  assert.equal(linked.status, "PENDING");
  const linkedPersonId = await api.linkIdentityCandidate({
    candidateId: linked.candidateId,
    actorUserId: userId,
    reason: "Manual confirmation despite conflicting stated locations",
  });
  const aggregate = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: linkedPersonId,
    policyKey: "sprint-12-social",
    algorithmVersion: "split-membership-v1",
  });
  const statedLocations = aggregate.profile.statedSignals.filter((signal) => signal.key === "location");
  assert.deepEqual(new Set(statedLocations.map((signal) => signal.value)), new Set(["London", "New York"]));
  assert.ok(statedLocations.some((signal) => signal.evidence[0]?.externalAccountId === accountA));
  assert.ok(statedLocations.some((signal) => signal.evidence[0]?.externalAccountId === accountB));

  await api.splitIdentityCandidate({ candidateId: linked.candidateId, actorUserId: userId, reason: "Separate confirmed accounts" });
  const stale = await pool.query("SELECT is_current FROM social_dna_profiles WHERE id = $1", [aggregate.profileId]);
  assert.equal(stale.rows[0].is_current, false);
  const splitPeople = await pool.query(
    "SELECT external_account_id, person_id FROM canonical_person_accounts WHERE external_account_id = ANY($1::uuid[]) AND status = 'CONFIRMED'",
    [[accountA, accountB]],
  );
  assert.equal(splitPeople.rowCount, 2);
  const personByAccount = new Map(splitPeople.rows.map((row) => [row.external_account_id, row.person_id]));
  const dnaA = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: personByAccount.get(accountA),
    policyKey: "sprint-12-social",
    algorithmVersion: "split-membership-v2",
  });
  const dnaB = await api.recomputeSocialDnaForPerson({
    scopeId: scope.scopeId,
    personId: personByAccount.get(accountB),
    policyKey: "sprint-12-social",
    algorithmVersion: "split-membership-v2",
  });
  assert.ok(dnaA.profile.evidence.some((item) => item.externalAccountId === accountA || item.contentItemId === contentA));
  assert.equal(dnaA.profile.evidence.some((item) => item.externalAccountId === accountB || item.contentItemId === contentB), false);
  assert.ok(dnaB.profile.evidence.some((item) => item.externalAccountId === accountB || item.contentItemId === contentB));
  assert.equal(dnaB.profile.evidence.some((item) => item.externalAccountId === accountA || item.contentItemId === contentA), false);
  assert.equal((await pool.query("SELECT count(*) FROM social_external_accounts WHERE id = ANY($1::uuid[])", [[accountA, accountB]])).rows[0].count, "2");
  assert.equal((await pool.query("SELECT count(*) FROM social_content_items WHERE id = ANY($1::uuid[])", [[contentA, contentB]])).rows[0].count, "2");
});
