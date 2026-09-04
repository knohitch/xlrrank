# XLRRANK — AUDIT REPAIR SPRINT 01  
## Establish a Trustworthy Verification Gate Before Further Feature Work

Repository:

`https://github.com/knohitch/xlrrank`

Base/source branch:

`master`

Existing audit branch:

`audit/production-verification-2026-09-04`

Existing draft PR:

`audit: independent production verification and hardening`

---

# YOUR ROLE

Act as a senior production engineer, application security engineer, QA architect, and release engineer.

You are **continuing an existing independent production audit** of XLRrank.

Do NOT restart the project.

Do NOT regenerate the architecture.

Do NOT rewrite the application from scratch.

Do NOT create a new parallel implementation.

Do NOT assume that `BUILD-PROGRESS.md` accurately reflects the state of the application.

The repository contents and executable behavior are the source of truth.

Your immediate objective is:

> **Make the XLRrank verification pipeline trustworthy enough that future implementation work cannot be falsely marked complete.**

This sprint is primarily about CI, tests, migrations, builds, deployment verification, and evidence.

It is NOT yet the sprint for completing every missing social connector, intelligence engine, AI provider UI, extension feature, or production integration.

---

# IMPORTANT EXISTING CONTEXT

An independent audit has already found that the codebase contains substantial architecture and implementation, but several areas previously marked as complete were only structurally implemented or were not proven end to end.

Do not discard existing work.

Several security and integrity fixes have already been made on:

`audit/production-verification-2026-09-04`

Preserve them unless a test proves they are incorrect.

These include work around:

- production secret validation
- AES-256-GCM encryption for stored credentials/secrets
- session revocation ownership
- support internal-message filtering
- atomic email-token consumption
- fail-closed social connectors
- platform connection behavior
- CSRF-aware web API client
- configurable server-side API proxy
- removal of fake dashboard success states
- admin API/frontend contract corrections
- worker fail-closed behavior
- PostgreSQL migration integration testing
- audit CI
- Dockerfile corrections

Do not revert these merely to make tests pass.

---

# CURRENT VERIFIED BASELINE

The latest independent GitHub Actions run successfully completed:

- clean frozen pnpm install
- lockfile integrity verification
- constitution guard
- lint
- TypeScript typecheck

The run then failed during the test stage.

The first confirmed failure is currently caused by test invocation such as:

```bash
node --test test/
```

Under the CI Node version, this is being interpreted as a module path and results in errors such as:

```text
Cannot find module '.../packages/database/test'
```

This means:

> The current CI failure is at least partly a broken test-discovery command.

Do NOT treat this as evidence that all underlying application tests are failing.

Fix the test runner correctly and then discover the real failures.

---

# NON-NEGOTIABLE ENGINEERING PRINCIPLES

XLRrank must retain these architectural rules.

## 1. No fake success

Never:

- return `{ success: true }` without real work
- return empty arrays to simulate an implemented provider
- return zero metrics because implementation is missing
- mark connectors connected without provider verification
- acknowledge jobs as processed when their processors are missing
- display fake health states
- fabricate AI/model/provider availability
- silently fall back to mock/demo data
- fake social API responses
- fake migration verification
- fake test results

If functionality is not implemented, it must fail explicitly or report:

- unavailable
- unsupported
- configuration required
- integration required
- not implemented

as appropriate.

---

## 2. No weakening the gate to make CI green

Do NOT:

- delete failing tests merely because they fail
- skip legitimate tests
- add `|| true`
- convert errors into warnings merely to pass CI
- disable TypeScript strictness
- disable ESLint rules to hide defects
- weaken security controls
- bypass migration checks
- disable database assertions
- remove production build steps
- mock production integrations merely to produce green checks

Fix root causes.

---

## 3. Configuration over hardcoding

Do not introduce hardcoded:

- domains
- SaaS URLs
- API origins
- provider credentials
- social provider credentials
- AI models
- AI model versions
- scoring weights
- entitlements
- deployment assumptions
- environment-specific infrastructure

Use configuration, persisted definitions, adapters, registries, or environment variables as appropriate.

---

## 4. Preserve provider/platform abstraction

The application is intended to remain provider-agnostic and potentially open-source.

Do not tightly couple core logic to:

