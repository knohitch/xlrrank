import type { Pool, PoolClient, QueryResult } from "pg";
import {
  generateSocialDna,
  matchIdentity,
  orderedPair,
  shouldAutoMerge,
  validateIdentityResolutionPolicy,
  validateSocialDnaPolicy,
  type IdentityAccountInput,
  type IdentityResolutionPolicy,
  type SocialDnaPolicy,
  type SocialDnaProfile,
} from "@xlrrank/intelligence";
import { getPool } from "../client.js";
import { invalidateIntelligenceForPeople } from "./discovery-relationship.js";

type Executor = Pick<Pool | PoolClient, "query">;

export interface PersistIdentityResolutionPolicyInput {
  policy: IdentityResolutionPolicy;
  active?: boolean;
}

export interface PersistSocialDnaPolicyInput {
  policy: SocialDnaPolicy;
  active?: boolean;
}

export interface ResolveIdentityCandidateInput {
  scopeId: string;
  accountAId: string;
  accountBId: string;
  policyKey: string;
}

export interface ManualIdentityDecisionInput {
  candidateId: string;
  actorUserId?: string | null;
  reason?: string;
}

export interface RecomputeSocialDnaInput {
  scopeId: string;
  personId: string;
  algorithmVersion?: string;
  policyKey?: string;
}

export async function persistIdentityResolutionPolicy(
  input: PersistIdentityResolutionPolicyInput,
  executor: Executor = getPool(),
): Promise<string> {
  const policy = validateIdentityResolutionPolicy(input.policy);
  return persistVersionedPolicy(executor, {
    table: "identity_resolution_policies",
    key: policy.policyKey,
    version: policy.version,
    config: policy,
    active: input.active ?? true,
  });
}

export async function persistSocialDnaPolicy(
  input: PersistSocialDnaPolicyInput,
  executor: Executor = getPool(),
): Promise<string> {
  const policy = validateSocialDnaPolicy(input.policy);
  return persistVersionedPolicy(executor, {
    table: "social_dna_policies",
    key: policy.policyKey,
    version: policy.version,
    config: policy,
    active: input.active ?? true,
  });
}

