import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { deactivatePersonalSocialAccessForAccountDeletion, runMigrations } from "../dist/index.js";

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit";
process.env.ENCRYPTION_MASTER_KEY ??= "account-delete-test-key-32-bytes";

const DATABASE_URL = process.env.DATABASE_URL;

async function createUser(pool, email) {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES ($1, 'hash', $2, 'ACTIVE') RETURNING id",
    [email, email],
  );
  return result.rows[0].id;
}

async function createConnectedPersonalScope(pool, userId, platformId, suffix) {
  const scope = await pool.query(
    "INSERT INTO data_scopes (scope_type, user_id) VALUES ('PERSONAL', $1) RETURNING id",
    [userId],
  );
  const connection = await pool.query(
    `
      INSERT INTO social_connections (
        scope_id, platform_id, status, credentials_encrypted, sync_enabled,
        schedule_cadence_seconds, next_sync_at
      )
      VALUES ($1, $2, 'CONNECTED', $3, true, 300, now() - interval '1 minute')
      RETURNING id
    `,
    [scope.rows[0].id, platformId, `enc:v2:${suffix}:secret-token`],
  );
  return { scopeId: scope.rows[0].id, connectionId: connection.rows[0].id };
}

async function createActiveSyncState(pool, scopeId, connectionId) {
  const job = await pool.query(
    `
      INSERT INTO jobs (
        type, status, queue_name, payload, payload_version, scope_id, connection_id, reason, max_attempts
      )
      VALUES (
        'social.connection.sync', 'QUEUED', 'ingestion',
        jsonb_build_object('version', 1, 'connectionId', $2::text, 'reason', 'MANUAL'),
        1, $1::uuid, $2::uuid, 'MANUAL', 3
      )
      RETURNING id
    `,
    [scopeId, connectionId],
  );
  await pool.query(
    `
      INSERT INTO social_sync_schedules (connection_id, enabled, cadence_seconds, next_sync_at, locked_by, locked_until)
      VALUES ($1, true, 300, now() - interval '1 minute', 'scheduler-a', now() + interval '5 minutes')
    `,
    [connectionId],
  );
  await pool.query(
    `
      INSERT INTO social_sync_leases (connection_id, job_id, owner_token, expires_at)
      VALUES ($1, $2, 'worker-a', now() + interval '5 minutes')
    `,
    [connectionId, job.rows[0].id],
  );
  return job.rows[0].id;
}

test("Sprint 20: account deletion revokes personal social execution state without touching other tenants", async () => {
  await runMigrations();
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const platformId = randomUUID();
    const deletedUserId = await createUser(
      pool,
      `delete-${Date.now()}-${Math.random()}@example.test`,
    );
    const otherUserId = await createUser(pool, `other-${Date.now()}-${Math.random()}@example.test`);
    await pool.query(
      "INSERT INTO platforms (id, slug, display_name, enabled) VALUES ($1, $2, 'Deletion Test', true)",
      [platformId, `deletion-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`],
    );

    const deletedScope = await createConnectedPersonalScope(
      pool,
      deletedUserId,
      platformId,
      "deleted",
    );
    const otherScope = await createConnectedPersonalScope(pool, otherUserId, platformId, "other");
    const deletedJobId = await createActiveSyncState(
      pool,
      deletedScope.scopeId,
      deletedScope.connectionId,
    );
    const otherJobId = await createActiveSyncState(
      pool,
      otherScope.scopeId,
      otherScope.connectionId,
    );

    const result = await deactivatePersonalSocialAccessForAccountDeletion(deletedUserId);

    assert.equal(result.connectionsDisconnected, 1);
    assert.equal(result.schedulesDisabled, 1);
    assert.equal(result.leasesReleased, 1);
    assert.equal(result.jobsCancelled, 1);

    const deletedConnection = await pool.query(
      `
        SELECT status, credentials_encrypted, sync_enabled, next_sync_at, disconnected_at
        FROM social_connections
        WHERE id = $1
      `,
      [deletedScope.connectionId],
    );
    assert.equal(deletedConnection.rows[0].status, "DISCONNECTED");
    assert.equal(deletedConnection.rows[0].credentials_encrypted, null);
    assert.equal(deletedConnection.rows[0].sync_enabled, false);
    assert.equal(deletedConnection.rows[0].next_sync_at, null);
    assert.ok(deletedConnection.rows[0].disconnected_at);

    const deletedJob = await pool.query("SELECT status, safe_error FROM jobs WHERE id = $1", [
      deletedJobId,
    ]);
    assert.equal(deletedJob.rows[0].status, "CANCELLED");
    assert.equal(deletedJob.rows[0].safe_error.message.includes("revoked social access"), true);
    assert.equal(
      (
        await pool.query("SELECT 1 FROM social_sync_leases WHERE connection_id = $1", [
          deletedScope.connectionId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT enabled, locked_by, locked_until FROM social_sync_schedules WHERE connection_id = $1",
          [deletedScope.connectionId],
        )
      ).rows[0].enabled,
      false,
    );

    const otherConnection = await pool.query(
      "SELECT status, credentials_encrypted, sync_enabled FROM social_connections WHERE id = $1",
      [otherScope.connectionId],
    );
    assert.equal(otherConnection.rows[0].status, "CONNECTED");
    assert.equal(otherConnection.rows[0].sync_enabled, true);
    assert.match(otherConnection.rows[0].credentials_encrypted, /^enc:v2:other:/);
    assert.equal(
      (await pool.query("SELECT status FROM jobs WHERE id = $1", [otherJobId])).rows[0].status,
      "QUEUED",
    );
  } finally {
    await pool.end();
  }
});
