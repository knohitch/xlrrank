# Sprint 08 Local Verification: LinkedIn Production Connector

Date: 2026-09-10

Scope: LinkedIn Production Connector — OAuth, Organizations, Community Management, Analytics, Notifications, Worker Ingestion, and Data Retention.

---

## Documentation and Standards Check

Official Microsoft and LinkedIn documentation was crawled and confirmed on 2026-09-09:
- LinkedIn Marketing Developer Platform baseline version: `202608` (monthly `YYYYMM` cadence).
- Rest.li Protocol: `2.0.0` (enforced via `X-Restli-Protocol-Version` and `Linkedin-Version` headers).
- REST API Base: `https://api.linkedin.com/rest/`
- OpenID Connect Userinfo: `https://api.linkedin.com/v2/userinfo` with `sub` claim as provider user identity (truthfully documented as non-KYC provider account identifier).
- Organization ACLs: `GET /rest/organizationAcls?q=roleAssignee`
- Posts API: `GET /rest/posts?author=urn:li:organization:{id}&q=author`
- Social Actions API: `GET /rest/socialActions/{activityUrn}/comments`
- Network Sizes: `GET /rest/networkSizes/urn:li:organization:{id}?edgeType=CompanyFollowedByMember`
- Webhooks: HMAC-SHA256 challenge-response and official notification signature verification via `X-LI-Signature`; POST verification requires the exact raw body and signs UTF-8 `hmacsha256=` plus the raw JSON bytes.
- Organization Social Action Notifications: Event Subscription API requires webhook registration/validation, authenticated member, `ADMINISTRATOR` organization access, `rw_organization_admin`, developer application, member, organization entity, event type, and webhook URL.
- Data Retention Requirements: authenticated member ID/profile and other member ID have no provider duration restriction; other member profile is 24-hour cache only; member social activity is 48 hours; organization social activity is six weeks or six months when it relates to an authenticated organization; authenticated organization profile is eight weeks; limited non-authenticated organization profile fields are 30 days; organization admin/reporting data is one year. Minimal webhook receipt storage is `XLRRANK_OPERATIONAL_RETENTION`, not LinkedIn-mandated retention.

Live provider verification remains `BLOCKED_EXTERNAL` because no production LinkedIn Partner credentials or Community Management API approvals were supplied.

---

## Verified Sprint 08 Deliverables

1. **Database Schema & Migrations**:
   - Historical migration `packages/database/migrations/0007_linkedin_retention_policies.sql` created the first LinkedIn retention table.
   - Forward migration `packages/database/migrations/0008_linkedin_retention_subscriptions_truthfulness.sql` corrects LinkedIn policy categories, adds `retention_mode`, supports nullable `max_retention_seconds` for no-duration-limit provider categories, adds generic `provider_data_category` columns, and creates `provider_event_subscriptions`.
   - Forward migration `packages/database/migrations/0010_provider_retention_runtime_side_tables.sql` adds retention category/basis columns for `social_account_handles` and durable `provider_retention_sweep_claims` for multi-worker retention-window ownership.
   - Forward migration `packages/database/migrations/0011_provider_family_subscription_keys.sql` adds `platforms.provider_family` for data-driven provider-family retention across multiple platform slugs and `provider_event_subscriptions.provider_key` for connector-owned subscription identity while preserving legacy LinkedIn Rest.li key columns for compatibility.
   - Updated check constraint `provider_authorization_assets_type_check` to support `'LINKEDIN_ORGANIZATION'`.
   - Historical migrations `0000` through `0006` were preserved without modification.
   - Cross-scope safe, record-level data retention purge mechanism implemented in `packages/database/src/social/retention.ts` (`loadProviderRetentionPolicies` and `purgeExpiredProviderData`), including canonical accounts, observations, handle history, scoped connection profile caches, authorization-asset decoration, encrypted authorization-asset credential minimization, and admin/reporting role data.

2. **Social Core & Connector Architecture**:
   - `packages/social-core/src/platforms/linkedin-api.ts`: centralized Marketing API version `202608`, Rest.li `2.0.0`, SSRF host validation, structured error mapping (401 reauth, 403 role-loss / product-access, 429 rate limit, 5xx server failure), official HMAC-SHA256 challenge/signature verification, opaque pagination cursor encoding/decoding.
   - `packages/social-core/src/platforms/linkedin-connector.ts`: full `LinkedInConnector` implementing `OAuthCapableConnector`, product-access-aware capability evaluation, 3-legged member OAuth, OIDC identity, organization ACL discovery, Posts API pagination, Social Actions comments, truthful metrics, connector-owned OAuth default-scope resolution, webhook asset extraction, authorization-asset discovery, and generic event subscription create/delete hooks.
   - Capability truthfulness: member feeds, follower identity lists, following lists, general search, notification support, and audience insights truthfully reported as `APP_REVIEW_REQUIRED`, `ACCESS_REQUIRED`, `PERMISSION_REQUIRED`, or `UNAVAILABLE`.

