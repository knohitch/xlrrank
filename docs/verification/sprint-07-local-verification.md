# Sprint 07 Focused Closure Verification

Date: 2026-09-09

Scope: focused closure for independently verified Meta gaps in PR #1.

## Documentation Check

Official Meta documentation was rechecked during closure. Direct opens to `developers.facebook.com` returned HTTP 429 in this environment. Official search-visible Meta results confirmed:

- Graph API `v26.0` is the current target used by the connector.
- Meta Webhooks and Instagram Webhooks use `X-Hub-Signature-256` with a `sha256=` signature.
- Instagram API with Facebook Login remains supported for Page-linked professional account access.
- Instagram API with Instagram Login is currently documented by Meta with `instagram_business_*` scopes, so the connector declares `FACEBOOK_LOGIN` and `INSTAGRAM_LOGIN` as distinct modes with fixed provider endpoints.

Live verification remains `BLOCKED_EXTERNAL` because no Meta app credentials, approved scopes, Facebook Pages, or Instagram Professional accounts were supplied.

## Closure Changes

- Split `@Public()` and CSRF semantics. `@Public()` now only exempts authentication; `@CsrfExempt()` is required for browser-CSRF bypass.
- Applied CSRF exemption only to Meta webhook POST. OAuth callbacks/challenges remain GET and do not need unsafe-method exemption.
- Added provider authorization and provider authorization asset AAD helpers. Shared grant secrets are bound to provider authorization IDs; asset secrets are bound to provider authorization asset IDs.
- Changed Meta OAuth callback lifecycle to stop before asset selection. It persists the shared authorization, discovers assets, stores asset inventory, and returns `ASSET_SELECTION_REQUIRED`.
- Added authorization asset APIs for listing stored assets and connecting selected assets by stored asset ID.
- Changed social connection uniqueness to allow multiple assets of the same platform in the same scope by keying on `(scope_id, platform_id, verified_external_id)`.
- Added forward migration `0006_meta_asset_connections.sql`; historical migration `0005` was not rewritten.
- Facebook Login asset discovery now returns Facebook Pages and linked Instagram Professional assets from the same shared Meta authorization.
- Corrected metrics semantics: profile/public aggregate metrics are not represented as Page/Instagram Insights, and `fan_count` is not used as content count.
- Added opaque cursor pagination for Facebook and Instagram comments.
- Added durable webhook processing: valid receipt, durable outbox job `social.webhook.process` v1 with only `receiptId`, BullMQ dispatch, worker asset resolution, normal social sync enqueue, and receipt state transition to `PROCESSED` or `IGNORED`.

## Focused Verification

```text
pnpm --filter @xlrrank/social-core build
pnpm --filter @xlrrank/social-core test
pnpm --filter @xlrrank/api build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55433/xlrrank_x_oauth_e2e X_OAUTH_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum node --test apps/api/test/csrf-guard.test.mjs apps/api/test/platforms-oauth.e2e.mjs
pnpm --filter @xlrrank/worker build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55433/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test --test-name-pattern "Meta worker ingestion|Meta webhook worker|X worker ingestion e2e: OAuth refresh" apps/worker/test/worker-ingestion.e2e.mjs
```

Results:

- CSRF focused test: PASS.
- Meta connector contract: PASS.
- Meta OAuth shared grant, asset selection, AAD, and IDOR E2E: PASS.
- Meta webhook signature/dedupe E2E: PASS.
- Meta webhook worker E2E: PASS.
- Facebook worker ingestion: PASS.
- Instagram worker ingestion: PASS.
- X worker OAuth regression: PASS.
- Redis local compatibility: PASS on Redis 5.0.14.1.

## Known Blockers

- Worker Docker Runtime: `BLOCKED_LOCAL_INFRA`.
- Remote CI: `BLOCKED_INFRA`; GitHub Actions were not rerun.
- Facebook Live Provider Gate: `BLOCKED_EXTERNAL`.
- Instagram Live Provider Gate: `BLOCKED_EXTERNAL`.
- Meta Live Provider Gate: `BLOCKED_EXTERNAL`.
