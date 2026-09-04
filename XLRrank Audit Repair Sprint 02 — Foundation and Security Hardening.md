# XLRRANK — AUDIT REPAIR SPRINT 02
## Foundation & Security Hardening

Repository:

`https://github.com/knohitch/xlrrank`

Working branch:

`audit/production-verification-2026-09-04`

Verified starting commit:

`aed86486deaea6b989f06d2dc1803a94fafd9aed`

Existing draft PR:

`audit: independent production verification and hardening`

---

# ROLE

Act as a senior application security engineer, TypeScript/NestJS engineer, database engineer, dependency-maintenance engineer, and production release engineer.

Sprint 01 has established a trustworthy remote verification harness.

You are now beginning the first **actual production repair sprint**.

Do NOT restart the project.

Do NOT create a replacement architecture.

Do NOT create another branch unless technically necessary.

Do NOT merge into `master`.

Continue working on:

```text
audit/production-verification-2026-09-04
```

---

# VERIFIED SPRINT 01 BASELINE

GitHub Actions run:

```text
33901573258
```

verified:

```text
Frozen install:             PASS
Constitution guard:         PASS
Lint:                       PASS
Typecheck:                  PASS
Workspace tests:            PASS
Security tests:             PASS
PostgreSQL migrations:      PASS
Migration repeat deploy:    PASS
Production build:           PASS
Docker Compose validation:  PASS
```

The verification harness is now trusted.

Do not weaken it.

---

# CURRENT SECURITY AUDIT BASELINE

The latest remote:

```bash
pnpm audit --prod
```

reports:

```text
17 vulnerabilities
7 HIGH
9 MODERATE
1 LOW
```

The command exits non-zero.

The GitHub Actions dependency-audit job appears green only because the audit is intentionally non-blocking.

Do NOT describe the dependency state as secure or passing.

---

# VERIFIED VULNERABILITY FAMILIES

The current production dependency tree includes the following known issues.

## Drizzle ORM

```text
Package: drizzle-orm
Severity: HIGH
Vulnerable: <0.45.2
Patched: >=0.45.2
Advisory: GHSA-gpj5-g38j-94v9
Issue: improperly escaped SQL identifiers / SQL injection
Paths:
apps/api > drizzle-orm
packages/database > drizzle-orm
```

---

## Multer

Multiple DoS advisories exist in the installed dependency path.

Current affected path includes:

```text
apps/api
→ @nestjs/core
→ @nestjs/platform-express
→ multer
```

and:

```text
apps/api
→ @nestjs/platform-express
→ multer
```

The current advisories require, collectively, a Multer version that resolves to at least:

```text
multer >=2.2.0
```

Do not fix only one advisory and leave the others unresolved.

---

## NestJS Core

```text
Package: @nestjs/core
Severity: MODERATE
Vulnerable: <=11.1.17
Patched: >=11.1.18
Advisory: GHSA-36xv-jgw5-4q75
```

---

## PostCSS

The web dependency path contains multiple PostCSS vulnerabilities through:

```text
apps/web
→ next
→ postcss
```

The newest currently relevant advisory requires:

```text
postcss >=8.5.23
```

Do not patch only an older advisory threshold such as `8.5.12` or `8.5.18` while leaving the newer advisory unresolved.

---

## file-type

Current NestJS dependency paths include vulnerable `file-type`.

To clear the currently reported advisories, the resolved dependency must satisfy at least:

```text
file-type >=21.3.2
```

---

## qs

Current API dependency paths include vulnerable `qs` through Express/body-parser.

The current advisory set requires at least:

```text
qs >=6.16.0
```

---

## body-parser

Current API dependency paths include:

```text
body-parser <1.20.6
```

Patched requirement:

```text
body-parser >=1.20.6
```

---

# PRIMARY SPRINT GOAL

The primary security objective is:

> Eliminate all known CRITICAL and HIGH production dependency vulnerabilities, and remove every MODERATE/LOW vulnerability that can be safely remediated without breaking the supported architecture.

The target is:

```text
0 critical
0 high
0 moderate
0 low
```

If achieving zero across all severities is genuinely impossible because of an upstream dependency with no compatible patched release, document the exact unresolved dependency path and evidence.

Do NOT accept a vulnerability merely because it is transitive.

Do NOT blindly force incompatible versions merely to obtain a zero count.

---

