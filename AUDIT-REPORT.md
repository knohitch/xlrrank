# XLRrank Production Audit Report

## 1. Executive Status

**NOT PRODUCTION READY**

Foundation security has been hardened. All known dependency vulnerabilities are resolved. Docker images build successfully. The verification pipeline is trustworthy. Worker/reference-provider social ingestion is implemented for Sprint 05 evidence. Sprint 06 added a production X OAuth/API connector with fixture-backed contract and remote CI gates. Sprint 07 added production Facebook and Instagram connectors with Facebook Login and direct Instagram Login auth modes, asset discovery, asset selection, opaque comment pagination, and HMAC-SHA256 webhooks. Sprint 08 adds a production LinkedIn Marketing API 202608 / Rest.li 2.0.0 connector with OIDC identity, organization ACL discovery, Posts API pagination, Social Actions comments, follower metrics, HMAC-SHA256 webhooks, BullMQ worker ingestion, and cross-scope data retention policies.

Live provider verification remains externally blocked for all third-party social providers (X, Facebook, Instagram, LinkedIn) because no live production credentials were supplied. Remote CI is `BLOCKED_INFRA` due to exhausted workflow run quota. Worker Docker runtime is `BLOCKED_LOCAL_INFRA`. Other third-party social connectors (Reddit), AI providers, intelligence engines, billing, extension production integration, and full deployment remain unverified.

---

## 2. Verification Environment

| Item              | Value                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Node version      | 22 (CI), v26.2.0 (local)                                                  |
| pnpm version      | 11.23.0                                                                   |
| PostgreSQL        | CI: pgvector/pgvector:pg16 with xlrrank_audit DB                          |
| pgvector          | CI: verified via migration integration test                               |
| Redis             | CI: redis:7-alpine; Sprint 03 E2E and Sprint 05 Worker Ingestion E2E      |
| SMTP sink         | Sprint 03 E2E job: axllent/mailpit:v1.21                                  |
| OS                | CI: ubuntu-latest; Local: Windows                                         |
| Branch            | audit/production-verification-2026-09-04                                  |
| Evidence baseline | Latest pre-closure technical CI: 648adb9f74b754f3995e09365751dc62c95f5a4b |

---

## 3. Gate Results

| Gate                          | Result   | Evidence                                                                                             |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Frozen install                | CI PASS  | pnpm install --frozen-lockfile                                                                       |
| Constitution guard            | CI PASS  | pnpm lint:constitution                                                                               |
| Lint                          | CI PASS  | pnpm lint --concurrency=2                                                                            |
| Typecheck                     | CI PASS  | pnpm typecheck --concurrency=2                                                                       |
| Tests                         | CI PASS  | Per-package test execution + security tests                                                          |
| Security tests                | CI PASS  | scripts/security.test.mjs (11 tests, 11 passed, 0 failed)                                            |
| DB migrations                 | CI PASS  | PostgreSQL 16 + pgvector, dedicated xlrrank_audit DB                                                 |
| Migration repeat deploy       | CI PASS  | pnpm db:migrate runs twice                                                                           |
| Production build              | CI PASS  | pnpm build (17/17 packages)                                                                          |
| Docker Compose validation     | VERIFIED | docker compose config --quiet                                                                        |
| API image build               | VERIFIED | API Docker image built successfully                                                                  |
| web image build               | VERIFIED | web Docker image built successfully                                                                  |
| worker image build            | VERIFIED | worker Docker image built successfully                                                               |
| Security Gate (High/Critical) | CI PASS  | pnpm audit --prod --audit-level=high (blocking)                                                      |
| Full Dependency Audit         | CI PASS  | pnpm audit --prod: 0 critical, 0 high, 0 moderate, 0 low                                             |
| Application E2E               | CI PASS  | apps/e2e Playwright suite with PostgreSQL 16 + pgvector, Redis 7, Mailpit, API, web, Chromium        |
| Social Data Isolation         | VERIFIED | Real PostgreSQL gate for scope isolation, connection ownership, idempotency, cursor, legacy backfill |
| Connector Contract            | VERIFIED | Local HTTP fixture connector gate for factory isolation, auth, pagination, error taxonomy            |
| Worker Ingestion E2E          | VERIFIED | Real worker process with PostgreSQL, Redis, BullMQ, local HTTP reference provider, crash/retry tests |
| Worker Docker Runtime         | VERIFIED | Built worker image readiness check against PostgreSQL and Redis                                      |
| X Connector Contract          | VERIFIED | Local HTTP fixture contract gate for X OAuth 2.0 PKCE, API v2, pagination, rate limits, error taxonomy |
| Meta Connector Contract       | VERIFIED | Local HTTP fixture contract gate for Graph v26.0 Facebook & Instagram connectors                      |
| LinkedIn Connector Contract   | VERIFIED | packages/social-core/test/linkedin-connector.test.mjs (20/20 pass, Version 202608, Rest.li 2.0.0)      |
| LinkedIn OAuth & Asset E2E    | VERIFIED | apps/api/test/platforms-oauth.e2e.mjs (6/6 pass with real PostgreSQL, OIDC, org ACLs, webhooks)        |
| LinkedIn Worker Ingestion E2E | VERIFIED | apps/worker/test/worker-ingestion.e2e.mjs (15/15 pass with real PostgreSQL + Redis + real worker)       |
| Data Retention Purge          | VERIFIED | packages/database/src/social/retention.ts and worker E2E cross-scope retention tests                  |


