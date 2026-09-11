import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
const DATABASE_URL = process.env.DATABASE_URL;
process.env.ENCRYPTION_MASTER_KEY ??= "integration-test-master-key-32b!";

async function createTestScope(executor) {
  const userRes = await executor.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', 'Test User', 'ACTIVE') RETURNING id",
    [`user-bounded-${Date.now()}-${Math.random()}@example.com`],
  );
  const userId = userRes.rows[0].id;
  const scopeRes = await executor.query(
    "INSERT INTO data_scopes (scope_type, user_id) VALUES ('PERSONAL', $1) RETURNING id",
    [userId],
  );
  return scopeRes.rows[0].id;
}

async function createTestAccount(executor, platformId, handle = "u/testuser") {
  const acctId = randomUUID();
  await executor.query(
    `INSERT INTO social_external_accounts (id, platform_id, external_id, current_handle, display_name)
     VALUES ($1, $2, $3, $4, 'Test User')`,
    [acctId, platformId, `user-${randomUUID()}`, handle],
  );
  return acctId;
}

import {
  createProviderDataDeletionRequest,
  executeProviderDataDeletion,
} from "../dist/index.js";

// ─── Defect 1 + 8: Bounded deletion ─────────────────────────────────────────

test("Bounded deletion: first invocation leaves records remaining, durable continuation completes", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeId = await createTestScope(pool);
    const platformId = randomUUID();
    const connectionId = randomUUID();
    const slug = `reddit-bounded-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit Bounded', true, 'reddit')`,
      [platformId, slug],
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`,
      [connectionId, scopeId, platformId],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_bounded_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    const acctId = await createTestAccount(pool, platformId);

    // Create 5 content items, each with 1 observation via the target connection
    const itemIds = [];
    for (let i = 0; i < 5; i++) {
      const itemId = randomUUID();
      itemIds.push(itemId);
      await pool.query(
        `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'body', 'PUBLIC')`,
        [itemId, platformId, acctId, `bounded-post-${i}-${Date.now()}`],
      );
      await pool.query(
        `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
        [connectionId, itemId, scopeId],
      );
    }

    // Create deletion request
    const creationResult = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId,
      connectionId,
      reason: "bounded deletion test",
      source: "TEST",
    });
    assert.ok(creationResult.deletionRequestId);

    // Execute with batchSize 1 and max 2 batches → should only process 2 observations
    let result = await executeProviderDataDeletion(creationResult.deletionRequestId, {
      batchSize: 1,
      maxBatchesPerInvocation: 2,
    });

    assert.equal(result.status, "IN_PROGRESS", "First invocation must return IN_PROGRESS");
    assert.ok(
      result.contentObservationsPurged <= 2,
      `Should purge at most 2, got ${result.contentObservationsPurged}`,
    );

    // Verify remaining observations exist
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`,
      [connectionId],
    );
    assert.ok(remaining.rows[0].cnt > 0, "Target records must remain after first bounded invocation");

    // Verify checkpoint in metadata and bounded relational workset
    const reqMeta = await pool.query(
      `SELECT metadata FROM provider_data_deletion_requests WHERE id = $1`,
      [creationResult.deletionRequestId],
    );
    assert.ok(reqMeta.rows[0]?.metadata?.deletionProgress, "Checkpoint must exist in metadata");
    assert.equal(
      reqMeta.rows[0]?.metadata?.deletionProgress?.targetContentItemIds,
      undefined,
      "Target IDs must not be stored as unbounded JSON arrays",
    );
    const targetRows = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM provider_data_deletion_targets WHERE deletion_request_id = $1 AND entity_type = 'CONTENT_ITEM'`,
      [creationResult.deletionRequestId],
    );
    assert.ok(targetRows.rows[0].cnt > 0, "Deleted observation targets must be captured in relational workset");

    // Continue until COMPLETED
    let iterations = 0;
    while (result.status === "IN_PROGRESS" && iterations < 20) {
      result = await executeProviderDataDeletion(creationResult.deletionRequestId, {
        batchSize: 1,
        maxBatchesPerInvocation: 2,
      });
      iterations++;
    }

    assert.equal(result.status, "COMPLETED", "Must eventually complete");

    // Verify all observations purged
    const finalCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`,
      [connectionId],
    );
    assert.equal(finalCount.rows[0].cnt, 0, "All target observations must be purged after completion");
  } finally {
    await pool.end();
  }
});

// ─── Defect 2: Deletion scope isolation ──────────────────────────────────────

test("Deletion scope isolation: scoped deletion does not affect unrelated data", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeA = await createTestScope(pool);
    const scopeB = await createTestScope(pool);
    const redditPlatformId = randomUUID();
    const twitterPlatformId = randomUUID();
    const connA = randomUUID();
    const connB = randomUUID();
    const connOther = randomUUID();
    const slugR = `reddit-iso-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const slugT = `twitter-iso-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Platforms
    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit', true, 'reddit')`,
      [redditPlatformId, slugR],
    );
    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Twitter', true, 'x')`,
      [twitterPlatformId, slugT],
    );

    // Connections: A (reddit, scope A), B (reddit, scope B), Other (twitter, scope B)
    await pool.query(`INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`, [connA, scopeA, redditPlatformId]);
    await pool.query(`INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`, [connB, scopeB, redditPlatformId]);
    await pool.query(`INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`, [connOther, scopeB, twitterPlatformId]);

    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_iso_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    const redditAcctA = await createTestAccount(pool, redditPlatformId);
    const redditAcctB = await createTestAccount(pool, redditPlatformId);
    const twitterAcct = await createTestAccount(pool, twitterPlatformId);

    // Target reddit scope A: 3 items + observations
    const targetItemIds = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      targetItemIds.push(id);
      await pool.query(`INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'body', 'PUBLIC')`, [id, redditPlatformId, redditAcctA, `target-${i}-${Date.now()}`]);
      await pool.query(`INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`, [connA, id, scopeA]);
    }

    // Unrelated reddit scope B: 2 items + observations
    const unrelatedItemIds = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      unrelatedItemIds.push(id);
      await pool.query(`INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'body', 'PUBLIC')`, [id, redditPlatformId, redditAcctB, `unrelated-${i}-${Date.now()}`]);
      await pool.query(`INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`, [connB, id, scopeB]);
    }

    // Orphan reddit canonical item (no observations, scope NULL)
    const orphanItemId = randomUUID();
    await pool.query(`INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'orphan', 'PUBLIC')`, [orphanItemId, redditPlatformId, redditAcctA, `orphan-${Date.now()}`]);

    // Orphan reddit account in scope B (no observations)
    const orphanAccountId = randomUUID();
    await pool.query(`INSERT INTO social_external_accounts (id, platform_id, external_id, current_handle) VALUES ($1, $2, $3, 'u/orphan_user')`, [orphanAccountId, redditPlatformId, `orphan_acct_${Date.now()}`]);

    // Shared canonical item with independent provenance (observed by BOTH A and Other provider)
    const sharedItemId = randomUUID();
    await pool.query(`INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'shared', 'PUBLIC')`, [sharedItemId, redditPlatformId, redditAcctA, `shared-${Date.now()}`]);
    await pool.query(`INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`, [connA, sharedItemId, scopeA]);
    await pool.query(`INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`, [connOther, sharedItemId, scopeB]);

    // Execute deletion scoped to connection A
    const creation = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      connectionId: connA,
      reason: "scope isolation test",
      source: "TEST",
    });

    let result = await executeProviderDataDeletion(creation.deletionRequestId, { batchSize: 10, maxBatchesPerInvocation: 50 });
    while (result.status === "IN_PROGRESS") {
      result = await executeProviderDataDeletion(creation.deletionRequestId, { batchSize: 10, maxBatchesPerInvocation: 50 });
    }
    assert.equal(result.status, "COMPLETED");

    // Scope A observations purged
    const obsA = await pool.query(`SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`, [connA]);
    assert.equal(obsA.rows[0].cnt, 0, "Target observations must be purged");

    // Scope B observations survive
    const obsB = await pool.query(`SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`, [connB]);
    assert.equal(obsB.rows[0].cnt, 2, "Unrelated Reddit scope B observations must survive");

    // Scope B items survive
    for (const id of unrelatedItemIds) {
      const r = await pool.query(`SELECT id FROM social_content_items WHERE id = $1`, [id]);
      assert.equal(r.rows.length, 1, `Unrelated item ${id} must survive`);
    }

    // Shared item survives (has independent Other-provider observation)
    const sharedCheck = await pool.query(`SELECT id FROM social_content_items WHERE id = $1`, [sharedItemId]);
    assert.equal(sharedCheck.rows.length, 1, "Shared canonical item must survive due to independent provenance");

    // Orphan account NOT sanitized (belongs to scope B)
    const orphanAcctCheck = await pool.query(`SELECT current_handle FROM social_external_accounts WHERE id = $1`, [orphanAccountId]);
    assert.equal(orphanAcctCheck.rows[0]?.current_handle, "u/orphan_user", "Orphan account in unrelated scope must NOT be sanitized");
  } finally {
    await pool.end();
  }
});