- OpenAI
- Anthropic
- DeepSeek
- Grok/xAI
- MiMo
- X
- Instagram
- Facebook
- LinkedIn
- Reddit
- any particular cloud or hosting provider

Provider-specific behavior belongs inside adapters.

---

# PRIMARY TASK

Complete **Audit Repair Sprint 01**.

The sprint is complete only when the verification pipeline itself is trustworthy and its remaining failures represent actual product defects rather than broken audit instrumentation.

---

# TASK 1 — INSPECT THE EXISTING AUDIT BRANCH

Checkout:

`audit/production-verification-2026-09-04`

Inspect all changes already made.

Do not start from `master` and lose audit fixes.

Review:

- root `package.json`
- workspace package manifests
- `turbo.json`
- `.github/workflows/audit-baseline.yml`
- all package test scripts
- migration scripts
- Dockerfiles
- docker-compose configuration
- TypeScript build graph
- generated files accidentally committed to source control

Document the actual workspace count.

Do not rely on historical documentation for this.

---

# TASK 2 — FIX NODE TEST DISCOVERY PROPERLY

Find every package using commands similar to:

```bash
node --test test/
```

Replace ambiguous directory execution with an explicit, cross-platform test discovery strategy compatible with the project's supported Node version.

Examples may include explicit globs or other appropriate Node test-runner syntax.

Choose one consistent method.

Requirements:

- works in GitHub Actions
- works on Linux
- works locally
- does not depend on shell behavior that differs between operating systems
- does not silently ignore nested test files
- does not accidentally execute non-test files
- retains `.mjs`, `.js`, or TypeScript test handling as appropriate

Do not modify assertions simply because the runner was previously broken.

---

# TASK 3 — RUN THE REAL TEST SUITE

After correcting discovery:

Run the complete test suite.

Record:

- packages with tests
- packages without tests
- total test files
- total tests
- passes
- failures
- skips

For each failure, classify it as one of:

### A. Test infrastructure defect

Examples:

- invalid path
- bad fixture
- wrong environment setup
- missing dependency
- incompatible Node invocation

Fix it during this sprint.

### B. Actual product defect

Do not hide it.

Fix it only if the correction is small, unambiguous, and within this verification sprint.

Otherwise record it in `AUDIT-REPORT.md` as a production blocker for a future repair sprint.

### C. Missing test coverage

Do not claim the associated subsystem is verified.

Record it explicitly.

---

# TASK 4 — DATABASE MIGRATION VERIFICATION

The existing static migration tests are not sufficient by themselves.

The audit already introduced PostgreSQL-backed migration verification.

Make sure it actually runs against:

- PostgreSQL 16
- pgvector
- dedicated database named `xlrrank_audit`

The integration test must:

1. confirm it is connected to the expected audit database
2. refuse destructive reset against any other database
3. reset only the audit database schema
4. execute actual migration SQL
5. verify key tables exist
6. verify pgvector is available
7. verify representative foreign keys
8. verify representative unique constraints/indexes
9. verify migrations can be re-run according to the repository's intended migration mechanism without corrupting state
10. fail clearly when schema verification fails

Do not test migrations only by reading SQL files and looking for strings.

---

# TASK 5 — VERIFY DATABASE MIGRATION IDEMPOTENCE CORRECTLY

Review what “idempotence” means for the migration framework actually being used.

Do not simply execute raw CREATE statements twice if the framework normally records migration state.

Test the intended production migration mechanism.

Verify:

- first deployment migration
- second deployment with no new migrations
- no destructive reapplication
- migration bookkeeping is correct

If current migration tooling cannot safely do this, record it as a production blocker rather than faking the test.

---

# TASK 6 — PRODUCTION BUILD

Once tests complete far enough to permit it, execute:

```bash
pnpm build
```

for the complete workspace.

Verify actual production builds for:

- API
- web
- worker
- browser extension
- shared packages required by them

Do not rely solely on TypeScript typechecking.

Build-time failures must be recorded separately from typecheck failures.

---

# TASK 7 — VERIFY THE DOCKER BUILD PATH

Inspect:

`infra/Dockerfile`

and deployment-related Docker configuration.

Confirm the Dockerfile references only real workspace packages.

Then actually attempt the relevant Docker builds, where feasible, rather than merely parsing Compose configuration.