### Dependency Audit Status

| Gate                                     | Result | Evidence                              |
| ---------------------------------------- | ------ | ------------------------------------- |
| High/Critical blocking gate              | PASS   | pnpm audit --prod --audit-level=high  |
| Full production dependency audit         | PASS   | pnpm audit --prod                     |
| Current known production vulnerabilities | 0      | 0 critical, 0 high, 0 moderate, 0 low |

---

## Sprint 08 — LinkedIn Production Connector & Data Retention

Sprint 08 establishes the official, production-grade LinkedIn integration in XLRrank adhering strictly to official Microsoft / LinkedIn documentation crawled and verified on 2026-09-09.

### Architecture & Capabilities

| Area | Implementation |
|---|---|
| Target API & Protocol | LinkedIn Marketing Developer Platform Version `202608`, Rest.li Protocol `2.0.0` (`X-Restli-Protocol-Version`, `Linkedin-Version`) |
| Transport & SSRF Safety | Strict URL host enforcement (`https://api.linkedin.com/rest/`), blocking private IP ranges and unauthorized hosts |
| Authentication | 3-legged member OAuth 2.0 (`/oauth/v2/authorization`, `/oauth/v2/accessToken`), encrypted tokens with AAD binding |
| Identity Resolution | OpenID Connect `/v2/userinfo`; immutable `sub` claim truthfully represented as non-KYC account identifier |
| Asset Discovery | Discovers administered organizations via `/rest/organizationAcls?q=roleAssignee`; stores in `provider_authorization_assets` |
| Asset Selection | User explicitly chooses organization assets; isolated per scope with IDOR checks (`(scope_id, platform_id, verified_external_id)`) |
| Dynamic Capabilities | Role-sensitive capability matrix (`ADMINISTRATOR` vs `ANALYST`); unpermitted features truthfully marked `APP_REVIEW_REQUIRED` / `UNAVAILABLE` |
| Ingestion Pagination | 2-page Posts API pagination (`start`/`count` cursors), Social Actions comments, and follower metrics |
| Webhooks | HMAC-SHA256 challenge-response handshake (`GET`) and notification verification (`POST` with `X-LI-Signature`, `@CsrfExempt()`) |
| Worker Ingestion | Durable webhook receipt outbox, BullMQ worker asset resolution, multi-page post sync, follower statistics snapshot |
| Error Handling | 401 reauth stop, 403 role loss / access control transitions connection to `DEGRADED`, 429 rate limit backoff |
| Data Retention | Migration `0007_linkedin_retention_policies.sql` + `purgeExpiredProviderData`: member 24h, org 56d, metrics 30d, receipts 7d |

### Evidence Matrix

| Gate / Test Suite | Result | Details |
|---|---|---|
| Database Migrations & Retention | PASS | 11 passed, 1 skipped. Migration 0007 clean forward apply, constraint updates, retention purge tests |
| Social-Core Contract Suite | PASS | 20 passed. Version 202608, Rest.li 2.0.0, dynamic capabilities, posts/comments/metrics pagination, HMAC signatures |
| API OAuth & Webhook E2E | PASS | 6 passed. Start OAuth, code exchange, OIDC identity, org discovery, asset selection, IDOR denial, webhook challenge/delivery |
| Worker Ingestion & Retention E2E | PASS | 15 passed. Real PostgreSQL + Redis + BullMQ + child worker. Posts, comments, metrics, webhook dispatch, retention purge |
| Monorepo Build & Types | PASS | 17/17 packages built, 26/26 typecheck tasks passed, 12/12 lint tasks passed (0 errors), 0 prod audit vulnerabilities |
| Live Provider Gate | BLOCKED_EXTERNAL | No live LinkedIn Partner credentials or Community Management API approvals supplied; production ready: NO |

---

## Sprint 07 — Meta Production Connectors (Facebook & Instagram)

Sprint 07 establishes the production Graph API `v26.0` connectors for Facebook and Instagram.

### Architecture & Capabilities

| Area | Implementation |
|---|---|
| Target API | Meta Graph API `v26.0` (`graph.facebook.com` and `graph.instagram.com`) |
| Auth Modes | Facebook Login (`FACEBOOK_LOGIN`) for Pages & Page-linked Instagram accounts; Instagram Login (`INSTAGRAM_LOGIN`) for direct Instagram accounts |
| CSRF & Webhooks | Dedicated `@CsrfExempt()` decorator for `POST /webhook`; challenge-response verification with verify token; HMAC-SHA256 signature verification |
| Asset Discovery & Selection | Facebook Login discovers Pages and linked Instagram accounts; user selects assets; stored in `provider_authorization_assets` |
| Token Lifecycle | Short-lived code exchange, long-lived token exchange (`fb_exchange_token` / Instagram token exchange), token refresh |
| Ingestion & Comments | Page/IG media pagination, opaque cursor comment pagination, profile aggregate metrics |
| Worker Ingestion | Durable webhook receipt outbox, BullMQ worker resolution, real child worker ingestion |

### Evidence Matrix

| Gate / Test Suite | Result | Details |
|---|---|---|
| Meta Contract Suite | PASS | Graph v26.0 targets, Facebook Login & Instagram Login isolation, comment pagination, token refresh |
| API OAuth & Asset E2E | PASS | Shared authorization grant, asset discovery, asset selection, IDOR protection, Instagram Login E2E |
| Worker Ingestion E2E | PASS | Real PostgreSQL + Redis + BullMQ worker ingestion for Facebook Pages, Instagram via Facebook Login, Instagram Login |
| Live Provider Gate | BLOCKED_EXTERNAL | No live Meta app credentials or approved permissions supplied; production ready: NO |