// ─── Defect 3: providerAuthorizationId validation ────────────────────────────

test("providerAuthorizationId: validates provider family and blocks unscoped global deletion", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeId = await createTestScope(pool);
    const platformId = randomUUID();
    const authId = randomUUID();
    const slug = `reddit-auth-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit Auth', true, 'reddit')`,
      [platformId, slug],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_auth_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    // Create provider authorization
    await pool.query(
      `INSERT INTO provider_authorizations (id, provider_family, scope_id, platform_id, provider_user_id, status, granted_scopes)
       VALUES ($1, 'reddit', $2, $3, 'test_user', 'ACTIVE', '[]'::jsonb)`,
      [authId, scopeId, platformId],
    );

    // Valid: matching family + auth → succeeds
    const validResult = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId,
      providerAuthorizationId: authId,
      reason: "auth test valid",
      source: "TEST",
    });
    assert.ok(validResult.deletionRequestId, "Valid request accepted");

    // Missing all scope identifiers without privileged flag → must fail
    await assert.rejects(
      () =>
        createProviderDataDeletionRequest({
          providerFamily: "reddit",
          reason: "should fail",
          source: "TEST",
        }),
      /Missing scope identifiers/,
      "Global deletion without explicit privilege must be rejected",
    );

    // Privileged global deletion → succeeds
    const privilegedResult = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      reason: "privileged global",
      source: "TEST",
      metadata: { privilegedProviderDeletion: true },
    });
    assert.ok(privilegedResult.deletionRequestId, "Privileged global deletion accepted");
  } finally {
    await pool.end();
  }
});

