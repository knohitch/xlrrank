import test from "node:test";
import assert from "node:assert/strict";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isAuditDb = DATABASE_URL.includes("xlrrank") || DATABASE_URL.includes("localhost");
const skip = !DATABASE_URL || !isAuditDb;

let pool;
let api;

async function setup() {
  if (pool) return;
  process.env.ENCRYPTION_MASTER_KEY ??= "social-isolation-key-32-bytes-minimum";
  const { Pool } = await import("pg");
  api = await import("../dist/index.js");
  await api.runMigrations?.();
  pool = new Pool({ connectionString: DATABASE_URL });
}

async function reset() {
  await setup();
  await pool.query(
    "TRUNCATE audit_logs, social_content_metrics, social_interaction_observations, social_interactions, social_content_observations, social_content_items, social_account_observations, social_ingestion_runs, social_connections, social_account_handles, social_external_accounts, social_accounts, data_scopes, organization_member_permissions, organization_members, organizations, platforms, users RESTART IDENTITY CASCADE",
  );
}

async function user(email) {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [email, email],
  );
  return result.rows[0].id;
}

async function platform(slug = `reference-${Date.now()}-${Math.random()}`) {
  const result = await pool.query(
    "INSERT INTO platforms (slug, display_name, enabled) VALUES ($1, $2, true) RETURNING id",
    [slug, slug],
  );
  return result.rows[0].id;
}

async function connected(scopeId, platformId, externalId = "acct") {
  const account = await pool.query(
    "INSERT INTO social_external_accounts (platform_id, external_id, current_handle, visibility) VALUES ($1, $2, $3, 'PUBLIC') ON CONFLICT (platform_id, external_id) DO UPDATE SET current_handle = EXCLUDED.current_handle RETURNING id",
    [platformId, externalId, externalId],
  );
  const connection = await pool.query(
    "INSERT INTO social_connections (scope_id, platform_id, external_account_id, status, credentials_encrypted, verified_external_id, verified_handle) VALUES ($1, $2, $3, 'CONNECTED', $4, $5, $6) RETURNING id",
    [scopeId, platformId, account.rows[0].id, `enc:v2:${scopeId}:redacted`, externalId, externalId],
  );
  return connection.rows[0].id;
}

function profile(platformId, externalId, handle, visibility = "PUBLIC") {
  return {
    platformId,
    externalId,
    handle,
    displayName: handle,
    visibility,
    provenance: {
      platformId,
      observedAt: "2030-01-01T00:00:00.000Z",
      normalizationVersion: "social-normalized-v2",
      adapterVersion: "test-adapter-v1",
      visibility,
    },
    metadata: { authorization: "secret", nested: { refresh_token: "secret" } },
  };
}

function content(platformId, authorExternalId, externalId, visibility = "PUBLIC") {
  return {
    platformId,
    authorExternalId,
    externalId,
    body: `body ${externalId}`,
    contentType: "post",
    language: "en",
    externalCreatedAt: "2030-01-01T00:00:00.000Z",
    visibility,
    metrics: {
      likes: 1,
      comments: 2,
      shares: 3,
      impressions: 4,
      snapshotKey: `${externalId}:snapshot`,
    },
    provenance: {
      platformId,
      observedAt: "2030-01-01T00:00:00.000Z",
      providerCreatedAt: "2030-01-01T00:00:00.000Z",
      normalizationVersion: "social-normalized-v2",
      adapterVersion: "test-adapter-v1",
      visibility,
    },
    metadata: { access_token: "secret", safe: "kept" },
  };
}

function interaction(platformId, fromExternalId, externalId, visibility = "PUBLIC") {
  return {
    platformId,
    fromExternalId,
    externalId,
    type: "LIKE",
    occurredAt: "2030-01-02T00:00:00.000Z",
    visibility,
    provenance: {
      platformId,
      observedAt: "2030-01-02T00:00:00.000Z",
      normalizationVersion: "social-normalized-v2",
      adapterVersion: "test-adapter-v1",
      visibility,
    },
    metadata: {},
  };
}

