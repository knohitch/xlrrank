import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  tsconfig: "./tsconfig.drizzle.json",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://xlrrank:xlrrank@localhost:5432/xlrrank",
  },
  strict: true,
  verbose: true,
});