3. **API & Webhooks**:
   - `apps/api/src/platforms/platforms.controller.ts`: added `GET :id/linkedin/webhook` (challenge-response) and `@Public() @CsrfExempt() POST :id/linkedin/webhook` (notification ingestion).
   - `apps/api/src/platforms/platforms.service.ts`: registered `LinkedInConnector`, generalized authorization asset persistence and selection for multi-asset platforms, added `verifyLinkedInWebhookChallenge`, fail-closed raw-body `receiveLinkedInWebhook`, minimized webhook receipt persistence, `notificationId:lastModifiedAt` logical dedupe, categorized initial profile/handle/observation persistence, connector-driven subscription synchronization with generic `provider_key`, and local-first asynchronous provider subscription cleanup.

4. **Worker Ingestion & Queue Reliability**:
   - `apps/worker/src/social-webhook-processor.ts`: connector-driven webhook processing now loads `webhook_receipts.platform_id`, asks the platform connector to extract provider asset IDs, and resolves connections with `sc.platform_id = receipt.platform_id` to prevent cross-provider object ID collisions.
   - `apps/worker/src/provider-retention-sweep.ts` and `apps/worker/src/runtime.ts`: production worker startup and cadence timer execute generic provider/data-policy retention sweeps. Cadence defaults to one hour and is capped to one quarter of the shortest active provider retention class, so LinkedIn 24-hour cache classes are enforced more granularly than daily. Each provider/window uses PostgreSQL advisory locking plus `provider_retention_sweep_claims` for single logical ownership across worker replicas. Purge SQL runs through the leased `PoolClient`, so `statement_timeout` bounds the actual retention work; failed claims are safely reclaimable.
   - `apps/worker/src/runtime.ts`: worker readiness is not blocked by the initial retention sweep; runtime registers the recurring maintenance timer and launches the first sweep asynchronously after `READY`.
   - `apps/worker/src/provider-subscription-cleanup-processor.ts`: generic connector-registry cleanup dispatch using `provider_key`; no worker import or direct construction of `LinkedInConnector`.
   - `apps/worker/src/social-sync-processor.ts`: updated `updateConnectionAfterFailure` to transition connections to `DEGRADED` on organization role loss or product access denial rather than infinite retry or reauth loops.

---

## Local Verification Commands and Results

### 1. Database Migrations & Retention Suite
```text
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_audit pnpm --filter @xlrrank/database test
```
**Result**: 8 passed, 4 skipped, 0 failed against `xlrrank_worker_e2e`.
- Forward migration 0008 cleanly applies after 0007 to PostgreSQL with pgvector.
- Core domain tables and constraint validations pass.
- Social data isolation, tenant boundaries, and advisory locks pass.

### 2. Social-Core Unit and Contract Suite
```text
pnpm --filter @xlrrank/social-core test
```
**Result**: 21 passed, 0 failed.
- LinkedIn Connector Contract: manifest, version `202608`, Rest.li `2.0.0`, headers, and truthful capabilities: PASS.
- LinkedIn Dynamic Capabilities: product access + scopes + role evaluation (`ADMINISTRATOR` vs `ANALYST`): PASS.
- LinkedIn OAuth & Member OIDC Identity: PASS.
- LinkedIn Organization Asset Discovery: PASS.
- LinkedIn Ingestion (posts 2-page pagination, comments, networkSizes metrics, share analytics semantics): PASS.
- LinkedIn Error Classifications (401, 403 role loss, 403 product review, 429, 500): PASS.
- LinkedIn Webhook Security (challenge-response, official string-to-sign, bare hex header, raw-HMAC rejection, prefix rejection, whitespace/order mutation rejection, dedupe): PASS.
- LinkedIn Event Subscription Contract (compound key, generic provider-key create/delete hooks, role denial, missing scope denial): PASS.
- Full regression across X, Meta, Facebook, and Instagram connectors: PASS.

### 3. API OAuth, Asset Selection, IDOR, and Webhooks E2E
```text
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_x_oauth_e2e X_OAUTH_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum node --test apps/api/test/platforms-oauth.e2e.mjs
```
**Result**: 11 passed, 0 failed.
- X OAuth E2E: PASS.
- X Organization scope binding: PASS.
- Meta webhook E2E: PASS.
- Meta OAuth E2E: PASS.
- Instagram Login OAuth E2E: PASS.
- LinkedIn OAuth E2E: PASS (Start OAuth, state digest, callback code exchange, OIDC identity, organization ACL discovery, multi-organization assets in `provider_authorization_assets`, asset selection by UUID, tenant isolation, User A/B IDOR rejection, idempotent reconnect, webhook challenge GET, raw-body webhook POST delivery, no-write missing/invalid signatures, minimized receipt).
- Initial connected profile retention: PASS (`social_external_accounts`, `social_account_observations`, and `social_account_handles` receive `organization_profile` classification during connection creation).
- Connection-specific disconnect (`DELETE /platforms/connections/:connectionId`): PASS (local status returns `DISCONNECTED` promptly without provider network DELETE, multi-asset sibling connection stays connected, shared authorization stays active, exact subscription is marked `PENDING_PROVIDER_DELETE`, and durable `provider.subscription.cleanup` outbox job is queued).
- Hanging provider disconnect: PASS (provider DELETE path intentionally not used during local disconnect).
- LinkedIn notification webhook deduplication: PASS (`notificationId + lastModifiedAt` duplicate version rejected, newer modified version accepted, overlapping batches accept exactly three logical versions, reorder rejected).

