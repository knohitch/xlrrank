import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

try {
  await runMigrations();
  process.exit(0);
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
}
