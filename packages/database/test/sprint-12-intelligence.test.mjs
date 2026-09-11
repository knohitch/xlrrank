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
    "INSERT INTO canonical_person_accounts (scope_id, person_id, external_account_id, status) VALUES ($1, $2, $3, 'CONFIRMED')",
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
    { key: "name_similarity", weight: 20 },
    { key: "company_match", weight: 20 },
    { key: "location_match", weight: 10 },
    { key: "bio_similarity", weight: 15 },
  ],
};

const policyB = {
  ...policyA,
  version: "v2",
  autoLinkThreshold: 95,
  manualReviewThreshold: 70,
  minimumPositiveSignals: 3,
  signals: [
    { key: "name_similarity", weight: 10 },
    { key: "website_domain_match", weight: 5 },
    { key: "company_match", weight: 5 },
    { key: "topic_similarity", weight: 80 },
  ],
};

test("Sprint 12 Social DNA: deterministic, evidence-backed, versioned, and deletion-aware", { skip }, async () => {
  await reset();
  const userId = await user();
  const scope = await api.ensurePersonalScope(userId);
  const devPlatform = await platform("sprint12-dev");
  const stylePlatform = await platform("sprint12-style");
  const devConnection = await connection(scope.scopeId, devPlatform, "dev-owner");
  const styleConnection = await connection(scope.scopeId, stylePlatform, "style-owner");

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

  const first = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson });
  const retry = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson });
  assert.equal(retry.profileId, first.profileId);
  assert.equal(retry.createdNewVersion, false);
  assert.deepEqual(retry.profile.dimensions, first.profile.dimensions);

  const style = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: stylePerson });
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
  const changed = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: devPerson });
  assert.equal(changed.createdNewVersion, true);
  assert.equal(changed.version, first.version + 1);
  assert.equal(changed.profile.evidence.some((item) => item.contentItemId === removedSource), false);
  assert.equal((await pool.query("SELECT count(*) FROM social_dna_profiles WHERE person_id = $1", [devPerson])).rows[0].count, "2");
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
  await pool.query("UPDATE identity_resolution_policies SET active = false WHERE policy_key = 'sprint-12' AND version = 'v1'");
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
  const beforeCandidateDna = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: personA, algorithmVersion: "candidate-boundary-v1" });
  assert.equal(beforeCandidateDna.profile.evidence.some((item) => item.externalAccountId === johnToronto), false);

  const confirmedDna = await api.recomputeSocialDnaForPerson({ scopeId: scope.scopeId, personId: strong.personId, algorithmVersion: "confirmed-aggregate-v1" });
  const evidenceAccounts = new Set(confirmedDna.profile.evidence.map((item) => item.externalAccountId).filter(Boolean));
  assert.ok(evidenceAccounts.has(accountA));
  assert.ok(evidenceAccounts.has(accountB));
});