# TASK 1 — SNAPSHOT THE ACTUAL DEPENDENCY GRAPH

Before modifying dependencies, run:

```bash
pnpm audit --prod
```

and inspect:

```bash
pnpm why drizzle-orm
pnpm why @nestjs/core
pnpm why @nestjs/common
pnpm why @nestjs/platform-express
pnpm why multer
pnpm why postcss
pnpm why file-type
pnpm why qs
pnpm why body-parser
```

Record:

- currently resolved version
- direct vs transitive
- every workspace introducing it
- parent dependency
- safe upgrade path

Do not assume the package.json range equals the installed lockfile version.

The lockfile is the source of truth for resolved versions.

---

# TASK 2 — REMEDIATE DRIZZLE ORM SAFELY

Upgrade every production use of `drizzle-orm` to a patched compatible version satisfying:

```text
>=0.45.2
```

Check:

- `apps/api`
- `packages/database`
- any additional workspaces
- `drizzle-kit` compatibility if used
- generated migrations
- schema imports
- query builders
- SQL helpers
- vector operations

Do not leave different incompatible Drizzle versions across workspace packages.

Do NOT regenerate the database schema merely because Drizzle was upgraded.

Do NOT generate destructive migrations unless the schema actually changed.

After upgrading, run:

```text
typecheck
database build
API build
tests
real PostgreSQL migrations
repeat deployment migration verification
```

Existing migrations must continue to work.

---

# TASK 3 — ADD A DRIZZLE SECURITY REGRESSION TEST

The vulnerability concerns SQL identifier escaping.

Where reasonably possible, add a regression test demonstrating that attacker-controlled identifier-like input cannot escape into executable SQL.

Do not write a meaningless:

```js
assert.ok(true)
```

test.

Do not reimplement Drizzle internally merely to test it.

Use the public API actually exercised by XLRrank.

If XLRrank never permits user-controlled identifiers, explicitly document that fact, but still upgrade the vulnerable package because vulnerable code remains part of the production dependency graph.

---

# TASK 4 — UPGRADE THE NESTJS STACK COHERENTLY

Inspect all NestJS package versions.

Do not independently upgrade only one NestJS package if the framework expects aligned versions.

At minimum evaluate:

```text
@nestjs/common
@nestjs/core
@nestjs/platform-express
```

Use mutually compatible patched releases.

The resolved `@nestjs/core` must satisfy:

```text
>=11.1.18
```

After upgrade verify:

- Nest application bootstrapping
- dependency injection
- controllers
- guards
- interceptors
- exception filters
- body parsing
- platform-express integration
- authentication
- CSRF behavior

Do not perform an unnecessary major framework migration if a compatible patched release in the current major line exists.

---

# TASK 5 — CLEAR ALL MULTER ADVISORIES

The final resolved production Multer version must satisfy all currently reported advisories.

Current target:

```text
multer >=2.2.0
```

Prefer obtaining the patched version naturally through the supported NestJS/platform-express dependency graph.

Use package-manager overrides only when:

1. the parent dependency permits the patched version semantically,
2. framework compatibility is demonstrated,
3. tests/build pass,
4. the reason is documented.

Do not use an override merely to trick `pnpm audit`.

After remediation run:

```bash
pnpm why multer
```

and prove the vulnerable version no longer exists anywhere in the production graph.

---

# TASK 6 — REVIEW FILE UPLOAD SURFACE

Search the API for actual use of:

- Multer
- FileInterceptor
- FilesInterceptor
- AnyFilesInterceptor
- multipart/form-data
- file uploads

If XLRrank currently exposes file-upload endpoints, verify explicit configurable limits for:

- maximum individual file size
- maximum number of files
- maximum field count
- maximum field-name size
- maximum field-value size
- multipart parts

Also verify:

- unsupported MIME types are rejected where applicable
- filenames are not trusted as filesystem paths
- uploads cannot escape configured storage boundaries

Do not invent file-upload functionality if the product currently has none.

If no upload endpoints exist, document:

```text
Multer is currently transitive only; no application upload surface found.
```

but still remediate the vulnerable dependency.

---

# TASK 7 — REMEDIATE `file-type`

Ensure the production dependency graph resolves the affected package to a non-vulnerable version satisfying the currently reported advisory set:

```text
file-type >=21.3.2
```

Prefer framework-supported upgrades.

Do not force an incompatible ESM/package version into NestJS unless compatibility is proven.