---

## Sprint 06 — X Production Connector

Sprint 06 adds a production X OAuth 2.0 and API v2 connector with fixture-backed contracts and worker pipeline integration.

### Architecture & Capabilities

| Area | Implementation |
|---|---|
| Target API | X API v2 with OAuth 2.0 PKCE (`code_challenge_method=S256`) |
| Credentials & Security | Client secrets encrypted with AES-256-GCM and AAD; PKCE transaction state single-use with TTL |
| Token Lifecycle | Refresh token rotation and worker reauthentication handling |
| Ingestion | Tweets, mentions, user timeline pagination, metrics snapshots |
| Worker Integration | Outbox -> BullMQ -> real worker -> X connector fixture -> normalized persistence |

---

## Sprint 05 — Worker Ingestion & Queue Reliability

Sprint 05 replaces the fail-closed social-ingestion worker stub with a durable worker pipeline for the Sprint 04 reference HTTP connector. It does not add live third-party social providers or intelligence processors.

### Worker Reliability Architecture

| Area                      | Implementation                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue namespace           | BullMQ `prefix` is driven by `QUEUE_PREFIX`, with CI-specific prefixes and no hardcoded production namespace                                                  |
| Job registry              | `@xlrrank/queue` defines `social.connection.sync`, payload version `1`, known reasons, statuses, and valid transitions                                        |
| Payload safety            | Queue payloads carry identifiers only and reject credential/token/cookie/authorization-shaped keys                                                            |
| Durable job ledger        | Existing `jobs` table records scope, connection, payload version, attempts, retry classification, BullMQ job ID, run ID, safe errors, terminal times          |
| Outbox                    | `job_outbox` is inserted in the same PostgreSQL transaction as the job request                                                                                |
| Dispatcher                | Claims outbox rows with PostgreSQL row locks and publishes deterministic BullMQ job IDs                                                                       |
| BullMQ responsibility     | Execution transport, delayed retries, stalled-job redelivery, bounded Redis retention                                                                         |
| PostgreSQL responsibility | Durable job history, outbox, schedules, leases, ingestion runs, cursors, dead letters, and worker heartbeat state                                             |
| Worker processor          | Real `social.connection.sync` processor loads DB state, validates connection/scope, obtains connector factory, fetches pages, persists via Sprint 04 boundary |
| Run-level lease           | `social_sync_leases` uses owner token, expiry, heartbeat, stale recovery, and release ownership                                                               |
| Retry behavior            | Connector retry classification maps to bounded backoff, rate-limit delay, reauth stop, or terminal dead letter                                                |
| Scheduling                | `social_sync_schedules` uses UTC `next_sync_at`, cadence, `SKIP LOCKED` claiming, and durable outbox dispatch                                                 |
| API/UI                    | Manual sync returns HTTP 202 and safe job status; UI shows truthful queued/running/retrying/completed/failed states without fake percentages                  |
| Worker runtime            | Startup reconciliation, readiness, heartbeat, graceful shutdown, safe structured logs, metrics, and retention controls                                        |

### Evidence Matrix

| Requirement           | Implementation                                                 | Redis                                | PostgreSQL                                          | Real Worker                                                | Status   |
| --------------------- | -------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------- | -------- |
| Durable sync request  | API/service creates durable job + outbox                       | Not required for request             | `jobs`, `job_outbox` transaction                    | Worker consumes after dispatch                             | VERIFIED |
| Outbox                | Dispatcher publishes pending rows                              | BullMQ receives deterministic job ID | `job_outbox` status/locks                           | Runtime dispatcher loop                                    | VERIFIED |
| Dispatch idempotency  | Deterministic BullMQ job IDs and unique active job constraints | Duplicate add is harmless            | Unique job/outbox constraints                       | Duplicate request E2E                                      | VERIFIED |
| Worker processor      | Real social sync processor                                     | BullMQ delivery                      | Loads authoritative job/connection state            | Built worker process                                       | VERIFIED |
| Run-level lease       | Owner-token connection lease                                   | N/A                                  | `social_sync_leases`                                | Prevents same-connection concurrent sync                   | VERIFIED |
| Cursor resume         | Cursor read from `social_connections`                          | Redelivery tolerated                 | Cursor advances only after page persistence         | Crash/restart E2E                                          | VERIFIED |
| Temporary retry       | RETRYABLE maps to delayed retry                                | BullMQ delayed job                   | attempt/retry state persisted                       | Reference provider 500 then success                        | VERIFIED |
| Rate-limit retry      | Normalized retryAfter/resetAt with safe bounds                 | Delayed retry                        | rate-limit state and next retry persisted           | Reference provider 429 then success                        | VERIFIED |
| Reauth handling       | AUTHENTICATION marks connection `REAUTH_REQUIRED`              | No hot loop                          | Job/run safe failure state                          | Reference provider 401                                     | VERIFIED |
| DLQ                   | Terminal dead-letter records                                   | Failed transport state bounded       | `job_dead_letters` and job terminal state           | Permanent/malformed failures                               | VERIFIED |
| Crash recovery        | Durable cursor + stale lease + BullMQ stalled recovery         | Job redelivery                       | Lease expiry and idempotent persistence             | Killed worker process                                      | VERIFIED |
| Redis outage recovery | Request path persists without Redis transport                  | Dispatch after recovery              | Pending outbox survives                             | Worker completes after start                               | VERIFIED |
| Scheduled sync        | Due schedules claimed with `SKIP LOCKED`                       | Same outbox transport                | `social_sync_schedules`, connection schedule mirror | Two scheduler instances in worker E2E                      | VERIFIED |
| Graceful shutdown     | Runtime drains intervals/workers and closes resources          | Queues/workers closed                | Heartbeat marked draining/stopped                   | Worker process stop exercised                              | VERIFIED |
| Worker Docker runtime | Worker image readiness check                                   | Redis service                        | PostgreSQL service                                  | `node apps/worker/dist/main.js --readiness-check` in image | VERIFIED |

