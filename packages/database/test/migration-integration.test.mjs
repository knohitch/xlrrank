import test from "node:test";
import assert from "node:assert/strict";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isAuditDb = DATABASE_URL.includes("xlrrank_audit") || DATABASE_URL.includes("localhost");

test("migration integration: requires audit database", { skip: !DATABASE_URL || !isAuditDb }, async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set");
  assert.ok(isAuditDb, "Must connect to xlrrank_audit database, not production");
});

test("migration integration: runs against PostgreSQL with pgvector", { skip: !DATABASE_URL || !isAuditDb }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const dbRes = await pool.query("SELECT current_database()");
    const dbName = dbRes.rows[0]?.current_database;
    assert.ok(
      dbName?.includes("xlrrank") || dbName?.includes("audit"),
      `Connected to unexpected database: ${dbName}`,
    );

    const extRes = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    assert.equal(extRes.rows[0]?.extname, "vector", "pgvector extension not found");

    const expectedTables = [
      "users", "sessions", "roles", "permissions", "user_roles",
      "platforms", "social_accounts", "people", "content",
      "relationships", "ai_providers", "ai_models",
    ];
    for (const table of expectedTables) {
      const res = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      assert.ok(res.rows.length > 0, `Table '${table}' not found`);
    }

    const fkRes = await pool.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      LIMIT 5
    `);
    assert.ok(fkRes.rows.length > 0, "No foreign keys found");

    const uniqRes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%unique%'
      LIMIT 5
    `);
    assert.ok(uniqRes.rows.length > 0, "No unique indexes found");

    await pool.end();
  } catch (err) {
    await pool.end();
    throw err;
  }
});

test("migration integration: drizzle migrate runs cleanly", { skip: !DATABASE_URL || !isAuditDb }, async () => {
  const { runMigrations } = await import("../dist/migrate.js");
  await assert.doesNotReject(() => runMigrations(), "Migration should not reject on clean database");
});