test("providerAuthorizationId: authorization-only deletion fails closed without authoritative connection mapping", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeId = await createTestScope(pool);
    const platformId = randomUUID();
    const connA = randomUUID();
    const connB = randomUUID();
    const authA = randomUUID();
    const authB = randomUUID();
    const slug = `reddit-auth-closed-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit Auth Closed', true, 'reddit')`,
      [platformId, slug],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_auth_closed_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );
    await pool.query(
      `INSERT INTO provider_authorizations (id, provider_family, scope_id, platform_id, provider_user_id, status, granted_scopes)
       VALUES ($1, 'reddit', $2, $3, 'auth_user_a', 'ACTIVE', '[]'::jsonb),
              ($4, 'reddit', $2, $3, 'auth_user_b', 'ACTIVE', '[]'::jsonb)`,
      [authA, scopeId, platformId, authB],
    );

    const acctA = await createTestAccount(pool, platformId, "u/auth_a");
    const acctB = await createTestAccount(pool, platformId, "u/auth_b");
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, external_account_id, status, credentials_encrypted)
       VALUES ($1, $2, $3, $4, 'CONNECTED', 'enc:v2:a'),
              ($5, $2, $3, $6, 'CONNECTED', 'enc:v2:b')`,
      [connA, scopeId, platformId, acctA, connB, acctB],
    );

    for (const [conn, acct, label] of [
      [connA, acctA, "a"],
      [connB, acctB, "b"],
    ]) {
      const itemId = randomUUID();
      await pool.query(
        `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility)
         VALUES ($1, $2, $3, $4, 'body', 'PUBLIC')`,
        [itemId, platformId, acct, `auth-${label}-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version)
         VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
        [conn, itemId, scopeId],
      );
    }

    const creation = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId,
      providerAuthorizationId: authA,
      reason: "auth fail closed test",
      source: "TEST",
    });

    await assert.rejects(
      () => executeProviderDataDeletion(creation.deletionRequestId),
      /not mapped to deletable social connection provenance/,
    );

    const remaining = await pool.query(
      `SELECT connection_id, COUNT(*)::int AS cnt
       FROM social_content_observations
       WHERE connection_id = ANY($1::uuid[])
       GROUP BY connection_id`,
      [[connA, connB]],
    );
    const counts = new Map(remaining.rows.map((row) => [row.connection_id, row.cnt]));
    assert.equal(counts.get(connA), 1, "Authorization A data must not be deleted without mapping");
    assert.equal(counts.get(connB), 1, "Authorization B data must remain untouched");
  } finally {
    await pool.end();
  }
});

