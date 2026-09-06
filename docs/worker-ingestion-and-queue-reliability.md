# Worker Ingestion and Queue Reliability

Sprint 05 makes social ingestion a durable, asynchronous worker workflow. PostgreSQL is the application system of record for requests, outbox dispatch, job status, ingestion runs, cursors, leases, dead letters, schedules, and worker heartbeat state. BullMQ and Redis are execution transport only.

## Delivery Model

The system does not promise exactly-once execution. It uses at-least-once BullMQ delivery with idempotent persistence, deterministic job identifiers, durable cursors, unique constraints, and duplicate-safe social persistence. A redelivered job resumes from the authoritative cursor stored on `social_connections`, not from queue payload data.

## Job Contract

Job types are defined in `@xlrrank/queue`. The Sprint 05 social ingestion job type is `social.connection.sync` with payload version `1`. Queue payloads contain identifiers and execution reason only: job request ID, connection ID, and reason. Payload parsing rejects unknown versions, malformed UUIDs, unknown reasons, and secret-looking keys such as tokens, credentials, cookies, and authorization headers.

`QUEUE_PREFIX` isolates BullMQ keys by environment. CI uses a test-specific prefix. No production namespace is hardcoded in the queue package.

## Durable Request and Outbox

Manual, retry, and scheduled sync requests create a row in `jobs` plus a matching `job_outbox` row in one PostgreSQL transaction. The request path does not require Redis to be available, so a temporary Redis outage leaves a durable pending outbox entry rather than losing the sync request.

The dispatcher claims pending outbox entries with PostgreSQL row locking and `SKIP LOCKED`, publishes to BullMQ with deterministic job IDs, and records the BullMQ job ID after publish. Re-running the dispatcher after a crash is safe because the outbox row and BullMQ job ID are deterministic, and the social persistence layer remains idempotent if BullMQ redelivers the same job.

## Worker Lifecycle

The worker starts by checking PostgreSQL, Redis, and the job registry. It reconciles expired outbox locks, stale worker heartbeats, and stale running social jobs that no longer have an active sync lease. It then starts dispatcher, scheduler, heartbeat, and BullMQ worker loops.

On shutdown the runtime stops scheduler and dispatcher intervals, marks the worker as draining, closes BullMQ workers and queues within the configured grace period, records a stopped heartbeat, and closes PostgreSQL resources. A stuck provider operation is bounded by the configured provider operation timeout and the shutdown grace period.

## Social Sync Processor

The ingestion processor accepts only `social.connection.sync`. Other current and future job types remain explicitly unsupported. The processor reloads the durable job record and the social connection from PostgreSQL, verifies the connection belongs to an existing scope, verifies the platform is enabled, and permits execution only for executable connection states.

Credentials are never read from Redis. The worker decrypts scoped encrypted credentials from `social_connections` with the Sprint 04 AES-256-GCM associated-data context, uses them only inside the connector operation context, and does not log plaintext or ciphertext.

Connectors are loaded through the Sprint 04 registry and factory lifecycle. The worker core does not switch on provider names and does not hold authenticated connector instances globally.

## Sync Lease and Cursor Semantics

Sprint 05 adds `social_sync_leases`, a database-backed run-level lease with owner token and expiry. The lease is held across provider fetches, normalization, page persistence, and pagination, without holding a PostgreSQL transaction open during network I/O. Only the lease owner can renew or release it. If a worker crashes, the lease expires and another worker can resume.

The Sprint 04 transaction-scoped advisory lock remains in the persistence path as defense in depth. The run-level lease prevents interleaved remote fetches for the same connection; the transaction lock protects bounded durable writes.

The sync cursor advances only after page persistence commits. If a worker crashes before persistence, the cursor is unchanged. If it crashes after a page commit but before BullMQ acknowledges the job, the redelivered job reads the durable cursor and resumes without duplicating records.

## Retry, Backoff, Rate Limits, and Dead Letters

Connector errors carry category and retry classification. Retryable temporary failures use bounded exponential backoff with configurable base delay, maximum delay, maximum attempts, and jitter. Rate-limit failures use normalized `retryAfter` or `resetAt` fields from the connector, then clamp the delay to configured safe bounds before scheduling retry and persisting safe rate-limit state.

Authentication failures that require new credentials mark the connection `REAUTH_REQUIRED` and do not loop automatically. Permanent and malformed-provider failures move to durable dead-letter state when they are terminal. Dead letters are stored in `job_dead_letters` with job ID, connection ID, ingestion run ID, safe error category, attempts, retry classification, and timestamps. Dead-letter records and persisted job errors pass through redaction and never store credentials or authorization headers.

Manual retry creates a new validated sync request from durable job state. Clients cannot rewrite arbitrary queue payloads.

## Scheduling

Scheduled syncs are stored in `social_sync_schedules` and mirrored on `social_connections` for status visibility. Schedules are UTC timestamps with configurable cadence. Multiple scheduler instances claim due schedules with PostgreSQL locking and `SKIP LOCKED`; scheduled work then enters the same durable job/outbox path as manual requests.

Disabled and reauthentication-required connections are not scheduled for execution. Future plan, platform, or deployment policies can adjust cadence without hardcoding provider-specific intervals in worker core.

## Status, API, and UI

The manual sync API returns HTTP 202 with a safe job identifier and a truthful status such as accepted or already queued. It does not block until provider sync completes and does not report fake completion. The status API returns safe job/run fields, attempts, safe error category, record counts, timestamps, and last durable cursor information after authorizing the caller against the connection scope.

The platform UI calls the asynchronous sync endpoint and polls the status endpoint. It displays truthful states such as queued, running, retrying, completed, failed, cancelled, dead-lettered, and reauthentication required. It does not display invented progress percentages.

## Operational Boundaries

Worker logs include low-cardinality correlation fields such as job ID, job type, connection ID, ingestion run ID, attempt, and error category. Logs avoid credentials, raw authorization, and provider content bodies. Metrics track job counts, retry/dead-letter events, sync duration, persisted page counts, and lease conflicts without user IDs, emails, external IDs, or URLs as labels.

Successful Redis jobs have bounded retention because PostgreSQL keeps durable business history. Cleanup policy is intentionally conservative: expire transient outbox locks and stale heartbeats, allow leases to expire, and retain durable job/dead-letter/audit history for later operator review.
