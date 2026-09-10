# Sprint 09 Local Verification

Date: 2026-09-10

## Sprint 09 Closure Repair Verification

Repair verification date: 2026-09-10

### 1. Defect 1: Retention Policy Repair & Fail-Closed Enforcement
- Fixed 30-day default eliminated in migration `0013_approved_use_retention_and_reconciliation.sql` (`max_retention_seconds = NULL`, `retention_mode = 'APPROVED_USE_CASE'`).
- `loadProviderRetentionPolicies` fails closed in production when unconfigured (`MissingApprovedUseCaseRetentionPolicyError`).
- Dynamic resolution across policy metadata, app config metadata, and environment variables verified in `packages/database/test/sprint-09-closure-repair.test.mjs`.

### 2. Defect 2: Bounded Durable Deletion Reconciliation
- Official Reddit `/api/info` resource reconciliation verified in `packages/social-core/test/reddit-connector.test.mjs` (mapping deleted content, deleted accounts, and author-deleted content).
- Database candidate claiming with `FOR UPDATE SKIP LOCKED`, checkpointing, deleted content purging, and author anonymization verified in `packages/database/test/sprint-09-closure-repair.test.mjs`.
- Bounded maintenance sweep implemented in `apps/worker/src/provider-reconciliation-sweep.ts`.

### 3. Defect 3: Durable Provider-Neutral Data Deletion Requests
- Outbox job `provider.data.deletion` in `QUEUE_NAMES.ingestion`.
- Policy-driven deadline calculation dynamically calculates 10-day DPA deadline (`deletionRequestDeadlineSeconds: 864000`) for Reddit, defaulting to 30 days for generic providers.
- Atomic insertion into `provider_data_deletion_requests`, `jobs`, and `job_outbox` prior to Redis submission.
- Bounded deletion execution preserving independent multi-provider canonical records verified.

### 4. Defect 4: Durable Final-Disconnect Token Revocation
- Local disconnect succeeds immediately (`DISCONNECTED`), clearing credentials from `social_connections`.
- 1500ms timeout fallback creates durable `provider.authorization.cleanup` in `provider_authorization_cleanups`.
- Encrypted snapshot using dedicated `providerAuthorizationCleanupAssociatedData`.
- Sibling connections sharing the external account remain unaffected.
- Worker processor `processProviderAuthorizationCleanup` wipes `credentials_encrypted` to `NULL` upon completion or terminal failure.

### Targeted Repair Test Verification

```sh
pnpm --filter @xlrrank/queue run test
pnpm --filter @xlrrank/social-core run test
pnpm --filter @xlrrank/database run test
pnpm --filter @xlrrank/worker run test
pnpm --filter @xlrrank/api run test
```

Observed:
- `@xlrrank/queue`: 6/6 tests passing.
- `@xlrrank/social-core`: 26/26 tests passing.
- `@xlrrank/database`: 19/19 tests passing.
- `@xlrrank/worker`: 3/3 tests passing.
- `@xlrrank/api`: 6/6 tests passing.


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