At minimum verify:

- API image
- web image
- worker image

Important:

If `--ignore-scripts` prevents a required native dependency such as password hashing or another native package from functioning, fix the Docker strategy rather than ignoring the problem.

Do not sacrifice dependency security.

---

# TASK 8 — DOCKER COMPOSE VALIDATION

Verify:

```bash
docker compose config
```

Then determine whether the Compose topology is coherent for:

- API
- web
- worker
- PostgreSQL
- pgvector
- Redis

Check:

- service DNS names
- API internal URL
- browser/public URL separation
- port exposure
- required secrets
- health checks
- service dependencies
- persistent storage
- production vs development assumptions

Do not hardcode a future XLRrank production domain.

---

# TASK 9 — PRODUCTION ENVIRONMENT VALIDATION

Confirm production startup fails safely when critical secrets are missing.

At minimum verify:

- `SESSION_SIGNING_SECRET`
- `ENCRYPTION_MASTER_KEY`

and any other security-critical production keys currently required by runtime.

Verify minimum lengths where appropriate.

Also verify SMTP validation:

If:

```text
EMAIL_TRANSPORT=smtp
```

then required SMTP values must be validated.

Do not require unrelated provider credentials when that provider is disabled.

---

# TASK 10 — SECURITY TESTS FOR AUDIT FIXES

Ensure tests exist for the high-risk audit corrections already made.

At minimum test:

## Encryption

- encryption/decryption roundtrip
- different ciphertext for same plaintext due to nonce/IV
- tampering rejection
- wrong-key rejection if practical
- legacy Base64 format not silently accepted as secure encryption

## Session ownership

A user must not be able to revoke another user's session merely by knowing its ID.

## Email token consumption

Concurrent or repeated token redemption must not allow successful reuse.

## Support internal messages

A normal user must never receive support messages marked internal.

## Social connector fail-closed behavior

An unimplemented connector must not report successful authentication or fake production data.

## Worker fail-closed behavior

An unimplemented processor must fail/reject the job rather than marking it processed.

Add tests at the appropriate layer.

---

# TASK 11 — CHECK WEB/API CONTRACTS THAT BLOCK BASIC AUTHENTICATED USE

This sprint is not a general frontend rebuild.

However, fix obvious contract failures that prevent basic authenticated use.

Verify:

## App layout

Use the correct endpoint and response shape for the current user.

## Settings

Confirm the actual backend endpoint.

Do not call nonexistent:

```text
PATCH /auth/me
```

if the implemented route is:

```text
PATCH /users/me
```

Make GET/PATCH response typing match the backend contract.

## Dashboard

If display name/profile information is required, use the user profile endpoint rather than assuming fields exist on session-auth context.

## Admin

Verify:

- admin auth response shape
- role handling
- admin dashboard endpoint
- paginated users response

Do not redesign the UI.

Fix contract correctness only.

---

# TASK 12 — REMOVE TRACKED GENERATED BUILD ARTIFACTS

Inspect Git tracking for generated files.

Specifically investigate:

```text
apps/web/tsconfig.tsbuildinfo
```

Generated TypeScript build metadata should not normally be tracked.

If appropriate:

- remove it from Git
- add `*.tsbuildinfo` to `.gitignore`

Also inspect for other accidentally tracked:

- `.next`
- `dist`
- coverage output
- local storage
- logs
- caches
- temporary build files

Do not delete legitimate source files.

---

# TASK 13 — SECRET SCAN

Perform a repository scan for likely committed secrets including:

- API keys
- bearer tokens
- OAuth secrets
- private keys
- database passwords
- SMTP credentials
- cloud credentials
- hardcoded production passwords

Differentiate between:

- actual secret
- test fixture
- documented placeholder
- demo credential

Do not expose secret values in the report.

If an actual credential is discovered:

1. remove it from code
2. replace with configuration
3. document that rotation is required

Do not claim a committed secret is safe merely because the repository is private.

---

# TASK 14 — DEPENDENCY SECURITY

Run the project's package-manager audit appropriate for production dependencies.

Record:

- critical
- high
- moderate
- low

Do not blindly upgrade major framework versions merely to silence audit output.

For each significant vulnerability determine:

