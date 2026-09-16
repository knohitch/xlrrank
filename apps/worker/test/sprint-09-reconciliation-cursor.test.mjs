import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  encryptSecret,
  socialCredentialAssociatedData,
} from "@xlrrank/shared";
import { connectorRegistry } from "@xlrrank/social-core";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "integration-test-master-key-32b!";
process.env.PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN ??= "100";

const DATABASE_URL = process.env.DATABASE_URL;

async function createTestScope(executor) {
  const userRes = await executor.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', 'Test User', 'ACTIVE') RETURNING id",
    [`user-reconcile-${Date.now()}-${Math.random()}@example.com`],
  );
  const scopeRes = await executor.query(
    "INSERT INTO data_scopes (scope_type, user_id) VALUES ('PERSONAL', $1) RETURNING id",
    [userRes.rows[0].id],
  );
  return scopeRes.rows[0].id;
}

test("provider reconciliation preserves checkpoint before deferred rate-limit candidates", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = `fixture-reconcile-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  connectorRegistry.registerFactory(() => ({
    getManifest() {
      return {
        id: slug,
        platformId: slug,
        name: "Fixture Reconciliation",
        version: "0.1.0",
        apiVersion: "fixture",
        capabilities: {},
        providerConfig: { fields: [] },
      };
    },
    async reconcileResources(items) {
      return {
        statuses: items.map((item, index) =>
          index === 0
            ? { externalId: item.externalId, state: "EXISTS" }
            : {
                externalId: item.externalId,
                state: "UNKNOWN",
                details: { reason: "DEFERRED_RATE_LIMIT" },
              },
        ),
        rateLimit: { remaining: 0, retryAfter: 60 },
      };
    },
  }));

  try {
    const scopeId = await createTestScope(pool);
    const platformId = randomUUID();
    const connectionId = randomUUID();

    await pool.query(
      `INSERT INTO platforms (id, slug, display_name, enabled, provider_family)
       VALUES ($1, $2, 'Fixture Reconciliation', true, $2)`,
      [platformId, slug],
    );
    const credentialsEncrypted = encryptSecret(
      JSON.stringify({ accessToken: "fixture-token" }),
      undefined,
      socialCredentialAssociatedData({
        connectionId,
        scopeId,
        platformSlug: slug,
      }),
    );
    await pool.query(
      `INSERT INTO social_connections (id, scope_id, platform_id, status, credentials_encrypted, updated_at)
       VALUES ($1, $2, $3, 'CONNECTED', $4, now() - interval '30 days')`,
      [connectionId, scopeId, platformId, credentialsEncrypted],
    );

    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO social_external_accounts (id, platform_id, external_id, current_handle)
       VALUES ($1, $2, $3, 'u/reconcile')`,
      [accountId, platformId, `acct-${randomUUID()}`],
    );
    for (let i = 0; i < 3; i++) {
      const itemId = randomUUID();
      await pool.query(
        `INSERT INTO social_content_items (id, platform_id, author_external_account_id, external_id, body, visibility)
         VALUES ($1, $2, $3, $4, 'body', 'PUBLIC')`,
        [itemId, platformId, accountId, `reconcile-${i}-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO social_content_observations (connection_id, content_item_id, scope_id, normalization_version, adapter_version)
         VALUES ($1, $2, $3, '1.0.0', '1.0.0')`,
        [connectionId, itemId, scopeId],
      );
    }

    const orderedCandidates = await pool.query(
      `
        SELECT sci.id
        FROM social_content_items sci
        JOIN social_content_observations sco ON sco.content_item_id = sci.id
        WHERE sco.connection_id = $1
        ORDER BY sci.id ASC
      `,
      [connectionId],
    );
    assert.equal(orderedCandidates.rows.length, 3);

    const { runProviderReconciliationSweepOnce } = await import("../dist/provider-reconciliation-sweep.js");
    const run = await runProviderReconciliationSweepOnce("reconciliation-cursor-test");
    assert.ok(run.itemsReconciled >= 1);

    const checkpoint = await pool.query(
      `
        SELECT last_processed_id, metadata
        FROM provider_reconciliation_checkpoints
        WHERE connection_id = $1 AND entity_type = 'CONTENT'
      `,
      [connectionId],
    );
    assert.equal(checkpoint.rows[0].last_processed_id, orderedCandidates.rows[0].id);
    assert.equal(checkpoint.rows[0].metadata.attemptedCount, 1);
    assert.notEqual(
      checkpoint.rows[0].last_processed_id,
      orderedCandidates.rows[2].id,
      "Checkpoint must not advance past deferred candidates",
    );
  } finally {
    connectorRegistry.unregister(slug);
    await pool.end();
  }
});