---

## Sprint 04 — Data Ownership & Social Persistence

Sprint 04 adds a structural tenant-isolation layer for social data without adding live third-party platform connectors.

### Data Ownership Inventory

| Table                           | Classification                              | Ownership Notes                                                                               |
| ------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| users                           | TENANT OWNED                                | Personal account owner and personal-scope anchor                                              |
| organizations                   | TENANT OWNED                                | Organization-scope anchor                                                                     |
| organization_members            | TENANT VISIBILITY LINK                      | User-to-organization membership                                                               |
| organization_member_permissions | TENANT VISIBILITY LINK                      | Organization-level social capabilities                                                        |
| data_scopes                     | TENANT OWNED                                | Formal PERSONAL/ORGANIZATION scope owner                                                      |
| platforms                       | GLOBAL CONFIGURATION                        | Platform definitions; deletion restricted for new social data                                 |
| platform_connectors             | GLOBAL CONFIGURATION                        | Connector metadata/configuration                                                              |
| social_accounts                 | PRIVATE SOURCE DATA                         | Legacy mixed table retained for compatibility/backfill only                                   |
| social_external_accounts        | CANONICAL PUBLIC DATA                       | Canonical provider identity keyed by platform + external ID                                   |
| social_account_handles          | CANONICAL PUBLIC DATA                       | Handle history for stable external account identity                                           |
| social_connections              | TENANT OWNED                                | Scope-owned credentials, status, cursor, rate-limit state                                     |
| social_account_observations     | TENANT VISIBILITY LINK                      | Scope/connection access to canonical accounts                                                 |
| people                          | CANONICAL PUBLIC DATA                       | Canonical person model; tenant-derived links must be scoped                                   |
| person_identifiers              | CANONICAL PUBLIC DATA                       | Identifier aliases for canonical people                                                       |
| external_organizations          | CANONICAL PUBLIC DATA                       | Canonical external organization records                                                       |
| content                         | PRIVATE SOURCE DATA                         | Legacy content table tied to legacy social_accounts                                           |
| content_media                   | PRIVATE SOURCE DATA                         | Legacy content media                                                                          |
| content_metrics                 | PRIVATE SOURCE DATA                         | Legacy point-in-time metrics                                                                  |
| social_content_items            | CANONICAL PUBLIC DATA / PRIVATE SOURCE DATA | PUBLIC rows canonical; UNKNOWN/SCOPE_PRIVATE/RESTRICTED rows scope-owned                      |
| social_content_observations     | TENANT VISIBILITY LINK                      | Scope/connection provenance for content visibility                                            |
| social_content_metrics          | DERIVED TENANT DATA                         | Scope-owned metrics snapshots                                                                 |
| interactions                    | PRIVATE SOURCE DATA                         | Legacy interaction table tied to legacy social_accounts/content                               |
| social_interactions             | CANONICAL PUBLIC DATA / PRIVATE SOURCE DATA | PUBLIC rows canonical; non-public rows scope-owned                                            |
| social_interaction_observations | TENANT VISIBILITY LINK                      | Scope/connection provenance for interactions                                                  |
| communities                     | CANONICAL PUBLIC DATA                       | Platform community records                                                                    |
| community_memberships           | CANONICAL PUBLIC DATA                       | Canonical community-account links                                                             |
| conversations                   | PRIVATE SOURCE DATA                         | Provider conversation records; future retention must be scoped                                |
| topics                          | GLOBAL CONFIGURATION                        | Global topic taxonomy/ontology                                                                |
| topic_clusters                  | GLOBAL CONFIGURATION                        | Global clustering/taxonomy support                                                            |
| content_topics                  | DERIVED TENANT DATA                         | Classification depends on observed content; future scoped watchlists remain tenant-owned      |
| relationship_pipelines          | GLOBAL CONFIGURATION                        | Current default pipeline template; customer-customized instances must use scoped config later |
| relationship_stages             | GLOBAL CONFIGURATION                        | Inherits current pipeline template semantics                                                  |
| relationships                   | DERIVED TENANT DATA                         | User-owned and Sprint 04 adds scope_id for future scoped CRM data                             |
| relationship_events             | DERIVED TENANT DATA                         | Inherits relationship ownership                                                               |
| social_dna_profiles             | DERIVED TENANT DATA                         | Sprint 04 adds scope_id for customer-derived intelligence                                     |
| opportunities                   | DERIVED TENANT DATA                         | User-owned and Sprint 04 adds scope_id                                                        |
| trends                          | DERIVED TENANT DATA                         | User/global field exists; customer watchlists must be tenant-owned                            |
| trend_snapshots                 | DERIVED TENANT DATA                         | Inherits trend ownership                                                                      |
| recommendations                 | DERIVED TENANT DATA                         | User-owned and Sprint 04 adds scope_id                                                        |
| recommendation_feedback         | DERIVED TENANT DATA                         | Inherits recommendation ownership                                                             |
| recommendation_evidence         | DERIVED TENANT DATA                         | Inherits recommendation ownership                                                             |
| jobs                            | SYSTEM OPERATIONAL DATA                     | Operational queue state                                                                       |
| job_runs                        | SYSTEM OPERATIONAL DATA                     | Operational job execution state                                                               |
| social_ingestion_runs           | SYSTEM OPERATIONAL DATA                     | Scope/connection-bound sync run state and cursor evidence                                     |
| notifications                   | TENANT OWNED                                | User-owned notification records                                                               |
| audit_logs                      | SYSTEM OPERATIONAL DATA                     | Security and operational audit trail                                                          |
| ai_providers                    | GLOBAL CONFIGURATION                        | AI provider definitions and encrypted deployment credentials                                  |
| ai_models                       | GLOBAL CONFIGURATION                        | Provider model registry                                                                       |
| ai_model_benchmarks             | GLOBAL CONFIGURATION                        | Model benchmark metadata                                                                      |
| ai_routes                       | GLOBAL CONFIGURATION                        | Routing configuration                                                                         |
| ai_usage                        | SYSTEM OPERATIONAL DATA                     | Usage/cost telemetry tied to user/provider                                                    |
| prompt_definitions              | GLOBAL CONFIGURATION                        | Prompt registry definition                                                                    |
| prompt_versions                 | GLOBAL CONFIGURATION                        | Prompt registry versions                                                                      |
| feature_flags                   | GLOBAL CONFIGURATION                        | Global/user/org-targeted configuration                                                        |
| subscriptions                   | TENANT OWNED                                | Billing entitlement record                                                                    |
| usage_metering                  | SYSTEM OPERATIONAL DATA                     | Billing/usage telemetry                                                                       |
| support_tickets                 | TENANT OWNED                                | User-owned support workflow                                                                   |
| support_messages                | TENANT OWNED                                | Inherits support ticket ownership; internal notes are restricted                              |

