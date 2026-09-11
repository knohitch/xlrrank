# Sprint 09 Local Verification

Date: 2026-09-11

## Final Sprint 09 Evidence

- Reddit account state safety: reconciliation uses `/api/info` for links/comments and `/user/{username}/about.json` for accounts. Suspended accounts and HTTP 404 account responses resolve to `UNKNOWN`, and `UNKNOWN` is non-destructive. Confirmed deleted-account evidence remains the path that may trigger anonymization.
- Durable authorization cleanup: `processProviderAuthorizationCleanup()` is covered by a real worker fixture path with canonical cleanup ID/AAD and credential wipe on terminal outcomes.
- Approved-use retention: Reddit retention is policy-driven through approved-use metadata; the generic 30-day default was removed.
- Provider deletion deadline: Reddit deletion requests resolve the 10-day deadline from policy metadata (`864000` seconds) and fail closed without policy or override.
- Bounded data deletion: each provider deletion worker execution performs one bounded destructive unit and commits that unit with phase/count checkpointing.
- Relational deletion workset: `provider_data_deletion_targets` stores bounded request/entity work records; request metadata stores phase and counts, not target UUID arrays.
- Real worker continuation: PostgreSQL-backed test uses more than 100 rows, exercises `processProviderDataDeletion()`, observes `IN_PROGRESS`, follows new durable job/outbox identities, and completes through continuation.
- Scope isolation: connection/scoped deletion preserves unrelated scope/provider data and does not sweep unrelated provider-family orphan records.
- Authorization isolation: authorization-only deletion fails closed unless authoritative connection provenance exists; same-scope two-authorization identity tests prove separate request/job identity.
- Reconciliation global budget: `PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN` remains provider-neutral, defaults to 5, and is capped at 100.
- Deferred cursor behavior: rate-limited/deferred reconciliation candidates remain eligible for retry; checkpoints do not advance past candidates that were not definitively attempted.
- Configuration maximum: config schema rejects zero, negative, and values above 100 for `PROVIDER_RECONCILIATION_MAX_BATCHES_PER_RUN`.

## Focused Tests

```sh
$env:DATABASE_URL='postgresql://xlrrank:xlrrank@127.0.0.1:5434/xlrrank_audit'; $env:ENCRYPTION_MASTER_KEY='integration-test-master-key-32b!'; node --test packages/database/test/sprint-09-bounded-deletion.test.mjs
```

Observed: 10/10 passing.

Previously accepted focused coverage remains in:
- `apps/worker/test/sprint-09-reconciliation-cursor.test.mjs`: deferred cursor preservation.
- `packages/config/test/env.test.mjs`: reconciliation batch cap.
- `apps/worker/test/sprint-09-closure-e2e.test.mjs`: Reddit account state safety and durable authorization cleanup.

## Final Matrix

```sh
pnpm lint --concurrency=2
pnpm typecheck --concurrency=2
pnpm build
pnpm test --concurrency=2
pnpm audit --prod
git diff --check
```

Observed on 2026-09-11:
- `pnpm lint --concurrency=2`: pass with existing warnings only.
- `pnpm typecheck --concurrency=2`: pass.
- `pnpm build`: pass.
- `pnpm test --concurrency=2`: pass, 27 turbo tasks successful. Notable package counts: `@xlrrank/database` 40 tests (32 pass, 8 skipped), `@xlrrank/worker` 28 tests (6 pass, 22 skipped), `@xlrrank/config` 9/9 pass.
- `pnpm audit --prod`: pass, no known vulnerabilities.
- `git diff --check`: pass; line-ending warnings only.

## External Blockers

- `REMOTE CI: BLOCKED_INFRA`
- `WORKER DOCKER RUNTIME: BLOCKED_LOCAL_INFRA`
- `REDDIT LIVE PROVIDER GATE: BLOCKED_EXTERNAL`

Remote CI was not triggered or polled. Docker was not installed or used. No live Reddit verification is claimed.
