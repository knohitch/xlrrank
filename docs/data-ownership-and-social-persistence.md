# Data Ownership and Social Persistence

Sprint 04 establishes the social-data foundation for live connectors without adding live third-party platform integrations.

## Scope Model

Customer-owned social data belongs to a `data_scopes` row.

- `PERSONAL` scopes reference exactly one `users.id`.
- `ORGANIZATION` scopes reference exactly one `organizations.id`.
- A database check constraint rejects ambiguous or missing owners.
- Server-side authorization resolves scope access through `ensurePersonalScope`, `ensureOrganizationScope`, `authorizeScope`, and `authorizeConnection`.

Client-supplied scope, organization, or connection IDs are treated only as lookup keys. The backend resolves the owning scope and validates the authenticated user before returning or mutating tenant-owned social data.

Organization social capabilities are represented by `organization_member_permissions`:

- `VIEW_SOCIAL_DATA`
- `MANAGE_SOCIAL_CONNECTIONS`
- `TRIGGER_SOCIAL_SYNC`
- `MANAGE_ORGANIZATION`

Global application roles do not automatically grant organization social-data access.

## Canonical Public Data

`social_external_accounts` represents a canonical provider identity keyed by:

- `platform_id`
- `external_id`

Handles are mutable and are not used as the canonical identity key. Current handles live on the canonical row, while `social_account_handles` preserves handle history for future identity-resolution use.

Public content and interactions can be shared canonical records when visibility is explicitly `PUBLIC`. Private, restricted, or unknown records are scope-owned and cannot be globally deduplicated.

## Tenant Observations

Canonical existence does not grant tenant visibility. Tenant access is represented by explicit observation tables:

- `social_account_observations`
- `social_content_observations`
- `social_interaction_observations`

Each observation records:

- `scope_id`
- `connection_id`
- observed entity
- `visibility`
- `observed_at`
- provider-created timestamp when available
- `normalization_version`
- `adapter_version`
- `ingestion_run_id`
- redacted metadata

Deleting a scope or connection can remove tenant observation links and private tenant data without deleting shared public canonical records still referenced by other scopes.

## Private Data

Visibility is conservative:

- `PUBLIC`
- `SCOPE_PRIVATE`
- `RESTRICTED`
- `UNKNOWN`

If provider data is not proven public, persistence treats it as scope-owned. Database check constraints require `scope_id` on non-public content and interactions.

## Connections and Credentials

`social_connections` is the tenant-owned connection state table. It stores:

- `scope_id`
- `platform_id`
- verified canonical external identity
- encrypted credentials
- status
- durable sync cursor
- sync timestamps
- safe error details
- normalized rate-limit state

Credentials are no longer attached to canonical external accounts. Disconnect clears `credentials_encrypted`, moves the connection to `DISCONNECTED`, and records an audit event. API responses use explicit DTOs and do not expose credential fields.

New social credentials are encrypted with AES-256-GCM using associated data bound to:

- connection ID
- scope ID
- platform slug
- secret purpose/version

A ciphertext copied from one connection context cannot be decrypted under a different context.

Sprint 06 adds generic OAuth provider application configuration in `provider_app_configurations`. Provider client secrets are encrypted separately from user connection credentials and are not returned by the admin API. OAuth authorization transactions persist only a state digest plus server-side PKCE verifier, requested scopes, local redirect target, expiry, and single-use timestamp.

## Connection State Machine

Allowed states are centralized:

- `DISCONNECTED`
- `CONNECTING`
- `CONNECTED`
- `DEGRADED`
- `REAUTH_REQUIRED`
- `ERROR`
- `DISABLED`

`CONNECTED` requires successful provider authentication and encrypted credentials. The database rejects a `CONNECTED` social connection without credentials.

## Connector Factory Lifecycle

The connector registry stores definitions:

- manifest
- capabilities
- factory
- test-only flag

It does not store long-lived authenticated connector instances. Runtime flow is:

1. Resolve registry definition.
2. Create an isolated operation connector.
3. Load and decrypt credentials for the authorized connection.
4. Pass credentials in the operation context.
5. Perform the provider operation.
6. Dispose the operation context.

The deterministic reference connector is test-only and refuses to run in production.

## Normalization Versioning

Normalized records carry `normalizationVersion`; the current contract is `social-normalized-v2`.

Connector provenance also records `adapterVersion`, so future migrations can identify which adapter and normalization schema produced each observation.

## Provenance

Sprint 04 persists provenance through ingestion runs and observation rows. The system can answer:

- which connection produced the observation
- which scope owned that connection
- which platform produced the data
- when XLRrank observed it
- when the provider says it was created
- which normalization version processed it
- which adapter version produced it
- which ingestion run persisted it
- whether the data was public, private, restricted, or unknown

Provider metadata is redacted before persistence. Full raw HTTP responses are not retained by default.

## Raw Payload Policy

The current policy is `DO_NOT_RETAIN` for arbitrary raw provider responses.

Future retention modes must define:

- scope ownership
- redaction
- encryption
- size limit
- retention period
- deletion behavior

Unlimited permanent raw JSON retention is not allowed.

## Cursor Semantics

`social_ingestion_runs` records:

- scope
- connection
- platform
- status
- cursor before
- cursor after
- processed counts
- errors
- retry classification
- normalization version

Provider HTTP calls happen before the bounded persistence transaction. The transaction persists a logical page, its provenance, observations, metrics, and cursor update together.

Cursor rule:

1. Fetch provider page.
2. Normalize and validate.
3. Begin bounded transaction.
4. Persist durable data, provenance, observations, and metrics.
5. Mark run complete.
6. Advance connection cursor.
7. Commit.

If persistence fails, the cursor remains at the previous durable point.

## Sync Concurrency

Same-connection sync uses a PostgreSQL advisory transaction lock keyed by connection ID. This prevents two workers from concurrently advancing the same connection cursor. It is database-backed and does not depend on a process-local mutex.

Different connections and scopes can run concurrently with independent credentials and cursors.

## Metrics

`social_content_metrics` stores historical snapshots keyed by:

- scope
- content item
- snapshot key

Metrics are not blindly overwritten, so future velocity, momentum, and trend detection can use history. Duplicate snapshots from the same observation are ignored.

## Retention and Deletion Compatibility

The schema separates:

- personal private data
- organization-owned data
- shared public canonical identities/content
- tenant observation links
- connection credentials and cursor state
- customer-derived data

This supports later account-deletion and organization-retention workflows without guessing ownership.
