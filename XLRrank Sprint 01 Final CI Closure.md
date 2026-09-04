# XLRRANK — SPRINT 01 FINAL CI CLOSURE

Repository:

`https://github.com/knohitch/xlrrank`

Branch:

`audit/production-verification-2026-09-04`

Current verified remote HEAD:

`3498660934503941974e3c2cb361ad47ca0c56d4`

Do NOT begin Sprint 02 yet.

Independent GitHub verification confirms that the Sprint 01 work is pushed, but the latest GitHub Actions run is still failing.

Your task is to close the remaining **verification-infrastructure defects** so that Sprint 01 can be considered remotely verified.

Do NOT implement social integrations, AI provider features, intelligence engines, workers, or other Sprint 02+ functionality.

---

# CURRENT REMOTE EVIDENCE

GitHub Actions currently shows:

```text
Install:                  PASS
Constitution Guard:       PASS
Lint:                     PASS
Typecheck:                PASS
PostgreSQL Migrations:    PASS
Tests:                    FAIL
Build:                    SKIPPED
Docker Compose:           SKIPPED
Dependency Audit:         EXECUTED / KNOWN VULNERABILITIES REMAIN
```

The PostgreSQL migration job successfully executed:

- PostgreSQL 16 + pgvector
- actual migrations
- migration re-application
- pgvector verification
- key table verification
- migration integration test

Do NOT regress this.

---

# DEFECT 1 — CONFIG TESTS REQUIRE BUILD OUTPUT THAT DOES NOT EXIST

Current config tests import:

```js
await import("../dist/env.js")
```

but the Tests job executes:

```bash
pnpm --filter @xlrrank/config test
```

without first producing `packages/config/dist`.

Therefore GitHub CI fails with:

```text
ERR_MODULE_NOT_FOUND:
packages/config/dist/env.js
```

This is a test lifecycle defect.

Fix it properly.

Determine the intended repository convention:

### Option A

Tests intentionally verify compiled package output.

Then the package/test pipeline must explicitly build the package and required dependencies before running those tests.

### Option B

Tests should execute source code directly through the project's supported TS execution tooling.

Then implement that consistently.

Do NOT depend on leftover `dist` directories from a developer machine.

A clean GitHub Actions checkout must be sufficient.

Do NOT commit generated `dist` output.

---

# DEFECT 2 — COMMONJS `require()` INSIDE ESM TEST

Current file:

`packages/config/test/env-production.test.mjs`

contains:

```js
const { signToken } = require("@xlrrank/auth");
```

This is invalid in the current ESM test context and GitHub fails with:

```text
ReferenceError: require is not defined
```

Correct this using the project's proper ESM conventions.

However, do NOT merely replace `require()` mechanically.

First determine what this test is actually supposed to prove.

The stated test is:

> production rejects missing SESSION_SIGNING_SECRET

That requirement is fundamentally an **environment/configuration validation requirement**.

Test the correct layer.

If `envSchema` is responsible for validating this requirement, test `envSchema`.

If `signToken()` independently has a runtime guard, test that separately in the auth/security tests.

Avoid duplicated tests that prove the wrong subsystem.

---

# DEFECT 3 — REMOVE THE FAKE SMTP TEST

The current `packages/config/test/env-production.test.mjs` contains:

```js
test("env validation: SMTP validation when EMAIL_TRANSPORT=smtp", () => {
  assert.ok(true, "SMTP validation handled by EmailService at runtime");
});
```

This is NOT a valid test.

It proves nothing.

It directly violates the XLRrank rule:

> No fake success.

Remove or replace it with an actual assertion.

Note that `packages/config/test/env.test.mjs` already contains meaningful SMTP validation:

- SMTP mode without required fields must fail
- SMTP mode with required configuration must pass

Do not maintain a duplicate fake assertion merely to increase the test count.

Test totals must represent real tests.

---

# DEFECT 4 — REMOVE NONEXISTENT `@xlrrank/storage` FROM CI

The Tests job currently includes:

```bash
pnpm --filter @xlrrank/storage test
```

Verify the actual workspace manifests.

If `@xlrrank/storage` does not exist, remove this stale CI reference.

Do NOT create a fake storage package merely to satisfy the workflow.

CI must reflect the actual repository.

Also inspect the entire workflow for other package names that no longer exist.

---

# TASK 5 — MAKE TEST EXECUTION COMPLETE

The current Tests job stops after the first failed package, meaning later package tests and security tests are skipped.

We need a trustworthy test gate.

Prefer using the repository's real workspace dependency graph rather than manually maintaining a drifting list of package commands.

If the root already provides an appropriate Turbo test command, consider using it with bounded concurrency.

For example conceptually:

```text
build test prerequisites
        ↓
execute workspace tests
        ↓
execute security/integration suites that are outside Turbo
```

But inspect `turbo.json` and package scripts first.

Do not blindly use a command that previously caused incorrect discovery.

Requirements:

- all packages that actually define tests execute
- packages without tests are not falsely counted
- one stale package name cannot silently survive
- build prerequisites are explicit
- test discovery remains deterministic
- CI clean checkout works
- security tests execute remotely

---

# TASK 6 — SECURITY TESTS MUST ACTUALLY RUN IN GITHUB

The previous report said security tests pass locally.

That is not sufficient.

The GitHub Tests job currently fails before reaching:

```bash
node --test scripts/security.test.mjs
```

After fixing the config test lifecycle, ensure the remote GitHub run actually executes the security suite.