test("connection validation: rejects provider family mismatch before destructive work", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeId = await createTestScope(pool);
    const redditPlatformId = randomUUID();
    const xPlatformId = randomUUID();
    const xConnectionId = randomUUID();

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family)
       VALUES ($1, $2, 'Reddit Validation', true, 'reddit'),
              ($3, $4, 'X Validation', true, 'x')`,
      [
        redditPlatformId,
        `reddit-validation-${randomUUID()}`,
        xPlatformId,
        `x-validation-${randomUUID()}`,
      ],
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted)
       VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:x')`,
      [xConnectionId, scopeId, xPlatformId],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_validation_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    const creation = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId,
      connectionId: xConnectionId,
      reason: "connection mismatch test",
      source: "TEST",
    });

    await assert.rejects(
      () => executeProviderDataDeletion(creation.deletionRequestId),
      /Provider family mismatch for connection/,
    );
  } finally {
    await pool.end();
  }
});

test("connection validation: rejects scope mismatch before destructive work", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeA = await createTestScope(pool);
    const scopeB = await createTestScope(pool);
    const platformId = randomUUID();
    const connectionId = randomUUID();

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family)
       VALUES ($1, $2, 'Reddit Scope Validation', true, 'reddit')`,
      [platformId, `reddit-scope-validation-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted)
       VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:reddit')`,
      [connectionId, scopeB, platformId],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_scope_validation_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    const creation = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId: scopeA,
      connectionId,
      reason: "connection scope mismatch test",
      source: "TEST",
    });

    await assert.rejects(
      () => executeProviderDataDeletion(creation.deletionRequestId),
      /Scope mismatch for connection/,
    );
  } finally {
    await pool.end();
  }
});

// ─── Defect 8: Data-deletion worker end-to-end ──────────────────────────────

