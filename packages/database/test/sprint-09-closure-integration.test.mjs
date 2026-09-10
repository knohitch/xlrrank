import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  encryptSecret,
  decryptSecret,
  providerAuthorizationCleanupAssociatedData,
} from "@xlrrank/shared";
import {
  createProviderAuthorizationCleanupRequestTx,
  markAuthorizationCleanupCompleted,
  markAuthorizationCleanupTerminal,
  createProviderDataDeletionRequest,
  executeProviderDataDeletion,
} from "../dist/index.js";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
const DATABASE_URL = process.env.DATABASE_URL;

process.env.ENCRYPTION_MASTER_KEY ??= "integration-test-master-key-32b!";

async function createTestScope(executor) {
  const userRes = await executor.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', 'Test User', 'ACTIVE') RETURNING id",
    [`user-${Date.now()}-${Math.random()}@example.com`],
  );
  const userId = userRes.rows[0].id;
  const scopeRes = await executor.query(
    "INSERT INTO data_scopes (scope_type, user_id) VALUES ('PERSONAL', $1) RETURNING id",
    [userId],
  );
  return scopeRes.rows[0].id;
}

test("Integration: PostgreSQL Durable Authorization Cleanup lifecycle and secret wipe", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const platformId = randomUUID();
    const connectionId = randomUUID();
    const cleanupId = randomUUID();
    const platformSlug = `reddit-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await client.query("BEGIN");
    const scopeId = await createTestScope(client);

    await client.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit Test', true, 'reddit')`,
      [platformId, platformSlug],
    );
    await client.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status) VALUES ($1, $2, $3, 'DISCONNECTED')`,
      [connectionId, scopeId, platformId],
    );

    const plaintext = JSON.stringify({ accessToken: "secret-access-token-123", refreshToken: "ref-456" });
    const encrypted = encryptSecret(
      plaintext,
      undefined,
      providerAuthorizationCleanupAssociatedData({
        cleanupId,
        scopeId,
        platformSlug,
      }),
    );

    // 1. Create cleanup request with explicit canonical cleanupId matching encryption AAD
    const cleanupResult = await createProviderAuthorizationCleanupRequestTx(client, {
      id: cleanupId,
      connectionId,
      scopeId,
      platformId,
      providerFamily: "reddit",
      credentialsEncrypted: encrypted,
      metadata: { platformSlug, connectionId },
    });

    await client.query("COMMIT");

    assert.equal(cleanupResult.cleanupId, cleanupId);
    assert.ok(cleanupResult.jobId);

    // 2. Verify worker query selects pac.connection_id and matches cleanupId
    const workerQueryRes = await pool.query(
      `
        SELECT pac.id, pac.status, pac.scope_id, pac.platform_id,
               pac.connection_id, pac.credentials_encrypted, pac.attempt_count,
               p.slug AS platform_slug
        FROM provider_authorization_cleanups pac
        JOIN platforms p ON p.id = pac.platform_id
        WHERE pac.id = $1
        LIMIT 1
      `,
      [cleanupId],
    );

    const cleanup = workerQueryRes.rows[0];
    assert.ok(cleanup, "Cleanup record should be found by worker query");
    assert.equal(cleanup.id, cleanupId);
    assert.equal(cleanup.connection_id, connectionId);
    assert.equal(cleanup.platform_slug, platformSlug);
    assert.ok(cleanup.credentials_encrypted);

    // 3. Worker decrypts using cleanup.id as AAD cleanupId
    const decrypted = decryptSecret(
      cleanup.credentials_encrypted,
      undefined,
      providerAuthorizationCleanupAssociatedData({
        cleanupId: cleanup.id,
        scopeId: cleanup.scope_id,
        platformSlug: cleanup.platform_slug,
      }),
    );
    assert.equal(decrypted, plaintext, "Worker must successfully decrypt using matched AAD");

    // 4. Mark completed: credentials_encrypted must be wiped to NULL
    await markAuthorizationCleanupCompleted(cleanup.id, cleanupResult.jobId, pool);

    const afterCompletedRes = await pool.query(
      "SELECT status, credentials_encrypted FROM provider_authorization_cleanups WHERE id = $1",
      [cleanupId],
    );
    assert.equal(afterCompletedRes.rows[0]?.status, "COMPLETED");
    assert.equal(afterCompletedRes.rows[0]?.credentials_encrypted, null, "Credentials must be wiped to NULL on completion");

    // 5. Test retryable failure & terminal DLQ wipe
    const retryCleanupId = randomUUID();
    const retryEncrypted = encryptSecret(
      plaintext,
      undefined,
      providerAuthorizationCleanupAssociatedData({
        cleanupId: retryCleanupId,
        scopeId,
        platformSlug,
      }),
    );

    const retryJob = await createProviderAuthorizationCleanupRequestTx(pool, {
      id: retryCleanupId,
      connectionId,
      scopeId,
      platformId,
      providerFamily: "reddit",
      credentialsEncrypted: retryEncrypted,
    });

    // Simulate retryable failure (attempt 1)
    await pool.query(
      `
        UPDATE provider_authorization_cleanups
        SET attempt_count = attempt_count + 1,
            last_error = $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [retryCleanupId, JSON.stringify({ message: "ETIMEDOUT" })],
    );

    const retryState = await pool.query(
      "SELECT attempt_count, credentials_encrypted FROM provider_authorization_cleanups WHERE id = $1",
      [retryCleanupId],
    );
    assert.equal(retryState.rows[0]?.attempt_count, 1);
    assert.ok(retryState.rows[0]?.credentials_encrypted, "Credentials retained during retry");

    // Simulate terminal failure: credentials wiped to NULL
    await markAuthorizationCleanupTerminal(retryCleanupId, retryJob.jobId, new Error("Permanent 400 invalid_grant"), pool);
    const deadLetteredState = await pool.query(
      "SELECT status, credentials_encrypted FROM provider_authorization_cleanups WHERE id = $1",
      [retryCleanupId],
    );
    assert.equal(deadLetteredState.rows[0]?.status, "DEAD_LETTERED");
    assert.equal(deadLetteredState.rows[0]?.credentials_encrypted, null, "Credentials wiped to NULL on terminal failure");
  } finally {
    client.release();
    await pool.end();
  }
});

