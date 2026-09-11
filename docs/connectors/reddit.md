# Reddit Connector

Verification date: 2026-09-10

Official sources checked:
- Reddit Responsible Builder Policy: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- Reddit Data API Terms: https://redditinc.com/policies/data-api-terms
- Reddit API index: https://www.reddit.com/dev/api/
- Reddit API wiki / OAuth 2 technical reference: https://github.com/reddit-archive/reddit/wiki/oauth2

## Access Model

The connector is official-API-only. It does not scrape Reddit web pages and does not use browser automation. Current Reddit policy requires Data API approval before production access, and commercial or use-case-specific access must be explicitly authorized where applicable.

Capability states are evaluated from generic provider app configuration metadata:
- no enabled provider app config: `CONFIGURATION_REQUIRED`
- app config exists but Reddit Data API approval is not recorded: `APP_REVIEW_REQUIRED`
- Data API approval exists but required commercial/use-case authorization is absent: `ACCESS_TIER_REQUIRED`
- connected account lacks a required OAuth scope: `PERMISSION_REQUIRED`
- followers/following/audience/messages/publishing: `UNAVAILABLE`

Approval metadata is admin-controlled in `provider_app_configurations.metadata.access`; ordinary OAuth users cannot assert approval through OAuth start or callback parameters.

## OAuth

The connector uses Reddit authorization-code OAuth through the existing generic OAuth framework:
- authorization endpoint: `https://www.reddit.com/api/v1/authorize`
- token endpoint: `https://www.reddit.com/api/v1/access_token`
- revocation endpoint: `https://www.reddit.com/api/v1/revoke_token`
- bearer API base: `https://oauth.reddit.com`
- `duration=permanent`
- HTTP Basic client authentication for token, refresh, and revoke
- `application/x-www-form-urlencoded` token bodies
- no PKCE parameters

Default scopes are minimized to `identity`, `read`, and `history`. Submit, vote, edit, moderator, account, and private-message scopes are not requested by this connector.

Refresh preserves an existing refresh token when Reddit omits a replacement token.

## User-Agent And HTTP Safety

Every Reddit Data API request must have configured `userAgent` or `redditUserAgent` metadata. The connector fails closed for missing, too-short, or browser/client-spoofed User-Agent values.

Production hosts are fixed to:
- `https://www.reddit.com` for OAuth token/revoke
- `https://oauth.reddit.com` for bearer Data API calls

Localhost base URL overrides are allowed only outside production for tests.

## Implemented API Surface

Implemented read-oriented endpoints:
- `GET /api/v1/me`
- `GET /user/{username}/about.json`
- `GET /user/{username}/submitted.json`
- `GET /user/{username}/comments.json`
- `GET /comments/{article}.json`
- `GET /search.json`

Listings cap `limit` at Reddit's maximum of 100 and use opaque `after` cursors. Deleted and removed placeholder content is minimized at normalization time and is not persisted as durable user content.

The connector normalizes Reddit profiles, submissions, comments, and search results into the existing profile/content/interaction contracts. Provider metadata includes retention category, retention basis, and a source policy that blocks model training, fine-tuning, benchmark, and seed-data use by default.

## Retention & Approved Use Case Enforcement

Reddit retention is strictly approved-use-case-driven through `provider_data_retention_policies` (migration `0013_approved_use_retention_and_reconciliation.sql`). The previous fixed 30-day default has been eliminated.

Default categories:
- `reddit_authenticated_user_profile`
- `reddit_public_user_profile`
- `reddit_user_content`
- `reddit_comment`

Retention rules:
- `retention_mode = 'APPROVED_USE_CASE'` with `max_retention_seconds = NULL` in database schema.
- In production, retention loading fails closed with `MissingApprovedUseCaseRetentionPolicyError` if no approved use-case retention duration is configured.
- Effective retention duration is resolved dynamically from:
  1. Policy metadata (`approvedUseCaseRetentionSeconds`)
  2. Provider application config metadata (`retention.approvedUseCaseRetentionSeconds` or category-level retention)
  3. Environment variable (`PROVIDER_APPROVED_USE_CASE_RETENTION_SECONDS_REDDIT` or `REDDIT_APPROVED_USE_CASE_RETENTION_SECONDS`)
- The retention sweep runtime generically processes providers configured with `APPROVED_USE_CASE` retention mode.

## Upstream Deletion Reconciliation

Reddit deletion reconciliation revalidates persisted content and accounts against official Reddit endpoints in accordance with Reddit Developer Terms:
- Endpoints:
  - Links and Comments: `GET /api/info` using `id` parameter with prefixed fullnames (`t3_` for submissions, `t1_` for comments) in bounded batches (up to 100 items).
  - User Accounts: `GET /user/{username}/about.json` using generic `lookupKey` / handle under `read` OAuth scope (official Reddit Data API specification restricts `/api/info` to `t1`, `t3`, and `t5`; `t2_*` accounts are queried via the about endpoint).
