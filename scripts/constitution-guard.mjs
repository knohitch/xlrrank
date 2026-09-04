import {
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".pnpm-store",
  "__fixtures__",
]);

const FORBIDDEN_IDENTIFIERS = [
  {
    pattern: /[a-z_]*\btwitter_user\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
  {
    pattern: /[a-z_]*\binstagram_person\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
  {
    pattern: /[a-z_]*\blinkedin_contact\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
  {
    pattern: /[a-z_]*\btwitter_profile\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
  {
    pattern: /[a-z_]*\binstagram_account\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
  {
    pattern: /[a-z_]*\blinkedin_profile\b/i,
    law: "Law 1",
    message: "platform-specific core concept found (use Person / SocialAccount / Platform)",
  },
];

const MODEL_NAME_PATTERN =
  /\b(gpt-[0-9][a-z0-9.-]+|o[1-9]-[a-z0-9.-]+|claude-[a-z0-9.-]+|deepseek-[a-z0-9.-]+|grok-[a-z0-9.-]+|mimo-[a-z0-9.-]+|llama-[0-9][a-z0-9.-]*|qwen-[0-9][a-z0-9.-]*)\b/i;

const SECRET_PATTERNS = [
  { pattern: /sk-[A-Za-z0-9]{16,}/, message: "possible API key literal (Law 3)" },
  { pattern: /AIza[0-9A-Za-z_-]{20,}/, message: "possible Google API key literal (Law 3)" },
  { pattern: /AKIA[0-9A-Z]{16}\b/, message: "possible AWS access key literal (Law 3)" },
  { pattern: /-----BEGIN (?:RSA |OPENSSH |EC |ENCRYPTED )?PRIVATE KEY-----/, message: "private key material (Law 3)" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, message: "possible GitHub token literal (Law 3)" },
];

function pathUnder(relPath, parts) {
  const segs = relPath.split(/[\\/]/);
  return parts.every((part, index) => segs[index] === part);
}

function shouldSkipDir(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

function collectSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(root, full);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!shouldSkipDir(rel)) walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf("."));
        if (SOURCE_EXTENSIONS.has(ext)) files.push({ full, rel });
      }
    }
  };
  walk(root);
  return files;
}

function scanFile({ full, rel, root }) {
  const violations = [];
  const content = readFileSync(full, "utf8");
  const lines = content.split(/\r?\n/);
  const isModelExempt =
    pathUnder(rel, ["packages", "ai-core"]) || pathUnder(rel, ["packages", "config"]);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line === undefined) continue;

    for (const rule of FORBIDDEN_IDENTIFIERS) {
      const match = rule.pattern.exec(line);
      if (match && match.index !== undefined) {
        violations.push({
          file: rel,
          line: lineNo + 1,
          column: match.index + 1,
          law: rule.law,
          message: rule.message,
        });
      }
    }

    if (!isModelExempt) {
      const modelMatch = MODEL_NAME_PATTERN.exec(line);
      if (modelMatch && modelMatch.index !== undefined) {
        violations.push({
          file: rel,
          line: lineNo + 1,
          column: modelMatch.index + 1,
          law: "Law 3",
          message: `hardcoded model name "${modelMatch[1]}" in business logic (Law 3)`,
        });
      }
    }

    for (const rule of SECRET_PATTERNS) {
      const match = rule.pattern.exec(line);
      if (match && match.index !== undefined) {
        violations.push({
          file: rel,
          line: lineNo + 1,
          column: match.index + 1,
          law: "Law 3",
          message: rule.message,
        });
      }
    }
  }

  return { violations, fileName: rel };
}

export function scanDirectory(root) {
  const files = collectSourceFiles(root);
  const violations = [];
  for (const file of files) {
    const result = scanFile({ ...file, root });
    violations.push(...result.violations);
  }
  return { scanned: files.length, violations };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const target = process.argv[2] ?? ".";
  const { scanned, violations } = scanDirectory(resolve(target));

  if (violations.length === 0) {
    console.log(`constitution-guard: PASS (${scanned} source files scanned, 0 violations)`);
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`${v.file}:${v.line}:${v.column} [${v.law}] ${v.message}`);
  }
  console.error(
    `constitution-guard: FAIL (${violations.length} violation${violations.length === 1 ? "" : "s"} across ${scanned} source files)`,
  );
  process.exit(1);
}