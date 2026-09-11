import type { Pool, PoolClient, QueryResult } from "pg";
import {
  generateSocialDna,
  matchIdentity,
  orderedPair,
  shouldAutoMerge,
  validateIdentityResolutionPolicy,
  type IdentityAccountInput,
  type IdentityResolutionPolicy,
  type SocialDnaProfile,
} from "@xlrrank/intelligence";
import { getPool } from "../client.js";

type Executor = Pick<Pool | PoolClient, "query">;

export interface PersistIdentityResolutionPolicyInput {
  policy: IdentityResolutionPolicy;
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
}

export async function persistIdentityResolutionPolicy(
  input: PersistIdentityResolutionPolicyInput,
  executor: Executor = getPool(),
): Promise<string> {
  const policy = validateIdentityResolutionPolicy(input.policy);
  const result = await executor.query<{ id: string }>(
    `
      INSERT INTO identity_resolution_policies (policy_key, version, config, active)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (policy_key, version)
      DO UPDATE SET config = EXCLUDED.config, active = EXCLUDED.active, updated_at = now()
      RETURNING id
    `,
    [policy.policyKey, policy.version, policy, input.active ?? true],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Identity resolution policy was not persisted");
  return row.id;
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
    await recordDecision(client, input.candidateId, input.actorUserId ?? null, "REJECT", candidate.status, "REJECTED", input.reason);
  });
}

export async function linkIdentityCandidate(input: ManualIdentityDecisionInput): Promise<string> {
  return withDecisionTransaction(input.candidateId, async (client, candidate) => {
    const personId = await linkCandidateAccounts(client, input.candidateId);
    await updateCandidateStatus(client, input.candidateId, "LINKED", input.actorUserId ?? null);
    await recordDecision(client, input.candidateId, input.actorUserId ?? null, "LINK", candidate.status, "LINKED", input.reason);
    return personId;
  });
}

export async function splitIdentityCandidate(input: ManualIdentityDecisionInput): Promise<void> {
  await withDecisionTransaction(input.candidateId, async (client, candidate) => {
    const accounts = await candidateAccounts(client, input.candidateId);
    await client.query(
      `
        UPDATE canonical_person_accounts
        SET status = 'SPLIT', split_at = now(), updated_at = now()
        WHERE scope_id = $1 AND external_account_id IN ($2, $3) AND status = 'CONFIRMED'
      `,
      [accounts.scopeId, accounts.accountAId, accounts.accountBId],
    );
    for (const accountId of [accounts.accountAId, accounts.accountBId]) {
      const personId = await createPersonFromAccount(client, accountId);
      await insertConfirmedAccountLink(client, accounts.scopeId, personId, accountId, input.candidateId);
    }
    await updateCandidateStatus(client, input.candidateId, "SPLIT", input.actorUserId ?? null);
    await recordDecision(client, input.candidateId, input.actorUserId ?? null, "SPLIT", candidate.status, "SPLIT", input.reason);
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
      return { profileId: existing.rows[0].id, version: existing.rows[0].version, createdNewVersion: false, profile };
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
        JSON.stringify(profile.dimensions),
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
    return { profileId: insertedRow.id, version: insertedRow.version, createdNewVersion: true, profile };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadActivePolicy(executor: Executor, policyKey: string): Promise<IdentityResolutionPolicy> {
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
  if (!result.rowCount || !result.rows[0]) throw new Error(`Identity resolution policy '${policyKey}' is not configured`);
  return validateIdentityResolutionPolicy(result.rows[0].config);
}

async function loadAccountForIdentity(executor: Executor, scopeId: string, accountId: string): Promise<IdentityAccountInput> {
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
  if (!result.rowCount || !result.rows[0]) throw new Error(`Social external account '${accountId}' is not available in scope`);
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
    topics: Array.isArray(metadata.topics) ? metadata.topics.filter((item): item is string => typeof item === "string") : [],
  };
}

async function withDecisionTransaction<T>(
  candidateId: string,
  fn: (client: PoolClient, candidate: { status: string }) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`identity-decision:${candidateId}`]);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM identity_resolution_candidates WHERE id = $1 FOR UPDATE",
      [candidateId],
    );
    if (!candidate.rowCount || !candidate.rows[0]) throw new Error(`Identity candidate '${candidateId}' not found`);
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
  const existingPerson = await executor.query<{ person_id: string }>(
    `
      SELECT person_id
      FROM canonical_person_accounts
      WHERE scope_id = $1 AND external_account_id IN ($2, $3) AND status = 'CONFIRMED'
      ORDER BY linked_at ASC
      LIMIT 1
    `,
    [accounts.scopeId, accounts.accountAId, accounts.accountBId],
  );
  const personId = existingPerson.rows[0]?.person_id ?? (await createPersonFromAccount(executor, accounts.accountAId));
  await insertConfirmedAccountLink(executor, accounts.scopeId, personId, accounts.accountAId, candidateId);
  await insertConfirmedAccountLink(executor, accounts.scopeId, personId, accounts.accountBId, candidateId);
  return personId;
}

async function candidateAccounts(executor: Executor, candidateId: string): Promise<{
  scopeId: string;
  accountAId: string;
  accountBId: string;
}> {
  const result = await executor.query<{ scope_id: string; account_a_id: string; account_b_id: string }>(
    "SELECT scope_id, account_a_id, account_b_id FROM identity_resolution_candidates WHERE id = $1",
    [candidateId],
  );
  if (!result.rowCount || !result.rows[0]) throw new Error(`Identity candidate '${candidateId}' not found`);
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
  if (!account.rowCount || !account.rows[0]) throw new Error(`Social external account '${accountId}' not found`);
  const row = account.rows[0];
  const person = await executor.query<{ id: string }>(
    `
      INSERT INTO people (name, bio, location, website, avatar_url, confidence)
      VALUES ($1, $2, $3, $4, $5, 'confirmed')
      RETURNING id
    `,
    [row.display_name ?? row.current_handle ?? accountId, row.bio, row.location, row.website, row.profile_image_url],
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
      ON CONFLICT (scope_id, external_account_id, status)
      DO UPDATE SET person_id = EXCLUDED.person_id, source_candidate_id = EXCLUDED.source_candidate_id, updated_at = now()
    `,
    [scopeId, personId, accountId, candidateId],
  );
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
  const profile = accounts.rows[0];
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
        `,
        [input.scopeId, accountIds],
      )
    : { rows: [] };
  const dnaInput: Parameters<typeof generateSocialDna>[0] = {
    personId: input.personId,
    algorithmVersion: input.algorithmVersion,
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
  if (profile) {
    dnaInput.profile = {
      externalAccountId: profile.id,
      platformId: profile.platform_id,
      providerObjectId: profile.external_id,
      bio: profile.bio ?? undefined,
      displayName: profile.display_name ?? profile.current_handle ?? undefined,
      location: profile.location ?? undefined,
      website: profile.website ?? undefined,
      observedAt: profile.last_observed_at.toISOString(),
    };
  }
  return dnaInput;
}
