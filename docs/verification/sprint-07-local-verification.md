# Sprint 07 Focused Closure Verification

Date: 2026-09-09

Scope: focused closure for independently verified Meta gaps in PR #1.

## Documentation Check

Official Meta documentation was rechecked during closure. Direct opens to `developers.facebook.com` returned HTTP 429 in this environment. Official search-visible Meta results confirmed:

- Graph API `v26.0` is the current target used by the connector.
- Meta Webhooks and Instagram Webhooks use `X-Hub-Signature-256` with a `sha256=` signature.
- Instagram API with Facebook Login remains supported for Page-linked professional account access.
- Instagram API with Instagram Login is currently documented by Meta with `https://graph.instagram.com`, `instagram_business_*` scopes, `/v26.0/me?fields=user_id,username`, authorization-code exchange at `https://api.instagram.com/oauth/access_token`, long-lived token exchange at `https://graph.instagram.com/access_token`, and refresh at `https://graph.instagram.com/refresh_access_token`.

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
- Instagram connector auth modes are executable contracts, not labels. `FACEBOOK_LOGIN` keeps the Facebook Graph host, Facebook/Page scopes, and `/me/accounts` Page discovery. `INSTAGRAM_LOGIN` uses the Instagram authorization endpoint, Instagram Graph host, `instagram_business_*` scopes, `/me` identity, and one direct Instagram Professional account authorization asset.
- Generic OAuth start resolves the configured connector auth-mode contract before scope normalization. Requested scopes outside the selected mode's default/allowed set are rejected, so Facebook Login scopes cannot leak into Instagram Login and Instagram Login scopes cannot leak into Facebook Login.
- Direct Instagram Login token lifecycle now performs short-lived code exchange, long-lived token extension, and long-lived token refresh through the documented Instagram endpoints. Refresh support is claimed only for that executable fixture path.
- Direct Instagram Login capability evaluation is mode-specific: profile, owned media, comments, and profile aggregate metrics require `instagram_business_*` grants; insights, mentions, business discovery, hashtag discovery, followers actor list, and following actor list remain unavailable/not claimed because there is no executable connector support in this closure.
- Granted OAuth scopes are now source-of-truth based. Provider-returned scopes win when present; otherwise adapters fall back only to the exact normalized scopes stored in the OAuth transaction. Direct Instagram Login no longer manufactures `instagram_business_manage_insights` when only `instagram_business_basic` and `instagram_business_manage_comments` were requested.
- Corrected metrics semantics: profile/public aggregate metrics are not represented as Page/Instagram Insights, and `fan_count` is not used as content count.
- Added opaque cursor pagination for Facebook and Instagram comments.
- Added durable webhook processing: valid receipt, durable outbox job `social.webhook.process` v1 with only `receiptId`, BullMQ dispatch, worker asset resolution, normal social sync enqueue, and receipt state transition to `PROCESSED` or `IGNORED`.

## Focused Verification

```text
pnpm --filter @xlrrank/social-core build
pnpm --filter @xlrrank/social-core test
pnpm --filter @xlrrank/api build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55434/xlrrank_x_oauth_e2e X_OAUTH_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum node --test apps/api/test/csrf-guard.test.mjs apps/api/test/platforms-oauth.e2e.mjs
pnpm --filter @xlrrank/worker build
DATABASE_URL=postgres://xlrrank@127.0.0.1:55434/xlrrank_worker_e2e REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 WORKER_INGESTION_E2E=1 NODE_ENV=test ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum node --test --test-name-pattern "Instagram Login worker|Meta worker ingestion|Meta webhook worker|X worker ingestion e2e: OAuth refresh" apps/worker/test/worker-ingestion.e2e.mjs
```

Results:

- CSRF focused test: PASS.
- Meta connector contract: PASS, including direct Instagram Login Graph-host isolation, `/me` identity, media pagination, comment pagination, and token extension/refresh.
- Meta OAuth shared grant, asset selection, AAD, and IDOR E2E: PASS.
- Direct Instagram Login OAuth E2E: PASS, including Instagram-specific scopes, token exchange/extension, provider authorization asset persistence, AAD, personal scope isolation, organization scope isolation, and wrong-user denial.
- Direct Instagram Login granted-scope truthfulness: PASS. The two-scope request persists exactly `instagram_business_basic` and `instagram_business_manage_comments`; the full allowed set persists only when explicitly requested.
- Meta webhook signature/dedupe E2E: PASS.
- Meta webhook worker E2E: PASS.
- Facebook worker ingestion: PASS.
- Instagram Facebook-Login worker ingestion: PASS.
- Instagram Login worker ingestion: PASS, through PostgreSQL, outbox, Redis, BullMQ, real worker, Instagram Graph fixture, normalized persistence, token secrecy, and no Facebook Graph call.
- X worker OAuth regression: PASS.
- Redis local compatibility: PASS on Redis 5.0.14.1.

## Known Blockers

- Worker Docker Runtime: `BLOCKED_LOCAL_INFRA`.
- Remote CI: `BLOCKED_INFRA`; GitHub Actions were not rerun.
- Facebook Live Provider Gate: `BLOCKED_EXTERNAL`.
- Instagram Live Provider Gate: `BLOCKED_EXTERNAL`.
- Meta Live Provider Gate: `BLOCKED_EXTERNAL`.