async function persistPage(
  scope,
  connectionId,
  platformId,
  cursorBefore,
  cursorAfter,
  visibility = "PUBLIC",
) {
  const runId = await api.beginSocialIngestionRun({
    scope,
    connectionId,
    platformId,
    cursorBefore,
    normalizationVersion: "social-normalized-v2",
  });
  return api.persistSocialSyncPage({
    scope,
    connectionId,
    platformId,
    ingestionRunId: runId,
    cursorBefore,
    cursorAfter,
    profiles: [profile(platformId, "acct-shared", "shared", "PUBLIC")],
    content: [content(platformId, "acct-shared", "post-shared", visibility)],
    interactions: [interaction(platformId, "acct-shared", `int-${visibility}`, visibility)],
    normalizationVersion: "social-normalized-v2",
    adapterVersion: "test-adapter-v1",
  });
}

test(
  "social data isolation: personal, organization, IDOR, shared public, private data, idempotency, cursor",
  { skip },
  async () => {
    await reset();
    const [userA, userB, userMulti, supportUser, adminUser, superAdminUser] = await Promise.all([
      user("a@example.test"),
      user("b@example.test"),
      user("multi@example.test"),
      user("support@example.test"),
      user("admin@example.test"),
      user("super-admin@example.test"),
    ]);
    const platformId = await platform("reference-http");
    const scopeA = await api.ensurePersonalScope(userA);
    const scopeB = await api.ensurePersonalScope(userB);
    const connectionA = await connected(scopeA.scopeId, platformId, "acct-a");
    const connectionB = await connected(scopeB.scopeId, platformId, "acct-b");

    assert.equal(await api.authorizeScope(userA, scopeB.scopeId), null);
    assert.equal(await api.authorizeConnection(userA, connectionB), null);
    assert.equal((await api.authorizeConnection(userA, connectionA)).scopeId, scopeA.scopeId);

    await persistPage(scopeA, connectionA, platformId, null, "page-2", "PUBLIC");
    await persistPage(scopeB, connectionB, platformId, null, "page-2", "PUBLIC");
    await persistPage(scopeA, connectionA, platformId, "page-2", "page-3", "PUBLIC");

    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_external_accounts WHERE external_id = 'acct-shared'",
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_account_observations WHERE external_account_id = (SELECT id FROM social_external_accounts WHERE external_id = 'acct-shared')",
          )
        ).rows[0].count,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_content_items WHERE external_id = 'post-shared' AND scope_id IS NULL",
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_content_observations WHERE content_item_id = (SELECT id FROM social_content_items WHERE external_id = 'post-shared' AND scope_id IS NULL)",
          )
        ).rows[0].count,
      ),
      2,
    );
    assert.equal(
      (await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [connectionA]))
        .rows[0].sync_cursor,
      "page-3",
    );

    await persistPage(scopeA, connectionA, platformId, "page-3", "page-4", "SCOPE_PRIVATE");
    await persistPage(scopeB, connectionB, platformId, "page-2", "page-4", "SCOPE_PRIVATE");
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_content_items WHERE external_id = 'post-shared' AND scope_id IS NOT NULL",
          )
        ).rows[0].count,
      ),
      2,
    );

    const orgA = await pool.query("INSERT INTO organizations (name) VALUES ('Org A') RETURNING id");
    const orgB = await pool.query("INSERT INTO organizations (name) VALUES ('Org B') RETURNING id");
    const scopeOrgAId = await api.ensureOrganizationScope(orgA.rows[0].id);
    const scopeOrgBId = await api.ensureOrganizationScope(orgB.rows[0].id);
    const memberA = await pool.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id",
      [orgA.rows[0].id, userMulti],
    );
    await pool.query(
      "INSERT INTO organization_member_permissions (member_id, capability) VALUES ($1, 'VIEW_SOCIAL_DATA')",
      [memberA.rows[0].id],
    );
    assert.equal((await api.authorizeScope(userMulti, scopeOrgAId)).scopeId, scopeOrgAId);
    assert.equal(await api.authorizeScope(userMulti, scopeOrgBId), null);

    await pool.query(
      "INSERT INTO roles (name, description) VALUES ('SUPPORT', 'Support'), ('ADMIN', 'Admin'), ('SUPER_ADMIN', 'Super admin') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'SUPPORT'), ($2, 'ADMIN'), ($3, 'SUPER_ADMIN')",
      [supportUser, adminUser, superAdminUser],
    );
    assert.equal(await api.authorizeScope(supportUser, scopeOrgAId), null);
    assert.equal(await api.authorizeScope(adminUser, scopeOrgAId), null);
    assert.equal(await api.authorizeScope(superAdminUser, scopeOrgAId), null);
  },
);