test("Integration: PostgreSQL connection-scoped bounded data deletion without scopeId", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const scopeId = await createTestScope(pool);
    const xScopeId = await createTestScope(pool);
    const redditPlatformId = randomUUID();
    const xPlatformId = randomUUID();
    const redditConnId = randomUUID();
    const xConnId = randomUUID();
    const redditSlug = `reddit-del-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const xSlug = `x-del-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Setup platforms
    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'Reddit Del Test', true, 'reddit')`,
      [redditPlatformId, redditSlug],
    );
    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family) VALUES ($1, $2, 'X Del Test', true, 'x')`,
      [xPlatformId, xSlug],
    );

    // Setup connections
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`,
      [redditConnId, scopeId, redditPlatformId],
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted) VALUES ($1, $2, $3, 'CONNECTED', 'enc:v2:mock-creds')`,
      [xConnId, xScopeId, xPlatformId],
    );

    // Setup Reddit external account and handle
    const redditAcctId = randomUUID();
    const redditUserExtId = `reddit_user_${Date.now()}`;
    await pool.query(
      `INSERT INTO social_external_accounts (id, platform_id, external_id, current_handle, display_name)
       VALUES ($1, $2, $3, 'u/reddituser1', 'Reddit User One')`,
      [redditAcctId, redditPlatformId, redditUserExtId],
    );
    await pool.query(
      `INSERT INTO social_account_handles (external_account_id, handle) VALUES ($1, 'u/reddituser1')`,
      [redditAcctId],
    );
    await pool.query(
      `INSERT INTO social_account_observations (connection_id, external_account_id, scope_id, normalization_version, adapter_version)
       VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
      [redditConnId, redditAcctId, scopeId],
    );

    // Setup orphaned Reddit content item (only observed by Reddit)
    const redditOrphanItemId = randomUUID();
    await pool.query(
      `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility)
       VALUES ($1, $2, $3, $4, 'Reddit Orphan Post Body', 'PUBLIC')`,
      [redditOrphanItemId, redditPlatformId, redditAcctId, `reddit_post_${Date.now()}`],
    );
    await pool.query(
      `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version)
       VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
      [redditConnId, redditOrphanItemId, scopeId],
    );

    // Setup multi-provider content item (observed by Reddit AND X)
    const multiProviderItemId = randomUUID();
    await pool.query(
      `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility)
       VALUES ($1, $2, $3, $4, 'Multi Provider Post Body', 'PUBLIC')`,
      [multiProviderItemId, redditPlatformId, redditAcctId, `multi_provider_post_${Date.now()}`],
    );
    await pool.query(
      `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version)
       VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
      [redditConnId, multiProviderItemId, scopeId],
    );
    await pool.query(
      `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version)
       VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
      [xConnId, multiProviderItemId, xScopeId],
    );

    // Ensure retention policy metadata exists for reddit
    await pool.query(
      `INSERT INTO provider_data_retention_policies (provider_family, data_category, retention_class, retention_mode, metadata)
       VALUES ('reddit', 'reddit_test_cat', 'REDDIT_APPROVED_USE_CONTENT', 'APPROVED_USE_CASE', '{"deletionRequestDeadlineSeconds": 864000}'::jsonb)
       ON CONFLICT (provider_family, data_category) DO UPDATE SET metadata = EXCLUDED.metadata`,
    );

    // 1. Create connection-scoped deletion request WITHOUT supplying scopeId
    const creationResult = await createProviderDataDeletionRequest({
      providerFamily: "reddit",
      connectionId: redditConnId,
      scopeId: null, // Caller does NOT supply scopeId
      reason: "User requested Reddit disconnection and erasure",
      source: "USER_REQUEST",
    });

    assert.ok(creationResult.deletionRequestId);
    assert.equal(creationResult.providerFamily, "reddit");

    // 2. Execute deletion with bounded batchSize: 1
    const executionResult = await executeProviderDataDeletion(creationResult.deletionRequestId, {
      batchSize: 1,
    });

    assert.equal(executionResult.status, "COMPLETED");
    assert.ok(executionResult.contentObservationsPurged >= 2, "Both Reddit content observations should be purged");
    assert.ok(executionResult.canonicalItemsPurged >= 1, "Orphaned Reddit post should be purged");
    assert.ok(executionResult.accountObservationsPurged >= 1, "Account observation purged");
    assert.ok(executionResult.accountsSanitized >= 1, "Account sanitized");
    assert.ok(executionResult.accountHandlesPurged >= 1, "Account handles purged");

    // 3. Multi-provider canonical item preservation:
    const multiItemCheck = await pool.query(
      "SELECT id FROM social_content_items WHERE id = $1",
      [multiProviderItemId],
    );
    assert.equal(
      multiItemCheck.rows.length,
      1,
      "Multi-provider canonical item must be preserved because X observation still exists",
    );

    // 4. Orphaned item purged:
    const orphanItemCheck = await pool.query(
      "SELECT id FROM social_content_items WHERE id = $1",
      [redditOrphanItemId],
    );
    assert.equal(
      orphanItemCheck.rows.length,
      0,
      "Orphaned item with no remaining observations must be purged",
    );

    // 5. External account sanitized:
    const acctCheck = await pool.query(
      "SELECT current_handle, metadata FROM social_external_accounts WHERE id = $1",
      [redditAcctId],
    );
    assert.equal(acctCheck.rows[0]?.current_handle, null, "External account handle must be cleared");
    assert.ok(acctCheck.rows[0]?.metadata?.deletionRequestPurgedAt, "Account marked with purge timestamp");

    // 6. Test idempotency: re-running returns COMPLETED immediately
    const rerunResult = await executeProviderDataDeletion(creationResult.deletionRequestId);
    assert.equal(rerunResult.status, "COMPLETED");
    assert.equal(rerunResult.contentObservationsPurged, executionResult.contentObservationsPurged);
  } finally {
    await pool.end();
  }
});