async function persistVersionedPolicy(
  executor: Executor,
  input: {
    table: "identity_resolution_policies" | "social_dna_policies";
    key: string;
    version: string;
    config: unknown;
    active: boolean;
  },
): Promise<string> {
  const run = async (client: Executor): Promise<string> => {
    if (input.active) {
      await client.query(
        `UPDATE ${input.table} SET active = false, updated_at = now() WHERE policy_key = $1 AND version <> $2`,
        [input.key, input.version],
      );
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
  const maybePool = executor as Executor & { connect?: () => Promise<PoolClient> };
  if (typeof maybePool.connect === "function") {
    const client = await maybePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `policy:${input.table}:${input.key}`,
      ]);
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
  return run(executor);
}

export async function resolveIdentityCandidate(input: ResolveIdentityCandidateInput): Promise<{
  candidateId: string;
  status: string;
  confidence: string;
  score: number;
  personId?: string;
}> {
  const [accountAId, accountBId] = orderedPair(input.accountAId, input.accountBId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `identity-resolution:${input.scopeId}:${accountAId}:${accountBId}:${input.policyKey}`,
    ]);
    const policy = await loadActivePolicy(client, input.policyKey);
    const [accountA, accountB] = await Promise.all([
      loadAccountForIdentity(client, input.scopeId, accountAId),
      loadAccountForIdentity(client, input.scopeId, accountBId),
    ]);
    const match = matchIdentity(accountA, accountB, policy);
    const targetStatus = shouldAutoMerge(match, policy) ? "LINKED" : match.recommendedStatus;
    const candidate = await client.query<{
      id: string;
      status: string;
      confidence: string;
      score: string;
    }>(
      `
        INSERT INTO identity_resolution_candidates (
          scope_id, account_a_id, account_b_id, status, confidence, score,
          reasons, contradictions, policy_key, policy_version, evidence_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (
          scope_id, account_a_id, account_b_id, policy_key, policy_version, evidence_fingerprint
        )
        DO UPDATE SET updated_at = identity_resolution_candidates.updated_at
        RETURNING id, status, confidence, score
      `,
      [
        input.scopeId,
        accountAId,
        accountBId,
        targetStatus,
        match.confidence,
        match.matchScore,
        JSON.stringify(match.signals),
        JSON.stringify(match.contradictions),
        match.policyKey,
        match.policyVersion,
        match.evidenceFingerprint,
      ],
    );
    const row = candidate.rows[0];
    if (!row) throw new Error("Identity candidate was not persisted");
    let personId: string | undefined;
    if (row.status === "LINKED") {
      personId = await linkCandidateAccounts(client, row.id);
    }
    await client.query("COMMIT");
    const response: {
      candidateId: string;
      status: string;
      confidence: string;
      score: number;
      personId?: string;
    } = {
      candidateId: row.id,
      status: row.status,
      confidence: row.confidence,
      score: Number(row.score),
    };
    if (personId) response.personId = personId;
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectIdentityCandidate(input: ManualIdentityDecisionInput): Promise<void> {
  await withDecisionTransaction(input.candidateId, async (client, candidate) => {
    await updateCandidateStatus(client, input.candidateId, "REJECTED", input.actorUserId ?? null);
    await recordDecision(
      client,
      input.candidateId,
      input.actorUserId ?? null,
      "REJECT",
      candidate.status,
      "REJECTED",
      input.reason,
    );
  });
}

export async function linkIdentityCandidate(input: ManualIdentityDecisionInput): Promise<string> {
  return withDecisionTransaction(input.candidateId, async (client, candidate) => {
    const personId = await linkCandidateAccounts(client, input.candidateId);
    await updateCandidateStatus(client, input.candidateId, "LINKED", input.actorUserId ?? null);
    await recordDecision(
      client,
      input.candidateId,
      input.actorUserId ?? null,
      "LINK",
      candidate.status,
      "LINKED",
      input.reason,
    );
    return personId;
  });
}

export async function splitIdentityCandidate(input: ManualIdentityDecisionInput): Promise<void> {
  await withDecisionTransaction(input.candidateId, async (client, candidate) => {
    const accounts = await candidateAccounts(client, input.candidateId);
    await lockMembershipScope(client, accounts.scopeId);
    await lockMembershipAccounts(client, accounts.scopeId, [
      accounts.accountAId,
      accounts.accountBId,
    ]);
    const priorMemberships = await loadConfirmedMemberships(client, accounts.scopeId, [
      accounts.accountAId,
      accounts.accountBId,
    ]);
    const priorPersonIds = uniqueSortedStrings(priorMemberships.map((row) => row.person_id));
    const priorClusterAccounts = await loadConfirmedAccountsForPeople(
      client,
      accounts.scopeId,
      priorPersonIds,
    );
    const affectedAccountIds = uniqueSortedStrings([
      accounts.accountAId,
      accounts.accountBId,
      ...priorClusterAccounts.map((row) => row.external_account_id),
    ]);
    await invalidateCurrentSocialDnaForPeople(client, accounts.scopeId, priorPersonIds);
    await client.query(
      `
        UPDATE canonical_person_accounts
        SET status = 'SPLIT', split_at = now(), updated_at = now()
        WHERE scope_id = $1 AND external_account_id IN ($2, $3) AND status = 'CONFIRMED'
      `,
      [accounts.scopeId, accounts.accountAId, accounts.accountBId],
    );
    const newPersonIds: string[] = [];
    for (const accountId of [accounts.accountAId, accounts.accountBId]) {
      const personId = await createPersonFromAccount(client, accountId);
      newPersonIds.push(personId);
      await insertConfirmedAccountLink(
        client,
        accounts.scopeId,
        personId,
        accountId,
        input.candidateId,
      );
    }
    await updateCandidateStatus(client, input.candidateId, "SPLIT", input.actorUserId ?? null);
    await recordDecision(
      client,
      input.candidateId,
      input.actorUserId ?? null,
      "SPLIT",
      candidate.status,
      "SPLIT",
      input.reason,
    );
    await invalidateCurrentSocialDnaForPeople(client, accounts.scopeId, [
      ...priorPersonIds,
      ...newPersonIds,
    ]);
    await invalidateStaleLinkedCandidates(client, {
      scopeId: accounts.scopeId,
      affectedAccountIds,
      sourceCandidateId: input.candidateId,
      actorUserId: input.actorUserId ?? null,
    });
  });
}

export async function recomputeSocialDnaForPerson(input: RecomputeSocialDnaInput): Promise<{
  profileId: string;
  version: number;
  createdNewVersion: boolean;
  profile: SocialDnaProfile;
}> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `social-dna:${input.scopeId}:${input.personId}:${input.algorithmVersion ?? "default"}`,
    ]);
    const profile = generateSocialDna(await loadSocialDnaInput(client, input));
    const existing = await client.query<{ id: string; version: number }>(
      `
        SELECT id, version
        FROM social_dna_profiles
        WHERE person_id = $1 AND algorithm_version = $2 AND source_fingerprint = $3
        ORDER BY version DESC
        LIMIT 1
      `,
      [input.personId, profile.algorithmVersion, profile.sourceFingerprint],
    );
    if (existing.rowCount && existing.rows[0]) {
      await client.query(
        "UPDATE social_dna_profiles SET is_current = (id = $1), superseded_at = CASE WHEN id = $1 THEN NULL ELSE COALESCE(superseded_at, now()) END WHERE person_id = $2",
        [existing.rows[0].id, input.personId],
      );
      await client.query("COMMIT");
      return {
        profileId: existing.rows[0].id,
        version: existing.rows[0].version,
        createdNewVersion: false,
        profile,
      };
    }

    const nextVersion = await client.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM social_dna_profiles WHERE person_id = $1",
      [input.personId],
    );
    await client.query(
      "UPDATE social_dna_profiles SET is_current = false, superseded_at = COALESCE(superseded_at, now()) WHERE person_id = $1 AND is_current = true",
      [input.personId],
    );
    const inserted = await client.query<{ id: string; version: number }>(
      `
        INSERT INTO social_dna_profiles (
          scope_id, person_id, version, dimensions, confidence, source_kind,
          stated_signals, observed_signals, evidence, algorithm_version,
          source_fingerprint, source_window, is_current
        )
        VALUES ($1, $2, $3, $4, $5, 'DERIVED', $6, $7, $8, $9, $10, $11, true)
        RETURNING id, version
      `,
      [
        input.scopeId,
        input.personId,
        nextVersion.rows[0]?.version ?? 1,
        JSON.stringify(semanticSocialDnaDimensions(profile)),
        JSON.stringify({ sourceCount: profile.sourceWindow.sourceCount }),
        JSON.stringify(profile.statedSignals),
        JSON.stringify(profile.observedSignals),
        JSON.stringify(profile.evidence),
        profile.algorithmVersion,
        profile.sourceFingerprint,
        JSON.stringify(profile.sourceWindow),
      ],
    );
    await client.query("COMMIT");
    const insertedRow = inserted.rows[0];
    if (!insertedRow) throw new Error("Social DNA profile was not persisted");
    return {
      profileId: insertedRow.id,
      version: insertedRow.version,
      createdNewVersion: true,
      profile,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadActivePolicy(
  executor: Executor,
  policyKey: string,
): Promise<IdentityResolutionPolicy> {
  const result = await executor.query<{ config: IdentityResolutionPolicy }>(
    `
      SELECT config
      FROM identity_resolution_policies
      WHERE policy_key = $1 AND active = true
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [policyKey],
  );
  if (!result.rowCount || !result.rows[0])
    throw new Error(`Identity resolution policy '${policyKey}' is not configured`);
  return validateIdentityResolutionPolicy(result.rows[0].config);
}

async function loadActiveSocialDnaPolicy(
  executor: Executor,
  policyKey: string,
): Promise<SocialDnaPolicy> {
  const result = await executor.query<{ config: SocialDnaPolicy }>(
    `
      SELECT config
      FROM social_dna_policies
      WHERE policy_key = $1 AND active = true
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [policyKey],
  );
  if (!result.rowCount || !result.rows[0])
    throw new Error(`Social DNA policy '${policyKey}' is not configured`);
  return validateSocialDnaPolicy(result.rows[0].config);
}

function semanticSocialDnaDimensions(profile: SocialDnaProfile): SocialDnaProfile["dimensions"] {
  const dimensions = [...profile.dimensions];
  const addDimension = (key: string, label: string, values: string[]) => {
    if (values.length === 0 || dimensions.some((dimension) => dimension.key === key)) return;
    dimensions.push({
      key,
      label,
      values,
      confidence: 1,
      sourceKind: "OBSERVED",
      evidence: profile.evidence,
    });
  };
  addDimension("topics", "Topics", profile.topics);
  addDimension("expertise", "Expertise", profile.expertise);
  addDimension("interests", "Interests", profile.interests);
  return dimensions;
}

async function loadAccountForIdentity(
  executor: Executor,
  scopeId: string,
  accountId: string,
): Promise<IdentityAccountInput> {
  const result = await executor.query<{
    id: string;
    platform_id: string;
    external_id: string;
    current_handle: string | null;
    display_name: string | null;
    bio: string | null;
    location: string | null;
    website: string | null;
    profile_url: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT sea.id, sea.platform_id, sea.external_id, sea.current_handle, sea.display_name,
             sea.bio, sea.location, sea.website, sea.profile_url, sea.metadata
      FROM social_external_accounts sea
      WHERE sea.id = $1
        AND EXISTS (
          SELECT 1 FROM social_account_observations sao
          WHERE sao.scope_id = $2 AND sao.external_account_id = sea.id
        )
    `,
    [accountId, scopeId],
  );
  if (!result.rowCount || !result.rows[0])
    throw new Error(`Social external account '${accountId}' is not available in scope`);
  const row = result.rows[0];
  const metadata = row.metadata ?? {};
  return {
    id: row.id,
    platformId: row.platform_id,
    externalId: row.external_id,
    name: row.display_name,
    handle: row.current_handle,
    bio: row.bio,
    location: row.location,
    website: row.website,
    profileUrl: row.profile_url,
    company: typeof metadata.company === "string" ? metadata.company : null,
    role: typeof metadata.role === "string" ? metadata.role : null,
    topics: Array.isArray(metadata.topics)
      ? metadata.topics.filter((item): item is string => typeof item === "string")
      : [],
  };
}

async function withDecisionTransaction<T>(
  candidateId: string,
  fn: (client: PoolClient, candidate: { status: string }) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `identity-decision:${candidateId}`,
    ]);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM identity_resolution_candidates WHERE id = $1 FOR UPDATE",
      [candidateId],
    );
    if (!candidate.rowCount || !candidate.rows[0])
      throw new Error(`Identity candidate '${candidateId}' not found`);
    const result = await fn(client, candidate.rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function linkCandidateAccounts(executor: Executor, candidateId: string): Promise<string> {
  const accounts = await candidateAccounts(executor, candidateId);
  await lockMembershipScope(executor, accounts.scopeId);
  await lockMembershipAccounts(executor, accounts.scopeId, [
    accounts.accountAId,
    accounts.accountBId,
  ]);
  const directMemberships = await loadConfirmedMemberships(executor, accounts.scopeId, [
    accounts.accountAId,
    accounts.accountBId,
  ]);
  let candidatePersonIds = uniqueSortedStrings(directMemberships.map((row) => row.person_id));

  if (candidatePersonIds.length > 1) {
    const clusterRows = await loadConfirmedAccountsForPeople(
      executor,
      accounts.scopeId,
      candidatePersonIds,
    );
    await lockMembershipAccounts(
      executor,
      accounts.scopeId,
      uniqueSortedStrings(clusterRows.map((row) => row.external_account_id)),
    );
    const refreshedRows = await loadConfirmedAccountsForPeople(
      executor,
      accounts.scopeId,
      candidatePersonIds,
    );
    candidatePersonIds = uniqueSortedStrings(refreshedRows.map((row) => row.person_id));
  }

  const personId =
    candidatePersonIds[0] ?? (await createPersonFromAccount(executor, accounts.accountAId));
  const losingPersonIds = candidatePersonIds.filter((id) => id !== personId);
  const affectedPersonIds = uniqueSortedStrings([personId, ...losingPersonIds]);

  if (losingPersonIds.length > 0) {
    await executor.query(
      `
        UPDATE canonical_person_accounts
        SET person_id = $3,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('canonical_union_from_person_ids', $4::jsonb),
            updated_at = now()
        WHERE scope_id = $1 AND person_id = ANY($2::uuid[]) AND status = 'CONFIRMED'
      `,
      [accounts.scopeId, losingPersonIds, personId, JSON.stringify(losingPersonIds)],
    );
  }

  await insertConfirmedAccountLink(
    executor,
    accounts.scopeId,
    personId,
    accounts.accountAId,
    candidateId,
  );
  await insertConfirmedAccountLink(
    executor,
    accounts.scopeId,
    personId,
    accounts.accountBId,
    candidateId,
  );
  await invalidateCurrentSocialDnaForPeople(executor, accounts.scopeId, affectedPersonIds);
  await assertCandidateAccountsSharePerson(
    executor,
    accounts.scopeId,
    [accounts.accountAId, accounts.accountBId],
    candidateId,
  );
  return personId;
}

async function candidateAccounts(
  executor: Executor,
  candidateId: string,
): Promise<{
  scopeId: string;
  accountAId: string;
  accountBId: string;
}> {
  const result = await executor.query<{
    scope_id: string;
    account_a_id: string;
    account_b_id: string;
  }>(
    "SELECT scope_id, account_a_id, account_b_id FROM identity_resolution_candidates WHERE id = $1",
    [candidateId],
  );
  if (!result.rowCount || !result.rows[0])
    throw new Error(`Identity candidate '${candidateId}' not found`);
  return {
    scopeId: result.rows[0].scope_id,
    accountAId: result.rows[0].account_a_id,
    accountBId: result.rows[0].account_b_id,
  };
}

async function createPersonFromAccount(executor: Executor, accountId: string): Promise<string> {
  const account = await executor.query<{
    display_name: string | null;
    current_handle: string | null;
    bio: string | null;
    location: string | null;
    website: string | null;
    profile_image_url: string | null;
  }>(
    "SELECT display_name, current_handle, bio, location, website, profile_image_url FROM social_external_accounts WHERE id = $1",
    [accountId],
  );
  if (!account.rowCount || !account.rows[0])
    throw new Error(`Social external account '${accountId}' not found`);
  const row = account.rows[0];
  const person = await executor.query<{ id: string }>(
    `
      INSERT INTO people (name, bio, location, website, avatar_url, confidence)
      VALUES ($1, $2, $3, $4, $5, 'confirmed')
      RETURNING id
    `,
    [
      row.display_name ?? row.current_handle ?? accountId,
      row.bio,
      row.location,
      row.website,
      row.profile_image_url,
    ],
  );
  const personRow = person.rows[0];
  if (!personRow) throw new Error("Person was not persisted");
  return personRow.id;
}

async function insertConfirmedAccountLink(
  executor: Executor,
  scopeId: string,
  personId: string,
  accountId: string,
  candidateId: string,
): Promise<void> {
  await executor.query(
    `
      INSERT INTO canonical_person_accounts (scope_id, person_id, external_account_id, status, source_candidate_id)
      VALUES ($1, $2, $3, 'CONFIRMED', $4)
      ON CONFLICT (scope_id, external_account_id) WHERE status = 'CONFIRMED'
      DO UPDATE SET person_id = EXCLUDED.person_id, source_candidate_id = EXCLUDED.source_candidate_id, updated_at = now()
    `,
    [scopeId, personId, accountId, candidateId],
  );
}

async function lockMembershipAccounts(
  executor: Executor,
  scopeId: string,
  accountIds: string[],
): Promise<void> {
  for (const accountId of uniqueSortedStrings(accountIds)) {
    await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `identity-membership:${scopeId}:${accountId}`,
    ]);
  }
}

async function lockMembershipScope(executor: Executor, scopeId: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `identity-membership-scope:${scopeId}`,
  ]);
}

async function loadConfirmedMemberships(
  executor: Executor,
  scopeId: string,
  accountIds: string[],
): Promise<Array<{ person_id: string; external_account_id: string }>> {
  if (accountIds.length === 0) return [];
  const result = await executor.query<{ person_id: string; external_account_id: string }>(
    `
      SELECT person_id, external_account_id
      FROM canonical_person_accounts
      WHERE scope_id = $1 AND external_account_id = ANY($2::uuid[]) AND status = 'CONFIRMED'
      ORDER BY external_account_id
      FOR UPDATE
    `,
    [scopeId, uniqueSortedStrings(accountIds)],
  );
  return result.rows;
}

async function loadConfirmedAccountsForPeople(
  executor: Executor,
  scopeId: string,
  personIds: string[],
): Promise<Array<{ person_id: string; external_account_id: string }>> {
  if (personIds.length === 0) return [];
  const result = await executor.query<{ person_id: string; external_account_id: string }>(
    `
      SELECT person_id, external_account_id
      FROM canonical_person_accounts
      WHERE scope_id = $1 AND person_id = ANY($2::uuid[]) AND status = 'CONFIRMED'
      ORDER BY external_account_id
      FOR UPDATE
    `,
    [scopeId, uniqueSortedStrings(personIds)],
  );
  return result.rows;
}

async function invalidateCurrentSocialDnaForPeople(
  executor: Executor,
  scopeId: string,
  personIds: string[],
): Promise<void> {
  const uniquePersonIds = uniqueSortedStrings(personIds);
  if (uniquePersonIds.length === 0) return;
  await executor.query(
    `
      UPDATE social_dna_profiles
      SET is_current = false, superseded_at = COALESCE(superseded_at, now())
      WHERE scope_id = $1 AND person_id = ANY($2::uuid[]) AND is_current = true
    `,
    [scopeId, uniquePersonIds],
  );
  await invalidateIntelligenceForPeople(executor, scopeId, uniquePersonIds);
}

async function assertCandidateAccountsSharePerson(
  executor: Executor,
  scopeId: string,
  accountIds: string[],
  candidateId: string,
): Promise<void> {
  const result = await executor.query<{ person_id: string }>(
    `
      SELECT DISTINCT person_id
      FROM canonical_person_accounts
      WHERE scope_id = $1 AND external_account_id = ANY($2::uuid[]) AND status = 'CONFIRMED'
    `,
    [scopeId, uniqueSortedStrings(accountIds)],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `Linked identity candidate '${candidateId}' did not converge to one canonical person`,
    );
  }
}

async function invalidateStaleLinkedCandidates(
  executor: Executor,
  input: {
    scopeId: string;
    affectedAccountIds: string[];
    sourceCandidateId: string;
    actorUserId: string | null;
  },
): Promise<void> {
  if (input.affectedAccountIds.length === 0) return;
  const stale = await executor.query<{ id: string }>(
    `
      SELECT c.id
      FROM identity_resolution_candidates c
      LEFT JOIN canonical_person_accounts left_membership
        ON left_membership.scope_id = c.scope_id
       AND left_membership.external_account_id = c.account_a_id
       AND left_membership.status = 'CONFIRMED'
      LEFT JOIN canonical_person_accounts right_membership
        ON right_membership.scope_id = c.scope_id
       AND right_membership.external_account_id = c.account_b_id
       AND right_membership.status = 'CONFIRMED'
      WHERE c.scope_id = $1
        AND c.status = 'LINKED'
        AND c.id <> $3
        AND (c.account_a_id = ANY($2::uuid[]) OR c.account_b_id = ANY($2::uuid[]))
        AND (
          left_membership.person_id IS NULL
          OR right_membership.person_id IS NULL
          OR left_membership.person_id <> right_membership.person_id
        )
      ORDER BY c.id
      FOR UPDATE OF c
    `,
    [input.scopeId, uniqueSortedStrings(input.affectedAccountIds), input.sourceCandidateId],
  );
  for (const row of stale.rows) {
    await updateCandidateStatus(executor, row.id, "PENDING", input.actorUserId);
    await recordDecision(
      executor,
      row.id,
      input.actorUserId,
      "INVALIDATE_LINK",
      "LINKED",
      "PENDING",
      `Invalidated by split candidate ${input.sourceCandidateId}`,
    );
  }
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function updateCandidateStatus(
  executor: Executor,
  candidateId: string,
  status: string,
  actorUserId: string | null,
): Promise<QueryResult> {
  return executor.query(
    "UPDATE identity_resolution_candidates SET status = $2, decided_by_user_id = $3, decided_at = now(), updated_at = now() WHERE id = $1",
    [candidateId, status, actorUserId],
  );
}

async function recordDecision(
  executor: Executor,
  candidateId: string,
  actorUserId: string | null,
  action: string,
  previousStatus: string,
  newStatus: string,
  reason?: string,
): Promise<void> {
  await executor.query(
    `
      INSERT INTO identity_resolution_decisions (
        candidate_id, actor_user_id, action, previous_status, new_status, reason
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [candidateId, actorUserId, action, previousStatus, newStatus, reason ?? null],
  );
}

async function loadSocialDnaInput(
  executor: Executor,
  input: RecomputeSocialDnaInput,
): Promise<Parameters<typeof generateSocialDna>[0]> {
  const policy = await loadActiveSocialDnaPolicy(executor, input.policyKey ?? "default");
  const accounts = await executor.query<{
    id: string;
    platform_id: string;
    external_id: string;
    current_handle: string | null;
    display_name: string | null;
    bio: string | null;
    location: string | null;
    website: string | null;
    last_observed_at: Date;
  }>(
    `
      SELECT sea.id, sea.platform_id, sea.external_id, sea.current_handle, sea.display_name,
             sea.bio, sea.location, sea.website, sea.last_observed_at
      FROM canonical_person_accounts cpa
      JOIN social_external_accounts sea ON sea.id = cpa.external_account_id
      WHERE cpa.scope_id = $1 AND cpa.person_id = $2 AND cpa.status = 'CONFIRMED'
      ORDER BY sea.platform_id, sea.external_id
    `,
    [input.scopeId, input.personId],
  );
  const accountIds = accounts.rows.map((row) => row.id);
  const content = accountIds.length
    ? await executor.query<{
        id: string;
        platform_id: string;
        external_id: string;
        author_external_account_id: string;
        body: string;
        content_type: string | null;
        language: string | null;
        observed_at: Date;
      }>(
        `
          SELECT sci.id, sci.platform_id, sci.external_id, sci.author_external_account_id,
                 sci.body, sci.content_type, sci.language, sco.observed_at
          FROM social_content_items sci
          JOIN social_content_observations sco ON sco.content_item_id = sci.id
          WHERE sco.scope_id = $1 AND sci.author_external_account_id = ANY($2::uuid[])
          ORDER BY sci.platform_id, sci.external_id
          LIMIT 1000
        `,
        [input.scopeId, accountIds],
      )
    : { rows: [] };
  const interactions = accountIds.length
    ? await executor.query<{
        id: string;
        platform_id: string;
        external_id: string;
        from_external_account_id: string;
        type: string;
        body: string | null;
        occurred_at: Date;
      }>(
        `
          SELECT id, platform_id, external_id, from_external_account_id, type, body, occurred_at
          FROM social_interactions
          WHERE scope_id = $1 AND from_external_account_id = ANY($2::uuid[])
          ORDER BY platform_id, external_id
          LIMIT 1000
        `,
        [input.scopeId, accountIds],
      )
    : { rows: [] };
  const dnaInput: Parameters<typeof generateSocialDna>[0] = {
    personId: input.personId,
    algorithmVersion: input.algorithmVersion,
    policy,
    profiles: accounts.rows.map((profile) => ({
      externalAccountId: profile.id,
      platformId: profile.platform_id,
      providerObjectId: profile.external_id,
      bio: profile.bio ?? undefined,
      displayName: profile.display_name ?? profile.current_handle ?? undefined,
      location: profile.location ?? undefined,
      website: profile.website ?? undefined,
      observedAt: profile.last_observed_at.toISOString(),
    })),
    content: content.rows.map((row) => ({
      id: row.id,
      externalAccountId: row.author_external_account_id,
      platformId: row.platform_id,
      providerObjectId: row.external_id,
      body: row.body,
      contentType: row.content_type ?? undefined,
      language: row.language,
      observedAt: row.observed_at.toISOString(),
    })),
    interactions: interactions.rows.map((row) => ({
      id: row.id,
      externalAccountId: row.from_external_account_id,
      platformId: row.platform_id,
      providerObjectId: row.external_id,
      type: row.type,
      body: row.body,
      observedAt: row.occurred_at.toISOString(),
    })),
  };
  return dnaInput;
}
