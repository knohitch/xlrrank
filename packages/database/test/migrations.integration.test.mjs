import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.MIGRATION_INTEGRATION_TEST === "1";

test(
  "migrations apply to an empty PostgreSQL database and create real constraints",
  { skip: !enabled },
  async () => {
    assert.equal(process.env.NODE_ENV, "test", "integration migration test requires NODE_ENV=test");

    const { getPool, closeDatabase } = await import("../dist/client.js");
    const { runMigrations } = await import("../dist/migrate.js");
    const pool = getPool();

    const dbNameResult = await pool.query("select current_database() as name");
    const dbName = dbNameResult.rows[0]?.name;
    assert.equal(
      dbName,
      "xlrrank_audit",
      "refusing to reset a database that is not the dedicated xlrrank_audit database",
    );

    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations();

    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const names = new Set(tables.rows.map((r) => r.table_name));
    for (const table of [
      "users",
      "sessions",
      "roles",
      "permissions",
      "social_accounts",
      "content",
      "relationships",
      "opportunities",
      "trends",
      "ai_providers",
      "ai_models",
      "support_tickets",
      "notifications",
      "subscriptions",
      "feature_flags",
      "email_tokens",
    ]) {
      assert.ok(names.has(table), `expected migrated table ${table}`);
    }

    const vector = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed",
    );
    assert.equal(vector.rows[0]?.installed, true);

    const foreignKeys = await pool.query(
      `SELECT count(*)::int AS count
       FROM information_schema.table_constraints
       WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY'`,
    );
    assert.ok((foreignKeys.rows[0]?.count ?? 0) > 0, "expected real foreign-key constraints");

    const uniqueIndexes = await pool.query(
      `SELECT count(*)::int AS count
       FROM pg_indexes
       WHERE schemaname='public' AND indexdef ILIKE '%UNIQUE%'`,
    );
    assert.ok((uniqueIndexes.rows[0]?.count ?? 0) > 0, "expected real unique indexes");

    await closeDatabase();
  },
);
