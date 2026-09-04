import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const migrationsDir = join(pkgRoot, "migrations");

test("migrations directory exists with journal", () => {
  assert.equal(existsSync(join(migrationsDir, "meta", "_journal.json")), true);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  assert.ok(files.length >= 1, "expected at least one migration");
});

test("pgvector extension is enabled by migrations or migrate runner", () => {
  const runner = readFileSync(join(pkgRoot, "src", "migrate.ts"), "utf8");
  assert.ok(runner.includes("CREATE EXTENSION IF NOT EXISTS vector"));
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const combined = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
  assert.ok(combined.includes("vector("), "expected vector columns in migrations");
});

test("core domain tables exist in migrations", () => {
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const combined = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
  for (const table of ['"users"', '"sessions"', '"roles"', '"platforms"', '"people"', '"content"']) {
    assert.ok(combined.includes(table), `missing table ${table}`);
  }
});