### Evidence Matrix

| Requirement                 | Implementation                                                | PostgreSQL Test                                              | HTTP/E2E                                           | Status                           |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- | -------------------------------- |
| Personal scope isolation    | `data_scopes` PERSONAL + `authorizeScope`                     | `social-isolation.integration.test.mjs`                      | Existing authenticated APIs resolve personal scope | VERIFIED LOCALLY / CI GATE ADDED |
| Organization isolation      | ORGANIZATION scopes + member capabilities                     | `social-isolation.integration.test.mjs`                      | Not exposed to UI yet                              | VERIFIED LOCALLY / CI GATE ADDED |
| Connection isolation        | `social_connections.scope_id` FK and repository functions     | `authorizeConnection` IDOR checks                            | Platform DTOs use scoped connections               | VERIFIED LOCALLY / CI GATE ADDED |
| Credential isolation        | Credentials moved to `social_connections`                     | Encrypted values preserved in legacy backfill test           | API DTO excludes credential fields                 | VERIFIED LOCALLY / CI GATE ADDED |
| Canonical identity          | `social_external_accounts` unique platform + external ID      | Shared public canonical test                                 | Reference connector returns stable external ID     | VERIFIED LOCALLY / CI GATE ADDED |
| Observation visibility      | Explicit observation link tables                              | Two scopes observe same public account/content independently | Reference metadata includes visibility             | VERIFIED LOCALLY / CI GATE ADDED |
| Private data isolation      | Non-public content/interactions require scope_id              | Same external ID creates per-scope private rows              | Reference connector supports SCOPE_PRIVATE         | VERIFIED LOCALLY / CI GATE ADDED |
| Profile persistence         | `persistSocialSyncPage` upserts accounts/handles/observations | Profile idempotency covered                                  | Reference connector normalizes profiles            | VERIFIED LOCALLY / CI GATE ADDED |
| Content persistence         | Scope-aware public/private content upsert                     | Public dedupe + private isolation covered                    | Reference connector cursor pages content           | VERIFIED LOCALLY / CI GATE ADDED |
| Interaction persistence     | Scope-aware interaction upsert                                | Interaction idempotency covered                              | Reference connector normalizes interactions        | VERIFIED LOCALLY / CI GATE ADDED |
| Provenance                  | Observation rows + ingestion run IDs                          | Observation/run assertions covered                           | Normalized contract carries provenance             | VERIFIED LOCALLY / CI GATE ADDED |
| Idempotency                 | Unique constraints and upsert paths                           | Repeated sync duplicate protection covered                   | Reference retry path covered                       | VERIFIED LOCALLY / CI GATE ADDED |
| Cursor atomicity            | Cursor updated inside persistence transaction                 | Failure-before-commit and partial retry covered              | Reference pagination supplies durable cursor       | VERIFIED LOCALLY / CI GATE ADDED |
| Connector factory isolation | Registry stores factories/manifests only                      | N/A                                                          | Connector Contract local HTTP test                 | VERIFIED LOCALLY / CI GATE ADDED |
| Concurrent sync protection  | PostgreSQL advisory transaction lock by connection ID         | Same-connection lock test                                    | N/A                                                | VERIFIED LOCALLY / CI GATE ADDED |