Run:

```bash
pnpm why file-type
```

after remediation and record the complete path.

---

# TASK 8 — REMEDIATE `qs`

Ensure vulnerable `qs` versions disappear from the API production graph.

Current required threshold:

```text
qs >=6.16.0
```

Inspect all paths via:

```bash
pnpm why qs
```

Because `qs` may arrive through:

- Express
- body-parser
- NestJS platform-express

prefer upgrading the owning packages rather than adding arbitrary direct dependencies.

---

# TASK 9 — REMEDIATE `body-parser`

Ensure all production paths satisfy:

```text
body-parser >=1.20.6
```

Verify via:

```bash
pnpm why body-parser
```

Do not assume upgrading Express or NestJS automatically fixes this; verify the resolved lockfile.

---

# TASK 10 — REMEDIATE POSTCSS THROUGH A SUPPORTED WEB STACK

The current production build uses Next.js.

Do not blindly install a second unrelated PostCSS version.

Inspect:

```bash
pnpm why postcss
pnpm why next
```

Use the safest supported route to ensure the production dependency graph satisfies the newest current patched PostCSS requirement:

```text
postcss >=8.5.23
```

This may require an appropriate Next.js patch upgrade or supported dependency resolution.

After modification:

- build the web application
- render all production routes
- run lint
- run typecheck
- ensure Next configuration still works

Do not downgrade Next.js to escape the advisory.

---

# TASK 11 — REVIEW REQUEST BODY LIMITS

Independently of package upgrades, review the API's request parsing configuration.

Verify that production HTTP request bodies are bounded.

Review:

- JSON request size
- URL-encoded body size
- parameter counts
- multipart limits if applicable

Do not hardcode arbitrary product policy values deep inside bootstrap logic.

If limits are business/deployment policy, make them configuration-driven with secure defaults.

For example, configuration concepts may include:

```text
HTTP_JSON_BODY_LIMIT
HTTP_URLENCODED_BODY_LIMIT
HTTP_PARAMETER_LIMIT
UPLOAD_MAX_FILE_SIZE
UPLOAD_MAX_FILES
```

Only add settings relevant to actual application behavior.

Validate them in configuration schema.

Add real tests.

---

# TASK 12 — SECURITY HEADERS / API FOUNDATION REVIEW

Review current production HTTP security configuration for:

- Helmet or equivalent response headers
- CORS
- CSRF
- cookie security
- trust proxy handling
- HSTS behavior behind reverse proxy
- request size boundaries
- error information leakage

Do not add duplicated middleware blindly.

If a protection already exists, verify it instead of replacing it.

Production cookie requirements must include, where applicable:

```text
HttpOnly
Secure
appropriate SameSite policy
```

Do not break the web/API proxy authentication flow.

---

# TASK 13 — VERIFY THE AUTH SECURITY FIXES SURVIVE DEPENDENCY UPGRADES

Existing security behavior must remain intact.

At minimum verify:

- Argon2id password hashing
- session signature verification
- session ownership on revocation
- CSRF enforcement
- email token one-time consumption
- account status enforcement
- internal support messages hidden from normal users
- AES-256-GCM secret encryption
- tamper rejection
- provider credentials never returned in plaintext

Do not rewrite these systems unless a concrete defect is found.

---

# TASK 14 — MAKE HIGH/CRITICAL DEPENDENCY AUDIT BLOCKING

Sprint 01 intentionally used a non-blocking dependency audit so the audit harness could complete while known vulnerabilities were documented.

Sprint 02 should graduate this.

Once HIGH/CRITICAL vulnerabilities are remediated, introduce a blocking security gate equivalent to:

```bash
pnpm audit --prod --audit-level=high
```

or another deterministic package-manager-native mechanism.

Requirements:

```text
CRITICAL vulnerability → CI FAIL
HIGH vulnerability → CI FAIL
```

A separate complete audit may still report moderate/low advisories.

Do not conceal them.

If Sprint 02 reaches zero vulnerabilities across all severities, the full audit can become blocking.

---

# TASK 15 — PRESERVE FULL AUDIT VISIBILITY

CI should report both:

### Release-blocking security result

At least:

```text
critical/high
```

### Full advisory inventory

```text
critical/high/moderate/low
```

Do not create a green “Dependency Audit” label that hides a nonzero audit command.

Name jobs or steps so their meaning is clear.

