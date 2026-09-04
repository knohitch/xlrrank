import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { getDb, getPool } from "./client.js";

export async function runMigrations() {
  const db = getDb();
  const env = process.env;
  const migrationsFolder =
    env.DATABASE_MIGRATIONS_FOLDER ??
    fileURLToPath(new URL("../migrations", import.meta.url));

  const pool = getPool();
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  await migrate(db, { migrationsFolder });
  console.log("Migrations completed successfully.");
}