---

## Sprint 03 — Auth/User/Admin/Support E2E

Local source gates passed after the Sprint 03 repair work already present on this branch before this documentation closure:

- `pnpm lint --concurrency=2` PASS, with pre-existing warnings in billing/reports.
- `pnpm typecheck --concurrency=2` PASS.
- `pnpm build` PASS.
- `pnpm test --concurrency=2` PASS: package test tasks passed; database migration integration tests remain skipped without their integration env.
- `node --test scripts/security.test.mjs` PASS: 11/11.
- `pnpm audit --prod --audit-level=high` PASS.
- `pnpm audit --prod` PASS: no known vulnerabilities.

Local browser E2E execution was not completed because Docker is not installed on the local Windows host and no local Mailpit/MailHog service is available. The blocking GitHub Actions `Application E2E` job now provisions the required real services and passed in run 34013204160 at commit 648adb9f74b754f3995e09365751dc62c95f5a4b.

| Journey            | API            | Browser                                                     | PostgreSQL                    | Negative Paths                                                | Status  |
| ------------------ | -------------- | ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ------- |
| Signup             | E2E test added | `/signup` browser test added                                | User status asserted          | duplicate, malformed email, weak password, invalid name, CSRF | CI PASS |
| Verify email       | E2E test added | Mailpit URL opened in browser                               | ACTIVE transition asserted    | invalid, expired, reuse                                       | CI PASS |
| Signin             | E2E test added | `/signin` browser test added                                | session persisted             | unverified denied, bad password                               | CI PASS |
| Session management | E2E test added | refresh/signout browser assertions added                    | sessions queried/revoked      | IDOR revoke attempt, revoked session                          | CI PASS |
| Profile            | E2E test added | `/settings` browser save added                              | display name asserted         | CSRF mismatch                                                 | CI PASS |
| Change password    | E2E test added | `/settings` browser form added                              | password hash asserted        | wrong current password, old password rejected                 | CI PASS |
| Reset password     | E2E test added | `/forgot-password` and `/reset-password` browser flow added | hash/session effects asserted | invalid, expired, wrong purpose, reuse                        | CI PASS |
| Account deletion   | E2E test added | settings UI wired                                           | DELETION_PENDING asserted     | signin/session denied after request                           | CI PASS |
| Admin RBAC         | E2E test added | admin UI wired                                              | roles/status queried          | USER/SUPPORT/ADMIN boundaries, unknown role                   | CI PASS |
| Admin users        | E2E test added | `/admin/users` filters/actions wired                        | user list from DB             | invalid page/status bounds                                    | CI PASS |
| Support tickets    | E2E test added | `/support` portal wired                                     | tickets/messages persisted    | ownership and forged UUID checks                              | CI PASS |
| Internal notes     | E2E test added | staff checkbox only                                         | internal flag persisted       | normal user cannot create or view                             | CI PASS |

---

## 4. Product Subsystem Matrix