### 4. Worker BullMQ Ingestion, Webhooks, and Retention E2E
```text
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test apps/worker/test/worker-ingestion.e2e.mjs
```
**Result**: 20 passed, 0 failed. One rerun immediately before final matrix hit a local child-process readiness crash (`UV_HANDLE_CLOSING` with Redis 5.0.14.1 warning); the single affected crash-resume test passed on targeted rerun.
- Real child worker processes + BullMQ + Redis 5.0.14.1 + PostgreSQL 18.
- Outbox to BullMQ to real worker persists across multiple pages.
- Crash recovery, mid-sync disconnects, lease renewals, concurrency locks.
- X worker OAuth refresh: PASS.
- Facebook Page & Instagram Professional worker ingestion: PASS.
- Direct Instagram Login worker ingestion: PASS.
- Meta webhook worker receipt resolution & dispatch: PASS.
- LinkedIn worker ingestion (organization posts, 2-page pagination, comments, networkSizes metrics, token secrecy): PASS.
- LinkedIn webhook worker (receipt outbox, multi-scope connection resolution, sync dispatch, deduplication): PASS.
- Social webhook platform isolation: PASS (LinkedIn organization ID `12345` and Facebook Page ID `12345`; LinkedIn receipt scheduled 1 LinkedIn sync and 0 Facebook syncs).
- Provider subscription cleanup worker: PASS (processes pending cleanup job, invokes LinkedIn DELETE against Rest.li compound key, transitions to `PROVIDER_DELETED`).
- Provider retention runtime: PASS (runtime startup registers and executes sweep; two simulated worker actors race the same retention window and only one durable `provider_retention_sweep_claims` owner runs the purge).
- Provider-family retention mapping: PASS (synthetic provider family with two platform slugs is purged by one family policy).
- Data retention (`purgeExpiredProviderData`): record-level LinkedIn categories, member comment on organization post purged after member social activity limit, authenticated organization post retained, interaction purge, operational webhook receipt purge, multi-tenant cross-scope isolation: PASS.
- Canonical profile retention & asset minimization: PASS (`authenticated_member_profile` unlimited, `other_member_profile` 24h, `organization_profile` 8w, restricted fields redacted while preserving stable external ID, handle-history purge, scoped connection cache redaction, cross-scope multi-tenant lawful preservation, `provider_authorization_assets` decorative field minimization/purge, encrypted credential role scrubbing, and one-year admin/reporting role expiry forcing `ACCESS_REQUIRED`/`DEGRADED`).

### 4a. Sprint 08 Closure Focused Regression Runs
```text
pnpm --filter @xlrrank/social-core test -- linkedin-connector.test.mjs
pnpm --filter @xlrrank/queue test
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_x_oauth_e2e X_OAUTH_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum node --test --test-name-pattern "LinkedIn notification subscriptions|Connection-specific disconnect|LinkedIn notification webhook deduplication" apps/api/test/platforms-oauth.e2e.mjs
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test --test-name-pattern "Social webhook worker e2e: receipt platform boundary|Data retention: record-level|Data retention: provider-family|Provider subscription cleanup worker|Provider retention runtime|Data retention: canonical profile" apps/worker/test/worker-ingestion.e2e.mjs
```
**Result**: social-core 21 passed; queue 4 passed; API focused 5 passed; worker focused 6 passed. No blocking skips in focused closure coverage.

### 5. Monorepo Quality Matrix
```text
pnpm install --frozen-lockfile   # PASS (0 changes)
git diff --check                 # PASS (clean whitespace, no trailing blank lines)
pnpm build                       # PASS (17/17 successful across all packages)
pnpm typecheck --concurrency=2   # PASS (26/26 tasks successful)
pnpm lint --concurrency=2        # PASS (12/12 tasks successful, 0 errors)
pnpm audit --prod                # PASS (0 vulnerabilities found)
pnpm test --concurrency=2        # PASS (all unit/integration tests pass across 27 tasks)
```

---

## Known Blockers Carried Forward

- **Worker Docker Runtime**: `BLOCKED_LOCAL_INFRA`.
- **Remote CI**: `BLOCKED_INFRA` (GitHub Actions workflow run quota exhausted).
- **LinkedIn Live Provider Gate**: `BLOCKED_EXTERNAL`.
- **Facebook Live Provider Gate**: `BLOCKED_EXTERNAL`.
- **Instagram Live Provider Gate**: `BLOCKED_EXTERNAL`.
- **Meta Live Provider Gate**: `BLOCKED_EXTERNAL`.
- **X Live Provider Gate**: `BLOCKED_EXTERNAL`.
- **Production Ready**: NO (awaiting live provider credentials and CI infrastructure quota).
