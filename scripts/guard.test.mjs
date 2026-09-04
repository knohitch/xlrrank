import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, "constitution-guard.mjs");
const REPO_ROOT = join(__dirname, "..");

function runGuard(targetDir) {
  return spawnSync(process.execPath, [GUARD, targetDir], { encoding: "utf8" });
}

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "xlrrank-guard-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("clean package tree passes", () => {
  const root = makeTree({
    "packages/intelligence/engine.ts": `export const score = 42;`,
  });
  try {
    const result = runGuard(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forbidden platform-specific core concept is flagged (Law 1)", () => {
  const twitter = "twitter";
  const linkedin = "linkedin";
  const root = makeTree({
    "packages/intelligence/bad.ts": `export const ${twitter}_user = 1;`,
    "packages/intelligence/bad2.ts": `export const ${linkedin}_contact = 2;`,
  });
  try {
    const result = runGuard(root);
    assert.equal(result.status, 1);
    const out = result.stdout + result.stderr;
    assert.match(out, /intelligence[\\/]bad\.ts/);
    assert.match(out, /intelligence[\\/]bad2\.ts/);
    assert.match(out, /Law 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret literals are flagged (Law 3)", () => {
  const fakeKey = "sk-" + "ABCdef12345678901234567890";
  const root = makeTree({
    "packages/intelligence/leak.ts": `export const key = "${fakeKey}";`,
  });
  try {
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /API key literal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardcoded model name is flagged outside ai-core (Law 3)", () => {
  const gpt = "gpt-" + "4o-mini";
  const root = makeTree({
    "packages/intelligence/score.ts": `export const model = "${gpt}";`,
    "packages/ai-core/registry.ts": `export const model = "${gpt}";`,
  });
  try {
    const result = runGuard(root);
    assert.equal(result.status, 1);
    const out = result.stdout + result.stderr;
    assert.match(out, /intelligence[\\/]score\.ts/);
    assert.doesNotMatch(out, /ai-core/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository itself passes the constitution guard", () => {
  const result = runGuard(REPO_ROOT);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});