| Subsystem                    | Status                           | Notes                                                                                                                                                |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication               | VERIFIED                         | Real browser/API E2E suite passed in CI                                                                                                              |
| Sessions                     | VERIFIED                         | HMAC-signed tokens, httpOnly cookies, revocation, expiry; E2E passed in CI                                                                           |
| Email verification           | VERIFIED                         | SMTP sink E2E passed in CI                                                                                                                           |
| Password reset               | VERIFIED                         | SMTP sink E2E with session revocation passed in CI                                                                                                   |
| RBAC                         | VERIFIED                         | 4 roles, 9 permissions, role hierarchy tested                                                                                                        |
| User portal                  | VERIFIED                         | Settings wires profile, password, sessions, account deletion; E2E passed in CI                                                                       |
| Admin portal                 | VERIFIED                         | User search/filter/status/roles wired; lockout protections tested in CI                                                                              |
| Support system               | VERIFIED                         | Ticket portal, internal note filtering, and RBAC tested by Playwright suite in CI                                                                    |
| Notifications                | SCAFFOLD ONLY                    | Service + controller exist, no notification triggers                                                                                                 |
| X connector                  | CONTRACT VERIFIED / LIVE BLOCKED | OAuth 2.0 PKCE adapter, API v2 transport, normalization, rate-limit/error handling, and worker fixture gates; live provider credentials not supplied |
| Instagram connector          | CONTRACT VERIFIED / LIVE BLOCKED | Graph API v26.0, Facebook Login & direct Instagram Login auth modes, asset discovery/selection, comments, webhooks; live credentials not supplied   |
| Facebook connector           | CONTRACT VERIFIED / LIVE BLOCKED | Graph API v26.0, Facebook Login, Page discovery/selection, comments, webhooks; live credentials not supplied                                         |
| LinkedIn connector           | CONTRACT VERIFIED / LIVE BLOCKED | Version 202608, Rest.li 2.0.0, OIDC identity, org ACLs, Posts pagination, comments, follower stats, webhooks, worker ingestion, retention; live credentials not supplied |
| Reddit connector             | INTERFACE ONLY                   | Same pattern                                                                                                                                         |
| Ingestion                    | VERIFIED PARTIAL                 | Reference, X, Meta, and LinkedIn social sync executes through PostgreSQL, Redis, BullMQ, real worker                                                 |
| Workers                      | VERIFIED PARTIAL                 | Social ingestion and webhook processors implemented; intelligence/future queues remain fail-closed                                                   |
| Normalized social model      | VERIFIED                         | Types defined, DB schema complete                                                                                                                    |
| Identity resolution          | SCAFFOLD ONLY                    | Algorithm exists, not tested with real data                                                                                                          |
| Social DNA                   | SCAFFOLD ONLY                    | Generator exists, not tested end-to-end                                                                                                              |
| Discovery                    | SCAFFOLD ONLY                    | Scoring algorithm exists, not tested with real data                                                                                                  |
| Relationships                | SCAFFOLD ONLY                    | Strength/momentum calculation exists                                                                                                                 |
| Radar/opportunities          | SCAFFOLD ONLY                    | Detection algorithm exists                                                                                                                           |
| Trends                       | SCAFFOLD ONLY                    | Detection algorithm exists                                                                                                                           |
| Content intelligence         | SCAFFOLD ONLY                    | Analysis algorithm exists                                                                                                                            |
| Network intelligence         | SCAFFOLD ONLY                    | Cross-platform merge exists                                                                                                                          |
| Search                       | SCAFFOLD ONLY                    | Inverted index + search exists                                                                                                                       |
| AI provider framework        | PARTIAL                          | Real HTTP implementations for OpenAI-compatible, Anthropic; 8 provider adapters                                                                      |
| Provider credential storage  | PARTIAL                          | DB table exists, encryption implemented                                                                                                              |
| Model discovery              | PARTIAL                          | Registry + prober with real HTTP calls                                                                                                               |
| Capability validation        | PARTIAL                          | Prober tests text gen, structured output, streaming                                                                                                  |
| Model registry persistence   | SCAFFOLD ONLY                    | In-memory only                                                                                                                                       |
| AI routing                   | PARTIAL                          | Router with 4 modes, candidate ranking, fallback                                                                                                     |
| Language guard               | SCAFFOLD ONLY                    | Detection + repair exist, not tested with real LLM output                                                                                            |
| AI cost controls             | SCAFFOLD ONLY                    | Tracking service exists                                                                                                                              |
| Feature flags                | SCAFFOLD ONLY                    | Service exists with scope-aware flags                                                                                                                |
| Plans/entitlements           | SCAFFOLD ONLY                    | 4 plans defined in code                                                                                                                              |
| Billing                      | SCAFFOLD ONLY                    | Service exists, no real billing integration                                                                                                          |
| Reports                      | SCAFFOLD ONLY                    | Service exists with basic reports                                                                                                                    |
| Browser extension            | PARTIAL                          | Manifest V3, content scripts for 5 platforms, popup                                                                                                  |
| Demo isolation               | SCAFFOLD ONLY                    | Demo seed exists, demo provider exists                                                                                                               |
| Social persistence           | VERIFIED LOCALLY / CI GATE ADDED | Scope-owned connections, canonical accounts, observations, content, interactions, provenance                                                         |
| Connector runtime isolation  | VERIFIED LOCALLY / CI GATE ADDED | Registry stores connector factories, not authenticated singleton instances                                                                           |
| Worker ingestion reliability | VERIFIED                         | Durable job outbox, run lease, retries, DLQ, scheduling, crash recovery via reference provider                                                       |
| Docker/deployment            | VERIFIED                         | Docker Compose valid, API/web/worker images build in CI                                                                                              |
| Dependency security          | VERIFIED                         | 0 known production vulnerabilities                                                                                                                   |
| Encryption                   | VERIFIED                         | AES-256-GCM, roundtrip tested, legacy rejection tested                                                                                               |
| RBAC security                | VERIFIED                         | Permission hierarchy tested, role enforcement tested                                                                                                 |
| CSRF                         | VERIFIED                         | Double-submit cookie pattern enforced                                                                                                                |
| Observability                | PARTIAL                          | Pino logging with redaction, basic metrics                                                                                                           |

---

## 5. Confirmed Defects (Active)

### HIGH

No active HIGH defects are confirmed in the Sprint 01-05 foundation gates. Production remains blocked by unverified product capabilities listed in Missing Verification.

### MEDIUM

1. **Model registry not persisted**
   - Affected: AI routing
   - Impact: Model discovery results lost on restart
   - State: Requires database persistence layer

### LOW

2. **Lint warnings in reports/billing services**
   - Affected: apps/api/src/reports/reports.service.ts, apps/api/src/billing/ai-cost.service.ts
   - Behavior: Unused variables (db, userId, aiProviders)
   - State: Non-blocking cleanup

---

## 6. Sprint 02 Remediation (All RESOLVED)

