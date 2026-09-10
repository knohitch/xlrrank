# Sprint 09 Local Verification

Date: 2026-09-10

## Sprint 09 Closure Repair Verification

Repair verification date: 2026-09-10

### 1. Defect 1: Reddit Account Reconciliation & Resource State Discrimination
- Separated reconciliation into official Reddit endpoints: `/api/info` for Links (`t3`) and Comments (`t1`), and `GET /user/{username}/about.json` under `read` scope for Accounts (`t2`).
- Added provider-neutral `lookupKey?: string` to `ReconcileResourceItem`.
- State discrimination: correctly identifies `EXISTS`, `DELETED`, `ACCOUNT_DELETED`, and `UNKNOWN`.
- Transient errors (429, 5xx, timeouts, missing handles) return `UNKNOWN` and never trigger destructive scrubbing.
- Verified in `packages/social-core/test/reddit-connector.test.mjs`.

### 2. Defect 2: Durable Authorization Cleanup Canonical ID & Schema Column Fix
- Fixed UUID mismatch: single canonical `cleanupId` allocated in `platforms.service.ts` passed to `createProviderAuthorizationCleanupRequestTx({ id: cleanupId })`, matching encryption AAD, database row `id`, queue payload, and worker decryption.
- Fixed schema column mismatch: worker processor queries `pac.connection_id` matching `provider_authorization_cleanups.connection_id`.
- Verified in PostgreSQL integration test `packages/database/test/sprint-09-closure-integration.test.mjs`: creation, AAD encryption, worker decrypt, mock revoke, credential wipe to NULL, and retryable failure.

### 3. Defect 3: Bounded Phased Data Deletion & Connection Scoping
- `executeProviderDataDeletion` runs in bounded batches (`batchSize`, default 100) across 8 distinct phases: `CONTENT_OBSERVATIONS`, `CANONICAL_ITEMS`, `INTERACTION_OBSERVATIONS`, `CANONICAL_INTERACTIONS`, `ACCOUNT_OBSERVATIONS`, `ACCOUNTS`, `ACCOUNT_HANDLES`, `CONTENT_METRICS`.
- Checkpointing: progress tracked in `metadata.deletionProgress` for safe resume and idempotency.
- Connection-scoping: dynamic SQL parameter index construction (`$1, $2, ...`) and automatic `scopeId` resolution from `social_connections` when callers omit `scopeId`.
- Multi-provider preservation: canonical items and interactions preserved if another provider or connection still references them.
- Verified in PostgreSQL integration test `packages/database/test/sprint-09-closure-integration.test.mjs`.

### 4. Defect 4: Fail-Closed Deletion Deadline (No 30-Day Hardcoded Fallback)
- Removed generic hardcoded 30-day default fallback from `calculateProviderDataDeletionDeadline`.
- Fails closed with `MissingProviderDeletionDeadlinePolicyError` when no policy metadata or environment override exists.
- Reddit 10-day deadline resolved from policy metadata (`deletionRequestDeadlineSeconds = 864000`).
- Verified in `packages/database/test/sprint-09-closure-repair.test.mjs`.

### 5. Defect 5: Bounded Rate-Limit Aware Reconciliation Sweep
- Work budget: capped at `maxBatchesPerRun` (default 5 batches per sweep run).
- Rate-limit aware: inspects `reconcileResult.rateLimit` and cleanly breaks if remaining is 0 or backoff requested, preserving checkpoint cursor.
- Timeout protection: protected with `AbortSignal.timeout(env.PROVIDER_RECONCILIATION_SWEEP_TIMEOUT_MS)`.
- Transaction isolation: claims candidates in short transaction, executes network calls outside transaction, and finalizes/checkpoints in a separate transaction.
- Verified in `apps/worker/src/provider-reconciliation-sweep.ts`.

### Targeted Repair Test Verification

```sh
pnpm --filter @xlrrank/social-core run test
pnpm --filter @xlrrank/database run test
pnpm --filter @xlrrank/worker run test
pnpm --filter @xlrrank/api run test
```

Observed:
- `@xlrrank/social-core`: 26/26 tests passing.
- `@xlrrank/database`: 30 tests (22 passing, 8 skipped for audit db env), including both PostgreSQL integration tests.
- `@xlrrank/worker`: 3/3 tests passing (22 skipped e2e).
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
