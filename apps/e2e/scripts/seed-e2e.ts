import { URL } from "node:url";
import { Pool } from "pg";
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  hashPassword,
  type Role,
} from "@xlrrank/auth";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "E2ePass123!";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for E2E seeding.");
}

const databaseName = new URL(DATABASE_URL).pathname.slice(1);
if (!databaseName.includes("xlrrank_e2e")) {
  throw new Error(`Refusing to seed non-E2E database: ${databaseName}`);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      TRUNCATE
        support_messages,
        support_tickets,
        audit_logs,
        sessions,
        email_tokens,
        user_roles,
        users
      RESTART IDENTITY CASCADE
    `);

    for (const role of ["USER", "SUPPORT", "ADMIN", "SUPER_ADMIN"]) {
      await client.query(
        `INSERT INTO roles (name, description)
         VALUES ($1::role_name, $2)
         ON CONFLICT (name) DO NOTHING`,
        [role, `${role} role`],
      );
    }

    for (const permission of ALL_PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (key, description)
         VALUES ($1, $1)
         ON CONFLICT (key) DO NOTHING`,
        [permission],
      );
    }

    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS) as [
      Role,
      string[],
    ][]) {
      for (const permission of permissions) {
        await client.query(
          `INSERT INTO role_permissions (role_name, permission_id)
           SELECT $1::role_name, id
           FROM permissions
           WHERE key = $2
           ON CONFLICT DO NOTHING`,
          [role, permission],
        );
      }
    }

    const users = [
      ["e2e-user@xlrrank.test", "E2E User", "ACTIVE", ["USER"]],
      ["e2e-user-a@xlrrank.test", "E2E User A", "ACTIVE", ["USER"]],
      ["e2e-user-b@xlrrank.test", "E2E User B", "ACTIVE", ["USER"]],
      ["e2e-support@xlrrank.test", "E2E Support", "ACTIVE", ["SUPPORT"]],
      ["e2e-admin@xlrrank.test", "E2E Admin", "ACTIVE", ["ADMIN"]],
      ["e2e-super@xlrrank.test", "E2E Super Admin", "ACTIVE", ["SUPER_ADMIN"]],
      ["e2e-super2@xlrrank.test", "E2E Backup Super", "ACTIVE", ["SUPER_ADMIN"]],
    ] as const;

    const passwordHash = await hashPassword(PASSWORD);
    for (const [email, displayName, status, roles] of users) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
         VALUES ($1, $2, $3, $4::account_status, now())
         RETURNING id`,
        [email, passwordHash, displayName, status],
      );
      const userId = inserted.rows[0]?.id;
      if (!userId) throw new Error(`Failed to create ${email}`);
      for (const role of roles) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_name)
           VALUES ($1, $2::role_name)
           ON CONFLICT DO NOTHING`,
          [userId, role],
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
