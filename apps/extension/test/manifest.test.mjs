import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");

test("extension manifest is Manifest V3 and references built outputs", () => {
  const manifest = JSON.parse(readFileSync(join(extRoot, "src", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background?.service_worker);
  assert.ok(manifest.action?.default_popup);
  assert.ok(Array.isArray(manifest.permissions));
});

test("extension build output exists (vite)", () => {
  assert.equal(existsSync(join(extRoot, "dist", "background.js")), true);
  assert.equal(existsSync(join(extRoot, "dist", "popup.js")), true);
});
