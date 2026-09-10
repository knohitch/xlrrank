# Sprint 09 Local Verification

Date: 2026-09-10

## Focused Verification

Reddit connector contract and regressions:

```sh
pnpm --filter @xlrrank/social-core typecheck
pnpm --filter @xlrrank/social-core build
pnpm --filter @xlrrank/social-core test
```

Observed: 25/25 passing, including Reddit OAuth, API normalization, capability gating, rate-limit/error mapping, User-Agent enforcement, unsupported follows, and safe host override coverage.

API OAuth E2E, Reddit-only:

```sh
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_x_oauth_e2e \
X_OAUTH_E2E=1 NODE_ENV=test \
ENCRYPTION_MASTER_KEY=x-oauth-e2e-master-key-32-bytes-minimum \
node --test --test-name-pattern "Reddit" apps/api/test/platforms-oauth.e2e.mjs
```

Observed: 2/2 passing.

Worker E2E, Reddit-only:

```sh
DATABASE_URL=postgres://xlrrank@127.0.0.1:5434/xlrrank_worker_e2e \
REDIS_URL=redis://127.0.0.1:6379 QUEUE_URL=redis://127.0.0.1:6379 \
WORKER_INGESTION_E2E=1 NODE_ENV=test \
ENCRYPTION_MASTER_KEY=worker-e2e-master-key-32-bytes-minimum \
node --test --test-name-pattern "Reddit worker" apps/worker/test/worker-ingestion.e2e.mjs
```

Observed: 1/1 passing.

Targeted package checks:

```sh
pnpm --filter @xlrrank/api typecheck
pnpm --filter @xlrrank/api build
pnpm --filter @xlrrank/worker typecheck
pnpm --filter @xlrrank/worker build
pnpm --filter @xlrrank/database typecheck
```

Observed: all passing.

## Source Verification

Official Reddit sources checked on 2026-09-10:
- Responsible Builder Policy, updated June 05, 2026: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- Data API Terms, last revised July 20, 2026: https://redditinc.com/policies/data-api-terms
- Reddit API index: https://www.reddit.com/dev/api/
- OAuth 2 technical reference: https://github.com/reddit-archive/reddit/wiki/oauth2

## Final Matrix

```sh
pnpm install --frozen-lockfile
pnpm lint --concurrency=2
pnpm typecheck --concurrency=2
pnpm build
pnpm test --concurrency=2
pnpm audit --prod
git diff --check
```

Observed:
- `pnpm install --frozen-lockfile`: pass, already up to date
- `pnpm lint --concurrency=2`: pass with existing warnings
- `pnpm typecheck --concurrency=2`: pass
- `pnpm build`: pass
- `pnpm test --concurrency=2`: pass
- `pnpm audit --prod`: pass, no known vulnerabilities
- `git diff --check`: pass; line-ending warnings only

Remote CI was not triggered or polled.

Docker was not installed or used.