---

# TASK 16 — ACTUALLY BUILD THE CONTAINER IMAGES

Sprint 01 verified:

```bash
docker compose config
```

Sprint 02 should also verify that production images can actually be built.

Inspect:

```text
infra/Dockerfile
docker-compose.yml
```

Build the actual deployable services where applicable:

```text
API
web
worker
```

Do not only parse Compose.

Pay particular attention to:

- native Argon2 dependencies
- install scripts
- workspace pruning/copying
- production dependencies
- Next.js build output
- worker runtime entrypoint
- non-root execution if configured
- secrets not baked into images

Do not put CI secrets into Docker image layers.

---

# TASK 17 — ADD DOCKER BUILD VERIFICATION TO CI

Where runtime permits, add a GitHub Actions verification job that builds the real images.

This should prove more than:

```text
docker compose config
```

It should catch:

- nonexistent packages
- broken COPY paths
- missing native modules
- bad build stages
- incorrect runtime commands
- missing workspace artifacts

Do not deploy the images.

No registry push is required in this sprint unless the existing deployment architecture already requires one for validation.

---

# TASK 18 — SECRET AND LOGGING REVIEW

Repeat repository scanning for:

- API keys
- OAuth secrets
- private keys
- bearer tokens
- database passwords
- SMTP credentials
- cloud credentials
- copied `.env` files

Also inspect logging paths for accidental exposure of:

- API keys
- authorization headers
- session tokens
- refresh tokens
- provider credentials
- email-token raw values

Existing `redactSensitive` behavior should be tested against realistic nested objects and headers if it is used for production logs.

Do not print discovered credentials into CI or documentation.

---

# TASK 19 — DO NOT WORK ON PRODUCT ENGINES YET

Do NOT implement during Sprint 02:

- X connector
- Instagram connector
- Facebook connector
- LinkedIn connector
- Reddit connector
- ingestion processors
- intelligence engines
- Social DNA
- discovery engine
- relationship engine
- opportunity/radar engine
- dynamic AI model discovery
- AI provider UI
- vector search
- browser-extension production integration
- billing
- demo architecture

Those begin after the production foundation is secure.

---

# TASK 20 — RUN THE FULL VERIFICATION MATRIX AFTER CHANGES

After dependency/security remediation, execute:

```text
frozen install
offline lockfile verification
constitution guard
lint
typecheck
workspace tests
security tests
PostgreSQL migrations
repeat migration deploy
production build
Docker Compose validation
actual Docker image build
dependency audit
```

All existing green Sprint 01 gates must remain green.

---

# SPRINT 02 SECURITY ACCEPTANCE CRITERIA

Do NOT declare Sprint 02 complete until:

- [ ] `drizzle-orm` vulnerability removed
- [ ] Drizzle resolved version >=0.45.2
- [ ] all HIGH Multer advisories removed
- [ ] resolved Multer satisfies current advisory set
- [ ] NestJS core advisory removed
- [ ] `@nestjs/core` resolved >=11.1.18
- [ ] PostCSS high advisories removed
- [ ] current PostCSS dependency path verified
- [ ] `file-type` advisories remediated where compatible
- [ ] `qs` advisories remediated
- [ ] `body-parser` advisory remediated
- [ ] 0 CRITICAL production vulnerabilities
- [ ] 0 HIGH production vulnerabilities
- [ ] every remaining MODERATE/LOW advisory explicitly analyzed
- [ ] request body limits reviewed
- [ ] multipart limits verified if uploads exist
- [ ] security headers/CORS/CSRF/cookies reviewed
- [ ] existing auth security tests still pass
- [ ] migration integration still passes
- [ ] production build still passes
- [ ] actual Docker images build successfully
- [ ] CI blocks future HIGH/CRITICAL dependency regressions
- [ ] no secrets added
- [ ] `AUDIT-REPORT.md` updated
- [ ] `BUILD-PROGRESS.md` verification layer updated
- [ ] branch pushed to GitHub
- [ ] remote GitHub Actions evidence collected

---

# IMPORTANT DEPENDENCY RULE

Do NOT solve dependency advisories by indiscriminately adding:

```text
pnpm.overrides
```

for every vulnerable transitive package.

Use this priority:

```text
1. supported parent/framework patch upgrade
2. supported direct dependency upgrade
3. compatible lockfile refresh
4. carefully justified override only when necessary
```