- runtime exposure
- dev-only exposure
- transitive dependency
- available safe upgrade

Fix straightforward safe updates.

Record larger upgrades separately.

---

# TASK 15 — CI WORKFLOW QUALITY

Review:

`.github/workflows/audit-baseline.yml`

The verification workflow should be ordered so that useful independent gates are not unnecessarily hidden.

Prefer clear stages such as:

```text
install
constitution
lint
typecheck
tests
migrations
build
docker validation/build
security audit
```

Where practical, structure CI so one failure does not prevent us from learning about completely independent later gates.

However:

Do not allow downstream deployment-ready status when required gates fail.

The final workflow must make it easy to determine exactly which gate failed.

---

# TASK 16 — DO NOT COMPLETE PRODUCT INTEGRATIONS IN THIS SPRINT

This is important.

Do NOT spend this sprint implementing:

- X OAuth
- Instagram Graph API
- Facebook Graph API
- LinkedIn API
- Reddit OAuth
- AI provider management UI
- AI dynamic model registry persistence
- Social DNA expansion
- vector search
- opportunity engine completion
- relationship graph UI
- full browser extension auth
- billing integrations

unless a tiny correction is required specifically to make verification trustworthy.

Those belong in subsequent repair sprints.

Instead, accurately classify them.

---

# TASK 17 — CREATE `AUDIT-REPORT.md`

Create:

```text
AUDIT-REPORT.md
```

This document must be evidence-based.

It must include:

# 1. Executive status

One of:

- PRODUCTION READY
- NOT PRODUCTION READY
- PRODUCTION READY WITH DOCUMENTED LIMITATIONS

Do not choose PRODUCTION READY unless every required launch-critical system is actually verified.

---

# 2. Verification environment

Record:

- Node version
- pnpm version
- PostgreSQL version
- pgvector
- Redis
- OS/CI environment
- tested branch
- commit SHA

---

# 3. Gate results

Use a table:

| Gate | Result | Evidence |
|---|---|---|
| Frozen install | PASS/FAIL | ... |
| Constitution guard | PASS/FAIL | ... |
| Lint | PASS/FAIL | ... |
| Typecheck | PASS/FAIL | ... |
| Tests | PASS/FAIL/PARTIAL | ... |
| DB migrations | PASS/FAIL | ... |
| Migration repeat deploy | PASS/FAIL | ... |
| Production build | PASS/FAIL | ... |
| Docker build | PASS/FAIL | ... |
| Compose validation | PASS/FAIL | ... |
| Dependency audit | PASS/FAIL/PARTIAL | ... |

Do not hide warnings.

---

# 4. Product subsystem matrix

Create a detailed matrix with statuses:

- VERIFIED
- PARTIAL
- SCAFFOLD ONLY
- INTERFACE ONLY
- DEFECTIVE
- NOT IMPLEMENTED
- BLOCKED BY EXTERNAL CREDENTIALS
- BLOCKED BY APP REVIEW
- NOT VERIFIED

Include at least:

- authentication
- sessions
- email verification
- password reset
- RBAC
- user portal
- admin portal
- support system
- notifications
- X
- Instagram
- Facebook
- LinkedIn
- Reddit
- ingestion
- workers
- normalized social model
- identity resolution
- Social DNA
- discovery
- relationships
- radar/opportunities
- trends
- content intelligence
- network intelligence
- search
- AI provider framework
- provider credential storage
- model discovery
- capability validation
- model registry persistence
- AI routing
- fallback
- language guard
- AI cost controls
- feature flags
- plans/entitlements
- billing
- reports
- browser extension
- demo isolation
- Docker/deployment
- observability

---

# 5. Confirmed defects

For every confirmed defect include:

- severity
- affected subsystem
- exact behavior
- impact
- remediation state
- test/evidence

Severity:

- CRITICAL
- HIGH
- MEDIUM
- LOW

---

# 6. Missing verification

Explicitly list areas where code exists but no meaningful automated proof exists.

Do not equate compilation with functional verification.

---

# 7. External integration blockers

Where credentials/app review/access are required, classify accurately.

Example:

```text
X connector:
INTERFACE ONLY / NOT PRODUCTION VERIFIED
Reason: no test credentials available and live provider workflow not implemented.
```

Do not fake provider verification.