- States: Distinguishes `EXISTS`, `DELETED`, `ACCOUNT_DELETED`, and `UNKNOWN`. Confirmed deleted-account evidence may trigger deletion/anonymization. Suspended accounts and HTTP 404 account responses are treated as `UNKNOWN`; `UNKNOWN` is non-destructive.
- Safe claiming: Database candidates are claimed with `FOR UPDATE SKIP LOCKED` and durable cursor tracking in `provider_reconciliation_checkpoints`.
- Non-locking execution: Candidates are claimed in a short database transaction; network requests execute outside open transactions; final state updates and checkpoint advancements commit in a separate short transaction.
- Work budget & Rate-limiting: Reconciliation sweeps enforce per-run batch budgets (`maxBatchesPerRun = 5`, configurable up to 100) and respect upstream rate-limit headers (`rateLimit.remaining === 0` or `retryAfter > 0`). Rate-limited or deferred account candidates are retried later; the checkpoint does not advance past candidates that were not definitively attempted against the provider. Sweeps are bounded by `AbortSignal.timeout(env.PROVIDER_RECONCILIATION_SWEEP_TIMEOUT_MS)`.
- Upstream removal: Items missing from the `/api/info` response or marked with `removed_by_category`, `[deleted]`, or `[removed]` have their observations purged. Orphan canonical items and interactions are removed only if no observation from another provider references them (preserving multi-provider provenance).
- Author account deletion: Confirmed deleted user accounts may trigger author anonymization (`author_handle = '[deleted]'`, `author_external_id = NULL`, removal of author fullname from metadata) across stored posts and interactions. Suspended or 404-only account states remain `UNKNOWN` and do not trigger destructive changes.

## Provider Data Deletion Requests (DPA Compliance)

Reddit Developer Terms and Data Protection Addendum (DPA) require deletion of Personal Data and derivatives within 10 days of request:
- Queue: `QUEUE_NAMES.ingestion`, job type `JOB_TYPES.providerDataDeletion` (`provider.data.deletion`).
- Deadline calculation: `calculateProviderDataDeletionDeadline` dynamically evaluates provider retention policy metadata (`deletionRequestDeadlineSeconds: 864000`, exactly 10 days for Reddit) or environment overrides. It fails closed with `MissingProviderDeletionDeadlinePolicyError` if provider policy metadata is absent.
- Durability: Requests, domain jobs, and outbox entries are committed atomically in the database within a single transaction prior to Redis transport.
- Bounded phased execution: Each worker execution performs one bounded destructive unit (`batchSize`, default 100) and commits that unit with its progress checkpoint and any continuation job. A continuation uses a new durable job and outbox identity that references the same deletion request.
- Relational workset: Canonical cleanup provenance is stored in `provider_data_deletion_targets`, keyed by deletion request, entity type, and entity ID. `provider_data_deletion_requests.metadata.deletionProgress` stores phase and counts only, not target UUID arrays.
- Phases:
  1. `CONTENT_OBSERVATIONS`
  2. `CANONICAL_ITEMS` (orphaned items cleaned only if no observation from any provider remains)
  3. `INTERACTION_OBSERVATIONS`
  4. `CANONICAL_INTERACTIONS` (orphaned interactions cleaned only if no observation remains)
  5. `ACCOUNT_OBSERVATIONS`
  6. `ACCOUNTS` (orphaned external accounts sanitized)
  7. `ACCOUNT_HANDLES` (orphaned handles purged)
  8. `CONTENT_METRICS` (derivatives purged)
- Scope and authorization safety: Scoped requests do not sweep unrelated provider-family orphan records. Connection requests validate connection existence, scope, and provider family before destructive work. Authorization-only requests fail closed unless authoritative connection provenance is available.
- Request idempotency: Idempotency is based on provider family plus the actual requested target identifiers: supplied scope, connection, provider authorization, or explicit privileged provider-wide deletion. Duplicate responses return the exact deletion request referenced by the active durable job payload.

## Disconnect & Durable Token Revocation

Disconnect maintains local-first availability while ensuring reliable remote token revocation:
- Local disconnect: Immediately marks connection `DISCONNECTED` and clears credentials from `social_connections`.
- Immediate revocation: Connector attempts remote revocation against `https://www.reddit.com/api/v1/revoke_token` with a 1500ms timeout.
- Sibling connection safety: Sibling connections in the same scope sharing the verified external account remain active and are not revoked.
- Durable fallback: If remote revocation times out or fails with a retryable error, a durable cleanup record is created in `provider_authorization_cleanups` along with an outbox job `provider.authorization.cleanup`. A single canonical `cleanupId` is shared across ID allocation, AES-256-GCM encryption AAD, database row insertion, and worker decryption.
- Worker query correctness: The worker queries `pac.connection_id` matching the database schema.
- Secret hygiene: Upon successful remote revocation or terminal failure in `processProviderAuthorizationCleanup`, `credentials_encrypted` is wiped to `NULL` to prevent credential leakage. Retries retain credentials until max attempts (3) or terminal classification.

## Live Gate

`REDDIT LIVE PROVIDER GATE: BLOCKED_EXTERNAL`

No live Reddit client credentials, Data API approval, commercial/use-case approval, or production User-Agent registration were supplied for this sprint. All verification relies on official documentation, contract tests, and local integration fixtures.