Any override must be documented with:

- why the owning dependency did not resolve safely
- why the override is semver/runtime compatible
- tests proving compatibility
- removal condition

---

# IMPORTANT DATABASE RULE

Updating Drizzle does NOT grant permission to rewrite or regenerate the schema.

Existing database migrations are production history.

Preserve them unless an actual schema change is required.

No destructive migration is permitted merely because tooling changed.

---

# COMMIT DISCIPLINE

Prefer focused commits, for example:

```text
security: upgrade drizzle orm beyond identifier injection advisory

security: update nest express dependency chain

security: remediate web postcss advisories

security: bound production request parsing

ci: block high severity dependency regressions

ci: verify production docker image builds

docs: update sprint 02 security evidence
```

Do not produce one giant opaque commit unless changes are inseparable.

---

# UPDATE `AUDIT-REPORT.md`

Add a Sprint 02 section including:

## Dependency baseline

Before / after table:

| Package | Before | After | Advisory | Status |
|---|---:|---:|---|---|
| drizzle-orm | ... | ... | GHSA-gpj5-g38j-94v9 | ... |
| multer | ... | ... | multiple | ... |
| @nestjs/core | ... | ... | GHSA-36xv-jgw5-4q75 | ... |
| postcss | ... | ... | multiple | ... |
| file-type | ... | ... | multiple | ... |
| qs | ... | ... | multiple | ... |
| body-parser | ... | ... | GHSA-v422-hmwv-36x6 | ... |

Also record:

```text
audit before:
critical:
high:
moderate:
low:

audit after:
critical:
high:
moderate:
low:
```

---

# UPDATE `BUILD-PROGRESS.md`

Do not mark the entire product production-ready.

Update only the relevant foundation/security verification statuses.

Example:

```text
Dependency security:
Implementation: HARDENED
Verification: VERIFIED
Production readiness: PASS for current known advisories

Social connectors:
Implementation: PARTIAL
Verification: NOT VERIFIED
Production readiness: NO
```

---

# DO NOT MERGE TO MASTER

Keep the PR in draft.

Sprint 02 success means:

> The XLRrank production foundation has been materially security-hardened.

It does NOT mean:

> XLRrank is ready to launch.

---

# REQUIRED FINAL RESPONSE

Return:

## 1. Branch

Exact remote branch and full final SHA.

## 2. Dependency versions

Before → after for:

```text
drizzle-orm
@nestjs/common
@nestjs/core
@nestjs/platform-express
multer
postcss
file-type
qs
body-parser
next
```

## 3. Audit result

Exact remote output summary:

```text
critical:
high:
moderate:
low:
```

## 4. Vulnerabilities eliminated

Map each resolved advisory to the dependency upgrade that fixed it.

## 5. Remaining vulnerabilities

For each remaining one provide:

- severity
- package
- dependency path
- exploit relevance
- why it cannot yet be safely eliminated
- remediation plan

Do not write “accepted risk” without evidence.

## 6. Security hardening

Report:

- request body limits
- upload limits if applicable
- CSRF
- CORS
- cookies
- headers
- logging/redaction
- secret handling

## 7. Verification

Actual remote GitHub Actions results for:

```text
Install:
Constitution:
Lint:
Typecheck:
Tests:
Security tests:
PostgreSQL migrations:
Repeat migration:
Production build:
Compose validation:
Docker image build:
High/critical dependency gate:
Full dependency audit:
```

## 8. Test totals

Exact:

```text
executed:
passed:
failed:
skipped:
```

## 9. Docker evidence

Specify exactly which images were successfully built.

## 10. Documentation

Confirm updates to:

```text
AUDIT-REPORT.md
BUILD-PROGRESS.md
```

## 11. Production readiness

Must still state:

```text
PRODUCTION READY: NO
```

unless the entire product — including its social, AI, worker, intelligence, extension, and deployment journeys — has actually been verified.

## 12. Stop point

End with:

```text
SPRINT 02 COMPLETE: YES/NO
FOUNDATION SECURITY GATE: PASS/FAIL
READY FOR SPRINT 03: YES/NO
```

---

# FINAL PRINCIPLE

Sprint 01 proved that XLRrank can be built and tested.

Sprint 02 must prove that its **foundation can be trusted under production security expectations**.

Do not optimize for lower vulnerability counts.

Fix the actual dependency and runtime security problems.