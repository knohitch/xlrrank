# Sprint 08 Local Verification: LinkedIn Production Connector

Date: 2026-09-09

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
   - Updated check constraint `provider_authorization_assets_type_check` to support `'LINKEDIN_ORGANIZATION'`.
   - Historical migrations `0000` through `0006` were preserved without modification.
   - Cross-scope safe, record-level data retention purge mechanism implemented in `packages/database/src/social/retention.ts` (`loadProviderRetentionPolicies` and `purgeExpiredProviderData`).

2. **Social Core & Connector Architecture**:
   - `packages/social-core/src/platforms/linkedin-api.ts`: centralized Marketing API version `202608`, Rest.li `2.0.0`, SSRF host validation, structured error mapping (401 reauth, 403 role-loss / product-access, 429 rate limit, 5xx server failure), official HMAC-SHA256 challenge/signature verification, opaque pagination cursor encoding/decoding.
   - `packages/social-core/src/platforms/linkedin-connector.ts`: full `LinkedInConnector` implementing `OAuthCapableConnector`, product-access-aware capability evaluation, 3-legged member OAuth, OIDC identity, organization ACL discovery, Posts API pagination, Social Actions comments, truthful metrics, and local notification subscription adapter.
   - Capability truthfulness: member feeds, follower identity lists, following lists, general search, notification support, and audience insights truthfully reported as `APP_REVIEW_REQUIRED`, `ACCESS_REQUIRED`, `PERMISSION_REQUIRED`, or `UNAVAILABLE`.

3. **API & Webhooks**:
   - `apps/api/src/platforms/platforms.controller.ts`: added `GET :id/linkedin/webhook` (challenge-response) and `@Public() @CsrfExempt() POST :id/linkedin/webhook` (notification ingestion).
   - `apps/api/src/platforms/platforms.service.ts`: registered `LinkedInConnector`, generalized authorization asset persistence and selection for multi-asset platforms, added `verifyLinkedInWebhookChallenge`, fail-closed raw-body `receiveLinkedInWebhook`, minimized webhook receipt persistence, and local subscription synchronization.

4. **Worker Ingestion & Queue Reliability**:
   - `apps/worker/src/social-webhook-processor.ts`: updated to handle `provider_family === 'linkedin'`, extracting organization URNs/IDs from payloads and dispatching sync jobs to active connections.
   - `apps/worker/src/social-sync-processor.ts`: updated `updateConnectionAfterFailure` to transition connections to `DEGRADED` on organization role loss or product access denial rather than infinite retry or reauth loops.

---

## Local Verification Commands and Results

### 1. Database Migrations & Retention Suite
```text
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_audit pnpm --filter @xlrrank/database test
```
**Result**: 11 passed, 1 skipped, 0 failed.
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
- LinkedIn Event Subscription Contract (compound key, role denial, missing scope denial): PASS.
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
- Connection-specific disconnect (`DELETE /platforms/connections/:connectionId`): PASS (multi-asset connection support, does not destroy sibling connections or authorizations, verifies exact LinkedIn subscription deletion).
- Disconnect temporary failure outbox: PASS (marks `PENDING_PROVIDER_DELETE` and dispatches `provider.subscription.cleanup` to outbox).
- LinkedIn notification webhook deduplication: PASS (batches `[100, 200]` and `[200, 300]` accept 3 logical events, reject duplicate notifications, handle reordering and standalone delivery).

### 4. Worker BullMQ Ingestion, Webhooks, and Retention E2E
```text
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test apps/worker/test/worker-ingestion.e2e.mjs
```
**Result**: 18 passed, 0 failed.
- Real child worker processes + BullMQ + Redis 5.0.14.1 + PostgreSQL 18.
- Outbox to BullMQ to real worker persists across multiple pages.
- Crash recovery, mid-sync disconnects, lease renewals, concurrency locks.
- X worker OAuth refresh: PASS.
- Facebook Page & Instagram Professional worker ingestion: PASS.
- Direct Instagram Login worker ingestion: PASS.
- Meta webhook worker receipt resolution & dispatch: PASS.
- LinkedIn worker ingestion (organization posts, 2-page pagination, comments, networkSizes metrics, token secrecy): PASS.
- LinkedIn webhook worker (receipt outbox, multi-scope connection resolution, sync dispatch, deduplication): PASS.
- Provider subscription cleanup worker: PASS (processes pending cleanup job, invokes LinkedIn DELETE against Rest.li compound key, transitions to `PROVIDER_DELETED`).
- Data retention (`purgeExpiredProviderData`): record-level LinkedIn categories, member comment on organization post purged after member social activity limit, authenticated organization post retained, interaction purge, operational webhook receipt purge, multi-tenant cross-scope isolation: PASS.
- Canonical profile retention & asset minimization: PASS (`authenticated_member_profile` unlimited, `other_member_profile` 24h, `organization_profile` 8w, restricted fields redacted while preserving stable external ID, cross-scope multi-tenant lawful preservation, and `provider_authorization_assets` decorative field minimization/purge).

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