Report its exact:

- number of tests
- passes
- failures
- skips

Do not report a local result as remote evidence.

---

# TASK 7 — BUILD MUST RUN AS AN INDEPENDENT VERIFICATION GATE

The Build job is currently defined with:

```yaml
needs: [lint, typecheck, tests]
```

Therefore a test-infrastructure failure prevents us from learning whether the production build succeeds.

Sprint 01 explicitly sought independently useful verification gates.

Restructure CI appropriately so independent verification can still execute.

The production build should be able to run after installation independently of unrelated test failures.

This does NOT mean a deployment can proceed when tests fail.

Distinguish:

```text
collect independent build evidence
```

from:

```text
approve deployment
```

Production readiness must still require all mandatory gates.

---

# TASK 8 — DOCKER COMPOSE VALIDATION MUST EXECUTE REMOTELY

Docker Compose validation was skipped only because Build was skipped.

Once CI dependencies are corrected, ensure:

```bash
docker compose config --quiet
```

actually executes on GitHub Actions.

Also preserve the rule:

- no hardcoded production XLRrank domain
- valid service references only
- no nonexistent workspace packages
- required secrets represented correctly

This remains Compose validation, not yet full production Docker deployment certification.

---

# TASK 9 — DO NOT MISREPORT DEPENDENCY AUDIT AS PASS

The dependency-audit workflow currently uses:

```yaml
continue-on-error: true
```

This means the GitHub job can appear successful even when `pnpm audit --prod` discovers vulnerabilities.

Do NOT describe that as:

```text
Dependency Audit: PASS
```

when vulnerabilities remain.

Use an evidence status such as:

```text
Dependency Audit: EXECUTED — FAIL/PARTIAL, remediation required
```

based on actual audit output.

Do NOT remove `continue-on-error` solely for aesthetics if keeping the job non-blocking during the audit is intentional.

But the report must accurately expose vulnerability counts.

Actual remediation belongs in Sprint 02.

---

# TASK 10 — RETEST EVERYTHING REMOTELY

After making these corrections:

1. commit changes
2. push the SAME audit branch
3. let GitHub Actions run
4. inspect the actual GitHub Actions result
5. fix verification-infrastructure failures if any remain

Do NOT stop at:

```text
workflow configured
```

We now require:

```text
workflow executed
```

---

# REQUIRED REMOTE GATES

Before declaring Sprint 01 remotely verified, GitHub must provide actual execution evidence for:

```text
Frozen install
Constitution guard
Lint
Typecheck
Tests
Security tests
PostgreSQL migrations
Migration repeat deployment
Production build
Docker Compose validation
Dependency audit
```

A known real product/security vulnerability can remain documented for Sprint 02.

A broken audit harness cannot.

---

# TEST COUNT RULE

Do not use historical numbers.

Calculate the exact test totals from the final GitHub run.

Never count:

- `assert.ok(true)` placeholders
- skipped commands
- tests that did not execute
- local-only tests as GitHub-tested
- static string checks as database integration tests

Return exact:

```text
tests executed:
passed:
failed:
skipped:
```

Break out security tests separately if useful.

---

# AUDIT DOCUMENT CORRECTION

Update:

`AUDIT-REPORT.md`

if any current claims conflict with the latest GitHub evidence.

Specifically correct:

- remote test status
- test totals
- lint status
- migration status
- build status
- Docker/Compose status
- dependency audit status

Do the same for the verification layer in:

`BUILD-PROGRESS.md`

Do not erase historical implementation notes.

---

# DO NOT TOUCH THESE PRODUCT AREAS YET

Do not implement:

- X API
- Instagram
- Facebook
- LinkedIn
- Reddit
- ingestion workers
- AI provider management
- model discovery persistence
- AI routing changes
- intelligence engines
- vector search
- browser extension production auth
- plans/billing
- demo architecture

This is the final closure of Sprint 01 only.

---

# REQUIRED FINAL RESPONSE

Return:

## 1. Branch and commit

Full SHA pushed to:

```text
audit/production-verification-2026-09-04
```

Confirm local and remote SHA match.

## 2. Actual GitHub Actions run

Provide the run ID.

## 3. Gate results

Report:

```text
Install:
Constitution:
Lint:
Typecheck:
Tests:
Security tests:
PostgreSQL migrations:
Migration repeat deployment:
Production build:
Docker Compose:
Dependency audit:
```

Use only actual remote execution evidence.

## 4. Exact test totals

```text
Executed:
Passed:
Failed:
Skipped:
```

Also state how many security tests actually executed remotely.

## 5. Test-harness defects fixed

Explicitly address:

- missing `dist/env.js`
- ESM `require()` problem
- fake SMTP assertion
- nonexistent `@xlrrank/storage` CI reference
- skipped security suite
- skipped build
- skipped Compose validation

## 6. Remaining actual product/security blockers

These may proceed to Sprint 02.

Do NOT include resolved CI/test-harness defects.

## 7. Production readiness

Must remain:

```text
PRODUCTION READY: NO
```

because Sprint 01 verifies the gate, not the entire XLRrank product.

## 8. Stop point

End with exactly:

```text
SPRINT 01 REMOTE VERIFICATION COMPLETE: YES/NO
VERIFICATION HARNESS TRUSTWORTHY: YES/NO
READY FOR SPRINT 02: YES/NO
```

Only say YES when GitHub evidence supports it.

---

# FINAL RULE

Do not tell us what CI is configured to do.

Tell us what CI actually did.