---

# 8. Recommended repair sprint order

Generate the next engineering sequence based on dependencies.

Expected general order:

1. foundation/security
2. auth/user/admin/support
3. persistence/data ownership
4. social connector framework
5. first live social connector
6. ingestion/workers
7. normalized graph/identity
8. AI provider runtime
9. dynamic model discovery
10. routing/fallback/language enforcement
11. intelligence engines
12. search
13. notifications/reports
14. extension
15. billing/entitlements
16. demo isolation
17. full E2E
18. deployment hardening

Adjust according to actual evidence.

---

# TASK 18 — CORRECT `BUILD-PROGRESS.md`

Do not delete useful historical information.

But update the document so it no longer treats source-file existence as production completion.

Add an audit status layer.

For each major system distinguish:

```text
IMPLEMENTED
VERIFIED
PRODUCTION READY
```

These are not equivalent.

Example:

```text
Implementation: PARTIAL
Verification: NOT VERIFIED
Production readiness: NO
```

Any previous DONE status that cannot be substantiated must be corrected.

Do not rewrite history deceptively.

Clearly state that a previous prompt may have been executed structurally while remaining incomplete operationally.

---

# ACCEPTANCE CRITERIA FOR THIS SPRINT

Do NOT declare Sprint 01 complete until all of the following are true:

- [ ] audit branch is preserved
- [ ] broken Node test discovery is corrected
- [ ] real tests execute
- [ ] actual test failures are distinguished from harness failures
- [ ] PostgreSQL migration integration test executes
- [ ] pgvector is verified
- [ ] migration repeat-deploy behavior is tested
- [ ] production workspace build executes
- [ ] Docker/Compose path is meaningfully verified
- [ ] production secret validation is tested
- [ ] encryption tests pass
- [ ] session ownership test exists
- [ ] support internal-note isolation test exists
- [ ] email-token one-time-use test exists
- [ ] social connector fail-closed behavior is tested
- [ ] worker fail-closed behavior is tested
- [ ] basic web/API contract mismatches are corrected
- [ ] generated TypeScript build metadata is no longer tracked if inappropriate
- [ ] repository secret scan is completed
- [ ] dependency audit is completed
- [ ] `AUDIT-REPORT.md` exists
- [ ] `BUILD-PROGRESS.md` reflects verified reality
- [ ] unresolved product gaps remain explicitly unresolved
- [ ] no fake success path was introduced

---

# COMMIT DISCIPLINE

Make small, reviewable commits grouped by concern.

Examples:

```text
test: fix cross-platform node test discovery

test: verify database migrations against postgres

test: cover security-sensitive audit fixes

fix: align authenticated web routes with API contracts

chore: remove tracked generated build metadata

ci: strengthen production verification gates

docs: add evidence-based production audit report
```

Do not produce one enormous undocumented commit.

---

# DO NOT MERGE TO MASTER YET

Keep the audit PR in draft state.

Do NOT merge the audit branch into `master` merely because Sprint 01 gates pass.

Passing Sprint 01 means:

> **The verification machinery is trustworthy enough to begin systematic production repair.**

It does NOT mean XLRrank as a whole is production ready.

---

# FINAL RESPONSE REQUIRED FROM YOU

When finished, respond with:

## 1. Branch

Exact branch and final commit SHA.

## 2. Verification results

Exact results for:

- install
- constitution
- lint
- typecheck
- tests
- migrations
- build
- Docker
- dependency audit

## 3. Test totals

Tests passed / failed / skipped.

## 4. Files changed

Grouped by purpose.

## 5. Defects fixed

Only defects actually corrected.

## 6. Remaining blockers

Do not minimize them.

## 7. Production readiness

Explicitly state:

```text
PRODUCTION READY: YES/NO
```

and explain why.

## 8. Next recommended sprint

Name the exact next subsystem to repair.

---

# MOST IMPORTANT RULE

Do not optimize for:

> “green CI”

Optimize for:

> **“green CI that actually proves something.”**

A red test exposing a real production defect is more valuable than a green test that verifies nothing.

Do not mark a requirement DONE because a class, route, interface, table, page, or function exists.

For XLRrank, DONE now means:

> implementation + execution + persistence where applicable + error handling + security + automated proof + honest status.