test("Data-deletion worker: processProviderDataDeletion creates durable continuations until completion", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const scopeId = await createTestScope(pool);
    const platformId = randomUUID();
    const connectionId = randomUUID();
    const slug = `reddit-e2e-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit E2E', true, 'reddit')`,
      [platformId, slug],
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`,
      [connectionId, scopeId, platformId],
    );
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_e2e_test', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    const acctId = await createTestAccount(pool, platformId);

    // Exceeds the worker's default batch size of 100, so the first real processor invocation cannot complete.
    for (let i = 0; i < 125; i++) {
      const itemId = randomUUID();
      await pool.query(
        `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility) VALUES ($1, $2, $3, $4, 'e2e body', 'PUBLIC')`,
        [itemId, platformId, acctId, `e2e-post-${i}-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version) VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
        [connectionId, itemId, scopeId],
      );
    }

    // Create deletion request (creates job + outbox)
    const creation = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      scopeId,
      connectionId,
      reason: "e2e worker test",
      source: "TEST",
    });
    assert.ok(creation.deletionRequestId);
    assert.ok(creation.jobId);

    // Verify job exists in PENDING_DISPATCH
    const jobCheck = await pool.query(
      `SELECT id, status FROM jobs WHERE payload->>'deletionRequestId' = $1`,
      [creation.deletionRequestId],
    );
    assert.equal(jobCheck.rows.length, 1);
    assert.equal(jobCheck.rows[0].status, "PENDING_DISPATCH");
    await pool.query(
      `UPDATE job_outbox SET status = 'DISPATCHED', bullmq_job_id = $2, dispatched_at = now() WHERE job_id = $1`,
      [creation.jobId, `provider-data-deletion-${creation.jobId}`],
    );
    await pool.query(
      `UPDATE jobs SET status = 'QUEUED', bullmq_job_id = $2 WHERE id = $1`,
      [creation.jobId, `provider-data-deletion-${creation.jobId}`],
    );

    // Import and call the real worker processor
    const { processProviderDataDeletion } = await import("../../../apps/worker/dist/provider-data-deletion-processor.js");
    const { JOB_TYPES } = await import("@xlrrank/queue");

    const mockJob = {
      name: JOB_TYPES.providerDataDeletion,
      data: {
        version: 1,
        jobRequestId: creation.jobId,
        deletionRequestId: creation.deletionRequestId,
      },
      queueName: "ingestion",
    };

    await processProviderDataDeletion(mockJob);

    const reqAfterFirst = await pool.query(
      `SELECT status, completion_evidence, metadata FROM provider_data_deletion_requests WHERE id = $1`,
      [creation.deletionRequestId],
    );
    assert.equal(reqAfterFirst.rows[0].status, "RUNNING");
    assert.equal(reqAfterFirst.rows[0].completion_evidence, null);
    assert.equal(reqAfterFirst.rows[0].metadata.deletionProgress.phase, "CONTENT_OBSERVATIONS");

    const obsAfterFirst = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`,
      [connectionId],
    );
    assert.equal(obsAfterFirst.rows[0].cnt, 25, "First worker invocation must not delete everything");

    const continuationAfterFirst = await pool.query(
      `
        SELECT id, status, payload, idempotency_key
        FROM jobs
        WHERE payload->>'deletionRequestId' = $1
          AND id <> $2
        ORDER BY created_at ASC
      `,
      [creation.deletionRequestId, creation.jobId],
    );
    assert.equal(continuationAfterFirst.rows.length, 1, "Exactly one active continuation must exist");
    assert.notEqual(continuationAfterFirst.rows[0].id, creation.jobId);
    assert.equal(
      continuationAfterFirst.rows[0].idempotency_key,
      `provider-deletion-continuation:${creation.deletionRequestId}`,
    );

    const originalOutboxRows = await pool.query(
      `SELECT status FROM job_outbox WHERE job_id = $1`,
      [creation.jobId],
    );
    assert.equal(originalOutboxRows.rows[0].status, "DISPATCHED", "Original outbox row remains dispatch history");

    await processProviderDataDeletion(mockJob);
    const continuationAfterRetry = await pool.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM jobs
        WHERE payload->>'deletionRequestId' = $1
          AND idempotency_key = $2
          AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
      `,
      [creation.deletionRequestId, `provider-deletion-continuation:${creation.deletionRequestId}`],
    );
    assert.equal(continuationAfterRetry.rows[0].cnt, 1, "Retrying completed transport job must not duplicate continuation");

    let nextJob = continuationAfterFirst.rows[0];
    let iterations = 0;
    while (iterations < 20) {
      await pool.query(
        `UPDATE job_outbox SET status = 'DISPATCHED', bullmq_job_id = $2, dispatched_at = now() WHERE job_id = $1`,
        [nextJob.id, `provider-data-deletion-${nextJob.id}`],
      );
      await pool.query(`UPDATE jobs SET status = 'QUEUED', bullmq_job_id = $2 WHERE id = $1`, [
        nextJob.id,
        `provider-data-deletion-${nextJob.id}`,
      ]);

      await processProviderDataDeletion({
        name: JOB_TYPES.providerDataDeletion,
        data: nextJob.payload,
        queueName: "ingestion",
      });

      const reqState = await pool.query(
        `SELECT status FROM provider_data_deletion_requests WHERE id = $1`,
        [creation.deletionRequestId],
      );
      if (reqState.rows[0].status === "COMPLETED") break;

      const activeContinuations = await pool.query(
        `
          SELECT id, status, payload
          FROM jobs
          WHERE payload->>'deletionRequestId' = $1
            AND idempotency_key = $2
            AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
          ORDER BY created_at ASC
        `,
        [creation.deletionRequestId, `provider-deletion-continuation:${creation.deletionRequestId}`],
      );
      assert.equal(activeContinuations.rows.length, 1, "Only one active continuation may exist");
      nextJob = activeContinuations.rows[0];
      iterations++;
    }

    const reqFinal = await pool.query(
      `SELECT status, completion_evidence FROM provider_data_deletion_requests WHERE id = $1`,
      [creation.deletionRequestId],
    );
    assert.equal(reqFinal.rows[0].status, "COMPLETED");
    assert.ok(reqFinal.rows[0].completion_evidence, "Completion evidence must exist");

    const obsFinal = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM social_content_observations WHERE connection_id = $1`,
      [connectionId],
    );
    assert.equal(obsFinal.rows[0].cnt, 0, "Observations purged through worker path");

    const targetCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM provider_data_deletion_targets WHERE deletion_request_id = $1 AND entity_type = 'CONTENT_ITEM'`,
      [creation.deletionRequestId],
    );
    assert.equal(targetCount.rows[0].cnt, 125, "All deleted content targets must be captured relationally");

    const nonTerminalJobs = await pool.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM jobs
        WHERE payload->>'deletionRequestId' = $1
          AND status IN ('PENDING_DISPATCH', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED')
      `,
      [creation.deletionRequestId],
    );
    assert.equal(nonTerminalJobs.rows[0].cnt, 0, "All deletion transport jobs must reach terminal states");
  } finally {
    await pool.end();
  }
});