test(
  "social data isolation: failure before commit and partial page retry keep durable cursor",
  { skip },
  async () => {
    await reset();
    const userId = await user("cursor@example.test");
    const platformId = await platform("reference-cursor");
    const scope = await api.ensurePersonalScope(userId);
    const connectionId = await connected(scope.scopeId, platformId, "acct-cursor");

    await persistPage(scope, connectionId, platformId, null, "page-1", "PUBLIC");
    const failedRun = await api.beginSocialIngestionRun({
      scope,
      connectionId,
      platformId,
      cursorBefore: "page-1",
      normalizationVersion: "social-normalized-v2",
    });
    await api.markSocialIngestionFailed({
      runId: failedRun,
      error: { code: "MALFORMED_PROVIDER_RESPONSE" },
      retryClassification: "NON_RETRYABLE",
    });
    assert.equal(
      (await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [connectionId]))
        .rows[0].sync_cursor,
      "page-1",
    );

    await persistPage(scope, connectionId, platformId, "page-1", "page-2", "PUBLIC");
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM social_content_items WHERE external_id = 'post-shared'",
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(
      (await pool.query("SELECT sync_cursor FROM social_connections WHERE id = $1", [connectionId]))
        .rows[0].sync_cursor,
      "page-2",
    );
  },
);

test(
  "social data isolation: same-connection concurrent sync is protected by postgres advisory lock",
  { skip },
  async () => {
    await reset();
    const userId = await user("lock@example.test");
    const platformId = await platform("reference-lock");
    const scope = await api.ensurePersonalScope(userId);
    const connectionId = await connected(scope.scopeId, platformId, "acct-lock");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [connectionId]);
      const runId = await api.beginSocialIngestionRun({
        scope,
        connectionId,
        platformId,
        cursorBefore: null,
        normalizationVersion: "social-normalized-v2",
      });
      await assert.rejects(
        () =>
          api.persistSocialSyncPage({
            scope,
            connectionId,
            platformId,
            ingestionRunId: runId,
            cursorBefore: null,
            cursorAfter: "locked",
            profiles: [profile(platformId, "acct-lock", "lock")],
            content: [],
            interactions: [],
            normalizationVersion: "social-normalized-v2",
            adapterVersion: "test-adapter-v1",
          }),
        /already running/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);

test(
  "legacy migration backfill preserves credentials, cursor, status, and platform identity",
  { skip },
  async () => {
    await reset();
    const userId = await user("legacy@example.test");
    const platformId = await platform("legacy-platform");
    await pool.query(
      `
      INSERT INTO social_accounts (
        platform_id, user_id, external_id, handle, status,
        credentials_encrypted, sync_cursor, last_sync_at
      )
      VALUES ($1, $2, 'legacy-ext', 'legacy-handle', 'CONNECTED', 'enc:v1:legacy:ciphertext', 'legacy-cursor', now())
    `,
      [platformId, userId],
    );
    await pool.query("SELECT backfill_legacy_social_accounts()");
    const scope = await api.ensurePersonalScope(userId);
    const result = await pool.query(
      `
      SELECT sc.credentials_encrypted, sc.sync_cursor, sc.status, sea.external_id, sea.current_handle
      FROM social_connections sc
      JOIN social_external_accounts sea ON sea.id = sc.external_account_id
      WHERE sc.scope_id = $1 AND sc.platform_id = $2
    `,
      [scope.scopeId, platformId],
    );
    assert.equal(result.rows[0].credentials_encrypted, "enc:v1:legacy:ciphertext");
    assert.equal(result.rows[0].sync_cursor, "legacy-cursor");
    assert.equal(result.rows[0].status, "CONNECTED");
    assert.equal(result.rows[0].external_id, "legacy-ext");
    assert.equal(result.rows[0].current_handle, "legacy-handle");
  },
);