| Package                  | Declared range / source                                      | Previous resolved | Current lockfile resolved | Advisory                              | Status    |
| ------------------------ | ------------------------------------------------------------ | ----------------: | ------------------------: | ------------------------------------- | --------- |
| drizzle-orm              | `^0.45.2` in apps/api and packages/database                  |            0.38.4 |                    0.45.2 | GHSA-gpj5-g38j-94v9 (SQL injection)   | RESOLVED  |
| @nestjs/common           | `^11.2.3` in apps/api                                        |           10.4.15 |                    11.2.3 | NestJS dependency advisory            | RESOLVED  |
| @nestjs/core             | `^11.2.3` in apps/api                                        |           10.4.22 |                    11.2.3 | GHSA-36xv-jgw5-4q75 (injection)       | RESOLVED  |
| @nestjs/platform-express | `^11.2.3` in apps/api                                        |           10.4.15 |                    11.2.3 | NestJS dependency advisory            | RESOLVED  |
| multer                   | Transitive via `@nestjs/platform-express`                    |             2.0.2 |                     2.2.0 | 4x HIGH + 1x MODERATE DoS             | RESOLVED  |
| postcss                  | pnpm override `>=8.5.23`; transitive via Next/Vite toolchain |            8.4.31 |                    8.5.26 | 2x HIGH + 2x MODERATE (file read/XSS) | RESOLVED  |
| file-type                | Transitive via `@nestjs/common`                              |            20.4.1 |                    21.3.4 | 2x MODERATE (DoS)                     | RESOLVED  |
| qs                       | pnpm override `>=6.16.0`; transitive via Express/body-parser |            6.14.2 |                    6.16.0 | 3x MODERATE (DoS)                     | RESOLVED  |
| body-parser              | Transitive via Express                                       |            1.20.4 |                     2.3.0 | 1x LOW (DoS)                          | RESOLVED  |
| next                     | `^15.1.3` in apps/web                                        |           15.5.25 |                   15.5.25 | Not part of Sprint 02 remediation     | UNCHANGED |
| drizzle-kit              | `^0.31.10` in packages/database                              |            0.30.1 |                   0.31.10 | Not a production dependency advisory  | RESOLVED  |

---

## 7. Missing Verification

- Live X provider OAuth/read/search/worker verification with real X developer app credentials/access
- Live Meta (Facebook & Instagram) provider OAuth/read/webhook verification with real developer app credentials/access
- Live LinkedIn provider OAuth/read/webhook verification with real developer app credentials and Partner Program approvals
- Reddit social connector implementation and verification
- Live third-party social ingestion through production provider APIs
- Remote CI infrastructure quota exhaustion (`BLOCKED_INFRA`)
- Worker Docker runtime local daemon availability (`BLOCKED_LOCAL_INFRA`)
- AI provider actual API calls (no test API keys in CI)
- AI runtime/provider configuration
- Persistent dynamic model registry
- Routing and language enforcement with real LLM output
- Intelligence engines with real data
- Search, including vector search with pgvector
- Full deployment journey
- Notification delivery
- Browser extension production integration
- Billing/entitlement enforcement
- Feature flag runtime behavior
- Cross-platform identity matching with real data

---

## 8. External Integration Blockers

| Integration      | Status                                    | Reason                                                                                                                |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| X (Twitter)      | CONTRACT VERIFIED / LIVE BLOCKED_EXTERNAL | Production OAuth/API implementation exists; no real X developer app credentials/access supplied for live verification |
| Instagram        | CONTRACT VERIFIED / LIVE BLOCKED_EXTERNAL | Graph v26.0 / Instagram Login implementation exists; no real test credentials supplied                                |
| Facebook         | CONTRACT VERIFIED / LIVE BLOCKED_EXTERNAL | Graph v26.0 implementation exists; no real test credentials supplied                                                  |
| LinkedIn         | CONTRACT VERIFIED / LIVE BLOCKED_EXTERNAL | Marketing API 202608 / Rest.li 2.0.0 implementation exists; no real credentials / partner approvals supplied          |
| Reddit           | NOT PRODUCTION VERIFIED                   | No test credentials                                                                                                   |
| Remote CI        | BLOCKED_INFRA                             | GitHub Actions workflow run quota exhausted; all local test matrices pass                                             |
| Worker Docker    | BLOCKED_LOCAL_INFRA                       | Docker runtime daemon unavailable on local host; built image verification verified in earlier CI                       |
| OpenAI           | IMPLEMENTED, NOT VERIFIED                 | Real HTTP implementation, no test API key                                                                             |
| Anthropic        | IMPLEMENTED, NOT VERIFIED                 | Real HTTP implementation, no test API key                                                                             |
| DeepSeek         | IMPLEMENTED, NOT VERIFIED                 | OpenAI-compatible adapter                                                                                             |
| xAI/Grok         | IMPLEMENTED, NOT VERIFIED                 | OpenAI-compatible adapter                                                                                             |
| Xiaomi MiMo      | IMPLEMENTED, NOT VERIFIED                 | OpenAI-compatible adapter                                                                                             |
| Stripe (billing) | NOT IMPLEMENTED                           | No integration code                                                                                                   |
| SMTP (email)     | IMPLEMENTED, CI VERIFIED                  | Mailpit SMTP sink exercised in Application E2E job; production SMTP delivery not verified                             |

---

## 9. Recommended Repair Sprint Order

1. ~~**Foundation/Security**~~ — DONE (Sprint 02)
2. ~~**Auth/User/Admin/Support**~~ — CI VERIFIED on current branch
3. ~~**Persistence/Data ownership**~~ — DONE (Sprint 04)
4. ~~**Worker ingestion reliability**~~ — DONE for reference-provider path (Sprint 05)
5. ~~**Social connector framework**~~ — CONTRACT VERIFIED (Reference, X, Meta, LinkedIn; live credentials blocked)
6. **AI provider runtime** — At least one real provider verified
7. **Dynamic model discovery** — Real model enumeration
8. **Routing/Fallback/Language** — End-to-end AI routing
9. **Intelligence engines** — With real data
10. **Search** — Vector search with pgvector
11. **Notifications/Reports** — Real delivery
12. **Extension** — Live profile detection
13. **Billing/Entitlements** — Stripe integration
14. **Demo isolation** — Complete demo mode
15. **Full E2E** — Complete user journey
16. **Deployment hardening** — Production config
