import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { getEnv } from "@xlrrank/config";
import { seedRbac } from "./seed-rbac.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

export async function runSeed() {
  getEnv();
  await seedRbac();
  console.log("Seed completed: RBAC roles and permissions are configured.");
}

try {
  await runSeed();
  process.exit(0);
} catch (err) {
  console.error("Seed failed:", err);
  process.exit(1);
}
