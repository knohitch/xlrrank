# Sprint 07 Local Verification

Date: 2026-09-09

Scope: Meta production integration engineering closure for Facebook Pages and Instagram Professional accounts.

## Official Meta Documentation Check

Meta developer docs were checked before implementation. Direct page opens to `developers.facebook.com` returned HTTP 429 during this run, so the implementation uses only stable official endpoint conventions and search-visible official Meta documentation snippets:

- Graph API v26.0 reference pages are current in Meta for Developers search results.
- Meta Webhooks documentation states event payloads are signed with `X-Hub-Signature-256` using a `sha256=` prefix.
- Instagram Webhooks documentation states the same `X-Hub-Signature-256` signing model.
- Instagram Platform/API with Facebook Login remains the route for Page-linked Instagram professional account access.

Live provider validation remains blocked because no Meta app credentials, approved scopes, Page assets, or Instagram Professional account assets were supplied.

## Implementation Summary

- Added shared Meta Graph client for Graph API `v26.0`, appsecret proof, Meta rate-limit headers, pagination cursors, and provider error mapping.
- Replaced placeholder Facebook connector with read-only Facebook Pages OAuth, asset discovery, Page profile, Page posts, comments, metrics, capability gates, and worker-compatible ingestion.
- Replaced placeholder Instagram connector with read-only Page-linked Instagram Professional account OAuth, asset discovery, profile, media, comments, metrics, capability gates, and worker-compatible ingestion.
- Added database schema and migration for shared provider authorizations, provider authorization assets, and webhook receipts.
- Added public Meta webhook challenge and delivery endpoints with verify-token validation, `X-Hub-Signature-256` verification, and receipt dedupe.
- Kept messaging, publishing, ads, Messenger, WhatsApp, Threads, LinkedIn, Reddit, and AI/billing/extension work out of scope.

## Local Verification Commands

```text
pnpm --filter @xlrrank/social-core build
pnpm --filter @xlrrank/social-core test
pnpm --filter @xlrrank/database build
pnpm --filter @xlrrank/api build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55433/xlrrank_x_oauth_e2e X_OAUTH_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum node --test apps/api/test/platforms-oauth.e2e.mjs
pnpm --filter @xlrrank/worker build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55433/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test --test-name-pattern "Meta worker ingestion" apps/worker/test/worker-ingestion.e2e.mjs
```

## Results

- Social-core build: PASS.
- Social-core connector tests: PASS, 12/12.
- Database build: PASS.
- API build: PASS.
- API OAuth/webhook E2E: PASS, 3/3.
- Worker build: PASS.
- Focused Meta worker ingestion E2E: PASS, 1/1.
- Redis local compatibility: PASS on Redis 5.0.14.1.
- Docker runtime parity: BLOCKED_LOCAL_INFRA.
- Remote CI: BLOCKED_INFRA because GitHub Actions quota is unavailable and Actions were not rerun.
- Meta live provider gates: BLOCKED_EXTERNAL.
